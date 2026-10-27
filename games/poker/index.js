import { beats, candidateMoves, cardOrder, cardText, classify, deck, singleStrength } from './rules.js'

const TYPE = { single: '单张', pair: '对子', triple: '三张', fullHouse: '三带二', straight: '顺子', pairs: '三连对', triples: '钢板', bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '天王炸' }
const team = seat => seat % 2
const nextActive = (state, seat) => {
  for (let i = 1; i <= 4; i++) if (!state.finished.includes((seat + i) % 4)) return (seat + i) % 4
  return seat
}
const partner = seat => (seat + 2) % 4
function dealHands() {
  const cards = deck()
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
  }
  return Array.from({ length: 4 }, (_, seat) => cards.slice(seat * 27, seat * 27 + 27).sort(cardOrder))
}
function endHand(state) {
  const first = state.placements[0]
  const missing = [0, 1, 2, 3].filter(seat => !state.placements.includes(seat))
  state.placements.push(...missing)
  const winnerTeam = team(first)
  const partnerPlace = state.placements.indexOf(partner(first))
  const grade = 4 - partnerPlace
  const levels = state.levels || [2, 2]
  const passedA = state.level === 14 && levels[winnerTeam] === 14 && partnerPlace < 3
  const nextLevel = Math.min(14, levels[winnerTeam] + grade)
  const gained = nextLevel - levels[winnerTeam]
  levels[winnerTeam] = nextLevel
  state.levels = levels
  state.winnerSeat = first
  state.winningTeam = winnerTeam
  state.handSummary = { round: state.round || 1, level: state.level, placements: [...state.placements], winnerTeam,
    grade, gained, nextLevel, passedA }
  state.passes = 0
  state.phase = passedA ? 'complete' : 'between'
  state.status = passedA ? 'over' : 'playing'
  state.currentSeat = 0
  return { type: 'handEnd', ...state.handSummary }
}
function startNextHand(state) {
  const summary = state.handSummary
  state.round = (state.round || 1) + 1
  state.dealId = Math.random().toString(36).slice(2)
  state.level = summary.nextLevel
  state.hands = dealHands()
  state.table = null
  state.passes = 0
  state.finished = []
  state.placements = []
  state.moveCount = 0
  state.tributePairs = []
  state.tributeLeader = summary.placements[0]
  const partnerPlace = summary.placements.indexOf(partner(summary.placements[0]))
  const givers = partnerPlace === 1 ? summary.placements.slice(2) : partnerPlace === 2 ? [summary.placements[3]] : []
  const kings = givers.reduce((count, seat) => count + state.hands[seat].filter(card => card.rank === 16).length, 0)
  const anti = givers.length && kings >= 2
  if (givers.length && !anti) {
    const gifts = givers.map(giver => {
      const card = [...state.hands[giver]]
        .filter(item => !(item.rank === state.level && item.suit === '♥'))
        .sort((a, b) => singleStrength(b.rank, state.level) - singleStrength(a.rank, state.level))[0]
      return { giver, card }
    }).sort((a, b) => singleStrength(b.card.rank, state.level) - singleStrength(a.card.rank, state.level)
      || (a.giver - summary.placements[0] + 4) % 4 - (b.giver - summary.placements[0] + 4) % 4)
    const receivers = partnerPlace === 1 ? summary.placements.slice(0, 2) : [summary.placements[0]]
    state.tributePairs = gifts.map((gift, index) => ({ giver: gift.giver, receiver: receivers[index], card: gift.card, returned: false }))
    state.tributeLeader = gifts[0].giver
    for (const pair of state.tributePairs) {
      state.hands[pair.giver] = state.hands[pair.giver].filter(card => card.id !== pair.card.id)
      state.hands[pair.receiver].push(pair.card)
      state.hands[pair.receiver].sort(cardOrder)
    }
  }
  state.phase = state.tributePairs.length ? 'return' : 'play'
  state.currentSeat = state.tributePairs.length ? state.tributePairs[0].receiver : state.tributeLeader
  return [{ type: 'newHand', round: state.round, level: state.level, anti: !!anti },
    ...state.tributePairs.map(pair => ({ type: 'tribute', giver: pair.giver, receiver: pair.receiver, card: pair.card }))]
}
function returnChoices(state, seat) {
  const hand = state.hands[seat] || []
  const low = hand.filter(card => card.rank <= 10)
  return low.length ? low : hand
}
function pickCards(state, seat, move) {
  if (!Array.isArray(move?.cards) || !move.cards.length || move.cards.length > 10 || new Set(move.cards).size !== move.cards.length) return null
  const byId = new Map(state.hands[seat].map(card => [card.id, card]))
  const cards = move.cards.map(id => byId.get(id))
  return cards.every(Boolean) ? cards : null
}
function describeState(state, seat) {
  const hand = state.hands[seat] || []
  return [
    `掼蛋第 ${state.round || 1} 副，四人两队。你在 ${seat} 号位，队友是 ${partner(seat)} 号位。本副级牌 ${state.level}，两队级数分别为 ${state.levels?.join('、') || '2、2'}。`,
    '牌力：大王＞小王＞级牌＞A～2；顺子、三连对、钢板按自然点数比，不抬高级牌。四王＞六张及以上炸弹＞同花顺＞五张炸弹＞四张炸弹＞普通牌型。红桃级牌可代替非王牌；上游出完且其余各家不压时，对家接风。',
    `手牌：${hand.map(c => `${c.id}:${cardText(c)}`).join('、')}`,
    `各席余牌：${state.hands.map((cards, i) => `${i}号 ${cards.length} 张`).join('；')}。已出完：${state.finished.join('、') || '无'}。`,
    state.phase === 'return' ? `还贡阶段：${state.currentSeat} 号位须还一张不大于 10 的牌；若无此牌可任选。动作格式 {"action":"return","card":"牌的 id"}。`
      : state.phase === 'between' ? '本副已结算，0 号位开始下一副，动作格式 {"action":"nextHand"}。'
        : state.table ? `桌面：${state.table.seat} 号位 ${TYPE[state.table.pattern.type]} ${state.table.cards.map(cardText).join('')}。` : '桌面空，请领出。',
    state.phase === 'return' ? `当前行动：${state.currentSeat} 号位。只能还贡，不可出牌或过牌；不要公开还贡牌面。`
      : state.phase === 'between' ? '当前行动：0 号位。只能开始下一副，不可出牌或过牌。'
        : `当前行动：${state.currentSeat} 号位。出牌请给 cards 数组，内容为手牌 id；不压牌可 pass。若队友已领牌，通常让队友继续，接风时则应主动领牌。`,
  ].join('\n')
}
function moveToText(move) {
  return move.action === 'pass' ? '过牌' : move.action === 'return' ? '还贡' : move.action === 'nextHand' ? '开始下一副'
    : `出 ${move.cards?.length || 0} 张牌`
}
function legalMoves(state, seat) {
  if (state.status !== 'playing' || state.currentSeat !== seat) return []
  if (state.phase === 'between') return seat === 0 ? [{ action: 'nextHand' }] : []
  if (state.phase === 'return') return returnChoices(state, seat).map(card => ({ action: 'return', card: card.id }))
  const moves = candidateMoves(state.hands[seat], state.level, state.table?.pattern, 300)
  if (state.table) moves.push({ action: 'pass' })
  return moves
}

