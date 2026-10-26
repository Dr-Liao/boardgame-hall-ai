// Dump mod asset URLs requested by the hall while starting a game.
import { chromium } from 'playwright'
const BASE = 'http://127.0.0.1:8799'
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const urls = []
page.on('request', r => { const u = r.url(); if (/arkhamhorror/.test(u) || /\.(css|js)(\?|$)/.test(u)) urls.push(r.method() + ' ' + u) })
let session
await page.route('**/api/start', async route => {
  const response = await route.fetch({ postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '05004', campaignId: 'thePathToCarcosa', seed: 'urls' } }) })
  const body = await response.json(); session = body.session
  await route.fulfill({ response, json: body })
})
await page.route('**/api/session?*', route => route.fulfill({ json: { ok: true, session } }))
await page.goto(BASE + '/index.html')
await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
await page.getByRole('button', { name: '开始新游戏' }).click()
await page.waitForSelector('.ah-table', { timeout: 90000 })
await page.waitForTimeout(1500)
console.log([...new Set(urls)].join('\n'))
await browser.close()
