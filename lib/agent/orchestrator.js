// Agent 编排器：一次 AI 回合的完整闭环。
//
//   构建提示词 → 调模型 → 解析 JSON → 用 Mod 的 validateMove 校验合法性
//     → 合法则交核心提交；不合法则重试；多次失败后按 legalMoves 校验兜底。
//
// 关键点：本层只通过 Mod 接口（describeState / moveFormat / validateMove / legalMoves /
// moveToText / applyMove）与游戏交互，完全不感知具体桌游规则；游戏也不感知 LLM。
//
// ★ 回合内记忆（turn）
//   一个桌游「回合」常常不止一次决策（诡镇：3 个行动点 + 若干待决选择）。大厅用
//   createTurnContext() 建立回合上下文，对同一个 AI 座位的连续决策复用同一个 turn，
//   编排器据此复用同一段对话历史，并把「本回合已走几步 / 上一手是什么」写进提示词；
//   回合真正结束时由大厅调用 endTurn() 结算（记录每回合步数）。
//   这样模型的多步决策不再互相独立，也不会反复丢失自己刚做过的事。

// ★ 失败语义
//   - 任何一步都先过 validateMove，非法一律打回重试，绝不污染棋局。
//   - 重试预算耗尽后：用 legalMoves 做确定性兜底（同一对局、同一回合可复现）。
//   - 若 legalMoves 里没有任何候选能通过校验，返回可诊断的 stalled，由大厅明确失败；
//     不再静默返回 null 造成「轮到 AI 但永远不动」的软死锁。
//   - 单回合模型调用总次数受 config.maxTurnCalls 限制，超限同样返回 stalled。

import { loadConfig } from './config.js'
import { chatCompletion } from './client.js'
import {
  buildSystemPrompt, buildUserPrompt, buildChatSystemPrompt, buildChatUserPrompt,
  buildReactionSystemPrompt, buildReactionUserPrompt,
} from './prompt.js'
import { parseAgentReply, parseChatReply, parseReactionReply, extractJsonObject } from './decoder.js'
import { estimateMessagesTokens } from './tokens.js'
import { needsCompaction, groupNotes, compactDeterministic, overHardLimit, notesTargetFrom, sortNotes, clampNoteText } from '../chat.js'
import { getDecisionSeat } from '../mods.js'
import { recordDecision, recordTurn, clip } from './log.js'

// 回合内记忆窗口的默认值：保留最近 N 步决策 + 当前步。
// 诡镇一个回合 3 个行动点，最近 2 步 + 当前步已足够。
// 可用 AI_MEMORY_STEPS 覆盖（见 config.memorySteps），真正的硬上限仍是 maxPromptTokens。
const DEFAULT_MEMORY_STEPS = 2
const DECAY_NOTE = '（系统：为控制上下文长度，早于以上窗口的对话已省略；请只依据当前局面行动。）'

/** 建立一个 AI 回合的上下文；大厅在同一座位的连续决策间复用它。 */
export function createTurnContext(seat, modId, sessionId) {
  return {
    seat, modId, sessionId, aiId: null,
    head: null, body: [], steps: 0, calls: 0, stall: false,
    lastStep: null, lastMoveText: '', finished: false,
    // 回合墙钟预算的起点：同一回合内的多次决策共享，见 config.turnTimeoutMs。
    startedAt: Date.now(),
  }
}