export default {
  id: 'poker', name: '扑克合集', nameEn: 'Poker Collection',
  players: [4, 4], seats: 4,
  cover: 'linear-gradient(135deg, #8a5336, #193c36 70%, #0b2224)',
  coverEmoji: '🃏',
  description: '选择扑克玩法，与 AI 或朋友同桌对局。目前收录支持升级、进贡与还贡的掼蛋。',
  tags: ['扑克', '四人', '组队'],
  render: { kind: 'cards' },
  settingsSpec: [{ key: 'variant', type: 'select', label: '选择游戏', default: 'guandan', options: [{ value: 'guandan', label: '掼蛋' }] }],
  defaults: { variant: 'guandan' },
  web: { dir: 'web', client: 'client.js', styles: 'style.css' },
  moveFormat: '{"action":"play","cards":["牌的 id",...]}、{"action":"pass"}、{"action":"return","card":"牌的 id"} 或 {"action":"nextHand"}',
  moveToText, describeState, legalMoves,
  agentActionMessage({ move, speech }) { return speech || `我${moveToText(move)}。` },
  agentActionSpeechFrequency({ move }) { return move.action === 'return' ? 0 : 100 },
  aiStepDelayMs: 600,
  participantDescription(_state, seat) { return `与 ${(seat + 2) % 4} 号位同队；对手是 ${(seat + 1) % 4}、${(seat + 3) % 4} 号位` },
  agentHint: '严格只用自己可见手牌的 id。大王＞小王＞级牌＞A～2；普通牌必须同牌型同张数压制，四王＞六张及以上炸弹＞同花顺＞五张炸弹＞四张炸弹。红桃级牌是逢人配，可替非王牌，顺子等连续牌按自然点数。对家是队友：队友牌已压住且无迫切出完机会时优先过牌；队友出完后无人压制可接风，接风时主动领出。领牌优先消化散牌、顺子和连对，保留关键炸弹；接近出完时优先找合法收尾。还贡仅还不大于10的牌（没有时任选），进贡由规则自动执行；还贡台词不要说出牌面。',
  agentCandidates(state, seat) {
    const moves = legalMoves(state, seat)
    if ((state.phase || 'play') !== 'play') return moves.slice(0, 12).map(move => ({ move, note: move.action === 'return' ? '选择合法还贡牌' : '进入下一副' }))
    const picked = []
    const seen = new Set()
    const add = move => {
      const key = JSON.stringify(move)
      if (!move || seen.has(key)) return
      seen.add(key); picked.push(move)
    }
    const groups = new Map()
    for (const move of moves) {
      const type = move.action === 'pass' ? 'pass' : classify(move.cards.map(id => state.hands[seat].find(card => card.id === id)), state.level)?.type
      if (!groups.has(type)) groups.set(type, [])
      groups.get(type).push(move)
    }
    for (const group of groups.values()) { add(group[0]); add(group.at(-1)) }
    for (const move of moves) { if (picked.length >= 18) break; add(move) }
    return picked.map(move => ({ move, note: move.action === 'pass' ? '让牌或保存实力'
      : `${TYPE[classify(move.cards.map(id => state.hands[seat].find(card => card.id === id)), state.level)?.type] || '出牌'}，${move.cards.length} 张` }))
  },
  agentFallback(state, seat) {
    const moves = legalMoves(state, seat)
    if (state.phase === 'between') return moves[0] || null
    if (state.phase === 'return') return moves.sort((a, b) => {
      const cardA = state.hands[seat].find(card => card.id === a.card)
      const cardB = state.hands[seat].find(card => card.id === b.card)
      return singleStrength(cardA.rank, state.level) - singleStrength(cardB.rank, state.level)
    })[0] || null
    const finish = moves.find(move => move.action === 'play' && move.cards.length === state.hands[seat].length)
    if (finish) return finish
    if (state.table?.seat % 2 === seat % 2 && moves.some(move => move.action === 'pass')) return { action: 'pass' }
    return (!state.table && [...moves].reverse().find(move => move.action === 'play' && move.cards.length >= 3 && !['bomb', 'straightFlush', 'jokerBomb'].includes(classify(move.cards.map(id => state.hands[seat].find(card => card.id === id)), state.level)?.type)))
      || moves.find(move => move.action === 'play' && move.cards.length > 1 && move.cards.length < 4)
      || moves[0] || null
  },
  createState(settings, players) {
    if (settings.variant && settings.variant !== 'guandan') throw new Error('尚未支持该扑克玩法')
    if (players.length !== 4) throw new Error('掼蛋需要四个席位')
    return { status: 'playing', phase: 'play', winnerSeat: null, winningTeam: null,
      currentSeat: 0, moveCount: 0, round: 1, level: 2, levels: [2, 2],
      dealId: Math.random().toString(36).slice(2),
      hands: dealHands(), table: null, passes: 0, finished: [], placements: [],
      handSummary: null, tributePairs: [], tributeLeader: null }
  },
  viewState(state, seat) {
    return { ...state, hands: state.hands.map((cards, index) => index === seat ? cards : Array(cards.length).fill(null)) }
  },
  viewEvents(events) { return events },
  validateMove(state, seat, move) {
    if (state.status !== 'playing') return '本局已结束'
    if (state.currentSeat !== seat) return '尚未轮到你'
    if (state.phase === 'between') return seat === 0 && move?.action === 'nextHand' ? null : '请等待房主开始下一副'
    if (state.phase === 'return') {
      const pair = state.tributePairs?.find(item => !item.returned)
      if (pair?.receiver !== seat || move?.action !== 'return') return '当前需要还贡'
      return returnChoices(state, seat).some(card => card.id === move.card) ? null : '请选择一张不大于10的手牌还贡'
    }
    if (move?.action === 'pass') return state.table ? null : '桌面空时必须出牌'
    if (move?.action !== 'play') return '请选择要出的牌'
    const cards = pickCards(state, seat, move)
    if (!cards) return '手牌选择无效'
    const pattern = classify(cards, state.level)
    if (!pattern) return '不符合掼蛋牌型'
    if (!beats(pattern, state.table?.pattern)) return '当前牌型压不过桌面'
    return null
  },
  applyMove(state, seat, move) {
    if (state.phase === 'between') return startNextHand(state)
    if (state.phase === 'return') {
      const pair = state.tributePairs.find(item => !item.returned)
      const card = state.hands[seat].find(item => item.id === move.card)
      state.hands[seat] = state.hands[seat].filter(item => item.id !== card.id)
      state.hands[pair.giver].push(card)
      state.hands[pair.giver].sort(cardOrder)
      pair.returned = true
      const next = state.tributePairs.find(item => !item.returned)
      state.currentSeat = next ? next.receiver : state.tributeLeader
      if (!next) state.phase = 'play'
      return [{ type: 'return', seat, to: pair.giver }]
    }
    state.moveCount++
    if (move.action === 'pass') {
      state.passes++
      const remaining = 4 - state.finished.length
      const events = [{ type: 'move', seat, move: { action: 'pass' } }]
      const ownerFinished = state.finished.includes(state.table.seat)
      if (state.passes >= remaining - (ownerFinished ? 0 : 1)) {
        const leader = ownerFinished ? partner(state.table.seat) : state.table.seat
        state.table = null; state.passes = 0; state.currentSeat = leader
        events.push({ type: 'trick', seat: leader })
      } else state.currentSeat = nextActive(state, seat)
      return events
    }
    const cards = pickCards(state, seat, move)
    const chosen = new Set(move.cards)
    const pattern = classify(cards, state.level)
    state.hands[seat] = state.hands[seat].filter(card => !chosen.has(card.id))
    state.table = { seat, cards, pattern }
    state.passes = 0
    const events = [{ type: 'move', seat, move: { action: 'play', cards: move.cards }, cards, pattern: pattern.type }]
    if (!state.hands[seat].length) {
      state.finished.push(seat)
      state.placements.push(seat)
      events.push({ type: 'finish', seat, place: state.finished.length })
      if (state.finished.length >= 2 && team(state.finished[0]) === team(state.finished[1]) || state.finished.length === 3) {
        events.push(endHand(state))
        if (state.status === 'over') events.push({ type: 'win', seat: state.winnerSeat, team: state.winningTeam, placements: state.placements })
      }
    }
    if (state.status === 'playing' && (state.phase || 'play') === 'play') state.currentSeat = nextActive(state, seat)
    return events
  },
}
