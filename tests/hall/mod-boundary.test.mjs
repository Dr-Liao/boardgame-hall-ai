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

// 卡图 / 混乱标记 / 字体 / 音频都是随包发布的二进制媒体：内容稳定，可以长缓存；
// 脚本与样式没有版本参数，必须继续复验。复验路径本身也不能再读盘 + 整文件算两遍哈希，
// 否则一屏几十张卡图会全部排在单线程事件循环上（表现为「图过一会儿才出来」）。
test('静态资源：命中摘要后条件请求不再读盘，二进制媒体长缓存', async t => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-static-'))
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)])
  fs.mkdirSync(path.join(webRoot, 'img'), { recursive: true })
  const imageFile = path.join(webRoot, 'img', 'card.png')
  const scriptFile = path.join(webRoot, 'client.js')
  fs.writeFileSync(imageFile, png)
  fs.writeFileSync(scriptFile, 'export const value = 1\n')
  const server = createServer({ mods: [{ id: 'static-test', web: { root: webRoot } }], persist: false })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(webRoot, { recursive: true, force: true })
  })

  const first = await fetch(base + '/mods/static-test/img/card.png')
  assert.equal(first.status, 200)
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png)
  const etag = first.headers.get('etag')
  assert.ok(etag, '静态资源必须带 ETag')
  assert.match(first.headers.get('cache-control'), /immutable/)
  assert.match(first.headers.get('cache-control'), /max-age=\d{4,}/)

  // 条件复验：304、空包体，且不再读盘（第一次已经记住了摘要）。
  const readFile = fs.promises.readFile
  let reads = 0
  fs.promises.readFile = async (...args) => { reads += 1; return readFile.apply(fs.promises, args) }
  try {
    const again = await fetch(base + '/mods/static-test/img/card.png', { headers: { 'if-none-match': etag } })
    assert.equal(again.status, 304)
    assert.equal((await again.text()).length, 0)
    assert.equal(reads, 0, '条件复验不应重新读取文件')
    // 图片重新显示但不带条件头：只需要内容，摘要复用即可。
    const repeat = await fetch(base + '/mods/static-test/img/card.png')
    assert.equal(repeat.status, 200)
    assert.equal(repeat.headers.get('etag'), etag)
    await repeat.arrayBuffer()
  } finally {
    fs.promises.readFile = readFile
  }

  // 文件内容变了：旧 ETag 立刻失效，不会把陈旧版本当成 304 发回去。
  fs.writeFileSync(imageFile, Buffer.concat([png, Buffer.from([1, 2, 3])]))
  const changed = await fetch(base + '/mods/static-test/img/card.png', { headers: { 'if-none-match': etag } })
  assert.equal(changed.status, 200)
  assert.notEqual(changed.headers.get('etag'), etag)
  assert.equal((await changed.arrayBuffer()).byteLength, png.length + 3)

  // 脚本/样式没有版本参数，必须保持复验，否则 Mod 更新后玩家会拿到旧代码。
  const script = await fetch(base + '/mods/static-test/client.js')
  assert.equal(script.status, 200)
  assert.match(script.headers.get('cache-control'), /must-revalidate/)
  const scriptEtag = script.headers.get('etag')
  const scriptAgain = await fetch(base + '/mods/static-test/client.js', { headers: { 'if-none-match': scriptEtag } })
  assert.equal(scriptAgain.status, 304)
  await script.arrayBuffer()
})
