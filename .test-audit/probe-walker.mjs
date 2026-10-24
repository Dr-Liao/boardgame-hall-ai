// Probe the walker workload: how many steps per game, how much time per game/step.
import { performance } from 'node:perf_hooks'
import { createRandomPolicy, playGame } from '../games/arkhamhorror/tools/replay-games.mjs'

const CAMPAIGNS = ['nightOfTheZealot', 'theDunwichLegacy', 'thePathToCarcosa', 'theForgottenAge']
const playersFor = count => Array.from({ length: count }, (_, seat) => ({ seat, role: seat === 0 ? 'human' : 'ai' }))
const BUDGET_MS = 60_000
const started = performance.now()
let totals = { steps: 0, games: 0, ms: 0 }
for (let game = 0; ; game++) {
  if (performance.now() - started > BUDGET_MS) break
  const gameStarted = performance.now()
  const campaignId = CAMPAIGNS[game % CAMPAIGNS.length]
  const seed = `walker-${game}`
  const result = playGame({
    settings: { campaignHub: true, campaignId, seed, rulesMode: game % 2 ? 'strict' : 'simplified' },
    players: playersFor(1 + (game % 4)),
    policy: createRandomPolicy(seed),
    steps: 400,
  })
  const steps = result.hashes.length - 1
  const ms = performance.now() - gameStarted
  totals.steps += steps
  totals.games++
  totals.ms += ms
  console.log(`game=${game} seats=${1 + (game % 4)} steps=${steps} gameMs=${Math.round(ms)} cumSteps=${totals.steps} cumMs=${Math.round(performance.now() - started)}`)
}
console.log(`SUMMARY ${JSON.stringify({ ...totals, ms: Math.round(totals.ms), avgStepsPerGame: (totals.steps / totals.games).toFixed(1), msPerStep: (totals.ms / totals.steps).toFixed(1) })}`)
