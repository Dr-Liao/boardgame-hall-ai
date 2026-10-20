// 五子棋的本地战术引擎（纯函数，与 LLM 无关）。
//
// 为什么需要它：
//   模型只读一张 15×15 的文本棋盘，很难稳定看出「活三 / 冲四 / 必防点」，
//   而一旦模型输出不可用，旧逻辑会在 225 个空点里随机挑一个 —— 就是玩家看到的「乱下」。
//   本模块给出一个确定性、可解释的落点选择，供 Mod 通过以下接口交给大厅：
//     agentFallback(state, seat)   模型失败/未配置时的兜底落点（不再随机）
//     agentCandidates(state, seat) 提示词里的「引擎建议」候选点
//     refineMove(state, seat, move) 只在「必杀 / 必防」时纠正模型的一手
//
// 评分思路（经典棋型打分）：
//   1. 只考虑已有棋子周围两格内的空点（棋盘再大也不会退化）；
//   2. 每个方向取 9 格窗口，按「棋型」打分（成五 > 活四 > 冲四 > 活三 > …）；
//   3. 一个点的价值 = 自己下这里的进攻分 + 对手下这里的防守分 × 权重，
//      四个方向相加，因此「双三 / 双四」这类双杀点自然得分最高；
//   4. 成五与堵对方成五是硬规则，优先于任何评分。

const N = 15
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]

const idx = (x, y) => y * N + x
const inBounds = (x, y) => x >= 0 && x < N && y >= 0 && y < N
const otherColor = (c) => (c === 'black' ? 'white' : 'black')

// 棋型分值：必须能明显区分强弱，让「活三」压过「冲二」这类小便宜。
const SCORE = {
  FIVE: 10000000,
  OPEN_FOUR: 500000,
  FOUR: 50000,
  OPEN_THREE: 10000,
  BROKEN_THREE: 8000,
  OPEN_TWO: 800,
  TWO: 200,
  BROKEN_TWO: 100,
  ONE: 20,
}

// 棋型表：按强弱排列，命中即返回。模式串一律以「候选点」为中心判定（见 patternHits）。
// '1' = 本方（含假设落下的那一子），'2' = 对方或棋盘外，'0' = 空点。
const PATTERNS = [
  { pattern: '11111', score: SCORE.FIVE },
  { pattern: '011110', score: SCORE.OPEN_FOUR },
  // 冲四：再补一子即成五的四（一端被堵的四连，或中间空一格的跳四）。
  { pattern: '011112', score: SCORE.FOUR },
  { pattern: '211110', score: SCORE.FOUR },
  { pattern: '11011', score: SCORE.FOUR },
  { pattern: '10111', score: SCORE.FOUR },
  { pattern: '11101', score: SCORE.FOUR },
  { pattern: '011101', score: SCORE.FOUR },
  { pattern: '101110', score: SCORE.FOUR },
  // 活三：两端都空的连三；跳活三同样是活三（下一手可变活四）。
  { pattern: '011100', score: SCORE.OPEN_THREE },
  { pattern: '001110', score: SCORE.OPEN_THREE },
  { pattern: '011010', score: SCORE.OPEN_THREE },
  { pattern: '010110', score: SCORE.OPEN_THREE },
  // 眠三：一端被封的连三，只需堵单点，价值低于活三。
  { pattern: '211100', score: SCORE.BROKEN_THREE },
  { pattern: '001112', score: SCORE.BROKEN_THREE },
  // 活二 / 眠二。
  { pattern: '001100', score: SCORE.OPEN_TWO },
  { pattern: '011000', score: SCORE.TWO },
  { pattern: '000110', score: SCORE.TWO },
  { pattern: '010100', score: SCORE.BROKEN_TWO },
  { pattern: '001010', score: SCORE.BROKEN_TWO },
  { pattern: '00100', score: SCORE.ONE },
]

// 自己进攻与「顺手挡住对手」的相对权重：进攻略优先，但不会无视对手的大棋型。
const DEFENSE_WEIGHT = 0.9
// 候选点半径：只看已有棋子两格以内的空点。
const NEIGHBOR_RADIUS = 2

