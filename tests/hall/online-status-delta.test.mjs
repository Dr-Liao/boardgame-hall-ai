// P3.1：/api/online/status 增量（sessionDelta / sessionOmitted）的服务端行为。
//
// 覆盖：
//   1. 未声明 baseStamp 的旧客户端永远拿完整 session（行为不变）；
//   2. 声明且命中基线：内容未变时 sessionOmitted=true 且响应很小；
//   3. 一次行动后：baseStamp 命中基线 → sessionDelta，客户端用 applySnapshotChanges 还原后与
//      全量视图 deepEqual（含 host 与 guest 两条路径）；
//   4. 基线不匹配 → 回全量；
//   5. BOARDGAME_ONLINE_STATUS_DELTA=0 回滚为永远全量。

import test from 'node:test'
import assert from 'node:assert/strict'
import { applySnapshotChanges } from '../../lib/online-sync.js'
import { createOnlineFixture, waitFor } from './helpers/online.mjs'

async function fixture(t, env = null) {
  return createOnlineFixture(t, {
    env,
    homePrefix: 'hall-status-delta-',
    relayOptions: { secret: 'status-delta-test' },
    details: true,
  })
}

async function startRoom(halls, relayUrl) {
  const [host, guest] = halls
  const created = await host.call('create', { relayUrl, modId: 'ox', capacity: 2, fillAi: false })
  assert.equal(created.json.ok, true, created.json.error)
  assert.equal((await guest.call('join', { relayUrl, code: created.json.room.code })).json.ok, true)
  await guest.call('ready', { ready: true })
  assert.equal((await host.command('start')).json.ok, true)
  await waitFor(async () => (await host.call('status')).json.session?.state?.status === 'playing'
    && (await guest.call('status')).json.session?.state?.status === 'playing')
}

const statusWith = (hall, baseStamp) => hall.call('status' + (baseStamp === undefined ? '' : '?baseStamp=' + encodeURIComponent(baseStamp)))

async function nextAction(halls) {
  const status = await halls[0].call('status')
  const seat = status.json.session.decisionSeat
  const session = (await halls[seat].call('status')).json.session
  const moveCount = session.state.moveCount || 0
  return { seat, hall: halls[seat], revision: session.state.revision, move: { x: moveCount % 3, y: Math.floor(moveCount / 3) % 3 } }
}

test('旧客户端（无 baseStamp）永远拿完整 session；新客户端命中后 sessionOmitted 很小', async t => {
  const { halls, relayUrl } = await fixture(t)
  await startRoom(halls, relayUrl)
  const [host] = halls
  const full = await statusWith(host)
  assert.ok(full.json.session, '旧客户端必须拿到完整 session')
  assert.equal(full.json.sessionOmitted, undefined)
  const stamp = full.json.stamp
  assert.equal(typeof stamp, 'string')

  const second = await statusWith(host)
  assert.ok(second.json.session, '不带 baseStamp 的请求应始终回全量')
  assert.equal(second.bytes, full.bytes, '同一状态的全量响应字节应一致')

  const omitted = await statusWith(host, stamp)
  assert.equal(omitted.json.sessionOmitted, true)
  assert.equal(omitted.json.session, undefined, '命中基线且内容未变时不应再发 session')
  assert.equal(omitted.json.stamp, stamp)
  // ox 的会话本身很小，响应里 room/players 等运行状态占大头；这里只要求「明显更小」，
  // 大视图（Arkham）的下降幅度在 harness / 浏览器用例里量。
  assert.ok(omitted.bytes < full.bytes * 0.9, `sessionOmitted 应更小（${omitted.bytes} vs ${full.bytes}）`)
})

