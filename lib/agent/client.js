// LLM 客户端：调用 OpenAI 兼容的 /chat/completions。
// 使用 Node 内置 fetch（Node 18+），零依赖。
//
// 返回值：{ text, usage, model, latencyMs }
//   - text     模型回复正文（已 trim）
//   - usage    后端返回的 token 用量（可能为 null），供决策日志统计
//   - model    后端实际使用的模型名（可能为 null）
//   - latencyMs 本次调用耗时

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const prompt = Number(raw.prompt_tokens)
  const completion = Number(raw.completion_tokens)
  const total = Number(raw.total_tokens)
  const reasoning = Number(raw.completion_tokens_details && raw.completion_tokens_details.reasoning_tokens)
  const usage = {}
  if (Number.isFinite(prompt)) usage.promptTokens = prompt
  if (Number.isFinite(completion)) usage.completionTokens = completion
  if (Number.isFinite(total)) usage.totalTokens = total
  if (Number.isFinite(reasoning)) usage.reasoningTokens = reasoning
  return Object.keys(usage).length ? usage : null
}

/** 回复正文可能是字符串，也可能是 [{type:'text',text}] 这样的分段数组。 */
function extractContent(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')))
      .join('')
      .trim()
    return text
  }
  return ''
}

// 推理型后端（如 DeepSeek 的 flash / pro）会先把 max_tokens 花在「思考」上。
// 思考没写完就到了上限时，content 会返回空字符串且 finish_reason='length'。
// 这种失败原样重试几乎必然再失败，所以这里把输出预算翻倍再试，最多两次。
const DEFAULT_MAX_TOKENS_CEILING = 65536
const DEFAULT_REASONING_RETRIES = 2

function budgetFor(config, attempt) {
  const base = Number(config && config.maxTokens) > 0 ? Number(config.maxTokens) : 0
  const ceiling = Number(config && config.maxTokensCeiling) > 0 ? Number(config.maxTokensCeiling) : DEFAULT_MAX_TOKENS_CEILING
  if (attempt <= 0) return base > 0 ? Math.min(base, ceiling) : 0
  const next = base > 0 ? base * Math.pow(2, attempt) : 16384 * attempt
  return Math.max(1, Math.min(ceiling, Math.round(next)))
}

function reasoningRetries(config) {
  const value = Number(config && config.reasoningRetries)
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_REASONING_RETRIES
}


// json_object 支持情况的进程内记忆：key = baseUrl|model。
// auto 模式下后端一旦表示不支持 response_format，就记住并在后续请求中不再下发，
// 避免每次都先打一次注定失败的请求。
const jsonObjectSupport = new Map()
const jsonModeWarned = new Set()

function jsonKey(config) {
  return String((config && config.baseUrl) || '') + '|' + String((config && config.model) || '')
}

function jsonModeEnabled(config, options) {
  if (!options || options.json !== true) return false
  const mode = (config && config.jsonMode) || 'auto'
  if (mode === 'off') return false
  if (mode === 'on') return true
  return jsonObjectSupport.get(jsonKey(config)) !== false
}

/** 后端是否是因为「不认识 response_format / json_object」而报错。 */
function unsupportedJsonMode(err) {
  const message = String(err && err.message ? err.message : err)
  return /response_format|json_object|json mode/i.test(message) && /\bHTTP 4\d\d\b/.test(message)
}

function markJsonUnsupported(config) {
  const key = jsonKey(config)
  if (jsonObjectSupport.get(key) === false) return
  jsonObjectSupport.set(key, false)
  if (!jsonModeWarned.has(key)) {
    jsonModeWarned.add(key)
    console.warn('  [agent] 后端不支持 response_format=json_object，已自动降级为提示词约束 JSON（' + key + '）')
  }
}

// reasoning_effort 支持情况的进程内记忆：不是所有 OpenAI 兼容后端都认这个参数，
// 一旦被拒就记住，后续请求不再下发，避免每次都白打一次失败请求。
const reasoningEffortSupport = new Map()
const reasoningEffortWarned = new Set()

/** 本次请求实际要下发的 reasoning_effort；空字符串表示不下发。 */
function reasoningEffortFor(config) {
  const value = config && config.reasoningEffort
  if (typeof value !== 'string' || !value) return ''
  if (reasoningEffortSupport.get(jsonKey(config)) === false) return ''
  return value
}

/** 后端是否因为不认识 reasoning_effort 而报错。 */
function unsupportedReasoningEffort(err) {
  const message = String(err && err.message ? err.message : err)
  return /reasoning_effort|reasoning effort/i.test(message) && /\bHTTP 4\d\d\b/.test(message)
}

function markReasoningEffortUnsupported(config) {
  const key = jsonKey(config)
  if (reasoningEffortSupport.get(key) === false) return
  reasoningEffortSupport.set(key, false)
  if (!reasoningEffortWarned.has(key)) {
    reasoningEffortWarned.add(key)
    console.warn('  [agent] 后端不支持 reasoning_effort，已忽略该设置（' + key + '）')
  }
}

