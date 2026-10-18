// 战术交流与备忘回归：可见性、写入闸门、注入、压缩、HTTP 端到端与持久化。
//
// 设计文档：docs/tactical-chat-design.md
// 运行：npm run test:hall

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import gobang from '../../games/gobang/index.js'
import { createServer } from '../../lib/server.js'
import { createAgent } from '../../lib/agent/orchestrator.js'
import { resetJsonModeCache } from '../../lib/agent/client.js'
import { statsSnapshot, resetStats } from '../../lib/agent/log.js'
import {
  visibleChat, chatLogFor, canWriteMemory, mergeNotes, compactDeterministic,
  pickNotesForSeat, groupNotes, normalizeNoteText, noteDuplicate, clampNoteText, clampChatText,
} from '../../lib/chat.js'

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

function startModel() {
  const state = { calls: 0, seen: [], foreignAuth: undefined, behavior: () => ({ content: '{"move":{"x":0},"speech":"ok"}' }) }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      state.calls++
      let payload = null
      try { payload = JSON.parse(body) } catch { /* 保留 null */ }
      if (String(req.headers.authorization || '') !== 'Bearer stub-key') {
        state.foreignAuth = String(req.headers.authorization || '')
        res.writeHead(500)
        res.end('refusing non-stub credential')
        return
      }
      state.seen.push(payload)
      const reply = await state.behavior(payload, state.calls)
      if (reply && reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(reply.body || '{}')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        choices: [{ message: { content: reply.content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'stub-model',
      }))
    })
  })
  return {
    state,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

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

/** 三座位的假 Mod（1 人类 + 2 AI），用于座位隔离与压缩测试。 */
function fakeMod(overrides = {}) {
  return {
    id: 'fake-chat', name: '聊天测试', description: '一个用于测试战术交流的假桌游',
    cooperative: false, moveFormat: '{"x":0}',
    createState: () => ({ status: 'playing', currentSeat: 0, moveCount: 0, winnerSeat: null, revision: 0 }),
    describeState: () => '局面：测试局面',
    legalMoves: () => [{ x: 0 }],
    moveToText: () => '(0)',
    validateMove: () => null,
    applyMove: () => [],
    ...overrides,
  }
}

function makeSession(mod, seats = 3) {
  const players = []
  for (let seat = 0; seat < seats; seat++) {
    players.push({
      seat, role: seat === 0 ? 'human' : 'ai', aiId: 'ai-' + seat,
      name: seat === 0 ? '你' : 'AI' + seat,
      color: seat === 0 ? 'black' : 'white', colorHex: '#000000',
    })
  }
  return {
    sessionId: 's-chat', modId: mod.id, modName: mod.name, render: {},
    players, state: mod.createState(), settings: {}, events: [], notes: [],
  }
}

const agentFor = (mod) => createAgent({
  modById: (id) => (id === mod.id ? mod : null),
  getAi: (id) => ({ id, name: '测试 AI ' + id, persona: '你是测试 AI。' }),
})

const notesOf = (session, seat) => pickNotesForSeat(session.notes, seat).map((note) => note.text)
const systemOf = (payload) => (payload.messages[0] && payload.messages[0].content) || ''
const joined = (payload) => payload.messages.map((message) => message.content).join('\n')

// ---------------------------------------------------------------------------

test('战术交流与备忘', { timeout: 90000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-chat-'))
  const saved = Object.fromEntries(['DSH_HOME', 'AI_API_KEY', 'AI_BASE_URL', 'AI_TURN_TIMEOUT_MS', 'AI_CHAT_ENABLED'].map((key) => [key, process.env[key]]))
  process.env.DSH_HOME = home
  process.env.AI_API_KEY = 'stub-key'
  delete process.env.AI_TURN_TIMEOUT_MS
  delete process.env.AI_CHAT_ENABLED

  const model = startModel()
  const baseUrl = await model.listen()
  process.env.AI_BASE_URL = baseUrl

  t.after(async () => {
    await model.close()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  // ---------------- 纯函数层 ----------------
  await t.test('可见性：私聊只对目标座位与人类可见', () => {
    const events = [
      { seq: 0, type: 'move', seat: 0 },
      { seq: 1, type: 'chat', seat: 0, to: null, text: '公开' },
      { seq: 2, type: 'chat', seat: 0, to: 2, text: '私聊给2' },
      { seq: 3, type: 'chat', seat: 2, to: 0, text: '2回复' },
    ]
    assert.deepEqual(chatLogFor(events, 2).map((e) => e.text), ['公开', '私聊给2', '2回复'])
    assert.deepEqual(chatLogFor(events, 3).map((e) => e.text), ['公开'])
    assert.deepEqual(chatLogFor(events, 0).map((e) => e.text), ['公开', '私聊给2', '2回复'])
    assert.equal(visibleChat(events, 3).some((e) => e.type === 'move'), true, '非 chat 事件不受影响')
    assert.equal(visibleChat(events, null).some((e) => e.to === 2), false, '没有观察者时私聊不外泄')
  })

  await t.test('写入闸门：只有玩家的长期意图发言才有资格变成备忘', () => {
    const aiProposal = { type: 'chat', seat: 2, text: '我建议先清小怪再推主线' }
    assert.equal(canWriteMemory('记住，以后优先推主线'), true)
    assert.equal(canWriteMemory('以后每次先调查再移动'), true)
    assert.equal(canWriteMemory('这回合先去阁楼'), false, '局内临时目标不得写入')
    assert.equal(canWriteMemory('你现在就去打那只怪'), false)
    assert.equal(canWriteMemory('你下棋真菜'), false)
    assert.equal(canWriteMemory('你觉得该先打谁？'), false)
    assert.equal(canWriteMemory('好，就按你说的', aiProposal), true, '确认型发言可以写入')
    assert.equal(canWriteMemory('好，就按你说的', null), false, '没有 AI 提议时纯"好"不算约定')
    assert.equal(canWriteMemory('好，那我自己来', aiProposal), false, '不是纯确认发言')
  })

  await t.test('合并：去重、包含式判重、跨作用域隔离', () => {
    let result = mergeNotes([], { add: ['先推进主线，小怪能躲就躲'] }, { evidence: 1, now: 1000 })
    assert.equal(result.added, 1)
    result = mergeNotes(result.notes, { add: ['先推进主线，小怪能躲就躲'] }, { evidence: 2, now: 2000 })
    assert.equal(result.notes.length, 1, '完全重复不得新增')
    assert.equal(result.added, 0)
    result = mergeNotes(result.notes, { add: ['先推进主线，小怪能躲就躲啊！'] }, { evidence: 3, now: 3000 })
    assert.equal(result.notes.length, 1, '包含式近重复必须并入既有条目')
    assert.equal(result.updated, 1)
    assert.equal(noteDuplicate('先推进主线，小怪能躲就躲', '先推进主线，小怪能躲就躲啊'), true)

    // 视角：私聊备忘只给目标座位；team 给所有座位
    result = mergeNotes(result.notes, { add: ['别把我的手牌告诉别人'] }, { scope: 'seat', seat: 2, now: 4000 })
    assert.deepEqual(notesOf({ notes: result.notes }, 1), ['先推进主线，小怪能躲就躲啊！'])
    assert.deepEqual(notesOf({ notes: result.notes }, 2), ['先推进主线，小怪能躲就躲啊！', '别把我的手牌告诉别人'])

    // 私聊删不掉公开备忘
    const removed = mergeNotes(result.notes, { remove: [result.notes[0].id] }, { scope: 'seat', seat: 2, now: 5000 })
    assert.equal(removed.removed, 0, '私聊不能删除公开备忘')
    // 单次操作数量上限
    const flood = mergeNotes([], { add: ['a1', 'a2', 'a3', 'a4', 'a5'] }, { now: 1 })
    assert.equal(flood.added, 3, '单次最多写入 3 条')
    assert.equal(clampNoteText('一'.repeat(80)).length, 30, '单条备忘截断到 30 字')
    assert.equal(clampChatText('x'.repeat(999), 500).length, 500, '单条发言截断到上限')
    assert.deepEqual(groupNotes(result.notes).map((group) => group.key), ['team', 'seat:2'])
  })

  await t.test('压缩：确定性裁剪可复现，且按作用域分组', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: 'n' + (i + 1), text: '策略' + i, scope: 'team', createdAt: i, updatedAt: i }))
    const first = compactDeterministic(many, 8)
    const second = compactDeterministic(many.slice().reverse(), 8)
    assert.deepEqual(first.notes.map((n) => n.id), second.notes.map((n) => n.id), '同输入必须同输出（与顺序无关）')
    assert.equal(first.notes.length, 8)
    assert.equal(first.dropped, 12)
    assert.deepEqual(first.notes.map((n) => n.id), ['n13', 'n14', 'n15', 'n16', 'n17', 'n18', 'n19', 'n20'], '保留最近更新的条目')
    const mixed = [...many.slice(0, 3), { id: 'n100', text: '私聊', scope: 'seat', seat: 2, createdAt: 1, updatedAt: 1 }]
    assert.deepEqual(groupNotes(mixed).map((g) => g.key).sort(), ['seat:2', 'team'])
    assert.equal(normalizeNoteText('注意，全角ＡＢＣ！'), normalizeNoteText('注意 全角ABC'))
  })

  // ---------------- agent 层 ----------------
  await t.test('agentChat：讨论不产生 move，解析失败会重试', async () => {
    resetJsonModeCache()
    resetStats()
    const mod = fakeMod()
    const agent = agentFor(mod)
    const session = makeSession(mod)

    model.state.seen.length = 0
    model.state.behavior = (payload) => {
      if (systemOf(payload).includes('记忆整理助手')) return { content: '{"notes":[]}' }
      if (systemOf(payload).includes('【讨论规则】')) return { content: '{"reply":"我建议先清小怪","memory":{}}' }
      return { content: '{"move":{"x":0},"speech":"ok"}' }
    }
    const outcome = await agent.agentChat(session, 2, '你觉得该怎么打？', 'seat')
    assert.equal(outcome.reply, '我建议先清小怪')
    assert.equal(outcome.memory.add.length + outcome.memory.update.length + outcome.memory.remove.length, 0, '没有长期意图时不得写记忆')
    assert.equal('move' in outcome, false, '讨论不得产出行动')

    // 第一次输出非法 JSON -> 反馈后重试成功
    model.state.calls = 0
    model.state.behavior = (payload, call) => {
      if (systemOf(payload).includes('【讨论规则】')) {
        return call === 1 ? { content: '这不是 JSON' } : { content: '{"reply":"重试成功","memory":{}}' }
      }
      return { content: '{"move":{"x":0},"speech":"ok"}' }
    }
    const retried = await agent.agentChat(session, 2, '再说一次', 'seat')
    assert.equal(retried.reply, '重试成功')
    assert.equal(model.state.calls, 2, '解析失败必须重试一次')

    // 全部失败：返回明确错误，不抛异常
    model.state.behavior = (payload) => (systemOf(payload).includes('【讨论规则】') ? { content: '还是不是 JSON' } : { content: '{"move":{"x":0}}' })
    const failed = await agent.agentChat(session, 2, '再试', 'seat')
    assert.equal(failed.reply, '')
    assert.match(failed.error, /无法解析/)

    const stats = statsSnapshot()
    assert.equal(stats.totals.chat, 2, '两次成功讨论')
    assert.ok(stats.totals.chatError >= 3, '失败次数单独计数')
    assert.equal(stats.totals.illegalRate, 0, '聊天不得污染非法率')
    assert.equal(stats.totals.fallbackRate, 0, '聊天不得污染兜底率')
    assert.equal(stats.totals.chatCalls, stats.totals.chat + stats.totals.chatError)
  })

  await t.test('备忘注入 system 末尾，且私聊备忘不泄漏给其它座位', async () => {
    const mod = fakeMod()
    const agent = agentFor(mod)
    const session = makeSession(mod)
    session.notes = [
      { id: 'n1', text: '先推进主线，小怪能躲就躲', scope: 'team', seat: null, origin: 'auto', createdAt: 1, updatedAt: 1 },
      { id: 'n2', text: '别把我的手牌说出去', scope: 'seat', seat: 2, origin: 'auto', createdAt: 2, updatedAt: 2 },
    ]
    session.events = [
      { seq: 0, type: 'chat', seat: 0, to: null, text: '公开讨论内容' },
      { seq: 1, type: 'chat', seat: 0, to: 2, text: '私密约定内容' },
    ]
    model.state.seen.length = 0
    model.state.behavior = () => ({ content: '{"move":{"x":0},"speech":"ok"}' })

    session.state.currentSeat = 1
    await agent.agentPlay(session, 1, undefined)
    const seat1 = model.state.seen.at(-1)
    const system1 = systemOf(seat1)
    assert.equal(system1.includes('先推进主线，小怪能躲就躲'), true, '公开备忘对队友可见')
    assert.equal(system1.includes('别把我的手牌说出去'), false, '私聊备忘不得泄漏给其它座位')
    assert.equal(system1.trimEnd().endsWith('一律以后者为准。'), true, '备忘必须追加在 system 末尾（缓存友好）')
    assert.equal(system1.includes('【备忘的使用边界】'), true)
    assert.equal(joined(seat1).includes('私密约定内容'), false, '私聊事件不得进入其它座位的上下文')
    assert.equal(joined(seat1).includes('公开讨论内容'), true, '公开讨论要进入上下文')

    session.state.currentSeat = 2
    await agent.agentPlay(session, 2, undefined)
    const seat2 = model.state.seen.at(-1)
    assert.equal(systemOf(seat2).includes('别把我的手牌说出去'), true, '私聊目标座位必须看到自己的备忘')
    assert.equal(joined(seat2).includes('私密约定内容'), true)
    assert.equal(joined(seat2).includes('🔒'), true, '私聊在历史里要有标记')
  })

  await t.test('压缩：模型可用时合并，不可用时确定性兜底', async () => {
    resetStats()
    const mod = fakeMod()
    const agent = agentFor(mod)
    const session = makeSession(mod)
    const many = Array.from({ length: 20 }, (_, i) => ({ id: 'n' + (i + 1), text: '策略条目' + i, scope: 'team', seat: null, origin: 'auto', createdAt: i, updatedAt: i }))
    session.notes = many.slice()

    // 模型正常合并
    model.state.seen.length = 0
    model.state.behavior = (payload) => {
      if (systemOf(payload).includes('记忆整理助手')) return { content: '{"notes":[{"id":"n19","text":"合并后的策略A"},{"id":"n20","text":"合并后的策略B"}]}' }
      return { content: '{"move":{"x":0}}' }
    }
    const merged = await agent.compactNotes(session)
    assert.equal(merged.compressed, true)
    assert.equal(merged.notes.length, 2)
    assert.equal(merged.notes.every((note) => many.some((item) => item.id === note.id)), true, '只能使用已有 id')
    assert.equal(merged.notes.every((note) => note.text.length <= 30), true)
    assert.ok(merged.dropped > 0)

    // 模型不可用 -> 确定性兜底，且两次结果一致
    session.notes = many.slice()
    model.state.behavior = (payload) => {
      if (systemOf(payload).includes('记忆整理助手')) return { content: '不是 JSON' }
      return { content: '{"move":{"x":0}}' }
    }
    const first = await agent.compactNotes(session)
    session.notes = many.slice()
    const second = await agent.compactNotes(session)
    assert.equal(first.compressed, true)
    assert.deepEqual(first.notes.map((n) => n.id), second.notes.map((n) => n.id), '兜底必须可复现')
    assert.equal(first.notes.length <= 8, true, '压缩到目标条数以内')
    assert.deepEqual(first.notes.map((n) => n.id), compactDeterministic(many, 8).notes.map((n) => n.id))
    assert.ok(statsSnapshot().totals.chatCompress >= 2, '压缩调用要单独计数')
  })

  // ---------------- HTTP 端到端 ----------------
  await t.test('HTTP：公开/私聊、记忆落盘、指标分桶、备忘管理、重启可恢复', async () => {
    resetStats()
    const startServer = async () => {
      const server = createServer({ mods: [gobang] })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      await server.ready
      return { server, url: 'http://127.0.0.1:' + server.address().port }
    }
    const stop = (running) => new Promise((resolve) => {
      const server = running && running.server ? running.server : running
      if (!server || !server.listening) return resolve()
      server.closeAllConnections()
      server.close(() => resolve())
    })

    model.state.behavior = (payload) => {
      if (systemOf(payload).includes('记忆整理助手')) return { content: '{"notes":[]}' }
      if (systemOf(payload).includes('【讨论规则】')) return { content: '{"reply":"明白，先推主线","memory":{"add":["先推进主线，小怪能躲就躲"]}}' }
      return { content: '{"move":{"x":0,"y":0},"speech":"ok"}' }
    }

    const first = await startServer()
    let sessionId = null
    let revision = null
    let noteId = null
    try {
      const started = await call(first.url, 'POST', '/api/start', { modId: 'gobang', settings: { firstMove: 'player', opponents: ['__random__'] } })
      assert.equal(started.data.ok, true, JSON.stringify(started.data))
      sessionId = started.data.session.sessionId
      revision = started.data.session.state.revision
      assert.deepEqual(started.data.session.notes, [], '开局自带空备忘')

      // 公开桌聊：触发记忆写入
      const publicChat = await call(first.url, 'POST', '/api/chat', { sessionId, text: '记住，以后优先推主线', to: null })
      assert.equal(publicChat.data.ok, true, JSON.stringify(publicChat.data))
      assert.equal(publicChat.data.chat.reply, '明白，先推主线')
      assert.equal(publicChat.data.chat.notesAdded, 1)
      assert.equal(publicChat.data.session.state.revision, revision, '聊天不得推进对局版本')
      const events = publicChat.data.session.events.filter((e) => e.type === 'chat')
      assert.equal(events.length, 2, '玩家发言 + AI 回复各一条')
      assert.equal(events[0].seat, 0)
      assert.equal(events[0].to, null)
      assert.equal(events[1].to, null)
      assert.equal(publicChat.data.session.notes.length, 1)
      assert.equal(publicChat.data.session.notes[0].scope, 'team')
      assert.equal(Number.isInteger(publicChat.data.session.notes[0].evidence), true, '每条备忘要能追溯到发言')
      noteId = publicChat.data.session.notes[0].id

      // 私聊：记忆落入 seat 作用域
      const privateChat = await call(first.url, 'POST', '/api/chat', { sessionId, text: '记住，私底下先别管小怪', to: 1 })
      assert.equal(privateChat.data.ok, true, JSON.stringify(privateChat.data))
      assert.equal(privateChat.data.session.notes.length, 2)
      const seatNote = privateChat.data.session.notes.find((note) => note.scope === 'seat')
      assert.equal(seatNote.seat, 1)
      const privateEvents = privateChat.data.session.events.filter((e) => e.type === 'chat' && e.to === 1)
      assert.equal(privateEvents.length, 2)

      // 没有长期意图时不得写入
      const noMemory = await call(first.url, 'POST', '/api/chat', { sessionId, text: '你觉得现在该走哪一步？', to: null })
      assert.equal(noMemory.data.ok, true)
      assert.equal(noMemory.data.chat.notesAdded, 0, '普通讨论不得写入记忆')
      assert.equal(noMemory.data.session.notes.length, 2)

      // 无效私聊对象
      const invalid = await call(first.url, 'POST', '/api/chat', { sessionId, text: '喂', to: 9 })
      assert.equal(invalid.status, 400)
      assert.equal(invalid.data.code, 'INVALID_TARGET')

      // 指标：聊天单独计数，不污染非法率/兜底率
      const stats = await call(first.url, 'GET', '/api/agent-stats')
      assert.ok(stats.data.totals.chatCalls >= 3)
      assert.equal(stats.data.totals.illegalRate, 0)
      assert.equal(stats.data.totals.fallbackRate, 0)
      assert.equal(stats.data.totals.chatNotes >= 2, true)
      assert.ok(stats.data.byMod.gobang.chatNotes >= 2)

      // 手动钉住 / 编辑 / 删除 / 清空
      const pinned = await call(first.url, 'POST', '/api/notes/add', { sessionId, text: '开局先占角' })
      assert.equal(pinned.data.session.notes.length, 3)
      const manual = pinned.data.session.notes.find((note) => note.origin === 'manual')
      assert.ok(manual)
      const edited = await call(first.url, 'POST', '/api/notes/update', { sessionId, noteId: manual.id, text: '开局先占角或边' })
      assert.equal(edited.data.session.notes.find((note) => note.id === manual.id).text, '开局先占角或边')
      const deleted = await call(first.url, 'POST', '/api/notes/delete', { sessionId, noteId: manual.id })
      assert.equal(deleted.data.session.notes.some((note) => note.id === manual.id), false)
      assert.equal(deleted.data.session.notes.length, 2)

      // 存档里必须带着备忘
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'boardgame-hall', 'sessions', 'gobang', sessionId + '.json'), 'utf8'))
      assert.equal(saved.session.notes.length, 2)
      assert.equal(saved.session.notes.some((note) => note.scope === 'seat' && note.seat === 1), true)
      assert.equal(saved.session.events.some((event) => event.type === 'chat' && event.to === 1), true)
    } finally {
      await stop(first)
    }

    // 重启后备忘与讨论记录都要在
    const second = await startServer()
    try {
      const resumed = await call(second.url, 'GET', '/api/session?sessionId=' + encodeURIComponent(sessionId))
      assert.equal(resumed.data.ok, true)
      assert.equal(resumed.data.session.notes.length, 2, '重启后必须恢复备忘')
      assert.equal(resumed.data.session.notes.some((note) => note.scope === 'seat' && note.seat === 1), true)
      assert.equal(resumed.data.session.events.filter((event) => event.type === 'chat').length >= 5, true)
      assert.equal(resumed.data.session.state.revision, revision, '恢复后对局版本不变')

      // 清空本局记忆（救济入口）
      const cleared = await call(second.url, 'POST', '/api/notes/clear', { sessionId })
      assert.deepEqual(cleared.data.session.notes, [])
      const afterClear = await call(second.url, 'GET', '/api/session?sessionId=' + encodeURIComponent(sessionId))
      assert.deepEqual(afterClear.data.session.notes, [])
    } finally {
      await stop(second)
    }

    assert.equal(model.state.foreignAuth, undefined, '不得使用 stub 之外的凭据')
  })
})