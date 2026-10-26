// A/B proof for the beneath-flicker root cause.
//
// Hypothesis: presentation checkpoint events (events[].presentation.tableState) are
// captured by captureTableState() which (v0.3.1 / server currently running) does NOT
// carry investigators[].beneath. table-presentation.js applyStep() merges that partial
// snapshot into the displayed state, replaces the investigator list, so the next
// render has no `beneath` array -> the whole .ah-beneath-row disappears until the
// presentation drain finishes and displayed = latest.
//
// MODE=control : server responses as shipped (checkpoints without beneath) -> flicker
// MODE=patched : Playwright rewrites checkpoint tableState.investigators[*].beneath
//                from the live session state (simulates the server-side fix) -> no flicker
//
// Usage: node .tmp-ui-bug/reports/beneath-ab.mjs control|patched [width] [height]
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const MODE = process.argv[2] === 'patched' ? 'patched' : 'control'
const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/reports/out'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const RUN = `${OUT}/ab-${MODE}-${stamp}`
mkdirSync(RUN, { recursive: true })
const width = Number(process.argv[3] || 1700)
const height = Number(process.argv[4] || 950)

const browser = await chromium.launch({ channel: 'msedge' })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

// ---- patched mode: rewrite presentation checkpoint snapshots on the wire ----
let patchStats = { responses: 0, eventsPatched: 0, beneathFound: 0 }
const patchPayload = (json) => {
  const sessions = []
  if (json?.session) sessions.push(json.session)
  if (json?.state?.investigators && json?.events) sessions.push(json)
  if (json?.sessions) sessions.push(...json.sessions)
  for (const s of sessions) {
    const beneathBySeat = new Map((s.state?.investigators || []).map(inv => [inv.seat, inv]))
    for (const event of s.events || []) {
      const snapshots = []
      if (event.tableState) snapshots.push(event.tableState)
      if (event.presentation?.tableState) snapshots.push(event.presentation.tableState)
      for (const snap of snapshots) {
        for (const inv of snap.investigators || []) {
          if (!('beneath' in inv)) patchStats.eventsPatched++
          const live = beneathBySeat.get(inv.seat)
          if (live) { inv.beneath = [...(live.beneath || [])]; inv.beneathCount = (live.beneath || []).length; patchStats.beneathFound++ }
        }
      }
    }
  }
  return json
}
if (MODE === 'patched') {
  await page.route('**/api/session*', async route => {
    try {
      const response = await route.fetch()
      const json = await response.json()
      patchStats.responses++
      patchPayload(json)
      await route.fulfill({ response, json })
    } catch (e) { console.error('patch session failed', e.message); await route.continue() }
  })
  await page.route('**/api/move', async route => {
    try {
      const response = await route.fetch()
      const json = await response.json()
      patchStats.responses++
      patchPayload(json)
      await route.fulfill({ response, json })
    } catch (e) { console.error('patch move failed', e.message); await route.continue() }
  })
}

const sleep = ms => page.waitForTimeout(ms)
const skipCinematics = async (limit = 40) => {
  for (let i = 0; i < limit; i++) {
    if (!(await page.locator('.ah-cinematic').count())) return
    const skip = page.getByRole('button', { name: '跳过演出' })
    if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
    await sleep(150)
  }
}

// ---- 1. real game, Sefina, place events beneath for real ----
await page.route('**/api/start', async route => {
  const postData = JSON.stringify({ modId: 'arkhamhorror', settings: {
    legacyAutoStart: true, playerCount: 1, playerInvestigator: '03003', seed: 'beneath-ab-' + MODE + '-' + Date.now() } })
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
  const r = await fetch('/api/session?sessionId=' + encodeURIComponent(id))
  return (await r.json()).session
}, sessionId)
let session = await fetchSession()
const state0 = {
  revision: session?.state?.revision,
  beneath: (session?.state?.investigators || []).map(inv => ({ seat: inv.seat, beneath: inv.beneath, beneathCount: inv.beneathCount })),
  pendingChoice: session?.state?.pendingChoice?.kind || null,
}
if (!state0.beneath?.[0]?.beneath?.length) throw new Error('no beneath cards for A/B test: ' + JSON.stringify(state0))

// ---- 2. instrumentation (frames + render hook) ----
await page.evaluate(() => {
  const mon = window.__mon = { frames: [], renders: [], marks: [], replaceHook: [] }
  const orig = Element.prototype.replaceChildren
  Element.prototype.replaceChildren = function (...nodes) {
    try {
      const findTable = n => n?.nodeType === 1 ? (n.matches?.('.ah-table') ? n : n.querySelector?.('.ah-table')) : null
      const table = nodes.map(findTable).find(Boolean)
      if (table) {
        const row = table.querySelector('.ah-beneath-row')
        const dock = table.querySelector('.ah-player-dock')
        const rec = {
          t: Math.round(performance.now()), revision: table.dataset.revision,
          hasBeneathRow: !!row, beneathCards: row?.querySelectorAll('.ah-minicard').length || 0,
          hasDock: !!dock, hasPlayerRegion: !!table.querySelector('.ah-table-player .ah-player-board'),
          status: table.querySelector('.bg-game-status')?.textContent?.slice(0, 40) || '',
          html: !row ? table.innerHTML.slice(0, 4000) : null,
          stack: !row ? (new Error().stack || '').split('\n').slice(1, 12).join(' | ') : null,
        }
        mon.renders.push(rec)
        if (!row) mon.replaceHook.push({ ...rec, innerLen: table.innerHTML.length })
      }
    } catch {}
    return orig.apply(this, nodes)
  }
  const loop = () => {
    try {
      const rows = document.querySelectorAll('.ah-beneath-row')
      const row = rows[0]
      const table = document.querySelector('.ah-table')
      const cards = row ? [...row.querySelectorAll('.ah-minicard')] : []
      mon.frames.push({
        t: Math.round(performance.now()), rows: rows.length,
        rev: table?.dataset?.revision ?? null,
        presenting: !!table?.classList?.contains('ah-presenting'),
        cinematic: document.querySelectorAll('.ah-cinematic').length,
        banner: document.querySelectorAll('.ah-fx-banner').length,
        cards: cards.map(c => ({
          interaction: c.dataset.interaction,
          artState: c.querySelector('.ah-table-art')?.dataset?.imageState ?? null,
          visible: getComputedStyle(c).visibility,
          rect: (() => { const r = c.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } })(),
        })),
      })
      if (mon.frames.length > 6000) mon.frames.splice(0, 1000)
    } catch {}
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
})
const mark = label => page.evaluate(label => window.__mon.marks.push({ label, t: Math.round(performance.now()) }), label)
const collect = () => page.evaluate(() => {
  const m = window.__mon
  return { frames: m.frames.splice(0), renders: m.renders.splice(0), marks: m.marks.splice(0) }
})

