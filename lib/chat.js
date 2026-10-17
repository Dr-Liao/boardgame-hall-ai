// 战术交流与备忘 · 纯函数层（无 IO、无网络、不依赖任何 Mod）
//
// 这里只做三件事，且全部可单测、可复现：
//   1. 可见性投影：私聊只对目标座位（和人类）可见；
//   2. 写入闸门：判断一句话值不值得变成「战术备忘」（本地硬规则）；
//   3. 备忘合并与压缩：去重、冲突覆盖、上限裁剪（确定性兜底）。
//
// 设计文档：docs/tactical-chat-design.md

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const NOTE_MAX_CHARS = 30          // 单条备忘字数上限
export const NOTES_SOFT_CHARS = 300       // 软阈值：合计字符数
export const NOTES_HARD_CHARS = 480       // 硬阈值：合计字符数
export const NOTES_HARD_MAX = 16          // 硬阈值：条数
export const NOTES_DEFAULT_MAX = 12       // 默认软阈值条数（可被 AI_CHAT_NOTES_MAX 覆盖）
export const NOTES_DEFAULT_TARGET = 8     // 压缩目标条数
export const SIMILAR_THRESHOLD = 0.7      // 相似度阈值：达到即视为同一条，走更新而非新增
export const OPS_PER_REPLY = 3            // 单次回复最多 add / update / remove 各 3 条

// 长时意图信号：命中才有资格写入备忘。
const LONG_TERM_SIGNAL = /记住|记一下|记下|别忘了|不要忘|以后|之后|每次|一直|优先|我们说好|说好了|约定|别再|不要再|下一关|下一回合|下一局|下次|从现在起|长期|always|from now on|remember|never again/i
// 即时限定：一旦出现就判定为「局内临时目标」，不进长期记忆。
const IMMEDIATE_LIMIT = /这一手|这一步|这回合|本回合|当前回合|现在就|立刻|马上|眼下|暂时/i
// 确认型发言：由若干「同意词」拼接而成（如「好，就按你说的」），需要上一句 AI 发言作为语境。
const AGREEMENT_TOKEN = /(好|行|可以|没问题|同意|赞成|就按你说的|就这么办|就这么定了|按你说的|听你的|那就这样|就这样|ok|okay|sure)/gi

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 去掉换行、折叠空白，并按字符数（码点）截断。 */
export function clampNoteText(text, max = NOTE_MAX_CHARS) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const chars = Array.from(flat)
  return chars.length > max ? chars.slice(0, max).join('') : flat
}

/** 玩家发言的长度上限；超长截断，避免一次灌爆提示词。 */
export function clampChatText(text, max = 500) {
  const flat = String(text == null ? '' : text).replace(/\r/g, '').trim()
  if (!flat) return ''
  const chars = Array.from(flat)
  return chars.length > max ? chars.slice(0, max).join('') : flat
}

/** 全角转半角 + 去标点空白 + 小写，用于判重（不用于展示）。 */
export function normalizeNoteText(text) {
  const half = String(text == null ? '' : text).replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  return half.replace(/[\s，。、；：！？,.;:!?（）()「」『』【】"'`~～\-—_]/g, '').toLowerCase().trim()
}

function bigrams(text) {
  const set = new Set()
  const s = normalizeNoteText(text)
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2))
  return set
}

function overlaps(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return { jaccard: 0, containment: 0 }
  let inter = 0
  for (const gram of A) if (B.has(gram)) inter++
  return {
    jaccard: inter / (A.size + B.size - inter),
    containment: inter / Math.min(A.size, B.size),
  }
}

/** 字符二元组 Jaccard 相似度（对中文比按词切分更稳）。 */
export function noteSimilarity(a, b) {
  return overlaps(a, b).jaccard
}

/**
 * 是否应视为同一条备忘（本地判重）。
 * 只负责「字面近重复」：完全相等、互为包含、或高度重叠。
 * 语义层面的合并（换个说法表达同一策略）交给模型 —— 它在提示词里能看到现有备忘的 id。
 */