/** 取以 (x,y) 为中心、沿 (dx,dy) 的 9 格棋型窗口；中心固定记为 '1'（假设已落子）。 */
export function windowAt(board, x, y, dx, dy, me) {
  let out = ''
  for (let i = -4; i <= 4; i++) {
    if (i === 0) { out += '1'; continue }
    const nx = x + dx * i
    const ny = y + dy * i
    if (!inBounds(nx, ny)) { out += '2'; continue }
    const v = board[idx(nx, ny)]
    out += v == null ? '0' : (v === me ? '1' : '2')
  }
  return out
}

/** 模式在窗口里命中，且必须覆盖中心点（否则是把旁处的棋型算到了这个点上）。 */
function patternHits(window, pattern) {
  let from = 0
  while (from <= window.length - pattern.length) {
    const at = window.indexOf(pattern, from)
    if (at < 0) return false
    if (at <= 4 && 4 < at + pattern.length) return true
    from = at + 1
  }
  return false
}

/** 单方向棋型分（取该方向命中的最强棋型）。 */
export function directionScore(window) {
  for (const entry of PATTERNS) {
    if (patternHits(window, entry.pattern)) return entry.score
  }
  return 0
}

/** 在 (x,y) 落 color 之后的进攻分与「对手落这里」的防守分。 */
export function evaluatePoint(board, x, y, me) {
  const opp = otherColor(me)
  let attack = 0
  let defense = 0
  for (const [dx, dy] of DIRS) {
    attack += directionScore(windowAt(board, x, y, dx, dy, me))
    defense += directionScore(windowAt(board, x, y, dx, dy, opp))
  }
  return { attack, defense, total: attack + defense * DEFENSE_WEIGHT }
}

/** 落 (x,y) 后该颜色是否立刻五连（用于成五 / 堵五的硬规则）。 */
export function makesFive(board, x, y, color) {
  for (const [dx, dy] of DIRS) {
    let count = 1
    for (const sign of [1, -1]) {
      for (let i = 1; i < 5; i++) {
        const nx = x + dx * i * sign
        const ny = y + dy * i * sign
        if (!inBounds(nx, ny) || board[idx(nx, ny)] !== color) break
        count++
      }
    }
    if (count >= 5) return true
  }
  return false
}

function hasAnyStone(board) {
  for (let i = 0; i < board.length; i++) if (board[i]) return true
  return false
}

/** 候选空点：已有棋子两格内；空盘时只给天元。 */
export function candidatePoints(board) {
  if (!hasAnyStone(board)) return [{ x: 7, y: 7 }]
  const out = []
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (board[idx(x, y)]) continue
      let near = false
      for (let dy = -NEIGHBOR_RADIUS; dy <= NEIGHBOR_RADIUS && !near; dy++) {
        for (let dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (inBounds(nx, ny) && board[idx(nx, ny)]) { near = true; break }
        }
      }
      if (near) out.push({ x, y })
    }
  }
  return out.length ? out : allEmpty(board)
}

function allEmpty(board) {
  const out = []
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!board[idx(x, y)]) out.push({ x, y })
  return out
}

/** 稳定的同分排序：越靠中心越优先，其次 y、x 递增，保证同一局面结果可复现。 */
function tieBreak(a, b) {
  const center = (N - 1) / 2
  const da = Math.abs(a.x - center) + Math.abs(a.y - center)
  const db = Math.abs(b.x - center) + Math.abs(b.y - center)
  if (da !== db) return da - db
  if (a.y !== b.y) return a.y - b.y
  return a.x - b.x
}

function scoredList(board, me) {
  return candidatePoints(board).map((point) => {
    const score = evaluatePoint(board, point.x, point.y, me)
    return { move: point, ...score }
  })
}

function pickBest(entries) {
  let best = null
  for (const entry of entries) {
    if (!best || entry.total > best.total ||
        (entry.total === best.total && tieBreak(entry.move, best.move) < 0)) best = entry
  }
  return best ? best.move : null
}

/**
 * 当前局面下的「成五点」与「必防点」（都按评分从强到弱）。
 * 成五点：自己落下即五连；必防点：对手落下即五连。
 */
