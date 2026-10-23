import { createP2P } from './p2p.js'

export function createOnlineUI({ h, state, render, renderChrome = render, request, loadGame, perf = null, hydrate = null }) {
  // perf 是 app.js 在 ?perf=1 时注入的 createPerfRecorder()；不传时全部埋点分支都不执行。
  const p2p = createP2P({ request, onChange: renderChrome, perf })
  let serial = -1, appliedSerial = -1, timer, working = false
  let renderQueued = false
  let instanceId
  const retiredInstances = new Set()
  let relayUrl = localStorage.getItem('boardgame-hall.relay') || '', invitation = '', modal = false, notice = ''
  let relayDraft, settingsNotice = '', copied = false, copyTimer, inviteFallback = ''
  let joinSeat = '', stopped = false
  const mine = () => state.online?.room?.members.find(m => m.id === state.online.memberId)
  const setAddress = value => { relayUrl = value.trim(); localStorage.setItem('boardgame-hall.relay', relayUrl) }
  const sessionStamp = session => session ? [
    session.sessionId, session.state?.revision, session.events?.at(-1)?.seq,
    session.state?.pendingChoice?.id, session.state?.status, session.state?.uiState,
  ].join(':') : ''
  const actionStamp = online => {
    const host = online?.room?.members?.find(member => member.host)
    return [online?.connected, online?.busy, host?.online].join(':')
  }
  const decisionSeat = session => session?.state?.pendingChoice?.seat ?? session?.state?.currentSeat
  const scheduleRender = force => {
    if (force) {
      renderQueued = false
      render({ force: true })
      return
    }
    if (renderQueued) return
    renderQueued = true
    queueMicrotask(() => {
      if (!renderQueued) return
      renderQueued = false
      render()
    })
  }
  function accept(value) {
    // apply 的同步耗时：state.online/state.session 更新 + p2p.update；提前返回的旧响应也记一条（sessionChanged=false）。
    const perfStarted = perf ? performance.now() : 0
    const recordApply = sessionChanged => {
      if (perf) perf.recordApply({ serial: value?.serial, sessionChanged, ms: performance.now() - perfStarted })
    }
    const previousOnline = state.online
    const previousSession = state.session
    const previousView = state.view
    const previousInstance = instanceId
    if (value.instanceId && value.instanceId !== instanceId) {
      if (retiredInstances.has(value.instanceId)) { recordApply(false); return { changed: false } }
      if (instanceId) retiredInstances.add(instanceId)
      instanceId = value.instanceId; serial = -1; appliedSerial = -1
    }
    // A slower status request must not undo a newer snapshot or room closure.
    if (value.serial < serial) { recordApply(false); return { changed: false } }
    let changed = serial !== value.serial
    const wasOnline = !!state.online?.room
    serial = value.serial; state.online = value
    p2p.update(value)
    if (!relayUrl && value.relayUrl) setAddress(value.relayUrl)
    if (value.room) {
      state.setup = null
      // P3.1：服务器确认「本地已是同一份会话」（sessionOmitted）时只更新 busy/lobby 等在线字段，
      // 不重建会话、不触发 loadGame；慢请求回滚的保护由上面的 serial 判断负责。
      const sessionOmitted = value.sessionOmitted === true && !!state.session
      // P1.4：应用会话前先 hydrate 公共静态表；本地没有匹配版本时保留当前完整视图，
      // 等大厅在后续响应里补发 static（失败模式只会是「慢一拍」，不会把精简会话当完整视图渲染）。
      const nextSession = value.session ? (hydrate ? hydrate(value.session) : value.session) : null
      if (sessionOmitted) {
        changed ||= appliedSerial !== value.serial
      } else if (value.session && !nextSession) {
        // 等静态表；本次不应用这份精简会话。
      } else if (nextSession && !state.busy && !(state.chat.pendings || []).length) {
        // Busy actions defer applying snapshots, not just rendering them.
        // Remember that deferred work even if its serial was already observed.
        changed ||= appliedSerial !== value.serial
        state.session = nextSession; state.view = 'game'
        appliedSerial = value.serial
        loadGame(state.catalog.find(g => g.id === nextSession.modId))
      } else if (!value.session && !sessionOmitted) { state.session = null; state.view = 'room' }
    } else if (wasOnline) { state.session = null; state.view = 'library'; state.error = value.error || null; appliedSerial = -1 }
    const lifecycle = previousInstance !== instanceId || !!previousOnline?.room !== !!state.online?.room
      || previousSession?.sessionId !== state.session?.sessionId || previousView !== state.view
    const sessionChanged = sessionStamp(previousSession) !== sessionStamp(state.session)
    const actionability = actionStamp(previousOnline) !== actionStamp(state.online)
    const mySeat = state.session?.mySeat
    const handoff = mySeat != null && decisionSeat(previousSession) !== mySeat && decisionSeat(state.session) === mySeat
    recordApply(sessionChanged)
    return { changed, lifecycle, sessionChanged, actionability, handoff }
  }
  async function refresh(wait = false) {
    const query = wait ? `?wait=1&after=${serial}&instanceId=${encodeURIComponent(instanceId || '')}` : ''
    const value = await request('GET', '/online/status' + query)
    const change = accept(value)
    if (change.changed) {
      const full = change.lifecycle || change.sessionChanged || change.actionability || state.view === 'room'
      if (full) scheduleRender(change.lifecycle || change.actionability || change.handoff)
      else renderChrome()
    }
    return value
  }
  async function run(fn) {
    if (working) return
    working = true; notice = ''; render()
    // P1.2：命令自己负责刷新（move/chat 不刷新，靠快照 + 长轮询），这里不再无条件多拉一次
    // /online/status；失败时 command() 里已有一次 GET /status 兜底。
    try { await fn() } catch (error) { notice = error.message; state.error = error.message }
    finally { working = false; render() }
  }
  function settingsPanel() {
    return h('div', { className: 'bg-online-settings' },
      h('p', { className: 'bg-desc' }, '设置创建房间和通过房间码加入时使用的中转服务。完整邀请会自动使用房主的地址。'),
      h('label', { className: 'bg-field' }, h('span', {}, '中转服务地址'),
        h('input', { className: 'bg-input', type: 'url', 'aria-label': '中转服务地址', value: relayDraft ?? relayUrl,
          oninput: e => { relayDraft = e.target.value; settingsNotice = '' } })),
      h('button', { className: 'bg-btn', onclick: () => {
        try {
          const value = (relayDraft ?? relayUrl).trim(), url = new URL(value)
          if (url.username || url.password || url.search || url.hash ||
              !(['https:', 'wss:'].includes(url.protocol) || ['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('请输入 HTTPS 中转地址；本机测试可使用 HTTP。')
          setAddress(value); relayDraft = value; settingsNotice = '联机设置已保存，下次创建或加入房间时生效。'
        } catch (error) { settingsNotice = error.message === 'Invalid URL' ? '请输入有效的中转服务地址。' : error.message }
        render()
      } }, '保存联机设置'),
      settingsNotice ? h('p', { role: 'status', className: 'bg-field-hint' }, settingsNotice) : null)
  }
  function capacity(game) {
    const setup = state.setup, min = setup.online ? Math.max(2, game.players[0]) : game.players[0]
    const count = Number(setup.form.playerCount ?? (setup.form.teammates == null ? game.seats : Number(setup.form.teammates) + 1))
    setup.form.playerCount = Math.max(min, Math.min(game.seats, count))
    setup.form.teammates = setup.form.playerCount - 1
    return setup.form.playerCount
  }
  function setupFields(game) {
    const setup = state.setup, count = capacity(game), min = setup.online ? Math.max(2, game.players[0]) : game.players[0]
    setup.onlineSeats ||= []
    setup.form.opponents ||= []
    const picker = (options, value, label, change) => h('select', { className: 'bg-select', 'aria-label': label, onchange: e => { change(e.target.value); render() } },
      options.map(option => h('option', { value: String(option.value), selected: String(option.value) === String(value) }, option.label)))
    return h('section', { className: 'bg-seat-setup', 'aria-label': '游戏方式与席位' },
      h('div', { className: 'bg-play-modes', role: 'group', 'aria-label': '游戏方式' },
        [false, true].map(online => h('button', { type: 'button', 'aria-pressed': String(!!setup.online === online), onclick: () => { setup.online = online; capacity(game); render() } },
          online ? '联机房间' : '本地游玩'))),
      h('label', { className: 'bg-field' }, h('span', {}, '席位数量'),
        picker(Array.from({ length: game.seats - min + 1 }, (_, i) => ({ value: min + i, label: `${min + i} 个席位` })), count, '席位数量', value => { setup.form.playerCount = Number(value); setup.form.teammates = Number(value) - 1 })),
      h('div', { className: 'bg-seat-list' },
        h('div', { className: 'bg-seat-row' }, h('span', { className: 'bg-seat-number' }, '1'), h('div', {}, h('strong', {}, state.config?.playerName || '你'), h('small', {}, setup.online ? '房主 · 玩家席位' : '你的席位'))),
        Array.from({ length: count - 1 }, (_, i) => {
          const selected = setup.online ? setup.onlineSeats[i] || '__human__' : setup.form.opponents[i] || '__random__'
          return h('label', { className: 'bg-seat-row' }, h('span', { className: 'bg-seat-number' }, String(i + 2)),
            picker([...(setup.online ? [{ value: '__human__', label: '等待玩家加入' }] : []), { value: '__random__', label: '🎲 随机 AI' },
              ...state.ais.map(ai => ({ value: ai.id, label: ai.name }))], selected, setup.online ? `席位 ${i + 2}` : `AI 队友 ${i + 1}`, value => {
                if (setup.online) setup.onlineSeats[i] = value
                else setup.form.opponents[i] = value
              }))
        })),
      h('p', { className: 'bg-field-hint' }, setup.online ? '玩家只能加入空出的玩家席位。AI 席位已预留，使用房主的模型设置。' : '其余席位由选择的 AI 角色参与。'))
  }
  function setupSettings(settings) {
    const count = capacity(state.setup.game)
    return { ...settings, playerCount: count, teammates: count - 1,
      opponents: Array.from({ length: count - 1 }, (_, i) => {
        const value = state.setup.online ? state.setup.onlineSeats?.[i] : state.setup.form.opponents?.[i]
        return !value || value.startsWith('__') ? null : value
      }) }
  }
  async function create(game, settings) {
    const setup = state.setup
    const count = capacity(game)
    const aiSeats = Array.from({ length: count - 1 }, (_, i) => ({ seat: i + 1, value: setup.onlineSeats?.[i] || '__human__' }))
      .filter(item => item.value !== '__human__').map(item => ({ seat: item.seat, aiId: item.value === '__random__' ? null : item.value }))
    const result = await request('POST', '/online/create', { relayUrl, modId: game.id, settings, capacity: count, aiSeats, fillAi: false })
    accept(result); state.setup = null; state.session = null; state.view = 'room'
  }
  async function join() {
    let code = invitation.trim()
    if (code.startsWith('BGH1 ')) {
      const parts = code.split(/\s+/)
      if (parts.length !== 3) throw new Error('邀请内容不完整')
      setAddress(parts[1]); code = parts[2]
    }
    const result = await request('POST', '/online/join', { relayUrl, code, ...(joinSeat ? { seat: Number(joinSeat) } : {}) })
    accept(result); modal = false
  }
  async function leave() {
    const result = await request('POST', '/online/leave', {})
    accept(result); state.session = null; state.view = 'library'; state.chat.open = false
    render()
  }
  async function loadSave(sessionId) {
    const result = await request('POST', '/online/load', { relayUrl, sessionId })
    accept(result); state.setup = null; state.session = null; state.view = 'room'
    state.error = null; render()
    return result
  }
  async function copyInvite() {
    const room = state.online?.room
    if (!room) return
    const invite = `BGH1 ${state.online.relayUrl} ${room.code}`
    try {
      await navigator.clipboard.writeText(invite)
      copied = true; clearTimeout(copyTimer)
      copyTimer = setTimeout(() => { copied = false; render() }, 2500)
    } catch { inviteFallback = invite }
    render()
  }
  async function command(action, body = {}) {
    const perfStarted = perf ? performance.now() : 0
    let transport = 'relay'
    try {
      // P1.2：move / chat 声明只要摘要响应（客人路径不再随命令传整份视图，快照由长轮询送达）。
      const slim = action === 'move' || action === 'chat'
      const payload = { ...body, operationId: body.operationId || crypto.randomUUID(),
        ...(slim ? { client: { ...(body.client || {}), slim: true } } : {}) }
      let result
      if (p2p.direct() && ['move', 'chat'].includes(action)) {
        transport = 'direct'
        try { result = await p2p.command(action, payload) }
        catch (error) {
          transport = 'relay'
          if (!error.transport) throw error
          result = await request('POST', '/online/command', { action, body: payload })
        }
      } else result = await request('POST', '/online/command', { action, body: payload })
      // 直连命令的总耗时由 p2p.command 记录（它还包含等待本地 revision 的轮询），这里只记中转路径，避免一次操作两条记录。
      if (perf && transport === 'relay') perf.recordCommand({ action, transport, ms: performance.now() - perfStarted })
      // P2.2：AI 回合在后台继续（aiPending）时，命令响应会先回来；这里立刻把「忙碌 + AI 思考中」
      // 写进本地联机状态，避免 start/aiRetry 随后的 long-poll 刷新把等待窗口拖长，
      // 同时让 Mod UI（看 state.online.busy / aiPending）在 state.busy 被清掉后仍然禁用行动入口。
      if (result && (result.aiPending === true || result.busy === true)) {
        state.online = { ...(state.online || {}), busy: true, aiPending: result.aiPending === true }
        renderChrome()
      }
      // P1.2：move / chat 不再显式 refresh()——响应本身已不含会话，页面靠快照 + 长轮询更新；
      // start / reset / save / forkCheckpoint / aiRetry 等仍需要这一下拉齐本地状态。
      if (!slim) await refresh()
      return result
    } catch (error) {
      const latest = await request('GET', '/online/status').catch(() => null)
      if (latest) { accept(latest); error.session = state.online?.session }
      throw error
    }
  }
  function banner() {
    const online = state.online, room = online?.room
    if (!room) return null
    const me = mine(), host = room.members.find(m => m.host)
    // P2.2：AI 在后台思考时显示更明确的状态（旧大厅没有 aiPending 字段时退回原文案）。
    const connection = !online.connected ? '连接中断，正在重连…' : !host?.online ? '房主离线，等待恢复…'
      : online.busy ? (online.aiPending ? 'AI 思考中…' : '正在处理行动…') : `已连接 · ${p2p.status()}`
    return h('section', { className: 'bg-online-banner', 'aria-label': '联机房间' },
      h('div', { className: 'bg-online-summary' }, h('strong', {}, room.game.name),
        h('span', { className: 'bg-online-meta' }, h('span', { className: 'bg-room-code' }, `房间 ${room.code}`), h('span', { role: 'status' }, `${connection} · 席位 ${Number(me?.seat) + 1}`))),
      h('div', { className: 'bg-online-actions' },
        h('button', { className: 'bg-btn secondary bg-copy-invite', 'aria-label': '复制邀请', onclick: copyInvite }, copied ? '✓ 已复制' : '复制邀请'),
        h('button', { className: 'bg-btn secondary', onclick: () => { state.settingsOpen = true; state.settingsTab = 'online'; render() } }, '联机设置'),
        h('button', { className: 'bg-btn danger', disabled: working, onclick: () => run(leave) }, me?.host ? '解散房间' : '离开房间')),
      online.error ? h('p', { role: 'alert', className: 'bg-online-notice' }, online.error) : null,
      copied ? h('div', { role: 'status', className: 'bg-copy-toast' }, '邀请已复制，发给朋友后在大厅粘贴加入。') : null,
      notice ? h('p', { role: 'alert', className: 'bg-online-notice' }, notice) : null)
  }
  function waitingRoom() {
    const online = state.online, room = online?.room
    if (!room) return null
    const me = mine(), saved = online.lobby?.savedGame
    const aiSeats = room.aiSeats || [], humanCount = room.capacity - aiSeats.length
    const allJoined = room.members.length === humanCount
    return h('div', { className: 'bg-lib bg-online-room' },
      h('div', { className: 'bg-room-heading' }, h('span', { className: 'bg-room-eyebrow' }, saved ? '联机存档' : '联机准备'), h('h2', {}, '等待玩家加入'),
        h('p', { className: 'bg-desc' }, saved ? '存档已读取。请朋友加入原来的席位，所有玩家准备后继续原有进度。' : '复制邀请发给朋友，所有玩家入座并准备后即可开始。'),
        h('span', { className: 'bg-room-count' }, `${room.members.length} / ${humanCount} 玩家已入座${aiSeats.length ? ` · ${aiSeats.length} 个 AI 席位` : ''}`)),
      h('div', { className: 'bg-online-seats' }, Array.from({ length: room.capacity }, (_, seat) => {
        const member = room.members.find(m => m.seat === seat)
        const ai = aiSeats.find(m => m.seat === seat)
        return h('div', { className: 'bg-online-seat' + (ai ? ' is-ai' : member ? ' is-occupied' : ' is-empty'), 'data-room-seat': seat },
          h('span', { className: 'bg-seat-number' }, String(seat + 1)),
          h('div', {}, h('strong', {}, member?.name || ai?.name || (saved ? `原玩家：${online.lobby.players.find(p => p.seat === seat)?.name || '等待玩家'}` : '等待玩家')),
            h('span', { className: 'bg-seat-status' }, ai ? 'AI · 已预留，玩家不可加入' : member ? `${member.host ? '房主 · ' : ''}${!member.online ? '已断线' : member.ready ? '已准备' : '未准备'}` : '空闲玩家席位')))
      })),
      h('div', { className: 'bg-online-actions' },
        me?.host ? h('button', { className: 'bg-btn', disabled: working || !online.connected || !allJoined || room.phase !== 'waiting' || room.members.some(m => !m.online || !m.ready),
          onclick: () => run(() => command('start')) }, room.phase === 'starting' ? '正在开始…' : saved ? '继续存档对局' : '开始联机对局')
          : h('button', { className: 'bg-btn', disabled: working || !online.connected || room.phase !== 'waiting', onclick: () => run(() => request('POST', '/online/ready', { ready: !me?.ready })) }, me?.ready ? '取消准备' : '准备'),
        h('p', { className: 'bg-field-hint' }, me?.host && !allJoined ? '等待其余玩家入座。' : '房主需保持大厅运行。网络中断后会自动尝试重连。')))
  }
  function joinModal() {
    if (inviteFallback) return h('div', { className: 'bg-backdrop' }, h('div', { className: 'bg-modal', role: 'dialog', 'aria-label': '手动复制邀请' },
      h('h2', {}, '复制邀请'), h('p', { className: 'bg-desc' }, '浏览器未允许访问剪贴板，请选中下方内容手动复制。'),
      h('textarea', { className: 'bg-input', 'aria-label': '邀请内容', readOnly: true, value: inviteFallback, onclick: e => e.target.select() }),
      h('div', { className: 'bg-modal-foot' }, h('button', { className: 'bg-btn', onclick: () => { inviteFallback = ''; render() } }, '关闭'))))
    if (!modal) return null
    return h('div', { className: 'bg-backdrop' }, h('div', { className: 'bg-modal', role: 'dialog', 'aria-label': '加入联机房间' },
      h('h2', {}, '加入联机房间'),
      h('label', { className: 'bg-field' }, h('span', {}, '房间码或完整邀请'), h('input', { className: 'bg-input', value: invitation, 'aria-label': '房间码或完整邀请', placeholder: '粘贴房主复制的邀请内容', oninput: e => { invitation = e.target.value } })),
      h('label', { className: 'bg-field' }, h('span', {}, '加入席位'), h('select', { className: 'bg-select', 'aria-label': '加入席位', onchange: e => { joinSeat = e.target.value } },
        [{ value: '', label: '自动分配空闲席位' }, ...Array.from({ length: 7 }, (_, i) => ({ value: String(i + 1), label: `席位 ${i + 2}` }))].map(item => h('option', { value: item.value, selected: joinSeat === item.value }, item.label)))),
      h('p', { className: 'bg-field-hint' }, '继续联机存档时，请选择自己原来的席位。'),
      h('p', { className: 'bg-desc' }, '完整邀请可直接加入；仅输入房间码时使用“设置 → 联机”中的中转服务。'),
      notice ? h('p', { role: 'alert' }, notice) : null,
      h('div', { className: 'bg-modal-foot' }, h('button', { className: 'bg-btn secondary', disabled: working, onclick: () => { modal = false; render() } }, '取消'),
        h('button', { className: 'bg-btn', disabled: working, onclick: () => run(join) }, working ? '正在连接…' : '加入房间'))))
  }
  async function boot() {
    await refresh()
    const poll = async () => {
      let delay = state.online?.room ? 0 : 2500
      try { await refresh(!!state.online?.room); if (state.online?.room) delay = 0 } catch { delay = 1500 }
      if (!stopped) timer = setTimeout(poll, delay)
    }
    timer = setTimeout(poll, 0)
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer) })
  }
  return { setupFields, setupSettings, settingsPanel, create, command, leave, loadSave, banner, waitingRoom, joinModal, boot,
    applyPending: () => state.online && accept(state.online),
    joinButton: () => h('button', { className: 'bg-btn secondary', onclick: () => { notice = ''; modal = true; render() } }, '加入联机房间') }
}
