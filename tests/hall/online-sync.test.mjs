import test from 'node:test'
import assert from 'node:assert/strict'
import { snapshotChanges, applySnapshotChanges } from '../../lib/online-sync.js'
import { trimEventVisuals } from '../../lib/server.js'

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

test('older event visuals are stripped at the source while the recent window stays replayable', () => {
  const events = Array.from({ length: 60 }, (_, seq) => ({
    seq, type: 'info', text: `event ${seq}`,
    tableState: { investigators: [{ seat: 0, hand: [] }] },
    ...(seq % 2 ? { presentation: { kind: 'test', tableState: { round: seq } } } : {}),
  }))
  const session = { events }
  assert.equal(trimEventVisuals(session, 10), 50, '只剥掉滑出窗口的 50 条')
  for (const event of events.slice(0, 50)) {
    assert.equal(event.tableState, undefined)
    assert.equal(event.presentation?.tableState, undefined)
    assert.equal(typeof event.text, 'string', '文字历史必须保留')
  }
  for (const event of events.slice(50)) assert.ok(event.tableState, '最近 10 条仍需可回放')
  assert.equal(trimEventVisuals(session, 10), 0, '重复调用不重复扫描')
  events.push({ seq: 60, type: 'info', text: 'event 60', tableState: { investigators: [] } })
  assert.equal(trimEventVisuals(session, 10), 1, '只处理新滑出窗口的那一条')
  assert.equal(events[50].tableState, undefined)
  assert.equal(events.length, 61, '不裁剪事件本身，只裁演出快照')
})
