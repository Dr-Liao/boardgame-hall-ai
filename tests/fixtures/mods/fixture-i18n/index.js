// 大厅测试专用 Mod：只用于 tests/hall/（含浏览器用例），不随发布包分发。
//
// 用来验证 Mod 本地化契约（docs/localization.md §7.1 / §7.6 / §8.2）：
//   - index.js 声明可选的 i18n：defaultLocale / supportedLocales / messages；
//   - messages 覆盖目录展示字段（name / description / tags / aiSlotLabel / aiSlotDescription）
//     与一个设置项的 label/description/options 文本；
//   - web.locales 声明两个语言包文件，大厅生成 mod.web.localeUrls 随 catalog 的 i18n.files 下发；
//   - web/client.js 导出 createUI(host)，用 host.locale 选择语言包，并实现 onLocaleChange
//     （同步、幂等、不重置对局，只重绘文案）。
//
// 规则部分是最小 3×3 棋盘：与合作类测试 Mod 一样 hideOpponentSettings，人数取 playerCount，
// 浏览器用例可以不开 AI 摆一局；只用于渲染与切换语言的回归，不追求完整棋类规则。
const BOARD_SIZE = 3
const TAGS = ['测试', '本地化']

function decisionSeat(state) {
  return state.status === 'playing' ? state.currentSeat : null
}

function actingSeats(state) {
  if (state.status !== 'playing') return []
  return [state.currentSeat]
}

function boardMoves(state) {
  const moves = []
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (!state.board[y * BOARD_SIZE + x]) moves.push({ x, y })
    }
  }
  return moves
}

function legalMoves(state, seat) {
  if (!actingSeats(state).includes(seat)) return []
  return boardMoves(state)
}

function validateMove(state, seat, move) {
  if (!move || typeof move !== 'object') return '动作必须是对象'
  if (state.status !== 'playing') return '对局已结束'
  if (!actingSeats(state).includes(seat)) return '还没轮到这个席位'
  if (!Number.isInteger(move.x) || !Number.isInteger(move.y)) return '坐标必须是整数'
  if (move.x < 0 || move.x >= BOARD_SIZE || move.y < 0 || move.y >= BOARD_SIZE) return '坐标越界'
  if (state.board[move.y * BOARD_SIZE + move.x]) return '该格已有棋子'
  return null
}

function winLine(board, value) {
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (board[i * BOARD_SIZE] === value && board[i * BOARD_SIZE + 1] === value && board[i * BOARD_SIZE + 2] === value) return true
    if (board[i] === value && board[BOARD_SIZE + i] === value && board[2 * BOARD_SIZE + i] === value) return true
  }
  return (board[0] === value && board[4] === value && board[8] === value) ||
    (board[2] === value && board[4] === value && board[6] === value)
}

function applyMove(state, seat, move) {
  state.moveCount++
  const value = seat === 0 ? 'black' : 'white'
  state.board[move.y * BOARD_SIZE + move.x] = value
  const events = [{ type: 'move', seat, move: { x: move.x, y: move.y } }]
  if (winLine(state.board, value)) {
    state.status = 'over'
    state.winnerSeat = seat
    events.push({ type: 'win', seat })
    return events
  }
  if (state.board.every(Boolean)) {
    state.status = 'draw'
    state.winnerSeat = null
    events.push({ type: 'draw' })
    return events
  }
  state.currentSeat = (seat + 1) % state.seats
  return events
}

export default {
  id: 'fixture-i18n',
  name: '本地化测试棋局',
  players: [1, 4],
  seats: 4,
  cooperative: true,
  hideOpponentSettings: true,
  cover: 'linear-gradient(135deg, #2d6a4f 0%, #081c15 100%)',
  coverEmoji: '🌐',
  description: '用于验证大厅与游戏语言包契约的测试棋局。',
  tags: TAGS,
  render: { kind: 'board', size: BOARD_SIZE, pieceStyle: 'stone' },
  settingsSpec: [
    {
      key: 'mode',
      type: 'select',
      label: '对局模式',
      default: 'normal',
      options: [{ value: 'normal', label: '普通' }, { value: 'quick', label: '快速' }],
    },
  ],
  defaults: { seed: 'fixture-i18n' },

  // 可选：游戏自带本地化元数据（由大厅在服务端合并，随 catalog 下发解析结果）。
  i18n: {
    defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en'],
    messages: {
      'zh-CN': {
        aiSlotLabel: '测试 AI 对手',
        aiSlotDescription: '由 AI 扮演的测试对手',
        settings: {
          mode: { label: '对局模式', description: '仅用于大厅测试的模式选项', options: { normal: '普通', quick: '快速' } },
        },
      },
      en: {
        name: 'Localization Fixture',
        description: 'A tiny 3×3 test game that verifies the hall localization contract.',
        tags: ['Test', 'Localization'],
        aiSlotLabel: 'Fixture AI opponent',
        aiSlotDescription: 'An AI-controlled opponent used only by hall tests',
        settings: {
          mode: { label: 'Game mode', description: 'Mode option used only by hall tests', options: { normal: 'Normal', quick: 'Quick' } },
        },
      },
    },
  },

  // 可选：游戏自己携带的前端语言包。由大厅挂载到 /mods/fixture-i18n/ 并生成 host.locale.files。
  web: {
    dir: 'web',
    client: 'client.js',
    locales: {
      'zh-CN': 'locales/zh-CN.js',
      en: 'locales/en.js',
    },
  },

  moveFormat: '{"x":0-2,"y":0-2}',
  moveToText: (move) => '(' + move.x + ',' + move.y + ')',
  describeState: (state, seat) =>
    '测试棋盘：' + state.board.map((cell) => (cell ? (cell === 'black' ? '●' : '○') : '·')).join('') + '；当前席位：' + state.currentSeat,
  decisionSeat,
  actingSeats,
  legalMoves,
  validateMove,
  applyMove,

  createState(settings, players) {
    return {
      status: 'playing',
      winnerSeat: null,
      currentSeat: 0,
      moveCount: 0,
      seats: players.length,
      board: Array(BOARD_SIZE * BOARD_SIZE).fill(null),
    }
  },
}
