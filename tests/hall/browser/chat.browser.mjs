// 战术讨论抽屉的浏览器回归（真实 Edge + 真实 HTTP + stub 模型）。
//
// 覆盖：刷新后自动续玩、公开/私聊渠道、AI 回复气泡、自动写入的战术备忘、
//       手动钉住、小屏铺满、以及"页面控制台零错误"（含 favicon 404 回归）。

import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const NOTE_TEXT = '先推进主线，小怪能躲就躲'

let stub = null
let hall = null
let home = null
let origin = null
let sessionId = null
const modelRequests = []
let slowChatRelease = null
let slowChatHeld = false

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

function startStub() {
  return http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload = null
      try { payload = JSON.parse(body) } catch { /* 保留 null */ }
      modelRequests.push(payload)
      const system = payload && Array.isArray(payload.messages) && payload.messages[0] ? String(payload.messages[0].content) : ''
      let content = '{"move":{"x":7,"y":7},"speech":"ok"}'
      if (system.includes('记忆整理助手')) content = '{"notes":[]}'
      else if (system.includes('【讨论规则】')) content = JSON.stringify({ reply: '明白，先推主线', memory: { add: [NOTE_TEXT] } })
      const prompt = Array.isArray(payload?.messages) ? payload.messages.map(message => String(message.content || '')).join('\n') : ''
      if (!slowChatHeld && system.includes('【讨论规则】') && prompt.includes('记住，以后优先推主线')) {
        slowChatHeld = true
        await new Promise(resolve => { slowChatRelease = resolve })
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'stub',
      }))
    })
  })
}

