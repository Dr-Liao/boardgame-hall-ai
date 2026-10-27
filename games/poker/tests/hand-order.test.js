import test from 'node:test'
import assert from 'node:assert/strict'
import { deck } from '../rules.js'
import { moveHandCard, reconcileHandOrder, sortedHandOrder } from '../web/hand-order.js'

test('一键理牌按牌力排列，大小王排在级牌之前', () => {
  const cards = deck().filter(card => card.copy === 0 &&
    (card.rank === 2 && card.suit === '♠' || card.rank === 10 && card.suit === '♥' || card.rank === 16))
  assert.deepEqual(sortedHandOrder(cards, 2), [cards[2].id, cards[0].id, cards[1].id])
})

test('拖动换序后，快照刷新保留现有顺序并移除已打出的牌', () => {
  const hand = deck().slice(0, 4)
  const ids = hand.map(card => card.id)
  const moved = moveHandCard(ids, ids[0], ids[3])
  assert.deepEqual(moved, [ids[1], ids[2], ids[3], ids[0]])
  assert.deepEqual(reconcileHandOrder(moved, hand.slice(1)), [ids[1], ids[2], ids[3]])
  assert.deepEqual(reconcileHandOrder(moved, hand), moved)
})
