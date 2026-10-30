import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRelay } from '../../relay/server.js'
import { createServer } from '../../lib/server.js'
import { gameVersions, relayAddress } from '../../lib/online.js'
import { snapshotPath } from '../../lib/sessions.js'
import {
  createOnlineFixture,
  listen,
  stop,
  waitFor as waitForOnline,
} from './helpers/online.mjs'

// 多人、私有信息、同时行动、批量确认与存档兼容统一用测试专用 Mod（tests/fixtures/mods/fixture-cards）验证；
// 具体游戏在联机层上的集成回归放在各自仓库（如 games/arkhamhorror/tests/hall-online.test.mjs）。
const CARDS = 'fixture-cards'
const waitFor = (check, timeout = 6000) => waitForOnline(check, timeout)

async function fixture(t, count = 2, persistHost = false) {
  return createOnlineFixture(t, {
    count,
    homePrefix: 'hall-online-',
    relayOptions: { secret: 'integration-test-secret' },
    persistHost,
  })
}

test('relay address accepts Render HTTPS and loopback development, rejects credentials and insecure remote hosts', () => {
  assert.equal(relayAddress('https://test.onrender.com'), 'wss://test.onrender.com/ws')
  assert.equal(relayAddress('http://127.0.0.1:1234'), 'ws://127.0.0.1:1234/ws')
  for (const url of ['http://example.com', 'wss://user:pass@example.com', 'file:///tmp/x', 'https://x.com?key=a']) assert.throws(() => relayAddress(url))
})

test('online compatibility uses manifest version numbers instead of file fingerprints', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-versions-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'index.js'), '// 第一版\n')
  const mods = [{ id: 'demo', package: { version: '1.2.3', dir } }]
  assert.deepEqual(gameVersions(mods), { demo: '1.2.3' })
  fs.writeFileSync(path.join(dir, 'index.js'), '// 只改注释，版本号不变\n')
  fs.writeFileSync(path.join(dir, 'extra.json'), '{"changed":true}')
  assert.deepEqual(gameVersions(mods), { demo: '1.2.3' }, '改游戏文件内容不应改变联机兼容性')
  assert.deepEqual(gameVersions([{ id: 'builtin' }, { id: 'odd', package: { version: 'dev' } }]), { builtin: '0.0.0', odd: '0.0.0' })
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
  assert.equal(chat.chat.error, undefined, '私聊真人不应报错')
  // 纯人类房间的公开聊天：只记录，不报「没有可对话的 AI 座位」
  const publicChat = await guest.command('chat', { text: '房间里的公开聊天' })
  assert.equal(publicChat.ok, true)
  assert.equal(publicChat.chat.error, undefined)
  assert.equal(publicChat.session.events.some(e => e.type === 'chat' && e.text === '房间里的公开聊天'), true)
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

test('debug console command is host-only, transactional, and rejected on the normal move path', async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: CARDS, capacity: 2, settings: { skipPrep: true, seed: 'debug' }, fillAi: false })
  assert.equal(created.ok, true, created.error)
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code })).ok, true)
  await guest.call('ready', { ready: true })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const session = started.session
  assert.equal(session.state.revision, 0)

  // 客人不能调用调试通道（即使 Mod 声明了 debugCommand）。
  const denied = await guest.command('debug', { revision: 0, command: { text: 'count 2' } })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /仅房主/)

  // 房主必须携带当前 revision。
  const stale = await host.command('debug', { revision: 9, command: { text: 'count 2' } })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'STALE_REVISION')

  // 房主调试指令：走事务提交，revision +1，返回 debug 消息与 move。
  const applied = await host.command('debug', { revision: 0, command: { text: 'count 2', targetSeat: 1 } })
  assert.equal(applied.ok, true, applied.error)
  assert.equal(applied.session.state.revision, 1)
  assert.equal(applied.session.state.debugTotal, 2)
  assert.equal(applied.debug.message, '调试计数 +2')
  assert.deepEqual(applied.debug.move, { action: 'debug', kind: 'count', amount: 2, targetSeat: 1 })
  assert.equal(applied.session.events.at(-1).type, 'move')

  // help 只回消息、不提交、不增加 revision。
  const help = await host.command('debug', { revision: 1, command: { text: 'help' } })
  assert.equal(help.ok, true, help.error)
  assert.equal(help.session.state.revision, 1)
  assert.equal(help.session.state.debugTotal, 2)
  assert.match(help.debug.message, /调试帮助/)

  // 普通行动通道（含客人伪造）不能夹带 debug 动作。
  const forged = await host.command('move', { revision: 1, move: { action: 'debug', kind: 'count', amount: 5 } })
  assert.equal(forged.ok, false)
  assert.equal(forged.code, 'DEBUG_ONLY')
  const guestForged = await guest.command('move', { revision: 1, move: { action: 'debug', kind: 'count', amount: 5 } })
  assert.equal(guestForged.ok, false)
  assert.equal((await host.call('status')).session.state.debugTotal, 2)
})

