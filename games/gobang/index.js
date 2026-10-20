// 桌游 Mod：五子棋（Gobang）
//
// 这是「每个桌游 = 一个独立插件」的参考实现。
// 本文件只包含游戏规则 + 给 AI/agent 的接口，完全不感知 LLM：
//   - 规则：createState / validateMove / applyMove；
//   - AI 接口：moveFormat / describeState / legalMoves / moveToText；
//   - 棋力接口：agentHint / agentCandidates / agentFallback / refineMove（见 engine.js）。
// 落子与台词由 lib/agent 里的模型产出，本 Mod 只负责校验、应用与战术兜底。

import { AGENT_HINT, bestMove, rankMoves, mustPlays } from './engine.js'

const N = 15
const idx = (x, y) => y * N + x
const inBounds = (x, y) => x >= 0 && x < N && y >= 0 && y < N
const otherColor = (c) => (c === 'black' ? 'white' : 'black')

function lineLength(board, x, y, color, dx, dy) {
  let n = 1
  let i = 1
  while (inBounds(x + dx * i, y + dy * i) && board[idx(x + dx * i, y + dy * i)] === color) { n++; i++ }
  i = 1
  while (inBounds(x - dx * i, y - dy * i) && board[idx(x - dx * i, y - dy * i)] === color) { n++; i++ }
  return n
}

// 假设在 (x, y) 落下 color 后，四个方向的最长连子。
function maxLine(board, x, y, color) {
  return Math.max(
    lineLength(board, x, y, color, 1, 0),
    lineLength(board, x, y, color, 0, 1),
    lineLength(board, x, y, color, 1, 1),
    lineLength(board, x, y, color, 1, -1),
  )
}

function checkWin(board, x, y, color) {
  return maxLine(board, x, y, color) >= 5
}

function moveToText(move) {
  return '(' + move.x + ',' + move.y + ')'
}

function describeState(state) {
  const sym = { black: 'X', white: 'O' }
  const name = { black: '黑', white: '白' }
  const lines = []
  lines.push('棋盘 ' + N + '×' + N + '，坐标 x=列(0..' + (N - 1) + ')、y=行(0..' + (N - 1) + ')。')
  lines.push('符号：X=黑，O=白，.=空。已落 ' + state.moveCount + ' 子。')
  if (state.lastMove) {
    const c = state.board[idx(state.lastMove.x, state.lastMove.y)]
    lines.push('上一手：' + name[c] + ' ' + moveToText(state.lastMove) + '。')
  }
  lines.push('现在轮到：' + name[state.colors[state.currentSeat]] + '。')
  lines.push('')
  let header = '    '
  for (let x = 0; x < N; x++) header += (x < 10 ? '  ' + x : ' ' + x)
  lines.push(header)
  for (let y = 0; y < N; y++) {
    let row = (y < 10 ? ' ' + y : '' + y) + '  '
    for (let x = 0; x < N; x++) {
      const v = state.board[idx(x, y)]
      row += (v ? sym[v] : '.') + '  '
    }
    lines.push(row)
  }
  return lines.join('\n')
}

export default {
  id: 'gobang',
  name: '五子棋',
  nameEn: 'Gobang',
  players: [2, 2],
  seats: 2,
  cover: 'linear-gradient(135deg, #1c2b4f 0%, #0d1428 100%)',
  coverEmoji: '⚫⚪',
  description: '黑白对弈，在 15×15 棋盘上率先五子连珠（横/竖/斜）者获胜。',
  tags: ['棋类', '双人', '策略'],
  render: { kind: 'board', size: 15, pieceStyle: 'stone' },

  settingsSpec: [
    {
      key: 'firstMove', type: 'select', label: '先手', default: 'player',
      options: [
        { value: 'player', label: '玩家（执黑先行）' },
        { value: 'ai', label: 'AI（执黑先行）' },
      ],
    },
  ],
  defaults: { firstMove: 'player' },

  // ---- 给 AI 的接口 ----
  moveFormat: '{"x": 0..14 的整数, "y": 0..14 的整数}（x=列，y=行）',
  moveToText,
  describeState,
  legalMoves(state) {
    const out = []
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!state.board[idx(x, y)]) out.push({ x, y })
    return out
  },

  // ---- 给 AI 的棋力支持（可选接口，见 lib/mods.js）----
  // 五子棋的胜负只由棋型决定，模型很难稳定看出活三/冲四；
  // 这里给出本地引擎的三件套：战术说明、候选点、必杀必防纠错与兜底。
  agentHint: AGENT_HINT,

  /** 提示词里的「引擎建议」候选点（按强弱排序）。 */
  agentCandidates(state, seat, limit) {
    return rankMoves(state, seat, limit || 4)
  },

  /** 模型失败/未配置时的兜底落点：走本地引擎，不再随机挑空点。 */
  agentFallback(state, seat) {
    return bestMove(state, seat)
  },

  /** 只在「必杀 / 必防」时纠正模型的一手；模型本身下对了就原样保留。 */
  refineMove(state, seat, move) {
    if (!move || typeof move.x !== 'number' || typeof move.y !== 'number') return move
    const { wins, blocks } = mustPlays(state, seat)
    const isOne = (point) => point && point.x === move.x && point.y === move.y
    if (wins.length) return wins.some(isOne) ? move : wins[0]
    if (blocks.length) return blocks.some(isOne) ? move : blocks[0]
    return move
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
    if (!inBounds(x, y)) return '超出棋盘范围（0..' + (N - 1) + '）'
    if (state.board[idx(x, y)]) return '该位置已有棋子'
    return null
  },

  applyMove(state, seat, move) {
    const color = state.colors[seat]
    const x = move.x, y = move.y
    state.board[idx(x, y)] = color
    state.lastMove = { x, y }
    state.moveCount++
    const events = [{ type: 'move', seat, move, x, y, color }]
    if (checkWin(state.board, x, y, color)) {
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
