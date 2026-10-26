// Quick debug: start a TCU session and report flow state.
import { chromium } from 'playwright'
const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1632, height: 800 } })
let session
await page.route('**/api/start', async route => {
  const response = await route.fetch({ postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '05004', campaignId: 'thePathToCarcosa', seed: 'dbg2' } }) })
  const body = await response.json()
  session = body.session
  await route.fulfill({ response, json: body })
})
await page.route('**/api/session?*', route => route.fulfill({ json: { ok: true, session } }))
await page.goto(BASE + '/index.html')
await page.locator('.bg-card').filter({ hasText: '璇￠晣濂囪皥' }).click()
await page.getByRole('button', { name: '寮€濮嬫柊娓告垙' }).click()
await page.waitForTimeout(2500)
console.log('session keys', Object.keys(session || {}))
const st = session?.state || {}
console.log('hubFlow', JSON.stringify(st.hubFlow), 'uiState', st.uiState, 'scenario', JSON.stringify(st.scenario && { name: st.scenario.name, id: st.scenario.id }))
console.log('investigators', JSON.stringify((st.investigators || []).map(i => ({ code: i.code, name: i.name, seat: i.seat }))))
console.log('hasTable', await page.locator('.ah-table').count(), 'hasHub', await page.locator('.ah-hub').count(), 'bodyText', (await page.evaluate(() => document.body.innerText)).slice(0, 600).replace(/\n+/g, ' | '))
console.log('buttons', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 30))))
console.log('state keys', Object.keys(st).join(','))
console.log('cards has 05004?', !!(st.cards && st.cards['05004']), 'def', JSON.stringify(st.cards?.['05004'] && { name: st.cards['05004'].name, hasReactionPrompt: st.cards['05004'].hasReactionPrompt, hasAutoReaction: st.cards['05004'].hasAutoReaction }))
await browser.close()

