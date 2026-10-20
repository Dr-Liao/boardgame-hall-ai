// Agent 配置：LLM 后端连接参数。
//
// 读取优先级：环境变量 > 项目根目录 boardgame.config.json > 默认值。
// 这是一个 OpenAI 兼容的 chat/completions 接口，可接 OpenAI / DeepSeek / Ollama 等。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 默认：项目根目录 boardgame.config.json。
// 若设置了 DSH_HOME，则改读 <DSH_HOME>/boardgame.config.json —— 与 AI 角色数据目录同级，
// 便于测试与多实例隔离，也避免误读仓库里的真实密钥配置。
function configPathNow() {
  const home = process.env.DSH_HOME
  if (home) return path.join(home, 'boardgame.config.json')
  return path.join(__dirname, '..', '..', 'boardgame.config.json')
}

export function loadConfig() {
  let fileCfg = {}
  try { fileCfg = JSON.parse(fs.readFileSync(configPathNow(), 'utf8')) } catch { /* 缺省即可 */ }

  const env = process.env
  const pick = (envKey, fileKey, def) => {
    if (env[envKey] !== undefined && env[envKey] !== '') return env[envKey]
    if (fileCfg[fileKey] !== undefined && fileCfg[fileKey] !== '') return fileCfg[fileKey]
    return def
  }
  const num = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def }
  const boolFrom = (v, def) => {
    if (typeof v === 'boolean') return v
    const text = String(v == null ? '' : v).trim().toLowerCase()
    if (['1', 'true', 'on', 'yes'].includes(text)) return true
    if (['0', 'false', 'off', 'no'].includes(text)) return false
    return def
  }
  const maxTokens = Math.round(num(pick('AI_MAX_TOKENS', 'maxTokens', 10000), 10000))
  const maxTurnCalls = Math.round(num(pick('AI_MAX_TURN_CALLS', 'maxTurnCalls', 24), 24))
  const maxTokensCeiling = Math.round(num(pick('AI_MAX_TOKENS_CEILING', 'maxTokensCeiling', 65536), 65536))

  return {
    playerName: normalizePlayerName(fileCfg.playerName),
    playerAvatar: validPlayerAvatar(fileCfg.playerAvatar) ? (fileCfg.playerAvatar || '👤') : '👤',
    baseUrl: pick('AI_BASE_URL', 'baseUrl', 'https://api.deepseek.com/v1'),
    apiKey: pick('AI_API_KEY', 'apiKey', ''),
    model: pick('AI_MODEL', 'model', 'deepseek-flash'),
    temperature: num(pick('AI_TEMPERATURE', 'temperature', 0.7), 0.7),
    // 可选采样参数；<=0 时不写入请求体，由后端决定。
    topP: num(pick('AI_TOP_P', 'topP', 0), 0),
    // 结构化输出：auto = 先试 response_format=json_object，后端不支持则自动降级并记住；
    // on = 始终下发；off = 从不下发（纯靠提示词约束 JSON）。
    jsonMode: normalizeJsonMode(pick('AI_JSON_MODE', 'jsonMode', 'auto')),
    maxRetries: Math.max(1, Math.round(num(pick('AI_MAX_RETRIES', 'maxRetries', 3), 3))),
    timeoutMs: num(pick('AI_TIMEOUT_MS', 'timeoutMs', 60000), 60000),
    // 单个 AI 回合的墙钟预算（毫秒）；<=0 表示不限制（只剩 timeoutMs x maxTurnCalls 兜底）。
    turnTimeoutMs: Math.max(0, Math.round(num(pick('AI_TURN_TIMEOUT_MS', 'turnTimeoutMs', 120000), 120000))),
    // 单次请求的提示词预算（估算 token）；<=0 表示不限制。超出时优先丢弃更早的对话历史。
    maxPromptTokens: Math.max(0, Math.round(num(pick('AI_MAX_PROMPT_TOKENS', 'maxPromptTokens', 131072), 131072))),
    // 回合内记忆窗口：保留最近 N 步决策 + 当前步。调大它才能让 AI 记住更长的行动序列；
    // 真正的硬上限仍是 maxPromptTokens（token 预算超了会继续丢弃更早的对话）。
    memorySteps: Math.max(1, Math.round(num(pick('AI_MEMORY_STEPS', 'memorySteps', 2), 2))),
    // —— 战术交流与备忘（见 docs/tactical-chat-design.md）——
    chatEnabled: boolFrom(pick('AI_CHAT_ENABLED', 'chatEnabled', true), true),
    // 备忘软阈值条数（触发压缩）；压缩目标 = max(4, 2/3 * 该值)
    chatNotesMax: Math.max(4, Math.round(num(pick('AI_CHAT_NOTES_MAX', 'chatNotesMax', 12), 12))),
    // 单条发言字数上限
    chatMaxChars: Math.max(50, Math.round(num(pick('AI_CHAT_MAX_CHARS', 'chatMaxChars', 500), 500))),
    // 注入提示词的最近讨论条数
    chatWindow: Math.max(2, Math.round(num(pick('AI_CHAT_WINDOW', 'chatWindow', 8), 8))),
    // AI 回复冷却：上一条回复开始后 N 毫秒内的新发言只记录、不逐条排队回复（0 = 关闭）
    chatReplyCooldownMs: Math.max(0, Math.min(60000, Math.round(num(pick('AI_CHAT_REPLY_COOLDOWN_MS', 'chatReplyCooldownMs', 4000), 4000)))),
    // 单次模型调用的输出上限；<=0 表示不传该参数，由后端决定。
    maxTokens: maxTokens > 0 ? maxTokens : 0,
    // 推理型后端把 max_tokens 花在思考上时，content 会返回空。遇到这种情况把输出预算
    // 翻倍重试（reasoningRetries 次，单次上限 maxTokensCeiling），比原样重试有效得多。
    maxTokensCeiling: Math.max(1024, maxTokensCeiling),
    reasoningRetries: Math.max(0, Math.round(num(pick('AI_REASONING_RETRIES', 'reasoningRetries', 2), 2))),
    // 推理强度（OpenAI / DeepSeek 的 reasoning_effort）；空字符串表示不下发，由后端默认。
    // 棋类这种需要算路的场景建议 low；复杂剧本推理可以 high/max。
    reasoningEffort: normalizeReasoningEffort(pick('AI_REASONING_EFFORT', 'reasoningEffort', '')),
    // 单个 AI 回合内允许的模型调用总次数（含多步行动、重试与反馈）。
    // 回合内记忆让一次 AI 回合可以连续走多步，因此必须有总预算兜底。
    maxTurnCalls: Math.max(1, maxTurnCalls > 0 ? maxTurnCalls : 24),
  }
}

