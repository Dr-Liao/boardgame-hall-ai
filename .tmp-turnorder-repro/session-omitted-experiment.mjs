// Repro experiment: deferred online snapshot + sessionOmitted loses the pending view.
// Simulates the real hall long-poll sequence around a mod move:
//   A) snapshot with session arrives while the mod action is in flight (state.busy=true) -> deferred
//   B) final busy=false status arrives; content unchanged so the route returns sessionOmitted (no session)
//   C) the mod finishes (busy=false) and renders -> renderNow() calls onlineUi.applyPending()
//   D) no further server serial arrives (server waits for this player) -> long poll returns the same status
// Expected buggy behavior: state.session never catches up; expected fixed behavior: catches up at C/D.
globalThis.localStorage = { getItem: () => '', setItem() {} }
globalThis.window = { addEventListener() {} }
const savedSetTimeout = globalThis.setTimeout
let poll = null
globalThis.setTimeout = (fn, ms) => { if (typeof fn === 'function') poll = fn; return 0 }

const { createOnlineUI } = await import('../public/online-ui.js')

const room = { code: 'TEST', members: [{ id: 'm1', host: false, seat: 2, online: true }] }
const view = (revision, pendingChoice) => ({
  sessionId: 'game-1', modId: 'arkhamhorror', modName: 'test', online: true, mySeat: 2,
  state: { revision, currentSeat: revision, pendingChoice: pendingChoice || null },
})
function status(serial, { busy, session, sessionOmitted }) {
  return { ok: true, instanceId: 'inst', serial, connected: true, room, busy, ...(session ? { session } : {}), ...(sessionOmitted ? { sessionOmitted: true } : {}) }
}

// ---- fake server timeline ----
const server = { serial: 1, busy: false }
let nextValue = status(1, { busy: false, session: view(1, { kind: 'turnOrder', id: 'q1-0' }) })
const request = async (method, pathname) => {
  if (pathname.startsWith('/online/status')) return nextValue
  throw new Error('unexpected ' + method + ' ' + pathname)
}
const state = { busy: false, chat: {}, catalog: [] }
const renders = []
const ui = createOnlineUI({ state, render: () => renders.push(state.session?.state?.revision), renderChrome: () => {}, request, loadGame() {} })
await ui.boot()
console.log('after boot: serial', state.online.serial, 'session rev', state.session.state.revision, 'pending?', !!state.session.state.pendingChoice)

// A) user clicks a stale move; mod sets busy before posting.
state.busy = true
nextValue = status(2, { busy: true, session: view(2, null) })
await poll()
console.log('A) deferred snapshot: online.serial', state.online.serial, '| state.session rev', state.session.state.revision, '| pending?', !!state.session.state.pendingChoice)

// B) final busy=false status, identical session content => sessionOmitted (no session field)
nextValue = status(3, { busy: false, sessionOmitted: true })
await poll()
console.log('B) sessionOmitted: online.serial', state.online.serial, '| online.session?', !!state.online.session, '| state.session rev', state.session.state.revision)

// C) mod action finished: busy=false then render() -> applyPending()
state.busy = false
ui.applyPending()
console.log('C) after applyPending: online.serial', state.online.serial, '| state.session rev', state.session.state.revision, '| pending?', !!state.session.state.pendingChoice)

// D) next long poll returns the same status (25s timeout / same serial)
nextValue = status(3, { busy: false, sessionOmitted: true })
await poll()
console.log('D) after next poll: state.session rev', state.session.state.revision, '| pending?', !!state.session.state.pendingChoice)

const stuck = state.session.state.revision !== 2
console.log(stuck ? 'VERDICT: STUCK (state.session stayed at revision 1)' : 'VERDICT: recovered to revision 2')
globalThis.setTimeout = savedSetTimeout
process.exit(stuck ? 1 : 0)
