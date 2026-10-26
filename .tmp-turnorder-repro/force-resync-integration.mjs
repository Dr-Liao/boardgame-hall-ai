// 集成验证（真实 relay + 2 个真实大厅 + 未修改的 public/online-ui.js）：
// 强制同步按钮的服务端链路：客人经 relay 执行 action:'sync' → 房主重置快照基线并广播全量，
// 随后浏览器 full=1 强制拉全量并应用到界面；本地卡死的 busy/旧 revision 被清掉。
// 运行：node .tmp-turnorder-repro/force-resync-integration.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRelay } from '../relay/server.js'
import { createServer } from '../lib/server.js'
import { loadTestMods } from '../tests/hall/helpers/mods.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'force-resync-'))
process.env.DSH_HOME = home
process.env.AI_API_KEY = ''
process.env.AI_CHAT_ENABLED = '0'
globalThis.localStorage = { getItem: () => '', setItem() {} }
globalThis.window = { addEventListener() {} }

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(resolve => { server.stopRelay?.(); server.online?.close(); server.closeAllConnections(); server.close(resolve) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const mods = await loadTestMods()
const relay = createRelay({ secret: 'force-resync-test' })
const relayUrl = await listen(relay)
const halls = []
for (let i = 0; i < 2; i++) {
  const server = createServer({ mods, persist: false })
  await server.ready
  const origin = await listen(server)
  halls.push({ server, origin })
}
const onlineFetch = async (index, route, body) => {
  const response = await fetch(halls[index].origin + '/api/online/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  return { status: response.status, json: await response.json() }
}
const waitFor = async (fn, timeout = 8000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(20) }
  throw new Error('等待超时')
}

try {
  // ---- 建房：2 个真人 + ox（强制同步是游戏无关的大厅能力） ----
  const created = await onlineFetch(0, 'create', { relayUrl, modId: 'ox', capacity: 2, fillAi: false })
  if (!created.json.ok) throw new Error('create: ' + created.json.error)
  const code = created.json.room.code
  if (!(await onlineFetch(1, 'join', { relayUrl, code })).json.ok) throw new Error('join failed')
  await onlineFetch(1, 'ready', { ready: true })
  await onlineFetch(0, 'command', { action: 'start', body: { operationId: randomUUID() } })
  await waitFor(async () => (await onlineFetch(1, 'status')).json.session?.state?.status === 'playing')

  // ---- 用真实 online-ui 模块跑客人侧同步层；request 模拟 app.js rawApi 的 HTTP 部分 ----
  const { createOnlineUI } = await import('../public/online-ui.js')
  const requests = []
  const request = async (method, pathname, body) => {
    requests.push({ method, pathname })
    const response = await fetch(halls[1].origin + '/api' + pathname, {
      method,
      headers: { 'x-boardgame-online': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    })
    const data = await response.json()
    if (data?.ok !== true) {
      const error = Object.assign(new Error(data?.error || 'HTTP ' + response.status), { status: response.status, code: data?.code, session: data?.session })
      throw error
    }
    return data
  }
  const state = { busy: false, chat: { pendings: [] }, catalog: [] }
  const ui = createOnlineUI({ state, render() {}, renderChrome() {}, loadGame() {}, request })
  await ui.boot()
  if (!state.session) throw new Error('boot 后应有会话')
  const bootRevision = state.session.state.revision
  console.log('[boot] revision', bootRevision, 'room', state.online?.room?.code, 'busy', state.online?.busy)

  // 房主走一步，让服务端 revision 前进；然后人为把客人本地做成「卡死」状态：
  // 旧 revision + busy 卡住 + 错误提示（模拟异常中断/丢快照）。
  const hostStatus = await onlineFetch(0, 'status')
  const hostSession = hostStatus.json.session
  const move = { x: hostSession.state.moveCount % 3, y: Math.floor(hostSession.state.moveCount / 3) % 3 }
  const moved = await onlineFetch(0, 'command', { action: 'move', body: { operationId: randomUUID(), move, revision: hostStatus.json.session.state.revision } })
  if (!moved.json.ok) throw new Error('host move: ' + moved.json.error)
  await waitFor(async () => (await onlineFetch(0, 'status')).json.session.state.revision > bootRevision)
  const serverRevision = (await onlineFetch(0, 'status')).json.session.state.revision
  // 卡死：本地停在旧 revision，标记 busy，聊天在途（正常情况下 accept 会因 chat.pendings 延迟应用）。
  state.session = { ...state.session, state: { ...state.session.state, revision: bootRevision } }
  state.busy = true
  state.chat.pendings = [{}]
  state.error = '对局版本已变化，请刷新后重试'
  const stuckBefore = state.session.state.revision
  console.log('[stuck] local revision', stuckBefore, 'server revision', serverRevision, 'busy', state.busy)

  const synced = await ui.forceResync()
  const checks = {
    synced,
    localRevision: state.session?.state?.revision,
    busy: state.busy,
    movePending: state.movePending,
    error: state.error,
    syncCommandSent: requests.some(item => item.method === 'POST' && item.pathname === '/online/command'),
    fullStatusSent: requests.some(item => item.pathname.startsWith('/online/status?full=1')),
  }
  console.log('[resync]', JSON.stringify(checks))
  const ok = synced === true && state.busy === false && state.error === null
    && state.session.state.revision >= serverRevision
    && checks.syncCommandSent && checks.fullStatusSent
  if (!ok) throw new Error('强制同步未恢复到服务端 revision')
  console.log('[verdict] FORCE RESYNC OK: 从本地 revision', stuckBefore, '恢复到', state.session.state.revision, '（服务端', serverRevision, '）')
  process.exitCode = 0
} catch (error) {
  console.error('[verdict] FAILED:', error?.stack || error)
  process.exitCode = 1
} finally {
  for (const hall of halls) await stop(hall.server)
  await stop(relay)
  fs.rmSync(home, { recursive: true, force: true })
  // boot() 的长轮询/定时器仍在跑：显式退出，避免脚本挂住。
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref?.()
}
