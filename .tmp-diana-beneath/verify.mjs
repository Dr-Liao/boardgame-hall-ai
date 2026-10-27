// 验证修复：银暮匕首在场时，「底下」的快速事件 / fromHand 反应 能通过反应窗口使用。
import assert from 'node:assert/strict'

import { fixture } from '../games/arkhamhorror/tests/core-fixture.mjs'
import { reactionWindow } from '../games/arkhamhorror/src/engine/engine.js'
import { resolveTransaction } from '../games/arkhamhorror/src/engine/resolution.js'
import { ALL_CARDS } from '../games/arkhamhorror/src/cards/cards-data.js'

const me = state => state.investigators[0]

function dianaFixture() {
  const state = fixture('01001')
  const inv = me(state)
  const card = ALL_CARDS['05004']
  Object.assign(inv, {
    code: '05004', name: card.nameZh, nameEn: card.name, klass: card.klass,
    willpower: card.willpower, intellect: card.intellect, combat: card.combat, agility: card.agility,
    baseHealth: card.health, baseSanity: card.sanity, health: card.health, sanity: card.sanity,
    maxHealth: card.health, maxSanity: card.sanity,
    beneath: [], assets: [], threat: [], damage: 0, horror: 0,
  })
  inv.resources = 10
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

// ---------------------------------------------------------------------------
// A. 快速事件（kind:'played' + fast + trigger）从底下打出：05014 黑暗洞察
// ---------------------------------------------------------------------------
{
  const state = dianaFixture()
  const inv = me(state)
  inv.hand = []
  inv.deck = Array(20).fill('01088')
  inv.assets = [{ id: 'dagger', code: '05013', exhausted: false }]
  inv.beneath = ['05014']
  const seen = []
  let chose = false
  runTransaction(state, current => {
    reactionWindow(current, 'encounterDrawn', {
      when: 'encounterDrawn', seat: 0, location: current.investigators[0].location,
      cardCode: '01037', prompt: '测试遭遇',
    }, [])
  }, pending => {
    if (pending.kind === 'reaction') {
      seen.push(pending.options.map(o => ({ id: o.id, code: o.cardCode, label: o.label })))
      const target = pending.options.find(o => o.cardCode === '05014')
      if (target && !chose) { chose = true; return target.id }
      if (pending.options.some(o => o.id === 'skip')) return 'skip'
    }
    return null
  })
  const after = me(state)
  console.log('[A] encounterDrawn 候选:', JSON.stringify(seen))
  console.log('    chose=', chose, 'beneath=', JSON.stringify(after.beneath),
    'daggerExhausted=', after.assets.find(a => a.id === 'dagger')?.exhausted,
    'discard=', after.discard)
}

// ---------------------------------------------------------------------------
// B. fromHand 反应描述子从底下触发：05324 美满结局（negativeTokenRevealed）
// ---------------------------------------------------------------------------
{
  const state = dianaFixture()
  const inv = me(state)
  inv.hand = []
  inv.resources = 10
  inv.assets = [{ id: 'dagger', code: '05013', exhausted: false }]
  inv.beneath = ['05324']
  const seen = []
  let chose = false
  let flipped = false
  runTransaction(state, current => {
    const ctx = {
      when: 'negativeTokenRevealed', seat: 0, location: current.investigators[0].location,
      token: '-2', testValue: 0, flipTokenSign: false, prompt: '测试负修正',
    }
    reactionWindow(current, 'negativeTokenRevealed', ctx, [])
    if (ctx.flipTokenSign) flipped = true
  }, pending => {
    if (pending.kind === 'reaction') {
      seen.push(pending.options.map(o => ({ id: o.id, code: o.cardCode, label: o.label })))
      const target = pending.options.find(o => o.cardCode === '05324')
      if (target && !chose) { chose = true; return target.id }
      if (pending.options.some(o => o.id === 'skip')) return 'skip'
    }
    return null
  })
  console.log('[B] negativeTokenRevealed 候选:', JSON.stringify(seen))
  console.log('    chose=', chose, 'beneath=', JSON.stringify(me(state).beneath),
    'daggerExhausted=', me(state).assets.find(a => a.id === 'dagger')?.exhausted,
    'flipTokenSign=', flipped,
    'discard=', me(state).discard, 'resources=', me(state).resources)
}
