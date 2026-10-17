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
  const usage = {}
  if (Number.isFinite(prompt)) usage.promptTokens = prompt
  if (Number.isFinite(completion)) usage.completionTokens = completion
  if (Number.isFinite(total)) usage.totalTokens = total
  return Object.keys(usage).length ? usage : null
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

/** 仅供测试使用：清空 json_object 支持情况缓存。 */
export function resetJsonModeCache() {
  jsonObjectSupport.clear()
  jsonModeWarned.clear()
}

async function requestOnce(messages, config, jsonObject) {
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
    if (Number.isFinite(config.maxTokens) && config.maxTokens > 0) payload.max_tokens = config.maxTokens
    if (jsonObject) payload.response_format = { type: 'json_object' }
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
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回为空')
    return {
      text: content.trim(),
      usage: normalizeUsage(data.usage),
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
  try {
    return await requestOnce(messages, config, wantJson)
  } catch (err) {
    if (wantJson && ((config && config.jsonMode) || 'auto') !== 'on' && unsupportedJsonMode(err)) {
      markJsonUnsupported(config)
      return await requestOnce(messages, config, false)
    }
    throw err
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
