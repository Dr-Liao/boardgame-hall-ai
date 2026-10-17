import { normalizePlan } from './plans.js'
// 解码模型输出：从自由文本里稳健地提取 JSON 对象。
//
// 两个消费者：
//   - parseAgentReply  决策步：{"move": <任意>, "speech": "<台词>"}
//   - parseChatReply   战术讨论：{"reply": "<台词>", "memory": {add,update,remove}}
//
// 两个解析器共用同一套「去代码块包裹 + 取首尾大括号」的稳健提取逻辑。

/** 从自由文本里提取第一个 JSON 对象。返回 { obj } 或 { error }。 */
export function extractJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: '输出为空' }
  let s = text.trim()
  // 去掉可能的 markdown 代码块包裹
  s = s.replace(/```(?:json|JSON)?\s*/g, '').replace(/```\s*$/g, '').trim()

  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return { error: '未找到 JSON 对象' }

  let obj
  try { obj = JSON.parse(s.slice(start, end + 1)) } catch (e) { return { error: String(e && e.message ? e.message : e) } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'JSON 根不是对象' }
  return { obj }
}

export function parseAgentReply(text) {
  const extracted = extractJsonObject(text)
  if (extracted.error) return { error: extracted.error }
  const obj = extracted.obj
  if (obj.move == null) return { error: '缺少 move 字段' }

  const speech = typeof obj.speech === 'string' ? obj.speech.trim() : ''
  const plan = normalizePlan(obj.plan)
  return { move: obj.move, speech, ...(plan ? { plan } : {}) }
}

const MEMORY_MAX_PER_OP = 3

/** 只保留结构正确的记忆操作，并限制单次数量（防止一次灌爆）。 */
function normalizeMemoryOps(raw) {
  const memory = { add: [], update: [], remove: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return memory
  if (Array.isArray(raw.add)) {
    memory.add = raw.add
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
      .slice(0, MEMORY_MAX_PER_OP)
  }
  if (Array.isArray(raw.update)) {
    memory.update = raw.update
      .filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id.trim() && typeof item.text === 'string' && item.text.trim())
      .map((item) => ({ id: item.id.trim(), text: item.text.trim() }))
      .slice(0, MEMORY_MAX_PER_OP)
  }
  if (Array.isArray(raw.remove)) {
    memory.remove = raw.remove
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
      .slice(0, MEMORY_MAX_PER_OP)
  }
  return memory
}

/** 解析一次战术讨论的回复。reply 为空且无任何记忆操作时视为无效输出。 */
export function parseChatReply(text) {
  const extracted = extractJsonObject(text)
  if (extracted.error) return { error: extracted.error }
  const obj = extracted.obj

  const reply = typeof obj.reply === 'string' ? obj.reply.trim() : ''
  const memory = normalizeMemoryOps(obj.memory)
  const hasMemory = memory.add.length + memory.update.length + memory.remove.length > 0
  if (!reply && !hasMemory) return { error: '缺少 reply 字段' }
  return { reply, memory }
}

export function parseReactionReply(text) {
  const extracted = extractJsonObject(text)
  if (extracted.error) return { error: extracted.error }
  const reply = typeof extracted.obj.reply === 'string' ? extracted.obj.reply.trim() : ''
  if (!reply) return { error: '缺少 reply 字段' }
  return { reply }
}
