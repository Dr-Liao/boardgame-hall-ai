// 大厅测试专用 Mod：只用于 tests/hall/，不随发布包分发。
//
// P1.4「静态表只发一次」的 wire 级夹具，只覆盖大厅通用机制：
//   - staticTables(state) 返回两张公开静态表（cards 很大、investigatorDefs 中等）；
//   - viewState(state, seat, { includeStatic:false, publicCardCodes/publicCards }) 省略两表；
//   - 运行时注入的卡面：落在公共区（table）的进 view.cardsPatch，落在本人手牌的进 view.privateCards；
//   - 私有手牌只给本人看（和 fixture-cards 一样），用来守「私有卡面绝不进公共表」。
//
// P3.2 A1′「共享 state clone」回归探针（仅 FIXTURE_SHARED_PROBE=1 时启用）：
//   - viewState 记录收到的 state 对象与 options.stateIsolated，并故意写入入参（顶层 __probe +
//     嵌套 table 数组）——若大厅误把权威 state（而非隔离副本）传进来，checkpointView 能观察到污染；
//   - checkpointView 每次视图生成后记录权威 session.state 的 JSON 哈希与探针计数，用来断言
//     「视图生成期间权威 state 的哈希不变」以及「每 revision 只 clone 一次、四席位共用同一副本」。
//
// 动作：
//   {"x":0-2,"y":0-2} 在 3×3 棋盘落子（通用大厅棋盘界面，浏览器回归用）；
//   {"action":"inject","code":"x-public"|"x-private","target":"table"|"hand"} 注入一张
//   运行时卡面（不在 state.cards 里，用于触发自愈）；{"action":"pass"} 直接推进座位。

import { createHash } from 'node:crypto'

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

// P3.2 共享视图探针（FIXTURE_SHARED_PROBE=1 才记录/写入）。测试直接 import 本模块读这些统计。
const sharedProbe = {
  viewStateCalls: 0,
  isolatedViewStateCalls: 0,
  samples: [],          // [{ revision, isolated, state }]：state 是 viewState 实际收到的入参对象
  authorityChecks: [],  // [{ revision, hash, topProbes, tableProbes }]：checkpointView 观察到的权威 state
}
export function resetSharedProbe() {
  sharedProbe.viewStateCalls = 0
  sharedProbe.isolatedViewStateCalls = 0
  sharedProbe.samples = []
  sharedProbe.authorityChecks = []
  return sharedProbe
}
export function sharedProbeSnapshot() {
  return {
    viewStateCalls: sharedProbe.viewStateCalls,
    isolatedViewStateCalls: sharedProbe.isolatedViewStateCalls,
    samples: sharedProbe.samples.map(sample => ({ revision: sample.revision, isolated: sample.isolated, state: sample.state })),
    authorityChecks: sharedProbe.authorityChecks.map(check => ({ ...check })),
  }
}

const probeEnabled = () => process.env.FIXTURE_SHARED_PROBE === '1'

function probeViewState(state, options) {
  sharedProbe.viewStateCalls++
  const isolated = !!(options && options.stateIsolated === true)
  if (isolated) sharedProbe.isolatedViewStateCalls++
  sharedProbe.samples.push({ revision: Number.isInteger(state?.revision) ? state.revision : -1, isolated, state })
  // 故意写入入参：共享模式下写的是隔离副本；若大厅把权威 state 直接传进来，checkpointView 会看到。
  // 只在 FIXTURE_SHARED_MUTATE=1 时写，避免干扰「回退逐席位浅拷贝」对照用例（那一路 Mod 必须只读）。
  if (process.env.FIXTURE_SHARED_MUTATE !== '1') return
  state.__probe = (state.__probe || 0) + 1
  if (Array.isArray(state.table)) state.table.push('__probe')
}

function stateHash(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

// 每次 sessionView 生成完一个席位的视图后，大厅会用权威 session 调用这里；只做观察，不输出到 wire。
function checkpointView(session) {
  if (!probeEnabled()) return undefined
  const state = session && session.state
  sharedProbe.authorityChecks.push({
    revision: Number.isInteger(state?.revision) ? state.revision : -1,
    hash: stateHash(state),
    topProbes: Number.isInteger(state?.__probe) ? state.__probe : 0,
    tableProbes: Array.isArray(state?.table) ? state.table.filter(value => value === '__probe').length : 0,
  })
  return undefined
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
  if (probeEnabled()) probeViewState(state, options)
  // 故障注入：验证「共享视图异常 → 本局回退逐席位拷贝」的失败模式（只影响测试夹具）。
  if (options && options.stateIsolated === true && process.env.FIXTURE_SHARED_THROW === '1') {
    throw new Error('fixture shared view boom')
  }
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
  // P3.2 A1′：声明 viewState 可接收大厅的共享隔离副本（options.stateIsolated=true）且不修改它。
  // 用函数形式，便于测试通过 FIXTURE_SHARED_CAPABILITY=off 验证「能力缺失 → 回退逐席位拷贝」。
  viewStateSharesState: () => process.env.FIXTURE_SHARED_CAPABILITY !== 'off',
  checkpointView,

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
