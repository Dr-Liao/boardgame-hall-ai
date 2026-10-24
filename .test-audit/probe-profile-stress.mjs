// cpu-prof driver: replicate campaign-n4 purchase-stress loop (N loops) without node:test.
import { createGameState, applyMove, validateMove, decisionSeat } from '../games/arkhamhorror/src/engine/engine.js'

const clone = value => JSON.parse(JSON.stringify(value))
function move(state, command) {
  const seat = decisionSeat(state)
  if (validateMove(state, seat, command) !== null) throw new Error('invalid move ' + JSON.stringify(command))
  return applyMove(state, seat, command)
}
function answer(state, optionId) {
  return move(state, { action: 'choose', choiceId: state.pendingChoice.id, optionId })
}
function settle(state, stopKind = null) {
  for (let i = 0; state.pendingChoice && state.pendingChoice.kind !== stopKind; i++) {
    if (i >= 150) throw new Error('settle limit')
    const choice = state.pendingChoice
    const preferred = ['done', 'skip', 'self', 'cancel'].find(id => choice.options.some(option => option.id === id))
    answer(state, preferred || choice.options[0].id)
  }
}
const state = createGameState({ playerInvestigator: '01001', seed: 'n4-campaign', difficulty: 'standard' }, [{ seat: 0 }])
settle(state)
// gatheringConclusion
state.actIndex = 2
state.chaosBag = ['0']
state.investigators[0].hand = []
state.enemies = []
move(state, { action: 'resource' })
settle(state, 'story')
answer(state, 'r2')

const LOOPS = Number(process.argv[2] || 20)
for (let i = 0; i < LOOPS; i++) {
  answer(state, 'upgrade')
  if (i % 2) answer(state, '01094')
  answer(state, 'cancel')
}
console.log('done', LOOPS)
