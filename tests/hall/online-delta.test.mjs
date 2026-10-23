// P3.1：浏览器 status 增量的纯逻辑单测（public/online-delta.js）。
//
// 覆盖：stamp 计算、增量应用到上一份会话、基线不符/非法路径时返回 null（调用方回全量）、
// 数组 splice/删除/嵌套字段与 set 语义正确。

import test from 'node:test'
import assert from 'node:assert/strict'
import { applySnapshotChanges, applyStatusDelta, statusStampOf } from '../../public/online-delta.js'
import { snapshotChanges } from '../../lib/online-sync.js'

test('statusStampOf 与大厅口径一致：sessionId:revision:eventCount[:staticVersion]', () => {
  assert.equal(statusStampOf(null), '')
  assert.equal(statusStampOf({}), ':-1:0')
  assert.equal(statusStampOf({ sessionId: 's1', state: { revision: 3 }, events: [{ seq: 0 }, { seq: 1 }] }), 's1:3:2')
  assert.equal(statusStampOf({ sessionId: 's1', state: { revision: 3 }, events: [], staticVersion: 'v1' }), 's1:3:0:v1')
})

test('applyStatusDelta 把 sessionDelta 应用到上一份会话，结果与全量一致', () => {
  const before = {
    sessionId: 's1', mySeat: 0,
    state: { revision: 1, board: [null, null, null], turn: 0, removed: true, nested: { a: 1 } },
    events: [{ seq: 0, text: 'a' }],
    notes: [],
  }
  const after = structuredClone(before)
  after.state.revision = 2
  after.state.board[1] = 'black'
  after.state.turn = 1
  delete after.state.removed
  after.state.nested.a = 2
  after.events.push({ seq: 1, text: 'b' })
  const changes = snapshotChanges(before, after)
  assert.ok(changes.length > 0)
  const payload = { sessionDelta: { stamp: statusStampOf(after), baseStamp: statusStampOf(before), changes } }
  const applied = applyStatusDelta(before, payload)
  assert.deepEqual(applied.session, after)
  assert.equal(applied.stamp, statusStampOf(after))
  assert.deepEqual(applySnapshotChanges(before, changes), after)
})

test('基线不符 / 非法增量 / 数组操作越界时返回 null（调用方回全量）', () => {
  const session = { sessionId: 's1', state: { revision: 1 }, events: [] }
  assert.equal(applyStatusDelta(session, { sessionDelta: { baseStamp: 'other:1:0', changes: [] } }), null)
  assert.equal(applyStatusDelta(null, { sessionDelta: { baseStamp: 's1:1:0', changes: [] } }), null)
  assert.equal(applyStatusDelta(session, { sessionDelta: { baseStamp: 's1:1:0', changes: [{ path: ['__proto__'], value: 1 }] } }), null)
  assert.equal(applyStatusDelta(session, { sessionDelta: { baseStamp: 's1:1:0', changes: [{ path: ['state'], splice: 5, items: [] }] } }), null)
  assert.equal(applyStatusDelta(session, {}), null)
})

test('增量支持数组截断/追加、顶层替换与 remove', () => {
  const before = { sessionId: 's1', state: { revision: 1, list: [1, 2, 3], keep: true }, events: [{ seq: 0 }] }
  const after = structuredClone(before)
  after.state.list.splice(1) // 截断成 [1]
  after.events.push({ seq: 1 })
  delete after.state.keep
  const changes = snapshotChanges(before, after)
  const applied = applySnapshotChanges(before, changes)
  assert.deepEqual(applied, after)
  // 顶层整体替换
  assert.deepEqual(applySnapshotChanges(before, [{ path: [], value: { replaced: true } }]), { replaced: true })
})
