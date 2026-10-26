// Does the same flicker happen on a plain UI action (结束回合) rather than the refresh button?
// End turn auto-resolves enemy/upkeep/mythos phases -> a sequence of presentation cues is
// replayed while applyStep uses checkpoint snapshots that lack investigators[].beneath.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/reports/out'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const RUN = `${OUT}/uiturn-${stamp}`
mkdirSync(RUN, { recursive: true })
const width = Number(process.argv[2] || 1700)
const height = Number(process.argv[3] || 950)

const browser = await chromium.launch({ channel: 'msedge' })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
const sleep = ms => page.waitForTimeout(ms)
const skipCinematics = async (limit = 40) => {
  for (let i = 0; i < limit; i++) {
    if (!(await page.locator('.ah-cinematic').count())) return
    const skip = page.getByRole('button', { name: '跳过演出' })
    if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
    await sleep(150)
  }
}
await page.route('**/api/start', async route => {
  const postData = JSON.stringify({ modId: 'arkhamhorror', settings: {
    legacyAutoStart: true, playerCount: 1, playerInvestigator: '03003', seed: 'beneath-uiturn-' + Date.now() } })
  const response = await route.fetch({ postData })
  const body = await response.json()
  await route.fulfill({ response, json: body })
})
await page.goto(BASE + '/index.html')
await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
await page.getByRole('button', { name: '开始新游戏' }).click()
await page.waitForSelector('.ah-table', { timeout: 60000 })
await skipCinematics()
await sleep(500)
for (let round = 0; round < 10; round++) {
  const clicked = await page.evaluate(() => {
    const choice = document.querySelector('.ah-choice')
    if (!choice) return null
    const buttons = [...choice.querySelectorAll('button')].filter(b => !b.disabled)
    const clear = buttons.find(b => /完成下方事件选择/.test(b.textContent))
    const cand = buttons.find(b => !/完成|跳过|保留|确认/.test(b.textContent))
    if (cand) { cand.click(); return cand.textContent.trim().slice(0, 20) }
    if (clear) { clear.click(); return 'done' }
    return null
  })
  if (!clicked) break
  await sleep(500)
  await skipCinematics(8)
}
await sleep(1200)
const sessionId = await page.evaluate(() => { try { return localStorage.getItem('boardgame-hall.sessionId') } catch { return null } })
const fetchSession = () => page.evaluate(async id => {
  const r = await fetch('/api/session?sessionId=' + encodeURIComponent(id)); return (await r.json()).session
}, sessionId)
const session0 = await fetchSession()
const beneath0 = session0.state.investigators[0].beneath
await page.screenshot({ path: `${RUN}/1-before.png` })

// rAF sampler
await page.evaluate(() => {
  const mon = window.__mon = { frames: [] }
  const loop = () => {
    const row = document.querySelector('.ah-beneath-row')
    const table = document.querySelector('.ah-table')
    const rr = row?.getBoundingClientRect()
    mon.frames.push({ t: Math.round(performance.now()), row: !!row, cards: row?.querySelectorAll('.ah-minicard').length ?? 0,
      rowRect: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
      rev: table?.dataset?.revision, presenting: !!table?.classList?.contains('ah-presenting'),
      phaseScene: document.querySelectorAll('.ah-phase-scene, .ah-cinematic').length,
      status: document.querySelector('.bg-game-status')?.textContent?.slice(0, 50) || '' })
    if (mon.frames.length > 20000) mon.frames.splice(0, 2000)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
})

const endTurnClicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.ah-table button, .bg-game button')].find(b => /结束回合/.test(b.textContent) && !b.disabled)
  if (btn) { btn.click(); return true }
  return false
})
let duringShot = false
const startedAt = Date.now()
for (let i = 0; i < 140; i++) {
  await sleep(180)
  const state = await page.evaluate(() => ({ row: !!document.querySelector('.ah-beneath-row'),
    rowTop: document.querySelector('.ah-beneath-row')?.getBoundingClientRect().y ?? null,
    presenting: !!document.querySelector('.ah-table')?.classList?.contains('ah-presenting') }))
  if (!duringShot && !state.row) { duringShot = true; await page.screenshot({ path: `${RUN}/2-during.png` }) }
  if (Date.now() - startedAt > 20000) break
}
let stillMissing = await page.evaluate(() => !document.querySelector('.ah-beneath-row'))
if (stillMissing) {
  // let the reader finish the remaining cinematic
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => {
      const texts = ['跳过演出', '继续', '下一幕', '确认']
      const btn = [...document.querySelectorAll('button')].find(b => !b.disabled && texts.some(t => (b.textContent || '').trim().startsWith(t)))
      if (btn) btn.click()
    })
    await sleep(400)
    if (await page.evaluate(() => !!document.querySelector('.ah-beneath-row'))) break
  }
}
await sleep(500)
await page.screenshot({ path: `${RUN}/3-after.png` })
const frames = await page.evaluate(() => window.__mon.frames.splice(0))
const sessionAfter = await fetchSession()
const gaps = []
let prev = null, since = null
for (const f of frames) {
  if (prev && prev.row && !f.row) since = { fromT: prev.t, toT: null, atRev: f.rev, presenting: f.presenting, phaseScene: f.phaseScene }
  if (since && f.row && since.toT == null) { since.toT = f.t; gaps.push(since); since = null }
  prev = f
}
if (since) { since.toT = frames.at(-1)?.t; gaps.push(since) }
const out = { sessionId, beneath0, session0Rev: session0.state.revision, sessionAfterRev: sessionAfter.state.revision,
  endTurnClicked, frames: frames.length, framesWithoutRow: frames.filter(f => !f.row).length,
  gaps, totalGapMs: gaps.reduce((n, g) => n + (g.toT - g.fromT), 0),
  phasesDuringGap: gaps.length ? frames.filter(f => gaps.some(g => f.t >= g.fromT && f.t <= g.toT)).map(f => f.phaseScene).filter(Boolean).length : 0,
  statuses: [...new Set(frames.map(f => f.status))].slice(0, 12), errors }
writeFileSync(`${RUN}/uiturn.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 1))
console.log('out', RUN)
await browser.close()
