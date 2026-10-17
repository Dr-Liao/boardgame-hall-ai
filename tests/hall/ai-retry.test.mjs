import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../lib/server.js'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
const mod = {
  id: 'retry-test', name: 'Retry test', players: [2, 2], seats: 2,
  cooperative: true, moveFormat: '{"action":"step"}',
  createState: () => ({ status: 'playing', currentSeat: 0, revision: 0, done: 0 }),
  describeState: state => `已完成 ${state.done} 步`,
  moveToText: () => '完成一步',
  legalMoves: () => [{action: 'step'}],
  validateMove: (state, seat, move) => move.action === 'step' ? null : 'invalid',
  applyMove(state, seat) {
    if (seat === 0) state.currentSeat = 1
    else if (++state.done === 3) state.currentSeat = 0
    return [{type: 'move', seat, move: {action: 'step'}}]
  },
}

test('HTTP AI recovery is bounded, retains progress, and prevents duplicate runners', {timeout: 20000}, async t => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AI_') || key === 'DSH_HOME'))
  for (const key of Object.keys(saved)) delete process.env[key]
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-ai-retry-'))
  process.env.DSH_HOME = home
  process.env.AI_API_KEY = 'stub-key'
  let behavior = () => true
  const seen = []
  const model = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer stub-key')
      const payload = JSON.parse(body)
      seen.push(payload)
      if (!behavior(payload, seen.length)) return // Deliberate stalled request; client must abort it.
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({choices: [{message: {content: '{"move":{"action":"step"},"speech":"ok"}'}}]}))
    })
  })
  let hall
  try {
    await listen(model)
    process.env.AI_BASE_URL = `http://127.0.0.1:${model.address().port}`
    hall = createServer({mods: [mod], persist: false})
    await hall.ready
    await listen(hall)
    const base = `http://127.0.0.1:${hall.address().port}`
    const call = async (route, body) => {
      const response = await fetch(base + route, body === undefined ? {} : {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
      })
      return {status: response.status, ...await response.json()}
    }
    const configure = patch => call('/api/config', {timeoutMs: 300, turnTimeoutMs: 300,
      maxRetries: 20, maxTurnCalls: 24, ...patch})
    const start = async () => {
      const result = await call('/api/start', {modId: mod.id, settings: {opponents: ['__random__']}})
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.session
    }
    const move = s => call('/api/move', {sessionId: s.sessionId, revision: s.state.revision, move: {action: 'step'}})

    await t.test('timeout after a committed action resumes only the remaining actions', async () => {
      await configure({})
      seen.length = 0
      behavior = (_, count) => count !== 2
      const s = await start()
      const pending = move(s)
      let snapshot
      for (let i = 0; i < 100; i++) {
        snapshot = await call('/api/session?sessionId=' + s.sessionId)
        if (snapshot.session.events.some(e => e.type === 'agentRetry')) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(snapshot.session.events.some(e => e.type === 'agentRetry'))
      assert.equal(snapshot.busy, true)
      assert.equal(snapshot.session.state.done, 1)
      assert.equal((await call('/api/ai/retry', {sessionId: s.sessionId, revision: snapshot.session.state.revision})).code, 'SESSION_BUSY')
      assert.equal((await call('/api/session/load', {sessionId: s.sessionId})).code, 'SESSION_BUSY')
      const result = await pending
      assert.equal(result.status, 200)
      assert.equal(result.session.state.done, 3)
      assert.equal(result.session.state.revision, 4)
      assert.equal(result.session.events.filter(e => e.type === 'move' && e.seat === 1).length, 3)
      assert.equal(result.session.events.filter(e => e.type === 'agentRetry').length, 1)
      assert.ok(seen[2].messages.some(m => m.content.includes('本回合你已经行动过 1 步')))
      assert.ok(seen[2].messages.some(m => m.content.includes('已完成 1 步')))
    })

    await t.test('repeated timeouts stop after two recoveries, then explicit retry resumes the same revision', async () => {
      await configure({})
      seen.length = 0
      behavior = () => false
      const s = await start()
      const result = await move(s)
      assert.equal(result.status, 502)
      assert.equal(result.code, 'AGENT_STALLED')
      assert.match(result.error, /自动重试已达上限/)
      assert.equal(result.session.events.filter(e => e.type === 'agentRetry').length, 2)
      assert.equal(result.session.state.done, 0)
      assert.equal(result.session.state.revision, 1)
      assert.ok(seen.length <= 6, 'failed requests must not run indefinitely')
      const idle = await call('/api/session?sessionId=' + s.sessionId)
      assert.equal(idle.busy, false)
      assert.equal((await call('/api/ai/retry', {sessionId: s.sessionId, revision: 0})).code, 'STALE_REVISION')
      behavior = () => true
      const resumed = await call('/api/ai/retry', {sessionId: s.sessionId, revision: 1})
      assert.equal(resumed.status, 200)
      assert.equal(resumed.session.state.done, 3)
      assert.equal(resumed.session.state.revision, 4)
      assert.equal((await call('/api/ai/retry', {sessionId: s.sessionId, revision: 4})).code, 'WRONG_SEAT')
    })

    await t.test('call-budget recovery also retains earlier decisions without replaying them', async () => {
      await configure({maxTurnCalls: 1, turnTimeoutMs: 5000})
      seen.length = 0
      behavior = () => true
      const s = await start()
      const result = await move(s)
      assert.equal(result.status, 200)
      assert.equal(result.session.state.done, 3)
      assert.equal(seen.length, 3)
      assert.deepEqual(result.session.events.filter(e => e.type === 'agentRetry').map(e => e.reason), ['turn-budget', 'turn-budget'])
      assert.ok(seen[2].messages.some(m => m.content.includes('本回合你已经行动过 2 步')))
    })
  } finally {
    if (hall) await close(hall)
    await close(model)
    for (const key of Object.keys(process.env)) if (key.startsWith('AI_') || key === 'DSH_HOME') delete process.env[key]
    Object.assign(process.env, saved)
    assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(home, {recursive: true, force: true})
  }
})
