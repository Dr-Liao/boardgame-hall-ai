// 提示词体量估算（零依赖、无分词器）。
//
// 目的不是精确计费，而是给「上下文预算」一个稳定的量纲：
//   - 中文/全角字符按 1 token 估（主流 BPE 对 CJK 多为 0.6~1.2，取偏保守值）；
//   - 其余字符按 4 字符 1 token 估（接近英文经验值）。
// 保守高估是刻意的：宁可提前剪枝，也不要撞到后端的上下文上限或账单。

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/** 估算一整段 messages 的输入 token（含每条消息的固定开销）。 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    if (!message) continue
    total += 4 + estimateTokens(message.content)
    if (typeof message.role === 'string') total += 1
  }
  return total
}