// 五子棋 / 井字棋的 AI 棋力回归：
//   - 本地引擎（engine.js）必须能看懂「必杀 / 必防」；
//   - 模型输出不可用时，兜底必须走引擎，不能再随机挑空点；
//   - 模型给出「合法但立刻输棋」的一手时，Mod 的 refineMove 要能纠正；
//   - 提示词要把引擎候选点交给模型；
//   - 推理型后端把输出预算花光（content 为空）时，客户端要提高预算重试。
//
// 全部使用本地 stub 模型，不访问真实付费接口。

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import gobang from '../../games/gobang/index.js'
import ox from '../../games/ox/index.js'
import * as gobangEngine from '../../games/gobang/engine.js'
import * as oxEngine from '../../games/ox/engine.js'
import { createAgent } from '../../lib/agent/orchestrator.js'
import { buildSystemPrompt, buildUserPrompt } from '../../lib/agent/prompt.js'
import { chatCompletion, resetJsonModeCache } from '../../lib/agent/client.js'
import { statsSnapshot, resetStats } from '../../lib/agent/log.js'

const N = 15
const idx = (x, y) => y * N + x

function makePlayers() {
  return [
    { seat: 0, role: 'human', color: 'black', name: '玩家' },
    { seat: 1, role: 'ai', color: 'white', name: '测试 AI', aiId: 'ai-1' },
  ]
}

/** 按 seat 摆放棋子（直接调用 Mod 的 applyMove），最后把行动权交给 AI。 */
function buildState(mod, placements) {
  const state = mod.createState({ firstMove: 'player' }, makePlayers())
  state.revision = 0
  for (const p of placements) {
    const invalid = mod.validateMove(state, p.seat, p)
    assert.equal(invalid, null, '测试局面本身必须合法：' + invalid)
    mod.applyMove(state, p.seat, p)
    state.revision++
  }
  return state
}

function makeSession(mod, state) {
  return {
    sessionId: 'game-ai-' + mod.id, modId: mod.id, modName: mod.name,
    players: makePlayers(), state, events: [], notes: [],
  }
}

const B = (x, y) => ({ seat: 0, x, y })
const W = (x, y) => ({ seat: 1, x, y })

// ---------------------------------------------------------------------------
// 引擎：五子棋
// ---------------------------------------------------------------------------

test('五子棋引擎：能看出自己的成五点，也能堵住对手的成五点', () => {
  // 白（AI）横向四连 (3,7)~(6,7)
  const attack = buildState(gobang, [B(0, 0), W(3, 7), B(1, 0), W(4, 7), B(0, 14), W(5, 7), B(14, 0), W(6, 7)])
  const wins = gobangEngine.mustPlays(attack, 1)
  assert.deepEqual(wins.wins.map((m) => `${m.x},${m.y}`).sort(), ['2,7', '7,7'])
  const attackMove = gobangEngine.bestMove(attack, 1)
  assert.ok(['2,7', '7,7'].includes(`${attackMove.x},${attackMove.y}`), '有四连时必须直接成五')
  assert.equal(gobangEngine.forcedMove(attack, 1).reason, 'win')

  // 黑（玩家）横向四连，AI 必须封堵
  const defense = buildState(gobang, [B(3, 7), W(3, 3), B(4, 7), W(4, 4), B(5, 7), W(5, 5), B(6, 7), W(9, 9), B(0, 0)])
  const blocks = gobangEngine.mustPlays(defense, 1)
  assert.deepEqual(blocks.blocks.map((m) => `${m.x},${m.y}`).sort(), ['2,7', '7,7'])
  const defenseMove = gobangEngine.bestMove(defense, 1)
  assert.ok(['2,7', '7,7'].includes(`${defenseMove.x},${defenseMove.y}`), '对手有四连时必须封堵')
  assert.equal(gobangEngine.forcedMove(defense, 1).reason, 'block')
})

