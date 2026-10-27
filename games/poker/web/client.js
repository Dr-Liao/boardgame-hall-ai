import { beats, classify } from './rules.js'
import { moveHandCard, reconcileHandOrder, sortedHandOrder } from './hand-order.js'

const rankName = rank => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '小王', 16: '大王' })[rank] || String(rank)
const face = card => card.rank >= 15 ? rankName(card.rank) : `${card.suit}${rankName(card.rank)}`
const typeName = { single: '单张', pair: '对子', triple: '三张', fullHouse: '三带二', straight: '顺子',
  pairs: '三连对', triples: '钢板', bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '天王炸' }
const patternName = pattern => `${typeName[pattern.type] || pattern.type}${['straight', 'pairs', 'triples', 'straightFlush'].includes(pattern.type) ? ` · ${rankName(pattern.rank)} 高` : ''}`
const imageAvatar = value => typeof value === 'string' && (
  /^data:image\//i.test(value) || /^blob:/i.test(value) || /^https?:\/\//i.test(value) || /^\/avatars\/[a-z0-9-]+\.webp$/i.test(value)
)

export function createUI(host) {
  const { h } = host
  let selected = new Set()
  let pending = false
  let notice = ''
  let lastRevision = null
  let bubbleSession = null
  let lastBubbleSeq = -1
  let bubbles = new Map()
  let bubbleTimer = null
  let handDeal = null
  let handOrder = []
  let drag = null
  let suppressClickUntil = 0

  function onCardPointerDown(event, id) {
    if (event.button !== 0 || drag) return
    if (event.pointerType === 'touch' && !event.target.closest('.gd-card-grip')) return
    drag = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, source: event.currentTarget }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onCardPointerMove(event) {
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return
    drag.moved = true
    drag.source.classList.add('gd-dragging')
    document.querySelector('.gd-hand .gd-drop-target')?.classList.remove('gd-drop-target')
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.gd-hand .gd-card[data-card-id]')
    if (target && target !== drag.source) target.classList.add('gd-drop-target')
  }

  function onCardPointerEnd(event) {
    if (!drag || drag.pointerId !== event.pointerId) return
    const current = drag
    drag = null
    current.source.classList.remove('gd-dragging')
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.gd-hand .gd-card[data-card-id]')
    document.querySelector('.gd-hand .gd-drop-target')?.classList.remove('gd-drop-target')
    if (!current.moved) return
    suppressClickUntil = Date.now() + 350
    if (event.type !== 'pointercancel' && target && target.dataset.cardId !== current.id) {
      handOrder = moveHandCard(handOrder, current.id, target.dataset.cardId)
      host.render()
    }
  }

  function syncBubbles(session) {
    const events = (session.events || []).filter(event => Number.isSafeInteger(event.seq))
    if (bubbleSession !== session.sessionId) {
      bubbleSession = session.sessionId
      lastBubbleSeq = Math.max(-1, ...events.map(event => event.seq))
      bubbles = new Map()
    } else {
      const now = Date.now()
      for (const event of events) {
        if (event.seq <= lastBubbleSeq || !['speech', 'chat'].includes(event.type) || !Number.isInteger(event.seat) || !event.text) continue
        bubbles.set(event.seat, { text: event.text, expires: now + 7000 })
      }
      lastBubbleSeq = Math.max(lastBubbleSeq, ...events.map(event => event.seq))
      for (const [seat, bubble] of bubbles) if (bubble.expires <= now) bubbles.delete(seat)
    }
    clearTimeout(bubbleTimer)
    if (bubbles.size) {
      const nextExpiry = Math.min(...[...bubbles.values()].map(bubble => bubble.expires))
      bubbleTimer = setTimeout(() => { if (host.state.session?.sessionId === bubbleSession) host.render() }, Math.max(1, nextExpiry - Date.now()))
    }
  }

  async function send(move) {
    const session = host.state.session
    if (!session || pending || host.state.busy) return
    if (move.action === 'play' && playReason(session, move.cards)) return
    pending = true; notice = ''
    const selectedBefore = new Set(selected)
    const handOrderBefore = [...handOrder]
    if (!session.online && move.action === 'play') {
      const chosen = new Set(move.cards)
      const cards = (session.state.hands?.[session.mySeat ?? 0] || []).filter(card => chosen.has(card.id))
      if (cards.length === chosen.size) {
        const me = session.mySeat ?? 0
        const hands = session.state.hands.map((hand, seat) => seat === me ? hand.filter(card => !chosen.has(card.id)) : hand)
        host.state.session = { ...session, state: { ...session.state, hands,
          table: { seat: me, cards, pattern: { type: '出牌中' } },
          currentSeat: (me + 1) % 4 } }
        selected.clear()
      }
    }
    host.render()
    let waiting = !session.online
    let progressTimer
    const poll = async () => {
      if (!waiting || host.state.session?.sessionId !== session.sessionId) return
      try {
        const result = await host.api('GET', '/session?sessionId=' + encodeURIComponent(session.sessionId))
        const current = host.state.session
        if (waiting && current?.sessionId === session.sessionId && result.session &&
            (result.session.state.revision > current.state.revision || result.session.events.length > current.events.length)) {
          host.state.session = result.session
          host.render()
        }
      } catch { /* The move response remains authoritative. */ }
      if (waiting) progressTimer = setTimeout(poll, 200)
    }
    if (waiting) progressTimer = setTimeout(poll, 100)
    try {
      const value = await host.api('POST', '/move', { sessionId: session.sessionId, revision: session.state.revision, move })
      if (value.session && host.state.session?.sessionId === session.sessionId) {
        host.state.session = value.session; host.rememberSession(value.session.sessionId)
      }
      selected.clear()
    } catch (error) {
      if (host.state.session?.sessionId === session.sessionId) host.state.session = error.session || session
      selected = selectedBefore
      handOrder = handOrderBefore
      notice = error.message || '出牌失败'
    } finally { waiting = false; clearTimeout(progressTimer); pending = false; host.render() }
  }

  function playReason(session, ids) {
    const game = session.state
    const me = session.mySeat ?? 0
    if (game.status !== 'playing') return '本局已结束'
    if (game.currentSeat !== me) return '尚未轮到你出牌'
    if (pending || host.state.busy || (session.online && (!host.state.online?.connected || host.state.online?.busy))) return '正在等待当前行动结算'
    if (game.phase === 'between') return '请开始下一副'
    if (game.phase === 'return') {
      if (ids.length !== 1) return '请选择一张还贡牌'
      const card = (game.hands?.[me] || []).find(item => item.id === ids[0])
      const hasLow = (game.hands?.[me] || []).some(item => item.rank <= 10)
      return !card || hasLow && card.rank > 10 ? '还贡牌不得大于10' : ''
    }
    if (!ids.length) return '请先选择手牌'
    const byId = new Map((game.hands?.[me] || []).map(card => [card.id, card]))
    const cards = ids.map(id => byId.get(id))
    if (ids.length > 10 || new Set(ids).size !== ids.length || cards.some(card => !card)) return '手牌选择无效'
    const pattern = classify(cards, game.level)
    if (!pattern) return '所选牌不符合掼蛋牌型'
    if (!beats(pattern, game.table?.pattern)) return '当前牌型压不过桌面'
    return ''
  }

  function playingCard(card, options = {}) {
    if (!card) return h('span', { className: 'gd-card gd-back', 'aria-label': '背面' }, '✦')
    const red = card.suit === '♥' || card.suit === '♦' || card.rank === 16
    return h(options.button ? 'button' : 'span', {
      type: options.button ? 'button' : undefined,
      className: 'gd-card' + (red ? ' gd-red' : '') + (options.selected ? ' gd-selected' : '') + (options.wild ? ' gd-wild' : ''),
      title: face(card) + (options.wild ? ' · 逢人配' : ''),
      'aria-label': face(card), 'aria-pressed': options.button ? String(!!options.selected) : undefined,
      disabled: options.button && options.disabled,
      'aria-disabled': options['aria-disabled'] === undefined ? undefined : String(options['aria-disabled']),
      'data-card-id': options['data-card-id'],
      onpointerdown: options.onpointerdown, onpointermove: options.onpointermove,
      onpointerup: options.onpointerup, onpointercancel: options.onpointercancel,
      onclick: options.onclick,
    }, h('span', { className: 'gd-card-corner' }, face(card)), h('span', { className: 'gd-card-suit' }, card.rank >= 15 ? '★' : card.suit),
    options.button ? h('span', { className: 'gd-card-grip', 'aria-hidden': 'true' }, '⋮') : null)
  }

  function renderGame(session) {
    syncBubbles(session)
    const game = session.state
    const phase = game.phase || 'play'
    const me = session.mySeat ?? 0
    const hand = game.hands?.[me] || []
    const dealKey = `${session.sessionId}:${game.dealId || game.round || 1}`
    if (handDeal !== dealKey) {
      handDeal = dealKey
      handOrder = sortedHandOrder(hand, game.level)
      selected.clear()
    } else handOrder = reconcileHandOrder(handOrder, hand)
    const byId = new Map(hand.map(card => [card.id, card]))
    const displayedHand = handOrder.map(id => byId.get(id)).filter(Boolean)
    const myTurn = game.status === 'playing' && game.currentSeat === me && !pending && !host.state.busy && (!session.online || host.state.online?.connected && !host.state.online?.busy)
    const active = myTurn && phase === 'play'
    const returning = myTurn && phase === 'return'
    const selecting = active || returning
    const canPass = active && !!game.table
    if (lastRevision !== game.revision) { selected = new Set([...selected].filter(id => hand.some(card => card?.id === id))); lastRevision = game.revision }
    const invalidPlay = playReason(session, [...selected])
    const selectedCards = [...selected].map(id => byId.get(id)).filter(Boolean)
    const selectedPattern = phase === 'play' ? classify(selectedCards, game.level) : null
    const others = [2, 1, 3].map(offset => (me + offset) % 4)
    const seat = (index, position) => {
      const player = session.players[index]
      const isMe = index === me
      const count = game.hands[index]?.length || 0
      const avatar = player.avatar || (player.name || '?').slice(0, 1)
      return h('div', { className: `gd-seat gd-seat-${position}` + (game.currentSeat === index && game.status === 'playing' ? ' gd-turn' : '') },
        h('span', { className: 'gd-seat-avatar', style: { background: player.colorHex || '#668' }, role: 'img', 'aria-label': `${player.name}头像` },
          imageAvatar(avatar) ? h('img', { src: avatar, alt: '' }) : avatar),
        h('span', { className: 'gd-seat-name' }, player.name, isMe ? ' · 我' : index % 2 === me % 2 ? ' · 队友' : ''),
        h('span', { className: 'gd-seat-count' }, game.finished.includes(index) ? '已出完' : `${count} 张`),
        bubbles.has(index) ? h('div', { className: 'gd-speech', role: 'status' }, bubbles.get(index).text) : null)
    }
    const table = game.table
    const status = game.status === 'over' ? (game.winningTeam === me % 2 ? '我方获胜' : '对方获胜')
      : phase === 'between' ? '本副已结算，准备下一副'
        : phase === 'return' ? (returning ? '请选择一张牌还贡' : `等待 ${session.players[game.currentSeat]?.name || '玩家'} 还贡`)
          : active ? '轮到你出牌' : `等待 ${session.players[game.currentSeat]?.name || '玩家'} 出牌`
    return h('div', { className: 'gd-game' },
      h('header', { className: 'gd-head' },
        h('div', {}, h('h2', {}, '扑克合集'), h('p', {}, `掼蛋 · 第 ${game.round || 1} 副 · 本副级牌 ${rankName(game.level)} · 我方 ${rankName(game.levels?.[me % 2] || 2)} / 对方 ${rankName(game.levels?.[1 - me % 2] || 2)} · ${status}`)),
        h('div', { className: 'gd-head-actions' },
          h('button', { onclick: host.openFeedback, title: '反馈' }, '反馈'),
          h('button', { onclick: host.reset, disabled: session.online && me !== 0 }, '再来一局'),
          h('button', { onclick: host.leave }, '返回大厅'))),
      h('div', { className: 'gd-scene' },
        h('div', { className: 'gd-table-shadow' }),
        h('div', { className: 'gd-table' },
          h('div', { className: 'gd-table-rim' }),
          h('div', { className: 'gd-felt' },
            table ? h('div', { className: 'gd-trick' },
              h('div', { className: 'gd-trick-label' }, `${session.players[table.seat]?.name || '玩家'} · ${patternName(table.pattern)} · ${table.cards.length} 张`),
              h('div', { className: 'gd-trick-cards' }, table.cards.map(card => playingCard(card))))
              : h('div', { className: 'gd-table-prompt' }, '等待领出'))),
        seat(others[0], 'top'), seat(others[1], 'left'), seat(others[2], 'right')),
      h('div', { className: 'gd-bottom' },
        seat(me, 'self'),
        h('div', { className: 'gd-hand', 'aria-label': '手牌，可拖动调整顺序' }, displayedHand.map(card => playingCard(card, {
          button: true, selected: selected.has(card.id), wild: card.rank === game.level && card.suit === '♥',
          'data-card-id': card.id, 'aria-disabled': !selecting,
          onpointerdown: event => onCardPointerDown(event, card.id),
          onpointermove: onCardPointerMove,
          onpointerup: onCardPointerEnd,
          onpointercancel: onCardPointerEnd,
          onclick: event => {
            if (event.target.closest('.gd-card-grip') || Date.now() < suppressClickUntil || !selecting) return
            selected.has(card.id) ? selected.delete(card.id) : selected.add(card.id); host.render()
          },
        }))),
        h('div', { className: 'gd-controls' },
          h('span', {}, `已选 ${selected.size} 张${selectedPattern ? ` · ${patternName(selectedPattern)}` : ''}`),
          h('button', { onclick: () => { handOrder = sortedHandOrder(hand, game.level); host.render() }, disabled: !hand.length }, '一键理牌'),
          h('button', { onclick: () => { selected.clear(); host.render() }, disabled: !selected.size }, '清空'),
          phase === 'between' ? h('button', { className: 'gd-primary', onclick: () => send({ action: 'nextHand' }), disabled: !myTurn }, '开始下一副')
            : phase === 'return' ? h('button', { className: 'gd-primary', onclick: () => send({ action: 'return', card: [...selected][0] }),
              disabled: !!invalidPlay, title: invalidPlay || '还贡' }, '还贡')
              : [h('button', { onclick: () => send({ action: 'pass' }), disabled: !canPass }, '过牌'),
                h('button', { className: 'gd-primary', onclick: () => send({ action: 'play', cards: [...selected] }),
                  disabled: !!invalidPlay, title: invalidPlay || '出牌', 'aria-describedby': invalidPlay ? 'gd-play-reason' : undefined }, '出牌')]),
        invalidPlay && phase !== 'between' ? h('p', { id: 'gd-play-reason', className: 'gd-play-reason', role: 'status' }, invalidPlay) : null,
        phase === 'return' ? h('p', { className: 'gd-hint' }, '进贡：',
          (game.tributePairs || []).map(pair => `${session.players[pair.giver]?.name || '玩家'} → ${session.players[pair.receiver]?.name || '玩家'}（${face(pair.card)}）${pair.returned ? '，已还贡' : '，待还贡'}  `)) : null,
        game.handSummary ? h('p', { className: 'gd-hint' }, `上一副：${game.handSummary.winnerTeam === me % 2 ? '我方' : '对方'}获胜，${game.handSummary.passedA ? '已过 A' : game.handSummary.gained ? `升 ${game.handSummary.gained} 级，下副打 ${rankName(game.handSummary.nextLevel)}` : '继续打 A'}`) : null,
        notice ? h('p', { className: 'gd-notice', role: 'alert' }, notice) : null,
        h('p', { className: 'gd-hint' }, '对家同队 · 红桃级牌为逢人配 · 上游出完且无人压牌时由对家接风')))
  }
  return { renderGame, chatPresentation: 'seats', onDeactivate() { clearTimeout(bubbleTimer); drag = null } }
}
