// 大厅测试专用 Mod：只用于 tests/hall/，不随发布包分发。
//
// 自动跳过（P0 单座位 / P1 全员缓存）的 wire 级夹具：只覆盖大厅通用机制，不依赖诡镇 Mod。
//   - `{action:'open'}` 打开本座位的 `kind:'reaction'` 可跳过窗口（选项 skip / trigger，
//     trigger 带 cardCode:'opt-card'，供偏好映射）；
//   - `{action:'openAll'}` 按座位 0..N-1 打开一条**连续窗口链**（模拟「所有人同时满足触发条件」）；
//     每次回答后在同一事务里给下一个座位开窗，直到链走完——用来验证 P1 能否在一个命令里全部代答；
//   - `{action:'next'}` 把行动权交给下一席位；`{action:'mark'}` 只记一条日志（用来捎带偏好）；
//   - `{action:'end'}` 结束对局；
//   - autoPassChoice 钩子：窗口所有选项的卡号都在 disabledCodes 里时返回普通 choose/skip。
//
// 断言口径：skip 与手点一样走 applyMove，所以 state.log 里能同时看到 open/openAll 与 skip。

const OPTION_CODE = 'opt-card'

function choiceFor(seat, id) {
  return {
    id, kind: 'reaction', seat, canSkip: true, source: OPTION_CODE,
    options: [{ id: 'skip', label: '跳过' }, { id: 'trigger', label: '触发', cardCode: OPTION_CODE }],
  }
}

function decisionSeat(state) {
  if (state.status !== 'playing') return null
  return state.pendingChoice ? state.pendingChoice.seat : state.currentSeat
}

function actingSeats(state) {
  const seat = decisionSeat(state)
  return seat === null ? [] : [seat]
}

function legalMoves(state, seat) {
  if (!actingSeats(state).includes(seat)) return []
  const choice = state.pendingChoice
  if (choice) {
    return choice.options.map(option => ({ action: 'choose', choiceId: choice.id, optionId: option.id }))
  }
  return [{ action: 'open' }, { action: 'openAll' }, { action: 'next' }, { action: 'mark' }, { action: 'end' }]
}

function validateMove(state, seat, move) {
  if (state.status !== 'playing') return '对局已结束'
  if (!actingSeats(state).includes(seat)) return '还没轮到该席位'
  const choice = state.pendingChoice
  if (choice) {
    if (move.action !== 'choose' || move.choiceId !== choice.id) return '当前选择已变化'
    if (!choice.options.some(option => option.id === move.optionId)) return '没有这个选项'
    return null
  }
  if (!['open', 'openAll', 'next', 'mark', 'end'].includes(move.action)) return '未知动作'
  return null
}

function applyMove(state, seat, move) {
  if (move.action === 'open') {
    state.pendingChoice = choiceFor(seat, 'opt-' + state.revision)
    state.log.push({ seat, move: { action: 'open' } })
    return [{ type: 'move', seat, move: { action: 'open' } }]
  }
  if (move.action === 'openAll') {
    // 连续窗口链：座位 0..N-1 依次开窗，全部在同一个事务（同一条命令）里推进。
    state.group = Array.from({ length: state.seats }, (_, index) => index)
    state.groupCursor = 0
    state.pendingChoice = choiceFor(0, 'opt-all-0')
    state.log.push({ seat, move: { action: 'openAll' } })
    return [{ type: 'move', seat, move: { action: 'openAll' } }]
  }
  if (move.action === 'next') {
    state.currentSeat = (seat + 1) % state.seats
    state.log.push({ seat, move: { action: 'next' } })
    return [{ type: 'move', seat, move: { action: 'next' } }]
  }
  if (move.action === 'mark') {
    state.log.push({ seat, move: { action: 'mark' } })
    return [{ type: 'move', seat, move: { action: 'mark' } }]
  }
  if (move.action === 'end') {
    state.status = 'over'
    state.log.push({ seat, move: { action: 'end' } })
    return [{ type: 'move', seat, move: { action: 'end' } }]
  }
  const choice = state.pendingChoice
  if (choice && move.optionId === 'trigger') state.triggered++
  state.log.push({ seat, move: { action: 'choose', choiceId: move.choiceId, optionId: move.optionId } })
  const event = { type: 'move', seat, move: { action: 'choose', choiceId: move.choiceId, optionId: move.optionId } }
  if (state.group) {
    state.groupCursor++
    if (state.groupCursor < state.group.length) {
      const next = state.group[state.groupCursor]
      state.pendingChoice = choiceFor(next, 'opt-all-' + next)
    } else {
      state.pendingChoice = null
      state.currentSeat = state.group[state.group.length - 1]
      state.group = null
      state.groupCursor = 0
      state.completed = (state.completed || 0) + 1
    }
    return [event]
  }
  state.pendingChoice = null
  return [event]
}

export default {
  id: 'fixture-autopass',
  name: '自动跳过测试局',
  players: [1, 4],
  seats: 4,
  cooperative: true,
  hideOpponentSettings: true,
  cover: 'linear-gradient(135deg, #444 0%, #111 100%)',
  coverEmoji: '⏭️',
  description: '大厅回归专用：自动跳过（宿主代答 / 全员偏好缓存）。',
  tags: ['测试'],
  render: { kind: 'plain' },
  settingsSpec: [],
  defaults: { seed: 'autopass' },

  moveFormat: '{"action":"open"} | {"action":"openAll"} | {"action":"next"} | {"action":"mark"} | {"action":"end"} | {"action":"choose","choiceId":"...","optionId":"..."}',
  moveToText: move => JSON.stringify(move),
  describeState: (state, seat) => `待决：${state.pendingChoice ? state.pendingChoice.id : '无'}；当前席位：${state.currentSeat}`,
  legalMoves,
  decisionSeat,
  actingSeats,
  validateMove,
  applyMove,

  createState(settings, players) {
    return {
      status: 'playing', seats: players.length, currentSeat: 0, pendingChoice: null, triggered: 0,
      completed: 0, group: null, groupCursor: 0, log: [],
    }
  },

  // 自动跳过钩子：窗口所有非 skip 选项都映射到已关闭的卡号时，返回一条普通 choose/skip。
  autoPassChoice({ state, seat, disabledCodes }) {
    const choice = state?.pendingChoice
    if (!choice || !choice.canSkip || choice.seat !== seat) return null
    const codes = choice.options.map(option => option.cardCode).filter(Boolean)
    if (!codes.length || !codes.every(code => disabledCodes.includes(code))) return null
    return { action: 'choose', choiceId: choice.id, optionId: 'skip' }
  },
}
