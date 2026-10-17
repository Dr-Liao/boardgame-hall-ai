import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRelay } from '../../relay/server.js'
import { createServer } from '../../lib/server.js'
import { loadMods } from '../../lib/mods.js'
import { relayAddress } from '../../lib/online.js'
import { snapshotPath } from '../../lib/sessions.js'

const arkham = fs.existsSync(new URL('../../games/arkhamhorror/index.js', import.meta.url)) ? {} : { skip: '未检出 games/arkhamhorror 子模块' }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(resolve => { server.stopRelay?.(); server.online?.close(); server.closeAllConnections(); server.close(resolve) })
async function waitFor(fn, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 30)) }
  throw new Error('等待状态同步超时')
}
async function fixture(t, count = 2, persistHost = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-online-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mods = await loadMods()
  const relay = createRelay({ secret: 'integration-test-secret' }), relayUrl = await listen(relay)
  const halls = []
  for (let i = 0; i < count; i++) {
    const server = createServer({ mods, persist: persistHost && halls.length === 0 }); await server.ready
    const origin = await listen(server)
    const call = async (route, body) => {
      const res = await fetch(origin + '/api/online/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
      return res.json()
    }
    const command = (action, body = {}) => call('command', { action, body: { operationId: randomUUID(), ...body } })
    halls.push({ server, origin, call, command })
  }
  t.after(async () => {
    await Promise.all(halls.map(h => stop(h.server))); await stop(relay)
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { halls, relay, relayUrl, mods }
}

test('relay address accepts Render HTTPS and loopback development, rejects credentials and insecure remote hosts', () => {
  assert.equal(relayAddress('https://test.onrender.com'), 'wss://test.onrender.com/ws')
  assert.equal(relayAddress('http://127.0.0.1:1234'), 'ws://127.0.0.1:1234/ws')
  for (const url of ['http://example.com', 'wss://user:pass@example.com', 'file:///tmp/x', 'https://x.com?key=a']) assert.throws(() => relayAddress(url))
})

test('two halls: ready, authoritative seats, revisions, duplicate operations, chat, reset, reconnect and close', async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: 'ox', capacity: 2, fillAi: false })
  assert.equal(created.ok, true, created.error)
  const joined = await guest.call('join', { relayUrl, code: created.room.code })
  assert.equal(joined.ok, true, joined.error)
  assert.equal((await host.command('start')).ok, false, 'unready guest prevents start')
  await guest.call('ready', { ready: true })
  assert.equal((await guest.command('start')).ok, false, 'guest cannot start')
  const start = await host.command('start')
  assert.equal(start.ok, true, start.error)
  await waitFor(async () => (await guest.call('status')).session)
  const guestSession = (await guest.call('status')).session
  assert.equal(guestSession.mySeat, 1)
  assert.deepEqual(guestSession.players.map(p => p.role), ['human', 'human'])
  const forged = await guest.command('move', { seat: 0, revision: 0, move: { x: 0, y: 0 } })
  assert.equal(forged.ok, false)
  const op = { operationId: randomUUID(), revision: 0, move: { x: 0, y: 0 } }
  const first = await host.command('move', op)
  assert.equal(first.ok, true, first.error)
  assert.equal((await host.command('move', op)).session.state.moveCount, 1, 'duplicate does not apply twice')
  assert.equal((await guest.command('move', { revision: 0, move: { x: 1, y: 0 } })).ok, false)
  const second = await guest.command('move', { revision: 1, move: { x: 1, y: 0 } })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.session.state.board[1], 'white')
  await waitFor(async () => (await host.call('status')).session.state.revision === 2)
  const chat = await guest.command('chat', { text: '来自第二席位', to: 0 })
  assert.equal(chat.session.events.at(-1).seat, 1)
  assert.equal((await guest.command('reset')).ok, false)
  const localBefore = (await guest.call('status')).memberId
  // Refreshing a browser does not recreate its local hall connection.
  assert.equal((await guest.call('status')).memberId, localBefore)
  const reset = await host.command('reset')
  assert.equal(reset.ok, true, reset.error)
  assert.equal(reset.session.state.moveCount, 0)
  assert.ok(reset.session.state.revision > 2)
  const blocked = await fetch(host.origin + '/api/online/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(blocked.status, 403)
  await host.call('leave', {})
  await waitFor(async () => !(await guest.call('status')).room)
})

