// Visual evidence for the beneath-row flicker (control mode, real server).
// Same trigger as beneath-ab.mjs control: leave the UI stale, produce several real
// server revisions, then click 刷新局势 and screenshot the table every 150ms.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/reports/out'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const RUN = `${OUT}/evidence-${stamp}`
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
    legacyAutoStart: true, playerCount: 1, playerInvestigator: '03003', seed: 'beneath-evidence-' + Date.now() } })
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
let session = await fetchSession()
const beneath0 = session.state.investigators[0].beneath
if (!beneath0?.length) throw new Error('no beneath')

// produce missed revisions while the UI is stale
const directMove = move => page.evaluate(async ({ sessionId, move }) => {
  const s = await (await fetch('/api/session?sessionId=' + encodeURIComponent(sessionId))).json()
  const r = await fetch('/api/move', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, revision: s.session.state.revision, move }) })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok, error: j.error, revision: j.session?.state?.revision, pending: j.session?.state?.pendingChoice?.kind || null }
}, { sessionId, move })
const preferred = ['resource', 'draw', 'resource', 'endTurn', 'resource', 'draw']
const results = []
let cursor = 0
for (let round = 0; round < 8; round++) {
  session = await fetchSession()
  const st = session.state
  let move
  if (st.pendingChoice) {
    const opt = (st.pendingChoice.options || []).find(o => ['done', 'skip', 'confirm'].includes(String(o.id))) || (st.pendingChoice.options || [])[0]
    move = { action: 'choose', choiceId: st.pendingChoice.id, optionId: opt ? String(opt.id) : 'done' }
  } else {
    const legal = st.legalMoves || []
    while (cursor < preferred.length && !legal.some(m => m.action === preferred[cursor])) cursor++
    if (cursor >= preferred.length) break
    move = { action: preferred[cursor] }
  }
  const res = await directMove(move)
  results.push({ move, res })
  await sleep(120)
  if (!res.ok) break
  if (results.length >= 6) break
}
const serverBefore = await fetchSession()
const staleUiRev = await page.evaluate(() => document.querySelector('.ah-table')?.dataset?.revision)

// click refresh, sample every 150ms
const refreshBtn = page.locator('.bg-game-actions button[aria-label="刷新局势"]')
await refreshBtn.first().evaluate(el => el.click())
const samples = []
for (let i = 0; i < 45; i++) {
  const info = await page.evaluate(() => {
    const row = document.querySelector('.ah-beneath-row')
    const table = document.querySelector('.ah-table')
    const bf = document.querySelector('.ah-equipment-battlefield')
    const rr = row?.getBoundingClientRect()
    const bfr = bf?.getBoundingClientRect()
    const t = Math.round(performance.now())
    return { t, row: !!row, cards: row?.querySelectorAll('.ah-minicard').length ?? 0,
      rowRect: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
      bfRect: bfr ? { x: Math.round(bfr.x), y: Math.round(bfr.y), w: Math.round(bfr.width), h: Math.round(bfr.height) } : null,
      rev: table?.dataset?.revision, presenting: !!table?.classList?.contains('ah-presenting'),
      status: document.querySelector('.bg-game-status')?.textContent?.slice(0, 60) || '',
      artStates: row ? [...row.querySelectorAll('.ah-table-art')].map(a => a.dataset.imageState) : [],
    }
  })
  samples.push(info)
  const name = `f${String(i).padStart(2, '0')}-${info.row ? 'row' : 'NOROW'}`
  await page.screenshot({ path: `${RUN}/${name}.png`, clip: info.row && info.bfRect
    ? { x: Math.max(0, info.bfRect.x - 10), y: Math.max(0, info.bfRect.y - 10), width: Math.min(width - 10, info.bfRect.w + 20), height: Math.min(height - 10, info.bfRect.h + 20) }
    : { x: 0, y: 300, width, height: Math.min(height - 300, 450) } })
  if (i === 0) await page.screenshot({ path: `${RUN}/full-before.png` })
  await sleep(150)
}
const serverAfter = await fetchSession()
await page.screenshot({ path: `${RUN}/full-after.png` })
const gaps = []
let prev = null, since = null
for (const sample of samples) {
  if (prev && prev.row && !sample.row) since = { fromT: prev.t, toT: null, atRev: sample.rev, presenting: sample.presenting }
  if (since && sample.row && since.toT == null) { since.toT = sample.t; gaps.push(since); since = null }
  prev = sample
}
if (since) { since.toT = samples.at(-1)?.t; gaps.push(since) }
const out = { sessionId, beneath0, moves: results.map(r => ({ ok: r.res.ok, rev: r.res.revision, pending: r.res.pending, err: r.res.error })),
  staleUiRev, serverRevBeforeRefresh: serverBefore.state.revision, serverRevAfterRefresh: serverAfter.state.revision,
  serverBeneathAfter: serverAfter.state.investigators.map(inv => inv.beneath), samples, gaps,
  gapSamples: samples.filter(s => gaps.some(g => s.t >= g.fromT && s.t <= g.toT)), errors }
writeFileSync(`${RUN}/evidence.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ sessionId, beneath0, staleUiRev, serverRevBeforeRefresh: out.serverRevBeforeRefresh, serverRevAfterRefresh: out.serverRevAfterRefresh,
  serverBeneathAfter: out.serverBeneathAfter, gapCount: gaps.length, gaps,
  files: samples.map((s, i) => `f${String(i).padStart(2, '0')}-${s.row ? 'row' : 'NOROW'}.png`), errors }, null, 1))
console.log('out', RUN)
await browser.close()
