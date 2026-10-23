import test from 'node:test'
import assert from 'node:assert/strict'
import { createPerfRecorder, PERF_SAMPLE_LIMIT } from '../../public/perf.js'
import { createOnlineUI } from '../../public/online-ui.js'

// 与 tests/hall/online-ui.test.mjs 相同的最小浏览器 mock：
// online-ui 构造时要读 localStorage，boot() 要用 window.addEventListener 与 setTimeout（拦截轮询）。
function mockBrowser(t) {
  const oldStorage = globalThis.localStorage, oldWindow = globalThis.window
  globalThis.localStorage = { getItem: () => '', setItem() {} }
  globalThis.window = { addEventListener() {} }
  t.mock.method(globalThis, 'setTimeout', () => 1)
  t.after(() => {
    if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
  })
}

function onlineStatus(serial, overrides = {}) {
  return {
    instanceId: 'perf-test-process', serial, connected: true, relayUrl: '', busy: false, memberId: 'member-1',
    room: { code: 'TEST01', capacity: 2, phase: 'playing', members: [{ id: 'member-1', name: '房主', host: true, online: true, seat: 0 }] },
    session: { sessionId: 'session-1', modId: 'arkhamhorror', state: { revision: serial }, events: [] },
    ...overrides,
  }
}

test('perf recorder：summary 给出每个阶段的 count/p50/p95/max/total 与 status/command 字节', () => {
  const scope = {}
  const perf = createPerfRecorder(scope)
  assert.equal(perf.enabled, true)
  assert.equal(scope.__ONLINE_PERF__, perf, '数据必须挂到 scope.__ONLINE_PERF__')
  assert.deepEqual(perf.summary().requests, { count: 0, p50: 0, p95: 0, max: 0, total: 0, bytes: { total: 0, status: 0, command: 0, other: 0 } })

  perf.recordRequest({ path: '/online/status', method: 'GET', ms: 10, bytes: 100 })
  perf.recordRequest({ path: '/online/status?wait=1&after=0', method: 'GET', ms: 20, bytes: 50 })
  perf.recordRequest({ path: '/online/command', method: 'POST', ms: 30, bytes: 300 })
  perf.recordCommand({ action: 'move', transport: 'relay', ms: 40 })
  perf.recordCommand({ action: 'chat', transport: 'direct', ms: 60 })
  perf.recordCommand({ action: 'move', transport: 'relay', ms: 20 })
  perf.recordApply({ serial: 1, sessionChanged: true, ms: 2 })
  perf.recordApply({ serial: 2, sessionChanged: false, ms: 4 })
  perf.recordRender(5)
  perf.recordRender(15)
  perf.recordRender(25)

  const summary = perf.summary()
  assert.deepEqual(summary.requests, {
    count: 3, p50: 20, p95: 30, max: 30, total: 60,
    bytes: { total: 450, status: 150, command: 300, other: 0 },
  })
  assert.deepEqual(summary.commands, {
    count: 3, p50: 40, p95: 60, max: 60, total: 120, transports: { direct: 1, relay: 2 },
  })
  assert.deepEqual(summary.applies, { count: 2, p50: 2, p95: 4, max: 4, total: 6, sessionChanged: 1 })
  assert.deepEqual(summary.renders, { count: 3, p50: 15, p95: 25, max: 25, total: 45 })
})

test('perf recorder：每类样本有界（最近 500 条），reset 清空且不改变挂载', () => {
  const scope = {}
  const perf = createPerfRecorder(scope)
  for (let i = 0; i < PERF_SAMPLE_LIMIT + 37; i++) {
    perf.recordRequest({ path: '/online/status', method: 'GET', ms: i, bytes: 1 })
    perf.recordCommand({ action: 'move', transport: 'relay', ms: i })
    perf.recordApply({ serial: i, sessionChanged: false, ms: i })
    perf.recordRender(i)
  }
  assert.equal(perf.requests.length, PERF_SAMPLE_LIMIT)
  assert.equal(perf.commands.length, PERF_SAMPLE_LIMIT)
  assert.equal(perf.applies.length, PERF_SAMPLE_LIMIT)
  assert.equal(perf.renders.length, PERF_SAMPLE_LIMIT)
  assert.equal(perf.renders[0].ms, 37, '超出上限时丢弃最旧的样本')
  assert.equal(perf.renders.at(-1).ms, PERF_SAMPLE_LIMIT + 36)
  const summary = perf.summary()
  assert.equal(summary.renders.count, PERF_SAMPLE_LIMIT)
  assert.equal(summary.requests.bytes.total, PERF_SAMPLE_LIMIT)

  perf.reset()
  assert.equal(perf.requests.length, 0)
  assert.equal(perf.commands.length, 0)
  assert.equal(perf.applies.length, 0)
  assert.equal(perf.renders.length, 0)
  assert.equal(perf.summary().renders.count, 0)
  assert.equal(scope.__ONLINE_PERF__, perf, 'reset 只清样本，不摘掉 window.__ONLINE_PERF__')
})

