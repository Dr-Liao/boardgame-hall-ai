import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { snapshotChanges, applySnapshotChanges } from './online-sync.js'
import { perf } from './perf.js'
import { HALL_VERSION, isVersion } from './version.js'

const defaultRelayUrl = 'https://boardgame-relay.onrender.com'

// Keep the text history, but do not retransmit every past animation's full
// table on every move. Authoritative events and saved games remain untouched.
export function onlineEventHistory(events, visualBudget = 512 * 1024) {
  let remaining = visualBudget, compact = false
  const result = new Array(events.length)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const snapshots = [event.tableState, event.presentation?.tableState].filter(Boolean)
    const bytes = compact ? 0 : snapshots.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0)
    if (bytes > remaining) compact = true
    if (!compact) { remaining -= bytes; result[i] = event; continue }
    const copy = { ...event }
    delete copy.tableState
    delete copy.presentation
    if (copy.type === 'presentation') delete copy.kind
    result[i] = copy
  }
  return result
}

// P1.4：把大厅已经缓存的公共静态表（cards / investigatorDefs）合并回一份省略了它们的席位视图。
// 只在本地给「没有声明 staticVersion 的旧客户端」补发完整状态时使用；调用方负责保证 staticInfo
// 来自房主的 mod.staticTables（公共卡面），且视图里的 privateCards 只属于该观察者。
export function mergeStaticIntoView(view, staticInfo) {
  if (!view || typeof view !== 'object' || !view.state || typeof view.state !== 'object') return view
  if (!staticInfo || typeof staticInfo !== 'object' || !staticInfo.cards || typeof staticInfo.cards !== 'object') return view
  const privateCards = view.state.privateCards
  const cards = privateCards && typeof privateCards === 'object' && Object.keys(privateCards).length
    ? { ...staticInfo.cards, ...privateCards }
    : staticInfo.cards
  return { ...view, state: { ...view.state, cards, investigatorDefs: staticInfo.investigatorDefs || {} } }
}

export function relayAddress(value) {
  const url = new URL(String(value || '').trim())
  if (url.username || url.password || url.search || url.hash) throw new Error('中转地址不能包含账号、查询参数或片段')
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('请使用 HTTPS 或 WSS 中转地址（本机测试可用 HTTP）')
  if (url.pathname === '/') url.pathname = '/ws'
  return url.href
}

// 联机兼容性只看版本号：大厅版本号（package.json 的 version）与游戏版本号
// （boardgame-mod.json 的 version）两端一致即可加入。
// 不再对游戏文件做逐字节指纹：改注释、样式或本机资源不会再把玩家挡在房间外；
// 内置游戏没有清单时按 0.0.0 处理，此时只由大厅版本号决定兼容性。
export function gameVersion(mod) {
  return isVersion(mod?.package?.version) ? mod.package.version : '0.0.0'
}

export function gameVersions(mods) {
  const versions = {}
  for (const mod of mods) versions[mod.id] = gameVersion(mod)
  return versions
}

