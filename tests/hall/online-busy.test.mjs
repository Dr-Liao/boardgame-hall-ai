// P1.1：busy / lobby 变化只发轻量 status 消息（复用 snapshot 信封），不重发整份会话。
//
// 覆盖点：
//   1. 命令 finally 的 busy true→false 走 status：publishOnline 记录里 statusSent > 0 且 published = 0；
//   2. status 不写 sentSnapshots 的增量基线：下一次行动仍然按上一份会话正确 diff，客人视图与房主一致；
//   3. 客人 /status 的 busy 在行动结束后恢复 false；
//   4. BOARDGAME_ONLINE_BUSY=0 时回到旧行为（busy 变化也发整份会话，无 publish.status 记录）。
//
// P1.5 发布合并后：busy=true 仍在命令开始就走轻量 status；busy=false 随命令末尾 flush 的
// 最终快照下发（不必再补一条 status），原「finally 必发 busy status」的断言随之放宽。

import test from 'node:test'
import assert from 'node:assert/strict'
import { perf } from '../../lib/perf.js'
import { createOnlineFixture, waitFor as waitForOnline } from './helpers/online.mjs'

const waitFor = (check, timeout = 6000, label) => waitForOnline(check, timeout, label)
const waitForRecords = (from, predicate, label) => waitFor(() => {
  const records = perf.recordsSince(from).records
  return predicate(records) ? records : null
}, 6000, label)

function enablePerf(t) {
  const previousFile = process.env.BOARDGAME_PERF_FILE
  process.env.BOARDGAME_PERF_FILE = '0'
  if (!perf.enabled) perf.setEnabled(true)
  perf.reset()
  t.after(() => {
    perf.setEnabled(false)
    if (previousFile === undefined) delete process.env.BOARDGAME_PERF_FILE
    else process.env.BOARDGAME_PERF_FILE = previousFile
  })
}

async function fixture(t, count = 2) {
  return createOnlineFixture(t, {
    count,
    homePrefix: 'hall-busy-',
    relayOptions: { secret: 'busy-test-secret' },
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
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  await waitFor(async () => (await host.call('status')).session?.state?.status === 'playing'
    && (await guest.call('status')).session?.state?.status === 'playing')
}

// 当前该行动的席位（ox 交替先手）；返回 { seat, hall, revision, move }。
// ox 的视图不带 legalMoves，按 moveCount 落一个未占用的坐标即可（15x15 棋盘）。
async function nextAction(halls) {
  const status = await halls[0].call('status')
  const seat = status.session.decisionSeat
  const actor = halls[seat]
  const view = await actor.call('status')
  const session = view.session
  const moveCount = session.state.moveCount || 0
  const move = { x: moveCount % 15, y: Math.floor(moveCount / 15) }
  return { seat, hall: actor, revision: session.state.revision, move }
}

test('busy 变化走轻量 status：只同步运行状态，不重发会话，也不污染下一次增量', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t)
  const [host, guest] = halls
  await startRoom(halls, relayUrl)

  const action = await nextAction(halls)
  const from = perf.count()
  const first = await action.hall.command('move', { revision: action.revision, move: action.move })
  assert.equal(first.ok, true, first.error)
  const records = await waitForRecords(from, entries => {
    const publishes = entries.filter(entry => entry.event === 'publishOnline')
    return publishes.length >= 2 && publishes.some(entry => entry.busy === false
      && (entry.published > 0 || entry.statusSent > 0))
  }, 'busy 发布记录')

  const publishes = records.filter(entry => entry.event === 'publishOnline')
  assert.ok(publishes.length >= 2, `一次行动应至少两次 publishOnline，实际 ${publishes.length}`)
  const busyOnly = publishes.filter(entry => entry.statusSent > 0)
  assert.ok(busyOnly.length >= 1, 'finally 的 busy 变化应走 status 消息')
  assert.ok(busyOnly.some(entry => entry.published === 0), 'busy 单独变化时不应重发整份会话')
  assert.ok(records.some(entry => entry.event === 'publishOnline' && entry.busy === false
    && (entry.published > 0 || entry.statusSent > 0)),
    'busy=false 应随命令末尾的最终快照（或轻量 status）下发')

  // 让客人追上 revision，确认 status 消息没有破坏 receivedSnapshot 的增量基线。
  const hostView = (await host.call('status')).session
  await waitFor(async () => (await guest.call('status')).session?.state?.revision === hostView.state.revision)
  const guestStatus = await guest.call('status')
  assert.equal(guestStatus.busy, false, '行动结束后客人 busy 应恢复 false')
  assert.deepEqual(guestStatus.session.state.board, hostView.state.board)

  // 第二次行动：增量仍然基于上一份完整会话，客人视图必须与房主一致。
  const second = await nextAction(halls)
  const fromSecond = perf.count()
  const result = await second.hall.command('move', { revision: second.revision, move: second.move })
  assert.equal(result.ok, true, result.error)
  const secondRecords = await waitForRecords(fromSecond,
    entries => entries.some(entry => entry.event === 'publish.member'
      && (entry.kind === 'delta' || entry.kind === 'full')),
    '第二次会话发布')
  assert.ok(secondRecords.some(entry => entry.event === 'publish.member' && (entry.kind === 'delta' || entry.kind === 'full')),
    '第二次行动仍需实际下发一次会话/增量')
  const hostAfter = (await host.call('status')).session
  await waitFor(async () => (await guest.call('status')).session?.state?.revision === hostAfter.state.revision)
  const guestAfter = (await guest.call('status')).session
  assert.deepEqual(guestAfter.state.board, hostAfter.state.board)
  assert.equal((await guest.call('status')).busy, false)
})

test('BOARDGAME_ONLINE_BUSY=0 回滚：busy 变化仍发整份会话', async t => {
  const previousBusy = process.env.BOARDGAME_ONLINE_BUSY
  process.env.BOARDGAME_ONLINE_BUSY = '0'
  t.after(() => {
    if (previousBusy === undefined) delete process.env.BOARDGAME_ONLINE_BUSY
    else process.env.BOARDGAME_ONLINE_BUSY = previousBusy
  })
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t)
  await startRoom(halls, relayUrl)

  const action = await nextAction(halls)
  const from = perf.count()
  const result = await action.hall.command('move', { revision: action.revision, move: action.move })
  assert.equal(result.ok, true, result.error)
  const records = await waitForRecords(from,
    entries => entries.some(entry => entry.event === 'publishOnline' && entry.published > 0),
    '回滚发布记录')
  assert.equal(records.some(entry => entry.event === 'publish.status'), false, '关闭开关后不应出现 status 消息')
  assert.equal(records.some(entry => entry.event === 'publishOnline' && entry.statusSent > 0), false)
  assert.ok(records.some(entry => entry.event === 'publishOnline' && entry.published > 0),
    'busy 变化应回到「重发整份会话」的旧行为')
})