test('three human seats see only their own hands; private chat reaches only its participants', async t => {
  const { halls: [host, guest, third], relayUrl } = await fixture(t, 3)
  const created = await host.call('create', { relayUrl, modId: CARDS, capacity: 3, settings: { seed: 'three-seats' }, fillAi: false })
  assert.equal(created.ok, true, created.error)
  for (const hall of [guest, third]) {
    assert.equal((await hall.call('join', { relayUrl, code: created.room.code })).ok, true)
    await hall.call('ready', { ready: true })
  }
  const start = await host.command('start')
  assert.equal(start.ok, true, start.error)
  await waitFor(async () => (await third.call('status')).session)
  const other = (await third.call('status')).session
  assert.equal(other.mySeat, 2)
  assert.deepEqual(other.players.map(p => p.role), ['human', 'human', 'human'])
  assert.deepEqual(other.settings, {}, 'room settings are not projected to guests')
  assert.equal(other.state.hands[2].length, 4)
  assert.deepEqual(other.state.hands[0], [])
  assert.deepEqual(other.state.hands[1], [])
  assert.deepEqual(other.state.deck, [])
  await guest.command('chat', { text: '仅第二和第三位可见', to: 2 })
  await waitFor(async () => (await third.call('status')).session.events.some(e => e.text === '仅第二和第三位可见'))
  assert.equal((await host.call('status')).session.events.some(e => e.text === '仅第二和第三位可见'), false)
  const session = (await host.call('status')).session
  assert.ok(session.state.legalMoves.length > 0)
  const moved = await host.command('move', { revision: session.state.revision, move: session.state.legalMoves[0] })
  assert.equal(moved.ok, true, moved.error)
})

test('simultaneous phases accept stale seat-local moves but keep teammates\' picks and later team decisions strict', async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: CARDS, capacity: 2, settings: { seed: 'concurrent' }, fillAi: false })
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code })).ok, true)
  await guest.call('ready', { ready: true })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const seen = await waitFor(async () => {
    const view = (await guest.call('status')).session
    return view?.state.revision === started.session.state.revision && view
  })
  assert.deepEqual(seen.actingSeats, [0, 1])
  const picks = seen.state.legalMoves.filter(move => move.action === 'pick')
  assert.ok(picks.length > 1, 'guest can choose while the host is still preparing')
  const stale = seen.state.revision
  const [hostPick, guestPick] = picks
  assert.equal((await host.command('move', { revision: stale, move: hostPick })).ok, true)
  assert.equal((await guest.command('move', { revision: stale, move: hostPick })).ok, false, 'a teammate’s pick is reserved')
  const picked = await guest.command('move', { revision: stale, move: guestPick })
  assert.equal(picked.ok, true, picked.error)
  assert.equal(picked.session.state.roles[1], guestPick.role)
  const guestReady = await guest.command('move', { revision: stale, move: { action: 'ready' } })
  assert.equal(guestReady.ok, true, guestReady.error)
  const afterGuest = (await host.call('status')).session
  assert.deepEqual(afterGuest.actingSeats, [0])
  assert.equal(afterGuest.state.phase, 'prep')
  const done = await host.command('move', { revision: afterGuest.state.revision, move: { action: 'ready' } })
  assert.equal(done.ok, true, done.error)
  assert.equal(done.session.state.phase, 'play')
  assert.deepEqual(done.session.actingSeats, [0])
  const late = await guest.command('move', { revision: stale, move: { action: 'pick', role: guestPick.role } })
  assert.equal(late.ok, false, 'decisions outside the simultaneous phase keep strict revisions and seat ownership')
})

