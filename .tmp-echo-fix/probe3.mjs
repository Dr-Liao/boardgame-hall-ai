// 真实引擎验证 · 往事回声「隐藏的图书馆 / [[通道]] / 皮博迪先生」修复后行为。
// 运行：node .tmp-echo-fix/probe3.mjs   （全绿时 exit code 0）
import assert from 'node:assert/strict'
import {
  createGameState, startScenario, applyMove, legalMoves, decisionSeat, advanceAct, hunterStep,
} from '../games/arkhamhorror/src/engine/engine.js'
import { behavior as echoes } from '../games/arkhamhorror/content/campaigns/thePathToCarcosa/scenarios/echoesOfThePast/behavior.js'

const PASSAGEWAY = 'Passageway'
const original = card => card?.originalCode || card?.code
const locById = (state, id) => state.locations.find(location => location.id === id)
const hasPassageway = location => (location?.traits || [])
  .some(trait => String(trait).toLowerCase() === PASSAGEWAY.toLowerCase())
const connections = (state, id) => locById(state, id)?.connections || []
let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`)
    process.exitCode = 1
  }
}

function settle(state) {
  for (let i = 0; state.pendingChoice; i++) {
    if (i > 200) throw new Error('choice loop')
    const choice = state.pendingChoice
    const id = ['done', 'skip', 'self'].find(option => choice.options.some(item => item.id === option))
      ?? choice.options[0]?.id
    applyMove(state, decisionSeat(state), { action: 'choose', choiceId: choice.id, optionId: id })
  }
}

const state = createGameState({
  campaignId: 'thePathToCarcosa',
  playerInvestigator: '03006',
  seed: 'echo-probe-3',
  seatInvestigators: ['03006'],
}, [{ seat: 0, role: 'human' }])
settle(state)
startScenario(state, 2, [])
settle(state)

// 幕 1 → 幕 2（此时隐藏的图书馆仍未入场）
state.investigators.forEach(inv => { inv.clues = 20 })
advanceAct(state, [])
settle(state)
check('幕 2 时隐藏的图书馆还没有入场', () => {
  assert.equal(locById(state, 'hiddenLibrary'), undefined)
  assert.equal(hasPassageway(locById(state, 'hiddenLibrary')), false)
})

// 幕 2 → 幕 3 背面：放隐藏的图书馆、发皮博迪先生
state.investigators.forEach(inv => { inv.clues = 20 })
advanceAct(state, [])
settle(state)
check('幕 3 当前（03126）', () => {
  assert.equal(original(state.acts[state.actIndex]), '03126')
})
check('幕 2 背面：隐藏的图书馆入场且 traits/connections 均为空', () => {
  const hidden = locById(state, 'hiddenLibrary')
  assert.ok(hidden, '隐藏的图书馆已入场')
  assert.equal(hidden.revealed, false)
  assert.deepEqual(hidden.traits, [])
  assert.deepEqual(hidden.connections, [])
  for (const id of ['meetingRoom', 'secondLibrary', 'thirdLibrary', 'peabodysOffice']) {
    if (!locById(state, id)) continue
    assert.equal(connections(state, id).includes('hiddenLibrary'), false, `${id} 不应连到隐藏的图书馆`)
  }
})
check('皮博迪先生已交给调查员', () => {
  assert.ok(state.investigators[0].assets.some(asset => original(asset) === '03141'))
})
check('幕 3 规则安装：带[[通道]]特性的地点双向互连', () => {
  assert.equal(state.scenarioFlags.echoesPassagewayRule, true)
  const ids = state.locations.filter(hasPassageway).map(location => location.id)
  assert.ok(ids.length >= 1)
  for (const id of ids) for (const other of ids) {
    if (id === other) continue
    assert.equal(connections(state, id).includes(other), true, `${id} → ${other}`)
    assert.equal(connections(state, other).includes(id), true, `${other} → ${id}`)
  }
  // 隐藏的图书馆仍未连接（用户缺陷 1 已修复）。
  const hidden = locById(state, 'hiddenLibrary')
  for (const id of ids) assert.equal(connections(state, id).includes('hiddenLibrary'), false)
})

// 敌人阶段窗口：隐藏的图书馆临时获得通道，猎手能追进来；移动结束还原。
const hunter = {
  id: 'probe-hunter', code: '03144', originalCode: '03144', name: '探求者（probe）',
  location: 'meetingRoom', hunter: true, fight: 1, evade: 1, health: 2,
  damage: 0, horror: 0, damageTaken: 0, engagedSeat: null, exhausted: false,
}
state.investigators[0].location = 'hiddenLibrary'
state.enemies = [hunter]
const api = { info() {} }
echoes.enemyPhaseStart(state, api)
check('敌人阶段窗口：隐藏的图书馆临时获得[[通道]]与连接', () => {
  const hidden = locById(state, 'hiddenLibrary')
  assert.equal(hasPassageway(hidden), true)
  assert.deepEqual(hidden.grantedTraits, [PASSAGEWAY])
  assert.equal(state.scenarioFlags.hiddenLibraryTemporaryPassageway, true)
  assert.equal(connections(state, 'hiddenLibrary').includes('meetingRoom'), true)
  assert.equal(connections(state, 'meetingRoom').includes('hiddenLibrary'), true)
})
check('敌人阶段窗口：猎手从会议室一步走进隐藏的图书馆', () => {
  assert.equal(hunterStep(state, state.enemies[0]), 'hiddenLibrary')
})
echoes.enemyPhaseAfterHunters(state, api)
check('敌人阶段窗口结束：临时特性/连接/标记全部还原', () => {
  const hidden = locById(state, 'hiddenLibrary')
  assert.equal(hasPassageway(hidden), false)
  assert.deepEqual(hidden.grantedTraits, [])
  assert.deepEqual(hidden.connections, [])
  assert.equal(state.scenarioFlags.hiddenLibraryTemporaryPassageway, undefined)
})
state.enemies = []

// 皮博迪先生：任意在场地点（含隐藏的图书馆）= 隐藏值 -1 + 通道 + 双向连接。
state.phase = 'investigation'
state.currentSeat = 0
state.pendingChoice = null
state.investigators[0].actionsLeft = 3
const peabodyMove = legalMoves(state).find(move => move.rule === 'peabodyPassage')
check('皮博迪先生行动出现在合法列表', () => {
  assert.ok(peabodyMove)
})
applyMove(state, 0, peabodyMove)
const choice = state.pendingChoice
check('目标选项覆盖所有在场地点（不排除调查员所在地点）', () => {
  assert.ok(choice)
  const expected = state.locations.map(location => location.id).sort()
  const actual = choice.options.map(option => option.id).sort()
  assert.deepEqual(actual, expected)
  assert.ok(actual.includes(state.investigators[0].location))
  assert.ok(actual.includes('hiddenLibrary'))
})
applyMove(state, decisionSeat(state), { action: 'choose', choiceId: choice.id, optionId: 'hiddenLibrary' })
settle(state)
check('皮博迪先生：隐藏的图书馆获得通道 + -1 隐藏值 + 双向连接', () => {
  const hidden = locById(state, 'hiddenLibrary')
  assert.equal(hasPassageway(hidden), true)
  assert.deepEqual(hidden.grantedTraits, [PASSAGEWAY])
  assert.equal(hidden.peabodyShroud, -1)
  assert.deepEqual(state.scenarioFlags.peabodyPassage, { locationId: 'hiddenLibrary' })
  assert.equal(state.investigators[0].assets.find(asset => original(asset) === '03141').exhausted, true)
  for (const other of state.locations.filter(location => location.id !== 'hiddenLibrary' && hasPassageway(location))) {
    assert.equal(connections(state, 'hiddenLibrary').includes(other.id), true)
    assert.equal(connections(state, other.id).includes('hiddenLibrary'), true)
  }
})

// 轮末清理（引擎在重整步骤之后调用 roundEnded；这里直接调用规则函数验证）。
echoes.roundEnded(state, { info() {} })
check('轮末：只撤销授予的通道/隐藏值/连接，印刷特性保留、规则连接保留', () => {
  const hidden = locById(state, 'hiddenLibrary')
  assert.equal(hasPassageway(hidden), false)
  assert.deepEqual(hidden.grantedTraits, [])
  assert.equal(hidden.peabodyShroud, undefined)
  assert.deepEqual(hidden.connections, [])
  assert.equal(state.scenarioFlags.peabodyPassage, undefined)
  const printed = state.locations.filter(hasPassageway).map(location => location.id)
  for (const id of printed) for (const other of printed) {
    if (id === other) continue
    assert.equal(connections(state, id).includes(other), true)
  }
})

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