export function noteDuplicate(a, b) {
  const na = normalizeNoteText(a)
  const nb = normalizeNoteText(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  const { jaccard, containment } = overlaps(a, b)
  return jaccard >= SIMILAR_THRESHOLD || containment >= 0.8
}

// ---------------------------------------------------------------------------
// 可见性
// ---------------------------------------------------------------------------

/**
 * 按观察座位过滤聊天事件；非 chat 事件原样保留。
 * - 公开桌聊（to == null）：所有人可见
 * - 私聊（to == AI 座位）：这是一个「人类 ↔ 该 AI」的频道，
 *   频道成员 = 人类座位 + 目标座位 + 发言者本人（私聊回复的 to 也是目标座位）。
 * - 没有观察者（seat 非整数）时保守处理：私聊一律不外泄
 *
 * @param {number} humanSeat 人类座位（本项目中恒为 0，见 lib/server.js 的 buildPlayers）
 */
export function visibleChat(events, seat, humanSeat = 0) {
  if (!Array.isArray(events)) return []
  const observer = Number.isInteger(seat) ? seat : null
  return events.filter((event) => {
    if (!event || event.type !== 'chat') return true
    if (Array.isArray(event.participants)) return event.participants.includes(observer)
    const to = event.to == null ? null : Number(event.to)
    if (to === null) return true
    if (observer === null) return false
    if (observer === humanSeat) return true
    return to === observer || event.seat === observer
  })
}

/** 该座位应该看到的聊天记录（按 seq 排序）。 */
export function chatLogFor(events, seat) {
  return visibleChat(events, seat).filter((event) => event && event.type === 'chat')
}

// ---------------------------------------------------------------------------
// 写入闸门
// ---------------------------------------------------------------------------

/** 是否含有「长期意图」信号（且不含即时限定）。 */
export function isLongTermUtterance(text) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, '')
  if (!flat) return false
  if (IMMEDIATE_LIMIT.test(flat)) return false
  return LONG_TERM_SIGNAL.test(flat)
}

/** 是否是「好，就按你说的」这类确认发言（需结合上一条 AI 发言）。 */
export function isConfirmationUtterance(text, previous) {
  const flat = String(text == null ? '' : text).replace(/[\s！。,.，、~～!?？]/g, '')
  if (!flat) return false
  // 去掉所有同意词后必须什么都不剩，才算纯确认发言
  if (flat.replace(AGREEMENT_TOKEN, '').length > 0) return false
  // 必须紧跟一条 AI 的公开/私聊发言，且该发言不是空话
  return !!(previous && previous.type === 'chat' && Number.isInteger(previous.seat) && previous.seat > 0 && String(previous.text || '').trim().length >= 4)
}

/**
 * 是否允许把这次回复里的 memory 落库。
 * 只有玩家发言能触发；AI 自己的话永远不能自动变成约定。
 */
export function canWriteMemory(playerText, previousEvent) {
  return isLongTermUtterance(playerText) || isConfirmationUtterance(playerText, previousEvent)
}

// ---------------------------------------------------------------------------
// 备忘集合
// ---------------------------------------------------------------------------

export function nextNoteId(notes) {
  let max = 0
  for (const note of notes || []) {
    const match = /^n(\d+)$/.exec(note && note.id ? note.id : '')
    if (match) max = Math.max(max, Number(match[1]))
  }
  return 'n' + (max + 1)
}

export function notesChars(notes) {
  return (notes || []).reduce((sum, note) => sum + String(note && note.text ? note.text : '').length, 0)
}

/** 该座位应被注入的备忘：公开（team）+ 自己的私聊（seat）。 */
export function pickNotesForSeat(notes, seat) {
  return (notes || []).filter((note) => {
    if (!note || !note.text) return false
    if (note.scope === 'seat') return note.seat === seat
    return true
  })
}

