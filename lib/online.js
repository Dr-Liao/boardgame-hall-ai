import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapshotChanges, applySnapshotChanges } from './online-sync.js'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

export function relayAddress(value) {
  const url = new URL(String(value || '').trim())
  if (url.username || url.password || url.search || url.hash) throw new Error('中转地址不能包含账号、查询参数或片段')
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('请使用 HTTPS 或 WSS 中转地址（本机测试可用 HTTP）')
  if (url.pathname === '/') url.pathname = '/ws'
  return url.href
}

// Fingerprint rules and browser code, not artwork. Different installs cannot
// accidentally share a room with incompatible rules or action formats.
export function gameVersions(mods) {
  const versions = {}
  for (const mod of mods) {
    const hash = createHash('sha256').update('boardgame-online-v2')
    const walk = dir => {
      if (!fs.existsSync(dir)) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (['node_modules', 'tests', 'tools', 'audit', 'Develop', 'docs'].includes(entry.name)) continue
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.(js|json)$/.test(entry.name)) hash.update(path.relative(project, file).replaceAll('\\', '/')).update(fs.readFileSync(file))
      }
    }
    walk(path.join(project, 'games', mod.id))
    versions[mod.id] = hash.digest('hex')
  }
  return versions
}

export function createOnline({ mods, onCommand, onRoom, stateFile, resumeState = () => ({}) }) {
  const instanceId = randomUUID()
  let socket, reconnectTimer, keepalive, closed = false, credentials = null, connecting = false
  let room = null, memberId = null, session = null, gameBusy = false, address = '', error = '', connected = false, serial = 0, attempts = 0
  let versions
  let lobby = null, receivedSnapshot = null, resyncing = false
  const sentSnapshots = new Map(), listeners = new Set()
  const directStreams = new Map(), signals = []
  let signalSeq = 0
  const metrics = { snapshots: 0, fullBytes: 0, sentBytes: 0, directBytes: 0, localCommands: 0 }
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
    signals: signals.filter(item => Date.now() - item.at < 30000).map(({ at, ...item }) => item) })
  function receiveSnapshot(message) {
    try {
      if (message.baseId && message.baseId !== receivedSnapshot?.id) throw new Error('同步基线已变化')
      const value = message.baseId ? applySnapshotChanges(receivedSnapshot.value, message.changes) : { session: message.session, busy: message.busy, lobby: message.lobby || null }
      receivedSnapshot = { id: message.snapshotId, value }
      session = value.session; gameBusy = !!value.busy; lobby = value.lobby; resyncing = false; update()
    } catch {
      if (!resyncing) { resyncing = true; rpc('request', { action: 'sync' }).catch(() => { resyncing = false }) }
    }
  }
  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('中转连接已断开，正在重新连接')
    socket.send(JSON.stringify({ id: randomUUID(), ...message }))
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
    receivedSnapshot = null; sentSnapshots.clear(); directStreams.clear(); signals.length = 0; resyncing = false
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
          else item.reject(new Error(message.error || '操作失败'))
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
          try { send({ type: 'reply', requestId: message.requestId, ok: false, error: err.message }) } catch {}
        }
      } else if (message.type === 'closed') {
        credentials = null; room = null; session = null; lobby = null; memberId = null; error = message.reason; update()
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
      const result = await connect('create', { name: profile.playerName, capacity, aiSeats: body.aiSeats, game: { id: mod.id, name: mod.name, version: versions[mod.id] } })
      if (body.aiSeats?.length && JSON.stringify(result.room.aiSeats?.map(item => item.seat)) !== JSON.stringify(body.aiSeats.map(item => item.seat))) {
        await leave()
        throw new Error('中转服务尚不支持预留 AI 席位，请更新中转服务后重试')
      }
      return result
    }
    const code = String(body.code || '').trim().toUpperCase()
    const cached = tickets.get(address + ':' + code)
    if (cached) return connect('resume', { token: cached.token, recovery: cached.room })
    const joined = await connect('join', { code, seat: body.seat, name: profile.playerName, versions })
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
    credentials = null; room = null; session = null; lobby = null; memberId = null; connected = false; connecting = false; gameBusy = false; error = ''; signals.length = 0; directStreams.clear(); update()
    if (stateFile) try { fs.rmSync(stateFile, { force: true }) } catch {}
    socket?.close(); rejectPending()
    return status()
  }
  return {
    status, me, open, leave, remember, metrics,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    resetSnapshots() { sentSnapshots.clear() },
    restore(saved) {
      versions ||= gameVersions(mods)
      if (versions[saved.room?.game?.id] !== saved.room?.game?.version) throw new Error('游戏版本已变化，请双方更新后重新创建房间')
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
      if (!member || !['move', 'chat', 'sync'].includes(action)) throw new Error('直连操作无效')
      return onCommand({ action, body, memberId: member.id, seat: member.seat })
    },
    directSnapshot(data) {
      if (me()?.host || !connected || !room?.members.some(member => member.host && member.online)) throw new Error('房主直连不可用')
      if (!data || typeof data !== 'object' || typeof data.snapshotId !== 'string') throw new Error('直连状态无效')
      receiveSnapshot(data)
      return status()
    },
    command(action, body) {
      if (me()?.host) {
        if (!connected) throw new Error('中转连接已断开，正在重新连接')
        metrics.localCommands++
        return onCommand({ action, body, memberId, seat: me().seat })
      }
      return rpc('request', { action, body })
    },
    publish(member, value, busy, lobbyValue = null) {
      if (member.id === memberId) { session = value; gameBusy = busy; lobby = lobbyValue; update(); return }
      if (!connected || !member.online) return
      const next = JSON.parse(JSON.stringify({ session: value, busy, lobby: lobbyValue }))
      const previous = sentSnapshots.get(member.id)
      const snapshotId = randomUUID()
      const full = { snapshotId, ...next }
      let data = full
      if (previous) {
        const changes = snapshotChanges(previous.value, next)
        if (!changes.length) return
        const delta = { snapshotId, baseId: previous.id, changes }
        if (JSON.stringify(delta).length < JSON.stringify(full).length) data = delta
      }
      const bytes = Buffer.byteLength(JSON.stringify(data))
      metrics.snapshots++; metrics.fullBytes += Buffer.byteLength(JSON.stringify(full))
      const direct = directStreams.get(member.id)
      if (direct) { direct(data); metrics.directBytes += bytes }
      else { send({ type: 'snapshot', target: member.id, data }); metrics.sentBytes += bytes }
      sentSnapshots.set(member.id, { id: snapshotId, value: next })
    },
    close() { closed = true; clearTimeout(reconnectTimer); clearInterval(keepalive); socket?.close(); rejectPending() },
  }
}
