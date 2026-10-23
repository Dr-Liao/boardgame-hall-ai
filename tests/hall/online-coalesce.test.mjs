// P1.5：发布合并（schedulePublish / flushPublish）。
//
// 覆盖点：
//   1. 一次行动里 snapshotSession 的多次发布合并：publishOnline 至多两次（命令开始的 busy 轻量
//      status + 命令末尾 flush 的最终快照），有且只有一次 published>0；publish.member 实际下发
//      不超过成员数；客人最终 revision/board 与房主一致（响应前 flush，不丢最终状态）。
//   2. BOARDGAME_ONLINE_COALESCE=0 回滚：恢复「每次 snapshotSession 立即 publishOnline」的 P1.4 行为。
//   3. 房间广播 / 加入 / 退出 / 同步仍立即发布：继续存档的等待房间在新玩家加入后，不依赖任何
//      命令就能立刻拿到 lobby；准备 / 退出触发的房间广播也各自立即 publishOnline。
//   4. AI 连续动作合并进最终快照：2 个 AI 席位连续落子的 move 事件不丢、events.seq 连续、
//      最终 revision/board 正确，publishOnline 次数不随 AI 步数线性增长；
//   5. 1 人类 + 1 AI 的两人房：host 一次行动后 AI 兜底动作随同一份最终快照到达，且只发一次。
//
// 观察手法同 tests/hall/online-busy.test.mjs：进程内直接读 lib/perf.js 的 publishOnline 记录
// （published / statusSent / skipped / busy 字段）与实际下发的 publish.member。

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRelay } from '../../relay/server.js'
import { createServer } from '../../lib/server.js'
import { perf } from '../../lib/perf.js'
import { loadTestMods } from './helpers/mods.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(resolve => { server.stopRelay?.(); server.online?.close(); server.closeAllConnections(); server.close(resolve) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20) }
  throw new Error('等待状态同步超时')
}

// perf 记录默认关闭且会写文件；测试里打开内存记录并关掉落盘（同 online-busy.test.mjs）。
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

async function fixture(t, { count = 2, env = null, persistHost = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-coalesce-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousEnv = {}
  for (const key of Object.keys(env || {})) {
    previousEnv[key] = process.env[key]
    process.env[key] = env[key]
  }
  const mods = await loadTestMods()
  const relay = createRelay({ secret: 'coalesce-test-secret' })
  const relayUrl = await listen(relay)
  const halls = []
  for (let i = 0; i < count; i++) {
    const server = createServer({ mods, persist: persistHost && i === 0 })
    await server.ready
    const origin = await listen(server)
    const call = async (route, body) => {
      const res = await fetch(origin + '/api/online/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return res.json()
    }
    halls.push({ server, origin, call, command: (action, body = {}) => call('command', { action, body: { operationId: randomUUID(), ...body } }) })
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await Promise.all(halls.map(hall => stop(hall.server)))
    await stop(relay)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { halls, relay, relayUrl }
}

// 建房 → 其余大厅按席位 index 加入 → 准备 → 房主开局，等所有大厅拿到同一 revision。
async function startRoom(halls, relayUrl, { modId = 'ox', capacity = 2, aiSeats = [], settings = null } = {}) {
  const [host] = halls
  const created = await host.call('create', {
    relayUrl, modId, capacity, fillAi: false,
    ...(aiSeats.length ? { aiSeats } : {}),
    ...(settings ? { settings } : {}),
  })
  assert.equal(created.ok, true, created.error)
  for (let index = 1; index < halls.length; index++) {
    const joined = await halls[index].call('join', { relayUrl, code: created.room.code, seat: index })
    assert.equal(joined.ok, true, joined.error)
    await halls[index].call('ready', { ready: true })
  }
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const revision = started.session.state.revision
  await waitFor(async () => (await Promise.all(halls.map(hall => hall.call('status'))))
    .every(status => status.session?.state?.revision === revision))
  return { created, revision }
}

// ox 当前该行动的席位（ox 交替先手）；返回 { seat, hall, revision, move }。
// ox 的视图不带 legalMoves，按 moveCount 落一个未占用的坐标即可（3×3 棋盘，测试只走前几步）。
async function nextAction(halls) {
  const status = await halls[0].call('status')
  const seat = status.session.decisionSeat
  const actor = halls[seat]
  const view = await actor.call('status')
  const session = view.session
  const moveCount = session.state.moveCount || 0
  const move = { x: moveCount % 3, y: Math.floor(moveCount / 3) % 3 }
  return { seat, hall: actor, revision: session.state.revision, move }
}

function publishRecords(records) {
  return records.filter(entry => entry.event === 'publishOnline')
}

test('一次行动只 flush 一次最终快照 + 一次 busy status，客人最终状态与房主一致', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t)
  const [host, guest] = halls
  await startRoom(halls, relayUrl)

  const action = await nextAction(halls)
  const from = perf.count()
  const result = await action.hall.command('move', { revision: action.revision, move: action.move })
  assert.equal(result.ok, true, result.error)
  // 等客人收到最终快照，并让可能残留的兜底 setImmediate 跑完后再读 perf 记录。
  const hostView = (await host.call('status')).session
  await waitFor(async () => (await guest.call('status')).session?.state?.revision === hostView.state.revision)
  await sleep(100)
  const records = perf.recordsSince(from).records
  const publishes = publishRecords(records)

  // P2.1 后：busy status + 行动者同步发布 + 其他席位后台发布，最多 3 次 publishOnline。
  assert.ok(publishes.length <= 3, `一次行动最多三次 publishOnline（busy status + 行动者 + 后台补齐），实际 ${publishes.length}`)
  assert.ok(publishes.filter(entry => entry.published > 0).length <= 2,
    '行动者与其余席位各发一次，不应重复发送同一份最终快照')
  assert.ok(publishes.filter(entry => entry.published > 0).length >= 1, '最终快照至少发一次')
  assert.ok(publishes.some(entry => entry.statusSent > 0 && entry.published === 0),
    'busy 变化仍走 P1.1 的轻量 status，不重发整份会话')
  const memberSends = records.filter(entry => entry.event === 'publish.member')
  assert.ok(memberSends.length <= 2, `publish.member 实际下发 ${memberSends.length} 次不应超过成员数 2`)

  // 最终快照已在命令响应前 flush：客人不需要额外命令就能拿到同一 revision/board。
  const guestStatus = await guest.call('status')
  assert.equal(guestStatus.session.state.revision, hostView.state.revision)
  assert.deepEqual(guestStatus.session.state.board, hostView.state.board)
  assert.equal(guestStatus.busy, false)
})

test('BOARDGAME_ONLINE_COALESCE=0 回滚：每个 snapshotSession 都立即 publishOnline', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t, { env: { BOARDGAME_ONLINE_COALESCE: '0' } })
  const [host, guest] = halls
  await startRoom(halls, relayUrl)

  const action = await nextAction(halls)
  const from = perf.count()
  const result = await action.hall.command('move', { revision: action.revision, move: action.move })
  assert.equal(result.ok, true, result.error)
  const hostView = (await host.call('status')).session
  await waitFor(async () => (await guest.call('status')).session?.state?.revision === hostView.state.revision)
  await sleep(100)
  const publishes = publishRecords(perf.recordsSince(from).records)

  // 回滚后：提交后的 snapshotSession、命令末尾的 snapshotSession、finally 各进一次发布路径。
  assert.ok(publishes.length >= 3, `关闭合并后每次 snapshotSession 都应 publishOnline（实际 ${publishes.length} 次）`)
  assert.ok(publishes.some(entry => entry.published === 0 && !entry.statusSent && entry.skipped > 0),
    '回滚后同一内容也会各走一次 publishOnline（内容未变被跳过但仍进入发布路径）')
  // 回滚只影响发布次数，最终状态仍必须一致。
  const guestStatus = await guest.call('status')
  assert.deepEqual(guestStatus.session.state.board, hostView.state.board)
  assert.equal(guestStatus.session.state.revision, hostView.state.revision)
})

