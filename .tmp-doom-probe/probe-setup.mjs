import { createGameState, startScenario, applyMove, decisionSeat } from '../games/arkhamhorror/src/engine/engine.js'
import { resolveTransaction } from '../games/arkhamhorror/src/engine/resolution.js'
import { legalMoves } from '../games/arkhamhorror/src/engine/engine.js'

function answerAll(state, tag) {
  for (let i = 0; state.pendingChoice && i < 200; i++) {
    const c = state.pendingChoice
    const id = ['done', 'skip', 'self'].find(id => c.options.some(o => o.id === id)) ?? c.options[0]?.id
    const seat = c.seat ?? decisionSeat(state) ?? 0
    try {
      applyMove(state, seat, { action: 'choose', choiceId: c.id, optionId: id })
    } catch (err) {
      console.log(tag, "FAIL at", i, c.kind, "seat", c.seat, "used", seat, err.message)
      console.log('legalMoves', JSON.stringify(legalMoves(state)).slice(0, 400))
      throw err
    }
  }
}
const codes = ['01001', '01002', '01003']
const players = codes.map((_, seat) => ({ seat, role: 'ai', name: 'P' + seat }))
const state = createGameState({ campaignId: 'thePathToCarcosa', playerInvestigator: '01001', seed: 'doom-clear-check', seatInvestigators: codes }, players)
console.log('after create: hub?', state.hubFlow, 'pending', state.pendingChoice?.kind)
answerAll(state, 'hub')
console.log('after hub: status', state.status, 'scenario', state.scenario?.id, 'pending', state.pendingChoice?.kind)
state.campaign.leadSeat = 0
state.campaign.records.vipsInterviewed = ['03079']
resolveTransaction(state, 0, { action: 'setup' }, (draft, seat, move, events) => startScenario(draft, 2, events), { initial: true })
console.log('after startScenario: scenario', state.scenario?.id, 'pending', state.pendingChoice?.kind, state.pendingChoice?.prompt)
answerAll(state, 'scenario')
console.log('final: round', state.round, 'phase', state.phase, 'agenda', state.agendas[state.agendaIndex]?.nameZh, 'threshold', state.agendas[state.agendaIndex]?.doomThreshold)