export function createAgent({ modById, getAi, getConfig }) {
  const resolveConfig = getConfig || (() => loadConfig())
  const initial = resolveConfig()
  if (!initial.apiKey) {
    console.warn('  [agent] 未配置 AI_API_KEY，AI 将按合法动作顺序兜底（全 agent 需配置模型）。')
  }

  /**
   * 运行 AI 座位的一个决策步。
   * @param {object} session 对局
   * @param {number} seat 应答座位
   * @param {object} [turn] 同一 AI 回合的上下文；缺省则该步自成一个回合（立即结算）
   */
  async function agentPlay(session, seat, turn) {
    const config = currentConfig()
    const mod = modById(session.modId)
    const state = session.state
    const revision = state.revision
    const ownTurn = !turn
    const context = turn || createTurnContext(seat, mod.id, session.sessionId)

    try {
      return await playStep(mod, session, seat, context, state, revision, config)
    } finally {
      if (ownTurn) endTurn(context)
    }
  }

  /** 结算一个 AI 回合（大厅在同一座位不再应答时调用）。幂等。 */
  function endTurn(context) {
    if (!context || context.finished) return
    context.finished = true
    recordTurn({
      modId: context.modId,
      sessionId: context.sessionId,
      seat: context.seat,
      steps: context.steps,
      calls: context.calls,
      stalled: !!context.stall,
      stale: !!context.stale,
    })
  }

  async function playStep(mod, session, seat, context, state, revision, config) {
    const isCurrent = () => session.state === state && state.revision === revision &&
      state.status === 'playing' && getDecisionSeat(mod, state) === seat && session.players[seat]?.role === 'ai'
    const stale = () => { context.stale = true; return { move: null, speech: '', stale: true } }
    if (!isCurrent()) return stale()

    const ai = getAi(session.players[seat].aiId)
    context.aiId = ai && ai.id ? ai.id : null
    const step = revision + 1
    const revisited = context.lastStep === step

    // 未配置模型：直接走兜底，连提示词都不必组装。
    if (!config.apiKey) {
      return fallback(mod, session, seat, context, { noKey: true, reason: 'no-model', step, config, attempts: 0 })
    }

    // 头部只放 system：每步的 user 消息进入对话体，便于剪枝；
    // describeState 每步只调用一次（Mod 的观察者投影可能很重）。
    if (context.head == null) context.head = [{ role: 'system', content: buildSystemPrompt(mod, ai, session, seat) }]

    const maxCalls = Math.max(1, config.maxTurnCalls || 24)
    if (context.calls >= maxCalls) {
      return stalled(mod, session, seat, context, { reason: 'turn-budget', step, config })
    }

    // 同一个待决 revision 只在第一次推入 user 消息；重试与续走沿用已有上下文。
    if (!revisited) {
      context.body.push({
        role: 'user',
        content: buildUserPrompt(mod, session, seat, {
          step, alreadyActed: (context.priorSteps || 0) + context.steps, lastMoveText: context.lastMoveText,
        }),
      })
    }

    const budget = Math.max(1, config.maxRetries)
    const maxPromptTokens = promptBudgetOf(config)
    const memorySteps = memoryStepsOf(config)
    const turnTimeoutMs = Math.max(0, config.turnTimeoutMs || 0)
    let attempts = 0
    let lastError = null

    while (attempts < budget && context.calls < maxCalls) {
      if (!isCurrent()) return stale()

      // 回合墙钟预算：到点立即中止该 AI 回合，避免一次 /api/move 长时间挂着。
      let callConfig = config
      if (turnTimeoutMs > 0) {
        const remaining = turnTimeoutMs - (Date.now() - (context.startedAt || Date.now()))
        if (remaining <= 0) return stalled(mod, session, seat, context, { reason: 'turn-timeout', step, config })
        callConfig = { ...config, timeoutMs: Math.min(config.timeoutMs || 60000, remaining) }
      }

      attempts++
      context.calls++

      // 预算内组装请求：超出 token 预算时优先丢弃更早的对话历史。
      const requestMessages = buildRequestMessages(context, maxPromptTokens, memorySteps)
      const promptTokensEst = estimateMessagesTokens(requestMessages)
      const promptMetrics = {
        promptTokensEst,
        promptOverBudget: maxPromptTokens > 0 && promptTokensEst > maxPromptTokens,
        memorySteps,
      }

      let reply
      try {
        reply = await chatCompletion(requestMessages, callConfig, { json: true })
      } catch (err) {
        if (!isCurrent()) return stale()
        const message = String(err && err.message ? err.message : err)
        lastError = '模型调用出错：' + message
        context.body.push({ role: 'user', content: '（系统提示）调用模型出错：' + message + '。请重新输出。' })
        log(mod, session, seat, ai, {
          step, attempt: attempts, outcome: 'callError', latencyMs: null,
          error: clip(message, 200), config, ...promptMetrics,
        })
        continue
      }
      if (!isCurrent()) return stale()

      context.body.push({ role: 'assistant', content: reply.text })
      const promptChars = contextChars(context)

      const parsed = parseAgentReply(reply.text)
      if (parsed.error) {
        lastError = '输出无法解析：' + parsed.error
        context.body.push({
          role: 'user',
          content: '你的输出无法解析：' + parsed.error + '。请严格只输出一个 JSON 对象 {"move":..., "speech":"..."' + (mod.agentPlanning ? ', "plan":{...}' : '') + '}。',
        })
        log(mod, session, seat, ai, {
          step, attempt: attempts, outcome: 'parseError', promptChars, reply, error: parsed.error, config, ...promptMetrics,
        })
        continue
      }

      const invalid = validateCandidate(mod, state, seat, parsed.move, true)
      if (invalid) {
        lastError = '行动不合法：' + invalid
        context.body.push({
          role: 'user',
          content: '你的行动不合法：' + invalid + '。请根据当前局面重新选择合法行动。',
        })
        log(mod, session, seat, ai, {
          step, attempt: attempts, outcome: 'validateError', promptChars, reply,
          error: clip(String(invalid), 200), move: parsed.move, config, ...promptMetrics,
        })
        continue
      }

      advance(context, step, mod, parsed.move)
      log(mod, session, seat, ai, {
        step, attempt: attempts, outcome: 'ok', promptChars, reply, move: parsed.move, config, ...promptMetrics,
      })
      return { move: parsed.move, speech: parsed.speech || '', ...(mod.agentPlanning && parsed.plan ? { plan: parsed.plan } : {}), calls: context.calls, attempts, usage: reply.usage, model: reply.model }
    }

    if (!isCurrent()) return stale()
    const reason = context.calls >= maxCalls ? 'turn-budget' : 'retries-exhausted'
    return fallback(mod, session, seat, context, { noKey: false, reason, step, config, attempts, lastError })
  }

  // 当前生效配置。`agent.config` 是兼容既有调用方的访问器：
  //   - 读取：实时快照（未覆盖时反映最新 env/文件配置）
  //   - 写属性：agent.config.apiKey = '' 这类写法会被当作显式覆盖（测试/离线自检常用）
  //   - 整体赋值：agent.config = {...} 同样作为覆盖；传 null/falsy 恢复默认来源
  let configOverride = null

  /** 把外部对配置对象的写入重定向到覆盖层，读到的对象自身保持一致。 */
  function configFacade() {
    const base = configOverride || resolveConfig()
    const target = { ...base }
    const overrides = { ...(configOverride || {}) }
    return new Proxy(target, {
      set(obj, key, value) {
        overrides[key] = value
        configOverride = overrides
        obj[key] = value
        return true
      },
      deleteProperty(obj, key) {
        delete overrides[key]
        delete obj[key]
        return true
      },
    })
  }

  const currentConfig = () => (configOverride ? { ...resolveConfig(), ...configOverride } : resolveConfig())

  /**
   * 一次战术讨论：独立的模型调用。
   * 关键约束：不创建 turn 上下文、不消耗 maxTurnCalls、不产生 move。
   * 返回 { reply, memory, calls } 或 { error, noModel?, disabled? }。
   */
  async function agentChat(session, seat, text, channel) {
    const config = currentConfig()
    const mod = modById(session.modId)
    const ai = session.players[seat] ? getAi(session.players[seat].aiId) : null
    const step = session.state ? session.state.revision : null
    if (config.chatEnabled === false) return { error: '聊天功能已关闭', disabled: true }
    if (!mod) return { error: '未知桌游：' + session.modId }
    if (!config.apiKey) return { noModel: true, reply: '', error: '未配置模型，无法讨论' }

    const messages = [
      { role: 'system', content: buildChatSystemPrompt(mod, ai, session, seat) },
      { role: 'user', content: buildChatUserPrompt(mod, session, seat, text, channel, { window: config.chatWindow }) },
    ]
    const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0)
    const budget = Math.max(1, config.maxRetries)
    const turnTimeoutMs = Math.max(0, config.turnTimeoutMs || 0)
    const startedAt = Date.now()
    let lastError = null

    for (let attempt = 1; attempt <= budget; attempt++) {
      let callConfig = config
      if (turnTimeoutMs > 0) {
        const remaining = turnTimeoutMs - (Date.now() - startedAt)
        if (remaining <= 0) { lastError = '讨论超时'; break }
        callConfig = { ...config, timeoutMs: Math.min(config.timeoutMs || 60000, remaining) }
      }
      let reply
      try {
        reply = await chatCompletion(messages, callConfig, { json: true })
      } catch (err) {
        lastError = '调用模型出错：' + String(err && err.message ? err.message : err)
        log(mod, session, seat, ai, { step, attempt, outcome: 'chatError', promptChars, latencyMs: null, error: clip(lastError, 200), config })
        continue
      }
      const parsed = parseChatReply(reply.text)
      if (parsed.error) {
        lastError = '输出无法解析：' + parsed.error
        messages.push({ role: 'assistant', content: reply.text })
        messages.push({
          role: 'user',
          content: '你的输出无法解析：' + parsed.error + '。请严格只输出一个 JSON 对象 {"reply":"...","memory":{"add":[],"update":[],"remove":[]}}。',
        })
        log(mod, session, seat, ai, { step, attempt, outcome: 'chatError', promptChars, reply, error: parsed.error, config })
        continue
      }
      log(mod, session, seat, ai, { step, attempt, outcome: 'chat', promptChars, reply, config })
      return { reply: parsed.reply, memory: parsed.memory, calls: attempt }
    }
    return { reply: '', error: lastError || '讨论失败' }
  }

  /**
   * 已提交规则事件的只读角色回应：不产生 move、不修改备忘，也不占用行动回合预算。
   */
  async function agentReact(session, seat, trigger) {
    const config = currentConfig()
    const mod = modById(session.modId)
    const ai = session.players[seat] ? getAi(session.players[seat].aiId) : null
    const step = session.state ? session.state.revision : null
    if (config.chatEnabled === false) return { error: '聊天功能已关闭', disabled: true }
    if (!mod) return { error: '未知桌游：' + session.modId }
    if (!config.apiKey) return { noModel: true, reply: '', error: '未配置模型，无法回应事件' }

    const messages = [
      { role: 'system', content: buildReactionSystemPrompt(mod, ai) },
      { role: 'user', content: buildReactionUserPrompt(mod, session, seat, trigger) },
    ]
    const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0)
    const budget = Math.max(1, config.maxRetries)
    let lastError = null

    for (let attempt = 1; attempt <= budget; attempt++) {
      let reply
      try {
        reply = await chatCompletion(messages, config, { json: true })
      } catch (err) {
        lastError = '调用模型出错：' + String(err && err.message ? err.message : err)
        log(mod, session, seat, ai, { step, attempt, outcome: 'reactionError', promptChars,
          latencyMs: null, error: clip(lastError, 200), config })
        continue
      }
      const parsed = parseReactionReply(reply.text)
      if (parsed.error) {
        lastError = '输出无法解析：' + parsed.error
        messages.push({ role: 'assistant', content: reply.text })
        messages.push({ role: 'user', content: '请严格只输出一个 JSON 对象 {"reply":"..."}。' })
        log(mod, session, seat, ai, { step, attempt, outcome: 'reactionError', promptChars,
          reply, error: parsed.error, config })
        continue
      }
      log(mod, session, seat, ai, { step, attempt, outcome: 'reaction', promptChars, reply, config })
      return { reply: parsed.reply, calls: attempt }
    }
    return { reply: '', error: lastError || '事件回应失败' }
  }

  /**
   * 备忘压缩：按作用域分组（team / 每个私聊座位）独立进行。
   * 先让模型合并同义条目；模型不可用或压缩后仍超硬阈值，走确定性裁剪（同输入同输出）。
   */
  async function compactNotes(session) {
    const config = currentConfig()
    const mod = modById(session.modId)
    const notes = Array.isArray(session.notes) ? session.notes.slice() : []
    const max = config.chatNotesMax
    if (!needsCompaction(notes, max)) return { notes: sortNotes(notes), compressed: false, dropped: 0, groups: 0 }

    const target = notesTargetFrom(max)
    const groups = groupNotes(notes)
    let collected = []
    let compressed = false
    let dropped = 0

    for (const group of groups) {
      if (!needsCompaction(group.notes, max)) { collected.push(...group.notes); continue }
      let merged = null
      if (config.chatEnabled !== false && config.apiKey) {
        merged = await compactGroupWithModel(mod, session, group, target, config)
      }
      if (merged && merged.length) {
        compressed = true
        dropped += Math.max(0, group.notes.length - merged.length)
        collected.push(...merged)
      } else {
        const fallback = compactDeterministic(group.notes, target)
        if (fallback.dropped > 0) compressed = true
        dropped += fallback.dropped
        collected.push(...fallback.notes)
      }
    }

    let result = sortNotes(collected)
    if (overHardLimit(result)) {
      const hard = compactDeterministic(result, target)
      dropped += hard.dropped
      result = hard.notes
      compressed = true
    }
    return { notes: result, compressed, dropped, groups: groups.length }
  }

  /** 单组模型压缩；输出必须是「已有 id + 截断后的文本」，否则判失败走确定性兜底。 */
  async function compactGroupWithModel(mod, session, group, target, config) {
    const step = session.state ? session.state.revision : null
    const scopeLabel = group.scope === 'seat' ? ('座位 ' + group.seat + ' 的私聊约定') : '全队公开约定'
    const messages = [
      { role: 'system', content: '你是记忆整理助手，只输出 JSON，不做任何解释。' },
      {
        role: 'user',
        content: [
          '下面是玩家与 AI 在「' + scopeLabel + '」范围内确认过的战术备忘。',
          '请合并同义条目、删除已失效或互相矛盾的条目，把 ' + group.notes.length + ' 条压缩到不超过 ' + target + ' 条。',
          '要求：',
          '- 只能使用已有条目的 id，不得创造新 id；合并时取被合并条目中的任意一个 id；',
          '- 每条不超过 30 字，必须保留原意，不得改变语义，不得引入任何新策略；',
          '- 只输出 {"notes":[{"id":"n1","text":"..."}]}。',
          '',
          JSON.stringify(group.notes.map((note) => ({ id: note.id, text: note.text }))),
        ].join('\n'),
      },
    ]

    let reply
    try {
      reply = await chatCompletion(messages, config, { json: true })
    } catch (err) {
      log(mod, session, group.seat, null, { step, outcome: 'chatCompress', latencyMs: null, error: clip(String(err && err.message ? err.message : err), 200), config })
      return null
    }
    const extracted = extractJsonObject(reply.text)
    if (extracted.error) {
      log(mod, session, group.seat, null, { step, outcome: 'chatCompress', reply, error: extracted.error, config })
      return null
    }
    const raw = extracted.obj.notes
    if (!Array.isArray(raw)) {
      log(mod, session, group.seat, null, { step, outcome: 'chatCompress', reply, error: 'notes 不是数组', config })
      return null
    }

    const byId = new Map(group.notes.map((note) => [note.id, note]))
    const used = new Set()
    const kept = []
    for (const item of raw) {
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') continue
      const source = byId.get(item.id)
      if (!source || used.has(item.id)) continue
      const text = clampNoteText(item.text)
      if (!text) continue
      used.add(item.id)
      kept.push({ ...source, text, updatedAt: Date.now(), compacted: true })
      if (kept.length >= target) break
    }
    if (!kept.length) {
      log(mod, session, group.seat, null, { step, outcome: 'chatCompress', reply, error: '压缩结果为空', config })
      return null
    }
    log(mod, session, group.seat, null, { step, outcome: 'chatCompress', reply, config })
    return kept
  }

  return {
    agentPlay,
    agentChat,
    agentReact,
    compactNotes,
    endTurn,
    getConfig: () => configFacade(),
    get config() { return configFacade() },
    set config(value) { configOverride = value || null },
  }
}

