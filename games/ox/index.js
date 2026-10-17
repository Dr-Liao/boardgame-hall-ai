// 桌游 Mod：井字棋（Tic-tac-toe）
//
// 第二个示例 Mod，用来证明「每个桌游都是一个独立插件」。
// 规则与五子棋完全不同（3×3、三连即胜），但暴露给 AI/agent 的接口一致。

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