test('createOnlineUI 注入 recorder 后，accept -> apply、command -> relay 命令都会记录', async t => {
  mockBrowser(t)
  const scope = {}
  const perf = createPerfRecorder(scope)
  const state = { busy: false, chat: {}, catalog: [], online: null, session: null, view: 'library' }
  const value = onlineStatus(1)
  const calls = []
  const sentBodies = []
  const request = async (method, path, body) => {
    calls.push(`${method} ${path}`)
    if (body !== undefined) sentBodies.push(body)
    if (method === 'GET' && path.startsWith('/online/status')) return value
    if (method === 'POST' && path === '/online/command') return { ok: true, revision: 1 }
    throw new Error('unexpected request: ' + method + ' ' + path)
  }
  const ui = createOnlineUI({ state, render() {}, renderChrome() {}, request, loadGame() {}, perf })
  await ui.boot()
  assert.equal(state.session?.sessionId, 'session-1')
  assert.ok(perf.applies.length >= 1, 'boot 的首个 status 必须记录 apply')
  const firstApply = perf.applies[0]
  assert.equal(firstApply.serial, 1)
  assert.equal(firstApply.sessionChanged, true)
  assert.equal(typeof firstApply.ms, 'number')
  assert.ok(firstApply.ms >= 0)

  const appliesBefore = perf.applies.length
  const statusBefore = calls.filter(call => call.startsWith('GET /online/status')).length
  const result = await ui.command('chat', { text: 'hello' })
  assert.deepEqual(result, { ok: true, revision: 1 })
  assert.equal(perf.commands.length, 1, '一次命令只产生一条命令记录')
  const command = perf.commands[0]
  assert.equal(command.action, 'chat')
  assert.equal(command.transport, 'relay', 'Node 里没有 WebRTC，命令走后转 HTTP')
  assert.equal(typeof command.ms, 'number')
  assert.ok(command.ms >= 0)
  // P1.2：move / chat 成功后不再显式 refresh——页面靠快照 + 长轮询更新；
  // 因此 command() 不应再额外产生一次 status 请求 / apply。
  assert.equal(perf.applies.length, appliesBefore, 'move / chat 命令不再触发额外 refresh')
  assert.equal(calls.filter(call => call.startsWith('GET /online/status')).length, statusBefore, '命令自身不新拉 /online/status')
  assert.ok(calls.includes('POST /online/command'))
  assert.equal(calls.filter(call => call.startsWith('GET /online/status')).length >= 1, true, 'status 仍走既有轮询')
  const sent = sentBodies.find(body => body?.action === 'chat')
  assert.equal(sent?.body?.client?.slim, true, 'P1.2：chat 命令必须声明 slim 响应')
})

test('createOnlineUI 不传 recorder 时行为不变，且不会创建 window.__ONLINE_PERF__', async t => {
  mockBrowser(t)
  delete globalThis.__ONLINE_PERF__
  delete globalThis.window.__ONLINE_PERF__
  const state = { busy: false, chat: {}, catalog: [], online: null, session: null, view: 'library' }
  const request = async (method, path) => {
    if (method === 'GET' && path.startsWith('/online/status')) return onlineStatus(1)
    if (method === 'POST' && path === '/online/command') return { ok: true, revision: 1 }
    throw new Error('unexpected request: ' + method + ' ' + path)
  }
  const ui = createOnlineUI({ state, render() {}, renderChrome() {}, request, loadGame() {} })
  await ui.boot()
  await ui.command('chat', { text: 'hello' })
  assert.equal(state.session?.sessionId, 'session-1')
  assert.equal(globalThis.window.__ONLINE_PERF__, undefined, '无 ?perf=1 时不得创建埋点对象')
  assert.equal(globalThis.__ONLINE_PERF__, undefined, '不得在全局作用域创建埋点对象')
})
