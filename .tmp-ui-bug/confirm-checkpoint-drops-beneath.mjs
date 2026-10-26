// Confirm: checkpoint presentation tableState (captureTableState-style, no beneath)
// keeps an intermediate render on screen long enough for the 下方 row to visibly vanish.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/out'
mkdirSync(OUT, { recursive: true })
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
  inv.resources = 7; inv.clues = 3; inv.beneath = ['01016', '01087']
  inv.assets = [{ id: 'beat-cop', code: '01018', exhausted: false }]
  s.legalMoves = []
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

await page.evaluate(() => {
  window.__beneathLog = []
  let last = document.querySelectorAll('.ah-beneath-row').length
  window.__beneathPoll = setInterval(() => {
    const count = document.querySelectorAll('.ah-beneath-row').length
    if (count !== last) {
      window.__beneathLog.push({ t: Math.round(performance.now()), count, presenting: document.querySelector('.ah-table')?.classList.contains('ah-presenting') || false })
      last = count
    }
  }, 15)
})

// mimic captureTableState: no beneath/beneathCount/deckSize; one new hand card to animate a draw.
const checkpointState = await page.evaluate(async id => {
  const payload = await fetch('/api/session?sessionId=' + encodeURIComponent(id)).then(r => r.json())
  const copy = JSON.parse(JSON.stringify(payload.session.state))
  for (const inv of copy.investigators) {
    delete inv.beneath; delete inv.beneathCount; delete inv.deckSize
    inv.hand = [...inv.hand, '01016']
  }
  return copy
}, session.sessionId)
const events = session.events || []
const nextSeq = Math.max(-1, ...events.map(e => e.seq ?? -1)) + 1
session.events = [...events, { seq: nextSeq, type: 'presentation', kind: 'checkpoint', tableState: checkpointState, inferReveals: false }]
session.state.revision = (session.state.revision || 0) + 1
await page.getByRole('button', { name: '刷新局势' }).first().evaluate(el => el.click())
const frames = []
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(80)
  frames.push(await page.evaluate(() => ({
    beneath: document.querySelectorAll('.ah-beneath-row').length,
    presenting: document.querySelector('.ah-table')?.classList.contains('ah-presenting') || false,
    hand: document.querySelectorAll('.ah-hand-card').length,
  })))
}
const log = await page.evaluate(() => { clearInterval(window.__beneathPoll); return window.__beneathLog })
writeFileSync(`${OUT}/checkpoint-flicker.json`, JSON.stringify({ log, frames, errors }, null, 2))
console.log(JSON.stringify({ log, errors, minBeneath: Math.min(...frames.map(f => f.beneath)), framesWithDrop: frames.filter(f => f.beneath === 0).length, frames: frames.length }, null, 1))
await browser.close()