test('Arkham supports three human seats, private hands and private chat projection', arkham, async t => {
  const { halls: [host, guest, third], relayUrl } = await fixture(t, 3)
  const created = await host.call('create', { relayUrl, modId: 'arkhamhorror', capacity: 3, settings: { difficulty: 'easy' }, fillAi: false })
  for (const hall of [guest, third]) {
    assert.equal((await hall.call('join', { relayUrl, code: created.room.code })).ok, true)
    await hall.call('ready', { ready: true })
  }
  const start = await host.command('start')
  assert.equal(start.ok, true, start.error)
  await waitFor(async () => (await third.call('status')).session)
  const other = (await third.call('status')).session
  assert.equal(other.mySeat, 2)
  assert.deepEqual(other.state.humanSeats, [0, 1, 2])
  assert.deepEqual(other.settings, {})
  for (const inv of other.state.investigators.filter(inv => inv.seat !== 2)) assert.deepEqual(inv.hand, [])
  await guest.command('chat', { text: '仅第二和第三位可见', to: 2 })
  await waitFor(async () => (await third.call('status')).session.events.some(e => e.text === '仅第二和第三位可见'))
  assert.equal((await host.call('status')).session.events.some(e => e.text === '仅第二和第三位可见'), false)
  const session = (await host.call('status')).session
  assert.ok(session.state.legalMoves.length > 0)
  const moved = await host.command('move', { revision: session.state.revision, move: session.state.legalMoves[0] })
  assert.equal(moved.ok, true, moved.error)
})

test('Arkham confirms several staged mulligan cards atomically in one online command', arkham, async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: 'arkhamhorror', capacity: 2,
    settings: { legacyAutoStart: true, seed: 'batch-mulligan' }, fillAi: false })
  assert.equal(created.ok, true, created.error)
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code })).ok, true)
  await guest.call('ready', { ready: true })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const before = started.session
  assert.equal(before.state.pendingChoice?.kind, 'mulligan')
  const hand = before.state.investigators[0].hand
  assert.ok(hand.length >= 3)
  const batchChoices = { choiceId: before.state.pendingChoice.id, kind: 'mulligan',
    selected: [{ index: 0, code: hand[0] }, { index: 2, code: hand[2] }], finish: 'done' }
  const bad = await host.command('move', { revision: before.state.revision,
    batchChoices: { ...batchChoices, selected: [{ index: 0, code: hand[0] }, { index: 2, code: 'forged' }] } })
  assert.equal(bad.ok, false)
  assert.equal((await host.call('status')).session.state.revision, before.state.revision, 'failed batch cannot commit a partial mulligan')
  const invalidFinish = await host.command('move', { revision: before.state.revision,
    batchChoices: { ...batchChoices, finish: 'help' } })
  assert.equal(invalidFinish.ok, false)
  assert.equal((await host.call('status')).session.state.revision, before.state.revision, 'a failed final confirmation rolls back earlier valid choices')
  const confirmed = await host.command('move', { revision: before.state.revision, batchChoices })
  assert.equal(confirmed.ok, true, confirmed.error)
  assert.equal(confirmed.session.state.revision, before.state.revision + 3)
  assert.notEqual(confirmed.session.state.pendingChoice?.seat, 0)
  await waitFor(async () => (await guest.call('status')).session?.state.revision === confirmed.session.state.revision)
  assert.deepEqual((await guest.call('status')).session.state.investigators[0].hand, [], 'other players still cannot see the new hand')
})

