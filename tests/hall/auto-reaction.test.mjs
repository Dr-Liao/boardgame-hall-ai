// 自动反应（三态）大厅回归：
//   - 默认 auto：有 autoOptionId 的窗口由房主进程补 choose/trigger；
//   - 个人覆盖 ask：窗口保留；skip：补 choose/skip；
//   - 覆盖随 prefs 异步上行，并单独写 sidecar；
//   - 四座位连续 auto 窗口在同一条命令里全部结算。
//
// 只测大厅通用机制，使用 fixture-autopass（它带 autoChoice 钩子）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRelay } from '../../relay/server.js'
import { createServer } from '../../lib/server.js'
import { readPrefs } from '../../lib/sessions.js'
import { loadTestMods } from './helpers/mods.mjs'

const MOD = 'fixture-autopass'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(resolve => { try { server.online?.close() } catch { /* already closed */ } server.closeAllConnections(); server.close(() => resolve()) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20) }
  throw new Error('等待状态同步超时')
}

async function fixture(t, count = 1) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-autoreaction-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mods = await loadTestMods()
  const relay = count > 1 ? createRelay({ secret: 'autoreaction-test-secret' }) : null
  const relayUrl = relay ? await listen(relay) : null
  const halls = []
  for (let index = 0; index < count; index++) {
    const server = createServer({ mods, persist: index === 0 })
    await server.ready
    const origin = await listen(server)
    const request = async (route, body) => {
      const res = await fetch(origin + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return res.json()
    }
    const online = async (route, body) => {
      const res = await fetch(origin + '/api/online/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return res.json()
    }
    halls.push({ server, origin, request, online,
      command: (action, body = {}) => online('command', { action, body: { operationId: randomUUID(), ...body } }) })
  }
  t.after(async () => {
    await Promise.all(halls.map(hall => stop(hall.server)))
    if (relay) await stop(relay)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { halls, relayUrl }
}

async function startSolo(t) {
  const { halls } = await fixture(t, 1)
  const hall = halls[0]
  const started = await hall.request('start', { modId: MOD, settings: { playerCount: 1 } })
  assert.equal(started.ok, true, started.error)
  return { hall, started }
}

async function startOnline(t, capacity = 4) {
  const { halls, relayUrl } = await fixture(t, capacity)
  const [host, ...guests] = halls
  const created = await host.online('create', { relayUrl, modId: MOD, capacity, fillAi: false })
  assert.equal(created.ok, true, created.error)
  for (const guest of guests) {
    assert.equal((await guest.online('join', { relayUrl, code: created.room.code })).ok, true)
    assert.equal((await guest.online('ready', { ready: true })).ok, true)
  }
  assert.equal((await host.command('start')).ok, true)
  await waitFor(async () => {
    const views = await Promise.all(halls.map(hall => hall.online('status')))
    return views.every(view => view.session?.state?.status === 'playing')
  })
  return { halls, host, guests }
}

const labels = state => state.log.map(entry => entry.move.optionId ?? entry.move.action)
const viewOf = async hall => (await hall.online('status')).session

test('单机：默认 auto 在响应前代答 trigger，窗口不发布', async t => {
  const { hall, started } = await startSolo(t)
  const sessionId = started.session.sessionId
  const revision = started.session.state.revision
  const opened = await hall.request('move', { sessionId, revision, move: { action: 'openAuto' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice, null)
  assert.equal(opened.session.state.triggered, 1)
  assert.deepEqual(labels(opened.session.state), ['openAuto', 'trigger'])
  assert.equal(opened.session.state.revision, revision + 2)
})

test('单机：ask 覆盖保留窗口，skip 覆盖代答 skip', async t => {
  const { hall, started } = await startSolo(t)
  const sessionId = started.session.sessionId
  const ask = await hall.request('move', {
    sessionId, revision: started.session.state.revision, move: { action: 'openAuto' },
    client: { autoPrefs: { states: { 'opt-card': 'ask' }, seq: 10 } },
  })
  assert.equal(ask.ok, true, ask.error)
  assert.equal(ask.session.state.pendingChoice?.seat, 0)
  assert.equal(ask.session.state.triggered, 0)
  assert.deepEqual(ask.session.state.pendingChoice.options.map(option => option.id), ['skip', 'trigger'])

  const answered = await hall.request('move', {
    sessionId, revision: ask.session.state.revision,
    move: { action: 'choose', choiceId: ask.session.state.pendingChoice.id, optionId: 'trigger' },
  })
  assert.equal(answered.ok, true, answered.error)
  assert.equal(answered.session.state.triggered, 1)

  const skip = await hall.request('move', {
    sessionId, revision: answered.session.state.revision, move: { action: 'openAuto' },
    client: { autoPrefs: { states: { 'opt-card': 'skip' }, seq: 11 } },
  })
  assert.equal(skip.ok, true, skip.error)
  assert.equal(skip.session.state.pendingChoice, null)
  assert.equal(skip.session.state.triggered, 1)
  assert.deepEqual(labels(skip.session.state).slice(-2), ['openAuto', 'skip'])
})

test('prefs 异步上行写入覆盖与 sidecar，后续命令按缓存代答', async t => {
  const { hall, started } = await startSolo(t)
  const sessionId = started.session.sessionId
  const pref = await hall.request('prefs', { sessionId, states: { 'opt-card': 'skip' }, seq: 20 })
  assert.equal(pref.ok, true, pref.error)
  const opened = await hall.request('move', { sessionId, revision: started.session.state.revision, move: { action: 'openAuto' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice, null)
  assert.equal(opened.session.state.triggered, 0)
  await waitFor(() => readPrefs(sessionId), 3000)
  const stored = readPrefs(sessionId)
  assert.equal(stored.seats['0'].states['opt-card'], 'skip')
})

test('联机：四座位连续 auto 窗口在同一条命令里全部 trigger', async t => {
  const { halls, host } = await startOnline(t, 4)
  const before = await viewOf(host)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAutoAll' } })
  assert.equal(opened.ok, true, opened.error)
  const after = opened.session.state
  assert.equal(after.pendingChoice, null)
  assert.equal(after.triggered, 4)
  assert.equal(after.completed, 1)
  assert.deepEqual(labels(after), ['openAutoAll', 'trigger', 'trigger', 'trigger', 'trigger'])
  assert.equal(after.revision, before.state.revision + 5)
  await waitFor(async () => {
    const views = await Promise.all(halls.map(hall => hall.online('status')))
    return views.every(view => view.session?.state?.revision >= after.revision)
  })
  for (const hall of halls) assert.equal((await viewOf(hall)).state.pendingChoice, null)
})

test('联机：某个座位 ask 时链停在该座位，回答后其余座位继续自动结算', async t => {
  const { halls, host, guests } = await startOnline(t, 4)
  const pref = await guests[0].command('prefs', { states: { 'opt-card': 'ask' }, seq: 30 })
  assert.equal(pref.ok, true, pref.error)
  const before = await viewOf(host)
  const opened = await host.command('move', { revision: before.state.revision, move: { action: 'openAutoAll' } })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice?.seat, 1, 'seat 0 自动、seat 1 留给本人')
  assert.equal(opened.session.state.triggered, 1)

  const guestView = await waitFor(async () => {
    const view = await viewOf(guests[0])
    return view.state.pendingChoice?.seat === 1 ? view : null
  })
  const answered = await guests[0].command('move', {
    revision: guestView.state.revision,
    move: { action: 'choose', choiceId: guestView.state.pendingChoice.id, optionId: 'trigger' },
  })
  assert.equal(answered.ok, true, answered.error)
  await waitFor(async () => {
    const view = await viewOf(host)
    return view.state.completed === 1 && view.state.pendingChoice === null ? view : null
  })
  const final = await viewOf(host)
  assert.equal(final.state.triggered, 4)
  assert.deepEqual(labels(final.state).slice(-4), ['trigger', 'trigger', 'trigger', 'trigger'])
})

test('sidecar 读档恢复：重启大厅后仍按 skip 代答', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-autoreaction-restore-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mods = await loadTestMods()
  const servers = []
  const startHall = async () => {
    const server = createServer({ mods, persist: true })
    await server.ready
    servers.push(server)
    const origin = await listen(server)
    return {
      origin,
      request: async (route, body) => {
        const res = await fetch(origin + '/api/' + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        })
        return res.json()
      },
    }
  }
  t.after(async () => {
    await Promise.all(servers.map(server => stop(server)))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  const first = await startHall()
  const started = await first.request('start', { modId: MOD, settings: { playerCount: 1 } })
  assert.equal(started.ok, true, started.error)
  const sessionId = started.session.sessionId
  assert.equal((await first.request('prefs', { sessionId, states: { 'opt-card': 'skip' }, seq: 99 })).ok, true)
  await waitFor(() => readPrefs(sessionId), 3000)
  await stop(servers.pop())

  const second = await startHall()
  const status = await second.request('session?sessionId=' + encodeURIComponent(sessionId))
  assert.equal(status.ok, true, status.error)
  const view = status.session
  assert.ok(view?.state, '重启后应对局可读')
  const opened = await second.request('move', {
    sessionId, revision: view.state.revision, move: { action: 'openAuto' },
  })
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.session.state.pendingChoice, null)
  assert.equal(opened.session.state.triggered, 0)
  assert.deepEqual(opened.session.state.log.slice(-2).map(entry => entry.move.optionId ?? entry.move.action), ['openAuto', 'skip'])
})