// ---- 3. leave the UI stale, produce several real server revisions, then refresh ----
const directMove = move => page.evaluate(async ({ sessionId, move }) => {
  const s = await (await fetch('/api/session?sessionId=' + encodeURIComponent(sessionId))).json()
  const revision = s.session.state.revision
  const r = await fetch('/api/move', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, revision, move }) })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok, error: j.error, revision: j.session?.state?.revision,
    pending: j.session?.state?.pendingChoice?.kind || null, events: j.session?.events?.length }
}, { sessionId, move })

session = await fetchSession()
const preferred = ['resource', 'draw', 'resource', 'endTurn', 'resource', 'draw']
const results = []
let cursor = 0
for (let round = 0; round < 8; round++) {
  session = await fetchSession()
  const st = session.state
  let move
  const pending = st.pendingChoice
  if (pending) {
    const doneOption = (pending.options || []).find(o => ['done', 'skip', 'confirm'].includes(String(o.id)))
      || (pending.options || [])[0]
    move = { action: 'choose', choiceId: pending.id, optionId: doneOption ? String(doneOption.id) : 'done' }
  } else {
    const legal = st.legalMoves || []
    // first unresolved preferred action
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
const staleRev = await page.evaluate(() => document.querySelector('.ah-table')?.revision || document.querySelector('.ah-table')?.dataset?.revision || null)
const serverNow = await fetchSession()

// ---- 4. trigger the UI refresh (this is what replays the missed checkpoints) ----
await mark('refresh')
const refreshBtn = page.locator('.bg-game-actions button[aria-label="刷新局势"]')
await refreshBtn.first().evaluate(el => el.click())
await sleep(5000)
const collected = await collect()
const realSession = await fetchSession()

// ---- 5. analyse row disappearance ----
const frames = collected.frames
const gaps = []
let absentSince = null
let prev = null
for (const f of frames) {
  if (prev && prev.rows > 0 && f.rows === 0) absentSince = { fromT: prev.t, toT: null, atRev: f.rev, presenting: f.presenting }
  if (absentSince && f.rows > 0 && absentSince.toT == null) { absentSince.toT = f.t; gaps.push(absentSince); absentSince = null }
  prev = f
}
if (absentSince) { absentSince.toT = frames.at(-1)?.t; gaps.push(absentSince) }
const rendersWithoutRow = collected.renders.filter(r => !r.hasBeneathRow)
const totalGapMs = gaps.reduce((sum, g) => sum + (g.toT - g.fromT), 0)
const result = {
  mode: MODE, sessionId, viewport: { width, height }, errors: errors.slice(0, 10),
  state0, moves: results, patchStats: MODE === 'patched' ? patchStats : null,
  staleUiRevision: staleRev, serverRevisionBeforeRefresh: serverNow.state.revision, serverRevisionAfterRefresh: realSession.state.revision,
  serverBeneathAfter: (realSession.state.investigators || []).map(inv => inv.beneath),
  frames: frames.length,
  renders: collected.renders.length,
  rendersWithoutBeneathRow: rendersWithoutRow.length,
  rendersWithoutBeneathRowSample: rendersWithoutRow.slice(0, 2).map(r => ({ t: r.t, revision: r.revision, status: r.status, hasDock: r.hasDock, hasPlayerRegion: r.hasPlayerRegion, stack: r.stack, detail: (() => {
    try {
      const html = r.html || ''
      const dockMatch = html.match(/ah-dock-kicker[\s\S]{0,120}/)
      return { kicker: dockMatch ? dockMatch[0].slice(0, 140) : null, len: html.length }
    } catch { return null }
  })() })),
  rowGaps: gaps,
  totalGapMs,
  framesRecords: frames.filter(f => f.t >= (gaps[0]?.fromT ?? 0) - 300 && f.t <= (gaps[0]?.toT ?? 0) + 400).slice(0, 40),
  marks: collected.marks,
}
writeFileSync(`${RUN}/result.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify({
  mode: MODE, sessionId, patchStats: result.patchStats, moves: results.map(r => ({ ok: r.res.ok, err: r.res.error, rev: r.res.revision, pending: r.res.pending })),
  state0, serverRev: result.serverRevisionAfterRefresh, serverBeneathAfter: result.serverBeneathAfter,
  renders: result.renders, rendersWithoutBeneathRow: result.rendersWithoutBeneathRow,
  gapCount: gaps.length, totalGapMs, gaps: gaps.slice(0, 6),
  hookSample: result.rendersWithoutBeneathRowSample,
  errors: result.errors,
}, null, 1))
console.log('out', RUN)
if (MODE === 'control') await page.screenshot({ path: `${RUN}/after-flicker.png` })
await browser.close()
