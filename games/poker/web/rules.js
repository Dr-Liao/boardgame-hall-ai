// 掼蛋的出牌判定。牌面 rank: 2..14, 15/16 为小/大王。
export const RANK_TEXT = Object.freeze({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '小王', 16: '大王' })
export const cardText = card => card.rank >= 15 ? RANK_TEXT[card.rank] : `${card.suit}${RANK_TEXT[card.rank] || card.rank}`
export const cardOrder = (a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit) || a.copy - b.copy

export function deck() {
  const cards = []
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of ['♠', '♥', '♣', '♦']) for (let rank = 2; rank <= 14; rank++) {
      cards.push({ id: `${copy}-${suit}-${rank}`, copy, suit, rank })
    }
    cards.push({ id: `${copy}-small`, copy, suit: '', rank: 15 })
    cards.push({ id: `${copy}-big`, copy, suit: '', rank: 16 })
  }
  return cards
}

export function singleStrength(rank, level) { return rank === level ? 15 : rank >= 15 ? rank + 1 : rank }
function result(type, rank, count, level, extra = 0) {
  const tier = type === 'jokerBomb' ? 100 : type === 'straightFlush' ? 55 : type === 'bomb' ? count * 10 : 0
  const sequence = ['straight', 'pairs', 'triples', 'straightFlush'].includes(type)
  return { type, rank, count, power: tier * 100 + (sequence ? rank : singleStrength(rank, level)) + extra / 100 }
}

function sequences(counts, length, each, wild) {
  // A2345 特例允许 A 作 1；其他顺子最高到 A。
  const tops = []
  for (let start = 1; start <= 15 - length; start++) {
    let needed = 0
    for (let r = start; r < start + length; r++) needed += Math.max(0, each - (counts.get(r === 1 ? 14 : r) || 0))
    if (needed !== wild) continue
    const allowed = new Set(Array.from({ length }, (_, i) => start + i === 1 ? 14 : start + i))
    if ([...counts.keys()].every(r => allowed.has(r) && (counts.get(r) || 0) <= each)) tops.push(start + length - 1)
  }
  return tops
}

export function classifyOptions(cards, level = 2) {
  if (!cards?.length) return []
  const n = cards.length
  if (n === 1 && cards[0].rank === level && cards[0].suit === '♥') return [result('single', level, 1, level)]
  if (n === 4 && cards.every(c => c.rank >= 15)) return [result('jokerBomb', 16, n, level)]
  const wild = cards.filter(c => c.rank === level && c.suit === '♥')
  const plain = cards.filter(c => !wild.includes(c))
  const counts = new Map()
  for (const c of plain) counts.set(c.rank, (counts.get(c.rank) || 0) + 1)
  const candidates = []
  const same = (size, type) => {
    if (n !== size) return
    for (let rank = 2; rank <= 16; rank++) {
      if (rank >= 15 && wild.length) continue
      if ([...counts.keys()].every(r => r === rank) && (counts.get(rank) || 0) + wild.length === size) candidates.push(result(type, rank, n, level))
    }
  }
  same(1, 'single'); same(2, 'pair'); same(3, 'triple')
  if (n >= 4 && n <= 10) same(n, 'bomb')
  if (n === 5) {
    for (let rank = 2; rank <= 14; rank++) for (let pair = 2; pair <= 14; pair++) {
      if (rank === pair || (counts.get(rank) || 0) > 3 || (counts.get(pair) || 0) > 2) continue
      if ([...counts.keys()].every(r => r === rank || r === pair) && Math.max(0, 3 - (counts.get(rank) || 0)) + Math.max(0, 2 - (counts.get(pair) || 0)) === wild.length) candidates.push(result('fullHouse', rank, n, level))
    }
  }
  for (const [length, each, type] of [[5, 1, 'straight'], [3, 2, 'pairs'], [2, 3, 'triples']]) {
    if (n !== length * each || [...counts.keys()].some(r => r >= 15)) continue
    for (const top of sequences(counts, length, each, wild.length)) candidates.push(result(type, top, n, level))
  }
  if (n === 5 && plain.length && plain[0].suit !== '' && plain.every(c => c.suit === plain[0].suit) && [...counts.keys()].every(r => r <= 14)) {
    for (const top of sequences(counts, 5, 1, wild.length)) candidates.push(result('straightFlush', top, n, level))
  }
  // 逢人配可能对应多个点数或牌型；默认使用最大解释。
  return [...new Map(candidates.map(candidate => [`${candidate.type}:${candidate.rank}`, candidate])).values()]
    .sort((a, b) => b.power - a.power)
}

