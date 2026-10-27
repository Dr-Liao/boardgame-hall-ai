// End-to-end: closing player window -> observation view -> table hunch mapping.
import assert from 'node:assert/strict'
import { fixture, move } from '../games/arkhamhorror/tests/core-fixture.mjs'
import { viewState } from '../games/arkhamhorror/src/integration/observation.js'
import { choicePresentation, entityMoves } from '../games/arkhamhorror/web/card-interactions.js'

const me = state => state.investigators[0]
const state = fixture('05002')
const inv = me(state)
inv.hunchDeck = []
inv.hunchRevealed = '01037'
inv.hand = []
inv.resources = 0
inv.discard = []
inv.actionsLeft = 1
const loc = state.locations.find(l => l.id === inv.location)
loc.clues = Math.max(1, loc.clues || 0)
move(state, { action: 'draw' })
const pending = state.pendingChoice
console.log('pending kind:', pending?.kind, 'options:', JSON.stringify(pending?.options?.map(o => ({ id: o.id }))))
const view = viewState(state, 0)
console.log('view.hunch:', JSON.stringify(view.hunch))
const item = choicePresentation(view).find(item => item.move.optionId === 'fast-card:hunch:01037')
console.log('item key:', item?.key, '| code:', item?.code)
console.log('entityMoves(hunch:01037):', JSON.stringify(entityMoves(view, 'hunch:01037')))
assert.ok(item, 'closing window option exists in view')
assert.equal(item.key, 'hunch:01037')
assert.equal(entityMoves(view, 'hunch:01037').length, 1)
console.log('\nPlayer window -> table mapping probe passed.')
