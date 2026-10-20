// 井字棋的本地完美引擎（纯函数，与 LLM 无关）。
//
// 井字棋只有 3×3、状态数不到 6000，用带记忆化的 minimax 就能做到「不失误」，
// 所以没有理由在模型失败时随手挑一个空点 —— 那就是玩家看到的「乱下」。
//
// 本模块给 Mod 提供与大棋类一致的接口：
//   agentFallback(state, seat)   模型失败/未配置时的兜底落点（完美解）
//   agentCandidates(state, seat) 提示词里的「引擎建议」候选点
//   refineMove(state, seat, move) 纠正模型「会输」的一手（必杀 / 必防 / 被双杀）

const N = 3
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]

const idx = (x, y) => y * N + x
const otherColor = (c) => (c === 'black' ? 'white' : 'black')

/** 返回获胜颜色；没有则返回 null。 */
export function winnerOf(board) {
  for (const line of LINES) {
    const first = board[line[0]]
    if (!first) continue
    if (board[line[1]] === first && board[line[2]] === first) return first
  }
  return null
}

function isFull(board) {
  for (let i = 0; i < board.length; i++) if (!board[i]) return false
  return true
}

function legalPoints(board) {
  const out = []
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!board[idx(x, y)]) out.push({ x, y })
  return out
}

/**
 * 局面分值（以 me 的视角，只依赖局面本身，便于记忆化）：
 *   +1 己方必胜、-1 己方必败、0 和棋。
 */
function evaluate(board, turn, me, opp, memo) {
  const key = board.map((c) => (c == null ? '.' : c === me ? 'x' : 'o')).join('') + '|' + (turn === me ? 'x' : 'o')
  const cached = memo.get(key)
  if (cached !== undefined) return cached

  const win = winnerOf(board)
  let score
  if (win === me) score = 1
  else if (win === opp) score = -1
  else if (isFull(board)) score = 0
  else {
    const maximizing = turn === me
    let best = maximizing ? -2 : 2
    for (const point of legalPoints(board)) {
      board[idx(point.x, point.y)] = turn
      const value = evaluate(board, otherColor(turn), me, opp, memo)
      board[idx(point.x, point.y)] = null
      best = maximizing ? Math.max(best, value) : Math.min(best, value)
    }
    score = best
  }
  memo.set(key, score)
  return score
}

/** 每个合法点的 minimax 分值（+1 必胜 / 0 和棋 / -1 必败），按分值降序。 */
export function rankMoves(state, seat, limit = 9) {
  const me = state.colors[seat]
  const opp = otherColor(me)
  const board = state.board.slice()
  const memo = new Map()
  const scored = legalPoints(board).map((point) => {
    board[idx(point.x, point.y)] = me
    const value = evaluate(board, opp, me, opp, memo)
    board[idx(point.x, point.y)] = null
    return { move: point, value }
  })
  // 同分时：中心 > 角 > 边，让开局与均势局面更自然（且完全确定）。
  const weight = (point) => (point.x === 1 && point.y === 1 ? 2 : (point.x === 1 || point.y === 1) ? 0 : 1)
  scored.sort((a, b) => (b.value - a.value) || (weight(b.move) - weight(a.move)))
  return scored.slice(0, Math.max(1, limit))
}

/**
 * 当前局面下的「成三点」与「必防点」。
 * 成三点：自己落下即三连；必防点：对手落下即三连。
 */
export function mustPlays(state, seat) {
  const me = state.colors[seat]
  const opp = otherColor(me)
  const board = state.board.slice()
  const wins = []
  const blocks = []
  for (const point of legalPoints(board)) {
    board[idx(point.x, point.y)] = me
    if (winnerOf(board) === me) wins.push(point)
    else {
      board[idx(point.x, point.y)] = opp
      if (winnerOf(board) === opp) blocks.push(point)
      board[idx(point.x, point.y)] = null
    }
    board[idx(point.x, point.y)] = null
  }
  return { wins, blocks }
}

/**
 * 「必杀 / 必防」落点：能立刻三连，或必须挡住对手的三连。
 * @returns {{ move: {x:number,y:number}, reason: 'win'|'block' }|null}
 */
export function forcedMove(state, seat) {
  const { wins, blocks } = mustPlays(state, seat)
  if (wins.length) return { move: wins[0], reason: 'win' }
  if (blocks.length) return { move: blocks[0], reason: 'block' }
  return null
}

/** 本地引擎的最佳落点（完美解，先看必杀/必防再看 minimax）。 */
export function bestMove(state, seat) {
  const forced = forcedMove(state, seat)
  if (forced) return forced.move
  const ranked = rankMoves(state, seat, 1)
  return ranked.length ? ranked[0].move : legalPoints(state.board)[0]
}

/** 给提示词用的候选点。 */
export function suggestions(state, seat, limit = 4) {
  const me = state.colors[seat]
  const opp = otherColor(me)
  const board = state.board.slice()
  const forced = forcedMove(state, seat)
  return rankMoves(state, seat, Math.max(1, limit)).map((entry) => ({
    move: entry.move,
    note: noteFor(board, entry.move, me, opp, forced),
  }))
}

function noteFor(board, move, me, opp, forced) {
  const at = idx(move.x, move.y)
  board[at] = me
  const win = winnerOf(board) === me
  board[at] = opp
  const loses = winnerOf(board) === opp
  board[at] = null
  if (win) return '直接三连，立刻获胜'
  if (loses) return '对方下一手就连成三子，必须封堵'
  if (forced && forced.move.x === move.x && forced.move.y === move.y) {
    return forced.reason === 'win' ? '制胜点' : '必防点'
  }
  if (move.x === 1 && move.y === 1) return '占据中心，同时兼顾多条线'
  if (move.x === 1 || move.y === 1) return '控制中间格，堵住一条线'
  return '占角，保留两条连线'
}

/** 供 agentHint 使用的战术摘要（写进 system prompt）。 */
export const AGENT_HINT = [
  '井字棋的判断顺序（务必逐条检查，不要随手落子）：',
  '1. 自己有没有「再下一子就连成三子」的点，有就立刻下；',
  '2. 对手有没有两子一线，有就必须封堵那一格；',
  '3. 落子优先占中心（1,1），其次是四个角，制造同时威胁两条线的双杀；',
  '4. 绝不下与胜负无关的空格，井字棋每一步都必须有攻守目的。',
].join('\n')
