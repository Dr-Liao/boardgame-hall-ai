// Node-level validation of the server-side fix, without restarting the shared hall:
// run the real engine in-process (current working tree), apply a real move, and inspect
// the presentation checkpoint snapshot that the server would ship to the browser.
import { createGameState, applyMove, getStat, getMaxSanity } from '../../games/arkhamhorror/src/engine/engine.js'
import { viewEvents } from '../../games/arkhamhorror/src/integration/observation.js'
import { captureTableState } from '../../games/arkhamhorror/src/integration/presentation-state.js'

const state = createGameState({ playerInvestigator: '03003', seed: 'beneath-node-check' }, [{ seat: 0 }])
state.pendingChoice = null
state.continuation = null
state.investigators[0].beneath = ['01051', '01066']
state.investigators[0].beneathCount = 2
const events = applyMove(state, 0, { action: 'resource' })
const cueOf = event => event.type === 'presentation' ? event : event.presentation
const snapshots = []
for (const event of events) {
  const snap = event.tableState || event.presentation?.tableState
  if (!snap) continue
  snapshots.push({ type: event.type, kind: event.kind || event.presentation?.kind,
    hasBeneathKey: 'beneath' in snap.investigators[0], beneath: snap.investigators[0].beneath,
    beneathCount: snap.investigators[0].beneathCount })
}
const seqEvents = events.map((e, i) => ({ ...e, seq: i }))
const own = viewEvents(seqEvents, 0).find(e => e.tableState || e.presentation?.tableState)
const spectator = viewEvents(seqEvents, null).find(e => e.tableState || e.presentation?.tableState)
const pub = vue => (cueOf(vue)?.tableState || vue?.tableState)?.investigators?.[0]
const rowRenders = inv => Array.isArray(inv?.beneath) && inv.beneath.length > 0
console.log(JSON.stringify({
  engine: 'working tree (fix applied)',
  moves: (state.actionLog || []).slice(-1),
  eventKinds: events.map(e => ({ type: e.type, kind: e.kind || e.presentation?.kind, text: (e.text || '').slice(0, 30) })),
  snapshots,
  projectedOwn: { beneath: pub(own)?.beneath, beneathCount: pub(own)?.beneathCount, rowRenders: rowRenders(pub(own)) },
  projectedSpectator: { beneath: pub(spectator)?.beneath, beneathCount: pub(spectator)?.beneathCount, rowRenders: rowRenders(pub(spectator)) },
  stateBeneathAfterMove: state.investigators[0].beneath,
}, null, 1))