/** 仅供测试使用：清空 json_object 支持情况缓存。 */
export function resetJsonModeCache() {
  jsonObjectSupport.clear()
  jsonModeWarned.clear()
  reasoningEffortSupport.clear()
  reasoningEffortWarned.clear()
}

async function requestOnce(messages, config, jsonObject, maxTokensOverride) {
  const url = String(config.baseUrl).replace(/\/+$/, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || 60000)
  const startedAt = Date.now()
  try {
    const payload = {
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: false,
    }
    if (Number.isFinite(config.topP) && config.topP > 0) payload.top_p = config.topP
    const maxTokens = Number.isFinite(maxTokensOverride) ? maxTokensOverride : config.maxTokens
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens
    if (jsonObject) payload.response_format = { type: 'json_object' }
    const reasoningEffort = reasoningEffortFor(config)
    if (reasoningEffort) payload.reasoning_effort = reasoningEffort
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (config.apiKey || ''),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300))
    const data = JSON.parse(text)
    const choice = data && data.choices && data.choices[0]
    const message = choice && choice.message
    const content = extractContent(message && message.content)
    const usage = normalizeUsage(data.usage)
    const finish = choice && choice.finish_reason
    // finish_reason=length 表示输出被 max_tokens 截断：JSON 一定不完整，
    // 与其把半截回复交给上层做解析失败重试，不如在这里换更大的预算重来。
    if (!content || finish === 'length') {
      const reasoning = typeof (message && message.reasoning_content) === 'string' ? message.reasoning_content.trim() : ''
      const apiError = data && data.error && (data.error.message || data.error.type)
      const tokens = usage && usage.reasoningTokens ? '，思考 ' + usage.reasoningTokens + ' tokens' : ''
      const err = new Error(
        apiError ? '模型返回错误：' + String(apiError).slice(0, 200)
          : finish === 'length'
            ? (content ? '模型输出被输出预算截断（finish_reason=length' + tokens + '）'
              : '模型思考占满了输出预算（finish_reason=length' + tokens + '）')
            : '模型返回为空（finish_reason=' + (finish || 'unknown') + '）')
      err.code = (finish === 'length' || reasoning) ? 'REASONING_LIMIT' : 'EMPTY_REPLY'
      err.finishReason = finish
      err.reasoningTokens = usage && usage.reasoningTokens
      throw err
    }
    return {
      text: content,
      usage,
      model: typeof data.model === 'string' ? data.model : null,
      latencyMs: Date.now() - startedAt,
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('模型调用超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调用 chat/completions。
 * @param {object} [options] { json: true } 表示这次要的是严格 JSON 决策：
 *   jsonMode=auto（默认）时优先下发 response_format=json_object，后端不支持会降级重试一次；
 *   jsonMode=on 时始终下发；off 时从不下发。testConnection 等非 JSON 场景不传 options。
 * @returns {{text: string, usage: object|null, model: string|null, latencyMs: number}}
 */
export async function chatCompletion(messages, config, options) {
  const wantJson = jsonModeEnabled(config, options)
  const retries = reasoningRetries(config)
  let attempt = 0
  let json = wantJson
  while (true) {
    try {
      return await requestOnce(messages, config, json, budgetFor(config, attempt))
    } catch (err) {
      // 推理把输出预算吃光：把预算翻倍再试，比原样重试有效得多。
      if (err && err.code === 'REASONING_LIMIT' && attempt < retries) {
        attempt++
        continue
      }
      // 后端不认识 response_format=json_object：降级为「只在提示词里约束 JSON」。
      if (json && ((config && config.jsonMode) || 'auto') !== 'on' && unsupportedJsonMode(err)) {
        markJsonUnsupported(config)
        json = false
        attempt = 0
        continue
      }
      // 后端不认识 reasoning_effort：记住并去掉该参数重试。
      if (reasoningEffortFor(config) && unsupportedReasoningEffort(err)) {
        markReasoningEffortUnsupported(config)
        attempt = 0
        continue
      }
      throw err
    }
  }
}

// 拉取 OpenAI 兼容的 GET /models 列表，返回模型 id 数组。
export async function listModels(config) {
  const url = String(config.baseUrl).replace(/\/+$/, '') + '/models'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || 15000)
  try {
    const res = await fetch(url, {
      headers: { authorization: 'Bearer ' + (config.apiKey || '') },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300))
    const data = JSON.parse(text)
    const list = data && data.data
    if (!Array.isArray(list)) throw new Error('模型列表格式异常')
    return list.map((m) => m && m.id).filter((id) => typeof id === 'string' && id)
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('获取模型列表超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 用一条最小请求验证连通性，返回模型回复与耗时。
export async function testConnection(config) {
  const start = Date.now()
  const result = await chatCompletion([
    { role: 'user', content: '请只回复「连接成功」四个字，不要任何其他内容。' },
  ], config)
  return { reply: result.text, latencyMs: Date.now() - start, model: config.model }
}
