import { createP2P } from './p2p.js'
import { t } from './i18n.js'

export function createOnlineUI({ h, state, render, renderChrome = render, request, loadGame, perf = null, hydrate = null, recover = null }) {
  // perf 是 app.js 在 ?perf=1 时注入的 createPerfRecorder()；不传时全部埋点分支都不执行。
  const p2p = createP2P({ request, onChange: renderChrome, perf })
  let serial = -1, appliedSerial = -1, timer, working = false
  let resyncing = false
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
  // p2p.status() 目前返回中文短语（'中转' / '直连' / '直连 N 人'）。p2p.js 不在本次 i18n 抽取范围，
  // 这里做一层显示适配：匹配已知形状后按当前语言输出，未知形状原样透传（后续可让 p2p.js 返回结构化状态）。
  const transportText = () => {
    const raw = p2p.status()
    if (raw === '中转') return t('online.transport.relay')
    if (raw === '直连') return t('online.transport.direct')
    const peers = /^直连 (\d+) 人$/.exec(raw)
    return peers ? t('online.transport.directPeers', { count: peers[1] }) : raw
  }
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
  function accept(value, options = {}) {
    const forceApply = options.force === true
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
    // P3.1：服务器确认「本地已是同一份会话」（sessionOmitted）时只更新 busy/lobby 等在线字段，
    // 不重建会话、不触发 loadGame；慢请求回滚的保护由上面的 serial 判断负责。
    const sessionOmitted = value.sessionOmitted === true && !!previousSession
    // 忙碌期间收到的快照只记 serial、不应用，唯一的副本留在 state.online.session 里。
    // sessionOmitted 表示「内容与上次发给本浏览器的视图完全相同」，响应里不再带 session；
    // 若直接用它覆盖 state.online 就会丢掉这份待应用视图：之后服务端在等本玩家行动、
    // serial 不再变化，长轮询一路挂到超时，界面永远停在旧 revision（再点只会拿到
    // STALE_REVISION）。所以把上次视图保留在响应对象上，等忙碌结束后补应用。
    if (sessionOmitted && !value.session && previousOnline?.session) value.session = previousOnline.session
    serial = value.serial; state.online = value
    p2p.update(value)
    if (!relayUrl && value.relayUrl) setAddress(value.relayUrl)
    if (value.room) {
      state.setup = null
      // P1.4：应用会话前先 hydrate 公共静态表；本地没有匹配版本时保留当前完整视图，
      // 等大厅在后续响应里补发 static（失败模式只会是「慢一拍」，不会把精简会话当完整视图渲染）。
      const nextSession = value.session ? (hydrate ? hydrate(value.session) : value.session) : null
      // 强制同步（用户手动恢复）时不受本地忙碌/聊天在途影响，直接应用权威视图。
      const canApplySession = forceApply || (!state.busy && !(state.chat.pendings || []).length)
      if (sessionOmitted) {
        changed ||= appliedSerial !== value.serial
        // 忙碌期间收到、还没应用的视图：忙碌结束后即使 serial 没变也要补应用
        // （正常路径里这份视图会随下一次带 session 的响应重新到达，长轮询在等待
        // 本玩家行动时却不会有下一次，必须在这里兜底）。
        if (nextSession && canApplySession
            && sessionStamp(state.session) !== sessionStamp(nextSession)) {
          state.session = nextSession; state.view = 'game'
          appliedSerial = value.serial
          loadGame(state.catalog.find(g => g.id === nextSession.modId))
          changed = true
        }
      } else if (value.session && !nextSession) {
        // 等静态表；本次不应用这份精简会话。
      } else if (nextSession && canApplySession) {
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
      h('p', { className: 'bg-desc' }, t('online.settings.desc')),
      h('label', { className: 'bg-field' }, h('span', {}, t('online.settings.relayLabel')),
        h('input', { className: 'bg-input', type: 'url', 'aria-label': t('online.settings.relayLabel'), value: relayDraft ?? relayUrl,
          oninput: e => { relayDraft = e.target.value; settingsNotice = '' } })),
      h('button', { className: 'bg-btn', onclick: () => {
        try {
          const value = (relayDraft ?? relayUrl).trim(), url = new URL(value)
          if (url.username || url.password || url.search || url.hash ||
              !(['https:', 'wss:'].includes(url.protocol) || ['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error(t('online.settings.invalidProtocol'))
          setAddress(value); relayDraft = value; settingsNotice = t('online.settings.saved')
        } catch (error) { settingsNotice = error.message === 'Invalid URL' ? t('online.settings.invalidUrl') : error.message }
        render()
      } }, t('online.settings.save')),
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
    return h('section', { className: 'bg-seat-setup', 'aria-label': t('online.setup.modeLabel') },
      h('div', { className: 'bg-play-modes', role: 'group', 'aria-label': t('online.setup.modeGroup') },
        [false, true].map(online => h('button', { type: 'button', 'aria-pressed': String(!!setup.online === online), onclick: () => { setup.online = online; capacity(game); render() } },
          online ? t('online.setup.modeOnline') : t('online.setup.modeLocal')))),
      h('label', { className: 'bg-field' }, h('span', {}, t('online.setup.seatsLabel')),
        picker(Array.from({ length: game.seats - min + 1 }, (_, i) => ({ value: min + i, label: t('online.setup.seatsOption', { count: min + i }) })), count, t('online.setup.seatsLabel'), value => { setup.form.playerCount = Number(value); setup.form.teammates = Number(value) - 1 })),
      h('div', { className: 'bg-seat-list' },
        h('div', { className: 'bg-seat-row' }, h('span', { className: 'bg-seat-number' }, '1'), h('div', {}, h('strong', {}, state.config?.playerName || t('online.setup.you')), h('small', {}, setup.online ? t('online.setup.hostSeat') : t('online.setup.yourSeat')))),
        Array.from({ length: count - 1 }, (_, i) => {
          const selected = setup.online ? setup.onlineSeats[i] || '__human__' : setup.form.opponents[i] || '__random__'
          return h('label', { className: 'bg-seat-row' }, h('span', { className: 'bg-seat-number' }, String(i + 2)),
            picker([...(setup.online ? [{ value: '__human__', label: t('online.setup.waitingPlayerOption') }] : []), { value: '__random__', label: t('online.setup.randomAi') },
              ...state.ais.map(ai => ({ value: ai.id, label: ai.name }))], selected, setup.online ? t('online.setup.seatPickerLabel', { seat: i + 2 }) : t('online.setup.aiSlotLabel', { index: i + 1 }), value => {
                if (setup.online) setup.onlineSeats[i] = value
                else setup.form.opponents[i] = value
              }))
        })),
      h('p', { className: 'bg-field-hint' }, setup.online ? t('online.setup.onlineHint') : t('online.setup.localHint')))
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
      if (parts.length !== 3) throw new Error(t('online.invite.incomplete'))
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
      // P1.2：move / chat / prefs（轻量偏好同步）声明只要摘要响应，省掉命令后的整份 status 刷新。
      const slim = action === 'move' || action === 'chat' || action === 'prefs'
      const payload = { ...body, operationId: body.operationId || crypto.randomUUID(),
        ...(slim ? { client: { ...(body.client || {}), slim: true } } : {}) }
      let result
      if (p2p.direct() && ['move', 'chat', 'prefs'].includes(action)) {
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
  /**
   * 强制同步（卡住恢复）：把本客户端手动拉回房主的权威局面。
   * 覆盖三类阻塞：①丢过快照/界面停在旧 revision；②异常中断的行动把本地 busy/movePending
   * 留在 true；③房主快照基线错乱导致长轮询只回 sessionOmitted。
   * 只重建展示状态，不提交任何游戏动作；房主的对局状态不会被这个按钮改变。
   */
  async function forceResync() {
    if (!state.online?.room || resyncing) return false
    resyncing = true
    notice = t('online.resync.pending')
    renderChrome()
    let synced = false
    try {
      // ① 先解除本地门闩（不是对局状态）：异常中断的行动可能留下 busy/movePending。
      state.busy = false
      state.movePending = null
      state.error = null
      // ② 请房主重置快照基线并广播一份完整快照；客人经 relay，房主本地直接执行。
      //    失败也继续走 ③（例如房主暂时离线时至少把本厅能拿到的最新视图画出来）。
      let targetRevision = null
      try {
        const result = await request('POST', '/online/command', { action: 'sync', body: {} })
        if (Number.isInteger(result?.session?.state?.revision)) targetRevision = result.session.state.revision
      } catch { /* 连接不可用时继续尝试下面的全量 status */ }
      // ③ 无条件拉全量（full=1 跳过长轮询等待与 sessionOmitted/delta 判定），强制应用。
      serial = -1
      appliedSerial = -1
      for (const delay of [0, 150, 600]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay))
        const value = await request('GET', '/online/status?full=1')
        accept(value, { force: true })
        const reached = state.session && (targetRevision === null || state.session.state.revision >= targetRevision)
        // 等待房间还没有 session 是正常状态：房间/准备信息同步成功即视为恢复。
        const lobbyOnly = !state.session && state.online?.room?.phase !== 'playing'
        if (reached || lobbyOnly) { synced = true; break }
      }
      if (!state.session && state.online?.room?.phase === 'playing') synced = false
      // ④ 让当前 Mod 清掉自己的本地演出/选择门闩（旧 Mod 没有该钩子时跳过）。
      try { recover?.() } catch { /* Mod 恢复钩子异常不影响大厅恢复 */ }
      notice = !synced ? t('online.resync.failed')
        : state.online?.busy ? t('online.resync.busy') : t('online.resync.done')
    } catch {
      notice = t('online.resync.failed')
    } finally {
      resyncing = false
      render()
    }
    return synced
  }
  const memberStatus = member => {
    const status = !member.online ? t('online.room.disconnected') : member.ready ? t('online.room.ready') : t('online.room.notReady')
    return member.host ? t('online.room.hostStatus', { status }) : status
  }
  function banner() {
    const online = state.online, room = online?.room
    if (!room) return null
    const me = mine(), host = room.members.find(m => m.host)
    // P2.2：AI 在后台思考时显示更明确的状态（旧大厅没有 aiPending 字段时退回原文案）。
    const connection = !online.connected ? t('online.banner.disconnected') : !host?.online ? t('online.banner.hostOffline')
      : online.busy ? (online.aiPending ? t('online.banner.aiThinking') : t('online.banner.processing')) : t('online.banner.connected', { transport: transportText() })
    return h('section', { className: 'bg-online-banner', 'aria-label': t('online.banner.label') },
      h('div', { className: 'bg-online-summary' }, h('strong', {}, room.game.name),
        h('span', { className: 'bg-online-meta' }, h('span', { className: 'bg-room-code' }, t('online.room.code', { code: room.code })), h('span', { role: 'status' }, t('online.banner.seat', { connection, seat: Number(me?.seat) + 1 })))),
      h('div', { className: 'bg-online-actions' },
        h('button', { className: 'bg-btn secondary bg-copy-invite', 'aria-label': t('online.copyInvite'), onclick: copyInvite }, copied ? t('online.copied') : t('online.copyInvite')),
        // 卡住恢复入口：任何操作看起来卡死时都可点；不依赖 working/busy，点了就强制拉回权威局面。
        h('button', { className: 'bg-btn secondary bg-online-resync', type: 'button', 'aria-busy': String(resyncing),
          title: t('online.resync.title'), 'aria-label': t('online.resync.title'), disabled: resyncing,
          onclick: () => { forceResync().catch(() => { notice = t('online.resync.failed'); render() }) } },
        resyncing ? t('online.resync.pending') : t('online.resync.label')),
        h('button', { className: 'bg-btn secondary', onclick: () => { state.settingsOpen = true; state.settingsTab = 'online'; render() } }, t('online.settingsButton')),
        h('button', { className: 'bg-btn danger', disabled: working, onclick: () => run(leave) }, me?.host ? t('online.dissolveRoom') : t('online.leaveRoom'))),
      online.error ? h('p', { role: 'alert', className: 'bg-online-notice' }, online.error) : null,
      copied ? h('div', { role: 'status', className: 'bg-copy-toast' }, t('online.invite.copiedToast')) : null,
      notice ? h('p', { role: 'alert', className: 'bg-online-notice' }, notice) : null)
  }
  function waitingRoom() {
    const online = state.online, room = online?.room
    if (!room) return null
    const me = mine(), saved = online.lobby?.savedGame
    const aiSeats = room.aiSeats || [], humanCount = room.capacity - aiSeats.length
    const allJoined = room.members.length === humanCount
    return h('div', { className: 'bg-lib bg-online-room' },
      h('div', { className: 'bg-room-heading' }, h('span', { className: 'bg-room-eyebrow' }, saved ? t('online.room.eyebrowSaved') : t('online.room.eyebrowReady')), h('h2', {}, t('online.room.waitingTitle')),
        h('p', { className: 'bg-desc' }, saved ? t('online.room.savedDesc') : t('online.room.newDesc')),
        h('span', { className: 'bg-room-count' }, aiSeats.length
          ? t('online.room.seatedWithAi', { joined: room.members.length, total: humanCount, count: aiSeats.length })
          : t('online.room.seated', { joined: room.members.length, total: humanCount }))),
      h('div', { className: 'bg-online-seats' }, Array.from({ length: room.capacity }, (_, seat) => {
        const member = room.members.find(m => m.seat === seat)
        const ai = aiSeats.find(m => m.seat === seat)
        return h('div', { className: 'bg-online-seat' + (ai ? ' is-ai' : member ? ' is-occupied' : ' is-empty'), 'data-room-seat': seat },
          h('span', { className: 'bg-seat-number' }, String(seat + 1)),
          h('div', {}, h('strong', {}, member?.name || ai?.name || (saved ? t('online.room.originalPlayer', { name: online.lobby.players.find(p => p.seat === seat)?.name || t('online.room.waitingPlayer') }) : t('online.room.waitingPlayer'))),
            h('span', { className: 'bg-seat-status' }, ai ? t('online.room.aiReserved') : member ? memberStatus(member) : t('online.room.emptySeat'))))
      })),
      h('div', { className: 'bg-online-actions' },
        me?.host ? h('button', { className: 'bg-btn', disabled: working || !online.connected || !allJoined || room.phase !== 'waiting' || room.members.some(m => !m.online || !m.ready),
          onclick: () => run(() => command('start')) }, room.phase === 'starting' ? t('online.room.starting') : saved ? t('online.room.continueSaved') : t('online.room.startOnline'))
          : h('button', { className: 'bg-btn', disabled: working || !online.connected || room.phase !== 'waiting', onclick: () => run(() => request('POST', '/online/ready', { ready: !me?.ready })) }, me?.ready ? t('online.room.cancelReady') : t('online.room.readyButton')),
        h('p', { className: 'bg-field-hint' }, me?.host && !allJoined ? t('online.room.waitingOthers') : t('online.room.hostKeepRunning'))))
  }
  function joinModal() {
    if (inviteFallback) return h('div', { className: 'bg-backdrop' }, h('div', { className: 'bg-modal', role: 'dialog', 'aria-label': t('online.manualCopy.label') },
      h('h2', {}, t('online.copyInvite')), h('p', { className: 'bg-desc' }, t('online.manualCopy.desc')),
      h('textarea', { className: 'bg-input', 'aria-label': t('online.manualCopy.inviteLabel'), readOnly: true, value: inviteFallback, onclick: e => e.target.select() }),
      h('div', { className: 'bg-modal-foot' }, h('button', { className: 'bg-btn', onclick: () => { inviteFallback = ''; render() } }, t('online.manualCopy.close')))))
    if (!modal) return null
    return h('div', { className: 'bg-backdrop' }, h('div', { className: 'bg-modal', role: 'dialog', 'aria-label': t('online.join.label') },
      h('h2', {}, t('online.join.title')),
      h('label', { className: 'bg-field' }, h('span', {}, t('online.join.codeLabel')), h('input', { className: 'bg-input', value: invitation, 'aria-label': t('online.join.codeLabel'), placeholder: t('online.join.codePlaceholder'), oninput: e => { invitation = e.target.value } })),
      h('label', { className: 'bg-field' }, h('span', {}, t('online.join.seatLabel')), h('select', { className: 'bg-select', 'aria-label': t('online.join.seatLabel'), onchange: e => { joinSeat = e.target.value } },
        [{ value: '', label: t('online.join.autoSeat') }, ...Array.from({ length: 7 }, (_, i) => ({ value: String(i + 1), label: t('online.join.seatOption', { seat: i + 2 }) }))].map(item => h('option', { value: item.value, selected: joinSeat === item.value }, item.label)))),
      h('p', { className: 'bg-field-hint' }, t('online.join.seatHint')),
      h('p', { className: 'bg-desc' }, t('online.join.fullInviteHint')),
      notice ? h('p', { role: 'alert' }, notice) : null,
      h('div', { className: 'bg-modal-foot' }, h('button', { className: 'bg-btn secondary', disabled: working, onclick: () => { modal = false; render() } }, t('online.join.cancel')),
        h('button', { className: 'bg-btn', disabled: working, onclick: () => run(join) }, working ? t('online.join.connecting') : t('online.join.join')))))
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
  /**
   * 语言切换钩子（hall-shell 在 setLocale() 之后调用）：本模块不缓存成句文案，房间/横幅/弹窗/设置
   * 每次渲染都重新取 t()。只有设置面板里保存瞬间生成的提示字符串会残留旧语言，这里清掉；
   * 不重置房间、对局、轮询与复制状态（app.js 随后会 render() 重建界面）。
   */
  function onLocaleChange() {
    settingsNotice = ''
    notice = ''
  }
  return { setupFields, setupSettings, settingsPanel, create, command, leave, loadSave, banner, waitingRoom, joinModal, boot,
    onLocaleChange, forceResync,
    applyPending: () => state.online && accept(state.online),
    joinButton: () => h('button', { className: 'bg-btn secondary', onclick: () => { notice = ''; modal = true; render() } }, t('online.join.joinButton')) }
}