test('房间广播 / 加入 / 退出 / 同步仍立即发布：等待房间的新玩家不靠命令就能拿到 lobby', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t)
  const [host, guest] = halls
  await startRoom(halls, relayUrl)
  const sessionId = (await host.call('status')).session.sessionId

  // 房主解散房间后从存档继续：等待中的房间只有 onlineSession，没有任何命令触发发布。
  await host.call('leave', {})
  await waitFor(async () => !(await host.call('status')).room)
  const loaded = await host.call('load', { relayUrl, sessionId })
  assert.equal(loaded.ok, true, loaded.error)
  assert.equal(loaded.room.phase, 'waiting')
  assert.equal(loaded.lobby.savedGame, true)

  // 新玩家加入触发中转房间广播 → onRoom 必须立即 publishOnline：客人不用发命令就拿到 lobby。
  let from = perf.count()
  const joined = await guest.call('join', { relayUrl, code: loaded.room.code })
  assert.equal(joined.ok, true, joined.error)
  assert.equal(joined.room.members.find(member => member.id === joined.memberId).seat, 1)
  const lobby = await waitFor(async () => {
    const status = await guest.call('status')
    return status.lobby?.savedGame ? status.lobby : null
  })
  const hostLobby = (await host.call('status')).lobby
  assert.equal(lobby.revision, hostLobby.revision)
  assert.equal(lobby.modName, hostLobby.modName)
  assert.equal((await guest.call('status')).session, null, '等待房间不应凭空出现对局会话')
  await sleep(100)
  assert.ok(publishRecords(perf.recordsSince(from).records).length >= 1,
    '加入触发的房间广播 / sync 必须立即 publishOnline，而不是等下一次命令')

  // 准备变化同样走房间广播（合并只作用于命令内部，不吞房间级发布）。
  from = perf.count()
  await guest.call('ready', { ready: true })
  await waitFor(async () => (await host.call('status')).room?.members.some(member => !member.host && member.ready))
  await sleep(100)
  assert.ok(publishRecords(perf.recordsSince(from).records).length >= 1,
    '准备变化触发的房间广播必须立即 publishOnline')

  // 退出 / 断线同样由中转房间广播同步：房主必须立即 publishOnline 让其他席位看到成员离线。
  from = perf.count()
  guest.server.online.close()
  await waitFor(async () => (await host.call('status')).room?.members.some(member => !member.host && member.online === false))
  await sleep(100)
  assert.ok(publishRecords(perf.recordsSince(from).records).length >= 1,
    '退出/断线触发的房间广播必须立即 publishOnline')
})

