// cpu-prof driver: replicate replay-fuzz-walker loop (~N steps) without node:test.
import { createGameState, applyMove } from '../games/arkhamhorror/src/engine/engine.js'
import { createRandomPolicy, nextMove } from '../games/arkhamhorror/tools/replay-games.mjs'

const playersFor = count => Array.from({ length: count }, (_, seat) => ({ seat, role: seat === 0 ? 'human' : 'ai' }))
const CAMPAIGNS = ['nightOfTheZealot', 'theDunwichLegacy', 'thePathToCarcosa', 'theForgottenAge']
const TARGET = Number(process.argv[2] || 100)

let steps = 0
for (let game = 0; steps < TARGET && game < 4; game++) {
  const campaignId = CAMPAIGNS[game % CAMPAIGNS.length]
  const seed = `walker-${game}`
  const state = createGameState(
    { campaignHub: true, campaignId, seed, rulesMode: game % 2 ? 'strict' : 'simplified' },
    playersFor(1 + (game % 4)),
  )
  const policy = createRandomPolicy(seed)
  for (let index = 0; state.status === 'playing' && index < 400 && steps < TARGET; index++) {
    const selection = nextMove(state, policy)
    if (!selection) break
    applyMove(state, selection.seat, selection.move)
    steps++
  }
}
console.log('steps', steps)
