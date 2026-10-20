// 桌游 Mod：井字棋（Tic-tac-toe）
//
// 第二个示例 Mod，用来证明「每个桌游都是一个独立插件」。
// 规则与五子棋完全不同（3×3、三连即胜），但暴露给 AI/agent 的接口一致。
// 棋力部分由 engine.js 的完美解提供（井字棋状态极少，可以直接算出最强手）。

import { AGENT_HINT, bestMove, suggestions, mustPlays, rankMoves } from './engine.js'

const N = 3
const idx = (x, y) => y * N + x

function checkWin(board, color) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ]
  return lines.some((l) => l.every((i) => board[i] === color))
}

function moveToText(move) {
  return '(' + move.x + ',' + move.y + ')'
}

function describeState(state) {
  const sym = { black: 'X', white: 'O' }
  const name = { black: 'X 方', white: 'O 方' }
  const lines = []
  lines.push('棋盘 3×3，坐标 x=列(0..2)、y=行(0..2)。')
  lines.push('符号：X=黑，O=白，.=空。已落 ' + state.moveCount + ' 子。')
  if (state.lastMove) {
    const c = state.board[idx(state.lastMove.x, state.lastMove.y)]
    lines.push('上一手：' + name[c] + ' ' + moveToText(state.lastMove) + '。')
  }
  lines.push('现在轮到：' + name[state.colors[state.currentSeat]] + '。')
  lines.push('')
  lines.push('     0   1   2')
  for (let y = 0; y < N; y++) {
    let row = '  ' + y + '  '
    for (let x = 0; x < N; x++) {
      const v = state.board[idx(x, y)]
      row += (v ? ' ' + sym[v] + ' ' : ' . ') + (x < N - 1 ? ' ' : '')
    }
    lines.push(row)
  }
  return lines.join('\n')
}

export default {
  id: 'ox',
  name: '井字棋',
  nameEn: 'Tic-tac-toe',
  players: [2, 2],
  seats: 2,
  cover: 'linear-gradient(135deg, #2f4a2f 0%, #0d1a0d 100%)',
  coverEmoji: '❌⭕',
  description: '三子连成一线（横/竖/斜）即胜，简单却暗藏玄机。',
  tags: ['棋类', '双人', '休闲'],
  render: { kind: 'board', size: 3, pieceStyle: 'mark' },

  settingsSpec: [
    {
      key: 'firstMove', type: 'select', label: '先手', default: 'player',
      options: [
        { value: 'player', label: '玩家（画 X 先行）' },
        { value: 'ai', label: 'AI（画 X 先行）' },
      ],
    },
  ],
  defaults: { firstMove: 'player' },

  // ---- 给 AI 的接口 ----
  moveFormat: '{"x": 0..2 的整数, "y": 0..2 的整数}（x=列，y=行）',
  moveToText,
  describeState,
  legalMoves(state) {
    const out = []
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!state.board[idx(x, y)]) out.push({ x, y })
    return out
  },

  // ---- 给 AI 的棋力支持（可选接口，见 lib/mods.js）----
  agentHint: AGENT_HINT,

  /** 提示词里的「引擎建议」候选点（按 minimax 分值排序）。 */
  agentCandidates(state, seat, limit) {
    return suggestions(state, seat, limit || 4)
  },

  /** 模型失败/未配置时的兜底落点：完美解，不再随机挑空点。 */
  agentFallback(state, seat) {
    return bestMove(state, seat)
  },

  /** 纠正模型「会输」的一手：必杀、必防，以及被对手双杀时的不输下法。 */
  refineMove(state, seat, move) {
    if (!move || typeof move.x !== 'number' || typeof move.y !== 'number') return move
    const { wins, blocks } = mustPlays(state, seat)
    const isOne = (point) => point && point.x === move.x && point.y === move.y
    if (wins.length) return wins.some(isOne) ? move : wins[0]
    if (blocks.length) return blocks.some(isOne) ? move : blocks[0]
    // 井字棋是已解游戏：模型这一手会输、而存在不输的下法时，换成不输的那一手。
    // 这样 AI 不会因为「没想到双杀」而输给玩家，但同分的好手仍保留模型的自由。
    const ranked = rankMoves(state, seat, 9)
    const best = ranked[0]
    if (!best || best.value < 0) return move
    const chosen = ranked.find((entry) => entry.move.x === move.x && entry.move.y === move.y)
    if (!chosen || chosen.value >= best.value) return move
    return best.move
  },

  // ---- 规则 ----
  createState(settings, players) {
    const humanBlack = players[0].color === 'black'
    return {
      status: 'playing',
      winnerSeat: null,
      currentSeat: humanBlack ? 0 : 1,
      moveCount: 0,
      lastMove: null,
      colors: players.map((p) => p.color),
      board: new Array(N * N).fill(null),
    }
  },

  validateMove(state, seat, move) {
    if (!move || typeof move.x !== 'number' || typeof move.y !== 'number') return '无效落子（需 {x,y} 整数）'
    const x = move.x, y = move.y
    if (!Number.isInteger(x) || !Number.isInteger(y)) return '坐标必须是整数'
    if (x < 0 || x >= N || y < 0 || y >= N) return '超出棋盘范围（0..2）'
    if (state.board[idx(x, y)]) return '该位置已被占用'
    return null
  },

  applyMove(state, seat, move) {
    const color = state.colors[seat]
    const x = move.x, y = move.y
    state.board[idx(x, y)] = color
    state.lastMove = { x, y }
    state.moveCount++
    const events = [{ type: 'move', seat, move, x, y, color }]
    if (checkWin(state.board, color)) {
      state.status = 'over'
      state.winnerSeat = seat
      events.push({ type: 'win', seat })
    } else if (state.moveCount >= N * N) {
      state.status = 'draw'
      events.push({ type: 'draw' })
    } else {
      state.currentSeat = (seat + 1) % state.colors.length
    }
    return events
  },
}