test('a batch of staged choices commits atomically in one online command', async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: CARDS, capacity: 2, settings: { skipPrep: true, seed: 'batch' }, fillAi: false })
  assert.equal(created.ok, true, created.error)
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code })).ok, true)
  await guest.call('ready', { ready: true })
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const before = started.session
  assert.equal(before.state.pendingChoice?.kind, 'swap')
  const hand = before.state.hands[0]
  const batchChoices = { choiceId: before.state.pendingChoice.id, kind: 'swap',
    selected: [{ index: 0, code: hand[0] }, { index: 2, code: hand[2] }], finish: 'done' }
  const forged = await host.command('move', { revision: before.state.revision,
    batchChoices: { ...batchChoices, selected: [{ index: 0, code: hand[0] }, { index: 2, code: 'forged' }] } })
  assert.equal(forged.ok, false)
  assert.equal((await host.call('status')).session.state.revision, before.state.revision, 'a rejected batch commits nothing')
  const invalidFinish = await host.command('move', { revision: before.state.revision, batchChoices: { ...batchChoices, finish: 'help' } })
  assert.equal(invalidFinish.ok, false)
  assert.equal((await host.call('status')).session.state.revision, before.state.revision, 'a failed final confirmation rolls back earlier valid steps')
  const confirmed = await host.command('move', { revision: before.state.revision, batchChoices })
  assert.equal(confirmed.ok, true, confirmed.error)
  assert.equal(confirmed.session.state.revision, before.state.revision + 3)
  assert.equal(confirmed.session.state.pendingChoice?.seat, 1)
  assert.notDeepEqual(confirmed.session.state.hands[0], hand)
  await waitFor(async () => (await guest.call('status')).session?.state.revision === confirmed.session.state.revision)
  assert.deepEqual((await guest.call('status')).session.state.hands[0], [], 'other players still cannot see the new hand')
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

