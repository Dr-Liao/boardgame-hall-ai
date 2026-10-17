import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../lib/server.js'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => {
  server.closeAllConnections()
  server.close(resolve)
})

test('规则事件可触发只读 AI 回应，普通行动发言遵循频率', { timeout: 10000 }, async () => {
  const keys = ['DSH_HOME', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MAX_RETRIES', 'AI_TIMEOUT_MS']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-agent-reactions-'))
  process.env.DSH_HOME = home
  process.env.AI_API_KEY = 'stub-key'
  process.env.AI_MAX_RETRIES = '1'
  process.env.AI_TIMEOUT_MS = '3000'

  const requests = []
  const model = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body)
      requests.push(payload)
      const reaction = payload.messages[0].content.includes('【回应边界】')
      const content = reaction
        ? JSON.stringify({ reply: '这次检定成功，局面稳住了。' })
        : JSON.stringify({ move: { action: 'aiMove' }, speech: '这句日常台词不应显示。' })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })

  const mod = {
    id: 'reaction-test', name: '回应测试', description: '测试规则事件回应',
    players: [3, 3], seats: 3, cooperative: true,
    moveFormat: '{"action":"aiMove"}',
    defaults: { opponents: [null, null] },
    createState: () => ({ status: 'playing', currentSeat: 0, revision: 0, moveCount: 0, seed: 'reaction-seed' }),
    decisionSeat: state => state.currentSeat,
    describeState: state => `当前座位 ${state.currentSeat}`,
    legalMoves: state => state.currentSeat === 1 ? [{ action: 'aiMove' }] : [{ action: 'humanMove' }],
    moveToText: move => move.action,
    validateMove: (state, seat, move) => (
      seat === 0 && move?.action === 'humanMove'
        ? null
        : seat === 1 && move?.action === 'aiMove' ? null : '非法行动'
    ),
    applyMove(state, seat) {
      state.moveCount++
      state.currentSeat = seat === 0 ? 1 : 0
      return seat === 0
        ? [{ type: 'presentation', kind: 'test', seat: 0, name: '玩家', success: true }]
        : []
    },
    agentActionSpeechFrequency: () => 0,
    agentReactionTriggers: ({ events, revision }) => events.some(event => event.kind === 'test')
      ? [{ key: `test:${revision}`, kind: 'test.result', title: '检定结果',
          context: 'AI 自身的检定成功。', frequencyByRole: { self: 100, other: 0 },
          subjectSeat: 1, audience: 'all' }]
      : [],
  }

  let hall
  try {
    await listen(model)
    process.env.AI_BASE_URL = `http://127.0.0.1:${model.address().port}`
    hall = createServer({ mods: [mod], persist: false })
    await hall.ready
    await listen(hall)
    const base = `http://127.0.0.1:${hall.address().port}`
    const post = async (url, body) => {
      const response = await fetch(base + url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await response.json()
      assert.equal(response.status, 200, data.error)
      assert.equal(data.ok, true, data.error)
      return data
    }
    let session = (await post('/api/start', {
      modId: mod.id, settings: { opponents: [null, null] },
    })).session
    session = (await post('/api/move', {
      sessionId: session.sessionId, revision: session.state.revision, move: { action: 'humanMove' },
    })).session

    assert.equal(requests.length, 2, '一次事件回应加一次 AI 行动')
    assert.ok(requests[0].messages[0].content.includes('【回应边界】'))
    assert.ok(requests[0].messages[1].content.includes('AI 自身的检定成功'))
    assert.equal(session.events.filter(event => event.origin === 'reaction').length, 1)
    assert.equal(session.events.find(event => event.origin === 'reaction').text, '这次检定成功，局面稳住了。')
    assert.equal(session.events.find(event => event.origin === 'reaction').seat, 1, '自身 100%，其他角色 0%')
    assert.equal(session.events.filter(event => event.origin === 'action').length, 0)
    assert.equal(session.events.filter(event => event.type === 'speech').length, 0)
    assert.equal(session.state.currentSeat, 0)
  } finally {
    if (hall) await close(hall)
    await close(model)
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
})