test('五子棋引擎：会封堵活三，且只下在战场附近', () => {
  const state = buildState(gobang, [
    B(5, 7), W(5, 5), B(6, 7), W(6, 6), B(7, 7), W(8, 4), B(0, 0), W(9, 9), B(1, 1),
  ])
  const move = gobangEngine.bestMove(state, 1)
  assert.ok(['4,7', '8,7'].includes(`${move.x},${move.y}`), '对手活三必须封一端，实际下了 ' + move.x + ',' + move.y)

  // 候选点必须贴着已有棋子（旧兜底会在全盘 225 个空点里随机挑，这是「乱下」的来源）
  for (const placement of [B(7, 7), B(3, 3), W(8, 8), B(6, 8), W(6, 6)]) {
    state.board[idx(placement.x, placement.y)] = placement.seat === 0 ? 'black' : 'white'
  }
  const mid = gobangEngine.bestMove(state, 1)
  let nearest = Infinity
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!state.board[idx(x, y)]) continue
      nearest = Math.min(nearest, Math.max(Math.abs(x - mid.x), Math.abs(y - mid.y)))
    }
  }
  assert.ok(nearest <= 2, '引擎落点必须贴着已有棋子（实际距离 ' + nearest + '）')
  assert.equal(gobang.validateMove(state, 1, mid), null, '引擎给出的落点必须合法')
})

test('五子棋引擎：同一局面结果稳定（便于回放与回归）', () => {
  const state = buildState(gobang, [B(7, 7), W(8, 8), B(6, 6), W(3, 3), B(7, 8)])
  const a = gobangEngine.bestMove(state, 1)
  const b = gobangEngine.bestMove(state, 1)
  assert.deepEqual(a, b)
})

// ---------------------------------------------------------------------------
// 引擎：井字棋
// ---------------------------------------------------------------------------

test('井字棋引擎：能立刻三连，也能挡住对手的三连', () => {
  const attack = buildState(ox, [{ seat: 0, x: 0, y: 0 }, { seat: 1, x: 0, y: 1 }, { seat: 0, x: 2, y: 2 }, { seat: 1, x: 1, y: 1 }])
  assert.equal(oxEngine.forcedMove(attack, 1).reason, 'win')
  assert.deepEqual(oxEngine.bestMove(attack, 1), { x: 2, y: 1 })

  const defense = buildState(ox, [{ seat: 0, x: 0, y: 0 }, { seat: 1, x: 1, y: 0 }, { seat: 0, x: 1, y: 1 }])
  assert.equal(oxEngine.forcedMove(defense, 1).reason, 'block')
  assert.deepEqual(oxEngine.bestMove(defense, 1), { x: 2, y: 2 })
})

test('井字棋引擎：后手（O）永不落败', () => {
  const cache = new Map()
  const colors = ['black', 'white']
  let losses = 0
  let games = 0

  const play = (board, seat) => {
    const winner = oxEngine.winnerOf(board)
    if (winner) {
      if (winner === 'black') losses++
      games++
      return
    }
    if (board.every(Boolean)) { games++; return }
    if (seat === 1) {
      const key = board.map((v) => (v == null ? '.' : v)).join('|')
      let move = cache.get(key)
      if (!move) {
        move = oxEngine.bestMove({ board: board.slice(), colors }, 1)
        cache.set(key, move)
      }
      const next = board.slice()
      next[move.x + move.y * 3] = 'white'
      play(next, 0)
      return
    }
    for (let i = 0; i < 9; i++) {
      if (board[i]) continue
      const next = board.slice()
      next[i] = 'black'
      play(next, 1)
    }
  }

  play(new Array(9).fill(null), 0)
  assert.ok(games > 100, '至少要覆盖上百条对局（实际 ' + games + '）')
  assert.equal(losses, 0, '井字棋引擎作为后手必须一局不失（实际输了 ' + losses + ' 局）')
})

// ---------------------------------------------------------------------------
// 与编排器集成：兜底与纠错
// ---------------------------------------------------------------------------