async function waitForHall(url) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url + '/api/catalog')).ok) return true } catch { /* 继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-chat-ui-'))
  stub = startStub()
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const stubUrl = 'http://127.0.0.1:' + stub.address().port + '/v1'

  const port = await freePort()
  origin = 'http://127.0.0.1:' + port
  hall = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DSH_HOME: home,
      BOARDGAME_PORT: String(port),
      BOARDGAME_HOST: '127.0.0.1',
      BOARDGAME_NO_OPEN: '1',
      AI_API_KEY: 'stub-key',
      AI_BASE_URL: stubUrl,
      AI_MODEL: 'stub',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  hall.stdout.resume()
  hall.stderr.resume()

  expect(await waitForHall(origin), '大厅必须在超时前启动').toBe(true)

  const started = await (await fetch(origin + '/api/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modId: 'gobang', settings: { firstMove: 'player', opponents: ['__random__'] } }),
  })).json()
  expect(started.ok, JSON.stringify(started)).toBe(true)
  sessionId = started.session.sessionId
})

test.afterAll(async () => {
  slowChatRelease?.()
  if (hall) hall.kill()
  if (stub) stub.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

test('战术讨论抽屉：自动续玩、公开/私聊、备忘写入与钉住', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push('console: ' + message.text()) })

  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.evaluate((id) => localStorage.setItem('boardgame-hall.sessionId', id), sessionId)
  await page.reload({ waitUntil: 'networkidle' })

  // 1) 刷新后应当自动回到对局页，并出现讨论入口
  await expect(page.locator('.bg-chat-fab')).toBeVisible()

  // 2) 抽屉与渠道页签
  await page.click('.bg-chat-fab')
  await expect(page.locator('.bg-chat-drawer')).toBeVisible()
  await expect(page.locator('.bg-chat-tab', { hasText: '公开桌聊' })).toBeVisible()
  await expect(page.locator('.bg-chat-tab', { hasText: '🔒' }).first()).toBeVisible()

  // 3) 公开桌聊：发言 + AI 回复
  await page.fill('.bg-chat-input', '记住，以后优先推主线')
  await page.click('.bg-chat-send')
  await expect(page.locator('.bg-chat-msg-me')).toHaveCount(1)
  await expect(page.locator('.bg-chat-msg-pending')).toContainText('记住，以后优先推主线')
  await expect(page.locator('.bg-chat-pending-label')).toHaveText('发送中…')
  await expect(page.locator('.bg-chat-msg-ai')).toHaveCount(0)
  await expect.poll(() => typeof slowChatRelease).toBe('function')
  slowChatRelease()
  slowChatRelease = null
  await expect(page.locator('.bg-chat-msg-ai')).toHaveCount(1)
  await expect(page.locator('.bg-chat-msg-me')).toHaveCount(1)
  await expect(page.locator('.bg-chat-msg-ai')).toContainText('明白，先推主线')

  // 4) 自动写入的战术备忘应当出现在备忘面板里
  const noteRows = page.locator('.bg-chat-note')
  await expect(noteRows).toHaveCount(1)
  await expect(noteRows.first()).toContainText(NOTE_TEXT)
  await expect(noteRows.first()).toContainText('队伍')

  // 5) 玩家气泡上有手动钉住入口
  await expect(page.locator('.bg-chat-pin')).toHaveCount(1)

  // 6) 私聊渠道：切换后是空态，发一条能收到回复
  await page.locator('.bg-chat-tab', { hasText: '🔒' }).first().click()
  await expect(page.locator('.bg-chat-empty')).toContainText('私聊内容其它 AI 看不到')
  await page.fill('.bg-chat-input', '私底下告诉你：我打算走中路')
  await page.click('.bg-chat-send')
  await expect(page.locator('.bg-chat-msg')).toHaveCount(2)

  // 7) 手动钉住：备忘条数 +1
  await page.locator('.bg-chat-pin').first().click()
  await expect(noteRows).toHaveCount(2)

  // 8) 小屏适配：抽屉铺满
  await page.setViewportSize({ width: 420, height: 820 })
  const width = await page.locator('.bg-chat-drawer').evaluate((el) => el.getBoundingClientRect().width)
  expect(width).toBeGreaterThanOrEqual(400)

  // 9) 控制台必须零错误（顺带守住 favicon 404 这类回归）
  expect(errors, errors.join('\n')).toEqual([])
})
test('模型设置：高级参数可见、可保存并生效', async ({ page }) => {
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.click('.bg-settings-btn')
  await page.locator('.bg-tab', { hasText: '模型连接' }).click()
  await expect(page.locator('.bg-advanced')).toBeVisible()
  await expect(page.locator('input[aria-label="maxTurnCalls"]')).toBeVisible()
  await expect(page.locator('input[aria-label="temperature"]')).toBeVisible()
  await page.fill('input[aria-label="maxTurnCalls"]', '7')
  await page.click('button:has-text("💾 保存")')
  await expect(page.locator('.bg-model-result.ok')).toContainText('已保存')
  const config = await (await fetch(origin + '/api/config')).json()
  expect(config.maxTurnCalls).toBe(7)
})

test('玩家名称：保存、刷新、对局显示和 AI 请求使用同一名称', async ({ page }) => {
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.click('.bg-settings-btn')
  await page.getByRole('button', { name: '👤 玩家', exact: true }).click()
  await expect(page.getByLabel('玩家名称', { exact: true })).toHaveValue('player')
  const name = '星河 <队长>'
  await page.getByLabel('玩家名称', { exact: true }).fill(name)
  await page.getByRole('button', { name: '💾 保存玩家资料', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已保存')
  await page.reload({ waitUntil: 'networkidle' })
  await page.click('.bg-settings-btn')
  await page.getByRole('button', { name: '👤 玩家', exact: true }).click()
  await expect(page.getByLabel('玩家名称', { exact: true })).toHaveValue(name)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const started = await (await fetch(origin + '/api/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modId: 'gobang', settings: { firstMove: 'player', opponents: ['__random__'] } }),
  })).json()
  expect(started.session.players[0].name).toBe(name)
  await page.evaluate(id => localStorage.setItem('boardgame-hall.sessionId', id), started.session.sessionId)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('.bg-chip-name').first()).toHaveText(name)
  await page.click('.bg-chat-fab')
  await page.fill('.bg-chat-input', '你好')
  await page.click('.bg-chat-send')
  await expect(page.locator('.bg-chat-msg-ai')).toHaveCount(1)
  await expect(page.locator('.bg-chat-msg-me .bg-chat-msg-name')).toHaveText(name)
  const request = modelRequests.findLast(p => p?.messages?.[0]?.content.includes('【讨论规则】'))
  expect(request.messages.map(m => m.content).join('\n')).toContain(name)
})
