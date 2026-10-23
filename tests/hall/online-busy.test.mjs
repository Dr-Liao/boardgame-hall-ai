// P1.1：busy / lobby 变化只发轻量 status 消息（复用 snapshot 信封），不重发整份会话。
//
// 覆盖点：
//   1. 命令 finally 的 busy true→false 走 status：publishOnline 记录里 statusSent > 0 且 published = 0；
//   2. status 不写 sentSnapshots 的增量基线：下一次行动仍然按上一份会话正确 diff，客人视图与房主一致；
//   3. 客人 /status 的 busy 在行动结束后恢复 false；
//   4. BOARDGAME_ONLINE_BUSY=0 时回到旧行为（busy 变化也发整份会话，无 publish.status 记录）。

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
async function waitFor(fn, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20) }
  throw new Error('等待状态同步超时')
}

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-busy-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mods = await loadTestMods()
  const relay = createRelay({ secret: 'busy-test-secret' })
  const relayUrl = await listen(relay)
  const halls = []
  for (let i = 0; i < count; i++) {
    const server = createServer({ mods, persist: i === 0 })
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
    await Promise.all(halls.map(hall => stop(hall.server)))
    await stop(relay)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { halls, relay, relayUrl }
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
  await sleep(50)
  const records = perf.recordsSince(from).records

  const publishes = records.filter(entry => entry.event === 'publishOnline')
  assert.ok(publishes.length >= 2, `一次行动应至少两次 publishOnline，实际 ${publishes.length}`)
  const busyOnly = publishes.filter(entry => entry.statusSent > 0)
  assert.ok(busyOnly.length >= 1, 'finally 的 busy 变化应走 status 消息')
  assert.ok(busyOnly.some(entry => entry.published === 0), 'busy 单独变化时不应重发整份会话')
  assert.ok(records.some(entry => entry.event === 'publish.status' && entry.busy === false),
    '应记录一条 busy=false 的 publish.status')

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
  await sleep(50)
  const secondRecords = perf.recordsSince(fromSecond).records
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
  await sleep(50)
  const records = perf.recordsSince(from).records
  assert.equal(records.some(entry => entry.event === 'publish.status'), false, '关闭开关后不应出现 status 消息')
  assert.equal(records.some(entry => entry.event === 'publishOnline' && entry.statusSent > 0), false)
  assert.ok(records.some(entry => entry.event === 'publishOnline' && entry.published > 0),
    'busy 变化应回到「重发整份会话」的旧行为')
})
