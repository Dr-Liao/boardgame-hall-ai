import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../lib/server.js'
import { loadModFrom, modCandidates } from '../../../lib/mods.js'

test('玩家出牌和每席 AI 行动逐步可见，AI 发言进入公开桌聊', { timeout: 15000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-poker-turn-'))
  const previous = process.env.DSH_HOME
  const previousKey = process.env.AI_API_KEY
  process.env.DSH_HOME = home
  delete process.env.AI_API_KEY
  const poker = await loadModFrom(modCandidates({ userDir: null }).find(candidate => candidate.id === 'poker'))
  const server = createServer({ mods: [poker], persist: false })
  await server.ready
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (previousKey === undefined) delete process.env.AI_API_KEY
    else process.env.AI_API_KEY = previousKey
    fs.rmSync(home, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}/api`
  const rulesResponse = await fetch(base.replace(/\/api$/, '/mods/poker/rules.js'))
  assert.equal(rulesResponse.status, 200, '浏览器应能加载与服务端相同的牌型规则')
  const call = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return response.json()
  }
  const started = await call('/start', { modId: 'poker', settings: { opponents: ['__random__', '__random__', '__random__'] } })
  assert.equal(started.ok, true, started.error)
  const session = started.session
  const card = session.state.hands[0][0]
  const request = call('/move', { sessionId: session.sessionId, revision: session.state.revision,
    move: { action: 'play', cards: [card.id] } })
  const observed = []
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const snapshot = await call('/session?sessionId=' + session.sessionId)
    const state = snapshot.session.state
    if (!observed.some(item => item.revision === state.revision)) observed.push({
      revision: state.revision, seat: state.currentSeat, tableSeat: state.table?.seat,
      moves: snapshot.session.events.filter(event => event.type === 'move').length,
    })
    if (state.currentSeat === 0 && state.revision >= session.state.revision + 4) break
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  const result = await request
  assert.equal(result.ok, true, result.error)
  assert.ok(observed.some(item => item.moves === 1 && item.tableSeat === 0), '玩家出牌应在 AI 行动前落桌')
  assert.ok(observed.some(item => item.moves === 2), '第一席 AI 行动应单独可见')
  assert.ok(observed.some(item => item.moves === 3), '第二席 AI 行动应单独可见')
  const aiMoves = result.session.events.filter(event => event.type === 'move' && event.seat !== 0)
  const publicChat = result.session.events.filter(event => event.type === 'chat' && event.origin === 'action' && event.to === null)
  assert.ok(aiMoves.length >= 3)
  assert.equal(publicChat.length, aiMoves.length)
  assert.ok(publicChat.every(event => event.text))
})