export function mustPlays(state, seat) {
  const board = state.board
  const me = state.colors[seat]
  const opp = otherColor(me)
  const wins = []
  const blocks = []
  for (const point of candidatePoints(board)) {
    if (makesFive(board, point.x, point.y, me)) wins.push(point)
    else if (makesFive(board, point.x, point.y, opp)) blocks.push(point)
  }
  const rank = (list) => list
    .map((move) => ({ move, ...evaluatePoint(board, move.x, move.y, me) }))
    .sort((a, b) => (b.total - a.total) || tieBreak(a.move, b.move))
    .map((entry) => entry.move)
  return { wins: rank(wins), blocks: rank(blocks) }
}

/**
 * 当前局面下 AI 的「必杀 / 必防」落点。
 * @returns {{ move: {x:number,y:number}, reason: 'win'|'block' }|null}
 */
export function forcedMove(state, seat) {
  const { wins, blocks } = mustPlays(state, seat)
  if (wins.length) return { move: wins[0], reason: 'win' }
  if (blocks.length) return { move: blocks[0], reason: 'block' }
  return null
}

/**
 * 本地引擎的最佳落点（确定性）。
 * @returns {{x:number,y:number}}
 */
export function bestMove(state, seat) {
  const forced = forcedMove(state, seat)
  if (forced) return forced.move
  const me = state.colors[seat]
  const picked = pickBest(scoredList(state.board, me))
  if (picked) return picked
  // 极端情况（理论上不会出现）：按顺序取第一个合法空点。
  return candidatePoints(state.board)[0]
}

/**
 * 给提示词用的候选点（按强弱排序）。
 * @param {number} limit 最多返回几个
 * @returns {{move:{x:number,y:number}, note:string}[]}
 */
export function rankMoves(state, seat, limit = 4) {
  const board = state.board
  const me = state.colors[seat]
  const opp = otherColor(me)
  const forced = forcedMove(state, seat)
  const entries = scoredList(board, me)

  return entries
    .map((entry) => ({
      ...entry,
      note: noteFor(board, entry, me, opp, forced),
    }))
    .sort((a, b) => {
      // 必杀 / 必防永远排第一档。
      const rank = (e) => (forced && e.move.x === forced.move.x && e.move.y === forced.move.y ? 2 : 0)
      const diff = rank(b) - rank(a)
      if (diff) return diff
      if (b.total !== a.total) return b.total - a.total
      return tieBreak(a.move, b.move)
    })
    .slice(0, Math.max(1, limit))
    .map((entry) => ({ move: entry.move, note: entry.note }))
}

function noteFor(board, entry, me, opp, forced) {
  const { move, attack, defense } = entry
  if (makesFive(board, move.x, move.y, me)) return '直接连成五子，立刻获胜'
  if (makesFive(board, move.x, move.y, opp)) return '对方下一手就成五，必须封堵'
  if (forced && forced.move.x === move.x && forced.move.y === move.y) {
    return forced.reason === 'win' ? '成五点' : '必防点'
  }
  if (attack >= SCORE.OPEN_FOUR) return '形成活四，下一手必胜'
  if (attack >= SCORE.FOUR) return '形成冲四，逼对方应对'
  if (attack >= SCORE.OPEN_THREE) return '形成活三，制造双重威胁'
  if (defense >= SCORE.OPEN_FOUR) return '挡住对方活四'
  if (defense >= SCORE.OPEN_THREE) return '挡住对方活三'
  if (attack >= SCORE.OPEN_TWO && defense >= SCORE.OPEN_TWO) return '攻守兼备'
  if (defense >= SCORE.OPEN_TWO) return '限制对方成形'
  return ''
}

/** 供 agentHint 使用的一句话战术摘要（写进 system prompt）。 */
export const AGENT_HINT = [
  '五子棋的判断顺序（务必逐条检查，不要随手落子）：',
  '1. 自己有没有「再落一子就成五」的点，有就立刻下；',
  '2. 对手有没有四连（下一手能成五），有就必须封堵；',
  '3. 主动制造活三 / 活四（两端都空的连子），并阻止对手形成；',
  '4. 落子要贴着已有棋子与战场，绝不把棋子下在远离棋形的空点上。',
].join('\n')