test('AI 连续动作合并进最终快照：事件不丢、seq 连续、发布次数不随 AI 步数线性增长', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t)
  const [host, guest] = halls
  // 4 席：房主 0 / 客人 1 是真人，2、3 是 AI；未配置模型时 AI 走合法动作兜底，可离线连续行动。
  await startRoom(halls, relayUrl, { modId: 'fixture-static', capacity: 4, aiSeats: [{ seat: 2 }, { seat: 3 }] })

  // 第一段：房主行动后轮到人类客人，不产生 AI 步 —— 作为「无 AI 连续动作」的发布次数基线。
  const initial = (await host.call('status')).session
  assert.equal(initial.decisionSeat, 0)
  let from = perf.count()
  const first = await host.command('move', { revision: initial.state.revision, move: { x: 0, y: 0 } })
  assert.equal(first.ok, true, first.error)
  await waitFor(async () => (await guest.call('status')).session?.state?.revision === (await host.call('status')).session.state.revision)
  await sleep(100)
  const noAiPublishes = publishRecords(perf.recordsSince(from).records).length

  // 第二段：客人行动后，AI 席位 2、3 连续行动，两段行动必须都随最终快照一次到达。
  const guestView = (await guest.call('status')).session
  assert.equal(guestView.decisionSeat, 1)
  from = perf.count()
  const second = await guest.command('move', { revision: guestView.state.revision, move: { x: 1, y: 0 } })
  assert.equal(second.ok, true, second.error)
  const hostAfter = (await host.call('status')).session
  await waitFor(async () => (await guest.call('status')).session?.state?.revision === hostAfter.state.revision)
  await sleep(100)
  const records = perf.recordsSince(from).records
  const aiPublishes = publishRecords(records).length
  const guestAfter = (await guest.call('status')).session

  assert.ok(hostAfter.state.revision >= guestView.state.revision + 3, '客人行动 + 两步 AI 行动都应提交')
  assert.equal(guestAfter.state.revision, hostAfter.state.revision)
  assert.deepEqual(guestAfter.state.board, hostAfter.state.board)
  const aiMoves = guestAfter.events.filter(event => event.type === 'move' && (event.seat === 2 || event.seat === 3))
  assert.equal(aiMoves.length, 2, 'AI 连续两步行动事件应随最终快照下发，不能丢')
  assert.deepEqual(guestAfter.events.map(event => event.seq), guestAfter.events.map((_, index) => index),
    'events.seq 必须连续，客户端才能按序回放 AI 动作')
  assert.ok(records.filter(entry => entry.event === 'publish.member').length <= 2,
    'publish.member 实际下发次数不应超过成员数')
  // 2 步 AI 行动至多比无 AI 行动多一次发布（busy status + 最终 flush），不随 AI 步数线性增长。
  assert.ok(aiPublishes <= noAiPublishes + 1,
    `2 步 AI 行动 publishOnline ${aiPublishes} 次，无 AI 行动 ${noAiPublishes} 次（不应随 AI 步数线性增长）`)
  assert.ok(aiPublishes <= 3, `一次行动 publishOnline 次数应 ≤3，实际 ${aiPublishes}`)
})

test('1 人类 + 1 AI 的两人房：host 一次行动后 AI 动作随最终快照到达且只发一份', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t, { count: 1 })
  const [host] = halls
  await startRoom([host], relayUrl, { modId: 'fixture-static', capacity: 2, aiSeats: [{ seat: 1 }] })

  const initial = (await host.call('status')).session
  assert.equal(initial.decisionSeat, 0)
  const from = perf.count()
  const result = await host.command('move', { revision: initial.state.revision, move: { x: 0, y: 0 } })
  assert.equal(result.ok, true, result.error)
  await sleep(100)
  const view = (await host.call('status')).session
  const records = perf.recordsSince(from).records
  const publishes = publishRecords(records)

  // 房主行动后 AI 座位 1 自动走一步：两步 move 事件都在最终快照里，seq 连续。
  assert.equal(view.state.revision, initial.state.revision + 2, '人类 + AI 两步都应提交到同一最终 revision')
  const moves = view.events.filter(event => event.type === 'move')
  assert.deepEqual(moves.map(event => event.seat), [0, 1], '人类行动与 AI 兜底动作事件都应保留')
  assert.deepEqual(view.events.map(event => event.seq), view.events.map((_, index) => index))
  assert.ok(publishes.length <= 3, `一次行动最多三次 publishOnline（含 P2.1 后台补齐），实际 ${publishes.length}`)
  assert.equal(publishes.filter(entry => entry.published > 0).length, 1, '最终快照只发一次')
  assert.equal(records.filter(entry => entry.event === 'publish.member').length, 0,
    '房间里没有远程成员时不应产生整份会话下发')
})
