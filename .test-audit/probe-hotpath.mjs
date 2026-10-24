// Measure the per-command transaction overhead: state size, static-field clone cost, applyMove cost.
import { performance } from 'node:perf_hooks'
import { createGameState, legalMoves, applyMove, decisionSeat } from '../games/arkhamhorror/src/engine/engine.js'

const now = () => performance.now()
const time = (label, fn) => {
  const started = now()
  const value = fn()
  console.log(`${label}: ${(now() - started).toFixed(1)}ms`, typeof value === 'object' ? '' : value)
  return value
}

const state = time('createGameState(1p)', () => createGameState({ playerInvestigator: '01001', seed: 'hotpath', difficulty: 'standard' }, [{ seat: 0 }]))

const measures = {}
measures.fullJson = JSON.stringify(state).length
measures.cardsJson = JSON.stringify(state.cards).length
measures.investigatorDefsJson = JSON.stringify(state.investigatorDefs).length
measures.scenarioJson = JSON.stringify(state.scenario).length
console.log('bytes:', JSON.stringify(measures, null, 0))

const STATIC_FIELDS = ['cards', 'investigatorDefs', 'classNames', 'classColors', 'skillNames', 'tokenLabels',
  'schemaVersion', 'rulesVersion', 'resourceVersion']
time('clone(static fields) x1', () => JSON.parse(JSON.stringify(Object.fromEntries(STATIC_FIELDS.map(key => [key, state[key]])))))
time('clone(cards) x1', () => JSON.parse(JSON.stringify(state.cards)))
time('clone(full state) x1', () => JSON.parse(JSON.stringify(state)))

// Drive ~20 commands and time each, plus a breakdown of transaction pieces.
let cursor = state
let total = 0
time('settle+20 commands', () => {
  for (let i = 0; i < 20; i++) {
    const moves = legalMoves(cursor)
    if (!moves.length) break
    const move = cursor.pendingChoice
      ? moves.find(item => ['done', 'skip', 'self'].includes(item.optionId)) || moves[0]
      : moves.find(item => item.action === 'endTurn') || moves[0]
    const seat = decisionSeat(cursor) ?? 0
    const started = now()
    applyMove(cursor, seat, move)
    total += now() - started
  }
})
console.log(`applyMove x20: ${total.toFixed(1)}ms → ${(total / 20).toFixed(1)}ms/command`)