function startModel() {
  const state = { calls: 0, seen: [], behavior: () => ({ content: '{"move":{"x":0,"y":0},"speech":"ok"}' }) }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      state.calls++
      let payload = null
      try { payload = JSON.parse(body) } catch { /* 保持 null */ }
      const auth = String(req.headers.authorization || '')
      if (auth !== 'Bearer stub-key') {
        res.writeHead(500)
        res.end('refusing non-stub credential: ' + auth)
        state.foreignAuth = auth
        return
      }
      state.seen.push(payload)
      const reply = await state.behavior(payload, state.calls)
      if (reply && reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(reply.body || JSON.stringify({ error: { message: 'stub error' } }))
        return
      }
      const choice = {
        message: { content: reply.content, ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}) },
        finish_reason: reply.finish || 'stop',
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        choices: [choice],
        usage: reply.usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'stub-model',
      }))
    })
  })
  return {
    state,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

test('五子棋 / 井字棋的 AI 棋力回归', { timeout: 120000 }, async (t) => {
  const envKeys = ['DSH_HOME', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MAX_RETRIES', 'AI_MAX_TOKENS', 'AI_REASONING_EFFORT']
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-game-ai-'))
  process.env.DSH_HOME = home
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_TIMEOUT_MS = '5000'

  const model = startModel()
  process.env.AI_BASE_URL = await model.listen()
  resetJsonModeCache()

  t.after(async () => {
    await model.close()
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  const agentFor = (mod) => createAgent({
    modById: (id) => (id === mod.id ? mod : null),
    getAi: () => ({ id: 'ai-1', name: '测试 AI', persona: '你是测试 AI。' }),
  })

  await t.test('模型输出不可用时，兜底必须走引擎（而不是随机空点）', async () => {
    resetStats()
    model.state.calls = 0
    model.state.behavior = () => ({ content: '这不是 JSON' })

    const state = buildState(gobang, [
      B(3, 7), W(3, 3), B(4, 7), W(4, 4), B(5, 7), W(5, 5), B(6, 7), W(9, 9), B(0, 0),
    ])
    const session = makeSession(gobang, state)
    const agent = agentFor(gobang)
    const result = await agent.agentPlay(session, 1)

    assert.equal(result.fallback, true)
    assert.ok(result.move, '兜底必须给出落点')
    assert.ok(['2,7', '7,7'].includes(`${result.move.x},${result.move.y}`),
      '兜底必须堵住四连，实际下了 ' + JSON.stringify(result.move))
    assert.equal(gobang.validateMove(state, 1, result.move), null)
  })

  await t.test('模型给了合法但漏防的一手时，refineMove 会纠正', async () => {
    resetStats()
    model.state.calls = 0
    // 合法的乱下：(0,13) 完全在战场之外，且放着玩家的四连不管
    model.state.behavior = () => ({ content: JSON.stringify({ move: { x: 0, y: 13 }, speech: '随便下' }) })

    const state = buildState(gobang, [
      B(3, 7), W(3, 3), B(4, 7), W(4, 4), B(5, 7), W(5, 5), B(6, 7), W(9, 9), B(0, 0),
    ])
    const session = makeSession(gobang, state)
    const agent = agentFor(gobang)
    const result = await agent.agentPlay(session, 1)

    assert.equal(result.fallback, undefined, '这不是兜底，而是对模型落点的纠错')
    assert.equal(result.refined, true)
    assert.deepEqual(result.refinedFrom, { x: 0, y: 13 })
    assert.ok(['2,7', '7,7'].includes(`${result.move.x},${result.move.y}`), '必须改成封堵四连')
    assert.equal(statsSnapshot().totals.refinedMoves, 1)
  })

  await t.test('模型自己下对了就不纠错（保留模型的进攻选择）', async () => {
    resetStats()
    model.state.calls = 0
    model.state.behavior = () => ({ content: JSON.stringify({ move: { x: 3, y: 7 }, speech: '堵住' }) })

    // 玩家活三，模型选择封左端 (4,7)；这不是必防点，但对局仍合理
    const state = buildState(gobang, [
      B(5, 7), W(5, 5), B(6, 7), W(6, 6), B(7, 7), W(8, 4), B(0, 0), W(9, 9), B(1, 1),
    ])
    const session = makeSession(gobang, state)
    const agent = agentFor(gobang)
    const result = await agent.agentPlay(session, 1)
    assert.deepEqual(result.move, { x: 3, y: 7 })
    assert.equal(result.refined, undefined)
  })

  await t.test('井字棋：模型漏挡三连时同样被纠正', async () => {
    resetStats()
    model.state.calls = 0
    model.state.behavior = () => ({ content: JSON.stringify({ move: { x: 0, y: 2 }, speech: '占角' }) })

    const state = buildState(ox, [{ seat: 0, x: 0, y: 0 }, { seat: 1, x: 1, y: 0 }, { seat: 0, x: 1, y: 1 }])
    const session = makeSession(ox, state)
    const agent = agentFor(ox)
    const result = await agent.agentPlay(session, 1)
    assert.equal(result.refined, true)
    assert.deepEqual(result.move, { x: 2, y: 2 }, '必须挡住斜线三连')
  })

  await t.test('井字棋：模型走了会输的一手（被双杀）时换成不输的一手', async () => {
    resetStats()
    model.state.calls = 0
    // X 占 (0,0)，O 只剩中心不输：(0,2) 会被 X 抢中心形成双杀
    model.state.behavior = () => ({ content: JSON.stringify({ move: { x: 0, y: 2 }, speech: '占角' }) })

    const state = buildState(ox, [{ seat: 0, x: 0, y: 0 }])
    const session = makeSession(ox, state)
    const agent = agentFor(ox)
    const result = await agent.agentPlay(session, 1)
    assert.equal(result.refined, true)
    assert.deepEqual(result.move, { x: 1, y: 1 }, '必须抢中心，否则会被双杀')
  })

  await t.test('提示词把引擎候选点交给模型', () => {
    const state = buildState(gobang, [
      B(3, 7), W(3, 3), B(4, 7), W(4, 4), B(5, 7), W(5, 5), B(6, 7), W(9, 9), B(0, 0),
    ])
    state.currentSeat = 1
    const session = makeSession(gobang, state)
    const prompt = buildUserPrompt(gobang, session, 1)
    assert.match(prompt, /【本地引擎建议】/)
    assert.match(prompt, /\(2,7\)|\(7,7\)/, '候选项必须给出成五点或必防点')
    assert.match(prompt, /必须封堵/)
    const system = buildSystemPrompt(gobang, { persona: '你是测试 AI。' }, session, 1)
    assert.match(system, /【游戏说明】/, 'Mod 的战术说明必须进入 system prompt')
    assert.match(system, /自己有没有「再落一子就成五」的点/)
  })

  await t.test('推理预算被打满（content 为空）时提高 max_tokens 重试', async () => {
    resetStats()
    model.state.calls = 0
    model.state.seen.length = 0
    model.state.behavior = (payload, call) => {
      if (call === 1) return { content: '', finish: 'length', reasoning: '我需要先把棋盘上的棋型都过一遍……' }
      return { content: '{"move":{"x":7,"y":7},"speech":"好"}' }
    }

    const reply = await chatCompletion([{ role: 'user', content: '请落子' }], {
      baseUrl: process.env.AI_BASE_URL, apiKey: 'stub-key', model: 'stub-model',
      temperature: 0.7, maxTokens: 1024, maxTokensCeiling: 65536, reasoningRetries: 2, timeoutMs: 5000,
    }, { json: true })

    assert.equal(reply.text, '{"move":{"x":7,"y":7},"speech":"好"}')
    assert.equal(model.state.calls, 2, '空回复必须重试一次')
    assert.equal(model.state.seen[0].max_tokens, 1024)
    assert.equal(model.state.seen[1].max_tokens, 2048, '重试时输出预算必须翻倍')
  })
})
