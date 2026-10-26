// Verify dock avatar/gear alignment after CSS+DOM change.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/out'
mkdirSync(OUT, { recursive: true })
const avatarSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><circle cx='40' cy='34' r='18' fill='%23e8e8e8'/><circle cx='40' cy='34' r='8' fill='%23111'/></svg>"
let session
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
await page.route('**/api/start', async route => {
  const response = await route.fetch({ postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '01001', seed: 'ui-bug' } }) })
  const body = await response.json()
  session = body.session
  const s = session.state
  s.pendingChoice = null; s.currentSeat = 0; s.phase = 'investigation'; s.enemies = []
  const inv = s.investigators[0]
  inv.location = 'hallway'; inv.hand = ['01016', '01087', '01088', '01025', '01086']
  inv.resources = 7; inv.clues = 3; inv.beneath = ['01016']
  inv.assets = [{ id: 'beat-cop', code: '01018', exhausted: false }]
  s.legalMoves = []
  session.players[0].name = 'DrLiao'
  session.players[0].avatar = avatarSvg
  await route.fulfill({ response, json: body })
})
await page.route('**/api/session?*', route => route.fulfill({ json: { ok: true, session } }))
await page.goto(BASE + '/index.html')
await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
await page.getByRole('button', { name: '开始新游戏' }).click()
await page.waitForSelector('.ah-table', { timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (!(await page.locator('.ah-cinematic').count())) break
  const skip = page.getByRole('button', { name: '跳过演出' })
  if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
  await page.waitForTimeout(200)
}
await page.waitForTimeout(1200)
const measure = () => page.evaluate(() => {
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), cx: +(r.x + r.width / 2).toFixed(1), cy: +(r.y + r.height / 2).toFixed(1) } }
  const gear = document.querySelector('.ah-dock-investigator .ah-reaction-mode')
  const portrait = document.querySelector('.ah-dock-investigator .ah-dock-portrait')
  const row = document.querySelector('.ah-dock-name-row')
  const inv = document.querySelector('.ah-dock-investigator')
  return {
    gear: rect(gear), portrait: rect(portrait), row: rect(row), investigator: rect(inv),
    rowPaddingRight: row ? getComputedStyle(row).paddingRight : null,
    portraitDisplay: portrait ? getComputedStyle(portrait).display : null,
    portraitPos: portrait ? getComputedStyle(portrait).position : null,
    portraitHasImg: !!portrait?.querySelector('img'),
    portraitArtProbe: portrait?.querySelector('.ah-table-art')?.dataset.artCode,
  }
})
const results = {}
for (const [w, h] of [[1400, 950], [1700, 950], [1920, 1080], [1001, 900], [980, 900], [900, 900], [700, 900]]) {
  await page.setViewportSize({ width: w, height: h })
  await page.waitForTimeout(350)
  results[`${w}x${h}`] = await measure()
  const crop = { x: 0, y: Math.max(0, (results[`${w}x${h}`].investigator?.y || 0) - 30), width: Math.min(w, 700), height: 260 }
  await page.screenshot({ path: `${OUT}/dock-${w}.png`, clip: crop, animations: 'disabled' })
}
// retention + stability across render/refresh
await page.setViewportSize({ width: 1400, height: 950 }); await page.waitForTimeout(300)
const before = await measure()
await page.locator('.ah-timeline-toggle').first().evaluate(el => el.click())
await page.waitForTimeout(150)
const afterRender = await measure()
await page.getByRole('button', { name: '刷新局势' }).first().evaluate(el => el.click())
await page.waitForTimeout(250)
const afterRefresh = await measure()
writeFileSync(`${OUT}/dock-check.json`, JSON.stringify({ results, before, afterRender, afterRefresh, errors }, null, 2))
console.log(JSON.stringify({ results, errors, afterRefresh }, null, 1))
await browser.close()
