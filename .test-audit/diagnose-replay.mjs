// Diagnose why replay-fuzz.test.mjs became extremely slow in the current dirty tree.
// Mirrors the two tests without assertions; prints per-game progress so we can see
// whether games terminate early (many games needed) or each step is expensive.
import { performance } from 'node:perf_hooks'
import { replayHashes } from '../games/arkhamhorror/src/engine/replay.js'
import { createRandomPolicy, playGame } from '../games/arkhamhorror/tools/replay-games.mjs'

const CAMPAIGNS = ['nightOfTheZealot', 'theDunwichLegacy', 'thePathToCarcosa', 'theForgottenAge']
const playersFor = count => Array.from({ length: count }, (_, seat) => ({ seat, role: seat === 0 ? 'human' : 'ai' }))
const now = () => performance.now()
const fmt = ms => Math.round(ms)

// ---- Phase A: 100 games, replay check each game (test 1) ----
let t0 = now()
let stepsA = 0
for (let index = 0; index < 100; index++) {
  const campaignId = CAMPAIGNS[index % CAMPAIGNS.length]
  const seats = 1 + (index % 4)
  const seed = `fuzz-${index}`
  const game = playGame({
    settings: {
      campaignHub: true, campaignId, seed,
      rulesMode: index % 3 === 0 ? 'strict' : 'simplified',
      aiStoryAwareness: index % 5 === 0 ? 'on' : 'off',
      difficulty: ['easy', 'standard', 'hard'][index % 3],
    },
    players: playersFor(seats),
    policy: createRandomPolicy(seed),
    steps: 8 + 5 * seats,
  })
  const moves = game.hashes.length - 1
  stepsA += moves
  replayHashes(game.log)
  if (index % 10 === 9) console.log(`A game ${index + 1} cumMs=${fmt(now() - t0)} steps=${stepsA}`)
}
console.log(`A total: ms=${fmt(now() - t0)} steps=${stepsA}`)

// ---- Phase B: 5000-step walker (test 2), capped at 90s of wall time ----
const BUDGET_MS = 90_000
t0 = now()
let tot = 0, games = 0
let phaseB
while (tot < 5000) {
  const elapsed = now() - t0
  if (elapsed > BUDGET_MS) { phaseB = 'timeout'; break }
  const campaignId = CAMPAIGNS[games % CAMPAIGNS.length]
  const seed = `walker-${games}`
  const result = playGame({
    settings: { campaignHub: true, campaignId, seed, rulesMode: games % 2 ? 'strict' : 'simplified' },
    players: playersFor(1 + (games % 4)),
    policy: createRandomPolicy(seed),
    steps: 400,
  })
  const s = result.hashes.length - 1
  tot += s
  games++
  if (games <= 15 || games % 10 === 0) {
    console.log(`B game ${games} steps=${s} cumSteps=${tot} cumMs=${fmt(now() - t0)}`)
  }
}
console.log(`B ${phaseB ?? 'completed'}: games=${games} steps=${tot} ms=${fmt(now() - t0)}`)