// ---------------------------------------------------------------------------
// 上下文组装
// ---------------------------------------------------------------------------

/** 记忆窗口（步数）：保留最近 N 步 + 当前步，非法值回落默认 2。 */
function memoryStepsOf(config) {
  const value = Number(config && config.memorySteps)
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : DEFAULT_MEMORY_STEPS
}

/** 固定头部（system）+ 剪枝后的对话体；剪枝时插入明确说明，避免模型误以为没有历史。
 *  两级剪枝：先按记忆窗口（AI_MEMORY_STEPS，默认 2）截断条数，再按 token 预算继续丢弃更早的对话。
 *  规则：至少保留最后一条消息；丢弃后保证首条是 user，不制造断裂的 assistant 开头。 */
function buildRequestMessages(context, maxTokens, memorySteps) {
  const body = context.body
  const head = context.head || []
  const limit = (Math.max(1, Number(memorySteps) || DEFAULT_MEMORY_STEPS) + 1) * 2
  let kept = body.length <= limit ? body.slice() : body.slice(-limit)
  if (maxTokens > 0) {
    while (kept.length > 1 && estimateMessagesTokens([...head, ...kept]) > maxTokens) {
      kept = kept.slice(1)
      while (kept.length > 1 && kept[0].role !== 'user') kept = kept.slice(1)
    }
  }
  if (kept.length === body.length) return [...head, ...kept]
  const note = { role: 'user', content: DECAY_NOTE + '（已省略 ' + (body.length - kept.length) + ' 条）' }
  return [...head, note, ...kept]
}

