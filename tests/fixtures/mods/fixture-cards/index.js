// 大厅测试专用 Mod：只用于 tests/hall/，不随发布包分发。
//
// 用最少的规则覆盖大厅需要验证的 Mod 能力，让大厅回归不依赖任何真实游戏：
//   - 1~4 人合作（cooperative / hideOpponentSettings），可混合人类与 AI 席位
//   - 私有手牌：viewState 只给观察者看自己的手牌
//   - 同时准备：准备阶段 actingSeats 为所有未就绪席位，seatLocalMove 允许旧版本号重放
//   - 待决选择：开局按席位依次换牌，可用 commitChoiceBatch 一次确认多张
//   - 存档兼容：saveCompatibilityFromState + rulesVersion
//
// settings.skipPrep=true 时跳过准备阶段，直接进入换牌。

const RULES_VERSION = 'fixture-cards-1'
const ROLES = ['scout', 'medic', 'scholar', 'guard', 'thief', 'pilot']
const HAND_SIZE = 4
// 公开卡表让状态有一定体量，便于验证联机增量同步确实比整份快照小。
const CARDS = Object.fromEntries(Array.from({ length: 40 }, (_, i) => {
  const code = 'c' + String(i + 1).padStart(2, '0')
  return [code, { code, name: '测试卡 ' + (i + 1), text: '这是一张只用于大厅回归的测试卡，编号 ' + (i + 1) + '，没有任何实际效果。' }]
}))

