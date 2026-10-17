import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import gobang from '../../games/gobang/index.js'
import { createServer } from '../../lib/server.js'
import { snapshotPath } from '../../lib/sessions.js'
import { buildUserPrompt } from '../../lib/agent/prompt.js'

test('游戏状态字段不会隐式触发大厅的专属提示逻辑', () => {
  const session = {
    players: [{ seat: 0, role: 'human', name: '玩家' }, { seat: 1, role: 'ai', name: '队友' }],
    state: { status: 'playing', investigators: [{ seat: 1, name: '不应读取的角色', actionsLeft: 3 }] },
    events: [],
  }
  const mod = { ...gobang, describeState: () => '测试局面' }
  assert.doesNotMatch(buildUserPrompt(mod, session, 1), /不应读取的角色|剩余行动点/)
  const hooked = { ...mod, participantDescription: () => '测试身份', actionsRemaining: () => 7 }
  assert.match(buildUserPrompt(hooked, session, 1), /测试身份/)
  assert.match(buildUserPrompt(hooked, session, 1), /剩余行动点：7/)
})

test('任意 Mod 可声明存档策略与客户端资料，不依赖游戏 ID 或内部字段', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-boundary-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mod = {
    ...gobang, id: 'custom-lifecycle',
    clientData: { reference: ['专属资料'] },
    sessionPolicy: () => ({ manualLoad: true, retainOnLeave: true, confirmDelete: true,
      detachOnDelete: true, manualSave: true, requireRevision: true, preserveInvalid: true }),
    saveSummary: () => ({ chapter: '第一章', modId: '不可覆盖标准字段' }),
  }
  let server
  const start = async () => {
    server = createServer({ mods: [mod] })
    const restored = await server.ready
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return restored
  }
  const stop = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  t.after(async () => {
    if (server?.listening) await stop()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected test directory')
    fs.rmSync(home, { recursive: true, force: true })
  })
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, ...await response.json() }
  }
  await start()
  const entry = (await request('/catalog')).games[0]
  assert.deepEqual(entry.clientData, mod.clientData)
  assert.equal(Object.hasOwn(entry, 'deckBuilder'), false)
  const created = await request('/start', { modId: mod.id, settings: { opponents: [null] } })
  assert.equal(created.ok, true, created.error)
  const sessionId = created.session.sessionId
  assert.equal(created.session.lifecycle.manualLoad, true)
  const missingRevision = await request('/move', { sessionId, move: { x: 7, y: 7 } })
  assert.equal(missingRevision.code, 'INVALID_REVISION')
  const summary = (await request('/sessions')).sessions[0]
  assert.equal(summary.chapter, '第一章')
  assert.equal(summary.modId, mod.id)
  await request('/leave', { sessionId })
  assert.equal(fs.existsSync(snapshotPath(sessionId)), true)
  await stop()
  assert.deepEqual(await start(), [], '显式读档游戏不自动恢复')
  assert.equal((await request('/session/load', { sessionId })).ok, true)
  assert.equal((await request('/session/delete', { sessionId })).code, 'CONFIRM_REQUIRED')
  assert.equal((await request('/session/delete', { sessionId, confirm: true })).removed, true)
  const detached = await request('/session?sessionId=' + sessionId)
  assert.equal(detached.session.saveDetached, true)
  assert.equal((await request('/session/save', { sessionId })).code, 'SAVE_DELETED')
  const saved = await request('/session/save-as', { sessionId })
  assert.equal(saved.ok, true, saved.error)
  assert.notEqual(saved.session.sessionId, sessionId)
  assert.equal(fs.existsSync(snapshotPath(saved.session.sessionId)), true)
})
