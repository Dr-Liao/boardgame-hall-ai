import test from 'node:test'
import assert from 'node:assert/strict'
import { snapshotChanges, applySnapshotChanges } from '../../lib/online-sync.js'

test('incremental snapshots preserve additions, deletions, truncation and appended events', () => {
  const before = { session: { state: { revision: 1, hand: ['a', 'b'], removed: true }, events: [{ seq: 0, text: 'first' }] }, busy: true }
  const after = { session: { state: { revision: 2, hand: ['b'], choice: null }, events: [{ seq: 0, text: 'first' }, { seq: 1, text: 'next' }] }, busy: false }
  const original = structuredClone(before)
  assert.deepEqual(applySnapshotChanges(before, snapshotChanges(before, after)), after)
  assert.deepEqual(before, original)
  assert.deepEqual(applySnapshotChanges(after, snapshotChanges(after, before)), before)
  assert.deepEqual(snapshotChanges(before, structuredClone(before)), [])
})

test('card selection sends a small change instead of repeating the card catalog and history', () => {
  const before = { session: { state: { revision: 1, cards: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i, { name: `card ${i}`, text: 'rules '.repeat(50) }])), selected: [], }, events: Array.from({ length: 100 }, (_, seq) => ({ seq, text: 'history' })) }, busy: false }
  const after = structuredClone(before)
  after.session.state.revision++; after.session.state.selected.push('42')
  after.session.events.push({ seq: 100, text: 'selected' })
  const changes = snapshotChanges(before, after)
  assert.deepEqual(applySnapshotChanges(before, changes), after)
  assert.ok(JSON.stringify(changes).length < JSON.stringify(after).length / 100)
  assert.throws(() => applySnapshotChanges({}, [{ path: ['__proto__', 'polluted'], value: true }]), /同步路径无效/)
})
