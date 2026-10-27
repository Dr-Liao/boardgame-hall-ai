// 临时探针：验证「往事回声」地点投影（traitsZh / grantedTraits / peabodyShroud）。
// 运行：node .tmp-echo-ui/probe-projection.mjs  （cwd 任意，路径按本文件解析）
import {
  createGameState, startScenario, applyMove, decisionSeat, advanceAct, getStat, getMaxSanity,
} from '../games/arkhamhorror/src/engine/engine.js'
import { viewState } from '../games/arkhamhorror/src/integration/observation.js'
import { captureTableState, maskHiddenLocations } from '../games/arkhamhorror/src/integration/presentation-state.js'

function settle(state) {
  for (let i = 0; state.pendingChoice; i++) {
    if (i > 200) throw new Error('choice loop')
    const choice = state.pendingChoice
    const id = ['done', 'skip', 'self'].find(id => choice.options.some(o => o.id === id)) ?? choice.options[0]?.id
    applyMove(state, decisionSeat(state), { action: 'choose', choiceId: choice.id, optionId: id })
  }
}

const state = createGameState({
  campaignId: 'thePathToCarcosa',
  playerInvestigator: '03006',
  seed: 'x',
  seatInvestigators: ['03006'],
}, [{ seat: 0, role: 'human' }])
settle(state)
startScenario(state, 2, [])
settle(state)
// 推进到第三幕（act 3）以让「隐藏的图书馆」入场。
for (let i = 0; i < 2; i++) {
  state.investigators.forEach(inv => { inv.clues = 10 })
  advanceAct(state, [])
  settle(state)
}

const hiddenLibrary = state.locations.find(loc => loc.id === 'hiddenLibrary')
if (!hiddenLibrary) throw new Error('hiddenLibrary 应在第三幕入场')
const meetingRoom = state.locations.find(loc => loc.id === 'meetingRoom')
if (!meetingRoom) throw new Error('meetingRoom 应在场')

// —— 模拟规则队友实现后的权威 state ——
// 03141 皮博迪先生：选择一个地点获得 [[通道]] 特性且 -1 帷幕（直到他重整）。
hiddenLibrary.grantedTraits = ['Passageway']
hiddenLibrary.traits = ['Passageway']
hiddenLibrary.peabodyShroud = -1
hiddenLibrary.revealed = false
const printedHiddenShroud = hiddenLibrary.shroud
const stateBefore = JSON.stringify(state)

const view = viewState(state, 0)
const viewHidden = view.locations.find(loc => loc.id === 'hiddenLibrary')
const viewMeeting = view.locations.find(loc => loc.id === 'meetingRoom')

const failures = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ' != ' + JSON.stringify(expected)}`)
  if (!ok) failures.push(label)
}

check('隐藏的图书馆 traits 原样保留', viewHidden.traits, ['Passageway'])
check('隐藏的图书馆 traitsZh 与 traits 逐位对应', viewHidden.traitsZh, ['通道'])
check('隐藏的图书馆 grantedTraits 透传', viewHidden.grantedTraits, ['Passageway'])
check('隐藏的图书馆 grantedTraitsZh 中文对照', viewHidden.grantedTraitsZh, ['通道'])
check('隐藏的图书馆 有效帷幕 = 印刷 ' + printedHiddenShroud + ' - 1', viewHidden.shroud, printedHiddenShroud - 1)
check('历史协会（地面层 + 通道印刷特性）traitsZh', viewMeeting.traitsZh, ['一楼', '通道'])
check('历史协会没有授予特性', viewMeeting.grantedTraits, [])
check('历史协会有效帷幕不变', viewMeeting.shroud, meetingRoom.shroud)
check('viewState 不写回权威 state', JSON.stringify(state) === stateBefore, true)

// 演出快照（presentation）与实时视图口径一致。
const snapshot = captureTableState(state, getStat, getMaxSanity)
const snapHidden = snapshot.locations.find(loc => loc.id === 'hiddenLibrary')
check('演出快照 隐藏的图书馆 traitsZh', snapHidden.traitsZh, ['通道'])
check('演出快照 隐藏的图书馆 grantedTraits', snapHidden.grantedTraits, ['Passageway'])
check('演出快照 隐藏的图书馆 有效帷幕', snapHidden.shroud, printedHiddenShroud - 1)
check('演出快照 历史协会 traitsZh', snapshot.locations.find(loc => loc.id === 'meetingRoom').traitsZh, ['一楼', '通道'])

// 隐藏身份地点：印刷 traits 仍被掩码清空（名字换成「未知小径」），但效果授予的通道保留，
// 这样未揭示地点被皮博迪先生点成通道时地图仍能显示关键字。
const masked = maskHiddenLocations([{
  id: 'secretPath', hiddenIdentity: true, revealed: false, traits: ['Secret Trait'],
  grantedTraits: ['Passageway'], grantedTraitsZh: ['通道'], connections: [], clues: 2,
}])[0]
check('隐藏身份地点 印刷 traits 不外泄', masked.traits, undefined)
check('隐藏身份地点 授予特性保留', masked.grantedTraits, ['Passageway'])
check('隐藏身份地点 授予特性中文对照保留', masked.grantedTraitsZh, ['通道'])

console.log('\nview.locations[hiddenLibrary] =', JSON.stringify(viewHidden))
if (failures.length) {
  console.error('\nFAILED:', failures.join(', '))
  process.exit(1)
}
console.log('\nALL PASS')