/** 当前提示词预算；<=0 表示不限制。 */
function promptBudgetOf(config) {
  return Math.max(0, (config && config.maxPromptTokens) || 0)
}

/** 本次请求的体量指标（预算控制 + 决策日志用）。memorySteps 与实发请求保持一致。 */
function promptStats(context, maxPromptTokens, memorySteps) {
  const tokens = estimateMessagesTokens(buildRequestMessages(context, maxPromptTokens, memorySteps))
  return { promptTokensEst: tokens, promptOverBudget: maxPromptTokens > 0 && tokens > maxPromptTokens }
}

function contextChars(context) {
  const head = context.head || []
  return head.reduce((sum, m) => sum + m.content.length, 0) +
    context.body.reduce((sum, m) => sum + m.content.length, 0)
}

function advance(context, step, mod, move) {
  context.steps++
  context.lastStep = step
  context.lastMoveText = safeMoveText(mod, move)
}

function safeMoveText(mod, move) {
  try {
    const text = mod.moveToText ? mod.moveToText(move) : ''
    return typeof text === 'string' ? text : ''
  } catch { return '' }
}

function validateCandidate(mod, state, seat, move, model = false) {
  try {
    const invalid = mod.validateMove(structuredClone(state), seat, structuredClone(move))
    return invalid || (model && mod.validateAgentMove ? mod.validateAgentMove(structuredClone(state), seat, structuredClone(move)) : null)
  } catch (err) {
    return String(err && err.message ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// 兜底与中止
// ---------------------------------------------------------------------------

// 「结束型」动作：会让 AI 回合/对局直接收尾，兜底时应作为最后手段。
// 先按结构化字段（action/type/kind）判断，再退回 label 文本，避免依赖单一命名习惯。
const TERMINAL_ACTION = /^(endturn|end|pass|skip|resign|leave|stop|forfeit|concede|done|noop|no-op|wait)$/i
const TERMINAL_LABEL = /结束回合|结束本回合|结束行动|结束并|撤退|认输|投降|跳过|放弃|不出牌|过牌/i

function isTerminalMove(move) {
  if (!move || typeof move !== 'object') return false
  const action = move.action != null ? move.action : (move.type != null ? move.type : move.kind)
  if (typeof action === 'string' && TERMINAL_ACTION.test(action.trim())) return true
  return typeof move.label === 'string' && TERMINAL_LABEL.test(move.label)
}

/** 在 legalMoves 里挑第一个能通过校验的候选；起点由确定性伪随机决定。
 *  候选按四档优先级挑选：非结束型且有正成本 → 非结束型 → 有正成本 → 全部，
 *  因此模型失败时不会顺手把 AI 回合直接结束掉。 */
function pickFallback(mod, state, seat, seed) {
  if (typeof mod.agentFallback === 'function') {
    const move = mod.agentFallback(structuredClone(state), seat)
    if (move && !validateCandidate(mod, state, seat, move)) return { move, total: 1, index: 0 }
  }
  let legal
  try { legal = mod.legalMoves(structuredClone(state), seat) || [] } catch { legal = [] }
  if (!legal.length) return { move: null, total: 0, index: -1 }

  const scored = legal.map((move) => ({
    move,
    cost: moveCost(mod, state, seat, move),
    terminal: isTerminalMove(move),
  }))
  const tiers = [
    scored.filter((entry) => !entry.terminal && entry.cost > 0),
    scored.filter((entry) => !entry.terminal),
    scored.filter((entry) => entry.cost > 0),
    scored,
  ]
  const picked = tiers.find((tier) => tier.length) || []

  const start = (seed >>> 0) % picked.length
  for (let i = 0; i < picked.length; i++) {
    const index = (start + i) % picked.length
    const candidate = picked[index].move
    if (candidate == null) continue
    if (!validateCandidate(mod, state, seat, candidate)) {
      return { move: candidate, total: picked.length, index, skipped: legal.length - picked.length }
    }
  }
  return { move: null, total: picked.length, index: -1 }
}

/** 候选动作的行动点成本；未知（无成本字段/未实现探测）时返回 1（视为普通动作）。 */
function moveCost(mod, state, seat, move) {
  try {
    if (typeof mod.moveCost === 'function') {
      const cost = mod.moveCost(state, seat, move)
      return Number.isFinite(cost) ? cost : 1
    }
    if (move && typeof move === 'object' && Number.isFinite(move.cost)) return move.cost
  } catch { return 1 }
  return 1
}

/** 同一对局 + 同一回合 → 同一兜底选择，可复现、可回归。
 *  优先使用 Mod 提供的对局种子（decisionSeed），这样「同一种子同一步」的兜底也一致；
 *  Mod 未提供时退化为 sessionId，至少保证同一会话内可复现。 */
function fallbackSeed(session, seat, step, mod) {
  let basis = null
  if (mod && typeof mod.decisionSeed === 'function') {
    try {
      const supplied = mod.decisionSeed(session, seat, step)
      if (typeof supplied === 'string' || Number.isFinite(supplied)) basis = String(supplied)
    } catch { basis = null }
  }
  const text = (basis != null ? 'seed:' + basis : 'session:' + String(session.sessionId || '')) +
    '|' + String(session.modId || '') + '|' + String(session.state ? session.state.revision : '') + '|' + String(seat)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

function fallback(mod, session, seat, context, options) {
  const { noKey, reason, step, config, attempts, lastError } = options
  const picked = pickFallback(mod, session.state, seat, fallbackSeed(session, seat, step, mod))

  if (picked.move == null) {
    context.stall = true
    log(mod, session, seat, context.aiId, {
      step, outcome: 'stall', promptChars: contextChars(context), latencyMs: null,
      reason: 'no-legal-fallback', legalMoves: picked.total, error: clip(String(lastError || ''), 200), config,
      ...promptStats(context, promptBudgetOf(config), memoryStepsOf(config)),
    })
    return {
      move: null, speech: '', stalled: true, fallback: true, reason: 'no-legal-fallback', calls: context.calls, attempts,
      error: '没有任何合法动作可供兜底（legalMoves 返回 ' + picked.total + ' 项，均未通过 validateMove）',
    }
  }

  advance(context, step, mod, picked.move)
  log(mod, session, seat, context.aiId, {
    step, outcome: noKey ? 'noKeyFallback' : 'fallback', promptChars: contextChars(context),
    latencyMs: null, reason, legalMoves: picked.total, legalIndex: picked.index,
    error: clip(String(lastError || ''), 200), config,
    ...promptStats(context, promptBudgetOf(config), memoryStepsOf(config)),
  })
  return {
    move: picked.move,
    speech: noKey ? '' : '……',
    fallback: true, reason, calls: context.calls, attempts,
  }
}

function stalled(mod, session, seat, context, options) {
  context.stall = true
  log(mod, session, seat, context.aiId, {
    step: options.step, outcome: 'stall', promptChars: contextChars(context), latencyMs: null,
    reason: options.reason, config: options.config,
    ...promptStats(context, promptBudgetOf(options.config), memoryStepsOf(options.config)),
  })
  const limitText = options.reason === 'turn-timeout'
    ? '本回合已超过墙钟预算（' + Math.round((options.config.turnTimeoutMs || 0) / 1000) + ' 秒）'
    : '本回合模型调用次数已达上限（' + (options.config.maxTurnCalls || 24) + '）'
  return {
    move: null, speech: '', stalled: true, fallback: false, reason: options.reason,
    calls: context.calls, attempts: 0,
    error: limitText + '，已中止该 AI 回合',
  }
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

/** 只记录传入的字段；其余保持 undefined，避免日志里出现无意义的 null。 */
function log(mod, session, seat, ai, fields) {
  const record = {
    modId: mod.id,
    sessionId: session.sessionId,
    seat,
    aiId: ai && ai.id ? ai.id : null,
    aiName: ai && ai.name ? ai.name : null,
    model: fields.config ? fields.config.model : null,
    revision: session.state ? session.state.revision : null,
    step: fields.step,
    attempt: fields.attempt,
    outcome: fields.outcome,
    reason: fields.reason,
    promptChars: fields.promptChars,
    promptTokensEst: fields.promptTokensEst,
    promptOverBudget: fields.promptOverBudget,
    memorySteps: fields.memorySteps,
    latencyMs: fields.reply ? fields.reply.latencyMs : fields.latencyMs,
    usage: fields.reply ? fields.reply.usage : null,
    replyChars: fields.reply ? fields.reply.text.length : null,
    replyExcerpt: fields.reply ? clip(fields.reply.text, 300) : null,
    move: fields.move,
    legalMoves: fields.legalMoves,
    legalIndex: fields.legalIndex,
    error: fields.error,
  }
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]
  recordDecision(record)
}