for (const modId of ['ox', CARDS]) test(`${modId}: host process restart restores saved game and authenticated room; guest can leave and return`, async t => {
  const { halls: [initial, guest], relayUrl, mods } = await fixture(t)
  await stop(initial.server)
  const hostServer = createServer({ mods, persist: true }); await hostServer.ready
  const hostUrl = await listen(hostServer)
  const call = async (origin, route, body) => (await fetch(origin + '/api/online/' + route, {
    method: body ? 'POST' : 'GET', headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json()
  const created = await call(hostUrl, 'create', { relayUrl, modId, capacity: 2, fillAi: false,
    settings: { skipPrep: true, seed: 'online-persistent-choice' } })
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
  if (modId === CARDS) {
    assert.equal(returned.state.pendingChoice.id, before.state.pendingChoice.id)
    assert.deepEqual(returned.state.hands[1], before.state.hands[1])
    assert.deepEqual(returned.state.hands[0], [])
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
  const created = await host.rpc({ type: 'create', name: '房主', capacity: 2, hallVersion: '0.1.2', game: { id: 'ox', name: '井字棋', version: '1.0.0' } })
  const room = created.data.room
  assert.equal(room.hallVersion, '0.1.2')
  assert.equal((await guest.rpc({ type: 'join', code: room.code, hallVersion: '0.1.2', versions: { ox: '1.0.1' } })).ok, false, 'game version must match')
  assert.equal((await guest.rpc({ type: 'join', code: room.code, hallVersion: '0.1.3', versions: { ox: '1.0.0' } })).ok, false, 'hall version must match')
  const joined = await guest.rpc({ type: 'join', code: room.code, hallVersion: '0.1.2', versions: { ox: '1.0.0' } })
  assert.equal(joined.ok, true)
  await stranger.rpc({ type: 'create', capacity: 2, hallVersion: '0.1.2', game: { id: 'ox', name: '其他房间', version: '1.0.0' } })
  // 旧版大厅不上报大厅版本号：这类房间仍只比较游戏版本号，新版中转不会挡住旧客户端。
  const legacyHost = await client(), legacyGuest = await client()
  const legacyRoom = (await legacyHost.rpc({ type: 'create', capacity: 2, game: { id: 'ox', name: '旧版房间', version: '1.0.0' } })).data.room
  assert.equal(legacyRoom.hallVersion, null)
  assert.equal((await legacyGuest.rpc({ type: 'join', code: legacyRoom.code, versions: { ox: '1.0.0' } })).ok, true)
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

test('relay reports each player ping without a room refresh, and a dropped socket is offline', async t => {
  const relay = createRelay(), url = await listen(relay), clients = []
  t.after(async () => { for (const client of clients) client.socket.close(); await stop(relay) })
  async function client() {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws'), messages = [], pending = new Map()
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data); messages.push(data)
      if (data.type === 'result') { pending.get(data.id)?.(data); pending.delete(data.id) }
    })
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
    const rpc = data => new Promise(resolve => { const id = randomUUID(); pending.set(id, resolve); socket.send(JSON.stringify({ ...data, id })) })
    const value = { socket, messages, rpc }; clients.push(value); return value
  }
  const host = await client(), guest = await client()
  const created = await host.rpc({ type: 'create', name: '房主', capacity: 2, hallVersion: '0.1.2', game: { id: 'ox', name: '井字棋', version: '1.0.0' } })
  assert.equal(created.ok, true, created.error)
  const joined = await guest.rpc({ type: 'join', code: created.data.room.code, name: '客人', hallVersion: '0.1.2', versions: { ox: '1.0.0' } })
  assert.equal(joined.ok, true, joined.error)
  const roomsBeforePing = host.messages.filter(message => message.type === 'room').length
  await waitFor(() => host.messages.some(message => message.type === 'presence'
    && message.members.length === 2 && message.members.every(member => Number.isInteger(member.ping) && member.ping >= 0 && member.ping <= 9999)))
  assert.equal(host.messages.filter(message => message.type === 'room').length, roomsBeforePing, '延迟更新不能走 room 广播')
  guest.socket.close()
  await waitFor(() => host.messages.some(message => message.type === 'room' && message.room.members.some(member => member.online === false && member.ping === null)))
})

test('hall status shows every member ping without republishing the match', async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t, 2)
  const created = await host.call('create', { relayUrl, modId: 'ox', capacity: 2, fillAi: false })
  assert.equal(created.ok, true, created.error)
  assert.equal((await guest.call('join', { relayUrl, code: created.room.code })).ok, true)
  assert.equal((await guest.call('ready', { ready: true })).ok, true)
  const started = await host.command('start')
  assert.equal(started.ok, true, started.error)
  const revision = started.session.state.revision
  await waitFor(async () => {
    const status = await host.call('status')
    return status.room.members.length === 2 && status.room.members.every(member => Number.isInteger(member.ping))
  })
  const after = await host.call('status')
  assert.equal(after.session.state.revision, revision)
  assert.ok(after.room.members.every(member => member.ping >= 0 && member.ping <= 9999))
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

test('online chat: @定向、@全体、/备忘 与备忘可见性', async t => {
  // 联机讨论需要模型；用一个本地 stub 代替真实后端。
  const stub = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload = null
      try { payload = JSON.parse(body) } catch { /* 忽略 */ }
      const system = payload && payload.messages && payload.messages[0] ? String(payload.messages[0].content) : ''
      const content = system.includes('记忆整理助手') ? '{"notes":[]}'
        : system.includes('【讨论规则】') ? '{"reply":"收到，我这就去。","memory":{"add":[],"update":[],"remove":[]}}'
          : '{"action":"ready","speech":"ok"}'
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'stub' }))
    })
  })
  const stubUrl = await new Promise((resolve) => stub.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + stub.address().port)))
  const savedEnv = Object.fromEntries(['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_JSON_MODE', 'AI_CHAT_REPLY_COOLDOWN_MS']
    .map((key) => [key, process.env[key]]))
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_BASE_URL = stubUrl
  process.env.AI_MODEL = 'stub'
  process.env.AI_JSON_MODE = 'off'
  process.env.AI_CHAT_REPLY_COOLDOWN_MS = '0'
  try {
    const { halls: [host, guest], relayUrl } = await fixture(t, 2)
    const created = await host.call('create', {
      relayUrl, modId: CARDS, capacity: 4, fillAi: false,
      aiSeats: [{ seat: 2, aiId: 'ai-hu' }, { seat: 3, aiId: 'ai-ling' }],
      settings: { seed: 'online-chat' },
    })
    assert.equal(created.ok, true, created.error)
    assert.equal((await guest.call('join', { relayUrl, code: created.room.code })).ok, true)
    await guest.call('ready', { ready: true })
    const start = await host.command('start')
    assert.equal(start.ok, true, start.error)
    await waitFor(async () => (await guest.call('status')).session)
    const session = (await guest.call('status')).session
    const ais = session.players.filter((p) => p.role === 'ai')
    assert.deepEqual(ais.map((p) => p.seat), [2, 3])
    const nameOf = (seat) => ais.find((p) => p.seat === seat).name
    const lastReplies = (data, count) => (data.session.events || [])
      .filter((event) => event.type === 'chat' && event.seat !== 0 && event.seat !== 1)
      .slice(-count).map((event) => event.seat)

    // @单个队友：只有该 AI 回复，且公开可见
    const single = await guest.command('chat', { text: '@' + nameOf(2) + ' 你先看牌' })
    assert.equal(single.ok, true, single.error)
    assert.deepEqual(single.chat.replies.map((item) => item.seat), [2])
    assert.deepEqual(lastReplies(single, 1), [2])

    // @全体：所有 AI 座位都回复
    const all = await guest.command('chat', { text: '@全体 报一下手牌数' })
    assert.deepEqual(all.chat.replies.map((item) => item.seat).sort(), [2, 3])
    assert.deepEqual(lastReplies(all, 2).sort(), [2, 3])

    // 公开 /备忘：队伍备忘，房主也能看到
    const note = await guest.command('chat', { text: '/备忘 先看队友手牌再决定' })
    assert.equal(note.chat.command.name, 'note')
    assert.equal(note.chat.replies.length, 0)
    assert.equal(note.session.notes.length, 1)
    assert.equal(note.session.notes[0].scope, 'team')
    await waitFor(async () => (await host.call('status')).session.notes.length === 1)

    // 私聊 /备忘：只给发起私聊的成员看
    const priv = await guest.command('chat', { text: '/备忘 别把牌给第三席看', to: 2 })
    assert.equal(priv.chat.command.scope, 'seat')
    assert.equal(priv.session.notes.length, 2)
    assert.equal(priv.session.notes.some((item) => item.scope === 'seat'), true)
    await waitFor(async () => (await guest.call('status')).session.notes.length === 2)
    // 房主依旧只看得到队伍备忘（等一个发布节拍再断言）
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal((await host.call('status')).session.notes.length, 1, '私聊备忘不得泄漏给其他成员')

    // 私聊真人不能写备忘
    const toHuman = await guest.command('chat', { text: '/备忘 这句话应该被拒绝', to: 0 })
    assert.equal(toHuman.ok, true)
    assert.match(String(toHuman.chat.error || ''), /AI 队友/)

    // /清除备忘 只清掉自己看得见的（这里两条都在 guest 视野内）
    const cleared = await guest.command('chat', { text: '/清除备忘' })
    assert.equal(cleared.chat.notesRemoved, 2)
    assert.deepEqual(cleared.session.notes, [])
    await waitFor(async () => (await host.call('status')).session.notes.length === 0)
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise((resolve) => { stub.closeAllConnections(); stub.close(resolve) })
  }
})

