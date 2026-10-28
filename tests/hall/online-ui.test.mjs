import test from 'node:test'
import assert from 'node:assert/strict'
import { createOnlineUI } from '../../public/online-ui.js'
import { onlineEventHistory } from '../../lib/online.js'

test('long online campaigns keep recent animations and full text without growing past the relay message limit', () => {
  const snapshot = { investigators: [{ seat: 0, hand: ['private-card'] }], log: ['x'.repeat(10000)] }
  const events = Array.from({ length: 1000 }, (_, seq) => ({ seq, type: 'info', text: `history ${seq}`,
    privateSeat: seq % 2 ? 1 : undefined, presentation: { kind: 'automatic', tableState: snapshot } }))
  const original = JSON.stringify(events)
  assert.ok(Buffer.byteLength(original) > 8 * 1024 * 1024)
  const compact = onlineEventHistory(events)
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 1024 * 1024)
  assert.deepEqual(compact.map(e => [e.seq, e.text, e.privateSeat]), events.map(e => [e.seq, e.text, e.privateSeat]))
  assert.equal(compact[0].presentation, undefined)
  assert.deepEqual(compact.at(-1).presentation.tableState, snapshot)
  assert.equal(JSON.stringify(events), original, 'saved events are never modified')
})

test('online snapshots deferred during a move redraw afterward; late polling responses cannot roll back state', async t => {
  let poll, value, renders = 0, chromeRenders = 0
  t.mock.method(globalThis, 'setTimeout', fn => { poll = fn; return 1 })
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  globalThis.window = { addEventListener() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
  const state = { busy: false, chat: {}, catalog: [] }
  const snapshot = serial => ({ instanceId: 'first-process', serial, room: { code: 'test' }, session: { sessionId: 'game', state: { revision: serial } } })
  value = snapshot(1)
  const ui = createOnlineUI({ state, render: () => renders++, renderChrome: () => chromeRenders++, request: async () => value, loadGame() {} })
  await ui.boot()
  assert.equal(state.session.state.revision, 1)
  const beforeChrome = chromeRenders, beforeSessionRender = renders
  value = { ...snapshot(1), serial: 2, transportNote: 'banner-only' }
  await poll()
  assert.equal(renders, beforeSessionRender, 'non-semantic online changes do not rebuild the game')
  assert.equal(chromeRenders, beforeChrome + 1, 'non-semantic online changes refresh only the banner')
  state.busy = true; value = snapshot(3)
  await poll()
  assert.equal(state.session.state.revision, 1)
  state.busy = false; state.session = snapshot(2).session
  const before = renders
  await poll()
  assert.equal(state.session.state.revision, 3)
  assert.equal(renders, before + 1, 'the deferred update must redraw even though its serial was seen while busy')
  value = snapshot(2)
  await poll()
  assert.equal(state.session.state.revision, 3, 'a late status response cannot undo a newer revision')
  value = { serial: 4, room: null }
  await poll()
  value = snapshot(3)
  await poll()
  assert.equal(state.session, null, 'a late response cannot reopen a dissolved room')
  assert.equal(state.view, 'library')
  value = { ...snapshot(0), instanceId: 'restarted-process' }
  await poll()
  assert.equal(state.session.state.revision, 0, 'a restarted local hall has a new serial sequence')
  value = snapshot(99)
  await poll()
  assert.equal(state.session.state.revision, 0, 'late responses from the previous process stay retired')
})

test('busy 期间延迟的快照在 sessionOmitted 终态后仍会补应用（「开始行动」卡住回归）', async t => {
  // 线上真实序列：玩家提交行动后，自己的 POST 还没返回（state.busy=true），
  // 长轮询先收到含新 revision 的快照（延迟应用）；随后房主把「忙碌结束」的终态以
  // 轻量 status 发布——会话内容和上一份完全相同，status 路由回 sessionOmitted（不带
  // session）。旧实现把 state.online 整个替换成这份不带 session 的响应，丢掉了待应用
  // 视图；服务端此时在等这位玩家行动、serial 不再变化，长轮询一直挂到超时，界面停在
  // 旧的 turnOrder 提示上，再点「开始行动」只会拿到 STALE_REVISION。
  let poll, value, renders = 0
  t.mock.method(globalThis, 'setTimeout', fn => { poll = fn; return 1 })
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  globalThis.window = { addEventListener() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
  const state = { busy: false, chat: {}, catalog: [] }
  const room = { code: 'race' }
  const session = (revision, pendingChoice) => ({ sessionId: 'game', modId: 'arkhamhorror', modName: 'race',
    mySeat: 2, state: { revision, currentSeat: revision, pendingChoice } })
  const status = (serial, extra) => ({ ok: true, instanceId: 'race-process', serial, connected: true, room, ...extra })
  value = status(1, { busy: false, session: session(1, { id: 'q1-0', kind: 'turnOrder', seat: 0 }) })
  const ui = createOnlineUI({ state, render: () => renders++, renderChrome() {}, request: async () => value, loadGame() {} })
  await ui.boot()
  assert.equal(state.session.state.revision, 1)
  // 自己的行动在途：新 revision 的快照先到，但处于 busy，延迟应用。
  state.busy = true
  value = status(2, { busy: true, session: session(2, null) })
  await poll()
  assert.equal(state.session.state.revision, 1, '忙碌期间不应用快照')
  // 终态 busy=false：内容未变，服务端回 sessionOmitted（不带 session）。
  value = status(3, { busy: false, sessionOmitted: true })
  await poll()
  assert.ok(state.online.session, 'sessionOmitted 响应不能丢掉待应用的会话视图')
  assert.equal(state.session.state.revision, 1)
  // 行动结束：Mod 的 finally 先置 busy=false，再 render()；renderNow 会调用 applyPending()。
  state.busy = false
  ui.applyPending()
  assert.equal(state.session.state.revision, 2, '忙碌结束后必须补应用延迟的权威快照')
  assert.equal(state.session.state.pendingChoice, null)
  assert.ok(renders > 0, '补应用后要重绘牌桌')
  // 之后再收到同 serial 的 sessionOmitted（长轮询超时返回）不能回退。
  value = status(3, { busy: false, sessionOmitted: true })
  await poll()
  assert.equal(state.session.state.revision, 2)
})

test('两人同抢「开始行动」失败一方也能从 409 错误响应拿到延迟快照（错误恢复回归）', async t => {
  // 两个真人同时点「开始行动」：后点的人自己的 state.busy=true 期间先收到胜者的 r+1 快照
  // （延迟应用），随后自己的命令被 409 STALE_REVISION 拒绝；command() 的兜底
  // GET /online/status 因 baseStamp 与服务器最后发送的视图相同而回 sessionOmitted。
  // 旧实现会在这里丢掉 state.online.session，error.session 变成 undefined，Mod 无法同步，
  // 界面停在旧 turnOrder 提示（截图里的 toast + 可点「开始行动」）。
  let poll, value, failMode = false
  t.mock.method(globalThis, 'setTimeout', fn => { poll = fn; return 1 })
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  globalThis.window = { addEventListener() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
  const state = { busy: false, chat: {}, catalog: [] }
  const room = { code: 'race' }
  const session = revision => ({ sessionId: 'game', modId: 'arkhamhorror', modName: 'race', mySeat: 2,
    state: { revision, currentSeat: 2, pendingChoice: revision === 1 ? { id: 'q1-0', kind: 'turnOrder' } : null } })
  const status = (serial, extra) => ({ ok: true, instanceId: 'race-process', serial, connected: true, room, ...extra })
  value = status(1, { busy: false, session: session(1) })
  // 命令失败后的兜底 GET 返回「内容未变」的 sessionOmitted。
  const omitted = status(2, { busy: false, sessionOmitted: true })
  const request = async (method, pathname) => {
    if (method === 'POST' && pathname === '/online/command') {
      throw Object.assign(new Error('对局版本已变化，请刷新后重试'), { code: 'STALE_REVISION', status: 409 })
    }
    return pathname.startsWith('/online/status') ? (failMode ? omitted : value) : value
  }
  const ui = createOnlineUI({ state, render() {}, renderChrome() {}, request, loadGame() {} })
  await ui.boot()
  assert.equal(state.session.state.revision, 1)
  // 自己点「开始行动」后 Mod 置 busy；胜者的 r+1 快照到达，延迟应用。
  state.busy = true
  value = status(2, { busy: false, session: session(2) })
  await poll()
  assert.equal(state.session.state.revision, 1, '忙碌期间不应用快照')
  failMode = true
  let caught
  await ui.command('move', { sessionId: 'game', revision: 1, move: { action: 'choose', choiceId: 'q1-0', optionId: '2' } })
    .catch(error => { caught = error })
  assert.ok(caught, '409 必须抛给调用方（Mod 的 cardMove catch）')
  assert.equal(caught.code, 'STALE_REVISION')
  assert.ok(caught.session, '错误响应必须带上当前席位视图，Mod 才能立即同步')
  assert.equal(caught.session.state.revision, 2)
  assert.equal(caught.session.state.pendingChoice, null)
})

test('强制同步：清掉本地卡死门闩并绕过省略/忙碌直接应用房主全量视图', async t => {
  // 用户点「强制同步」时，本地可能处于 busy/错误/旧 revision，甚至聊天在途；
  // 恢复流程必须：①清本地门闩 ②请求房主重置快照基线 ③用 full=1 拉全量并强制应用。
  let poll, value
  t.mock.method(globalThis, 'setTimeout', fn => { poll = fn; return 1 })
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  globalThis.window = { addEventListener() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
  const state = { busy: false, chat: { pendings: [] }, catalog: [] }
  const room = { code: 'stuck' }
  const session = revision => ({ sessionId: 'game', modId: 'arkhamhorror', modName: 'race', mySeat: 0,
    state: { revision, currentSeat: 0, pendingChoice: null } })
  const status = (serial, extra) => ({ ok: true, instanceId: 'stuck-process', serial, connected: true, room, ...extra })
  value = status(1, { busy: false, session: session(1) })
  const requests = []
  const ui = createOnlineUI({
    state, render() {}, renderChrome() {}, loadGame() {},
    request: async (method, pathname, body) => {
      requests.push({ method, pathname, body })
      if (method === 'POST' && pathname === '/online/command') {
        assert.equal(body.action, 'sync', '强制同步必须先请房主重置快照基线')
        return { ok: true, session: session(5) }
      }
      if (pathname.startsWith('/online/status?full=1')) return status(9, { busy: false, session: session(5) })
      return value
    },
  })
  await ui.boot()
  assert.equal(state.session.state.revision, 1)
  // 模拟卡死：上一次行动异常留下 busy/movePending/错误提示，聊天也有在途消息。
  state.busy = true; state.movePending = { sessionId: 'game' }; state.error = '对局版本已变化，请刷新后重试'
  state.chat.pendings = [{}]
  const synced = await ui.forceResync()
  assert.equal(synced, true)
  assert.equal(state.busy, false, '恢复后不能继续卡在本地 busy')
  assert.equal(state.movePending, null)
  assert.equal(state.error, null)
  assert.equal(state.session.state.revision, 5, '必须强制应用房主最新权威视图（聊天在途也不能挡住）')
  assert.ok(requests.some(item => item.pathname.startsWith('/online/status?full=1')),
    '恢复必须走 full=1 强制全量，不能依赖可能被省略的快照')
})

test('联机命令把 body.client.autoPass 原样带给房主（P0 自动跳过的传输契约）', async t => {
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  globalThis.window = { addEventListener() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
  const received = []
  const state = { busy: false, chat: {}, catalog: [] }
  const ui = createOnlineUI({
    state, render() {}, renderChrome() {}, loadGame() {},
    request: async (method, pathname, body) => { received.push({ method, pathname, body }); return { ok: true } },
  })
  const autoPass = { codes: ['01073', '01017'] }
  await ui.command('move', { sessionId: 'game', revision: 7, move: { action: 'draw' }, client: { autoPass } })
  const sent = received.find(item => item.pathname === '/online/command')
  assert.ok(sent, '联机命令必须走 /online/command（直连不可用时）')
  assert.equal(sent.body.action, 'move')
  assert.deepEqual(sent.body.body.client.autoPass, autoPass, 'client.autoPass 不能被 slim/operationId 覆盖掉')
  assert.equal(sent.body.body.client.slim, true)
  assert.equal(sent.body.body.move.action, 'draw')
})

test('prefs 命令走同一条联机命令通道并保留 codes（P1 偏好同步契约）', async t => {
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  globalThis.window = { addEventListener() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
  const received = []
  const state = { busy: false, chat: {}, catalog: [] }
  const ui = createOnlineUI({
    state, render() {}, renderChrome() {}, loadGame() {},
    request: async (method, pathname, body) => { received.push({ method, pathname, body }); return { ok: true } },
  })
  await ui.command('prefs', { sessionId: 'game', codes: ['01073'] })
  const sent = received.find(item => item.pathname === '/online/command' && item.body?.action === 'prefs')
  assert.ok(sent, 'prefs 必须经 /online/command 到达房主（直连不可用时）')
  assert.deepEqual(sent.body.body.codes, ['01073'])
  assert.equal(sent.body.body.sessionId, 'game')
})

test('悬浮联机栏默认收起、可展开，收起时保留房间/连接状态与提示并记住选择', async t => {
  // 需求：联机栏做成悬浮可折叠，不能像通栏一样占牌桌空间。收起时仍要能看到房间码、
  // 连接状态和强制同步等操作的提示；展开后才能拿到复制邀请/强制同步等操作入口。
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  const stored = new Map()
  globalThis.localStorage = { getItem: key => stored.get(key) ?? '', setItem: (key, value) => stored.set(key, value) }
  globalThis.window = { addEventListener() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
  const h = (tag, props, ...children) => ({
    tag, props: props || {}, children: children.flat(Infinity).filter(child => child != null && child !== false),
  })
  const collect = (node, predicate, out = []) => {
    if (!node || typeof node === 'string') return out
    if (predicate(node)) out.push(node)
    for (const child of node.children || []) collect(child, predicate, out)
    return out
  }
  const byClass = (node, name) => collect(node, item => String(item.props?.className || '').split(/\s+/).includes(name))
  const state = {
    busy: false, chat: {}, catalog: [],
    online: {
      connected: true, busy: false, memberId: 'm-host', relayUrl: '',
      room: {
        code: 'F789C780D5', game: { name: '诡镇奇谈：卡牌版' },
        members: [
          { id: 'm-host', host: true, seat: 0, online: true, ready: true },
          { id: 'm-guest', host: false, seat: 1, online: true, ready: false },
        ],
      },
    },
  }
  let chromeRenders = 0
  const ui = createOnlineUI({
    h, state, render() {}, renderChrome: () => { chromeRenders++ }, loadGame() {},
    request: async () => ({ ok: true }),
  })
  // 默认收起：没有操作区（复制邀请等按钮），胶囊里仍有房间码与「已连接·中转·席位」状态。
  const collapsed = ui.banner()
  assert.equal(collapsed.props['data-collapsed'], 'true')
  assert.equal(byClass(collapsed, 'bg-online-actions').length, 0, '收起时不渲染操作按钮区')
  const collapsedText = (node => (typeof node === 'string' ? node : (node.children || []).map(collapsedText).join(' ')))
  assert.match(collapsedText(collapsed), /F789C780D5/)
  assert.match(collapsedText(collapsed), /已连接 · 中转 · 席位 1/)
  const toggle = byClass(collapsed, 'bg-online-toggle')[0]
  assert.equal(toggle.props['aria-expanded'], 'false')
  assert.equal(toggle.props['aria-label'], '展开联机房间栏')
  // 点击后只刷新悬浮栏（不整页重绘），展开出操作区并写入持久化选择。
  toggle.props.onclick()
  assert.equal(chromeRenders, 1)
  assert.equal(stored.get('boardgame-hall.online-banner-collapsed'), '0')
  const expanded = ui.banner()
  assert.equal(expanded.props['data-collapsed'], 'false')
  assert.equal(byClass(expanded, 'bg-online-actions').length, 1)
  assert.equal(byClass(expanded, 'bg-online-toggle')[0].props['aria-expanded'], 'true')
  assert.ok(collect(expanded, item => item.props?.['aria-label'] === '复制邀请').length, '展开后必须有复制邀请入口')
  // 收起时错误/提示贴在胶囊下方，不能因为折叠而消失（如从大厅错误 toast 触发强制同步后的结果）。
  state.online = { ...state.online, error: '联机连接暂不可用' }
  byClass(expanded, 'bg-online-toggle')[0].props.onclick()
  const collapsedWithError = ui.banner()
  assert.equal(collapsedWithError.props['data-collapsed'], 'true')
  assert.equal(byClass(collapsedWithError, 'bg-online-flash').length, 1)
  assert.match(collapsedText(collapsedWithError), /联机连接暂不可用/)
  assert.equal(stored.get('boardgame-hall.online-banner-collapsed'), '1')
})
