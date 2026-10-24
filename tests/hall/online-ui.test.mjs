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
