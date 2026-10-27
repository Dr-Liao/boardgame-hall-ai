// End-to-end: engine reaction window -> observation view -> web choicePresentation mapping.
import assert from 'node:assert/strict'
import { fixture, move, settle, enemy } from '../games/arkhamhorror/tests/core-fixture.mjs'
import { viewState } from '../games/arkhamhorror/src/integration/observation.js'
import { choicePresentation, entityMoves } from '../games/arkhamhorror/web/card-interactions.js'

const me = state => state.investigators[0]
const state = fixture('05002')
const inv = me(state)
inv.hunchDeck = []
inv.hunchRevealed = '01022'
inv.hand = []
inv.resources = 0
inv.discard = []
const loc = state.locations.find(l => l.id === inv.location)
loc.clues = Math.max(1, loc.clues || 0)
state.chaosBag = ['0']
const target = enemy(state, { id: 'view-target', fight: 0, evade: 1, health: 1, damageTaken: 0, engagedSeat: 0 })
move(state, { action: 'fight', enemyId: target.id })
// Settle commit windows only: stop at the reaction window.
import('./../games/arkhamhorror/src/engine/engine.js').then(() => {})

// Re-run inside transactions via fixture settle pattern: this probe is simpler with manual loop.
// (state.pendingChoice is either commit or reaction here; walk choices except the hunch option.)
let guard = 0
while (state.pendingChoice && guard++ < 30) {
  const pending = state.pendingChoice
  if (pending.kind === 'reaction') break
  const option = pending.options.find(o => ['done', 'skip', 'self', 'normal'].includes(o.id)) || pending.options[0]
  // eslint-disable-next-line no-await-in-loop
  const { applyMove } = await import('../games/arkhamhorror/src/engine/engine.js')
  applyMove(state, pending.seat, { action: 'choose', choiceId: pending.id, optionId: option.id })
}

const pending = state.pendingChoice
console.log('pending kind:', pending?.kind, 'options:', JSON.stringify(pending?.options?.map(o => ({ id: o.id, cardCode: o.cardCode }))))
const view = viewState(state, 0)
console.log('view.hunch:', JSON.stringify(view.hunch))
console.log('view.pendingChoice.options:', JSON.stringify(view.pendingChoice?.options))
const items = choicePresentation(view)
const hunchItem = items.find(item => item.move.optionId === 'hunch')
console.log('hunch choice item:', JSON.stringify(hunchItem))
console.log('entityMoves(hunch:01022):', JSON.stringify(entityMoves(view, 'hunch:01022')))
assert.ok(hunchItem, 'hunch option survives observation projection')
assert.equal(hunchItem.key, 'hunch:01022')
assert.equal(entityMoves(view, 'hunch:01022').length, 1)
console.log('\nView -> table mapping probe passed.')

// Avoid unused import lint noise.
void settle
