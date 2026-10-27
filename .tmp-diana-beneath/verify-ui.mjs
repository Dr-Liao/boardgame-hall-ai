// 校验 web/card-interactions.js 的 choicePresentation 能把 beneath 候选挂回「下方」的牌。
import assert from 'node:assert/strict'

import { fixture } from '../games/arkhamhorror/tests/core-fixture.mjs'
import { legalMoves, reactionWindow } from '../games/arkhamhorror/src/engine/engine.js'
import { resolveTransaction } from '../games/arkhamhorror/src/engine/resolution.js'
import { ALL_CARDS } from '../games/arkhamhorror/src/cards/cards-data.js'
import { choicePresentation, entityMoves } from '../games/arkhamhorror/web/card-interactions.js'

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
  inv.hand = []
  inv.resources = 10
  return state
}

// 与 dispatch / observation 一致：先把 legalMoves 刷成当前观察者可见的那份。
function openWindow(state, execute) {
  resolveTransaction(state, 0, { action: 'test' }, execute)
  state.legalMoves = legalMoves(state, 0)
}

// A：快速事件窗口
{
  const state = dianaFixture()
  me(state).beneath = ['05014']
  me(state).assets = [{ id: 'dagger', code: '05013', exhausted: false }]
  openWindow(state, current => {
    reactionWindow(current, 'encounterDrawn', {
      when: 'encounterDrawn', seat: 0, location: current.investigators[0].location,
      cardCode: '01037', prompt: '测试遭遇',
    }, [])
  })
  const items = choicePresentation(state)
  const target = items.find(item => item.key === 'beneath:05014')
  console.log('[A] pending:', state.pendingChoice?.kind, 'items:', JSON.stringify(items.map(i => ({ id: i.move.optionId, key: i.key, code: i.code }))))
  assert.ok(target, 'A：choicePresentation 应把 beneath 快速事件挂回 beneath:05014')
  assert.equal(entityMoves(state, 'beneath:05014').length, 1, 'A：点下方的牌应能提交这个窗口的选项')
}

// B：fromHand 能力窗口
{
  const state = dianaFixture()
  me(state).beneath = ['05324']
  me(state).assets = [{ id: 'dagger', code: '05013', exhausted: false }]
  openWindow(state, current => {
    reactionWindow(current, 'negativeTokenRevealed', {
      when: 'negativeTokenRevealed', seat: 0, location: current.investigators[0].location,
      token: '-2', testValue: 0, flipTokenSign: false, prompt: '测试负修正',
    }, [])
  })
  const items = choicePresentation(state)
  const target = items.find(item => item.key === 'beneath:05324')
  console.log('[B] pending:', state.pendingChoice?.kind, 'items:', JSON.stringify(items.map(i => ({ id: i.move.optionId, key: i.key, code: i.code }))))
  assert.ok(target, 'B：choicePresentation 应把 beneath 能力候选挂回 beneath:05324')
  assert.equal(entityMoves(state, 'beneath:05324').length, 1, 'B：点下方的牌应能提交这个窗口的选项')
}

console.log('OK: beneath 候选在反应/能力窗口都能从牌桌「下方」的牌点出。')
