import { singleStrength } from './rules.js'

const suitOrder = new Map(['♠', '♥', '♣', '♦', ''].map((suit, index) => [suit, index]))

export function reconcileHandOrder(order, hand) {
  const present = new Set(hand.map(card => card.id))
  const kept = order.filter(id => present.has(id))
  const known = new Set(kept)
  return [...kept, ...hand.map(card => card.id).filter(id => !known.has(id))]
}

export function sortedHandOrder(hand, level) {
  return [...hand].sort((a, b) =>
    singleStrength(b.rank, level) - singleStrength(a.rank, level)
    || (suitOrder.get(a.suit) ?? 5) - (suitOrder.get(b.suit) ?? 5)
    || a.copy - b.copy,
  ).map(card => card.id)
}

export function moveHandCard(order, fromId, toId) {
  const from = order.indexOf(fromId)
  const to = order.indexOf(toId)
  if (from < 0 || to < 0 || from === to) return [...order]
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return next
}
