// Probe why presentation/p3 browser tests fail in the current worktree (concurrent WIP check).
import { chromium } from 'playwright'
const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
await page.goto(BASE + '/index.html')
await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
await page.waitForTimeout(800)
const combos = await page.locator('select').evaluateAll(els => els.map(el => ({ aria: el.getAttribute('aria-label'), name: el.name, options: el.options.length, text: [...el.options].slice(0, 3).map(o => o.textContent) })))
const region = await page.locator('.ah-hub-setup').count()
const buttons = await page.getByRole('button').evaluateAll(els => els.map(el => el.textContent.trim()).filter(Boolean).slice(0, 30))
// try starting a legacy auto session and see the intro overlay
await page.route('**/api/start', async route => {
  const body = route.request().postDataJSON()
  await route.continue({ postData: JSON.stringify({ ...body, settings: { ...body.settings, playerCount: 1, legacyAutoStart: true, seed: 'probe' } }) })
})
const start = page.getByRole('button', { name: '开始新游戏' })
if (await start.count()) await start.click()
await page.waitForTimeout(2500)
const table = await page.locator('.ah-table').count()
const cine = await page.locator('.ah-cinematic').count()
const cineKind = await page.locator('.ah-cinematic').first().getAttribute('data-title').catch(() => null)
console.log(JSON.stringify({ errors, setupRegion: region, combos, buttons, table, cine, cineKind }, null, 1))
await browser.close()
