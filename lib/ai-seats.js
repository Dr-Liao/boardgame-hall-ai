// 大厅 AI 座位分配（服务端纯函数）
//
// 一局里同一个 AI 只能出现一次：随机补位与手动选角共用这里的规则，
// 唯一性同时按 id 和名字判断（AI 名单里可能有同名但不同 id 的角色）。
// 浏览器端 public/ai-seats.js 用同样的规则禁用「已上场」的选项；
// 这里的分配结果是权威值，旧客户端传上来的重复选择会被改派给还没上场的 AI。

export const RANDOM_AI = '__random__'

/** AI 名字的唯一性键：去掉首尾空白、忽略大小写。 */
export function aiNameKey(ai) {
  return String(ai?.name || '').trim().toLowerCase()
}

/**
 * AI 名单去重：同一 id 或同一名字只保留第一个。
 * 随机座位只会从这里挑角色，因此不会随机出两个同名 AI。
 */
export function uniqueAiList(list) {
  const out = []
  const ids = new Set()
  const names = new Set()
  for (const ai of Array.isArray(list) ? list : []) {
    if (!ai || !ai.id) continue
    const name = aiNameKey(ai)
    if (ids.has(ai.id) || (name && names.has(name))) continue
    ids.add(ai.id)
    if (name) names.add(name)
    out.push(ai)
  }
  return out
}

/**
 * 给 count 个 AI 座位分配互不相同的角色（按 id 和名字去重）。
 *
 * - requested 与座位一一对应：`null` / `''` / `'__random__'` 表示该座位随机；
 * - 先落实所有有效的手动选择，再从剩下的角色里随机补位，避免随机座位抢走后面手动选的 AI；
 * - 重复选择、同名角色和已不存在的 AI 都按随机处理（不抛错，兼容旧客户端/旧设置）；
 * - 角色数量不够时抛 AI_POOL_EXHAUSTED：宁可让玩家补角色，也不让同名 AI 坐两席。
 *
 * @param {Array} ais 大厅 AI 名单
 * @param {number} count 需要的 AI 座位数
 * @param {Array<string|null|undefined>} [requested] 每个座位的选择
 * @returns {Array<object>} 与座位等长的 AI 对象
 */
export function assignUniqueAis(ais, count, requested = []) {
  const total = Math.max(0, Math.trunc(Number(count) || 0))
  const list = Array.isArray(ais) ? ais : []
  const pool = uniqueAiList(list)
  const picks = new Array(total).fill(null)
  const usedIds = new Set()
  const usedNames = new Set()

  function isFree(ai) {
    if (!ai || !ai.id) return false
    const name = aiNameKey(ai)
    return !usedIds.has(ai.id) && !(name && usedNames.has(name))
  }

  function take(index, ai) {
    picks[index] = ai
    usedIds.add(ai.id)
    const name = aiNameKey(ai)
    if (name) usedNames.add(name)
  }

  // 先按座位顺序落实有效的手动选择；重复/同名/未知的 id 留到随机补位。
  for (let i = 0; i < total; i++) {
    const id = Array.isArray(requested) ? requested[i] : undefined
    if (id == null || id === '' || id === RANDOM_AI) continue
    const ai = list.find((item) => item && item.id === id)
    if (!ai || !isFree(ai)) continue
    take(i, ai)
  }

  // 其余座位从还没上场的角色里随机。候选池按名字去重，所以不会撞名。
  for (let i = 0; i < total; i++) {
    if (picks[i]) continue
    const free = pool.filter(isFree)
    if (!free.length) {
      const error = new Error(
        'AI 角色不足：本局需要 ' + total + ' 个不同的 AI，大厅当前只有 ' + pool.length
        + ' 个（同名角色只算一个）。请先在「设置 → AI」中新增 AI 角色。',
      )
      error.code = 'AI_POOL_EXHAUSTED'
      throw error
    }
    take(i, free[Math.floor(Math.random() * free.length)])
  }
  return picks
}
