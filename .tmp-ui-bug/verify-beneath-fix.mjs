// Verify the beneath fix end-to-end at the client layer:
// - tableState shaped like the fixed captureTableState (has beneath) -> row must stay;
// - tableState shaped like the old captureTableState (no beneath) -> row drops (old bug).
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

async function runCheckpointVariant({ withBeneath, addHand }) {
  // fresh observer + poller
  await page.evaluate(() => {
    window.__log = []
    if (window.__poll) clearInterval(window.__poll)
    let last = document.querySelectorAll('.ah-beneath-row').length
    window.__poll = setInterval(() => {
      const count = document.querySelectorAll('.ah-beneath-row').length
      if (count !== last) { window.__log.push({ t: Math.round(performance.now()), count }); last = count }
    }, 15)
  })
  const tableState = await page.evaluate(async ({ id, withBeneath, addHand }) => {
    const payload = await fetch('/api/session?sessionId=' + encodeURIComponent(id)).then(r => r.json())
    const copy = JSON.parse(JSON.stringify(payload.session.state))
    for (const inv of copy.investigators) {
      delete inv.deckSize
      if (!withBeneath) { delete inv.beneath; delete inv.beneathCount }
      else { inv.beneath = ['01016', '01087']; inv.beneathCount = 2 }
      if (addHand) inv.hand = [...inv.hand, '01016']
    }
    return copy
  }, { id: session.sessionId, withBeneath, addHand })
  const events = session.events || []
  const nextSeq = Math.max(-1, ...events.map(e => e.seq ?? -1)) + 1
  session.events = [...events, { seq: nextSeq, type: 'presentation', kind: 'checkpoint', tableState, inferReveals: false }]
  session.state.revision = (session.state.revision || 0) + 1
  await page.getByRole('button', { name: '刷新局势' }).first().evaluate(el => el.click())
  await page.waitForTimeout(1600)
  return page.evaluate(() => { clearInterval(window.__poll); return window.__log })
}

const fixed = await runCheckpointVariant({ withBeneath: true, addHand: true })
await page.waitForTimeout(500)
const old = await runCheckpointVariant({ withBeneath: false, addHand: true })
writeFileSync(`${OUT}/beneath-fix-verify.json`, JSON.stringify({ fixed, old, errors }, null, 2))
console.log(JSON.stringify({
  errors,
  fixed: { drops: fixed.filter(e => e.count === 0).length, log: fixed },
  old: { drops: old.filter(e => e.count === 0).length, log: old },
}, null, 1))
await browser.close()
