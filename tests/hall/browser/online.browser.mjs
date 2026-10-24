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
  return (await fetch(halls[index].url + '/api/online/' + route, { method: body ? 'POST' : 'GET', headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json()
}
const command = (index, action, body = {}) => api(index, 'command', { action, body: { operationId: randomUUID(), ...body } })
test.beforeAll(async () => {
  previousHome = process.env.DSH_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-online-browser-')); process.env.DSH_HOME = home
  const mods = await loadTestMods()
  relay = createRelay(); relayUrl = await listen(relay)
  for (let i = 0; i < 2; i++) {
    const server = createServer({ mods, persist: i === 0 }); await server.ready
    halls.push({ server, url: await listen(server) })
  }
})
test.afterAll(async () => {
  await Promise.all(halls.map(h => stop(h.server))); await stop(relay)
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})
test.afterEach(async () => { for (let i = 0; i < 2; i++) await api(i, 'leave', {}) })

test('two players create/join in the hall, alternate turns, chat and refresh', async ({ browser }) => {
  const host = await browser.newPage(), guest = await browser.newPage()
  const errors = []
  for (const page of [host, guest]) page.on('pageerror', e => errors.push(e.message))
  await host.goto(halls[0].url)
  await host.locator('.bg-settings-btn').click()
  await host.getByRole('button', { name: '联机', exact: true }).click()
  await host.getByRole('textbox', { name: '中转服务地址' }).fill(relayUrl)
  await host.getByRole('button', { name: '保存联机设置' }).click()
  await host.getByRole('button', { name: '关闭', exact: true }).click()
  await host.locator('.bg-card', { hasText: '井字棋' }).click()
  await host.getByRole('button', { name: '联机房间', exact: true }).click()
  await expect(host.getByRole('textbox', { name: '中转服务地址' })).toHaveCount(0)
  await expect(host.getByRole('combobox', { name: '席位数量' })).toHaveCount(1)
  await host.getByRole('button', { name: '开始对局', exact: true }).click()
  await expect(host.getByRole('heading', { name: '等待玩家加入' })).toBeVisible()
  const code = (await api(0, 'status')).room.code
  await guest.goto(halls[1].url)
  await guest.getByRole('button', { name: '加入联机房间', exact: true }).click()
  await guest.getByRole('textbox', { name: '房间码或完整邀请' }).fill(`BGH1 ${relayUrl} ${code}`)
  await guest.getByRole('button', { name: '加入房间', exact: true }).click()
  await guest.getByRole('button', { name: '准备', exact: true }).click()
  await expect(host.getByRole('button', { name: '开始联机对局' })).toBeEnabled()
  await host.getByRole('button', { name: '开始联机对局' }).click()
  await expect(host.locator('.bg-cell')).toHaveCount(9)
  await expect(guest.locator('.bg-cell').first()).toBeDisabled()
  await host.locator('.bg-cell').nth(0).click()
  await expect(guest.locator('.bg-cell').nth(1)).toBeEnabled()
  await guest.locator('.bg-cell').nth(1).click()
  await expect(host.locator('.bg-cell-white')).toHaveCount(1)
  await guest.getByRole('button', { name: '打开战术讨论' }).click()
  await guest.getByRole('textbox', { name: '战术讨论输入' }).fill('第二位玩家的消息')
  await guest.getByRole('button', { name: '发送', exact: true }).click()
  await expect(guest.locator('.bg-chat-msg-me')).toContainText('第二位玩家的消息')
  await guest.reload()
  await expect(guest.locator('.bg-cell-white')).toHaveCount(1)
  await expect(guest.getByRole('button', { name: '再来一局' })).toBeDisabled()
  await host.screenshot({ path: 'artifacts/online-room-game.png', fullPage: true })
  await host.getByRole('button', { name: '解散房间' }).click()
  await expect(guest.getByRole('heading', { name: '🎲 桌游大厅' })).toBeVisible()
  expect(errors).toEqual([])
  await host.close(); await guest.close()
})

test('browser peers exchange moves and snapshots directly, then fall back when a peer tab closes', async ({ browser }) => {
  const created = await api(0, 'create', { relayUrl, modId: 'ox', capacity: 2, fillAi: false })
  expect(created.ok, created.error).toBe(true)
  await api(1, 'join', { relayUrl, code: created.room.code }); await api(1, 'ready', { ready: true })
  const host = await browser.newPage(), guest = await browser.newPage(), errors = []
  for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message))
  // ?perf=1：读取直连命令的浏览器侧耗时（P2/P3 直连出口口径）。
  await host.goto(halls[0].url + '?perf=1'); await guest.goto(halls[1].url + '?perf=1')
  await expect(guest.locator('.bg-online-banner')).toContainText('直连', { timeout: 30000 })
  await expect(host.locator('.bg-online-banner')).toContainText('直连 1 人')
  const started = await command(0, 'start')
  expect(started.ok, started.error).toBe(true)
  await expect(guest.locator('.bg-cell')).toHaveCount(9)
  const before = { ...halls[0].server.online.metrics }
  await host.locator('.bg-cell').nth(0).click()
  await expect(guest.locator('.bg-cell-black')).toHaveCount(1)
  await guest.locator('.bg-cell').nth(1).click()
  await expect(host.locator('.bg-cell-white')).toHaveCount(1)
  // P2.3：直连命令等待本地 revision 由快照/长轮询事件唤醒，不再每 100ms 轮询 /online/status。
  const p2pStats = await guest.evaluate(() => window.__P2P_STATS__ || null)
  expect(p2pStats).toBeTruthy()
  expect(p2pStats.waits + p2pStats.resolvedImmediately).toBeGreaterThan(0)
  expect(p2pStats.timeouts).toBe(0)
  expect(p2pStats.fallbackStatusFetches).toBe(0)
  // P1.2/P3：直连命令回包应是 slim 摘要，命令结果里不再携带整份视图。
  const directCommands = await guest.evaluate(() => (window.__ONLINE_PERF__?.commands || [])
    .filter(command => command.transport === 'direct'))
  expect(directCommands.length, JSON.stringify(directCommands)).toBeGreaterThan(0)
  expect(Math.max(...directCommands.map(command => command.ms))).toBeLessThan(300)
  console.log('[direct] 浏览器侧直连命令耗时(ms):', directCommands.map(command => command.ms).join(','))
  expect(halls[0].server.online.metrics.directBytes).toBeGreaterThan(before.directBytes)
  expect(halls[0].server.online.metrics.sentBytes).toBe(before.sentBytes, 'game snapshots should bypass the relay while directly connected')
  await host.close()
  await expect(guest.locator('.bg-online-banner')).toContainText('中转', { timeout: 15000 })
  const hostMove = await command(0, 'move', { revision: 2, move: { x: 0, y: 1 } })
  expect(hostMove.ok, hostMove.error).toBe(true)
  await expect(guest.locator('.bg-cell-black')).toHaveCount(2)
  expect(halls[0].server.online.metrics.sentBytes).toBeGreaterThan(before.sentBytes, 'relay resumes after the direct peer closes')
  expect(errors).toEqual([])
  await guest.close()
})

