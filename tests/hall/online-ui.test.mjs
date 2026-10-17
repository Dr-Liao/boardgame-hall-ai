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
