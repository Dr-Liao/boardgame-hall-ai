// 大厅浏览器端 i18n 回归（docs/localization.md §14.3）：
//   1. 设置 → 语言 → English：界面立即英文（页签/按钮/说明/标题/<html lang>），弹窗不关闭；
//   2. 刷新页面仍是英文（settings.json 持久化），切回简体中文恢复且无控制台报错；
//   3. fixture-i18n：目录/描述/设置标签英文 + game.i18n.files；切换语言调用 onLocaleChange，
//      文本更新、对局不重置（页面不刷新、棋盘仍在、locale-changes 递增）；
//   4. 只有 nameEn 的旧 Mod：名称为英文，描述/设置仍中文，catalog 标记 fellBack / legacy-name；
//   5. 390px 英文设置页不横向溢出。
//
// 运行：npx playwright test --config tests/hall/playwright.config.mjs i18n.browser.mjs
// （沙箱下若 Playwright/Edge 启动报 EPERM，属于环境限制；文件本身按 §14.3 交付）
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../lib/server.js'
import { loadTestMods } from '../helpers/mods.mjs'

let server, origin, home, previousHome

const listen = (target) => new Promise((resolve) => target.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + target.address().port)))
const stop = async (target) => {
  target.closeAllConnections?.()
  await new Promise((resolve) => target.close(resolve))
}
const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options })
  return response.json()
}
const postSettings = (locale) => fetchJson(origin + '/api/settings', { method: 'POST', body: JSON.stringify({ locale }) })
const getSettings = () => fetchJson(origin + '/api/settings')
const getCatalog = () => fetchJson(origin + '/api/catalog')

/** 设置弹窗 → 最后一个页签（语言，允许当前界面语言下文案不同） → 等语言下拉出现。 */
async function openLanguageTab(page) {
  await page.locator('.bg-settings-btn').click()
  await page.locator('.bg-tabs .bg-tab').last().click()
  await expect(page.locator('[data-testid="hall-locale"]')).toBeVisible()
}

