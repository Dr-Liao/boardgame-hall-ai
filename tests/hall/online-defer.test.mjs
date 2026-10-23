// P2.1：非行动者视图延后（BOARDGAME_ONLINE_DEFER=1 开启；默认关闭，因为 P1.4 之后收益在噪声内）。
//
// 断言：
//   1. 开启时，一次行动的会话发布整体延后到命令响应之后的后台发布，各席位只收到一份快照，
//      最终 revision/board 一致；
//   2. 默认关闭时，命令末尾仍同步一次性发布所有席位（mode=flush），行为同 P1.5。

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

async function fixture(t, { count = 3, env = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-defer-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousEnv = {}
  for (const key of Object.keys(env || {})) {
    previousEnv[key] = process.env[key]
    process.env[key] = env[key]
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  const mods = await loadTestMods()
  const relay = createRelay({ secret: 'defer-test-secret' })
  const relayUrl = await listen(relay)
  const halls = []
  for (let i = 0; i < count; i++) {
    const server = createServer({ mods, persist: false })
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
  })
  return { halls, relayUrl }
}

async function startRoom(halls, relayUrl) {
  const [host] = halls
  // fixture-static 支持 2–4 人且无需准备流程，适合 3 厅验证「行动者 + 2 个非行动者」。
  const created = await host.call('create', { relayUrl, modId: 'fixture-static', capacity: halls.length, fillAi: false })
  assert.equal(created.ok, true, created.error)
  for (let index = 1; index < halls.length; index++) {
    assert.equal((await halls[index].call('join', { relayUrl, code: created.room.code })).ok, true)
    await halls[index].call('ready', { ready: true })
  }
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const revision = started.session.state.revision
  await waitFor(async () => (await Promise.all(halls.map(hall => hall.call('status'))))
    .every(status => status.session?.state?.revision === revision))
}

// 当前该行动的席位；取它视图里的第一个合法动作。
async function nextAction(halls) {
  const status = await halls[0].call('status')
  const seat = status.session.decisionSeat
  const actor = halls[seat]
  const session = (await actor.call('status')).session
  const moves = session.state.legalMoves || []
  assert.ok(moves.length, '当前席位必须有合法动作')
  return { seat, hall: actor, revision: session.state.revision, move: moves[0] }
}

const publishesOf = records => records.filter(entry => entry.event === 'publishOnline')

test('BOARDGAME_ONLINE_DEFER=1：会话发布整体延后到命令响应之后，后台一次补齐', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t, { env: { BOARDGAME_ONLINE_DEFER: '1' } })
  const [host, guest1, guest2] = halls
  await startRoom(halls, relayUrl)

  const action = await nextAction(halls)
  const from = perf.count()
  const result = await action.hall.command('move', { revision: action.revision, move: action.move })
  assert.equal(result.ok, true, result.error)

  // 命令一返回时，「会话发布」应该在服务端命令边界之后的后台进行（客户端观察到响应与
  // setImmediate 的先后有竞态，因此不从这里断言时序，只断言不再有行动者同步发布）。
  const immediatePublishes = publishesOf(perf.recordsSince(from).records)
  assert.equal(immediatePublishes.some(entry => entry.mode === 'actor'), false, 'P2.1 不应再同步发布行动者快照')
  assert.ok(immediatePublishes.some(entry => entry.mode === 'full' && entry.statusSent > 0 && entry.published === 0),
    '命令开始的 busy=true 仍应走 P1.1 轻量 status')

  // 等待后台发布补齐。
  const hostView = (await host.call('status')).session
  await waitFor(async () => (await Promise.all([guest1.call('status'), guest2.call('status')]))
    .every(status => status.session?.state?.revision === hostView.state.revision))
  await sleep(80)
  const records = perf.recordsSince(from).records
  const background = publishesOf(records).find(entry => entry.mode === 'background')
  assert.ok(background, '应存在一次后台补齐发布')
  // 命令响应在 onlineCommandInner 返回时发出；onlineCommand 的 perf 记录在同一个微任务里生成，
  // 后台发布只能是之后的 setImmediate，所以背景必须是后记录的那条，绝不会反过来。
  const commandRecord = records.find(entry => entry.event === 'onlineCommand')
  assert.ok(commandRecord, '应有 onlineCommand 的耗时记录')
  assert.ok(background.ts >= commandRecord.ts,
    `后台发布必须在命令边界之后（background.ts=${background.ts}, command.ts=${commandRecord.ts}）`)
  assert.ok(background.published >= 2, `后台发布应补齐两个客人，实际 published=${background.published}`)
  assert.ok(background.revision >= action.revision + 1, '后台发布应携带提交后的新 revision')

  // 每个远程客人恰好收到一份快照（后台发布一次补齐，不重复下发）。
  const memberSends = records.filter(entry => entry.event === 'publish.member')
  assert.equal(memberSends.length, 2, `两名客人应各收到一份快照，实际 ${memberSends.length} 次`)
  assert.deepEqual(memberSends.map(entry => entry.seat).sort(), [1, 2])

  // 最终状态一致。
  const guestStates = await Promise.all([guest1.call('status'), guest2.call('status')])
  for (const guest of guestStates) {
    assert.equal(guest.session.state.revision, hostView.state.revision)
    assert.deepEqual(guest.session.state.board, hostView.state.board)
    assert.equal(guest.busy, false)
  }
})

test('BOARDGAME_ONLINE_DEFER=0 回滚：命令末尾一次性同步发布所有席位', async t => {
  enablePerf(t)
  const { halls, relayUrl } = await fixture(t)
  const [host] = halls
  await startRoom(halls, relayUrl)

  const action = await nextAction(halls)
  const from = perf.count()
  const result = await action.hall.command('move', { revision: action.revision, move: action.move })
  assert.equal(result.ok, true, result.error)
  const hostView = (await host.call('status')).session
  await waitFor(async () => (await Promise.all(halls.map(hall => hall.call('status'))))
    .every(status => status.session?.state?.revision === hostView.state.revision))
  await sleep(80)

  const publishes = publishesOf(perf.recordsSince(from).records)
  assert.equal(publishes.some(entry => entry.mode === 'actor'), false, '默认关闭时不应出现行动者单独发布')
  assert.equal(publishes.some(entry => entry.mode === 'background'), false, '默认关闭时不应出现后台补齐')
  const fullFlush = publishes.find(entry => entry.mode === 'flush')
  assert.ok(fullFlush, '默认关闭时应在命令末尾一次性 flush 所有席位')
  assert.equal(fullFlush.deferred, 0, '默认关闭时不应延后任何席位')
  assert.ok(fullFlush.published >= 2, '默认关闭时一次性发布所有在线席位')
})
