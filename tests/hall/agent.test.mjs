// 大厅核心（lib/）通用回归：Agent 编排器的回合内记忆、失败语义与决策指标。
//
// 这些测试不依赖任何具体桌游，用「本地 stub 模型 + 自造 Mod」验证 lib/ 的行为；
// 真实 HTTP、会话与旧棋盘 Mod 的回归仍然在 games/arkhamhorror/tests/ 里。
//
// 运行：npm run test:hall

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'

import { createAgent, createTurnContext } from '../../lib/agent/orchestrator.js'
import { buildUserPrompt } from '../../lib/agent/prompt.js'
import { parseAgentReply } from '../../lib/agent/decoder.js'
import { resetJsonModeCache } from '../../lib/agent/client.js'
import { estimateTokens } from '../../lib/agent/tokens.js'
import { statsSnapshot, resetStats } from '../../lib/agent/log.js'

// ---------------------------------------------------------------------------
// 测试替身：一个可控的 OpenAI 兼容模型服务
// ---------------------------------------------------------------------------

function startModel() {
  const state = { calls: 0, seen: [], behavior: () => ({ content: '{"move":{"step":1},"speech":"ok"}' }) }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      state.calls++
      let payload = null
      try { payload = JSON.parse(body) } catch { /* 保留 null */ }
      // 防呆：只服务本测试注入的 stub 密钥。若别的配置生效（例如仓库里的真实密钥），
      // 说明隔离失败，必须立刻失败而不是去打真实付费接口。
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
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        choices: [{ message: { content: reply.content } }],
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

const jsonReply = (move, speech = '') => ({ content: JSON.stringify({ move, speech }) })

/** 一个「一个回合需要多步决策」的通用 Mod（模拟诡镇这类行动点游戏）。 */
function multiStepMod(overrides = {}) {
  return {
    id: 'multi-step', name: '多步测试', description: '一个回合需要多次决策的游戏',
    moveFormat: '{"step": 1 或 2}', cooperative: false,
    createState: () => ({ status: 'playing', currentSeat: 1, revision: 0, actionsLeft: 2, done: 0 }),
    decisionSeat: (state) => state.currentSeat,
    describeState: (state) => '局面：已完成 ' + state.done + ' 步，剩余行动 ' + state.actionsLeft,
    legalMoves: (state) => (state.actionsLeft > 0 ? [{ step: 1 }, { step: 2 }] : [{ action: 'end' }]),
    moveToText: (move) => '动作' + (move.step != null ? move.step : move.action),
    validateMove: (state, seat, move) => {
      if (move && move.action === 'end') return state.actionsLeft > 0 ? '还需行动' : null
      if (!move || move.step == null) return '需要 {step}'
      return state.actionsLeft > 0 ? null : '行动点已用完'
    },
    applyMove: () => [],
    ...overrides,
  }
}

function newTurn(seat, modId, sessionId) {
  return createTurnContext(seat, modId, sessionId)
}

function newSession(mod, sessionId) {
  return {
    sessionId, modId: mod.id,
    players: [{ seat: 0, role: 'human', color: 'black' }, { seat: 1, role: 'ai', color: 'white', aiId: 'ai-1' }],
    events: [], state: mod.createState(),
  }
}

/** 模拟大厅提交：推进 revision，并按 Mod 规则推进局面。 */
function commit(session, move) {
  session.state.done += 1
  session.state.actionsLeft -= 1
  session.state.revision += 1
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('agent 通用回归', { timeout: 60000 }, async (t) => {
  const envKeys = ['DSH_HOME', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MAX_RETRIES', 'AI_MAX_TOKENS', 'AI_MAX_TURN_CALLS', 'AI_TIMEOUT_MS']
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  const saved = { ...process.env }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-agent-'))

  // 关键隔离：DSH_HOME 让 lib/agent/config.js 不再读取仓库根目录的 boardgame.config.json
  //（那里可能有真实密钥），同时决策日志落到临时目录。
  process.env.DSH_HOME = home
  process.env.AI_API_KEY = 'stub-key' // 环境变量优先于任何文件配置
  process.env.AI_TIMEOUT_MS = '5000'
  delete process.env.AI_MAX_RETRIES
  delete process.env.AI_MAX_TOKENS
  delete process.env.AI_MAX_TURN_CALLS

  const model = startModel()
  const baseUrl = await model.listen()
  process.env.AI_BASE_URL = baseUrl

  const withEnv = async (patch, run) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try { return await run() } finally {
      for (const [key, value] of Object.entries(patch)) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }

  t.after(async () => {
    await model.close()
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  const agentFor = (mod) => createAgent({
    modById: (id) => (id === mod.id ? mod : null),
    getAi: () => ({ id: 'ai-1', name: '测试 AI', persona: '你是测试 AI。' }),
  })

  const assertLocalOnly = () => {
    assert.equal(model.state.foreignAuth, undefined, '不得使用 stub 之外的凭据（配置隔离失败）')
  }

  await t.test('一个回合内的多步决策共享同一段对话记忆', async () => {
    resetStats()
    model.state.calls = 0
    model.state.seen.length = 0
    // 第 2 次调用故意返回非法 JSON，验证「解析失败 → 反馈 → 重试」发生在同一步内。
    model.state.behavior = (payload, call) => (call === 2 ? { content: '这不是 JSON' } : jsonReply(call === 1 ? { step: 1 } : { step: 2 }, '台词' + call))

    const mod = multiStepMod()
    const agent = agentFor(mod)
    const session = newSession(mod, 'session-memory')
    const turn = newTurn(1, mod.id, session.sessionId)
    const config = agent.getConfig()

    // 第一步
    const first = await agent.agentPlay(session, 1, turn)
    assert.deepEqual(first.move, { step: 1 })
    assert.equal(turn.steps, 1)
    assert.equal(turn.calls, 1)
    commit(session, first.move)

    // 第二步：模型给出非法 JSON → 同一步内重试 → 合法
    const second = await agent.agentPlay(session, 1, turn)
    assert.deepEqual(second.move, { step: 2 })
    assert.equal(turn.steps, 2, '同一个 turn 累计到第二步')
    assert.equal(model.state.calls, 3, '非法输出消耗了一次重试预算')
    assert.ok(config.maxRetries > 1, '默认重试预算必须大于 1 才能覆盖本用例')

    const lastRequest = model.state.seen.at(-1)
    const joined = lastRequest.messages.map((m) => m.content).join('\n')
    assert.equal(joined.includes('【你的回合进度】'), true, '第二步提示词必须含回合进度')
    assert.equal(joined.includes('已经行动过 1 步'), true, '第二步提示词必须说明已行动步数')
    assert.equal(joined.includes('动作1'), true, '第二步提示词必须回显上一手')
    assert.equal(joined.includes('无法解析'), true, '同一步内的解析失败反馈必须留在上下文里')
    assertLocalOnly()

    // 回合结束时必须结算，用于统计「每回合步数」
    agent.endTurn(turn)
    const stats = statsSnapshot()
    assert.equal(stats.byMod[mod.id].turns, 1)
    assert.equal(stats.byMod[mod.id].avgStepsPerTurn, 2)
    agent.endTurn(turn)
    assert.equal(statsSnapshot().byMod[mod.id].turns, 1, 'endTurn 必须幂等')

    // 记忆是「回合内」的：新建的回合上下文不得带上一个回合的历史
    model.state.seen.length = 0
    const freshTurn = newTurn(1, mod.id, session.sessionId)
    session.state.currentSeat = 1
    const third = await agent.agentPlay(session, 1, freshTurn)
    assert.ok(third.move)
    assert.equal(freshTurn.steps, 1, '新回合上下文从零开始计数')
    const freshRequest = model.state.seen.at(-1).messages.map((m) => m.content).join('\n')
    assert.equal(freshRequest.includes('已经行动过'), false, '新回合不得继承上一个回合的进度')
    assert.equal(freshRequest.includes('动作1'), false, '新回合不得继承上一个回合的历史')
  })

  await t.test('提示词剪枝：长回合不会让请求无限增长，且明确标注省略', async () => {
    resetStats()
    model.state.calls = 0
    model.state.seen.length = 0
    model.state.behavior = (payload, call) => jsonReply({ step: call % 2 ? 1 : 2 }, '台词')

    const mod = multiStepMod({ createState: () => ({ status: 'playing', currentSeat: 1, revision: 0, actionsLeft: 9, done: 0 }) })
    const agent = agentFor(mod)
    const session = newSession(mod, 'session-prune')
    const turn = newTurn(1, mod.id, session.sessionId)

    let maxMessages = 0
    for (let i = 0; i < 6; i++) {
      const result = await agent.agentPlay(session, 1, turn)
      assert.ok(result.move, '第 ' + i + ' 步必须给出行动')
      commit(session, result.move)
      maxMessages = Math.max(maxMessages, model.state.seen.at(-1).messages.length)
    }
    assert.equal(turn.steps, 6)
    assert.ok(maxMessages <= 8, '对话体必须被剪枝（实际最大 ' + maxMessages + ' 条消息）')
    const joined = model.state.seen.at(-1).messages.map((m) => m.content).join('\n')
    assert.equal(joined.includes('已省略'), true, '剪枝必须显式标注，避免模型误以为没有历史')
    assert.equal(joined.includes('【你的回合进度】'), true)
    assert.equal(joined.includes('已经行动过 5 步'), true)
  })

  await t.test('重试耗尽后兜底：确定性、可复现，且不走首选项', async () => {
    resetStats()
    model.state.calls = 0
    await withEnv({ AI_MAX_RETRIES: '1' }, async () => {
      model.state.behavior = () => jsonReply({ bad: true }, '乱来')

      const mod = multiStepMod({ legalMoves: () => [{ step: 2 }, { step: 1 }] })
      const agent = agentFor(mod)
      const session = newSession(mod, 'session-fallback')
      const first = await agent.agentPlay(session, 1)
      assert.equal(first.fallback, true)
      assert.equal(first.reason, 'retries-exhausted')
      assert.equal(model.state.calls, 1, '重试预算为 1 时只调用一次模型')

      // 同一 sessionId + 同一步 → 同一兜底选择（可复现，便于回放与回归）
      const repeat = await agent.agentPlay(newSession(mod, 'session-fallback'), 1)
      assert.deepEqual(repeat.move, first.move, '兜底必须可复现')

      // 不同 sessionId 的兜底起点应当分布开，而不是恒定选 legalMoves[0]
      const others = new Set()
      for (let i = 0; i < 12; i++) {
        const pick = await agent.agentPlay(newSession(mod, 'session-fallback-' + i), 1)
        others.add(JSON.stringify(pick.move))
      }
      assert.ok(others.size > 1, '不同对局的兜底不应恒为首个候选（实际 ' + [...others].join(',') + '）')
    })
    assertLocalOnly()
  })

  await t.test('legalMoves 无一合法时明确失败，不再静默返回 null', async () => {
    resetStats()
    await withEnv({ AI_MAX_RETRIES: '1' }, async () => {
      model.state.behavior = () => jsonReply({ bad: true })
      const mod = multiStepMod({
        legalMoves: () => [{ step: 1 }, null],
        validateMove: () => '全部不合法',
      })
      const agent = agentFor(mod)
      const result = await agent.agentPlay(newSession(mod, 'session-stall'), 1)
      assert.equal(result.move, null)
      assert.equal(result.stalled, true)
      assert.equal(result.reason, 'no-legal-fallback')
      assert.match(result.error, /没有任何合法动作/)
    })
    assertLocalOnly()
  })

  await t.test('单回合模型调用预算（maxTurnCalls）超限时中止并给出原因', async () => {
    resetStats()
    await withEnv({ AI_MAX_TURN_CALLS: '2' }, async () => {
      model.state.calls = 0
      model.state.behavior = () => jsonReply({ bad: true })
      const mod = multiStepMod()
      const agent = agentFor(mod)
      const session = newSession(mod, 'session-budget')
      const turn = newTurn(1, mod.id, session.sessionId)
      await agent.agentPlay(session, 1, turn)
      const result = await agent.agentPlay(session, 1, turn)
      assert.equal(result.stalled, true)
      assert.equal(result.reason, 'turn-budget')
      assert.match(result.error, /上限/)
      assert.equal(model.state.calls, 2, '不得超过单回合调用预算')
    })
    assertLocalOnly()
  })

  await t.test('无模型（未配置 apiKey）时仍能兜底行动且不调用网络', async () => {
    resetStats()
    model.state.calls = 0
    const agent = createAgent({
      modById: () => multiStepMod(),
      getAi: () => ({ id: 'ai-1', name: '测试 AI' }),
      getConfig: () => ({ apiKey: '', model: 'none', baseUrl, temperature: 0, maxRetries: 3, timeoutMs: 1000, maxTokens: 0, maxTurnCalls: 24 }),
    })
    const mod = multiStepMod()
    const result = await agent.agentPlay(newSession(mod, 'session-nokey'), 1)
    assert.ok(result.move, '未配置模型时也必须给出合法行动')
    assert.equal(result.fallback, true)
    assert.equal(result.reason, 'no-model')
    assert.equal(result.speech, '', '无模型时不产生台词')
    assert.equal(model.state.calls, 0, '未配置模型时不得发起网络请求')
    const stats = statsSnapshot()
    assert.equal(stats.totals.noKeyFallback, 1)
  })

  await t.test('决策指标可聚合：非法率、兜底率、提示词长度与每回合步数', async () => {
    resetStats()
    // 单步重试预算 2：第一步「非法 → 合法」用 2 次调用，第二步「非法 → 非法 → 兜底」用 2 次调用。
    await withEnv({ AI_MAX_RETRIES: '2' }, async () => {
      model.state.calls = 0
      let call = 0
      model.state.behavior = () => {
        call++
        if (call === 1) return jsonReply({ bad: true }, '非法')
        if (call === 2) return jsonReply({ step: 2 }, '合法')
        return jsonReply({ bad: true })
      }
      const mod = multiStepMod()
      const agent = agentFor(mod)
      const session = newSession(mod, 'session-stats')
      const turn = newTurn(1, mod.id, session.sessionId)
      // 第一步：非法 → 重试 → 合法
      const ok = await agent.agentPlay(session, 1, turn)
      assert.deepEqual(ok.move, { step: 2 })
      commit(session, ok.move)
      // 第二步：非法 → 重试耗尽 → 兜底
      const fb = await agent.agentPlay(session, 1, turn)
      assert.equal(fb.fallback, true)

      // 回合结束由大厅结算（runAiTurns 在座位切换/收尾时调用）
      agent.endTurn(turn)

      const stats = statsSnapshot()
      assert.equal(stats.totals.calls, 5, '五次模型调用：第一步 2 次（非法→合法）+ 第二步 2 次非法后兜底（不额外调用）')
      assert.equal(turn.steps, 2)
      agent.endTurn(turn)
      assert.equal(stats.totals.validateError, 3)
      assert.equal(stats.totals.ok, 1)
      assert.equal(stats.totals.fallback, 1)
      assert.equal(stats.totals.illegalRate, 0.6)
      assert.equal(stats.totals.fallbackRate, 0.2)
      assert.ok(stats.totals.avgPromptChars > 0, '必须统计提示词长度')
      assert.equal(stats.totals.promptTokens, 40, '必须累计 token 用量')
      assert.equal(stats.byMod[mod.id].calls, 5)
      assert.equal(stats.byMod[mod.id].turns, 1)
      assert.equal(stats.byMod[mod.id].avgStepsPerTurn, 2)
      assert.equal(model.state.seen.every((payload) => payload.max_tokens === 10000), true, '必须下发 max_tokens')
      assert.equal(model.state.seen.at(-1).messages.length <= 8, true, '请求消息数必须受限')

      const logFile = path.join(home, 'boardgame-hall', 'decisions.jsonl')
      assert.equal(fs.existsSync(logFile), true, '必须落盘 decisions.jsonl')
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      assert.ok(lines.length > 0)
      assert.equal(lines.every((entry) => typeof entry.ts === 'string' && entry.modId === mod.id), true)
      assert.equal(lines.some((entry) => entry.outcome === 'validateError' && entry.replyExcerpt), true, '非法输出必须留证据')
      assert.equal(lines.some((entry) => entry.outcome === 'fallback' && entry.legalMoves === 2), true, '兜底必须记录候选数与选中项')
      assert.equal(lines.some((entry) => entry.kind === 'turn' && entry.steps === 2), true, '必须记录回合结束与步数')
      const serialized = JSON.stringify(lines)
      assert.equal(serialized.includes('stub-key'), false, '日志不得包含密钥')
      assert.equal(serialized.includes('Bearer'), false, '日志不得包含鉴权头')
    })
    assertLocalOnly()
  })

  await t.test('采样参数与结构化输出：真正下发，且 auto 模式优先用 response_format', async () => {
    await withEnv({ AI_MAX_RETRIES: '1' }, async () => {
      resetJsonModeCache()
      model.state.calls = 0
      model.state.seen.length = 0
      model.state.behavior = () => jsonReply({ step: 1 }, 'ok')

      const mod = multiStepMod()
      const agent = agentFor(mod)

      // 默认 topP=0：不下发 top_p（避免被后端解读为"只取最大概率"）
      await agent.agentPlay(newSession(mod, 'session-topp-default'), 1)
      assert.equal('top_p' in model.state.seen.at(-1), false, 'topP 未配置时不得下发 top_p')
      assert.deepEqual(model.state.seen.at(-1).response_format, { type: 'json_object' }, 'auto 模式应优先下发 response_format')

      // 配置 topP 后必须真的写进请求体（此前是死配置）
      agent.getConfig().topP = 0.42
      await agent.agentPlay(newSession(mod, 'session-topp-set'), 1)
      assert.equal(model.state.seen.at(-1).top_p, 0.42, 'topP 配置必须真正写入请求体')
      assertLocalOnly()
    })
  })

  await t.test('response_format 不被支持时自动降级，且同一后端只踩一次坑', async () => {
    await withEnv({ AI_MAX_RETRIES: '1' }, async () => {
      resetJsonModeCache()
      model.state.calls = 0
      model.state.seen.length = 0
      let withJson = 0
      let withoutJson = 0
      model.state.behavior = (payload) => {
        if (payload && payload.response_format) {
          withJson++
          return { status: 400, body: JSON.stringify({ error: { message: 'response_format is not supported' } }) }
        }
        withoutJson++
        return jsonReply({ step: 1 }, '降级成功')
      }

      const mod = multiStepMod()
      const agent = agentFor(mod)
      const first = await agent.agentPlay(newSession(mod, 'session-json-1'), 1)
      assert.ok(first.move, '降级后仍必须拿到合法行动')
      assert.equal(withJson, 1, '第一次应先尝试 response_format')
      assert.equal(withoutJson, 1, '不支持时应自动重试一次不带 response_format')

      const second = await agent.agentPlay(newSession(mod, 'session-json-2'), 1)
      assert.ok(second.move)
      assert.equal(withJson, 1, '同一 baseUrl+model 不应反复下发已知不支持的参数')
      assert.equal(withoutJson, 2)
      assertLocalOnly()
    })
  })

  await t.test('提示词 token 预算：超出时剪掉更早的对话并计入 overBudget', async () => {
    resetStats()
    model.state.calls = 0
    model.state.seen.length = 0
    model.state.behavior = () => jsonReply({ step: 1 }, '台词')
    const mod = multiStepMod({ createState: () => ({ status: 'playing', currentSeat: 1, revision: 0, actionsLeft: 9, done: 0 }) })
    const agent = agentFor(mod)

    // 预算充足：不剪枝、不报 overBudget
    await withEnv({ AI_MAX_PROMPT_TOKENS: '20000', AI_MAX_RETRIES: '1' }, async () => {
      const session = newSession(mod, 'session-tokens-loose')
      const turn = newTurn(1, mod.id, session.sessionId)
      for (let i = 0; i < 3; i++) { const r = await agent.agentPlay(session, 1, turn); commit(session, r.move) }
      const messages = model.state.seen.at(-1).messages
      assert.equal(messages.some((m) => typeof m.content === 'string' && m.content.includes('已省略')), false, '预算充足时不应剪枝')
    })
    assert.equal(statsSnapshot().totals.overBudget, 0, '预算充足时 overBudget 必须为 0')

    // 预算极小：系统提示本身已超预算 → 只保留最后一条 user，并标记 overBudget
    await withEnv({ AI_MAX_PROMPT_TOKENS: '200', AI_MAX_RETRIES: '1' }, async () => {
      const session = newSession(mod, 'session-tokens-tight')
      const turn = newTurn(1, mod.id, session.sessionId)
      for (let i = 0; i < 3; i++) { const r = await agent.agentPlay(session, 1, turn); commit(session, r.move) }
      const messages = model.state.seen.at(-1).messages
      assert.ok(messages.length <= 3, '超预算时必须把对话剪到只剩最后一条（实际 ' + messages.length + ' 条）')
      assert.equal(estimateTokens(messages.map((m) => m.content).join('\n')) > 0, true)
    })
    const stats = statsSnapshot()
    assert.ok(stats.totals.promptTokensEst > 0, '必须累计估算 token')
    assert.ok(stats.totals.avgPromptTokensEst > 0)
    assert.ok(stats.totals.overBudget > 0, '极小预算必须计入 overBudget')
    assert.ok(stats.totals.overBudgetRate > 0)
    assert.ok(stats.byMod[mod.id].overBudget > 0, 'overBudget 必须按 Mod 分桶')
    assertLocalOnly()

    const logged = fs.readFileSync(path.join(home, 'boardgame-hall', 'decisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(logged.some((entry) => Number.isFinite(entry.promptTokensEst) && entry.promptTokensEst > 0), true, '日志必须记录估算 token')
    assert.equal(logged.some((entry) => entry.promptOverBudget === true), true, '日志必须记录是否超预算')
  })

  await t.test('默认预算常量：128K 提示词 / 120s 单回合 / 2 步记忆窗口', async () => {
    await withEnv({ AI_MAX_PROMPT_TOKENS: undefined, AI_TURN_TIMEOUT_MS: undefined, AI_MEMORY_STEPS: undefined }, async () => {
      const config = agentFor(multiStepMod()).getConfig()
      assert.equal(config.maxPromptTokens, 131072, '提示词预算默认应为 131072（128K）')
      assert.equal(config.turnTimeoutMs, 120000, '单回合墙钟预算默认应为 120s')
      assert.equal(config.memorySteps, 2, '回合内记忆窗口默认应为 2 步（行为与历史版本一致）')
    })
  })

  await t.test('AI_MEMORY_STEPS：回合内记忆窗口可调，默认不变', async () => {
    resetStats()
    model.state.seen.length = 0
    model.state.behavior = () => jsonReply({ step: 1 }, '台词')
    const mod = multiStepMod({ createState: () => ({ status: 'playing', currentSeat: 1, revision: 0, actionsLeft: 9, done: 0 }) })
    const agent = agentFor(mod)

    // 跑满 6 步，记录请求里最多的消息条数（system + 剪枝后的对话体 + 省略说明）
    const runTurn = async (sessionId) => {
      const session = newSession(mod, sessionId)
      const turn = newTurn(1, mod.id, session.sessionId)
      let maxMessages = 0
      for (let i = 0; i < 6; i++) {
        const result = await agent.agentPlay(session, 1, turn)
        assert.ok(result.move, '第 ' + i + ' 步必须给出行动')
        commit(session, result.move)
        maxMessages = Math.max(maxMessages, model.state.seen.at(-1).messages.length)
      }
      agent.endTurn(turn)
      return maxMessages
    }

    let narrow = 0
    let wide = 0
    await withEnv({ AI_MEMORY_STEPS: '1' }, async () => { narrow = await runTurn('session-window-1') })
    await withEnv({ AI_MEMORY_STEPS: '4' }, async () => { wide = await runTurn('session-window-4') })

    assert.ok(wide > narrow, '调大记忆窗口必须保留更多对话（window=1 -> ' + narrow + '，window=4 -> ' + wide + '）')
    assert.ok(narrow <= 6, '窗口 1 步：最多 4 条对话 + system + 省略说明（实际 ' + narrow + '）')
    assert.ok(wide <= 12, '窗口 4 步：最多 10 条对话 + system + 省略说明（实际 ' + wide + '）')
    assert.ok(wide >= 9, '窗口 4 步必须真的多带历史（实际 ' + wide + '）')

    // 非法/边界值：不得抛错，且必须归一化到合法窗口
    await withEnv({ AI_MEMORY_STEPS: '0' }, async () => {
      assert.equal(agentFor(mod).getConfig().memorySteps, 1, '<=0 归一化为 1（至少保留当前步）')
    })
    await withEnv({ AI_MEMORY_STEPS: 'abc' }, async () => {
      assert.equal(agentFor(mod).getConfig().memorySteps, 2, '非法值回落默认 2')
    })

    // 决策日志里要能看到本次用了多大的窗口
    const logged = fs.readFileSync(path.join(home, 'boardgame-hall', 'decisions.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(logged.some((entry) => entry.memorySteps === 4), true, '日志必须记录记忆窗口')
    assertLocalOnly()
  })

  await t.test('回合墙钟预算：超时中止并给出明确原因', async () => {
    resetStats()
    await withEnv({ AI_TURN_TIMEOUT_MS: '600', AI_TIMEOUT_MS: '5000' }, async () => {
      model.state.calls = 0
      model.state.behavior = async () => { await new Promise((r) => setTimeout(r, 300)); return jsonReply({ step: 1 }, '慢') }
      const mod = multiStepMod({ createState: () => ({ status: 'playing', currentSeat: 1, revision: 0, actionsLeft: 9, done: 0 }) })
      const agent = agentFor(mod)
      const session = newSession(mod, 'session-turn-timeout')
      const turn = newTurn(1, mod.id, session.sessionId)

      let result = null
      for (let i = 0; i < 6; i++) {
        result = await agent.agentPlay(session, 1, turn)
        if (!result.move || result.stalled) break
        commit(session, result.move)
      }
      assert.equal(result.stalled, true, '超过墙钟预算必须中止该回合')
      assert.equal(result.reason, 'turn-timeout')
      assert.match(result.error, /墙钟预算/)
      assertLocalOnly()
    })
    assert.equal(statsSnapshot().totals.turnTimeouts, 1, '必须计入 turnTimeouts')
  })

  await t.test('确定性兜底不会顺手「结束回合」', async () => {
    resetStats()
    await withEnv({ AI_MAX_RETRIES: '1' }, async () => {
      model.state.behavior = () => jsonReply({ bad: true }, '乱来')
      const mod = multiStepMod({
        legalMoves: () => [{ action: 'endTurn', label: '⏹ 结束回合' }, { step: 1 }, { step: 2 }],
        // 结束型动作本身是合法的：只有「候选排序」能把它挡在兜底之外。
        validateMove: (state, seat, move) => (move && (move.step != null || move.action === 'endTurn') ? null : '非法动作'),
      })
      const agent = agentFor(mod)
      const picked = new Set()
      for (let i = 0; i < 9; i++) {
        const result = await agent.agentPlay(newSession(mod, 'session-terminal-' + i), 1)
        assert.equal(result.fallback, true)
        assert.ok(result.move, '必须给出兜底动作')
        assert.notEqual(result.move.action, 'endTurn', '兜底不得选择结束型动作（实际 ' + JSON.stringify(result.move) + '）')
        picked.add(JSON.stringify(result.move))
      }
      assert.ok(picked.size > 1, '兜底仍应保持确定性伪随机的分散性')
      assertLocalOnly()
    })

    // 只剩结束型动作时，仍然要给出动作而不是直接 stalled
    await withEnv({ AI_MAX_RETRIES: '1' }, async () => {
      model.state.behavior = () => jsonReply({ bad: true }, '乱来')
      const only = multiStepMod({
        legalMoves: () => [{ action: 'endTurn', label: '结束回合' }],
        validateMove: (state, seat, move) => (move && move.action === 'endTurn' ? null : '非法动作'),
      })
      const result = await agentFor(only).agentPlay(newSession(only, 'session-terminal-only'), 1)
      assert.equal(result.fallback, true)
      assert.deepEqual(result.move, { action: 'endTurn', label: '结束回合' })
      assertLocalOnly()
    })
  })

  await t.test('提示词与解码的边界行为', () => {
    const mod = multiStepMod()
    const session = newSession(mod, 'session-prompt')
    const prompt = buildUserPrompt(mod, session, 1, { step: 2, alreadyActed: 1, lastMoveText: '动作1' })
    assert.equal(prompt.includes('【当前局面】'), true)
    assert.equal(prompt.includes('【你的回合进度】'), true)
    assert.equal(prompt.includes('已经行动过 1 步'), true)
    assert.equal(prompt.includes('动作1'), true)

    // 不开回合进度时（旧调用方式）仍能正常生成
    const legacy = buildUserPrompt(mod, session, 1)
    assert.equal(legacy.includes('【你的回合进度】'), false)
    assert.equal(legacy.includes('【当前局面】'), true)

    assert.deepEqual(parseAgentReply('```json\n{"move":{"a":1},"speech":" hi "}\n```'), { move: { a: 1 }, speech: 'hi' })
    assert.equal(parseAgentReply('').error, '输出为空')
    assert.ok(parseAgentReply('没有 JSON').error)
    assert.ok(parseAgentReply('[1,2]').error)
    assert.ok(parseAgentReply('{"speech":"无 move"}').error)
  })
})
