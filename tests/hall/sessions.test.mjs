// 大厅对局持久化回归：存档落盘、重启自动恢复、删除/过期清理、损坏存档隔离。
//
// 这些用例不依赖任何付费模型：五子棋在未配置 apiKey 时会走确定性兜底，
// 因此"玩家走一步 → AI 兜底一步 → 落盘 → 重启恢复"可以完全离线跑通。
//
// 运行：npm run test:hall

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import gobang from '../../games/gobang/index.js'
import { createServer } from '../../lib/server.js'
import { readSnapshots, deleteSnapshot, pruneSnapshots, snapshotPath, sessionsDir } from '../../lib/sessions.js'

const GRID = 15

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)))
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

test('大厅对局持久化（存档 / 恢复 / 隔离 / 清理）', { timeout: 90000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-sessions-'))
  const saved = { DSH_HOME: process.env.DSH_HOME, AI_API_KEY: process.env.AI_API_KEY, BOARDGAME_PERSIST: process.env.BOARDGAME_PERSIST }
  process.env.DSH_HOME = home
  delete process.env.AI_API_KEY
  delete process.env.BOARDGAME_PERSIST

  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  const startServer = async () => {
    const server = createServer({ mods: [gobang] })
    const url = await listen(server)
    const restored = await server.ready
    return { server, url, restored }
  }
  const stop = (running) => new Promise((resolve) => {
    const server = running && running.server ? running.server : running
    if (!server || !server.listening) return resolve()
    server.closeAllConnections()
    server.close(() => resolve())
  })

  const firstEmptyCell = (board) => {
    for (let i = 0; i < board.length; i++) if (!board[i]) return { x: i % GRID, y: Math.floor(i / GRID) }
    return null
  }

  let sessionId = null
  let revisionAfterMove = null

  await t.test('开局后自动落盘；进程重启后自动恢复并可继续对局', async () => {
    const first = await startServer()
    try {
      const started = await call(first.url, 'POST', '/api/start', {
        modId: 'gobang',
        settings: { firstMove: 'player', opponents: ['__random__'] },
      })
      assert.equal(started.data.ok, true, JSON.stringify(started.data))
      sessionId = started.data.session.sessionId
      assert.equal(fs.existsSync(snapshotPath(sessionId)), true, '开局后必须立即产生存档')

      const moved = await call(first.url, 'POST', '/api/move', { sessionId, move: { x: 7, y: 7 } })
      assert.equal(moved.data.ok, true, JSON.stringify(moved.data))
      revisionAfterMove = moved.data.session.state.revision
      assert.ok(revisionAfterMove >= 1, '玩家落子 + AI 兜底后 revision 必须前进')

      const list = await call(first.url, 'GET', '/api/sessions')
      assert.equal(list.data.ok, true)
      assert.equal(list.data.persist, true)
      assert.equal(list.data.sessions.some((item) => item.sessionId === sessionId), true, '存档列表必须包含当前对局')
    } finally {
      await stop(first.server)
    }

    // 模拟进程重启：同一 DSH_HOME 再起一个实例
    const second = await startServer()
    try {
      assert.equal(second.restored.includes(sessionId), true, '重启后必须自动恢复该对局')

      const resumed = await call(second.url, 'GET', '/api/session?sessionId=' + encodeURIComponent(sessionId))
      assert.equal(resumed.data.ok, true, JSON.stringify(resumed.data))
      assert.equal(resumed.data.session.sessionId, sessionId)
      assert.equal(resumed.data.session.state.revision, revisionAfterMove, '恢复后必须保留 revision')
      assert.equal(resumed.data.session.state.board[7 * GRID + 7], 'black', '恢复后必须保留玩家落子')

      // 恢复出来的对局仍然可以继续走
      const cell = firstEmptyCell(resumed.data.session.state.board)
      assert.ok(cell, '棋盘必须有空位')
      const again = await call(second.url, 'POST', '/api/move', { sessionId, move: cell })
      assert.equal(again.data.ok, true, JSON.stringify(again.data))
      assert.ok(again.data.session.state.revision > revisionAfterMove)
    } finally {
      await stop(second.server)
    }

    // 退出对局时应当连存档一起清掉
    const third = await startServer()
    try {
      const left = await call(third.url, 'POST', '/api/leave', { sessionId })
      assert.equal(left.data.ok, true)
      assert.equal(fs.existsSync(snapshotPath(sessionId)), false, '退出对局后必须删除存档')
    } finally {
      await stop(third.server)
    }
  })

  await t.test('存档模块：删除、过期清理与路径安全', async () => {
    const session = { sessionId: 'bg-test-1', modId: 'gobang', modName: '五子棋', players: [], state: { status: 'playing', revision: 0 }, settings: {}, events: [] }
    const { saveSnapshot } = await import('../../lib/sessions.js')
    saveSnapshot(session, { resourceVersion: null })
    assert.equal(fs.existsSync(snapshotPath('bg-test-1')), true)
    assert.equal(readSnapshots().length, 1)
    assert.equal(deleteSnapshot('bg-test-1'), true)
    assert.equal(fs.existsSync(snapshotPath('bg-test-1')), false)

    // 过期快照按 savedAt 清理
    saveSnapshot(session, {})
    const file = snapshotPath('bg-test-1')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.savedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    fs.writeFileSync(file, JSON.stringify(record), 'utf8')
    assert.equal(pruneSnapshots(14 * 24 * 60 * 60 * 1000), 1)
    assert.equal(fs.existsSync(file), false)

    // 路径穿越必须被拒绝
    assert.throws(() => snapshotPath('../../etc/passwd'))
    assert.throws(() => snapshotPath('a/b'))
  })

  await t.test('损坏存档被隔离，不影响大厅启动与其它对局', async () => {
    fs.mkdirSync(sessionsDir(), { recursive: true })
    fs.writeFileSync(path.join(sessionsDir(), 'broken.json'), '{ 这不是 JSON', 'utf8')
    fs.writeFileSync(path.join(sessionsDir(), 'wrong-shape.json'), JSON.stringify({ schema: 1, savedAt: new Date().toISOString(), session: {} }), 'utf8')

    const instance = await startServer()
    try {
      assert.equal(instance.restored.length, 0, '损坏存档不得被恢复')
      assert.equal(fs.existsSync(path.join(sessionsDir(), 'broken.json.bad')), true, '无法解析的存档必须被隔离为 .bad')
      assert.equal(fs.existsSync(path.join(sessionsDir(), 'wrong-shape.json.bad')), true, '结构不符的存档必须被隔离为 .bad')

      // 大厅仍然能正常开局
      const started = await call(instance.url, 'POST', '/api/start', {
        modId: 'gobang',
        settings: { firstMove: 'player', opponents: ['__random__'] },
      })
      assert.equal(started.data.ok, true, JSON.stringify(started.data))
      await call(instance.url, 'POST', '/api/leave', { sessionId: started.data.session.sessionId })
    } finally {
      await stop(instance)
    }
  })
})