test('Arkham skill card selection uses the same atomic confirmation and validates the current choice', arkham, async t => {
  const { halls, relayUrl } = await fixture(t)
  const created = await halls[0].call('create', { relayUrl, modId: 'arkhamhorror', capacity: 2,
    settings: { legacyAutoStart: true, seed: 'batch-skill-test' }, fillAi: false })
  assert.equal(created.ok, true, created.error)
  assert.equal((await halls[1].call('join', { relayUrl, code: created.room.code })).ok, true)
  await halls[1].call('ready', { ready: true })
  assert.equal((await halls[0].command('start')).ok, true)
  let confirmed = false
  for (let step = 0; step < 80 && !confirmed; step++) {
    const session = (await halls[0].call('status')).session
    const seat = session.decisionSeat
    const view = (await halls[seat].call('status')).session
    const st = view.state, moves = st.legalMoves
    const candidate = st.pendingChoice?.kind === 'commit' && moves.find(move => /^\d+$/.test(move.optionId))
    if (candidate) {
      const index = Number(candidate.optionId), code = st.investigators[seat].hand[index]
      const wrong = await halls[seat].command('move', { revision: st.revision, batchChoices: {
        choiceId: 'stale-choice', kind: 'commit', selected: [{ index, code }], finish: 'done' } })
      assert.equal(wrong.ok, false)
      assert.equal((await halls[0].call('status')).session.state.revision, st.revision)
      const result = await halls[seat].command('move', { revision: st.revision, batchChoices: {
        choiceId: st.pendingChoice.id, kind: 'commit', selected: [{ index, code }], finish: 'done' } })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.session.state.revision, st.revision + 2)
      confirmed = true
      break
    }
    const move = st.pendingChoice
      ? moves.find(item => ['done', 'skip', 'pass', 'keep', '0'].includes(item.optionId)) || moves[0]
      : moves.find(item => item.action === 'investigate') || moves.find(item => item.action === 'endTurn') || moves[0]
    assert.ok(move, `no legal move at ${step}`)
    const result = await halls[seat].command('move', { revision: st.revision, move })
    assert.equal(result.ok, true, result.error)
  }
  assert.equal(confirmed, true, 'expected a skill test with a legal card to commit')
})

test('relay restart restores room code and seats with persistent signing secret', async t => {
  const { halls: [host, guest], relay, relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: 'gobang', capacity: 2, fillAi: false })
  await guest.call('join', { relayUrl, code: created.room.code }); await guest.call('ready', { ready: true })
  assert.equal((await host.command('start')).ok, true)
  await host.command('move', { revision: 0, move: { x: 7, y: 7 } })
  const port = relay.address().port
  await stop(relay)
  await waitFor(async () => !(await host.call('status')).connected && !(await guest.call('status')).connected)
  const replacement = createRelay({ secret: 'integration-test-secret' })
  await new Promise(r => replacement.listen(port, '127.0.0.1', r))
  t.after(() => stop(replacement))
  await waitFor(async () => {
    const value = await guest.call('status')
    return value.connected && value.session?.state.revision === 1 && value.room.members.every(m => m.online)
  }, 15000)
  const result = await guest.command('move', { revision: 1, move: { x: 7, y: 8 } })
  assert.equal(result.ok, true, result.error)
  assert.equal((await guest.call('status')).room.code, created.room.code)
})

for (const modId of ['ox', 'arkhamhorror']) test(`${modId}: host process restart restores saved game and authenticated room; guest can leave and return`, modId === 'arkhamhorror' ? arkham : {}, async t => {
  const { halls: [initial, guest], relayUrl, mods } = await fixture(t)
  await stop(initial.server)
  const hostServer = createServer({ mods, persist: true }); await hostServer.ready
  const hostUrl = await listen(hostServer)
  const call = async (origin, route, body) => (await fetch(origin + '/api/online/' + route, {
    method: body ? 'POST' : 'GET', headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json()
  const created = await call(hostUrl, 'create', { relayUrl, modId, capacity: 2, fillAi: false,
    settings: { legacyAutoStart: true, seed: 'online-persistent-choice' } })
  await guest.call('join', { relayUrl, code: created.room.code }); await guest.call('ready', { ready: true })
  const cmd = (origin, action, body = {}) => call(origin, 'command', { action, body: { operationId: randomUUID(), ...body } })
  const started = await cmd(hostUrl, 'start')
  assert.equal(started.ok, true)
  const move = modId === 'ox' ? { x: 0, y: 0 } : started.session.state.legalMoves.find(m => m.optionId === 'done')
  assert.equal((await cmd(hostUrl, 'move', { revision: 0, move })).ok, true)
  await waitFor(async () => (await guest.call('status')).session?.state.revision === 1)
  const before = (await guest.call('status')).session
  await stop(hostServer)
  const replacement = createServer({ mods, persist: true }); await replacement.ready
  const replacementUrl = await listen(replacement)
  t.after(() => stop(replacement))
  await waitFor(async () => (await call(replacementUrl, 'status')).connected)
  const restored = await call(replacementUrl, 'status')
  assert.equal(restored.room.code, created.room.code)
  assert.equal(restored.session.state.revision, 1)
  const returningId = (await guest.call('status')).memberId
  await guest.call('leave', {})
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code })).ok, true)
  assert.equal((await guest.call('status')).memberId, returningId)
  await waitFor(async () => (await guest.call('status')).session?.state.revision === 1)
  const returned = (await guest.call('status')).session
  if (modId === 'arkhamhorror') {
    assert.equal(returned.state.pendingChoice.id, before.state.pendingChoice.id)
    assert.deepEqual(returned.state.investigators[1].hand, before.state.investigators[1].hand)
    assert.deepEqual(returned.state.investigators[0].hand, [])
  }
  const nextMove = modId === 'ox' ? { x: 1, y: 1 } : returned.state.legalMoves.find(m => m.optionId === 'done')
  const moved = await guest.command('move', { revision: 1, move: nextMove })
  assert.equal(moved.ok, true, moved.error)
})

