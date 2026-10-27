import { createGameState, startScenario, applyMove, legalMoves, decisionSeat, advanceAct } from '../games/arkhamhorror/src/engine/engine.js'
import { viewState } from '../games/arkhamhorror/src/integration/observation.js'

function settle(state) {
  for (let i = 0; state.pendingChoice; i++) {
    if (i > 200) throw new Error('choice loop')
    const c = state.pendingChoice
    const id = ['done', 'skip', 'self'].find(id => c.options.some(o => o.id === id)) ?? c.options[0]?.id
    applyMove(state, decisionSeat(state), { action: 'choose', choiceId: c.id, optionId: id })
  }
}

const state = createGameState({
  campaignId: 'thePathToCarcosa',
  playerInvestigator: '03006',
  seed: 'echo-probe',
  seatInvestigators: ['03006'],
}, [{ seat: 0, role: 'human' }])
settle(state)
startScenario(state, 2, [])
settle(state)
state.investigators.forEach(inv => { inv.clues = 10 })
advanceAct(state, [])
settle(state)
state.investigators.forEach(inv => { inv.clues = 10 })
advanceAct(state, [])
settle(state)

const inv = state.investigators[0]
inv.actionsLeft = 3
state.phase = 'investigation'
state.currentSeat = 0
const moves = legalMoves(state).filter(m => m.rule === 'peabodyPassage' || (m.action === 'scenarioAction' && /通路|通道/.test(m.label || '')))
console.log('peabody moves:', JSON.stringify(moves, null, 1))
const peabodyMove = legalMoves(state).find(m => m.rule === 'peabodyPassage')
const events = applyMove(state, 0, peabodyMove)
settle(state)
console.log('pendingChoice after peabody action:', JSON.stringify(state.pendingChoice?.options?.map(o => o.label)))
if (state.pendingChoice) {
  const target = state.pendingChoice.options.find(o => o.id === 'hiddenLibrary') || state.pendingChoice.options[0]
  applyMove(state, decisionSeat(state), { action: 'choose', choiceId: state.pendingChoice.id, optionId: target.id })
}
console.log('\n=== after peabody (target hiddenLibrary) ===')
for (const loc of state.locations) {
  console.log(`- ${loc.id} traits=${JSON.stringify(loc.traits)} revealed=${loc.revealed} shroud=${loc.shroud} shroudMod=${loc.shroudMod} peabodyShroud=${loc.peabodyShroud} conns=${JSON.stringify(loc.connections)}`)
}
console.log('peabodyPassage flag:', state.scenarioFlags.peabodyPassage)
console.log('asset exhausted:', state.investigators[0].assets.map(a => a.code + ':' + a.exhausted))

// what the browser receives
const view = viewState(state)
console.log('\nview locations with traits/connections:')
for (const loc of view.locations) {
  if (loc.id === 'hiddenLibrary' || loc.id === 'meetingRoom') console.log(' ', loc.id, JSON.stringify({ traits: loc.traits, connections: loc.connections, shroud: loc.shroud, shroudMod: loc.shroudMod, peabodyShroud: loc.peabodyShroud }))
}
console.log('view cards 03139:', JSON.stringify(view.cards?.['03139'] && { traits: view.cards['03139'].traits, traitsZh: view.cards['03139'].traitsZh }))
console.log('view cards 03137:', JSON.stringify(view.cards?.['03137'] && { traits: view.cards['03137'].traits, traitsZh: view.cards['03137'].traitsZh }))
