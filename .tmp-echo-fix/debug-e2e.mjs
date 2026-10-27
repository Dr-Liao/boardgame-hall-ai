// 「往事回声」隐藏的图书馆 / [[通道]] 规则端到端回归。
//
// 用户报告（2026-10-27）：
//   1. 隐藏的图书馆一开始就连接了；
//   2. 皮博迪先生改不了其他地点的通道属性；
//   3. 通道也没有关键字。
//
// 本文件用真实引擎状态验证整条链路：
//   布置 → 幕 2 背面（放置隐藏的图书馆 + 皮博迪）→ 幕 3（通道特性地点互相连接）
//   → 皮博迪行动（-1 帷幕 + 通道特性 + 双向连接 + UI 投影）→ 轮末清理
//   → 敌人阶段临时授予（猎手能进入隐藏的图书馆）→ 还原。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createGameState, startScenario, applyMove, legalMoves, decisionSeat, advanceAct, hunterStep,
} from '../games/arkhamhorror/src/engine/engine.js'
import { viewState } from '../games/arkhamhorror/src/integration/observation.js'
import { behavior as echoes } from '../games/arkhamhorror/content/campaigns/thePathToCarcosa/scenarios/echoesOfThePast/behavior.js'
import { settle } from '../games/arkhamhorror/tests/core-fixture.mjs'

const PASSAGEWAY = 'Passageway'
const original = card => card?.originalCode || card?.code
const locationById = (state, id) => state.locations.find(location => location.id === id)
const hasPassageway = location => (location?.traits || [])
  .some(trait => String(trait).toLowerCase() === PASSAGEWAY.toLowerCase())
const connectionIds = location => (location?.connections || []).filter(id =>
  state.locations.some(other => other.id === id))
let state

function startEchoes() {
  const game = createGameState({
    campaignId: 'thePathToCarcosa',
    playerInvestigator: '03006',
    seed: 'echoes-passageways-e2e',
    seatInvestigators: ['03006'],
  }, [{ seat: 0, role: 'human' }])
  settle(game)
  startScenario(game, 2, [])
  settle(game)
  return game
}

function advanceOnce(game) {
  for (const inv of game.investigators) inv.clues = 20
  advanceAct(game, [])
  settle(game)
}

function stubApi() {
  return { info() {}, choose() { throw new Error('unexpected choice') }, place() {}, giveAsset() {} }
}

test('布置阶段：隐藏的图书馆放在一边，不在场、未连接', () => {
  state = startEchoes()
  assert.equal(state.scenario.id, 'echoesOfThePast')
  assert.equal(state.scenarioZones.setAside.includes('03139'), true)
  assert.equal(state.locations.some(location => location.id === 'hiddenLibrary'), false)
  for (const location of state.locations) {
    assert.equal((location.connections || []).includes('hiddenLibrary'), false,
      `${location.id} 在布置阶段不能连接隐藏的图书馆`)
  }
})

test('幕 2 背面：隐藏的图书馆入场但没有特性/连接；幕 3 通道特性地点互相连接', () => {
  advanceOnce(state) // 幕 1 → 幕 2
  assert.equal(state.actIndex, 1)
  assert.equal(state.locations.some(location => location.id === 'hiddenLibrary'), false)

  advanceOnce(state) // 幕 2 背面 → 幕 3
  assert.equal(state.actIndex, 2)
  assert.equal(original(state.acts[state.actIndex]), '03126')

  const hidden = locationById(state, 'hiddenLibrary')
  assert.ok(hidden, '隐藏的图书馆已放入场')
  assert.equal(hidden.revealed, false)
  assert.deepEqual(hidden.connections, [], '隐藏的图书馆默认没有任何连接')
  assert.equal(hasPassageway(hidden), false, '隐藏的图书馆默认没有[[通道]]特性')

  // 皮博迪先生交给调查员。
  assert.equal(state.investigators[0].assets.some(asset => original(asset) === '03141'), true)

  // 幕 3 规则：场上所有带[[通道]]特性的地点互相连接（双向）。
  const passageways = state.locations.filter(hasPassageway)
  assert.ok(passageways.length >= 1, '至少一个印刷[[通道]]地点在场')
  for (const location of passageways) {
    const connections = connectionIds(location)
    for (const other of passageways) {
      if (other.id === location.id) continue
      assert.equal(connections.includes(other.id), true, `${location.id} → ${other.id} 应连接`)
      assert.equal(connectionIds(other).includes(location.id), true, `${other.id} → ${location.id} 应连接`)
    }
    // 非通道地点不因这条规则被连上（只检查本规则自动添加的连接；印刷地图连接保留）。
    assert.deepEqual(location.passagewayLinks.filter(id => !hasPassageway(locationById(state, id))), [],
      `${location.id} 的自动通道连接只能指向通道地点`)
    for (const other of state.locations) {
      if (other.id === location.id || hasPassageway(other)) continue
      assert.deepEqual(other.passagewayLinks || [], [], `${other.id} 不应被规则自动连上`)
    }
  }
})

