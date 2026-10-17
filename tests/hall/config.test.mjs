// 模型配置高级参数回归：GET 下发、POST 持久化、非法数值拒绝。
//
// 运行：npm run test:hall

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import gobang from '../../games/gobang/index.js'
import { createServer } from '../../lib/server.js'
import { loadConfig } from '../../lib/agent/config.js'
import { buildUserPrompt, buildChatUserPrompt } from '../../lib/agent/prompt.js'

const ENV_KEYS = [
  'DSH_HOME',
  'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_TEMPERATURE', 'AI_TOP_P', 'AI_MAX_RETRIES',
  'AI_TIMEOUT_MS', 'AI_MAX_TOKENS', 'AI_MAX_TURN_CALLS', 'AI_JSON_MODE', 'AI_TURN_TIMEOUT_MS',
  'AI_MAX_PROMPT_TOKENS', 'AI_MEMORY_STEPS', 'AI_CHAT_ENABLED', 'AI_CHAT_NOTES_MAX',
  'AI_CHAT_MAX_CHARS', 'AI_CHAT_WINDOW',
]

async function call(base, method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* 保留 null */ }
  return { status: res.status, data }
}

test('模型配置高级参数：界面可读写并持久化', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-config-'))
  const savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.DSH_HOME = home

  const server = createServer({ mods: [gobang], persist: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await server.ready
  const base = 'http://127.0.0.1:' + server.address().port

  t.after(async () => {
    await new Promise((resolve) => {
      if (!server.listening) return resolve()
      server.closeAllConnections()
      server.close(() => resolve())
    })
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  const initial = await call(base, 'GET', '/api/config')
  assert.equal(initial.status, 200)
  assert.equal(initial.data.ok, true)
  assert.equal(initial.data.playerName, 'player')
  assert.equal(initial.data.playerAvatar, '👤')
  assert.equal(initial.data.model, 'deepseek-flash')
  assert.equal(initial.data.maxTokens, 10000)
  const start = () => call(base, 'POST', '/api/start', {
    modId: 'gobang', settings: { opponents: ['__random__'], firstMove: 'player' },
  })
  assert.equal((await start()).data.session.players[0].name, 'player')
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
  assert.equal((await call(base, 'POST', '/api/config', { playerAvatar: avatar })).data.playerAvatar, avatar)
  assert.equal(loadConfig().playerAvatar, avatar, '头像写入配置，重新读取仍保留')
  const avatarSession = (await start()).data.session
  assert.equal(avatarSession.players[0].avatar, avatar)
  for (const invalidAvatar of [null, {}, 42, 'blob:temporary', 'https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,!!', 'data:image/png;base64,' + 'A'.repeat(700000)]) {
    assert.equal((await call(base, 'POST', '/api/config', { playerAvatar: invalidAvatar, playerName: '不应写入' })).status, 400)
    assert.equal(loadConfig().playerAvatar, avatar)
    assert.equal(loadConfig().playerName, 'player', '非法头像不能部分保存资料')
  }
  await call(base, 'POST', '/api/config', { playerName: 'player' })
  assert.equal(loadConfig().playerAvatar, avatar, '仅保存名字时保留头像')
  assert.equal((await call(base, 'POST', '/api/config', { playerAvatar: '' })).data.playerAvatar, '👤')
  const retained = await call(base, 'GET', '/api/session?sessionId=' + avatarSession.sessionId)
  assert.equal(retained.data.session.players[0].avatar, avatar, '已有对局保留原头像')
  const resetAvatar = await call(base, 'POST', '/api/reset', { sessionId: avatarSession.sessionId })
  assert.equal(resetAvatar.data.session.players[0].avatar, '👤', '重开使用最新头像')
  const renamed = await call(base, 'POST', '/api/config', { playerName: '  星河  ' })
  assert.equal(renamed.data.playerName, '星河')
  assert.equal(loadConfig().playerName, '星河', '重新加载配置仍保留名字')
  const namedSession = (await start()).data.session
  assert.equal(namedSession.players[0].name, '星河')
  assert.match(buildUserPrompt(gobang, namedSession, 1), /星河/)
  assert.match(buildChatUserPrompt(gobang, namedSession, 1, '你好', 'table'), /星河/,
    '即使没有历史消息，战术聊天也知道玩家名字')
  namedSession.events.push({ type: 'chat', seat: 0, to: null, text: '走中路', seq: 99 })
  assert.match(buildChatUserPrompt(gobang, namedSession, 1, '你好', 'table'), /星河：走中路/)
  const coop = { ...gobang, cooperative: true, participantDescription: (state, seat) => state.characters?.[seat]?.name }
  namedSession.state.characters = [{ name: '罗兰' }]
  assert.match(buildUserPrompt(coop, namedSession, 1), /星河.*真人玩家.*罗兰/)
  assert.match(buildChatUserPrompt(coop, namedSession, 1, '你好', 'table'), /星河.*真人玩家.*罗兰/)
  assert.equal((await call(base, 'POST', '/api/config', { playerName: {} })).status, 400)
  assert.equal(loadConfig().playerName, '星河')
  assert.equal((await call(base, 'POST', '/api/config', { playerName: '名'.repeat(40) })).data.playerName, '名'.repeat(32))
  assert.equal((await call(base, 'POST', '/api/config', { playerName: ' \n\t ' })).data.playerName, 'player')
  assert.equal((await start()).data.session.players[0].name, 'player')
  const oldSession = await call(base, 'GET', '/api/session?sessionId=' + namedSession.sessionId)
  assert.equal(oldSession.data.session.players[0].name, '星河', '已有对局保留原名称')
  const reset = await call(base, 'POST', '/api/reset', { sessionId: namedSession.sessionId })
  assert.equal(reset.data.session.players[0].name, 'player', '重开使用最新名称')
  for (const key of [
    'temperature', 'timeoutMs', 'topP', 'maxRetries', 'maxTokens', 'maxTurnCalls',
    'jsonMode', 'turnTimeoutMs', 'maxPromptTokens', 'memorySteps', 'chatEnabled',
    'chatNotesMax', 'chatMaxChars', 'chatWindow',
  ]) {
    assert.equal(Object.hasOwn(initial.data, key), true, 'GET /api/config 必须下发 ' + key)
  }

  const saved = await call(base, 'POST', '/api/config', {
    temperature: 0.25,
    topP: 0.8,
    maxRetries: 5,
    timeoutMs: 30000,
    maxTokens: 1024,
    maxTurnCalls: 12,
    jsonMode: 'off',
    turnTimeoutMs: 90000,
    maxPromptTokens: 65536,
    memorySteps: 3,
    chatEnabled: false,
    chatNotesMax: 20,
    chatMaxChars: 800,
    chatWindow: 10,
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  assert.equal(saved.data.ok, true)
  assert.equal(saved.data.temperature, 0.25)
  assert.equal(saved.data.topP, 0.8)
  assert.equal(saved.data.maxRetries, 5)
  assert.equal(saved.data.timeoutMs, 30000)
  assert.equal(saved.data.maxTokens, 1024)
  assert.equal(saved.data.maxTurnCalls, 12)
  assert.equal(saved.data.jsonMode, 'off')
  assert.equal(saved.data.turnTimeoutMs, 90000)
  assert.equal(saved.data.maxPromptTokens, 65536)
  assert.equal(saved.data.memorySteps, 3)
  assert.equal(saved.data.chatEnabled, false)
  assert.equal(saved.data.chatNotesMax, 20)
  assert.equal(saved.data.chatMaxChars, 800)
  assert.equal(saved.data.chatWindow, 10)

  const file = JSON.parse(fs.readFileSync(path.join(home, 'boardgame.config.json'), 'utf8'))
  assert.equal(file.memorySteps, 3)
  assert.equal(file.chatWindow, 10)
  assert.equal(file.chatEnabled, false)

  const invalid = await call(base, 'POST', '/api/config', { maxRetries: '不是数字' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.data.ok, false)
  assert.match(invalid.data.error, /maxRetries/)
})
