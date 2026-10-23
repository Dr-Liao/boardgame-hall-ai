// 大厅测试专用 Mod：只用于 tests/hall/，不随发布包分发。
//
// P1.4「静态表只发一次」的 wire 级夹具，只覆盖大厅通用机制：
//   - staticTables(state) 返回两张公开静态表（cards 很大、investigatorDefs 中等）；
//   - viewState(state, seat, { includeStatic:false, publicCardCodes/publicCards }) 省略两表；
//   - 运行时注入的卡面：落在公共区（table）的进 view.cardsPatch，落在本人手牌的进 view.privateCards；
//   - 私有手牌只给本人看（和 fixture-cards 一样），用来守「私有卡面绝不进公共表」。
//
// 动作：
//   {"x":0-2,"y":0-2} 在 3×3 棋盘落子（通用大厅棋盘界面，浏览器回归用）；
//   {"action":"inject","code":"x-public"|"x-private","target":"table"|"hand"} 注入一张
//   运行时卡面（不在 state.cards 里，用于触发自愈）；{"action":"pass"} 直接推进座位。

const RULES_VERSION = 'fixture-static-1'
const SEAT_COUNT = 4

// 公共卡表：约 140KB，让「省略静态表」在字节上足够明显。
const CARD_TEXT = '这是一张只用于大厅静态表回归的测试卡，卡面文本用于制造足够大的公共静态表体积，没有任何实际效果。'
const CARDS = Object.fromEntries(Array.from({ length: 120 }, (_, i) => {
  const code = 's' + String(i + 1).padStart(3, '0')
  return [code, { code, name: '静态测试卡 ' + (i + 1), text: CARD_TEXT + ' 编号 ' + (i + 1) + '。', type: 'asset' }]
}))
const CARD_CODES = Object.keys(CARDS)

// 调查员定义表：约 20KB，和 cards 一起构成「两张公共静态表」。
const INVESTIGATOR_DEFS = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
  const code = 'inv' + String(i + 1).padStart(2, '0')
  return [code, { code, name: '调查员 ' + (i + 1), text: '调查员定义占位文本，用于制造第二张公共静态表的体积。'.repeat(6), klass: 'seeker' }]
}))

// 运行时才会出现的卡面（不在 CARDS / state.cards 里）：x-private 只进本人 privateCards，
// x-public 落在公共桌面 → 应该走 cardsPatch 并进公共静态表。
const RUNTIME_CARDS = {
  'x-private': { code: 'x-private', name: '私有自愈卡', text: '只在本人手牌里可见的运行时卡面。', type: 'asset' },
  'x-public': { code: 'x-public', name: '公共自愈卡', text: '出现在公共桌面上、所有席位都可见的运行时卡面。', type: 'asset' },
}

function startState(players) {
  const hands = players.map((_, seat) => CARD_CODES.slice(seat * 3, seat * 3 + 3))
  return {
    status: 'playing', winnerSeat: null, currentSeat: 0, moveCount: 0, phase: 'play',
    rulesVersion: RULES_VERSION,
    cards: CARDS, investigatorDefs: INVESTIGATOR_DEFS,
    hands,
    table: [],
    // 3×3 棋盘：大厅通用棋盘界面按 render.kind/board 渲染，浏览器回归用它验证 hydrate 后的渲染。
    board: Array(9).fill(null),
    deckSize: CARD_CODES.length - hands.length * 3,
  }
}

const BOARD_SIZE = 3

function actingSeats(state) { return state.status === 'playing' ? [state.currentSeat] : [] }
function decisionSeat(state) { return state.status === 'playing' ? state.currentSeat : null }
function boardMoves(state) {
  const moves = []
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) if (!state.board[y * BOARD_SIZE + x]) moves.push({ x, y })
  }
  return moves
}
function legalMoves(state, seat) {
  if (state.status !== 'playing' || state.currentSeat !== seat) return []
  const moves = [...boardMoves(state), { action: 'pass' }]
  for (const code of Object.keys(RUNTIME_CARDS)) {
    moves.push({ action: 'inject', code, target: 'table' })
    moves.push({ action: 'inject', code, target: 'hand' })
  }
  return moves
}