test('relay rejects incompatible games and guest control messages; snapshots stay in their room', async t => {
  const relay = createRelay(), url = await listen(relay), clients = []
  t.after(async () => { for (const client of clients) client.socket.close(); await stop(relay) })
  async function client() {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws'), messages = [], pending = new Map()
    socket.addEventListener('message', e => {
      const data = JSON.parse(e.data); messages.push(data)
      if (data.type === 'result') { pending.get(data.id)?.(data); pending.delete(data.id) }
    })
    await new Promise(r => socket.addEventListener('open', r, { once: true }))
    const send = data => socket.send(JSON.stringify({ id: randomUUID(), ...data }))
    const rpc = data => new Promise(resolve => { const id = randomUUID(); pending.set(id, resolve); send({ ...data, id }) })
    const value = { socket, messages, send, rpc }; clients.push(value); return value
  }
  const host = await client(), guest = await client(), stranger = await client()
  const created = await host.rpc({ type: 'create', name: '房主', capacity: 2, game: { id: 'ox', name: '井字棋', version: 'one' } })
  const room = created.data.room
  assert.equal((await guest.rpc({ type: 'join', code: room.code, versions: { ox: 'two' } })).ok, false)
  const joined = await guest.rpc({ type: 'join', code: room.code, versions: { ox: 'one' } })
  assert.equal(joined.ok, true)
  await stranger.rpc({ type: 'create', capacity: 2, game: { id: 'ox', name: '其他房间', version: 'one' } })
  for (const type of ['snapshot', 'reply', 'phase']) assert.equal((await guest.rpc({ type, phase: 'playing', target: joined.data.memberId, data: { session: { private: 'forged' } } })).ok, false)
  assert.equal((await guest.rpc({ type: 'request', action: 'config', body: { apiKey: 'fake' } })).ok, false)
  host.send({ type: 'snapshot', target: joined.data.memberId, data: { session: { private: 'only-room-one' } } })
  await waitFor(() => guest.messages.some(m => m.type === 'snapshot'))
  assert.equal(guest.messages.find(m => m.type === 'snapshot').session.private, 'only-room-one')
  assert.equal(stranger.messages.some(m => m.type === 'snapshot'), false)
  const signal = { type: 'offer', negotiationId: 'test', description: { type: 'offer', sdp: 'test' } }
  assert.equal((await guest.rpc({ type: 'signal', target: created.data.memberId, data: signal })).ok, true)
  await waitFor(() => host.messages.some(message => message.type === 'signal'))
  assert.equal(host.messages.find(message => message.type === 'signal').from, joined.data.memberId)
  assert.equal((await guest.rpc({ type: 'signal', target: joined.data.memberId, data: signal })).ok, false)
  assert.equal((await stranger.rpc({ type: 'signal', target: joined.data.memberId, data: signal })).ok, false)
  assert.equal((await guest.rpc({ type: 'signal', target: created.data.memberId, data: { ...signal, description: { sdp: 'x'.repeat(66000) } } })).ok, false)
})

test('empty slots can be AI and host executes AI turns once', async t => {
  const { halls: [host], relayUrl } = await fixture(t, 1)
  await host.call('create', { relayUrl, modId: 'ox', capacity: 2, fillAi: true, settings: { firstMove: 'ai' } })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  assert.equal(started.session.players[1].role, 'ai')
  assert.equal(started.session.state.moveCount, 1)
  assert.equal(started.session.decisionSeat, 0)
  const position = started.session.state.board.findIndex(v => !v)
  const result = await host.command('move', { revision: started.session.state.revision, move: { x: position % 3, y: Math.floor(position / 3) } })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.session.state.moveCount, 3)
})

