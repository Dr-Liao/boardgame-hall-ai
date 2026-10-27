import test from 'node:test'
import assert from 'node:assert/strict'
import mod from '../index.js'
import { beats, candidateMoves, classify, deck } from '../rules.js'

const cards = deck()
const take = (rank, n, suit) => cards.filter(card => card.rank === rank && (!suit || card.suit === suit)).slice(0, n)

test('牌型与炸弹级别', () => {
  const pair = classify(take(7, 2), 2)
  const triple = classify(take(8, 3), 2)
  const full = classify([...take(8, 3), ...take(6, 2)], 2)
  const flush = classify([6, 7, 8, 9, 10].map(rank => take(rank, 1, '♠')[0]), 2)
  assert.equal(pair.type, 'pair')
  assert.equal(triple.type, 'triple')
  assert.equal(full.type, 'fullHouse')
  assert.equal(flush.type, 'straightFlush')
  assert.equal(beats(classify(take(9, 4), 2), full), true)
  assert.equal(beats(flush, classify(take(9, 5), 2)), true)
  assert.equal(beats(classify(take(9, 6), 2), flush), true)
  assert.equal(classify([...take(15, 2), ...take(16, 2)], 2).type, 'jokerBomb')
})

test('四席发牌、私有视图和本地 AI 可完成一副牌', () => {
  const state = mod.createState({}, [{}, {}, {}, {}])
  assert.deepEqual(state.hands.map(hand => hand.length), [27, 27, 27, 27])
  for (let seat = 0; seat < 4; seat++) {
    const view = mod.viewState(state, seat)
    assert.equal(view.hands[seat].filter(Boolean).length, 27)
    assert.equal(view.hands.flat().filter(Boolean).length, 27)
  }
  let steps = 0
  while (state.phase === 'play' && steps++ < 400) {
    const seat = state.currentSeat
    const move = mod.agentFallback(state, seat)
    assert.equal(mod.validateMove(state, seat, move), null)
    mod.applyMove(state, seat, move)
  }
  assert.equal(state.phase, 'between')
  assert.equal(state.placements.length, 4)
  assert.ok(state.handSummary.gained >= 1)
})

test('非法牌型、非本人手牌和空桌过牌会被拒绝', () => {
  const state = mod.createState({}, [{}, {}, {}, {}])
  assert.match(mod.validateMove(state, 0, { action: 'pass' }), /必须出牌/)
  assert.match(mod.validateMove(state, 0, { action: 'play', cards: [state.hands[1][0].id] }), /无效/)
  assert.match(mod.validateMove(state, 1, { action: 'play', cards: [state.hands[1][0].id] }), /尚未轮到/)
})

test('大小王高于级牌，逢人配采用较大的顺子解释并进入 AI 候选', () => {
  const level = classify(take(2, 1, '♠'), 2)
  const small = classify(take(15, 1), 2)
  const big = classify(take(16, 1), 2)
  assert.equal(beats(level, big), false)
  assert.equal(beats(big, level), true)
  assert.equal(beats(small, level), true)
  const wild = take(2, 2, '♥')
  const run = [...wild, take(5, 1, '♠')[0], take(6, 1, '♣')[0], take(7, 1, '♦')[0]]
  assert.equal(classify(run, 2).rank, 9)
  const missingSix = [wild[0], take(3, 1, '♠')[0], take(4, 1, '♣')[0], take(5, 1, '♦')[0], take(7, 1, '♠')[0]]
  assert.equal(classify(missingSix, 2).type, 'straight')
  assert.ok(candidateMoves(missingSix, 2, null).some(move => move.cards.length === 5))
  const flush = [wild[0], ...[3, 4, 5, 7].map(rank => take(rank, 1, '♠')[0])]
  assert.equal(classify(flush, 2).type, 'straightFlush')
  const lowerRun = [6, 7, 8, 9, 10].map(rank => take(rank, 1, '♣')[0])
  const higherRun = [10, 11, 12, 13, 14].map(rank => take(rank, 1, '♦')[0])
  assert.equal(beats(classify(higherRun, 10), classify(lowerRun, 10)), true, '顺子不按级牌抬升')
})

test('出完牌后等待其余三人过牌，再由队友接风并按名次升级', () => {
  const state = mod.createState({}, [{}, {}, {}, {}])
  state.hands = [take(3, 1, '♠'), take(4, 1, '♠'), take(5, 1, '♠'), take(6, 1, '♠')]
  mod.applyMove(state, 0, { action: 'play', cards: [state.hands[0][0].id] })
  assert.deepEqual(state.finished, [0])
  mod.applyMove(state, 1, { action: 'pass' })
  mod.applyMove(state, 2, { action: 'pass' })
  assert.equal(state.currentSeat, 3, '第三位仍可压制')
  assert.ok(state.table)
  mod.applyMove(state, 3, { action: 'pass' })
  assert.equal(state.currentSeat, 2, '对家接风')
  assert.equal(state.table, null)
  mod.applyMove(state, 2, { action: 'play', cards: [state.hands[2][0].id] })
  assert.equal(state.phase, 'between')
  assert.equal(state.handSummary.gained, 3)
  assert.equal(state.levels[0], 5)
  assert.deepEqual(state.placements.slice(0, 2), [0, 2])
  assert.equal(mod.validateMove(state, 0, { action: 'nextHand' }), null)
  mod.applyMove(state, 0, { action: 'nextHand' })
  assert.equal(state.round, 2)
  assert.equal(state.level, 5)
  if (state.tributePairs.length) {
    assert.equal(state.phase, 'return')
    while (state.phase === 'return') {
      const seat = state.currentSeat
      const move = mod.legalMoves(state, seat)[0]
      assert.equal(mod.validateMove(state, seat, move), null)
      const [event] = mod.applyMove(state, seat, move)
      assert.equal(event.type, 'return')
      assert.equal(Object.hasOwn(event, 'card'), false, '还贡牌不应公开给其他座位')
    }
    assert.deepEqual(state.hands.map(hand => hand.length), [27, 27, 27, 27])
  }
  assert.equal(state.phase, 'play')
  assert.match(mod.describeState(state, state.currentSeat), /大王＞小王＞级牌/)
})

test('打 A 且队友不落末游时整局结束', () => {
  const state = mod.createState({}, [{}, {}, {}, {}])
  state.level = 14
  state.levels = [14, 12]
  state.hands = [take(3, 1, '♠'), take(4, 1, '♠'), take(5, 1, '♠'), take(6, 1, '♠')]
  mod.applyMove(state, 0, { action: 'play', cards: [state.hands[0][0].id] })
  for (const seat of [1, 2, 3]) mod.applyMove(state, seat, { action: 'pass' })
  mod.applyMove(state, 2, { action: 'play', cards: [state.hands[2][0].id] })
  assert.equal(state.status, 'over')
  assert.equal(state.handSummary.passedA, true)
})

test('自动策略可走完升级、进贡、还贡直至过 A', () => {
  const state = mod.createState({}, [{}, {}, {}, {}])
  let steps = 0
  while (state.status === 'playing' && steps++ < 10000) {
    const seat = state.currentSeat
    const move = mod.agentFallback(state, seat)
    assert.equal(mod.validateMove(state, seat, move), null)
    mod.applyMove(state, seat, move)
  }
  assert.equal(state.status, 'over')
  assert.ok(state.round > 1)
  assert.equal(state.handSummary.passedA, true)
})
