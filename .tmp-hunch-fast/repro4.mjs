// Ability-layer hunch fast event (01522 证据！ from Dunwich) must be playable from hunch.
import assert from 'node:assert/strict'
import { fixture, move, settle, enemy } from '../games/arkhamhorror/tests/core-fixture.mjs'

const me = state => state.investigators[0]

const state = fixture('05002')
const inv = me(state)
inv.hunchDeck = []
inv.hunchRevealed = '01522'
inv.hand = []
inv.resources = 0
inv.discard = []
const loc = state.locations.find(l => l.id === inv.location)
loc.clues = Math.max(1, loc.clues || 0)
const cluesBefore = inv.clues
state.chaosBag = ['0']
const target = enemy(state, { id: 'p-hunch2', fight: 0, evade: 1, health: 1, damageTaken: 0, engagedSeat: 0 })
move(state, { action: 'fight', enemyId: target.id })
const windows = []
let chosen = null
settle(state, pending => {
  if (pending.kind !== 'reaction') return null
  windows.push(pending.options.map(o => ({ id: o.id, label: o.label, cardCode: o.cardCode })))
  const option = pending.options.find(o => o.cardCode === '01522' && /直觉牌库/.test(o.label || ''))
  if (option) { chosen = option; return option.id }
  return null
})
console.log('reaction windows:', JSON.stringify(windows, null, 1))
const after = me(state)
console.log('chosen:', JSON.stringify(chosen))
console.log('hunchRevealed:', after.hunchRevealed, '| resources:', after.resources,
  '| discard:', JSON.stringify(after.discard), '| clues:', after.clues, '(was', cluesBefore + ')')
assert.ok(chosen, 'ability-layer fromHand hunch fast event must be offered')
assert.equal(after.hunchRevealed ?? null, null)
assert.equal(after.resources, 0, 'cost 1 - 2 = 0')
assert.ok(after.discard.includes('01522'))
assert.equal(after.clues, cluesBefore + 1, 'Evidence! discovers 1 clue')
console.log('\nAbility-layer hunch fast event probe passed.')