test('reserved AI seats survive relay restart, block joins, and preserve the chosen AI identities', arkham, async t => {
  const { halls: [host, guest, extra], relay, relayUrl } = await fixture(t, 3)
  for (const aiSeats of [[{ seat: 0 }], [{ seat: 4 }], [{ seat: 1 }, { seat: 1 }]]) {
    assert.equal((await host.call('create', { relayUrl, modId: 'arkhamhorror', capacity: 4, aiSeats })).ok, false)
  }
  const created = await host.call('create', { relayUrl, modId: 'arkhamhorror', capacity: 4,
    aiSeats: [{ seat: 1, aiId: 'ai-hu' }, { seat: 3, aiId: 'ai-mei' }] })
  assert.equal(created.ok, true, created.error)
  assert.deepEqual(created.room.aiSeats.map(s => s.seat), [1, 3])
  assert.equal((await host.command('start')).ok, false, 'empty human seats must join before starting')
  const port = relay.address().port
  await stop(relay)
  await waitFor(async () => !(await host.call('status')).connected)
  const replacement = createRelay({ secret: 'integration-test-secret' })
  await new Promise(r => replacement.listen(port, '127.0.0.1', r))
  t.after(() => stop(replacement))
  await waitFor(async () => (await host.call('status')).connected, 15000)
  assert.deepEqual((await host.call('status')).room.aiSeats, created.room.aiSeats)
  const joined = await guest.call('join', { relayUrl, code: created.room.code })
  assert.equal(joined.ok, true, joined.error)
  assert.equal(joined.room.members.find(m => m.id === joined.memberId).seat, 2)
  const rejected = await extra.call('join', { relayUrl, code: created.room.code })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /AI 席位不可加入/)
  await guest.call('ready', { ready: true })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  assert.deepEqual(started.session.players.map(p => p.role), ['human', 'ai', 'human', 'ai'])
  assert.equal(started.session.players[1].aiId, 'ai-hu')
  assert.equal(started.session.players[3].aiId, 'ai-mei')
})

