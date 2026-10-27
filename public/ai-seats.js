// 大厅 AI 座位去重（浏览器端纯函数，无 DOM 依赖）
//
// 规则与服务端 lib/ai-seats.js 一致：一局里同一个 AI（id 或名字相同）只能坐一个座位。
// 这里负责两件事：
//   1. 把默认设置/旧状态里的重复选择就地改成「随机 AI」；
//   2. 给下拉框标出「已经被其他座位选走」的角色，禁用它们，避免玩家选到重复的 AI。

export const RANDOM_AI = '__random__'
export const HUMAN_SEAT = '__human__'

/** AI 名字的唯一性键：去掉首尾空白、忽略大小写。 */
export function aiNameKey(ai) {
  return String(ai?.name || '').trim().toLowerCase()
}

/** 下拉框候选：只去掉重复 id，保留名单原样（同名角色仍然显示，但会被互斥禁用）。 */
export function aiChoices(list) {
  const out = []
  const ids = new Set()
  for (const ai of Array.isArray(list) ? list : []) {
    if (!ai || !ai.id || ids.has(ai.id)) continue
    ids.add(ai.id)
    out.push(ai)
  }
  return out
}

/**
 * 座位选择去重：保留第一个出现的 AI，后面重复的（同 id 或同名）改成随机。
 * null/undefined/'' 原样保留：联机新座位借此保持「等待玩家加入」的默认值。
 * 已不存在的 AI 也改成随机，避免 <select> 回落到第一项造成误选。
 */
export function dedupeSeatChoices(values, list) {
  const choices = aiChoices(list)
  const ids = new Set()
  const names = new Set()
  return (Array.isArray(values) ? values : []).map(value => {
    if (value == null || value === '') return value
    if (value === RANDOM_AI || value === HUMAN_SEAT) return value
    const ai = choices.find(item => item.id === value)
    if (!ai) return RANDOM_AI
    const name = aiNameKey(ai)
    if (ids.has(ai.id) || (name && names.has(name))) return RANDOM_AI
    ids.add(ai.id)
    if (name) names.add(name)
    return ai.id
  })
}

/** 当前座位可选的 AI：其他座位已经选走的角色标记 used=true（同名同样算被占用）。 */
export function seatAiChoices(list, values, index) {
  const choices = aiChoices(list)
  const ids = new Set()
  const names = new Set()
  ;(Array.isArray(values) ? values : []).forEach((value, i) => {
    if (i === index || value == null || value === RANDOM_AI || value === HUMAN_SEAT) return
    const ai = choices.find(item => item.id === value)
    if (!ai) return
    ids.add(ai.id)
    const name = aiNameKey(ai)
    if (name) names.add(name)
  })
  return choices.map(ai => {
    const name = aiNameKey(ai)
    return { ...ai, used: ids.has(ai.id) || !!(name && names.has(name)) }
  })
}
