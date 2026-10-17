// 决策日志与运行指标（agent 侧可观测性）
//
// 目标：让「AI 这一步为什么这么走、失败在哪一步」有据可查，并给出可聚合的指标。
//   - 每次模型调用写一行 JSONL 到 <DSH_HOME>/boardgame-hall/decisions.jsonl
//   - 进程内维护聚合计数，GET /api/agent-stats 直接读取（不重读整个日志文件）
//
// 本模块是「尽力而为」的旁路：日志写失败只警告，绝不打断对局。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MAX_RECORDS = 2000
const startedAt = new Date().toISOString()

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'boardgame-hall')
}

function logFile() { return path.join(dataDir(), 'decisions.jsonl') }

const counters = {
  calls: 0,
  turns: 0,
  ok: 0,
  parseError: 0,
  validateError: 0,
  callError: 0,
  fallback: 0,
  noKeyFallback: 0,
  stall: 0,
  stalled: 0,
  promptChars: 0,
  promptTokens: 0,
  completionTokens: 0,
  latencyMs: 0,
  // 本地估算的输入 token（不依赖后端返回 usage）与预算命中情况。
  promptTokensEst: 0,
  overBudget: 0,
  turnTimeouts: 0,
  // 战术交流：chat=成功的讨论调用，chatError=讨论调用失败，chatCompress=压缩调用。
  // 单独计数，避免污染 illegalRate / fallbackRate。
  chat: 0,
  chatError: 0,
  chatCompress: 0,
  chatNotes: 0,
  chatCompacted: 0,
}
const byMod = new Map()
const recent = []
let writeFailures = 0
let warnedOnce = false

function bucket(modId) {
  if (!byMod.has(modId)) {
    byMod.set(modId, { calls: 0, ok: 0, fallback: 0, stall: 0, parseError: 0, validateError: 0, callError: 0, promptChars: 0, latencyMs: 0, promptTokensEst: 0, overBudget: 0, chat: 0, chatError: 0, chatNotes: 0, chatCompacted: 0 })
  }
  return byMod.get(modId)
}

/** 截断长文本，避免日志与统计被整段提示词撑爆。 */
function clip(value, max) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) + '…(' + value.length + '字符)' : value
}

/** 记录一次 AI 决策尝试（内部使用，orchestrator 负责组装字段）。 */
export function recordDecision(record) {
  if (!record || typeof record !== 'object') return
  const entry = { ts: new Date().toISOString(), ...record }

  counters.calls++
  const mod = bucket(entry.modId || '(unknown)')
  mod.calls++
  if (Number.isFinite(entry.promptChars)) {
    counters.promptChars += entry.promptChars
    mod.promptChars += entry.promptChars
  }
  if (Number.isFinite(entry.promptTokensEst)) {
    counters.promptTokensEst += entry.promptTokensEst
    mod.promptTokensEst += entry.promptTokensEst
  }
  if (entry.promptOverBudget) {
    counters.overBudget++
    mod.overBudget++
  }
  if (entry.outcome === 'stall' && entry.reason === 'turn-timeout') counters.turnTimeouts++
  if (Number.isFinite(entry.latencyMs)) {
    counters.latencyMs += entry.latencyMs
    mod.latencyMs += entry.latencyMs
  }
  if (entry.usage) {
    counters.promptTokens += Number(entry.usage.promptTokens) || 0
    counters.completionTokens += Number(entry.usage.completionTokens) || 0
  }

  const outcome = entry.outcome
  if (outcome && Object.hasOwn(counters, outcome)) {
    counters[outcome]++
    if (Object.hasOwn(mod, outcome)) mod[outcome]++
  }

  recent.push(entry)
  if (recent.length > MAX_RECORDS) recent.splice(0, recent.length - MAX_RECORDS)
  appendLine(entry)
}

/**
 * 记录一次备忘写入/压缩结果。
 * 备忘不是模型调用，因此直接计数，不经过 recordDecision（也不影响 illegalRate / fallbackRate）。
 */
export function recordChatMemory(fields) {
  if (!fields || typeof fields !== 'object') return
  const added = Number(fields.added) || 0
  const updated = Number(fields.updated) || 0
  const removed = Number(fields.removed) || 0
  const compacted = Number(fields.compacted) || 0
  counters.chatNotes += added
  counters.chatCompacted += compacted
  const mod = bucket(fields.modId || '(unknown)')
  mod.chatNotes += added
  mod.chatCompacted += compacted
  const entry = { ts: new Date().toISOString(), ...fields, added, updated, removed, compacted, kind: 'memory' }
  recent.push(entry)
  if (recent.length > MAX_RECORDS) recent.splice(0, recent.length - MAX_RECORDS)
  appendLine(entry)
}