test('online saves reopen as joinable rooms and preserve seats, private state and pending choices', arkham, async t => {
  const { halls: [host, guest, third], relayUrl, mods } = await fixture(t, 3, true)
  const local = async (route, body) => (await fetch(host.origin + '/api/' + route, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json()
  const solo = await local('start', { modId: 'ox', settings: { opponents: ['ai-hu'] } })
  assert.equal(solo.ok, true, solo.error)
  assert.equal((await host.call('load', { relayUrl, sessionId: solo.session.sessionId })).ok, false)
  const created = await host.call('create', { relayUrl, modId: 'arkhamhorror', capacity: 4,
    aiSeats: [{ seat: 2, aiId: 'ai-hu' }], settings: { legacyAutoStart: true, seed: 'load-online-save' } })
  assert.equal(created.ok, true, created.error)
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code, seat: 2 })).ok, false, 'cannot claim AI seat')
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code, seat: 3 })).ok, true)
  assert.equal((await third.call('join', { relayUrl, code: created.room.code, seat: 1 })).ok, true)
  await guest.call('ready', { ready: true }); await third.call('ready', { ready: true })
  await waitFor(async () => (await host.call('status')).room.members.every(m => m.ready))
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const moved = await host.command('move', { revision: 0, move: started.session.state.legalMoves.find(m => m.optionId === 'done') })
  assert.equal(moved.ok, true, moved.error)
  const id = moved.session.sessionId
  const before = (await third.call('status')).session
  assert.equal(before.state.pendingChoice.seat, 1)
  await host.call('leave', {})
  await waitFor(async () => !(await guest.call('status')).room && !(await third.call('status')).room)
  const summaries = (await local('sessions')).sessions
  assert.equal(summaries.find(s => s.sessionId === id).mode, 'online')
  assert.equal(summaries.find(s => s.sessionId === id).humanCount, 3)
  assert.equal(summaries.find(s => s.sessionId === solo.session.sessionId).mode, 'solo')
  assert.equal((await local('session/load', { sessionId: id })).code, 'ONLINE_SAVE')
  const file = snapshotPath(id), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.resourceVersion = 'previous-browser-ui-version'
  fs.writeFileSync(file, JSON.stringify(saved))
  assert.equal((await local('sessions')).sessions.find(s => s.sessionId === id).compatible, true, 'UI-only upgrades preserve old saves')
  const validRules = saved.session.state.rulesVersion
  saved.session.state.rulesVersion = 'incompatible-rules'
  fs.writeFileSync(file, JSON.stringify(saved))
  assert.equal((await host.call('load', { relayUrl, sessionId: id })).ok, false, 'real rules mismatch stays blocked')
  saved.session.state.rulesVersion = validRules
  fs.writeFileSync(file, JSON.stringify(saved))
  const loaded = await host.call('load', { relayUrl, sessionId: id })
  assert.equal(loaded.ok, true, loaded.error)
  assert.notEqual(loaded.room.code, created.room.code)
  assert.equal(loaded.room.phase, 'waiting')
  assert.equal(loaded.session, null)
  assert.equal(loaded.lobby.savedGame, true)
  assert.deepEqual(loaded.room.aiSeats.map(s => s.seat), [2])
  assert.equal((await host.command('start')).ok, false, 'must wait for human seats')
  assert.equal((await host.command('move', { revision: 1, move: {} })).ok, false)
  // Restart the host while the loaded save is still waiting for its players.
  await stop(host.server)
  host.server = createServer({ mods, persist: true }); await host.server.ready
  host.origin = await listen(host.server)
  host.call = async (route, body) => (await fetch(host.origin + '/api/online/' + route, {
    method: body ? 'POST' : 'GET', headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json()
  host.command = (action, body = {}) => host.call('command', { action, body: { operationId: randomUUID(), ...body } })
  await waitFor(async () => (await host.call('status')).connected)
  assert.equal((await host.call('status')).lobby.savedGame, true)
  assert.equal((await host.call('status')).session, null)
  await guest.call('join', { relayUrl, code: loaded.room.code, seat: 3 })
  await third.call('join', { relayUrl, code: loaded.room.code, seat: 1 })
  await waitFor(async () => (await third.call('status')).lobby?.savedGame)
  assert.equal((await third.command('move', { revision: 1, move: {} })).ok, false)
  await guest.call('ready', { ready: true }); await third.call('ready', { ready: true })
  await waitFor(async () => (await host.call('status')).room.members.every(m => m.ready))
  const resumed = await host.command('start')
  assert.equal(resumed.ok, true, resumed.error)
  assert.equal(resumed.session.sessionId, id)
  await waitFor(async () => (await third.call('status')).session?.state.revision === 1)
  const after = (await third.call('status')).session
  assert.equal(after.mySeat, 1)
  assert.deepEqual(after.state, before.state)
  assert.deepEqual(after.players, before.players)
  assert.deepEqual(after.events, before.events)
  assert.deepEqual(after.state.investigators[0].hand, [])
  assert.equal((await third.command('move', { revision: 1, move: after.state.legalMoves.find(m => m.optionId === 'done') })).ok, true)
})

test('status updates wake immediately and host operations use the local authority', arkham, async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: 'arkhamhorror', capacity: 2, aiSeats: [] })
  await guest.call('join', { relayUrl, code: created.room.code }); await guest.call('ready', { ready: true })
  await waitFor(async () => (await host.call('status')).room.members.every(m => m.ready))
  await host.command('start')
  await waitFor(async () => !!(await guest.call('status')).session)
  const current = await guest.call('status')
  let answered = false
  const waiting = guest.call(`status?wait=1&after=${current.serial}&instanceId=${current.instanceId}`).then(value => { answered = true; return value })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(answered, false, 'unchanged state does not poll or resend a full session')
  const metric = { ...host.server.online.metrics }
  const sent = performance.now()
  await host.command('chat', { text: 'wake up immediately' })
  const value = await waiting
  assert.ok(performance.now() - sent < 600, 'no 700 ms polling delay')
  assert.ok(value.session.events.some(e => e.text === 'wake up immediately'))
  assert.equal(host.server.online.metrics.localCommands, metric.localCommands + 1)
  const bytes = host.server.online.metrics.sentBytes - metric.sentBytes
  const full = host.server.online.metrics.fullBytes - metric.fullBytes
  assert.ok(bytes < full / 10, `delta ${bytes} versus full ${full}`)
  t.diagnostic(`chat snapshot payload: ${bytes} bytes versus ${full} bytes without deltas`)
})

