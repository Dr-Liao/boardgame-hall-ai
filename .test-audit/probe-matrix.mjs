// Probe: time one campaign-n4 legal-campaign matrix combo and count commands.
import { createGameState, applyMove, legalMoves, validateMove, decisionSeat } from '../games/arkhamhorror/src/engine/engine.js'

const clone = value => JSON.parse(JSON.stringify(value))
const combos = [[1, 'standard']]
for (const [count, difficulty] of combos) {
  const started = Date.now()
  let state = createGameState({ playerInvestigator: '01001', seed: 'n4-legal-campaign', difficulty }, Array.from({ length: count }, (_, seat) => ({ seat })))
  const commands = []
  for (let i = 0; state.status === 'playing' && i < 900; i++) {
    const choices = legalMoves(state)
    if (!choices.length) throw new Error('no choices at ' + i)
    const command = state.pendingChoice
      ? choices.find(item => ['done', 'skip', 'self'].includes(item.optionId)) || choices[0]
      : choices.find(item => item.action === 'resign') || choices.find(item => item.action === 'endTurn')
    if (!command) throw new Error('no command at ' + i)
    commands.push(clone(command))
    const seat = decisionSeat(state)
    if (validateMove(state, seat, command) !== null) throw new Error('invalid at ' + i + ': ' + JSON.stringify(command))
    applyMove(state, seat, command)
    state = clone(state)
  }
  console.log(JSON.stringify({ count, difficulty, status: state.status, outcome: state.outcome, commands: commands.length, ms: Date.now() - started }))
}
