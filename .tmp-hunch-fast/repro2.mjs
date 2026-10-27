// Repro: can Joe Diamond play a Fast event (Evidence! 01022) from the hunch deck
// in the 'defeatEnemy' reaction window?
import assert from 'node:assert/strict'
import { fixture } from '../games/arkhamhorror/tests/core-fixture.mjs'
import { reactionWindow, playerWindow } from '../games/arkhamhorror/src/engine/engine.js'
import { resolveTransaction } from '../games/arkhamhorror/src/engine/resolution.js'
import { ALL_CARDS } from '../games/arkhamhorror/src/cards/cards-data.js'

function investigatorFixture(code) {
  const state = fixture('01001')
  const inv = state.investigators[0]
  const card = ALL_CARDS[code]
  Object.assign(inv, {
    code, name: card.nameZh, nameEn: card.name, klass: card.klass,
    willpower: card.willpower, intellect: card.intellect, combat: card.combat, agility: card.agility,
    baseHealth: card.health, baseSanity: card.sanity, health: card.health, sanity: card.sanity,
    maxHealth: card.health, maxSanity: card.sanity,
    beneath: [], assets: [], threat: [], damage: 0, horror: 0,
  })
  return state
}

function runTransaction(state, execute, choose) {
  resolveTransaction(state, 0, { action: 'tcuInvestigatorTest' }, execute)
  for (let guard = 0; state.pendingChoice; guard++) {
    assert.ok(guard < 120, `Choice loop: ${state.pendingChoice.kind}`)
    const pending = state.pendingChoice
    const optionId = choose?.(pending, state)
      ?? ['done', 'skip', 'self', 'normal'].find(id => pending.options.some(option => option.id === id))
      ?? pending.options[0].id
    resolveTransaction(state, pending.seat, { action: 'choose', choiceId: pending.id, optionId }, execute)
  }
}

function probe(label, arrange, choose) {
  const state = investigatorFixture('05002')
  const inv = state.investigators[0]
  inv.hand = []
  inv.hunchDeck = []
  inv.hunchRevealed = null
  inv.resources = 10
  inv.discard = []
  arrange(state, inv)

  const seen = []
  runTransaction(state, current => {
    const target = current.investigators[0]
    reactionWindow(current, 'defeatEnemy', {
      when: 'defeatEnemy', seat: 0, location: target.location,
      enemy: { id: 'probe-enemy', code: 'ghoulMinion', name: '测试敌人', location: target.location },
      prompt: '你击败了一个敌人',
    }, [])
  }, pending => {
    if (pending.kind === 'reaction') {
      for (const opt of pending.options) seen.push({ id: opt.id, cardCode: opt.cardCode, label: opt.label })
      return choose?.(pending) ?? null
    }
    return null
  })
  console.log(`\n=== ${label} ===`)
  console.log('reaction options:', JSON.stringify(seen, null, 2))
  const after = state.investigators[0]
  console.log('hunchRevealed after:', after.hunchRevealed, '| resources:', after.resources,
    '| discard:', JSON.stringify(after.discard), '| clues:', after.clues)
  return { state, seen, after }
}

// A) baseline: Evidence! in HAND -> should be offered in defeatEnemy window.
probe('01022 in hand', (state, inv) => { inv.hand = ['01022'] })

// B) bug: Evidence! revealed from hunch deck -> should also be offered (as if in hand, -2 cost).
probe('01022 revealed from hunch', (state, inv) => { inv.hunchRevealed = '01022' },
  pending => pending.options.find(o => o.cardCode === '01022')?.id ?? null)

// C) player window fast-card option (own turn, no action left)
{
  const state = investigatorFixture('05002')
  const inv = state.investigators[0]
  inv.hand = []
  inv.hunchDeck = []
  inv.hunchRevealed = '01054' // fast event, no trigger (play during your turn)
  inv.resources = 10
  inv.actionsLeft = 0
  const seen = []
  runTransaction(state, current => {
    playerWindow(current, 'investigation.afterAction', [], null, { fastCards: true })
  }, pending => {
    if (pending.kind === 'playerWindow') for (const opt of pending.options) seen.push({ id: opt.id, cardCode: opt.cardCode, label: opt.label })
    return null
  })
  console.log('\n=== fast card from hunch in player window ===')
  console.log('playerWindow options:', JSON.stringify(seen, null, 2))
}
