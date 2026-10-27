// Verify the hunch-deck fast-card fix (Joe Diamond 05002).
import assert from 'node:assert/strict'
import { fixture, move, answer, settle, enemy, legalMoves } from '../games/arkhamhorror/tests/core-fixture.mjs'

const me = state => state.investigators[0]

function joeState({ revealed, resources = 0, hand = [] }) {
  const state = fixture('05002')
  const inv = me(state)
  inv.hunchDeck = []
  inv.hunchRevealed = revealed
  inv.hand = hand
  inv.resources = resources
  inv.discard = []
  const loc = state.locations.find(l => l.id === inv.location)
  loc.clues = Math.max(1, loc.clues || 0)
  return state
}

// A) Evidence! (01022, cost 1, Fast after defeating an enemy) revealed from hunch deck.
{
  const state = joeState({ revealed: '01022', resources: 0 })
  const inv = me(state)
  const cluesBefore = inv.clues
  state.chaosBag = ['0']
  const target = enemy(state, { id: 'p-hunch', fight: 0, evade: 1, health: 1, damageTaken: 0, engagedSeat: 0 })
  move(state, { action: 'fight', enemyId: target.id })
  let offered = null
  settle(state, pending => {
    if (pending.kind !== 'reaction') return null
    const option = pending.options.find(o => o.id === 'hunch' && o.cardCode === '01022')
    if (option) { offered = option; return option.id }
    return null
  })
  console.log('A) offered:', JSON.stringify(offered))
  const after = me(state)
  console.log('A) hunchRevealed:', after.hunchRevealed, '| resources:', after.resources,
    '| discard:', JSON.stringify(after.discard), '| clues:', after.clues, '(was', cluesBefore + ')')
  assert.ok(offered, 'A: hunch Evidence! must be offered in defeatEnemy reaction window')
  assert.equal(after.hunchRevealed, null, 'A: revealed marker cleared')
  assert.equal(after.resources, 0, 'A: cost 1 - 2 = 0 resources')
  assert.ok(after.discard.includes('01022'), 'A: played event goes to discard')
  assert.equal(after.clues, cluesBefore + 1, 'A: Evidence! discovers 1 clue')
}

// B) Working a Hunch (01037, cost 2) with 0 resources: -2 discount must make it legal as a normal action.
{
  const state = joeState({ revealed: '01037', resources: 0 })
  const inv = me(state)
  const cluesBefore = inv.clues
  const play = legalMoves(state).find(m => m.action === 'play' && m.fromHunch === true && m.cardId === '01037')
  console.log('B) legalMoves fromHunch:', JSON.stringify(play))
  assert.ok(play, 'B: fromHunch candidate must pass validateMove even when resources < printed cost')
  move(state, play)
  settle(state)
  const after = me(state)
  console.log('B) hunchRevealed:', after.hunchRevealed, '| resources:', after.resources,
    '| discard:', JSON.stringify(after.discard), '| clues:', after.clues)
  assert.equal(after.hunchRevealed ?? null, null, 'B: revealed marker cleared')
  assert.equal(after.resources, 0, 'B: 2 - 2 = 0 resources')
  assert.ok(after.discard.includes('01037'), 'B: played event goes to discard')
  assert.equal(after.clues, cluesBefore + 1, 'B: Working a Hunch discovers 1 clue')
}

// C) Closing player window: fast hunch card can still be played after the last action.
{
  const state = joeState({ revealed: '01037', resources: 0 })
  const inv = me(state)
  const cluesBefore = inv.clues
  inv.actionsLeft = 1
  move(state, { action: 'draw' })
  console.log('C) pendingChoice:', state.pendingChoice?.kind,
    JSON.stringify(state.pendingChoice?.options?.map(o => o.id)))
  const option = state.pendingChoice?.options?.find(o => o.id === 'fast-card:hunch:01037')
  assert.ok(option, 'C: closing window must offer the hunch fast card')
  answer(state, option.id)
  const after = me(state)
  console.log('C) hunchRevealed:', after.hunchRevealed, '| resources:', after.resources,
    '| discard:', JSON.stringify(after.discard), '| round:', state.round, '| clues:', after.clues)
  assert.equal(after.hunchRevealed ?? null, null, 'C: revealed marker cleared')
  assert.equal(after.resources, 0, 'C: 2 - 2 = 0 resources')
  assert.ok(after.discard.includes('01037'), 'C: played event goes to discard')
  assert.equal(state.round, 2, 'C: turn ends normally after the fast card resolves')
  assert.equal(after.clues, cluesBefore + 1, 'C: Working a Hunch discovers 1 clue')
}

console.log('\nAll hunch fast-card probes passed.')