export function classify(cards, level = 2) { return classifyOptions(cards, level)[0] || null }

export function beats(next, previous) {
  if (!next) return false
  if (!previous) return true
  if (next.type === 'jokerBomb') return previous.type !== 'jokerBomb'
  if (previous.type === 'jokerBomb') return false
  const bomb = x => x.type === 'bomb' || x.type === 'straightFlush'
  if (bomb(next) && !bomb(previous)) return true
  if (!bomb(next) && bomb(previous)) return false
  if (bomb(next) && bomb(previous)) return next.power > previous.power
  return next.type === previous.type && next.count === previous.count && next.power > previous.power
}

export function candidateMoves(hand, level, table, limit = 100) {
  const groups = new Map()
  const wild = hand.filter(card => card.rank === level && card.suit === '♥')
  for (const card of hand.filter(card => !wild.includes(card))) {
    if (!groups.has(card.rank)) groups.set(card.rank, [])
    groups.get(card.rank).push(card)
  }
  const out = []
  const seen = new Set()
  const add = cards => {
    if (new Set(cards.map(card => card.id)).size !== cards.length) return
    const pattern = classifyOptions(cards, level).find(candidate => beats(candidate, table))
    if (!pattern) return
    const ids = cards.map(c => c.id)
    const key = ids.join('|')
    if (seen.has(key)) return
    seen.add(key); out.push({ action: 'play', cards: ids, pattern })
  }
  for (const cards of groups.values()) for (let n = 1; n <= Math.min(cards.length, 8); n++) {
    for (let used = 0; used <= Math.min(wild.length, 10 - n); used++) add([...cards.slice(0, n), ...wild.slice(0, used)])
  }
  for (const card of wild) add([card])
  for (let rank = 2; rank <= 14; rank++) {
    const triples = groups.get(rank) || []
    for (let pair = 2; pair <= 14; pair++) {
      if (pair === rank) continue
      const pairCards = groups.get(pair) || []
      const picked = [...triples.slice(0, 3), ...pairCards.slice(0, 2)]
      if (picked.length >= 3 && 5 - picked.length <= wild.length) add([...picked, ...wild.slice(0, 5 - picked.length)])
    }
  }
  for (const [length, each] of [[5, 1], [3, 2], [2, 3]]) {
    for (let start = 1; start <= 15 - length; start++) {
      const run = []
      for (let r = start; r < start + length; r++) run.push(...(groups.get(r === 1 ? 14 : r) || []).slice(0, each))
      const missing = length * each - run.length
      if (missing <= wild.length) add([...run, ...wild.slice(0, missing)])
    }
  }
  for (const suit of ['♠', '♥', '♣', '♦']) for (let start = 1; start <= 10; start++) {
    const run = []
    for (let r = start; r < start + 5; r++) {
      const card = hand.find(c => !wild.includes(c) && c.rank === (r === 1 ? 14 : r) && c.suit === suit)
      if (card) run.push(card)
    }
    if (5 - run.length <= wild.length) add([...run, ...wild.slice(0, 5 - run.length)])
  }
  const jokers = hand.filter(c => c.rank >= 15)
  if (jokers.length === 4) add(jokers)
  out.sort((a, b) => a.cards.length - b.cards.length || a.pattern.power - b.pattern.power)
  return out.slice(0, limit).map(({ action, cards }) => ({ action, cards }))
}