export function configPath() { return configPathNow() }

export function normalizePlayerName(value) {
  if (typeof value !== 'string') return 'player'
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 32).trim() || 'player'
}

// 上传图片由浏览器裁剪并压缩；只接受内嵌位图，避免保存临时 blob 地址。
export function validPlayerAvatar(value) {
  return typeof value === 'string' && (value === '' || value === '👤' || (
    value.length <= 700000 && /^data:image\/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ))
}

/** 归一化结构化输出模式，非法值回落到 auto。 */
function normalizeJsonMode(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase()
  if (['on', 'always', 'strict', 'json', 'true', '1'].includes(text)) return 'on'
  if (['off', 'none', 'never', 'false', '0'].includes(text)) return 'off'
  return 'auto'
}

/** 归一化推理强度；空或非法值表示「不下发，交给后端默认」。 */
function normalizeReasoningEffort(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase()
  return ['minimal', 'low', 'medium', 'high', 'max'].includes(text) ? text : ''
}

// 将部分配置写回 boardgame.config.json（仅覆盖传入的字段，其余保持不变）。
// 返回生效配置（仍遵循「环境变量 > 文件 > 默认值」的优先级）。
export function saveConfig(patch) {
  patch = patch || {}
  const file = configPathNow()
  let fileCfg = {}
  try { fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 缺省即可 */ }

  const next = { ...fileCfg }
  if (Object.hasOwn(patch, 'playerAvatar')) {
    if (!validPlayerAvatar(patch.playerAvatar)) throw new Error('头像必须是有效的 PNG、JPEG 或 WebP 图片，处理后不能超过 700KB')
    next.playerAvatar = patch.playerAvatar || '👤'
  }
  if (typeof patch.playerName === 'string') next.playerName = normalizePlayerName(patch.playerName)
  const setString = (key, value) => { if (typeof value === 'string' && value !== '') next[key] = value }
  setString('baseUrl', patch.baseUrl)
  setString('model', patch.model)
  setString('jsonMode', patch.jsonMode)
  if (typeof patch.reasoningEffort === 'string') next.reasoningEffort = normalizeReasoningEffort(patch.reasoningEffort)
  if (typeof patch.apiKey === 'string' && patch.apiKey !== '') next.apiKey = patch.apiKey
  if (typeof patch.chatEnabled === 'boolean') next.chatEnabled = patch.chatEnabled
  for (const key of ['temperature', 'topP', 'maxRetries', 'timeoutMs', 'maxTokens', 'maxTokensCeiling', 'reasoningRetries', 'maxTurnCalls', 'turnTimeoutMs', 'maxPromptTokens', 'memorySteps', 'chatNotesMax', 'chatMaxChars', 'chatWindow', 'chatReplyCooldownMs']) {
    if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) next[key] = patch[key]
  }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return loadConfig()
}

// 返回当前被环境变量覆盖的字段对应的环境变量名列表，供前端提示「界面修改不生效」。
export function envOverrides() {
  const env = process.env
  const map = [
    ['AI_BASE_URL', 'baseUrl'],
    ['AI_API_KEY', 'apiKey'],
    ['AI_MODEL', 'model'],
    ['AI_TEMPERATURE', 'temperature'],
    ['AI_TOP_P', 'topP'],
    ['AI_MAX_RETRIES', 'maxRetries'],
    ['AI_TIMEOUT_MS', 'timeoutMs'],
    ['AI_MAX_TOKENS', 'maxTokens'],
    ['AI_MAX_TOKENS_CEILING', 'maxTokensCeiling'],
    ['AI_REASONING_RETRIES', 'reasoningRetries'],
    ['AI_REASONING_EFFORT', 'reasoningEffort'],
    ['AI_MAX_TURN_CALLS', 'maxTurnCalls'],
    ['AI_JSON_MODE', 'jsonMode'],
    ['AI_TURN_TIMEOUT_MS', 'turnTimeoutMs'],
    ['AI_MAX_PROMPT_TOKENS', 'maxPromptTokens'],
    ['AI_MEMORY_STEPS', 'memorySteps'],
    ['AI_CHAT_ENABLED', 'chatEnabled'],
    ['AI_CHAT_NOTES_MAX', 'chatNotesMax'],
    ['AI_CHAT_MAX_CHARS', 'chatMaxChars'],
    ['AI_CHAT_WINDOW', 'chatWindow'],
    ['AI_CHAT_REPLY_COOLDOWN_MS', 'chatReplyCooldownMs'],
  ]
  return map.filter(([key]) => env[key] !== undefined && env[key] !== '').map(([key]) => key)
}
