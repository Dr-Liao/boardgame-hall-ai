import { createGameState, startScenario, applyMove, legalMoves, decisionSeat, advanceAct } from '../games/arkhamhorror/src/engine/engine.js'

function settle(state) {
  for (let i = 0; state.pendingChoice; i++) {
    if (i > 200) throw new Error('choice loop')
    const c = state.pendingChoice
    const id = ['done', 'skip', 'self'].find(id => c.options.some(o => o.id === id)) ?? c.options[0]?.id
    applyMove(state, decisionSeat(state), { action: 'choose', choiceId: c.id, optionId: id })
  }
}

function showLocations(state, label) {
  console.log(`\n=== ${label} === act=${state.actIndex} round=${state.round}`)
  for (const loc of state.locations) {
    console.log(`- ${loc.id} [${loc.originalCode}] ${loc.name} traits=${JSON.stringify(loc.traits)} revealed=${loc.revealed} conns=${JSON.stringify(loc.connections)} peabodyShroud=${loc.peabodyShroud}`)
  }
  console.log('hiddenLibrary in play:', state.locations.some(l => l.id === 'hiddenLibrary'))
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
console.log('scenario:', state.scenario.id, state.scenario.name, 'numInvestigators:', state.numInvestigators)
showLocations(state, 'after setup')
console.log('setAside:', JSON.stringify(state.scenarioZones.setAside))
console.log('flags:', JSON.stringify(state.scenarioFlags))

state.investigators.forEach(inv => { inv.clues = 10 })
advanceAct(state, [])
settle(state)
showLocations(state, 'after act1 advance (act2 front)')

state.investigators.forEach(inv => { inv.clues = 10 })
advanceAct(state, [])
settle(state)
showLocations(state, 'after act2 advance (act3 front)')
console.log('flags:', JSON.stringify(state.scenarioFlags))
console.log('storyAssets:', JSON.stringify((state.storyAssets || []).map(a => a.code)))
console.log('assets:', JSON.stringify(state.investigators.map(inv => (inv.assets || []).map(a => a.code + (a.exhausted ? '(ex)' : '')))))
console.log('act now:', state.acts[state.actIndex].originalCode, state.acts[state.actIndex].name)
