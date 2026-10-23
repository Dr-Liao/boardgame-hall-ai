// P2.2：AI 回合与回包解耦（后台 AI + aiPending + agentError + 重启恢复）。
//
// 覆盖点：
//   1. 假模型延迟 3s：人类动作命令 200ms 内返回 aiPending/busy=true，AI 完成后 busy=false，
//      最终状态与 BOARDGAME_ONLINE_AI_BACKGROUND=0 的同步旧路径一致；
//   2. AI 失败：session.events 追加 agentError，busy 一定清理，status 可感知；旧 aiRetry 仍可用；
//   3. 双击/并发：AI 后台运行期间第二个 move 返回 SESSION_BUSY；同一 operationId 重放回放第一次
//      的 aiPending 响应且不重复调用模型；
//   4. start 先手 AI：start 立即返回 aiPending，后台完成后状态正确；
//   5. 重启恢复：存档 pendingAi 标记被持久化，新进程恢复后从最新 revision 继续，不重复提交已完成动作；
//   6. 回滚开关：BOARDGAME_ONLINE_AI_BACKGROUND=0 时命令仍等 AI 跑完（旧行为）；
//   7. guest 大厅经快照/status 感知 aiPending，AI 思考期间客人仍可聊天，下一步行动被服务器拒绝。
//
// 测试用自造 Mod + 本地 stub 模型（AI_BASE_URL/AI_API_KEY 注入，DSH_HOME 隔离真实配置）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRelay } from '../../relay/server.js'
import { createServer } from '../../lib/server.js'
import { snapshotPath } from '../../lib/sessions.js'
import { createOnlineUI } from '../../public/online-ui.js'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(resolve => { server.stopRelay?.(); server.online?.close(); server.closeAllConnections(); server.close(resolve) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 12000, label = '条件') {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(20)
  }
  throw new Error('等待' + label + '超时（' + timeout + 'ms）')
}

// ---------------------------------------------------------------------------
// 测试替身：可控的 OpenAI 兼容模型服务
// ---------------------------------------------------------------------------
function startModel() {
  const state = {
    calls: 0,
    seen: [],
    behavior: () => ({ content: JSON.stringify({ move: { action: 'step' }, speech: '' }) }),
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      state.calls++
      let payload = null
      try { payload = JSON.parse(body) } catch { /* 保留 null */ }
      // 防呆：只服务本测试注入的 stub 密钥，避免配置隔离失败时打到真实接口。
      if (String(req.headers.authorization || '') !== 'Bearer stub-key') {
        res.writeHead(500)
        res.end('refusing non-stub credential')
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
      res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'stub-model' }))
    })
  })
  return {
    state,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port))),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}

const MODEL_STEP = JSON.stringify({ move: { action: 'step' }, speech: '' })
const MODEL_CHAT = JSON.stringify({ reply: '收到。', memory: { add: [], update: [], remove: [] } })
const isChatPrompt = payload => String(payload?.messages?.[0]?.content || '').includes('【讨论规则】')

// ---------------------------------------------------------------------------
// 测试用 Mod：回合制「人类 0 / AI 递增座位」，状态确定、可复现。
// aiStalled=true 时 AI 座位的候选动作全部非法：模型输出、重试与兜底都拿不到合法动作，
// runAiTurns 会以 AGENT_STALLED 失败（用来验证 agentError 路径）。
// ---------------------------------------------------------------------------
const RULES_VERSION = 'ai-background-test-1'
function aiBackgroundMod({ id = 'ai-bg', aiStalled = false } = {}) {
  return {
    id, name: '后台 AI 测试', description: 'P2.2 后台 AI 回合回归专用 Mod',
    players: [1, 4], seats: 4, cooperative: true, hideOpponentSettings: true,
    coverEmoji: '🤖', tags: ['测试'],
    render: { kind: 'board', size: 3, pieceStyle: 'stone' },
    defaults: { seed: 'ai-background' }, settingsSpec: [],
    moveFormat: '{"action":"step"}',
    moveToText: move => '行动' + (move?.action ? ':' + move.action : ''),
    describeState: state => `已完成 ${state.done} 步，现在轮到座位 ${state.currentSeat}`,
    createState(settings, players) {
      return {
        status: 'playing', currentSeat: settings?.firstSeat === 1 ? 1 : 0,
        revision: 0, done: 0, moveCount: 0, seatCount: players.length,
        rulesVersion: RULES_VERSION,
      }
    },
    decisionSeat: state => (state.status === 'playing' ? state.currentSeat : null),
    actingSeats: state => (state.status === 'playing' ? [state.currentSeat] : []),
    legalMoves(state, seat) {
      if (state.currentSeat !== seat) return []
      // 失败夹具：AI 座位只有非法候选，兜底也选不出合法动作 → no-legal-fallback。
      if (aiStalled && seat !== 0) return [{ action: 'impossible' }]
      return [{ action: 'step' }]
    },
    validateMove(state, seat, move) {
      if (state.status !== 'playing') return '对局已结束'
      if (state.currentSeat !== seat) return '还没轮到这个席位'
      if (move?.action === 'step') return aiStalled && seat !== 0 ? 'AI 不能行动' : null
      return '未知动作'
    },
    applyMove(state, seat) {
      state.moveCount++
      state.done++
      state.currentSeat = (seat + 1) % state.seatCount
      return [{ type: 'move', seat, move: { action: 'step' } }]
    },
    saveCompatibilityFromState: true,
    saveCompatibilityError: state => (state?.rulesVersion === RULES_VERSION ? null : '后台 AI 测试规则版本不兼容'),
  }
}