/** 分组：team 一组，每个私聊座位各一组 —— 压缩时必须分组，否则私聊会串进公开层。 */
export function groupNotes(notes) {
  const groups = []
  const byKey = new Map()
  for (const note of notes || []) {
    if (!note || !note.text) continue
    const isSeat = note.scope === 'seat' && Number.isInteger(note.seat)
    const key = isSeat ? 'seat:' + note.seat : 'team'
    if (!byKey.has(key)) {
      const group = { key, scope: isSeat ? 'seat' : 'team', seat: isSeat ? note.seat : null, notes: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    byKey.get(key).notes.push(note)
  }
  return groups
}

export function notesMaxFrom(configMax) {
  const value = Number(configMax)
  return Number.isFinite(value) && value >= 4 ? Math.round(value) : NOTES_DEFAULT_MAX
}

export function notesTargetFrom(configMax) {
  return Math.max(4, Math.round(notesMaxFrom(configMax) * 2 / 3))
}

export function needsCompaction(notes, max = NOTES_DEFAULT_MAX) {
  const count = (notes || []).length
  return count > notesMaxFrom(max) || notesChars(notes) > NOTES_SOFT_CHARS
}

export function overHardLimit(notes) {
  return (notes || []).length > NOTES_HARD_MAX || notesChars(notes) > NOTES_HARD_CHARS
}

/**
 * 确定性裁剪：与模型无关，同输入必得同输出（可复现）。
 * 顺序：先剔除无效条目 → 按 updatedAt 升序丢最久未更新的（同值按 id 字典序）→ 按 createdAt 重排。
 */
export function compactDeterministic(notes, target = NOTES_DEFAULT_TARGET) {
  const clean = (notes || []).filter((note) => note && note.id && typeof note.text === 'string' && note.text.trim())
  const ascending = clean.slice().sort((a, b) => ((a.updatedAt || 0) - (b.updatedAt || 0)) || String(a.id).localeCompare(String(b.id)))
  const dropped = Math.max(0, ascending.length - Math.max(1, target))
  const kept = ascending.slice(dropped)
  kept.sort((a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) || String(a.id).localeCompare(String(b.id)))
  return { notes: kept, dropped }
}

/** 按 createdAt（同值按 id）稳定排序，保证注入顺序可复现。 */
export function sortNotes(notes) {
  return (notes || []).slice().sort((a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) || String(a.id).localeCompare(String(b.id)))
}

/**
 * 应用一次回复里的 memory 操作，返回新集合与计数。
 * ctx: { scope:'team'|'seat', seat, evidence, origin:'auto'|'manual', now }
 */
export function mergeNotes(notes, ops, ctx = {}) {
  const result = { notes: (notes || []).slice(), added: 0, updated: 0, removed: 0 }
  const scope = ctx.scope === 'seat' ? 'seat' : 'team'
  const seat = scope === 'seat' && Number.isInteger(ctx.seat) ? ctx.seat : null
  if (scope === 'seat' && seat === null) return result
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now()
  const evidence = Number.isInteger(ctx.evidence) ? ctx.evidence : null
  const origin = ctx.origin === 'manual' ? 'manual' : 'auto'
  const inScope = (note) => {
    if (!note) return false
    if (note.scope === 'seat') return scope === 'seat' && note.seat === seat
    return scope === 'team'
  }

  // 1) 删除（只能删本作用域内的条目，私聊删不掉公开备忘）
  const removeIds = new Set((Array.isArray(ops && ops.remove) ? ops.remove : []).slice(0, OPS_PER_REPLY).filter((id) => typeof id === 'string'))
  if (removeIds.size) {
    const kept = []
    for (const note of result.notes) {
      if (inScope(note) && removeIds.has(note.id)) { result.removed++; continue }
      kept.push(note)
    }
    result.notes = kept
  }

  // 2) 更新
  for (const op of (Array.isArray(ops && ops.update) ? ops.update : []).slice(0, OPS_PER_REPLY)) {
    if (!op || typeof op.text !== 'string') continue
    const text = clampNoteText(op.text)
    if (!text) continue
    const note = result.notes.find((item) => item.id === op.id && inScope(item))
    if (!note) continue
    if (note.text !== text) { note.text = text; note.updatedAt = now; result.updated++ }
    if (evidence != null) note.evidence = evidence
  }

  // 3) 新增（先做精确/相似判重，相似则升级为更新）
  for (const raw of (Array.isArray(ops && ops.add) ? ops.add : []).slice(0, OPS_PER_REPLY)) {
    if (typeof raw !== 'string') continue
    const text = clampNoteText(raw)
    if (!text) continue
    const normalized = normalizeNoteText(text)
    let duplicate = null
    for (const note of result.notes) {
      if (!inScope(note)) continue
      if (normalizeNoteText(note.text) === normalized) { duplicate = { kind: 'exact', note }; break }
      if (!duplicate && noteDuplicate(note.text, text)) duplicate = { kind: 'similar', note }
    }
    if (duplicate) {
      if (duplicate.kind === 'similar' && duplicate.note.text !== text) {
        duplicate.note.text = text
        duplicate.note.updatedAt = now
        if (evidence != null) duplicate.note.evidence = evidence
        result.updated++
      }
      continue
    }
    result.notes.push({
      id: nextNoteId(result.notes), text, scope, seat, origin,
      evidence, createdAt: now, updatedAt: now,
    })
    result.added++
  }

  result.notes = sortNotes(result.notes)
  return result
}

/** 手工钉住（O4）：直接用一段文本生成一条备忘，走同一套判重。 */
export function pinNote(notes, text, ctx = {}) {
  return mergeNotes(notes, { add: [text], update: [], remove: [] }, { ...ctx, origin: 'manual' })
}
