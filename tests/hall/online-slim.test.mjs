// P1.2：联机客人的命令响应可以只回摘要（body.client.slim），整份视图由随后的快照 + 长轮询送达。
//
// 覆盖点：
//   1. 客人声明 slim 后响应不含 session，但有 sessionId/revision/eventCount/busy；
//   2. 房主命令仍返回完整 session（本地渲染需要）；
//   3. 不带 slim 的旧客户端仍拿到完整 session（向后兼容）；
//   4. 重复 operationId 的回放响应同样保持 slim，且不会重复执行；
//   5. BOARDGAME_ONLINE_SLIM=0 时回到「客人响应带完整 session」的旧行为（回滚开关）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createOnlineFixture, waitFor as waitForOnline } from './helpers/online.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = (check, timeout = 6000) => waitForOnline(check, timeout)

async function fixture(t, count = 2) {
  return createOnlineFixture(t, {
    count,
    homePrefix: 'hall-slim-',
    relayOptions: { secret: 'slim-test-secret' },
    persistHost: true,
  })
}

async function startRoom(halls, relayUrl) {
  const [host, guest] = halls
  const created = await host.call('create', { relayUrl, modId: 'ox', capacity: 2, fillAi: false })
  assert.equal(created.ok, true, created.error)
  const joined = await guest.call('join', { relayUrl, code: created.room.code })
  assert.equal(joined.ok, true, joined.error)
  await guest.call('ready', { ready: true })
  assert.equal((await host.command('start')).ok, true)
  await waitFor(async () => (await host.call('status')).session?.state?.status === 'playing'
    && (await guest.call('status')).session?.state?.status === 'playing')
}

async function nextAction(halls) {
  const status = await halls[0].call('status')
  const seat = status.session.decisionSeat
  const view = await halls[seat].call('status')
  const session = view.session
  const moveCount = session.state.moveCount || 0
  // ox 默认 3x3 棋盘；按顺序落一个未占用的格子。
  return { seat, hall: halls[seat], revision: session.state.revision, move: { x: moveCount % 3, y: Math.floor(moveCount / 3) % 3 } }
}

test('客人 slim 命令只回摘要，房主仍拿完整会话，快照随后把 revision 送到客人', async t => {
  const { halls, relayUrl } = await fixture(t)
  const { host, guest } = { host: halls[0], guest: halls[1] }
  await startRoom(halls, relayUrl)

  // 房主命令：仍是完整 session（本地渲染需要）。
  const hostAction = await nextAction(halls)
  assert.equal(hostAction.seat, 0)
  const hostResult = await hostAction.hall.command('move', { revision: hostAction.revision, move: hostAction.move })
  assert.equal(hostResult.ok, true, hostResult.error)
  assert.ok(hostResult.session, '房主命令响应必须带完整 session')

  // 客人命令：声明 slim 后只回摘要。
  const guestAction = await nextAction(halls)
  assert.equal(guestAction.seat, 1)
  const slim = await guestAction.hall.command('move', {
    revision: guestAction.revision, move: guestAction.move, client: { slim: true },
  })
  assert.equal(slim.ok, true, slim.error)
  assert.equal(slim.slim, true)
  assert.equal(slim.session, undefined, '客人 slim 响应不应带整份会话')
  assert.equal(typeof slim.sessionId, 'string')
  assert.equal(typeof slim.revision, 'number')
  assert.equal(typeof slim.eventCount, 'number')
  assert.equal(slim.busy, false)

  // 权威快照随后通过客人本地状态送达（浏览器走长轮询读它）。
  const synced = await waitFor(async () => {
    const view = (await guestAction.hall.call('status')).session
    return view?.state?.revision === slim.revision ? view : null
  })
  assert.equal(synced.sessionId, slim.sessionId)
  assert.ok(synced.events.length >= slim.eventCount)

  // 旧客户端（不带 client.slim）仍拿到完整会话：需要让房主先走完，再轮到客人。
  const hostAction2 = await nextAction(halls)
  assert.equal(hostAction2.seat, 0)
  assert.equal((await hostAction2.hall.command('move', { revision: hostAction2.revision, move: hostAction2.move })).ok, true)
  const legacyAction = await nextAction(halls)
  assert.equal(legacyAction.seat, 1)
  const legacy = await legacyAction.hall.command('move', { revision: legacyAction.revision, move: legacyAction.move })
  assert.equal(legacy.ok, true, legacy.error)
  assert.ok(legacy.session, '未声明 slim 的调用方必须继续拿完整 session')
  assert.equal(legacy.slim, undefined)
})

test('重复 operationId 的 slim 回放不重复执行且保持摘要响应', async t => {
  const { halls, relayUrl } = await fixture(t)
  const [host] = halls
  await startRoom(halls, relayUrl)
  assert.equal((await nextAction(halls)).seat, 0)
  const firstAction = await nextAction(halls)
  assert.equal((await firstAction.hall.command('move', { revision: firstAction.revision, move: firstAction.move })).ok, true)

  const action = await nextAction(halls)
  const operationId = randomUUID()
  const body = { operationId, revision: action.revision, move: action.move, client: { slim: true } }
  const [first, replay] = await Promise.all([
    action.hall.call('command', { action: 'move', body }),
    sleep(30).then(() => action.hall.call('command', { action: 'move', body })),
  ])
  for (const result of [first, replay]) {
    assert.equal(result.ok, true, result.error)
    assert.equal(result.slim, true, '回放响应也应保持 slim')
    assert.equal(result.session, undefined)
  }
  assert.equal(first.revision, replay.revision, '重复操作不应推进 revision')
  await waitFor(async () => (await host.call('status')).session?.state?.moveCount === 2)
  assert.equal((await host.call('status')).session.state.moveCount, 2, '两个真实动作，重放不落子')
})

test('BOARDGAME_ONLINE_SLIM=0 回滚：客人声明 slim 也拿完整会话', async t => {
  const previous = process.env.BOARDGAME_ONLINE_SLIM
  process.env.BOARDGAME_ONLINE_SLIM = '0'
  t.after(() => {
    if (previous === undefined) delete process.env.BOARDGAME_ONLINE_SLIM
    else process.env.BOARDGAME_ONLINE_SLIM = previous
  })
  const { halls, relayUrl } = await fixture(t)
  await startRoom(halls, relayUrl)
  assert.equal((await nextAction(halls)).seat, 0)
  assert.equal((await nextAction(halls).then(action => action.hall.command('move', { revision: action.revision, move: action.move }))).ok, true)
  const action = await nextAction(halls)
  const result = await action.hall.command('move', {
    revision: action.revision, move: action.move, client: { slim: true },
  })
  assert.equal(result.ok, true, result.error)
  assert.ok(result.session, '回滚后即使声明 slim 也要拿完整 session')
  assert.equal(result.slim, undefined)
})