function shuffled(seed) {
  let x = 2166136261
  for (const ch of String(seed)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0
  const deck = Object.keys(CARDS)
  for (let i = deck.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    const j = x % (i + 1)
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

function startPlay(state) {
  state.phase = 'play'
  state.currentSeat = 0
  state.pendingChoice = { id: 'swap-0', kind: 'swap', seat: 0, selected: [] }
}

function decisionSeat(state) {
  if (state.status !== 'playing') return null
  if (state.phase === 'prep') return state.ready.findIndex(ready => !ready)
  return state.pendingChoice ? state.pendingChoice.seat : state.currentSeat
}

function actingSeats(state) {
  if (state.status !== 'playing') return []
  if (state.phase === 'prep') return state.ready.flatMap((ready, seat) => ready ? [] : [seat])
  return [decisionSeat(state)]
}

function legalMoves(state, seat) {
  if (!actingSeats(state).includes(seat)) return []
  if (state.phase === 'prep') {
    // AI 兜底只按此列表选择：先选职业再就绪，保证准备阶段一定能结束。
    if (state.roles[seat]) return [{ action: 'ready' }]
    return ROLES.filter(role => !state.roles.includes(role)).map(role => ({ action: 'pick', role }))
  }
  const choice = state.pendingChoice
  if (choice) {
    return [
      ...state.hands[seat].map((_, index) => index).filter(index => !choice.selected.includes(index))
        .map(index => ({ action: 'choose', choiceId: choice.id, optionId: String(index) })),
      { action: 'choose', choiceId: choice.id, optionId: 'done' },
    ]
  }
  return state.hands[seat].length
    ? state.hands[seat].map((_, index) => ({ action: 'play', index }))
    : [{ action: 'pass' }]
}

function validateMove(state, seat, move) {
  if (!move || typeof move !== 'object') return '动作必须是对象'
  if (state.status !== 'playing') return '对局已结束'
  if (!actingSeats(state).includes(seat)) return '还没轮到这个席位'
  if (state.phase === 'prep') {
    if (move.action === 'pick') {
      if (!ROLES.includes(move.role)) return '未知职业'
      const owner = state.roles.indexOf(move.role)
      if (owner !== -1 && owner !== seat) return '该职业已被队友选择'
      return null
    }
    if (move.action === 'ready') return state.roles[seat] ? null : '请先选择职业'
    return '准备阶段只能选择职业或就绪'
  }
  const choice = state.pendingChoice
  if (choice) {
    if (move.action !== 'choose' || move.choiceId !== choice.id) return '当前选择已变化'
    if (move.optionId === 'done') return null
    const index = Number(move.optionId)
    if (!/^\d+$/.test(String(move.optionId)) || index >= state.hands[seat].length) return '没有这张手牌'
    return null
  }
  if (move.action === 'pass') return state.hands[seat].length ? '还有手牌时不能跳过' : null
  if (move.action !== 'play' || !Number.isInteger(move.index) || move.index < 0 || move.index >= state.hands[seat].length) return '没有这张手牌'
  return null
}

function applyMove(state, seat, move) {
  state.moveCount++
  if (state.phase === 'prep') {
    if (move.action === 'pick') state.roles[seat] = move.role
    else state.ready[seat] = true
    if (state.ready.every(Boolean)) startPlay(state)
    return [{ type: 'move', seat, move: { ...move } }]
  }
  const choice = state.pendingChoice
  if (choice) {
    if (move.optionId !== 'done') {
      const index = Number(move.optionId)
      choice.selected = choice.selected.includes(index) ? choice.selected.filter(item => item !== index) : [...choice.selected, index]
      return [{ type: 'move', seat, move: { ...move } }]
    }
    for (const index of choice.selected) state.hands[seat][index] = state.deck.shift()
    const next = seat + 1
    state.pendingChoice = next < state.hands.length ? { id: 'swap-' + next, kind: 'swap', seat: next, selected: [] } : null
    return [{ type: 'move', seat, move: { ...move }, swapped: choice.selected.length }]
  }
  if (move.action === 'play') state.table.push({ seat, code: state.hands[seat].splice(move.index, 1)[0] })
  const events = [{ type: 'move', seat, move: { ...move } }]
  if (state.hands.every(hand => !hand.length)) {
    state.status = 'over'
    state.winnerSeat = 0
    events.push({ type: 'win', seat: 0 })
  } else {
    state.currentSeat = (seat + 1) % state.hands.length
  }
  return events
}

export default {
  id: 'fixture-cards',
  name: '测试牌局',
  players: [1, 4],
  seats: 4,
  cooperative: true,
  hideOpponentSettings: true,
  cover: 'linear-gradient(135deg, #444 0%, #111 100%)',
  coverEmoji: '🧪',
  description: '大厅回归专用的合作牌局。',
  tags: ['测试'],
  render: { kind: 'cards' },
  settingsSpec: [
    {
      key: 'seed',
      type: 'select',
      label: '牌堆种子',
      default: 'fixture',
      options: [{ value: 'fixture', label: '固定（fixture）' }, { value: 'random', label: '随机' }],
    },
  ],
  defaults: { seed: 'fixture' },

  // 可选 i18n：供大厅回归验证「目录元数据按语言下发」的契约（docs/localization.md §7.1）。
  // 只有 messages 里出现的字段才被覆盖；省略的字段回退基础字段。
  i18n: {
    defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en'],
    messages: {
      'zh-CN': {
        aiSlotLabel: '测试 AI 对手',
        aiSlotDescription: '由 AI 扮演的测试对手',
        settings: {
          seed: { label: '牌堆种子', description: '固定牌堆顺序，便于回归' },
        },
      },
      en: {
        name: 'Fixture Card Game',
        description: 'Cooperative card game used only by hall regressions.',
        tags: ['Test'],
        aiSlotLabel: 'Test AI opponent',
        aiSlotDescription: 'An AI-controlled test opponent',
        settings: {
          seed: { label: 'Deck seed', description: 'Fixed deck order for deterministic regressions' },
        },
      },
    },
  },

  // 可选：前端语言包放在 web/locales/，由大厅生成 mod.web.localeUrls / catalog 的 i18n.files。
  web: {
    dir: 'web',
    locales: {
      'zh-CN': 'locales/zh-CN.js',
      en: 'locales/en.js',
    },
  },

  moveFormat: '{"action":"pick","role":"..."} | {"action":"ready"} | {"action":"choose","choiceId":"...","optionId":"..."} | {"action":"play","index":0} | {"action":"pass"}',
  moveToText: move => JSON.stringify(move),
  describeState: (state, seat) => `阶段 ${state.phase}；你的手牌：${(state.hands[seat] || []).join(', ') || '无'}`,
  legalMoves,
  decisionSeat,
  actingSeats,
  seatLocalMove: (state, seat, move) => state.phase === 'prep' && ['pick', 'ready'].includes(move?.action),
  validateMove,
  applyMove,

  createState(settings, players) {
    const deck = shuffled(settings.seed || 'fixture')
    const state = {
      status: 'playing', winnerSeat: null, currentSeat: 0, moveCount: 0,
      rulesVersion: RULES_VERSION, phase: 'prep', cards: CARDS,
      roles: players.map(() => null), ready: players.map(() => false),
      hands: players.map(() => deck.splice(0, HAND_SIZE)), deck, table: [], pendingChoice: null,
    }
    if (settings.skipPrep) {
      state.roles = players.map((_, seat) => ROLES[seat])
      state.ready = players.map(() => true)
      startPlay(state)
    }
    return state
  },

  viewState(state, seat) {
    const view = structuredClone(state)
    view.hands = view.hands.map((hand, owner) => owner === seat ? hand : [])
    view.deck = []
    if (view.pendingChoice && view.pendingChoice.seat !== seat) view.pendingChoice.selected = []
    view.legalMoves = legalMoves(state, seat)
    return view
  },

  saveCompatibilityFromState: true,
  saveCompatibilityError: state => state?.rulesVersion === RULES_VERSION ? null : '测试牌局规则版本不兼容',

  commitChoiceBatch(session, seat, batch, { commitMove, moveError }) {
    const choice = session.state.pendingChoice
    if (!batch || batch.kind !== 'swap' || typeof batch.finish !== 'string' || !Array.isArray(batch.selected) || !batch.selected.length) throw moveError('不支持的批量选择')
    if (choice?.id !== batch.choiceId || choice.seat !== seat) throw moveError('当前选择已变化，请刷新后重试')
    const hand = session.state.hands[seat]
    for (const item of batch.selected) {
      if (!Number.isInteger(item?.index) || hand[item.index] !== item.code) throw moveError('所选手牌已变化，请重新选择')
    }
    // 在草稿上逐步提交，任何一步失败都不影响真实会话。
    const before = session.state
    const eventStart = session.events.length
    const draft = { ...session, events: [...session.events] }
    for (const item of batch.selected) {
      commitMove(draft, seat, { action: 'choose', choiceId: choice.id, optionId: String(item.index) }, draft.state.revision)
    }
    commitMove(draft, seat, { action: 'choose', choiceId: choice.id, optionId: batch.finish }, draft.state.revision)
    session.state = draft.state
    session.events = draft.events
    return { before, after: session.state, events: session.events.slice(eventStart), seat, move: { action: 'choiceBatch', kind: 'swap' }, revision: session.state.revision }
  },
}
