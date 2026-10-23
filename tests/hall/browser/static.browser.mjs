// P1.4 浏览器回归（fixture-static 测试 Mod）：
//   - 联机对局在「静态表只发一次 + 浏览器 hydrate」下正常渲染、落子、同步；
//   - 客人刷新页面（浏览器内存缓存丢失）后，guest 大厅用本地缓存的静态表补发，棋盘仍完整渲染；
//   - ?perf=1 观测到首份 status 带数组（大），之后命中版本的 status 明显变小。
//
// 运行：node node_modules/@playwright/test/cli.js test --config tests/hall/playwright.config.mjs
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRelay } from '../../../relay/server.js'
import { createServer } from '../../../lib/server.js'
import { loadTestMods } from '../helpers/mods.mjs'

let relay, relayUrl, halls = [], home, previousHome
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))
const stop = server => new Promise(r => { server.stopRelay?.(); server.online?.close(); server.closeAllConnections(); server.close(r) })
async function api(index, route, body) {
  return (await fetch(halls[index].url + '/api/online/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })).json()
}
const command = (index, action, body = {}) => api(index, 'command', { action, body: { operationId: randomUUID(), ...body } })

test.beforeAll(async () => {
  previousHome = process.env.DSH_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-static-browser-'))
  process.env.DSH_HOME = home
  const mods = await loadTestMods()
  relay = createRelay(); relayUrl = await listen(relay)
  for (let i = 0; i < 2; i++) {
    const server = createServer({ mods, persist: false }); await server.ready
    halls.push({ server, url: await listen(server) })
  }
})
test.afterAll(async () => {
  await Promise.all(halls.map(hall => stop(hall.server))); await stop(relay)
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})
test.afterEach(async () => { for (let i = 0; i < 2; i++) await api(i, 'leave', {}).catch(() => {}) })

test('静态表 hydrate 后联机棋局正常渲染，客人刷新由 guest 大厅补发静态表', async ({ browser }) => {
  const created = await api(0, 'create', { relayUrl, modId: 'fixture-static', capacity: 2, fillAi: false })
  expect(created.ok, created.error).toBe(true)
  expect((await api(1, 'join', { relayUrl, code: created.room.code })).ok).toBe(true)
  await api(1, 'ready', { ready: true })
  const started = await command(0, 'start')
  expect(started.ok, started.error).toBe(true)

  const host = await browser.newPage(), guest = await browser.newPage(), errors = []
  for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message))
  await host.goto(halls[0].url + '?perf=1')
  await guest.goto(halls[1].url + '?perf=1')

  // 视图（含公共静态表 hydrate）正常渲染出 3×3 棋盘。
  await expect(host.locator('.bg-cell')).toHaveCount(9)
  await expect(guest.locator('.bg-cell')).toHaveCount(9)

  // 双方交替落子：每次 action 后 revision 变化，浏览器用精简视图 + 静态表继续渲染。
  await host.locator('.bg-cell').nth(0).click()
  await expect(guest.locator('.bg-cell-black')).toHaveCount(1)
  await guest.locator('.bg-cell').nth(1).click()
  await expect(host.locator('.bg-cell-white')).toHaveCount(1)

  // P1.4 wire 证据：首份 status 带 static 信封（fixture-static 公共表约 36KB），命中版本后的 status 很小。
  const statusBytes = await guest.evaluate(() => window.__ONLINE_PERF__.requests
    .filter(request => request.path.startsWith('/online/status')).map(request => request.bytes))
  expect(statusBytes.length).toBeGreaterThan(1)
  expect(Math.max(...statusBytes)).toBeGreaterThan(25 * 1024)
  expect(Math.min(...statusBytes)).toBeLessThan(8 * 1024)

  // 浏览器刷新会丢掉内存里的静态表：由 guest 大厅缓存补发后必须仍完整渲染同一棋局。
  await guest.reload()
  await expect(guest.locator('.bg-cell-black')).toHaveCount(1)
  await expect(guest.locator('.bg-cell-white')).toHaveCount(1)
  // 刷新后回合仍在房主：房主继续落子，客人的 hydrate 视图继续通过快照更新。
  await host.locator('.bg-cell').nth(2).click()
  await expect(guest.locator('.bg-cell-black')).toHaveCount(2)

  expect(errors).toEqual([])
  await host.close(); await guest.close()
})