test('Arkham human guests and an AI teammate complete preparation and opening choices together', arkham, async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: 'arkhamhorror', capacity: 3, fillAi: true, settings: { seed: 'mixed-arkham-online' } })
  await guest.call('join', { relayUrl, code: created.room.code }); await guest.call('ready', { ready: true })
  assert.equal((await host.command('start')).ok, true)
  for (let step = 0; step < 24; step++) {
    const s = (await host.call('status')).session
    if (s.state.uiState === 'inScenario' && s.state.pendingChoice?.kind !== 'mulligan') break
    const seat = s.decisionSeat
    assert.ok(seat === 0 || seat === 1, 'the AI runner returns control to a human')
    const hall = seat ? guest : host
    await waitFor(async () => (await hall.call('status')).session?.state.revision === s.state.revision)
    const current = (await hall.call('status')).session
    const moves = current.state.legalMoves
    const move = current.state.pendingChoice ? moves.find(m => ['done', 'skip'].includes(m.optionId)) || moves[0]
      : ['hubGoSetup', 'hubAutoDeck', 'hubSelectInvestigator', 'hubDoneSeat', 'hubBeginScenario', 'hubSetLeader'].map(action => moves.find(m => m.action === action)).find(Boolean)
    assert.ok(move)
    const result = await hall.command('move', { revision: current.state.revision, move })
    assert.equal(result.ok, true, result.error)
  }
  const final = (await host.call('status')).session
  assert.deepEqual(final.players.map(p => p.role), ['human', 'human', 'ai'])
  assert.equal(final.state.uiState, 'inScenario')
  assert.notEqual(final.state.pendingChoice?.kind, 'mulligan')
  assert.deepEqual(final.state.investigators[2].hand, [])
  assert.ok(final.state.campaign.investigators[2].deckSize > 0)
})