/** 记录一次 AI 回合的结束（用于统计「一个回合走了几步」）。 */
export function recordTurn(record) {
  if (!record || typeof record !== 'object') return
  const entry = { ts: new Date().toISOString(), kind: 'turn', ...record }
  counters.turns++
  const mod = bucket(entry.modId || '(unknown)')
  if (Number.isFinite(entry.steps)) {
    mod.steps = (mod.steps || 0) + entry.steps
    mod.turns = (mod.turns || 0) + 1
  }
  recent.push(entry)
  if (recent.length > MAX_RECORDS) recent.splice(0, recent.length - MAX_RECORDS)
  appendLine(entry)
}

function appendLine(entry) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.appendFileSync(logFile(), JSON.stringify(entry) + '\n', 'utf8')
  } catch (err) {
    writeFailures++
    if (!warnedOnce) {
      warnedOnce = true
      console.warn('  [agent] 决策日志写入失败（不影响对局）：' + String(err && err.message ? err.message : err))
    }
  }
}

/** 进程内指标快照，供 GET /api/agent-stats 使用。 */
export function statsSnapshot() {
  const mods = {}
  for (const [id, m] of byMod) {
    const turns = m.turns || 0
    mods[id] = {
      calls: m.calls,
      ok: m.ok,
      fallback: m.fallback,
      stall: m.stall,
      parseError: m.parseError,
      validateError: m.validateError,
      callError: m.callError,
      avgPromptChars: m.calls ? Math.round(m.promptChars / m.calls) : 0,
      avgPromptTokensEst: m.calls ? Math.round(m.promptTokensEst / m.calls) : 0,
      overBudget: m.overBudget,
      avgLatencyMs: m.calls ? Math.round(m.latencyMs / m.calls) : 0,
      chat: m.chat,
      chatError: m.chatError,
      chatNotes: m.chatNotes,
      chatCompacted: m.chatCompacted,
      turns,
      avgStepsPerTurn: turns ? Number(((m.steps || 0) / turns).toFixed(2)) : 0,
    }
  }
  const avg = (total) => (counters.calls ? Math.round(total / counters.calls) : 0)
  return {
    since: startedAt,
    logFile: logFile(),
    writeFailures,
    totals: {
      calls: counters.calls,
      turns: counters.turns,
      ok: counters.ok,
      parseError: counters.parseError,
      validateError: counters.validateError,
      callError: counters.callError,
      fallback: counters.fallback,
      noKeyFallback: counters.noKeyFallback,
      stall: counters.stall,
      avgPromptChars: avg(counters.promptChars),
      avgLatencyMs: avg(counters.latencyMs),
      promptTokens: counters.promptTokens,
      completionTokens: counters.completionTokens,
      promptTokensEst: counters.promptTokensEst,
      avgPromptTokensEst: avg(counters.promptTokensEst),
      overBudget: counters.overBudget,
      overBudgetRate: counters.calls ? Number((counters.overBudget / counters.calls).toFixed(3)) : 0,
      turnTimeouts: counters.turnTimeouts,
      // 战术交流（不进 illegalRate / fallbackRate 的分子，也不单独稀释它们）
      chatCalls: counters.chat + counters.chatError,
      chat: counters.chat,
      chatError: counters.chatError,
      chatCompress: counters.chatCompress,
      chatNotes: counters.chatNotes,
      chatCompacted: counters.chatCompacted,
      illegalRate: counters.calls ? Number((counters.validateError / counters.calls).toFixed(3)) : 0,
      fallbackRate: counters.calls ? Number(((counters.fallback + counters.noKeyFallback) / counters.calls).toFixed(3)) : 0,
    },
    byMod: mods,
    recent: recent.slice(-30).reverse(),
  }
}

/** 仅供测试使用：清空进程内指标与最近记录（不动磁盘日志）。 */
export function resetStats() {
  for (const key of Object.keys(counters)) counters[key] = 0
  byMod.clear()
  recent.length = 0
  writeFailures = 0
}

export { clip }