test.beforeAll(async () => {
  previousHome = process.env.DSH_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-i18n-browser-'))
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

// 每个用例都从简体中文开始：语言偏好是服务端全局设置，用例之间必须隔离。
test.beforeEach(async () => {
  const saved = await postSettings('zh-CN')
  expect(saved.ok, saved.error).toBe(true)
})

test('设置 → 语言：切换 English 立即生效、刷新保持、切回简体中文恢复', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.goto(origin)
  await expect(page.locator('.bg-head h1')).toHaveText('🎲 桌游大厅')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

  await openLanguageTab(page)
  const localeSelect = page.locator('[data-testid="hall-locale"]')
  await expect(localeSelect).toHaveValue('zh-CN')
  await expect(page.locator('.bg-modal h2')).toHaveText('⚙️ 设置')

  // 选择 English：无需刷新立即生效，弹窗保持打开、仍停在语言页签。
  await localeSelect.selectOption('en')
  await expect(page.locator('.bg-modal h2')).toHaveText('⚙️ Settings')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page).toHaveTitle('Board Game Hall')
  await expect(page.locator('.bg-tab-active')).toContainText('Language')
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  await expect(page.locator('.bg-modal')).toBeVisible()
  await expect(localeSelect).toHaveValue('en')
  await expect(localeSelect.locator('option:checked')).toHaveText('English')
  expect((await getSettings()).settings.locale).toBe('en')

  // 刷新后仍英文（settings.json 持久化）。
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('.bg-head h1')).toHaveText('🎲 Board Game Hall')
  await openLanguageTab(page)
  await expect(page.locator('.bg-modal h2')).toHaveText('⚙️ Settings')
  await expect(page.locator('[data-testid="hall-locale"]')).toHaveValue('en')

  // 切回简体中文：中文恢复，无控制台报错。
  await page.locator('[data-testid="hall-locale"]').selectOption('zh-CN')
  await expect(page.locator('.bg-modal h2')).toHaveText('⚙️ 设置')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page).toHaveTitle('桌游大厅')
  await expect(page.locator('[data-testid="hall-locale"]')).toHaveValue('zh-CN')
  expect((await getSettings()).settings.locale).toBe('zh-CN')

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('fixture-i18n：目录/设置元数据英文，切换语言触发 onLocaleChange 且不重置对局', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const english = await postSettings('en')
  expect(english.ok, english.error).toBe(true)

  // 服务端已解析结果：名称/描述/标签/设置项英文，i18n 带 files 与 resolved。
  const catalog = await getCatalog()
  const fixture = catalog.games.find((game) => game.id === 'fixture-i18n')
  expect(fixture.name).toBe('Localization Fixture')
  expect(fixture.description).toContain('3×3 test game')
  expect(fixture.tags).toEqual(['Test', 'Localization'])
  expect(fixture.i18n.resolved).toBe('en')
  expect(fixture.i18n.fellBack).toBe(false)
  expect(fixture.i18n.files.en).toBe('/mods/fixture-i18n/locales/en.js')
  expect(fixture.i18n.files['zh-CN']).toBe('/mods/fixture-i18n/locales/zh-CN.js')
  expect(fixture.settingsSpec.find((spec) => spec.key === 'mode').label).toBe('Game mode')

  // 大厅 UI：卡片与开局表单跟随英文。
  await page.goto(origin)
  await expect(page.locator('.bg-card-name', { hasText: 'Localization Fixture' })).toBeVisible()
  await page.locator('.bg-card', { hasText: 'Localization Fixture' }).click()
  await expect(page.locator('.bg-modal h2')).toHaveText('Start game · Localization Fixture')
  await expect(page.locator('.bg-modal .bg-desc')).toContainText('3×3 test game')
  await expect(page.locator('.bg-modal .bg-field label', { hasText: 'Game mode' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  // 单人开局（hideOpponentSettings，playerCount=1 没有 AI），并用 localStorage 恢复对局视图。
  const started = await fetchJson(origin + '/api/start', {
    method: 'POST',
    body: JSON.stringify({ modId: 'fixture-i18n', settings: { playerCount: 1 } }),
  })
  expect(started.ok, started.error).toBe(true)
  await page.evaluate((id) => localStorage.setItem('boardgame-hall.sessionId', id), started.session.sessionId)
  await page.reload()

  const title = page.locator('[data-testid="fixture-i18n-title"]')
  const locale = page.locator('[data-testid="fixture-i18n-locale"]')
  const changes = page.locator('[data-testid="fixture-i18n-locale-changes"]')
  const game = page.locator('[data-testid="fixture-i18n-game"]')
  await expect(game).toBeVisible()
  await expect(title).toHaveText('Localization Fixture')
  await expect(locale).toHaveText('en')
  await expect(changes).toHaveText('0')

  // 已开局时通过同一保存流程切换语言（设置页在对局中不可达，用例直接调用 app.js 导出的 saveLocale）。
  await page.evaluate(() => { window.__i18nNoReload = true })
  await page.evaluate(async () => {
    const app = await import('/app.js')
    await app.saveLocale('zh-CN')
  })
  await expect(title).toHaveText('本地化测试棋局')
  await expect(locale).toHaveText('zh-CN')
  await expect(changes).toHaveText('1')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  // onLocaleChange 只重绘：页面没有刷新、对局没有被重置。
  expect(await page.evaluate(() => window.__i18nNoReload)).toBe(true)
  await expect(game).toBeVisible()
  await expect(page.locator('[data-testid="fixture-i18n-cell-0-0"]')).toBeVisible()

  // 再切回 English：onLocaleChange 幂等，计数继续递增。
  await page.evaluate(async () => {
    const app = await import('/app.js')
    await app.saveLocale('en')
  })
  await expect(title).toHaveText('Localization Fixture')
  await expect(locale).toHaveText('en')
  await expect(changes).toHaveText('2')

  expect(pageErrors).toEqual([])
})

test('只有 nameEn 的旧 Mod：名称英文化、描述/设置仍中文、catalog 标记回退', async ({ page }) => {
  const english = await postSettings('en')
  expect(english.ok, english.error).toBe(true)

  const catalog = await getCatalog()
  const gobang = catalog.games.find((game) => game.id === 'gobang')
  expect(gobang.name).toBe('Gobang')
  expect(gobang.i18n.matched).toBe('legacy-name')
  expect(gobang.i18n.fellBack).toBe(true)
  // 旧 Mod 没有 i18n：只有名称用 nameEn，描述/设置项保持基础中文。
  expect(gobang.description).toContain('五子连珠')

  await page.goto(origin)
  await expect(page.locator('.bg-card-name', { hasText: 'Gobang' })).toBeVisible()
  await page.locator('.bg-card', { hasText: 'Gobang' }).click()
  await expect(page.locator('.bg-modal h2')).toHaveText('Start game · Gobang')
  await expect(page.locator('.bg-modal .bg-desc')).toContainText('五子连珠')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('390px 英文设置页不横向溢出', async ({ page }) => {
  const english = await postSettings('en')
  expect(english.ok, english.error).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin)
  await expect(page.locator('.bg-head h1')).toHaveText('🎲 Board Game Hall')

  await openLanguageTab(page)
  await expect(page.locator('.bg-modal h2')).toHaveText('⚙️ Settings')
  await expect(page.locator('[data-testid="hall-locale"]')).toHaveValue('en')
  // 页面与弹窗都不能横向滚动（英文文案比中文长 30%–60%）。
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await page.evaluate(() => {
    const modal = document.querySelector('.bg-modal')
    return modal.scrollWidth <= modal.clientWidth + 1
  })).toBe(true)
})