test('Arkham four humans: preparation, choices, private tests, round transitions and reconnect', { ...arkham, timeout: 240000 }, async t => {
  const { halls, relay, relayUrl } = await fixture(t, 4)
  const created = await halls[0].call('create', { relayUrl, modId: 'arkhamhorror', capacity: 4, fillAi: false, settings: { seed: 'online-arkham-audit' } })
  assert.equal(created.ok, true, created.error)
  for (const hall of halls.slice(1)) {
    assert.equal((await hall.call('join', { relayUrl, code: created.room.code })).ok, true)
    await hall.call('ready', { ready: true })
  }
  assert.equal((await halls[0].command('start')).ok, true)
  const kinds = new Set(), actors = new Set(), actions = new Set()
  let help = false, privateTest = false, reconnected = false, peak = 0
  async function views() {
    const revision = (await halls[0].call('status')).session.state.revision
    await waitFor(async () => (await Promise.all(halls.map(h => h.call('status')))).every(v => v.session?.state.revision === revision))
    const sessions = await Promise.all(halls.map(async h => (await h.call('status')).session))
    for (const [seat, session] of sessions.entries()) {
      assert.equal(session.mySeat, seat)
      assert.equal(session.state.revision, revision)
      peak = Math.max(peak, Buffer.byteLength(JSON.stringify(session)))
      for (const inv of session.state.investigators) if (inv.seat !== seat) {
        assert.deepEqual(inv.hand, [])
        assert.deepEqual(inv.deck, [])
        assert.equal(session.state.campaign.investigators[inv.seat]?.deck, undefined)
      }
      for (const event of session.events) {
        assert.ok(event.privateSeat == null || event.privateSeat === seat)
        for (const inv of (event.tableState || event.presentation?.tableState)?.investigators || []) {
          if (inv.seat !== seat) assert.deepEqual(inv.hand, [])
        }
      }
      if (session.decisionSeat !== seat) assert.deepEqual(session.state.legalMoves, [])
    }
    return sessions
  }
  async function act(seat, move, sessions) {
    const revision = sessions[seat].state.revision
    const wrong = await halls[(seat + 1) % 4].command('move', { revision, move })
    assert.equal(wrong.ok, false, 'another player cannot answer this decision')
    const result = await halls[seat].command('move', { revision, move })
    assert.equal(result.ok, true, `${seat}: ${JSON.stringify(move)}: ${result.error}`)
    assert.equal(result.session.state.revision, revision + 1)
    actions.add(move.action); actors.add(seat)
    // Stay below the public relay's per-connection abuse limit while testing
    // four snapshot recipients and a rejected spoof before each real action.
    await new Promise(r => setTimeout(r, 350))
  }
  for (let step = 0; step < 240; step++) {
    const sessions = await views(), seat = sessions[0].decisionSeat
    const session = sessions[seat ?? 0], st = session.state, moves = st.legalMoves
    if (step % 20 === 0) console.log(`Arkham audit step=${step} round=${st.round} phase=${st.phase} choice=${st.pendingChoice?.kind} bytes=${peak}`)
    if (st.uiState === 'scenarioResult' || st.status !== 'playing') break
    assert.ok(moves.length, `no moves: ${st.uiState}/${st.phase}/${seat}`)
    let move
    if (st.pendingChoice) {
      kinds.add(st.pendingChoice.kind)
      if (st.skillTest && !st.skillTest.helpRequested) {
        privateTest = true
        for (const other of sessions.filter(s => s.mySeat !== st.skillTest.seat)) assert.equal(other.state.skillTest, null)
      }
      move = (!help && moves.find(m => m.optionId === 'help')) || moves.find(m => ['done', 'skip', 'pass', 'keep'].includes(m.optionId)) || moves[0]
      if (move.optionId === 'help') help = true
      if (!reconnected && seat > 0 && st.pendingChoice.kind === 'commit') {
        const port = relay.address().port
        await stop(relay)
        await waitFor(async () => (await Promise.all(halls.map(h => h.call('status')))).every(v => !v.connected))
        const replacement = createRelay({ secret: 'integration-test-secret' })
        await new Promise(r => replacement.listen(port, '127.0.0.1', r))
        t.after(() => stop(replacement))
        try {
          await waitFor(async () => (await Promise.all(halls.map(h => h.call('status')))).every(v => v.connected && v.room.members.every(m => m.online)), 15000)
        } catch (error) {
          console.log('Reconnect states', JSON.stringify(await Promise.all(halls.map(async h => { const v = await h.call('status'); return { connected: v.connected, error: v.error, members: v.room?.members, revision: v.session?.state.revision } }))))
          throw error
        }
        const resumed = await views()
        assert.equal(resumed[seat].state.pendingChoice.id, st.pendingChoice.id)
        assert.deepEqual(resumed[seat].state.legalMoves, moves)
        reconnected = true
      }
    } else if (st.uiState !== 'inScenario') {
      move = ['hubGoSetup', 'hubAutoDeck', 'hubSelectInvestigator', 'hubDoneSeat', 'hubBeginScenario', 'hubSetLeader']
        .map(a => moves.find(m => m.action === a)).find(Boolean)
    } else {
      move = (!help || !privateTest ? moves.find(m => m.action === 'investigate') : null)
        || moves.find(m => m.action === 'endTurn') || moves[0]
    }
    assert.ok(move)
    await act(seat, move, sessions)
  }
  assert.equal(actors.size, 4)
  assert.ok(help, 'another human was asked to help with a test')
  assert.ok(privateTest, 'private skill test was inspected')
  assert.ok(reconnected, 'relay restarted during a guest decision')
  assert.ok(kinds.has('commit'))
  let final = await views()
  assert.ok(final[0].state.round >= 4 || final[0].state.uiState === 'scenarioResult')
  assert.ok(peak < 2 * 1024 * 1024, 'historical animations must not keep growing the wire snapshot')
  if (final[0].state.uiState === 'scenarioResult') {
    for (let step = 0; step < 40 && final[0].state.uiState !== 'inScenario' && final[0].state.status === 'playing'; step++) {
      const seat = final[0].decisionSeat, st = final[seat].state, moves = st.legalMoves
      const move = st.pendingChoice ? moves.find(m => ['done', 'skip'].includes(m.optionId)) || moves[0]
        : ['hubContinue', 'hubAutoDeck', 'hubSelectInvestigator', 'hubDoneSeat', 'hubBeginScenario', 'hubSetLeader']
          .map(a => moves.find(m => m.action === a)).find(Boolean)
      assert.ok(move, 'campaign continuation must offer an actionable choice')
      await act(seat, move, final)
      final = await views()
    }
    assert.ok(actions.has('hubContinue'))
    assert.ok(final[0].state.uiState === 'inScenario' || final[0].state.status !== 'playing', 'interlude finishes for every human seat')
    assert.ok(final[0].state.campaign.scenarioResults.length > 0)
  }
  t.diagnostic(`choice kinds=${[...kinds]}; actions=${[...actions]}; peak snapshot=${peak} bytes; revision=${final[0].state.revision}`)
})
