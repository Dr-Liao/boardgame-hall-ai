// 大厅设置页回归：顶层页签合并 + 页签无 emoji。
//
// 覆盖（本次改版验收）：
//   1. 顶层页签固定 5 个（玩家/AI/联机/大厅更新/语言），顺序固定、不含 emoji，默认选中 AI；
//      footer 不再有「反馈」入口（反馈只保留大厅右上角与对局标题栏）；
//   2. AI 页签内的二级页签（AI 角色/模型连接/AI 指标）可切换，模型表单与指标面板仍可用；
//      「新增 AI」只在 AI 角色子页签出现，指标面板自带刷新/清空、footer 不再重复刷新；
//   3. 390px 窄屏下 AI 页签与二级页签不横向溢出；英文语言下页签文案同步且无 emoji。
//
// 运行：npx playwright test --config tests/hall/playwright.config.mjs settings.browser.mjs
// （channel msedge，不下载额外浏览器）
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../lib/server.js'
import { loadTestMods } from '../helpers/mods.mjs'

const EMOJI = /\p{Extended_Pictographic}/u
// 「大厅更新」页签在有可用更新时会追加 " •"；那是环境信号，不该让页签文案断言随机失败。
const tabTexts = (labels) => labels.map((label) => label.trim().replace(/\s*•$/, ''))

let server, origin, home, previousHome

const listen = (target) => new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + target.address().port)))
const stop = async (target) => {
  target.closeAllConnections?.()
  await new Promise((resolve) => target.close(resolve))
}
const postSettings = async (locale) => {
  const response = await fetch(origin + '/api/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale }),
  })
  return response.json()
}

const openSettings = async (page) => {
  await page.locator('.bg-settings-btn').click()
  await expect(page.locator('.bg-modal')).toBeVisible()
}

test.beforeAll(async () => {
  previousHome = process.env.DSH_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-settings-browser-'))
  process.env.DSH_HOME = home
  server = createServer({ mods: await loadTestMods(), persist: false })
  await server.ready
  origin = await listen(server)
})

test.afterAll(async () => {
  if (server) await stop(server)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

// 语言偏好是服务端全局设置，用例之间必须隔离回简体中文。
test.beforeEach(async () => {
  const saved = await postSettings('zh-CN')
  expect(saved.ok, saved.error).toBe(true)
})

test('设置页签：合并为 5 个顶层页签、无 emoji、默认停在 AI', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(origin, { waitUntil: 'networkidle' })
  await openSettings(page)

  const labels = tabTexts(await page.locator('.bg-tabs .bg-tab').allTextContents())
  expect(labels).toEqual(['玩家', 'AI', '联机', '大厅更新', '语言'])
  expect(labels.filter((label) => EMOJI.test(label))).toEqual([])
  // AI 角色 / 模型连接 / AI 指标已合并，不再作为顶层页签出现。
  expect(labels).not.toContain('AI 角色')
  expect(labels).not.toContain('模型连接')
  expect(labels).not.toContain('AI 指标')

  await expect(page.locator('.bg-tab-active')).toHaveText('AI')
  expect(await page.locator('.bg-subtab').allTextContents()).toEqual(['AI 角色', '模型连接', 'AI 指标'])
  await expect(page.locator('.bg-subtab-active')).toHaveText('AI 角色')
  await expect(page.locator('.bg-ai-list')).toBeVisible()
  // 设置里不再有「反馈」按钮（反馈入口只在大厅右上角与对局标题栏）。
  await expect(page.locator('.bg-modal > .bg-modal-foot button', { hasText: '反馈' })).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('AI 页签：三个二级页签可切换，模型表单 / 指标面板 / 新增 AI 按上下文出现', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(origin, { waitUntil: 'networkidle' })
  await openSettings(page)

  // AI 角色：列表 + footer「新增 AI」，不显示模型表单。
  await expect(page.locator('.bg-modal > .bg-modal-foot button', { hasText: '新增 AI' })).toHaveCount(1)
  await expect(page.locator('.bg-advanced')).toHaveCount(0)

  // 模型连接：高级参数与 API 地址/密钥/模型输入框可见；footer 不再显示「新增 AI」。
  await page.locator('.bg-subtab', { hasText: '模型连接' }).click()
  await expect(page.locator('.bg-advanced')).toBeVisible()
  await expect(page.locator('input[aria-label="API 地址"]')).toHaveCount(1)
  await expect(page.locator('input[aria-label="API 密钥"]')).toHaveCount(1)
  await expect(page.locator('input[aria-label="模型"]')).toHaveCount(1)
  await expect(page.locator('.bg-modal > .bg-modal-foot button', { hasText: '新增 AI' })).toHaveCount(0)

  // AI 指标：面板自己带刷新/清空（footer 不重复刷新），footer 只剩「关闭」。
  await page.locator('.bg-subtab', { hasText: 'AI 指标' }).click()
  await expect(page.locator('.bg-stats-grid')).toBeVisible()
  await expect(page.locator('.bg-modal > .bg-modal-foot > button')).toHaveCount(1)
  const subLabels = await page.locator('.bg-subtab').allTextContents()
  expect(subLabels.filter((label) => EMOJI.test(label))).toEqual([])

  // 切回 AI 角色仍正常（二级页签状态独立于顶层页签）。
  await page.locator('.bg-subtab', { hasText: 'AI 角色' }).click()
  await expect(page.locator('.bg-ai-list')).toBeVisible()
  await expect(page.locator('.bg-modal > .bg-modal-foot button', { hasText: '新增 AI' })).toHaveCount(1)

  expect(pageErrors).toEqual([])
})

test('390px 与英文：页签不横向溢出、英文文案无 emoji', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin, { waitUntil: 'networkidle' })
  await openSettings(page)

  const noOverflow = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.evaluate(() => {
      const modal = document.querySelector('.bg-modal')
      return modal.scrollWidth <= modal.clientWidth + 1
    })).toBe(true)
  }
  await noOverflow()
  await page.locator('.bg-subtab', { hasText: '模型连接' }).click()
  await noOverflow()
  await page.locator('.bg-subtab', { hasText: 'AI 指标' }).click()
  await noOverflow()

  // 切换英文：顶层页签文案同步，且仍不含 emoji；语言页签保持在最后。
  const english = await postSettings('en')
  expect(english.ok, english.error).toBe(true)
  await page.reload({ waitUntil: 'networkidle' })
  await openSettings(page)
  const labels = tabTexts(await page.locator('.bg-tabs .bg-tab').allTextContents())
  expect(labels).toEqual(['Player', 'AI', 'Online', 'Hall updates', 'Language'])
  expect(labels.filter((label) => EMOJI.test(label))).toEqual([])
  await expect(page.locator('.bg-tab-active')).toHaveText('AI')
  expect(await page.locator('.bg-subtab').allTextContents()).toEqual(['AI characters', 'Model', 'AI metrics'])
  await noOverflow()
})