export function createOnline({ mods, onCommand, onRoom, stateFile, resumeState = () => ({}) }) {
  const instanceId = randomUUID()
  let socket, reconnectTimer, keepalive, closed = false, credentials = null, connecting = false
  let room = null, memberId = null, session = null, gameBusy = false, address = '', error = '', connected = false, serial = 0, attempts = 0
  let versions
  let lobby = null, receivedSnapshot = null, resyncing = false
  // P1.1：先于对应快照到达的轻量 busy/lobby 状态。等 revision 匹配的 snapshot 落地后再应用，
  // 避免「按钮提前可用」；snapshot 一旦越过该 revision，这条状态就作废。
  let pendingStatus = null
  const sentSnapshots = new Map(), listeners = new Set()
  // P1.4：guest 大厅按 sessionId 缓存房主发来的公共静态表。首份快照带 static 信封，之后只带
  // staticVersion；浏览器刷新（丢掉浏览器缓存）时由 guest 大厅用这份缓存补发，不必再向房主要全量。
  const staticTables = new Map()
  const rememberStatic = (tables, sessionId) => {
    if (!tables || typeof tables !== 'object' || typeof tables.version !== 'string') return
    if (!tables.cards || typeof tables.cards !== 'object' || !sessionId) return
    staticTables.delete(sessionId)
    staticTables.set(sessionId, { version: tables.version, cards: tables.cards, investigatorDefs: tables.investigatorDefs || {} })
    // 只保留最近几局，避免长时间运行的大厅一直握着旧卡表。
    while (staticTables.size > 4) staticTables.delete(staticTables.keys().next().value)
  }
  const directStreams = new Map(), signals = []
  let signalSeq = 0
  const metrics = { snapshots: 0, fullBytes: 0, sentBytes: 0, directBytes: 0, localCommands: 0, statusMessages: 0 }
  const pending = new Map()
  const tickets = new Map()
  const me = () => room?.members.find(member => member.id === memberId)
  const update = () => { serial++; for (const listener of [...listeners]) listener() }
  function remember() {
    if (!stateFile || !credentials || !room) return
    const value = { relayUrl: address, token: credentials, room, memberId, ...resumeState() }
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(value), { mode: 0o600 })
      fs.renameSync(stateFile + '.tmp', stateFile)
    } catch { error = '联机恢复信息保存失败；请保持当前大厅程序运行'; update() }
  }
  const status = () => ({ ok: true, instanceId, serial, connected, connecting, error, relayUrl: address || process.env.BOARDGAME_RELAY_URL || defaultRelayUrl, room, memberId, session, lobby, busy: gameBusy,
    // P2.2：AI 回合在后台继续（只增可选字段）。host 看 session.pendingAi；guest 大厅的 session
    // 来自快照（视图里同样带 pendingAi），因此重连/刷新后也能恢复「AI 思考中」。
    aiPending: !!session?.pendingAi,
    signals: signals.filter(item => Date.now() - item.at < 30000).map(({ at, ...item }) => item) })
  function receiveSnapshot(message) {
    // P1.1：busy / lobby 变化的轻量消息复用 snapshot 信封（kind='status'），只更新会话外的
    // 运行状态，不替换 session，也不参与 sentSnapshots 的增量基线。
    if (message.kind === 'status') {
      const revision = Number.isInteger(message.revision) ? message.revision : null
      const current = session?.state?.revision
      if (revision !== null && Number.isInteger(current) && revision < current) return
      if (revision !== null && (!Number.isInteger(current) || revision > current)) {
        pendingStatus = { revision, busy: !!message.busy, ...(Object.hasOwn(message, 'lobby') ? { lobby: message.lobby } : {}) }
        return
      }
      gameBusy = !!message.busy
      if (Object.hasOwn(message, 'lobby')) lobby = message.lobby
      pendingStatus = null
      update()
      return
    }
    try {
      if (message.baseId && message.baseId !== receivedSnapshot?.id) throw new Error('同步基线已变化')
      // P1.4：static 只随完整快照下发（增量/status 里没有）。先记缓存再应用会话。
      if (!message.baseId) rememberStatic(message.static, message.session?.sessionId)
      const value = message.baseId ? applySnapshotChanges(receivedSnapshot.value, message.changes) : { session: message.session, busy: message.busy, lobby: message.lobby || null }
      receivedSnapshot = { id: message.snapshotId, value }
      session = value.session; gameBusy = !!value.busy; lobby = value.lobby; resyncing = false
      if (pendingStatus) {
        const revision = session?.state?.revision
        if (Number.isInteger(revision) && pendingStatus.revision <= revision) {
          if (pendingStatus.revision === revision) {
            gameBusy = pendingStatus.busy
            if (Object.hasOwn(pendingStatus, 'lobby')) lobby = pendingStatus.lobby
          }
          pendingStatus = null
        }
      }
      // 视图只有版本号、而本厅没有对应静态表（例如刚重启/缓存被清）：请求房主重发一份带表的全量。
      if (session?.staticVersion && !staticTables.has(session.sessionId) && !resyncing) {
        resyncing = true
        rpc('request', { action: 'sync' }).catch(() => { resyncing = false })
      }
      update()
    } catch {
      if (!resyncing) { resyncing = true; rpc('request', { action: 'sync' }).catch(() => { resyncing = false }) }
    }
  }
  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('中转连接已断开，正在重新连接')
    socket.send(JSON.stringify({ id: randomUUID(), ...message }))
  }
  // P1.3：snapshot 的 payload 已经序列化好，直接拼进信封发送，避免 socket 层把整份快照
  // 再 JSON.stringify 一次（中转按 { type, ...message.data } 原样转发给目标席位）。
  function sendSerializedSnapshot(target, payloadJson) {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('中转连接已断开，正在重新连接')
    const head = JSON.stringify({ id: randomUUID(), type: 'snapshot', target })
    socket.send(head.slice(0, -1) + ',"data":' + payloadJson + '}')
  }
  function rpc(type, payload = {}, timeout = 190000) {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('连接或操作超时，请重试')) }, timeout)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      try { send({ id, type, ...payload }) } catch (err) { clearTimeout(timer); pending.delete(id); reject(err) }
    })
  }
  const rejectPending = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('连接已中断；重新连接后会同步最新对局')) }
    pending.clear()
  }
  function scheduleReconnect() {
    if (closed || !credentials || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect('resume', { token: credentials, recovery: room }).catch(() => {})
    }, Math.min(10000, 700 * 2 ** Math.min(attempts++, 4)))
    reconnectTimer.unref()
  }
  async function connect(type, payload) {
    if (typeof WebSocket !== 'function') throw new Error('联机功能需要 Node.js 22.15 或更新版本，请更新大厅运行环境')
    connecting = true; connected = false; error = ''; update()
    const ws = new WebSocket(address)
    receivedSnapshot = null; pendingStatus = null; sentSnapshots.clear(); directStreams.clear(); signals.length = 0; resyncing = false
    let announcedRoom = null
    socket = ws
    ws.addEventListener('message', async event => {
      if (socket !== ws) return
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.type === 'result') {
        const item = pending.get(message.id)
        if (item) {
          pending.delete(message.id); clearTimeout(item.timer)
          if (message.ok) item.resolve(message.data?.snapshotSession ? { ...message.data, session } : message.data)
          else {
            // P2.2：把房主附带的稳定错误码（如 SESSION_BUSY）透传给浏览器命令错误对象（只增可选字段）。
            const error = new Error(message.error || '操作失败')
            if (typeof message.code === 'string') error.code = message.code
            item.reject(error)
          }
        }
      } else if (message.type === 'room') {
        announcedRoom = message.room
        sentSnapshots.clear()
        room = message.room; update(); remember()
        if (me()?.host) onRoom?.()
      } else if (message.type === 'snapshot') {
        receiveSnapshot(message)
      } else if (message.type === 'signal') {
        if (room?.members.some(member => member.id === message.from) && message.data && typeof message.data === 'object') {
          signals.push({ seq: ++signalSeq, at: Date.now(), from: message.from, data: message.data })
          if (signals.length > 32) signals.shift()
          update()
        }
      } else if (message.type === 'command' && me()?.host) {
        try {
          const data = await onCommand(message)
          // The final snapshot is sent first on this same ordered socket.
          // Avoid transmitting the entire session again as the RPC reply.
          send({ type: 'reply', requestId: message.requestId, ok: true, data: data?.session ? { ...data, session: undefined, snapshotSession: true } : data })
        } catch (err) {
          try { send({ type: 'reply', requestId: message.requestId, ok: false, error: err.message, ...(err?.code ? { code: err.code } : {}) }) } catch {}
        }
      } else if (message.type === 'closed') {
        credentials = null; room = null; session = null; lobby = null; memberId = null; error = message.reason; pendingStatus = null; staticTables.clear(); update()
        if (stateFile) try { fs.rmSync(stateFile, { force: true }) } catch {}
      }
    })
    ws.addEventListener('close', event => {
      if (socket !== ws) return
      if (event.code === 4001) { credentials = null; error = '此席位已在另一个大厅连接，请退出当前房间' }
      connected = false; connecting = false; clearInterval(keepalive); rejectPending(); update(); scheduleReconnect()
    })
    ws.addEventListener('error', () => {})
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('无法连接中转服务；免费 Render 服务首次唤醒可能需要一分钟，请稍后重试')) }, 75000)
        timer.unref()
        ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接中转服务，请检查地址和网络')) }, { once: true })
        ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('中转连接关闭')) }, { once: true })
      })
      const result = await rpc(type, payload, 15000)
      // Room broadcasts can arrive while the RPC promise is settling. They
      // include later joins/reconnects and must win over the older RPC result.
      credentials = result.token; room = announcedRoom || result.room; memberId = result.memberId
      connected = true; connecting = false; attempts = 0; error = ''; update()
      remember()
      clearInterval(keepalive)
      keepalive = setInterval(() => rpc('ping', {}, 12000).catch(() => ws.close()), 20000)
      keepalive.unref()
      if (me()?.host) onRoom?.()
      else rpc('request', { action: 'sync' }).catch(() => {})
      return status()
    } catch (err) {
      error = err.message; connecting = false; update()
      ws.close(); scheduleReconnect(); throw err
    }
  }
  async function open(type, body, profile) {
    if (connecting || room) throw new Error('请先退出当前房间')
    address = relayAddress(body.relayUrl || process.env.BOARDGAME_RELAY_URL || defaultRelayUrl)
    closed = false; credentials = null; session = null; lobby = null; error = ''
    versions ||= gameVersions(mods)
    if (type === 'create') {
      const mod = mods.find(m => m.id === body.modId)
      if (!mod) throw new Error('未找到游戏')
      const capacity = Number(body.capacity)
      if (!Number.isInteger(capacity) || capacity < Math.max(2, mod.players[0]) || capacity > (mod.seats || mod.players[1])) throw new Error('房间人数不符合游戏要求')
      const result = await connect('create', { name: profile.playerName, capacity, aiSeats: body.aiSeats, hallVersion: HALL_VERSION, game: { id: mod.id, name: mod.name, version: versions[mod.id] } })
      if (body.aiSeats?.length && JSON.stringify(result.room.aiSeats?.map(item => item.seat)) !== JSON.stringify(body.aiSeats.map(item => item.seat))) {
        await leave()
        throw new Error('中转服务尚不支持预留 AI 席位，请更新中转服务后重试')
      }
      return result
    }
    const code = String(body.code || '').trim().toUpperCase()
    const cached = tickets.get(address + ':' + code)
    if (cached) return connect('resume', { token: cached.token, recovery: cached.room })
    const joined = await connect('join', { code, seat: body.seat, name: profile.playerName, hallVersion: HALL_VERSION, versions })
    if (body.seat != null && me()?.seat !== body.seat) {
      await leave()
      throw new Error('中转未能分配指定席位，请更新中转服务后重试')
    }
    return joined
  }
  async function leave() {
    closed = true; clearTimeout(reconnectTimer); reconnectTimer = null; clearInterval(keepalive)
    if (room?.phase === 'playing' && !me()?.host && credentials) tickets.set(address + ':' + room.code, { token: credentials, room })
    if (connected && room) try { await rpc('leave', {}, 3000) } catch {}
    credentials = null; room = null; session = null; lobby = null; memberId = null; connected = false; connecting = false; gameBusy = false; pendingStatus = null; error = ''; signals.length = 0; directStreams.clear(); staticTables.clear(); update()
    if (stateFile) try { fs.rmSync(stateFile, { force: true }) } catch {}
    socket?.close(); rejectPending()
    return status()
  }
  return {
    status, me, open, leave, remember, metrics,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    resetSnapshots() { sentSnapshots.clear() },
    // P1.4：guest 大厅缓存的公共静态表；浏览器刷新后由本地大厅补发，不必再向房主要全量。
    staticFor(sessionId) { return (sessionId && staticTables.get(sessionId)) || null },
    // 视图只有版本号、本地却没有对应静态表时，请求房主重发一份带 static 的全量快照。
    requestSync() { return rpc('request', { action: 'sync' }) },
    restore(saved) {
      versions ||= gameVersions(mods)
      // 重连只复核游戏版本号：大厅版本升级不应打断仍在进行的房间。
      if (saved.room?.game && versions[saved.room.game.id] !== saved.room.game.version) throw new Error('游戏版本已变化，请双方更新后重新创建房间')
      address = relayAddress(saved.relayUrl); credentials = saved.token; room = saved.room; memberId = saved.memberId
      closed = false; update(); onRoom?.()
      connect('resume', { token: credentials, recovery: room }).catch(() => {})
    },
    ready: ready => rpc('ready', { ready }),
    phase: phase => rpc('phase', { phase }),
    signal(target, data) {
      if (!connected || !room) throw new Error('中转连接已断开')
      return rpc('signal', { target, data }, 10000)
    },
    directSubscribe(target, emit) {
      if (!me()?.host || !room?.members.some(member => member.id === target && !member.host)) throw new Error('直连席位无效')
      directStreams.set(target, emit); sentSnapshots.delete(target)
      return () => { if (directStreams.get(target) === emit) { directStreams.delete(target); sentSnapshots.delete(target); onRoom?.() } }
    },
    directCommand(target, action, body) {
      if (!me()?.host || !connected) throw new Error('房主连接不可用')
      const member = room?.members.find(item => item.id === target && !item.host && item.online)
      // P1：prefs（自动跳过偏好同步）与 move/chat 走同一条直连命令通道，保证和 move 的相对顺序一致。
      if (!member || !['move', 'chat', 'sync', 'prefs'].includes(action)) throw new Error('直连操作无效')
      return onCommand({ action, body, memberId: member.id, seat: member.seat })
    },
    directSnapshot(data) {
      if (me()?.host || !connected || !room?.members.some(member => member.host && member.online)) throw new Error('房主直连不可用')
      if (!data || typeof data !== 'object') throw new Error('直连状态无效')
      // P1.1：busy/lobby 状态消息没有 snapshotId；完整快照仍然必须带 snapshotId。
      if (data.kind !== 'status' && typeof data.snapshotId !== 'string') throw new Error('直连状态无效')
      receiveSnapshot(data)
      return status()
    },
    command(action, body) {
      if (me()?.host) {
        if (!connected) throw new Error('中转连接已断开，正在重新连接')
        metrics.localCommands++
        return onCommand({ action, body, memberId, seat: me().seat })
      }
      // 客人命令：经 relay 的 RPC 往返（含房主处理与两段中转）。只记耗时，不改结果。
      const endPerf = perf.span('online.guestCommand', { action })
      return rpc('request', { action, body }).then(
        data => { endPerf({ ok: true }); return data },
        err => {
          endPerf({ ok: false, error: String(err?.message || err).slice(0, 120) })
          throw err
        },
      )
    },
    publish(member, value, busy, lobbyValue = null, options = null) {
      if (member.id === memberId) { session = value; gameBusy = busy; lobby = lobbyValue; update(); return }
      if (!connected || !member.online) return
      // P1.3：sessionView 每个 revision 都产出新对象、发布后不再被修改，所以不再做
      // 「JSON.parse(JSON.stringify(...))」式防御性深拷贝：直接把视图引用当增量基线，
      // 省掉每席位一次约 1MB 的序列化 + 解析（tests/hall 的多人多步用例守住宿主对象不被改动）。
      const next = { session: value, busy, lobby: lobbyValue }
      const previous = sentSnapshots.get(member.id)
      const snapshotId = randomUUID()
      // P1.4：静态表只在「该席位还没收到当前版本」时随完整快照下发一次；带上 static 时必须走全量，
      // 不能走增量（增量基线里没有 static，否则客户端会以错误 base 计算）。
      const attachedStatic = options && options.static && typeof options.static === 'object' && typeof options.static.version === 'string'
        ? options.static : null
      const full = { snapshotId, ...next, ...(attachedStatic ? { static: attachedStatic } : {}) }
      const startedDiff = perf.enabled ? performance.now() : 0
      let data = full
      let payloadJson = null
      let fullBytes = 0
      if (previous && !attachedStatic) {
        const changes = snapshotChanges(previous.value, next)
        if (!changes.length) {
          if (perf.enabled) {
            const diffMs = +(performance.now() - startedDiff).toFixed(3)
            perf.record('publish.member', { seat: member.seat, kind: 'skip', diffMs, bytes: 0, ms: diffMs })
          }
          return
        }
        const delta = { snapshotId, baseId: previous.id, changes }
        // 只做两次序列化：全量与增量各一次，既用来比长度也直接复用到发送。
        const fullJson = JSON.stringify(full)
        const deltaJson = JSON.stringify(delta)
        if (deltaJson.length < fullJson.length) { data = delta; payloadJson = deltaJson }
        else payloadJson = fullJson
        fullBytes = Buffer.byteLength(fullJson)
      } else {
        payloadJson = JSON.stringify(full)
        fullBytes = Buffer.byteLength(payloadJson)
      }
      const diffMs = perf.enabled ? +(performance.now() - startedDiff).toFixed(3) : 0
      const bytes = Buffer.byteLength(payloadJson)
      metrics.snapshots++
      // P1.3：fullBytes 需要额外一次全量序列化，只在 BOARDGAME_PERF=1 时统计。
      if (perf.enabled) metrics.fullBytes += fullBytes
      const direct = directStreams.get(member.id)
      if (direct) { direct(data); metrics.directBytes += bytes }
      else { sendSerializedSnapshot(member.id, payloadJson); metrics.sentBytes += bytes }
      sentSnapshots.set(member.id, { id: snapshotId, value: next })
      perf.record('publish.member', { seat: member.seat, kind: data === full ? 'full' : 'delta',
        diffMs, bytes, fullBytes, ms: diffMs })
    },
    // P1.1：只同步 busy / lobby 等运行状态，不发会话。复用现有 snapshot 信封（kind='status'），
    // 中转与直连都原样转发即可；不写 sentSnapshots，避免污染下一次全量/增量的 diff 基线。
    publishStatus(member, value = {}) {
      const payload = {
        kind: 'status',
        busy: !!value.busy,
        revision: Number.isInteger(value.revision) ? value.revision : null,
        lobby: value.lobby ?? null,
      }
      if (member.id === memberId) {
        gameBusy = payload.busy
        lobby = payload.lobby
        update()
        return
      }
      if (!connected || !member.online) return
      const direct = directStreams.get(member.id)
      if (direct) direct(payload)
      else send({ type: 'snapshot', target: member.id, data: payload })
      metrics.statusMessages++
      perf.record('publish.status', { seat: member.seat, busy: payload.busy, revision: payload.revision })
    },
    close() { closed = true; clearTimeout(reconnectTimer); clearInterval(keepalive); socket?.close(); rejectPending() },
  }
}