test('一次行动后：baseStamp 命中回 sessionDelta，应用后与全量视图一致（host/guest）', async t => {
  const { halls, relayUrl } = await fixture(t)
  await startRoom(halls, relayUrl)
  const [host, guest] = halls

  for (const target of [host, guest]) {
    // 先拿到该厅的完整基线视图与 stamp。
    const base = await statusWith(target)
    assert.ok(base.json.session)
    const baseView = base.json.session
    const baseStamp = base.json.stamp

    const action = await nextAction(halls)
    assert.equal((await action.hall.command('move', { revision: action.revision, move: action.move })).json.ok, true)
    // 注意：这里用进程内状态等待，不能再打 /status（否则会把服务器 delta 基线刷新到新 revision）。
    await waitFor(async () => {
      const view = target.server.online.status().session
      return view && view.state.revision > baseView.state.revision
    })

    const deltaResponse = await statusWith(target, baseStamp)
    assert.ok(deltaResponse.json.sessionDelta, '命中基线时应回 sessionDelta')
    const delta = deltaResponse.json.sessionDelta
    assert.equal(delta.baseStamp, baseStamp)
    const applied = applySnapshotChanges(baseView, delta.changes)
    assert.ok(applied.state.revision > baseView.state.revision)
    assert.ok(deltaResponse.bytes < base.bytes, `增量应小于全量（${deltaResponse.bytes} vs ${base.bytes}）`)

    // 与全量视图逐字段比较（全量请求会重建基线，因此放在最后）。
    const fullAfter = await statusWith(target)
    assert.deepEqual(applied, fullAfter.json.session, '应用增量后应与全量视图一致')
  }
})

test('基线不匹配时回全量；BOARDGAME_ONLINE_STATUS_DELTA=0 回滚为始终全量', async t => {
  const { halls, relayUrl } = await fixture(t)
  await startRoom(halls, relayUrl)
  const [host] = halls
  const stale = await statusWith(host, 'stale:1:0')
  assert.ok(stale.json.session, '基线不匹配必须回全量')
  assert.equal(stale.json.sessionDelta, undefined)

  // 回滚开关：新建 fixture（env 在 createServer 时读取）。
  const rolled = await fixture(t, { BOARDGAME_ONLINE_STATUS_DELTA: '0' })
  await startRoom(rolled.halls, rolled.relayUrl)
  const [host2] = rolled.halls
  const base = await statusWith(host2)
  const stamp = base.json.stamp
  const second = await statusWith(host2, stamp)
  assert.ok(second.json.session, '回滚后即使声明 baseStamp 也应回全量')
  assert.equal(second.json.sessionOmitted, undefined)
  assert.equal(second.json.sessionDelta, undefined)
})

test('full=1 强制全量：即使命中基线也下发 session，且跳过长轮询等待', async t => {
  const { halls, relayUrl } = await fixture(t)
  await startRoom(halls, relayUrl)
  const [host] = halls

  const base = await statusWith(host)
  const stamp = base.json.stamp
  assert.equal((await statusWith(host, stamp)).json.sessionOmitted, true)
  // 用同样的 baseStamp（本来会命中 sessionOmitted）与当前 serial（本来会挂起长轮询）构造
  // 一次「强制同步」请求：full=1 必须跳过等待并回全量。
  const view = base.json
  const waitingQuery = '?full=1&wait=1&after=' + encodeURIComponent(String(view.serial))
    + '&instanceId=' + encodeURIComponent(view.instanceId || '') + '&baseStamp=' + encodeURIComponent(stamp)
  const started = Date.now()
  const forced = await host.call('status' + waitingQuery)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, `full=1 不应等待长轮询（实际 ${elapsed}ms）`)
  assert.ok(forced.json.session, 'full=1 必须下发完整 session')
  assert.equal(forced.json.sessionOmitted, undefined)
  assert.equal(forced.json.sessionDelta, undefined)
  assert.equal(forced.json.session.state.revision, view.session.state.revision)
})

test('客人也能请求 sync 重置快照基线（强制同步按钮的服务端路径，经 relay）', async t => {
  const { halls, relayUrl } = await fixture(t)
  await startRoom(halls, relayUrl)
  const [host, guest] = halls
  const before = await guest.call('status')
  const stamp = before.json.stamp
  assert.equal((await statusWith(guest, stamp)).json.sessionOmitted, true)

  // 浏览器「强制同步」会先发 action:'sync'（客人经 relay 到房主），再拉 full=1 全量。
  const synced = await guest.command('sync')
  assert.equal(synced.json.ok, true, synced.json.error)
  assert.ok(synced.json.session, '客人 sync 必须拿回一份会话视图')
  const forced = await guest.call('status?full=1&baseStamp=' + encodeURIComponent(stamp))
  assert.ok(forced.json.session, 'sync 后 full=1 必须回全量')
  assert.equal(forced.json.session.state.revision, synced.json.session.state.revision)
  // 房主侧同样可用（按钮在房主浏览器上走本地命令）。
  const hostSynced = await host.command('sync')
  assert.equal(hostSynced.json.ok, true, hostSynced.json.error)
  assert.ok(hostSynced.json.session)
})