test('皮博迪先生：隐藏的图书馆获得[[通道]]特性 + 隐藏值 -1 + 双向连接；UI 投影带「通道」关键字', () => {
  const inv = state.investigators[0]
  inv.actionsLeft = 3
  state.phase = 'investigation'
  state.currentSeat = 0
  state.pendingChoice = null

  const move = legalMoves(state).find(candidate => candidate.rule === 'peabodyPassage')
  assert.ok(move, '皮博迪先生的行动出现在合法列表里')
  // 目标不能排除调查员所在地点：所有在场地点都是候选（由后续 choose 的选项验证）。
  applyMove(state, 0, move)
  const choice = state.pendingChoice
  assert.ok(choice, '皮博迪先生行动需要选择目标地点')
  const option = choice.options.find(candidate => candidate.id === 'hiddenLibrary')
  assert.ok(option, '隐藏的图书馆是皮博迪先生的合法目标')
  applyMove(state, decisionSeat(state), { action: 'choose', choiceId: choice.id, optionId: 'hiddenLibrary' })
  settle(state)

  const hidden = locationById(state, 'hiddenLibrary')
  assert.equal(hasPassageway(hidden), true, '隐藏的图书馆获得[[通道]]特性')
  assert.equal(hidden.peabodyShroud, -1, '隐藏的图书馆隐藏值 -1')
  assert.deepEqual([...(hidden.grantedTraits || [])].sort(), [PASSAGEWAY], '授予的特性记录在 grantedTraits')
  assert.equal(state.investigators[0].assets.find(asset => original(asset) === '03141').exhausted, true)
  assert.deepEqual(state.scenarioFlags.peabodyPassage, { locationId: 'hiddenLibrary' })

  // 双向连接：所有印刷[[通道]]地点都能进出隐藏的图书馆。
  const passageways = state.locations.filter(location => location.id !== 'hiddenLibrary' && hasPassageway(location))
  assert.ok(passageways.length >= 1)
  for (const location of passageways) {
    assert.equal(connectionIds(hidden).includes(location.id), true, `隐藏的图书馆 → ${location.id}`)
    assert.equal(connectionIds(location).includes('hiddenLibrary'), true, `${location.id} → 隐藏的图书馆`)
  }

  // 观察投影：界面能拿到中文关键字、授予特性与 -1 帷幕后的有效隐藏值。
  const view = viewState(state)
  const viewHidden = view.locations.find(location => location.id === 'hiddenLibrary')
  assert.ok(viewHidden, '投影包含隐藏的图书馆')
  const index = (viewHidden.traits || []).findIndex(trait => String(trait).toLowerCase() === 'passageway')
  assert.equal(index >= 0, true, '投影地点特性含 Passageway')
  assert.equal(viewHidden.traitsZh?.[index], '通道', '投影带中文特性名「通道」')
  assert.deepEqual(viewHidden.grantedTraits, [PASSAGEWAY])
  assert.equal(viewHidden.shroud, 3, '印刷隐藏值 4 - 皮博迪 1 = 3')

  // 调查员真的能走进去（过去被错误连接掩盖的入口，现在只能靠皮博迪打开）。
  const target = passageways[0]
  state.investigators[0].location = target.id
  state.investigators[0].actionsLeft = 3
  state.pendingChoice = null
  const into = legalMoves(state).find(candidate => candidate.action === 'move' && candidate.locationId === 'hiddenLibrary')
  assert.ok(into, `${target.id} 的调查员可以移动到隐藏的图书馆`)
  applyMove(state, 0, into)
  settle(state)
  assert.equal(state.investigators[0].location, 'hiddenLibrary')
  assert.equal(locationById(state, 'hiddenLibrary').revealed, true, '进入后揭示隐藏的图书馆')
})

