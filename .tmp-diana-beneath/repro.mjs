// 复现：黛安娜穿上银暮匕首（05013）后，能否把「底下」的事件/技能当成手牌打出/投入。
// 运行：node .tmp-diana-beneath/repro.mjs
import assert from 'node:assert/strict'

import { fixture } from '../games/arkhamhorror/tests/core-fixture.mjs'
import {
  legalMoves, reactionWindow, evaluateCriteria, applyMove, validateMove, decisionSeat,
} from '../games/arkhamhorror/src/engine/engine.js'
import { resolveTransaction } from '../games/arkhamhorror/src/engine/resolution.js'
import { registeredEntry } from '../games/arkhamhorror/src/engine/ability.js'
import { ALL_CARDS } from '../games/arkhamhorror/src/cards/cards-data.js'
import { entityMoves, choicePresentation } from '../games/arkhamhorror/web/card-interactions.js'

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

function dagger(inv) {
  inv.assets = [{ id: 'dagger', code: '05013', exhausted: false }]
}

// ---------------------------------------------------------------------------
// 1. 普通行动：legalMoves 提供 fromBeneath 候选（现状应通过）
// ---------------------------------------------------------------------------
{
  const state = dianaFixture()
  const inv = me(state)
  inv.hand = []
  dagger(inv)
  inv.beneath = ['01052']  // 偷袭（event）
  const moves = legalMoves(state).filter(m => m.action === 'play' && m.fromBeneath)
  console.log('[1] 普通打出 fromBeneath 候选:', moves.map(m => m.cardId), '→', moves.length ? 'OK' : 'FAIL')
  console.log('    entityMoves(beneath:01052):', entityMoves(state, 'beneath:01052').map(m => m.label))
}

// ---------------------------------------------------------------------------
// 2. 快速事件反应窗口（05014 黑暗洞察：kind:'played' + fast + trigger）
// ---------------------------------------------------------------------------
{
  const state = dianaFixture()
  const inv = me(state)
  inv.hand = []
  dagger(inv)
  inv.beneath = ['05014']
  inv.deck = Array(20).fill('01088')
  const seen = []
  runTransaction(state, current => {
    reactionWindow(current, 'encounterDrawn', {
      when: 'encounterDrawn', seat: 0, location: current.investigators[0].location,
      cardCode: '01037', prompt: '测试遭遇',
    }, [])
  }, pending => {
    if (pending.kind === 'reaction') seen.push(pending.options.map(o => ({ id: o.id, code: o.cardCode })))
    return pending.options.some(o => o.id === 'skip') ? 'skip' : null
  })
  const offered = seen.flat().filter(o => o.code === '05014')
  console.log('[2] 遭遇窗口 reaction 候选:', JSON.stringify(seen))
  console.log('    05014（底下的快速事件）是否出现:', offered.length ? 'OK' : 'FAIL')
}

// ---------------------------------------------------------------------------
// 3. 能力窗口（05280 否决存在：kind:'reaction' + fromHand）
// ---------------------------------------------------------------------------
{
  const state = dianaFixture()
  const inv = me(state)
  inv.hand = []
  dagger(inv)
  inv.beneath = ['05280']
  inv.resources = 10
  const seen = []
  runTransaction(state, current => {
    const ctx = { when: 'wouldLoseResources', seat: 0, location: current.investigators[0].location,
      what: 'resources', amount: 2, source: { kind: 'encounter' }, cancelled: false, prompt: '测试失去资源' }
    reactionWindow(current, 'wouldLoseResources', ctx, [])
    if (!ctx.cancelled) current.investigators[0].resources -= 2
  }, pending => {
    if (pending.kind === 'reaction') seen.push(pending.options.map(o => ({ id: o.id, code: o.cardCode })))
    return pending.options.some(o => o.id === 'skip') ? 'skip' : null
  })
  const offered = seen.flat().filter(o => o.code === '05280' || String(o.id).includes('05280'))
  console.log('[3] 失去资源窗口 reaction 候选:', JSON.stringify(seen))
  console.log('    05280（底下的 fromHand 反应）是否出现:', offered.length ? 'OK' : 'FAIL')
}

// ---------------------------------------------------------------------------
// 4. 技能检定投入（现状应通过）
// ---------------------------------------------------------------------------
{
  const state = dianaFixture()
  const inv = me(state)
  inv.hand = []
  dagger(inv)
  inv.beneath = ['01025']
  console.log('[4] 投入通道：见 tests/tcu-investigators.test.mjs R7 用例（已知通过）')
}