test('reserved AI seats survive relay restart, block joins, and preserve the chosen AI identities', async t => {
  const { halls: [host, guest, extra], relay, relayUrl } = await fixture(t, 3)
  for (const aiSeats of [[{ seat: 0 }], [{ seat: 4 }], [{ seat: 1 }, { seat: 1 }]]) {
    assert.equal((await host.call('create', { relayUrl, modId: CARDS, capacity: 4, aiSeats })).ok, false)
  }
  const created = await host.call('create', { relayUrl, modId: CARDS, capacity: 4,
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
  assert.deepEqual(started.session.actingSeats, [0, 2], 'AI seats finish the simultaneous phase on their own')
})

test('reserved AI seats deduplicate duplicate picks and random picks before the room opens', async t => {
  const { halls: [host], relayUrl } = await fixture(t)
  const created = await host.call('create', {
    relayUrl, modId: CARDS, capacity: 4,
    aiSeats: [{ seat: 1, aiId: 'ai-hu' }, { seat: 3, aiId: 'ai-hu' }, { seat: 2 }],
  })
  assert.equal(created.ok, true, created.error)
  const names = created.room.aiSeats.map(item => item.name)
  assert.equal(names.length, 3)
  assert.equal(new Set(names).size, names.length, 'AI 席位不能出现同名角色')
  const status = await host.call('status')
  assert.deepEqual(status.room.aiSeats, created.room.aiSeats, '重连/状态刷新不能改掉已分好的角色')
})

test('online saves reopen as joinable rooms and preserve seats, private state and pending choices', async t => {
  const { halls: [host, guest, third], relayUrl, mods } = await fixture(t, 3, true)
  const local = async (route, body) => (await fetch(host.origin + '/api/' + route, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })).json()
  const solo = await local('start', { modId: 'ox', settings: { opponents: ['ai-hu'] } })
  assert.equal(solo.ok, true, solo.error)
  assert.equal((await host.call('load', { relayUrl, sessionId: solo.session.sessionId })).ok, false)
  const created = await host.call('create', { relayUrl, modId: CARDS, capacity: 4,
    aiSeats: [{ seat: 2, aiId: 'ai-hu' }], settings: { skipPrep: true, seed: 'load-online-save' } })
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
  assert.deepEqual(after.state.hands[0], [])
  assert.equal((await third.command('move', { revision: 1, move: after.state.legalMoves.find(m => m.optionId === 'done') })).ok, true)
})

test('status updates wake immediately and host operations use the local authority', async t => {
  const { halls: [host, guest], relayUrl } = await fixture(t)
  const created = await host.call('create', { relayUrl, modId: CARDS, capacity: 2, aiSeats: [] })
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
  // P1.3 起 metrics.fullBytes 只在 BOARDGAME_PERF=1 时统计；这里用同一份客人视图估算
  // 「如果每次变化都发全量」的体积，断言实际下行远小于它（增量生效）。
  const guestView = (await guest.call('status')).session
  const full = Buffer.byteLength(JSON.stringify(guestView))
  assert.ok(bytes < full / 10, `delta ${bytes} versus full ${full}`)
  t.diagnostic(`chat snapshot payload: ${bytes} bytes versus ${full} bytes without deltas`)
})