test('轮末：皮博迪先生重整后撤销特性/隐藏值/连接，印刷[[通道]]特性不会被误删', () => {
  // 先把一个印刷[[通道]]地点也点成「临时通道」，验证清理不会剥掉印刷特性。
  const printed = state.locations.find(location => location.id !== 'hiddenLibrary' && hasPassageway(location))
  state.phase = 'investigation'
  state.currentSeat = 0
  state.investigators[0].actionsLeft = 3
  // 皮博迪先生已横置，先直接还原成可再次使用（这一批测的是清理路径）。
  const peabody = state.investigators[0].assets.find(asset => original(asset) === '03141')
  peabody.exhausted = false
  const move = legalMoves(state).find(candidate => candidate.rule === 'peabodyPassage')
  console.log('DEBUG move:', JSON.stringify(move), 'pending:', JSON.stringify(state.pendingChoice?.id))
  try { applyMove(state, 0, move) } catch (e) { console.log('DEBUG applyMove threw', e.message) }
  const choice = state.pendingChoice
  console.log('DEBUG choice:', JSON.stringify(choice?.options))
  const answer = applyMove(state, decisionSeat(state), { action: 'choose', choiceId: choice.id, optionId: printed.id })
  console.log('DEBUG after choose pending:', JSON.stringify(state.pendingChoice?.id), 'flag:', JSON.stringify(state.scenarioFlags.peabodyPassage))
  settle(state)
  const printedNow = locationById(state, printed.id)
  console.log('DEBUG printedNow:', printedNow.id, JSON.stringify(printedNow.grantedTraits), 'traits:', JSON.stringify(printedNow.traits), 'assetEx:', peabody.exhausted)
  assert.equal(printedNow.grantedTraits?.includes(PASSAGEWAY), true)
  assert.equal(printedNow.peabodyShroud, -1)

  echoes.roundEnded(state, stubApi())

  const hidden = locationById(state, 'hiddenLibrary')
  assert.equal(hasPassageway(hidden), false, '隐藏的图书馆失去[[通道]]特性')
  assert.equal(hidden.peabodyShroud, undefined)
  assert.deepEqual(hidden.connections, [], '隐藏的图书馆连接清空')
  assert.equal(hasPassageway(printedNow), true, '印刷[[通道]]特性保留')
  assert.equal(printedNow.peabodyShroud, undefined)
  assert.equal(printedNow.grantedTraits?.includes(PASSAGEWAY), false)
  assert.equal(state.scenarioFlags.peabodyPassage, undefined)
  // 幕 3 规则仍然生效：印刷[[通道]]地点之间仍互相连接。
  const passageways = state.locations.filter(hasPassageway)
  for (const location of passageways) for (const other of passageways) {
    if (location.id === other.id) continue
    assert.equal(connectionIds(location).includes(other.id), true)
  }
})

test('敌人阶段：敌人移动时隐藏的图书馆临时获得[[通道]]，猎手可以追进来；移动结束后还原', () => {
  const hidden = locationById(state, 'hiddenLibrary')
  const passageway = state.locations.find(location => location.id !== 'hiddenLibrary' && hasPassageway(location))
  assert.ok(passageway)
  state.investigators[0].location = 'hiddenLibrary'
  state.enemies = [{
    id: 'hunter-e1', code: '03144', originalCode: '03144', name: '猎手（测试）',
    location: passageway.id, hunter: true, fight: 1, evade: 1, health: 2,
    damage: 0, horror: 0, damageTaken: 0, engagedSeat: null, exhausted: false,
  }]
  state.phase = 'enemy'
  state.pendingChoice = null

  echoes.enemyPhaseStart(state, stubApi())
  assert.equal(hasPassageway(hidden), true, '敌人移动窗口内隐藏的图书馆获得[[通道]]特性')
  assert.equal(connectionIds(hidden).includes(passageway.id), true)
  const step = hunterStep(state, state.enemies[0])
  assert.equal(step, 'hiddenLibrary', '猎手朝隐藏的图书馆移动一步')
  echoes.enemyPhaseAfterHunters(state, stubApi())

  assert.equal(hasPassageway(hidden), false, '移动窗口结束后撤掉临时[[通道]]特性')
  assert.equal(connectionIds(hidden).includes(passageway.id), false, '临时连接被移除')
})