// ---------------------------------------------------------------------------
// 环境隔离 + 大厅 fixture
// ---------------------------------------------------------------------------
const AI_ENV_KEYS = [
  'DSH_HOME', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_JSON_MODE', 'AI_TIMEOUT_MS',
  'AI_TURN_TIMEOUT_MS', 'AI_MAX_RETRIES', 'AI_MAX_TURN_CALLS', 'AI_CHAT_ENABLED', 'AI_CHAT_REPLY_COOLDOWN_MS',
  'BOARDGAME_ONLINE_AI_BACKGROUND', 'BOARDGAME_ONLINE_BUSY', 'BOARDGAME_ONLINE_COALESCE', 'BOARDGAME_PERSIST',
]

/** 清掉外部环境里的 AI 配置（真实密钥/真实模型），让每个用例自行注入。 */
function isolateEnv(t) {
  const saved = {}
  for (const key of AI_ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key] }
  t.after(() => {
    for (const key of AI_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  return saved
}

async function fixture(t, { mods, count = 1, persist = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-ai-background-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const relay = createRelay({ secret: 'ai-background-test-secret' })
  const relayUrl = await listen(relay)
  const halls = []
  for (let i = 0; i < count; i++) {
    const server = createServer({ mods, persist: persist && i === 0 })
    await server.ready
    const origin = await listen(server)
    const call = async (route, body) => {
      const response = await fetch(origin + '/api/online/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      return response.json()
    }
    halls.push({ server, origin, call, command: (action, body = {}) => call('command', { action, body: { operationId: randomUUID(), ...body } }) })
  }
  t.after(async () => {
    for (const hall of halls) await stop(hall.server)
    await stop(relay)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { halls, relay, relayUrl, home }
}

async function createAiRoom(halls, relayUrl, { mod, capacity = 2, fillAi = true, firstSeat = 0, aiSeats = null, settings = {} } = {}) {
  const body = {
    relayUrl, modId: mod.id, capacity, fillAi,
    settings: { firstSeat, ...settings },
    ...(aiSeats ? { aiSeats } : {}),
  }
  const created = await halls[0].call('create', body)
  assert.equal(created.ok, true, created.error)
  return created
}

async function idleStatus(hall, timeout = 15000) {
  return waitFor(async () => {
    const status = await hall.call('status')
    return status && status.busy === false && status.aiPending === false ? status : null
  }, timeout, '大厅空闲（busy/aiPending=false）')
}

// ---------------------------------------------------------------------------
// 1. 延迟 3s：命令 200ms 内确认，最终状态与同步旧路径一致
// ---------------------------------------------------------------------------
test('3s 模型延迟下人类动作 200ms 内返回 aiPending，AI 完成后状态与同步旧路径一致', { timeout: 90000 }, async t => {
  isolateEnv(t)
  const model = startModel()
  const baseUrl = await model.listen()
  let actionDelayMs = 3000
  model.state.behavior = async (payload) => {
    if (isChatPrompt(payload)) return { content: MODEL_CHAT }
    await sleep(actionDelayMs)
    return { content: MODEL_STEP }
  }
  const mod = aiBackgroundMod()
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_BASE_URL = baseUrl
  process.env.AI_MODEL = 'stub'
  process.env.AI_JSON_MODE = 'off'
  process.env.AI_TIMEOUT_MS = '20000'
  process.env.AI_TURN_TIMEOUT_MS = '40000'
  process.env.AI_CHAT_REPLY_COOLDOWN_MS = '0'
  process.env.AI_MAX_RETRIES = '2'

  const bg = await fixture(t, { mods: [mod], count: 1, persist: true })
  t.after(async () => { await model.close() })
  const [host] = bg.halls
  await createAiRoom(bg.halls, bg.relayUrl, { mod, capacity: 2, firstSeat: 0 })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  assert.equal(started.aiPending, undefined, '人类先手时开局不需要后台 AI')
  const humanRevision = started.session.state.revision

  // —— 人类动作：立即回包，不等 3s 模型 ——
  const began = performance.now()
  const moved = await host.command('move', { revision: humanRevision, move: { action: 'step' } })
  const elapsed = performance.now() - began
  t.diagnostic(`3s 模型延迟：人类动作命令返回 ${elapsed.toFixed(1)}ms（旧同步路径约 3000ms+）`)
  assert.equal(moved.ok, true, moved.error)
  assert.equal(moved.aiPending, true)
  assert.equal(moved.busy, true)
  assert.ok(moved.session, '房主响应仍带自己的完整视图')
  assert.equal(moved.session.state.revision, humanRevision + 1, '人类动作在响应前已提交')
  assert.equal(moved.session.state.currentSeat, 1)
  assert.ok(elapsed < 500, '命令不得等待模型（实测 ' + elapsed.toFixed(1) + 'ms）')

  const pending = await host.call('status')
  assert.equal(pending.busy, true, 'AI 后台运行期间 busy 保持 true')
  assert.equal(pending.aiPending, true)
  assert.equal(pending.session.state.revision, humanRevision + 1)
  const savedWhilePending = JSON.parse(fs.readFileSync(snapshotPath(pending.session.sessionId), 'utf8'))
  assert.equal(savedWhilePending.session.pendingAi, true, 'pendingAi 标记必须随存档落盘（重启恢复依据）')

  // —— AI 思考期间：聊天允许、下一步行动拒绝 ——
  const chat = await host.command('chat', { text: 'AI 思考期间继续讨论战术' })
  assert.equal(chat.ok, true, chat.error)
  assert.equal(chat.session.events.some(event => event.type === 'chat' && event.seat === 0), true)
  const blocked = await host.command('move', { revision: humanRevision + 1, move: { action: 'step' } })
  assert.equal(blocked.ok, false, 'AI 后台运行期间不得推进下一步行动')
  assert.equal(blocked.code, 'SESSION_BUSY')
  assert.match(String(blocked.error), /正在处理上一操作/)

  // —— AI 完成：busy 清理、事件完整、最终状态 ——
  const finalStatus = await waitFor(async () => {
    const status = await host.call('status')
    return status.busy === false && status.aiPending === false && status.session?.state.revision === humanRevision + 2
      ? status : null
  }, 20000, '后台 AI 回合完成')
  const finalSession = finalStatus.session
  assert.equal(finalStatus.busy, false)
  assert.equal(finalStatus.aiPending, false)
  assert.equal(finalSession.state.currentSeat, 0, 'AI 走完后回到人类回合')
  assert.deepEqual(finalSession.events.map(event => event.seq), finalSession.events.map((_, index) => index),
    'events.seq 必须连续，客户端才能按序回放 AI 动作')
  assert.equal(finalSession.events.filter(event => event.type === 'move' && event.seat === 1).length, 1)
  assert.equal(finalSession.events.filter(event => event.type === 'agentError').length, 0)
  const savedFinal = JSON.parse(fs.readFileSync(snapshotPath(finalSession.sessionId), 'utf8'))
  assert.ok(!savedFinal.session.pendingAi, 'AI 完成后 pendingAi 标记必须清除并落盘')
  assert.equal(savedFinal.session.state.revision, humanRevision + 2)

  // —— 同步旧路径对照：BOARDGAME_ONLINE_AI_BACKGROUND=0 等 AI 跑完再返回，最终状态一致 ——
  actionDelayMs = 0
  process.env.BOARDGAME_ONLINE_AI_BACKGROUND = '0'
  const sync = await fixture(t, { mods: [mod], count: 1, persist: false })
  const [syncHost] = sync.halls
  await createAiRoom(sync.halls, sync.relayUrl, { mod, capacity: 2, firstSeat: 0 })
  const syncStart = await syncHost.command('start')
  assert.equal(syncStart.ok, true, syncStart.error)
  const syncMove = await syncHost.command('move', { revision: syncStart.session.state.revision, move: { action: 'step' } })
  assert.equal(syncMove.ok, true, syncMove.error)
  assert.equal(syncMove.aiPending, undefined, '回滚开关关闭后不再返回 aiPending')
  assert.equal(syncMove.session.state.revision, humanRevision + 2, '同步旧路径在响应前已跑完 AI')
  assert.deepEqual(syncMove.session.state, finalSession.state, '后台路径最终状态必须与同步旧路径一致')
  assert.deepEqual(syncMove.session.events.filter(event => event.type === 'move').map(event => event.seat), [0, 1])
  assert.equal((await syncHost.call('status')).busy, false)
})

// ---------------------------------------------------------------------------
// 2. AI 失败：agentError + busy 清理 + status 可感知 + 旧 aiRetry 仍可用
// ---------------------------------------------------------------------------
test('AI 失败追加 agentError、清理 busy，status 可感知，aiRetry 仍可重试', { timeout: 60000 }, async t => {
  isolateEnv(t)
  const model = startModel()
  const baseUrl = await model.listen()
  model.state.behavior = async (payload) => ({ content: isChatPrompt(payload) ? MODEL_CHAT : MODEL_STEP })
  const mod = aiBackgroundMod({ aiStalled: true })
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_BASE_URL = baseUrl
  process.env.AI_MODEL = 'stub'
  process.env.AI_JSON_MODE = 'off'
  process.env.AI_TIMEOUT_MS = '8000'
  process.env.AI_MAX_RETRIES = '1'
  process.env.AI_CHAT_REPLY_COOLDOWN_MS = '0'

  const { halls: [host], relayUrl } = await fixture(t, { mods: [mod], count: 1, persist: true })
  t.after(async () => { await model.close() })
  await createAiRoom([host], relayUrl, { mod, capacity: 2, firstSeat: 0 })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const humanRevision = started.session.state.revision
  const moved = await host.command('move', { revision: humanRevision, move: { action: 'step' } })
  assert.equal(moved.ok, true, moved.error, 'AI 失败不得改变已返回的命令响应')
  assert.equal(moved.aiPending, true)

  const failed = await idleStatus(host)
  assert.equal(failed.busy, false, '失败路径 busy 必须清理')
  assert.equal(failed.aiPending, false)
  assert.equal(failed.session.state.revision, humanRevision + 1, 'AI 失败不推进 revision')
  const agentErrors = failed.session.events.filter(event => event.type === 'agentError')
  assert.equal(agentErrors.length, 1)
  assert.equal(agentErrors[0].seat, 1)
  assert.equal(agentErrors[0].retryable, true)
  assert.equal(agentErrors[0].code, 'AGENT_STALLED')
  assert.match(String(agentErrors[0].message), /无法行动|AI/)
  assert.deepEqual(failed.session.events.map(event => event.seq), failed.session.events.map((_, index) => index))
  const saved = JSON.parse(fs.readFileSync(snapshotPath(failed.session.sessionId), 'utf8'))
  assert.ok(!saved.session.pendingAi)
  assert.equal(saved.session.events.some(event => event.type === 'agentError'), true, 'agentError 必须随快照落盘/下发')

  // 旧 aiRetry 仍可用：再次进入后台 AI，再失败一次（不静默成功）。
  const retried = await host.command('aiRetry')
  assert.equal(retried.ok, true, retried.error)
  assert.equal(retried.aiPending, true, 'aiRetry 同样立即回包，后台继续')
  const failedAgain = await idleStatus(host)
  assert.equal(failedAgain.busy, false)
  assert.equal(failedAgain.session.events.filter(event => event.type === 'agentError').length, 2)
  assert.equal(failedAgain.session.state.revision, humanRevision + 1)
})

// ---------------------------------------------------------------------------
// 3. 双击 / 并发：SESSION_BUSY + operationId 幂等回放不重复跑 AI
// ---------------------------------------------------------------------------
test('AI 后台运行期间第二个 move 返回 SESSION_BUSY；operationId 重放不重复调用模型', { timeout: 60000 }, async t => {
  isolateEnv(t)
  const model = startModel()
  const baseUrl = await model.listen()
  model.state.behavior = async (payload) => {
    if (isChatPrompt(payload)) return { content: MODEL_CHAT }
    await sleep(1500)
    return { content: MODEL_STEP }
  }
  const mod = aiBackgroundMod()
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_BASE_URL = baseUrl
  process.env.AI_MODEL = 'stub'
  process.env.AI_JSON_MODE = 'off'
  process.env.AI_TIMEOUT_MS = '15000'
  process.env.AI_MAX_RETRIES = '2'

  const { halls: [host], relayUrl } = await fixture(t, { mods: [mod], count: 1, persist: false })
  t.after(async () => { await model.close() })
  await createAiRoom([host], relayUrl, { mod, capacity: 2, firstSeat: 0 })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const humanRevision = started.session.state.revision
  const operationId = randomUUID()
  const body = { operationId, revision: humanRevision, move: { action: 'step' } }

  const began = performance.now()
  const firstPromise = host.call('command', { action: 'move', body })
  const replayPromise = sleep(40).then(() => host.call('command', { action: 'move', body }))
  const secondPromise = sleep(80).then(() => host.call('command', {
    action: 'move', body: { operationId: randomUUID(), revision: humanRevision, move: { action: 'step' } },
  }))
  const [first, replay, second] = await Promise.all([firstPromise, replayPromise, secondPromise])
  const elapsed = performance.now() - began
  assert.equal(first.ok, true, first.error)
  assert.equal(first.aiPending, true)
  assert.ok(elapsed < 500, '并发场景下首个命令也不得等待模型（实测 ' + elapsed.toFixed(1) + 'ms）')
  assert.equal(replay.ok, true, replay.error)
  assert.equal(replay.aiPending, true, '幂等回放必须返回第一次的 aiPending 响应')
  assert.equal(replay.revision, first.revision)
  assert.equal(second.ok, false, 'AI 后台运行期间不得重入第二个行动')
  assert.equal(second.code, 'SESSION_BUSY')

  const idle = await idleStatus(host)
  assert.equal(idle.session.state.revision, humanRevision + 2, '只有一次 AI 行动被提交')
  assert.equal(idle.session.events.filter(event => event.type === 'move').length, 2, '人类 + AI 各一步')
  assert.equal(idle.session.events.filter(event => event.type === 'agentError').length, 0)
  assert.equal(model.state.calls, 1, '重放/并发不得重复调用模型（stub 调用 ' + model.state.calls + ' 次）')
})

// ---------------------------------------------------------------------------
// 4. start 先手 AI：先回包再后台跑先手回合
// ---------------------------------------------------------------------------
test('AI 先手：start 立即返回 aiPending，后台完成先手回合', { timeout: 60000 }, async t => {
  isolateEnv(t)
  const model = startModel()
  const baseUrl = await model.listen()
  model.state.behavior = async (payload) => {
    if (isChatPrompt(payload)) return { content: MODEL_CHAT }
    await sleep(2000)
    return { content: MODEL_STEP }
  }
  const mod = aiBackgroundMod()
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_BASE_URL = baseUrl
  process.env.AI_MODEL = 'stub'
  process.env.AI_JSON_MODE = 'off'
  process.env.AI_TIMEOUT_MS = '15000'
  process.env.AI_MAX_RETRIES = '2'

  const { halls: [host], relayUrl } = await fixture(t, { mods: [mod], count: 1, persist: true })
  t.after(async () => { await model.close() })
  await createAiRoom([host], relayUrl, { mod, capacity: 2, firstSeat: 1 })
  const began = performance.now()
  const started = await host.command('start')
  const elapsed = performance.now() - began
  t.diagnostic(`2s 模型延迟：start（AI 先手）返回 ${elapsed.toFixed(1)}ms`)
  assert.equal(started.ok, true, started.error)
  assert.equal(started.aiPending, true)
  assert.equal(started.busy, true)
  assert.equal(started.session.state.revision, 0, '首份快照包含 phase 切换，但先手 AI 尚未行动')
  assert.ok(elapsed < 500, 'start 不得等待先手模型（实测 ' + elapsed.toFixed(1) + 'ms）')
  const pending = await host.call('status')
  assert.equal(pending.busy, true)
  assert.equal(pending.aiPending, true)

  const idle = await idleStatus(host, 20000)
  assert.equal(idle.session.state.revision, 1)
  assert.equal(idle.session.state.currentSeat, 0)
  assert.equal(idle.session.events.filter(event => event.type === 'move' && event.seat === 1).length, 1)
  const saved = JSON.parse(fs.readFileSync(snapshotPath(idle.session.sessionId), 'utf8'))
  assert.ok(!saved.session.pendingAi)

  // reset 同样先回包：新一局仍是 AI 先手，后台跑先手回合。
  const beginReset = performance.now()
  const reset = await host.command('reset')
  const resetElapsed = performance.now() - beginReset
  assert.equal(reset.ok, true, reset.error)
  assert.equal(reset.aiPending, true, 'reset 后先手仍是 AI 时也要立即回包')
  assert.ok(resetElapsed < 500, 'reset 不得等待先手模型（实测 ' + resetElapsed.toFixed(1) + 'ms）')
  assert.equal(reset.session.state.revision, 2, 'reset 基线 = 上一局 revision + 1')
  const resetIdle = await idleStatus(host, 20000)
  assert.equal(resetIdle.session.state.revision, 3, '后台跑完先手 AI 的一步')
  assert.equal(resetIdle.session.events.filter(event => event.type === 'move' && event.seat === 1).length, 1)
})

// ---------------------------------------------------------------------------
// 5. 重启恢复：pendingAi 标记让新进程继续，且不重复提交已完成动作
// ---------------------------------------------------------------------------
test('重启恢复：存档 pendingAi 标记驱动新进程继续 AI 回合，不重复提交已完成动作', { timeout: 60000 }, async t => {
  isolateEnv(t) // 无模型：恢复后 AI 走本地合法动作兜底，用来验证「恢复继续」而不是模型行为
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-ai-restart-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mod = aiBackgroundMod()
  const relay = createRelay({ secret: 'ai-background-restart-secret' })
  const relayUrl = await listen(relay)
  const servers = []
  const spawn = async () => {
    const server = createServer({ mods: [mod], persist: true })
    servers.push(server)
    await server.ready
    const origin = await listen(server)
    const call = async (route, body) => {
      const response = await fetch(origin + '/api/online/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return response.json()
    }
    return { server, origin, call, command: (action, body = {}) => call('command', { action, body: { operationId: randomUUID(), ...body } }) }
  }
  t.after(async () => {
    for (const server of servers) await stop(server)
    await stop(relay)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  const first = await spawn()
  const created = await first.call('create', { relayUrl, modId: mod.id, capacity: 2, fillAi: true, settings: { firstSeat: 0 } })
  assert.equal(created.ok, true, created.error)
  const started = await first.command('start')
  assert.equal(started.ok, true, started.error)
  const sessionId = started.session.sessionId

  // 模拟「人类动作已提交 + AI 回合进行到一半时进程崩溃」的存档：
  // pendingAi=true 是本实现落盘的恢复标记；已完成的人类动作与 revision 都在存档里。
  const file = snapshotPath(sessionId)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.session.state.revision = 5
  record.session.state.currentSeat = 1
  record.session.state.done = 1
  record.session.state.moveCount = 1
  record.session.events = [{ seq: 0, type: 'move', seat: 0, move: { action: 'step' } }]
  record.session.pendingAi = true
  fs.writeFileSync(file, JSON.stringify(record))
  await stop(first.server)

  // 新进程：同一 DSH_HOME + persist:true，恢复联机房间与存档，按 pendingAi 标记在后台继续。
  const second = await spawn()
  assert.equal(second.server.online.status().session?.sessionId, sessionId, '恢复后应载入原对局')
  const idle = await idleStatus(second)
  assert.equal(idle.session.sessionId, sessionId)
  assert.equal(idle.session.state.revision, 6, '从存档 revision 5 继续 AI 的这一步')
  assert.equal(idle.session.state.currentSeat, 0)
  const moves = idle.session.events.filter(event => event.type === 'move')
  assert.equal(moves.length, 2)
  assert.deepEqual(moves.map(event => event.seat), [0, 1], '已完成的人类动作不得重复提交，只补跑 AI 回合')
  assert.deepEqual(idle.session.events.map(event => event.seq), [0, 1])
  assert.equal(idle.busy, false)
  const saved = JSON.parse(fs.readFileSync(snapshotPath(sessionId), 'utf8'))
  assert.ok(!saved.session.pendingAi, '恢复完成后必须清除 pendingAi 标记')
  assert.equal(saved.session.state.revision, 6)

  // —— 读档恢复（房间已解散）：start 继续存档时 pendingAi 标记同样要在后台接着跑 ——
  await stop(second.server)
  const record2 = JSON.parse(fs.readFileSync(snapshotPath(sessionId), 'utf8'))
  record2.session.pendingAi = true
  record2.session.state.currentSeat = 1
  fs.writeFileSync(snapshotPath(sessionId), JSON.stringify(record2))
  fs.rmSync(path.join(home, 'boardgame-hall', 'online-connection.json'), { force: true })
  const third = await spawn()
  const loaded = await third.call('load', { relayUrl, sessionId })
  assert.equal(loaded.ok, true, loaded.error)
  const resumed = await third.command('start')
  assert.equal(resumed.ok, true, resumed.error)
  assert.equal(resumed.aiPending, true, '读档恢复时 pendingAi 也要立即回包并后台继续')
  const resumedIdle = await idleStatus(third)
  assert.equal(resumedIdle.session.state.revision, 7, '从读档 revision 6 继续一步')
  assert.deepEqual(resumedIdle.session.events.filter(event => event.type === 'move').map(event => event.seat), [0, 1, 1],
    '历史动作不重放，只补跑 AI 那一步')
  const savedAgain = JSON.parse(fs.readFileSync(snapshotPath(sessionId), 'utf8'))
  assert.ok(!savedAgain.session.pendingAi)
})

// ---------------------------------------------------------------------------
// 6. 回滚开关：命令仍等 AI 跑完（旧行为）
// ---------------------------------------------------------------------------
test('BOARDGAME_ONLINE_AI_BACKGROUND=0 回滚：命令等待 AI 跑完后返回', { timeout: 60000 }, async t => {
  isolateEnv(t)
  const model = startModel()
  const baseUrl = await model.listen()
  model.state.behavior = async (payload) => {
    if (isChatPrompt(payload)) return { content: MODEL_CHAT }
    await sleep(700)
    return { content: MODEL_STEP }
  }
  const mod = aiBackgroundMod()
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_BASE_URL = baseUrl
  process.env.AI_MODEL = 'stub'
  process.env.AI_JSON_MODE = 'off'
  process.env.AI_TIMEOUT_MS = '10000'
  process.env.AI_MAX_RETRIES = '2'
  process.env.BOARDGAME_ONLINE_AI_BACKGROUND = '0'

  const { halls: [host], relayUrl } = await fixture(t, { mods: [mod], count: 1, persist: false })
  t.after(async () => { await model.close() })
  await createAiRoom([host], relayUrl, { mod, capacity: 2, firstSeat: 0 })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const began = performance.now()
  const moved = await host.command('move', { revision: started.session.state.revision, move: { action: 'step' } })
  const elapsed = performance.now() - began
  t.diagnostic(`回滚开关下 move 命令返回 ${elapsed.toFixed(1)}ms（含 700ms 模型延迟）`)
  assert.equal(moved.ok, true, moved.error)
  assert.equal(moved.aiPending, undefined, '回滚后不再返回 aiPending')
  assert.ok(elapsed >= 600, '回滚后命令必须等 AI 跑完（实测 ' + elapsed.toFixed(1) + 'ms）')
  assert.equal(moved.session.state.revision, 2, '响应内已包含人类动作 + AI 回合')
  assert.deepEqual(moved.session.events.filter(event => event.type === 'move').map(event => event.seat), [0, 1])
  const idle = await idleStatus(host)
  assert.equal(idle.busy, false)
  assert.equal(idle.aiPending, false)
})

// ---------------------------------------------------------------------------
// 7. guest 大厅：快照/status 传递 aiPending；AI 思考期间客人可聊天、行动仍被拒
// ---------------------------------------------------------------------------
test('guest 大厅经快照/status 感知 aiPending；AI 思考期间客人可聊天，行动仍被拒', { timeout: 60000 }, async t => {
  isolateEnv(t)
  const model = startModel()
  const baseUrl = await model.listen()
  model.state.behavior = async (payload) => {
    if (isChatPrompt(payload)) return { content: MODEL_CHAT }
    await sleep(1200)
    return { content: MODEL_STEP }
  }
  const mod = aiBackgroundMod()
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_BASE_URL = baseUrl
  process.env.AI_MODEL = 'stub'
  process.env.AI_JSON_MODE = 'off'
  process.env.AI_TIMEOUT_MS = '15000'
  process.env.AI_MAX_RETRIES = '2'
  process.env.AI_CHAT_REPLY_COOLDOWN_MS = '0'

  const { halls: [host, guest], relayUrl } = await fixture(t, { mods: [mod], count: 2 })
  t.after(async () => { await model.close() })
  // 3 席：房主 seat0，AI 预留 seat1，客人 seat2；房主行动后轮到 AI。
  await createAiRoom([host], relayUrl, { mod, capacity: 3, fillAi: false, firstSeat: 0, aiSeats: [{ seat: 1, aiId: 'ai-hu' }] })
  const joined = await guest.call('join', { relayUrl, code: (await host.call('status')).room.code })
  assert.equal(joined.ok, true, joined.error)
  await guest.call('ready', { ready: true })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const humanRevision = started.session.state.revision
  const moved = await host.command('move', { revision: humanRevision, move: { action: 'step' } })
  assert.equal(moved.ok, true, moved.error)
  assert.equal(moved.aiPending, true)

  // 客人通过本地大厅 status 感知 AI 后台回合（guest 大厅的 session 来自快照，带 pendingAi）。
  const guestPending = await waitFor(async () => {
    const status = await guest.call('status')
    return status.aiPending === true && status.busy === true && status.session?.state?.revision === humanRevision + 1
      ? status : null
  }, 8000, '客人感知 aiPending')
  assert.equal(guestPending.session.pendingAi, true, 'guest 视图里也应带 pendingAi 可选字段')

  // 客人聊天仍可提交（不推进局面、不与 AI 抢座位）。
  const chat = await guest.command('chat', { text: 'AI 思考期间客人也能说话' })
  assert.equal(chat.ok, true, chat.error)
  // 客人的下一步行动仍被服务器拒绝（中转只透传 error 文本，旧协议不增加 code 字段）。
  const blocked = await guest.command('move', { revision: humanRevision + 1, move: { action: 'step' } })
  assert.equal(blocked.ok, false)
  assert.match(String(blocked.error), /正在处理上一操作/)

  const finalStatus = await waitFor(async () => {
    const status = await guest.call('status')
    return status.busy === false && status.aiPending === false && status.session?.state.revision === humanRevision + 2
      ? status : null
  }, 20000, '客人收到最终快照')
  assert.equal(finalStatus.session.state.currentSeat, 2, 'AI 走完后轮到客人 seat2')
  assert.equal(finalStatus.session.events.filter(event => event.type === 'move' && event.seat === 1).length, 1)
  assert.equal(finalStatus.session.events.some(event => event.type === 'chat' && event.text === 'AI 思考期间客人也能说话'), true)
})

// ---------------------------------------------------------------------------
// 8. 客户端 banner：aiPending 时显示「AI 思考中…」
// ---------------------------------------------------------------------------
test('联机 banner 在 aiPending 时显示「AI 思考中…」，否则退回「正在处理行动…」', async t => {
  const oldStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = oldStorage
  })
  const h = (tag, props, ...children) => ({
    tag, props: props || {}, children: children.flat(Infinity).filter(child => child != null && child !== false),
  })
  const text = node => (typeof node === 'string' ? node : (node?.children || []).map(text).join(' '))
  const room = {
    code: 'AIBG01', game: { name: '后台 AI 测试' },
    members: [
      { id: 'm-host', host: true, seat: 0, online: true, ready: true },
      { id: 'm-guest', host: false, seat: 1, online: true, ready: true },
    ],
  }
  const state = { online: { connected: true, busy: true, aiPending: true, room, memberId: 'm-host', relayUrl: '' }, session: null, chat: {} }
  const ui = createOnlineUI({
    h, state, render() {}, renderChrome() {},
    request: async () => { throw new Error('banner 不应发请求') }, loadGame() {},
  })
  assert.match(text(ui.banner()), /AI 思考中…/)
  state.online = { ...state.online, aiPending: false }
  assert.match(text(ui.banner()), /正在处理行动…/)
  state.online = { ...state.online, busy: false }
  assert.doesNotMatch(text(ui.banner()), /AI 思考中|正在处理行动/)
})