function validateMove(state, seat, move) {
  if (!move || typeof move !== 'object') return '动作必须是对象'
  if (state.status !== 'playing') return '对局已结束'
  if (state.currentSeat !== seat) return '还没轮到这个席位'
  if (Number.isInteger(move.x) || Number.isInteger(move.y)) {
    if (!Number.isInteger(move.x) || !Number.isInteger(move.y) || move.x < 0 || move.x >= BOARD_SIZE || move.y < 0 || move.y >= BOARD_SIZE) return '坐标越界'
    if (state.board[move.y * BOARD_SIZE + move.x]) return '该格已有棋子'
    return null
  }
  if (move.action === 'pass') return null
  if (move.action === 'inject') {
    if (!RUNTIME_CARDS[move.code]) return '未知运行时卡'
    if (!['table', 'hand'].includes(move.target)) return '未知注入位置'
    return null
  }
  return '未知动作'
}

function applyMove(state, seat, move) {
  state.moveCount++
  if (Number.isInteger(move.x)) {
    state.board[move.y * BOARD_SIZE + move.x] = seat === 0 ? 'black' : 'white'
  } else if (move.action === 'inject') {
    if (move.target === 'table') state.table.push(move.code)
    else state.hands[seat].push(move.code)
  }
  state.currentSeat = (seat + 1) % state.hands.length
  return [{ type: 'move', seat, move: { ...move } }]
}

// 公共表自愈：全量模式下把缺失卡面直接补进 view.cards（供逐字节对照）；精简模式下
// 分别给出 cardsPatch（公共）/ privateCards（本人私有）。
function healCards(state, view, observer, options) {
  const publicCards = options.publicCards || null
  const known = code => (publicCards ? publicCards[code] : view.cards?.[code])
  const publicZone = new Set(state.table)
  const ownPrivate = new Set(observer == null ? [] : state.hands[observer] || [])
  const missing = new Set()
  for (const code of [...publicZone, ...ownPrivate]) if (code && !known(code)) missing.add(code)
  if (!missing.size) return
  for (const code of missing) {
    const def = RUNTIME_CARDS[code]
    if (!def) continue
    if (publicCards) {
      if (publicZone.has(code) || !ownPrivate.has(code)) (view.cardsPatch ||= {})[code] = def
      else (view.privateCards ||= {})[code] = def
    } else {
      ;(view.cards ||= {})[code] = def
    }
  }
}

function viewState(state, observerSeat = null, options = {}) {
  const includeStatic = !(options && options.includeStatic === false)
  const view = { ...state }
  if (!includeStatic) {
    delete view.cards
    delete view.investigatorDefs
  }
  view.hands = state.hands.map((hand, owner) => owner === observerSeat ? [...hand] : [])
  view.table = [...state.table]
  view.legalMoves = legalMoves(state, observerSeat)
  healCards(state, view, observerSeat, options)
  return view
}

export default {
  id: 'fixture-static',
  name: '静态表夹具牌局',
  players: [1, 4],
  seats: SEAT_COUNT,
  cooperative: true,
  hideOpponentSettings: true,
  cover: 'linear-gradient(135deg, #334 0%, #112 100%)',
  coverEmoji: '🧩',
  description: '大厅静态表回归专用的合作牌局。',
  tags: ['测试'],
  render: { kind: 'board', size: BOARD_SIZE, pieceStyle: 'stone' },
  settingsSpec: [],
  defaults: { seed: 'fixture-static' },

  moveFormat: '{"action":"pass"} | {"action":"inject","code":"x-public","target":"table"}',
  moveToText: move => JSON.stringify(move),
  describeState: (state, seat) => `桌面 ${state.table.length} 张；你的手牌：${(state.hands[seat] || []).join(', ') || '无'}`,
  legalMoves,
  decisionSeat,
  actingSeats,
  validateMove,
  applyMove,

  createState(settings, players) {
    const state = startState(players)
    return state
  },

  viewState,

  // P1.4：公共静态表只能来自这里；返回独立副本，供大厅长期缓存与 cardsPatch 合并。
  staticTables(state) {
    return {
      cards: structuredClone(state.cards || {}),
      investigatorDefs: structuredClone(state.investigatorDefs || {}),
    }
  },

  saveCompatibilityFromState: true,
  saveCompatibilityError: state => state?.rulesVersion === RULES_VERSION ? null : '静态表测试牌局规则版本不兼容',
}