test('generic setup reserves AI slots and copying an invitation never shifts the room layout', async ({ browser }) => {
  const host = await browser.newPage(), errors = []
  host.on('pageerror', error => errors.push(error.message))
  await host.goto(halls[0].url)
  await host.locator('.bg-settings-btn').click()
  await host.getByRole('button', { name: '联机', exact: true }).click()
  await host.getByRole('textbox', { name: '中转服务地址' }).fill(relayUrl)
  await host.getByRole('button', { name: '保存联机设置' }).click()
  await host.getByRole('button', { name: '关闭', exact: true }).click()
  await host.reload()
  await host.locator('.bg-card', { hasText: '测试牌局' }).click()
  await host.getByRole('button', { name: '联机房间', exact: true }).click()
  await expect(host.getByRole('textbox', { name: '中转服务地址' })).toHaveCount(0)
  await expect(host.getByRole('combobox', { name: '席位数量' })).toHaveCount(1)
  await host.getByRole('combobox', { name: '席位数量' }).selectOption('4')
  await host.getByRole('combobox', { name: '席位 2', exact: true }).selectOption('ai-hu')
  await host.getByRole('combobox', { name: '席位 4', exact: true }).selectOption('ai-mei')
  await host.screenshot({ path: 'artifacts/online-unified-setup.png', fullPage: true })
  await host.getByRole('button', { name: '开始对局', exact: true }).click()
  await expect(host.getByRole('heading', { name: '等待玩家加入' })).toBeVisible()
  await expect(host.locator('[data-room-seat="1"]')).toContainText('才羽绿')
  await expect(host.locator('[data-room-seat="1"]')).toContainText('玩家不可加入')
  await expect(host.getByRole('button', { name: '开始联机对局' })).toBeDisabled()
  const status = await api(0, 'status')
  expect(status.relayUrl).toContain(relayUrl.replace('http:', 'ws:'))
  await host.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.testInvite = text } } }))
  for (const width of [1400, 390]) {
    await host.setViewportSize({ width, height: 950 })
    const copy = host.getByRole('button', { name: '复制邀请', exact: true })
    const before = { copy: await copy.boundingBox(), banner: await host.locator('.bg-online-banner').boundingBox(), room: await host.locator('.bg-online-room').boundingBox() }
    await copy.click()
    await expect(host.getByText('邀请已复制，发给朋友后在大厅粘贴加入。')).toBeVisible()
    expect(await copy.boundingBox()).toEqual(before.copy)
    expect(await host.locator('.bg-online-banner').boundingBox()).toEqual(before.banner)
    expect(await host.locator('.bg-online-room').boundingBox()).toEqual(before.room)
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await host.screenshot({ path: `artifacts/online-room-${width}.png`, fullPage: true })
  }
  expect(await host.evaluate(() => window.testInvite)).toContain(status.room.code)
  await host.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } }))
  await host.getByRole('button', { name: '复制邀请', exact: true }).click()
  await expect(host.getByRole('dialog', { name: '手动复制邀请' })).toBeVisible()
  await expect(host.getByRole('textbox', { name: '邀请内容' })).toHaveValue(`BGH1 ${status.relayUrl} ${status.room.code}`)
  await host.getByRole('button', { name: '关闭', exact: true }).click()
  const joined = await api(1, 'join', { relayUrl, code: status.room.code })
  expect(joined.room.members.find(m => m.id === joined.memberId).seat).toBe(2)
  await api(1, 'ready', { ready: true })
  await expect(host.getByRole('button', { name: '开始联机对局' })).toBeEnabled()
  expect(errors).toEqual([])
  await host.close()
})
