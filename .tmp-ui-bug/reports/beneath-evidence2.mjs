// Clean visual evidence: before / during-gap / after-gap full screenshots.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/reports/out'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const MODE = process.argv[4] === 'patched' ? 'patched' : 'control'
const RUN = `${OUT}/evidence2-${MODE}-${stamp}`
mkdirSync(RUN, { recursive: true })
const width = Number(process.argv[2] || 1700)
const height = Number(process.argv[3] || 950)

const patchStats = { responses: 0, snappedBeneath: 0 }
const patchPayload = (json) => {
  const sessions = []
  if (json?.session) sessions.push(json.session)
  if (json?.state?.investigators && json?.events) sessions.push(json)
  for (const s of sessions) {
    const live = new Map((s.state?.investigators || []).map(inv => [inv.seat, inv]))
    for (const event of s.events || []) {
      for (const snap of [event.tableState, event.presentation?.tableState]) {
        for (const inv of snap?.investigators || []) {
          const source = live.get(inv.seat)
          if (source) { inv.beneath = [...(source.beneath || [])]; inv.beneathCount = (source.beneath || []).length; patchStats.snappedBeneath++ }
        }
      }
    }
  }
  return json
}

const browser = await chromium.launch({ channel: 'msedge' })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
const page = await context.newPage()
if (MODE === 'patched') {
  await page.route('**/api/session*', async route => {
    try {
      const response = await route.fetch()
      const json = await response.json()
      patchStats.responses++
      patchPayload(json)
      await route.fulfill({ response, json })
    } catch { await route.continue() }
  })
  await page.route('**/api/move', async route => {
    try {
      const response = await route.fetch()
      const json = await response.json()
      patchStats.responses++
      patchPayload(json)
      await route.fulfill({ response, json })
    } catch { await route.continue() }
  })
}
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
    legacyAutoStart: true, playerCount: 1, playerInvestigator: '03003', seed: 'beneath-evidence2-' + Date.now() } })
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
const directMove = move => page.evaluate(async ({ sessionId, move }) => {
  const s = await (await fetch('/api/session?sessionId=' + encodeURIComponent(sessionId))).json()
  const r = await fetch('/api/move', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, revision: s.session.state.revision, move }) })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok, error: j.error, revision: j.session?.state?.revision, pending: j.session?.state?.pendingChoice?.kind || null }
}, { sessionId, move })
// 3 resources -> actions run out -> server auto-resolves end of turn + phases (multiple presentation cues)
const results = []
for (let i = 0; i < 3; i++) {
  const res = await directMove({ action: 'resource' })
  results.push(res)
  await sleep(120)
  if (!res.ok) break
}
session = await fetchSession()
const staleUiRev = await page.evaluate(() => document.querySelector('.ah-table')?.dataset?.revision)
const serverBefore = session
const beforeInfo = await page.evaluate(() => {
  const row = document.querySelector('.ah-beneath-row'); const bf = document.querySelector('.ah-equipment-battlefield')
  const rr = row?.getBoundingClientRect(); const br = bf?.getBoundingClientRect()
  return { row: !!row, cards: row?.querySelectorAll('.ah-minicard').length ?? 0,
    rowRect: rr ? { x: rr.x, y: rr.y, w: rr.width, h: rr.height } : null,
    bfRect: br ? { x: br.x, y: br.y, w: br.width, h: br.height } : null }
})
await page.screenshot({ path: `${RUN}/1-before-refresh.png` })
if (beforeInfo.rowRect) {
  await page.screenshot({ path: `${RUN}/1-before-refresh-crop.png`, clip: {
    x: Math.max(0, beforeInfo.rowRect.x - 40), y: Math.max(0, beforeInfo.rowRect.y - 20),
    width: Math.min(width - beforeInfo.rowRect.x + 40, beforeInfo.rowRect.w + 80), height: beforeInfo.rowRect.h + 40 } })
}
const refreshBtn = page.locator('.bg-game-actions button[aria-label="刷新局势"]')
await refreshBtn.first().evaluate(el => el.click())
const samples = []
let gapStart = null, gapEnd = null, gapCropShot = false
const clickAdvance = () => page.evaluate(() => {
  const texts = ['跳过演出', '继续', '下一幕', '确认', '开始']
  const btn = [...document.querySelectorAll('button')].find(b => !b.disabled &&
    texts.some(text => (b.textContent || '').trim().startsWith(text) || b.getAttribute('aria-label') === text))
  if (btn) { btn.click(); return (btn.textContent || '').trim().slice(0, 20) }
  return null
})
for (let i = 0; i < 200; i++) {
  const info = await page.evaluate(() => {
    const row = document.querySelector('.ah-beneath-row')
    const table = document.querySelector('.ah-table')
    const bf = document.querySelector('.ah-equipment-battlefield')
    const rr = row?.getBoundingClientRect(); const br = bf?.getBoundingClientRect()
    return { t: Math.round(performance.now()), row: !!row, cards: row?.querySelectorAll('.ah-minicard').length ?? 0,
      rowRect: rr ? { x: rr.x, y: rr.y, w: rr.width, h: rr.height } : null,
      bfRect: br ? { x: br.x, y: br.y, w: br.width, h: br.height } : null,
      rev: table?.dataset?.revision, presenting: !!table?.classList?.contains('ah-presenting'),
      phaseScene: document.querySelectorAll('.ah-phase-scene, .ah-cinematic').length,
      status: document.querySelector('.bg-game-status')?.textContent?.slice(0, 60) || '' }
  })
  samples.push(info)
  if (!gapStart && !info.row && beforeInfo.row) {
    gapStart = info
    await page.screenshot({ path: `${RUN}/2-during-gap.png` })
    if (info.bfRect) await page.screenshot({ path: `${RUN}/2-during-gap-crop.png`, clip: {
      x: Math.max(0, info.bfRect.x - 10), y: Math.max(0, info.bfRect.y - 10),
      width: Math.min(width - info.bfRect.x + 10, info.bfRect.w + 20), height: info.bfRect.h + 20 } })
    gapCropShot = true
  }
  if (gapStart && !gapEnd && info.row) {
    gapEnd = info
    await page.screenshot({ path: `${RUN}/3-after-gap.png` })
    if (info.rowRect) await page.screenshot({ path: `${RUN}/3-after-gap-crop.png`, clip: {
      x: Math.max(0, info.rowRect.x - 40), y: Math.max(0, info.rowRect.y - 20),
      width: Math.min(width - info.rowRect.x + 40, info.rowRect.w + 80), height: info.rowRect.h + 40 } })
  }
  if (gapEnd) break
  if (gapStart && !gapEnd) await clickAdvance().catch(() => null)
  await sleep(150)
}
const serverAfter = await fetchSession()
const out = { mode: MODE, patchStats: MODE === 'patched' ? patchStats : null, sessionId, beneath0, moves: results, staleUiRev,
  serverRevBeforeRefresh: serverBefore.state.revision, serverRevAfterRefresh: serverAfter.state.revision,
  serverBeneathAfter: serverAfter.state.investigators.map(inv => inv.beneath),
  before: beforeInfo, samples, gapStart, gapEnd, gapDurationMs: gapStart && gapEnd ? gapEnd.t - gapStart.t : null,
  gapCropShot, errors }
writeFileSync(`${RUN}/evidence.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ sessionId, beneath0, staleUiRev, serverRevBefore: out.serverRevBeforeRefresh, serverRevAfter: out.serverRevAfterRefresh,
  serverBeneathAfter: out.serverBeneathAfter, before: beforeInfo, gapStart, gapEnd, gapDurationMs: out.gapDurationMs,
  sampleCount: samples.length, errors }, null, 1))
console.log('out', RUN)
await browser.close()
