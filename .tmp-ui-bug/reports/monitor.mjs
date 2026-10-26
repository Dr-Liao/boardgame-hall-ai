// Real-browser dynamic monitor for the beneath-row flicker.
// Resumes a REAL hall session (server-side, has cards beneath the investigator),
// then instruments every frame / DOM mutation while we exercise refresh paths.
//
// Usage:
//   node .tmp-ui-bug/reports/monitor.mjs [sessionId|-] [width] [height]
// If no sessionId (or resume fails), it starts a fresh real game with Sefina (03003)
// and answers her openingHand choice so several cards end up beneath her.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/reports/out'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const RUN = `${OUT}/monitor-${stamp}`
mkdirSync(RUN, { recursive: true })
const sessionIdArg = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null
const width = Number(process.argv[3] || 1700)
const height = Number(process.argv[4] || 950)
const STEP_MS = Number(process.env.STEP_MS || 1600)

const browser = await chromium.launch({ channel: 'msedge' })
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
if (sessionIdArg) {
  await context.addInitScript(id => { try { localStorage.setItem('boardgame-hall.sessionId', id) } catch {} }, sessionIdArg)
}
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()) })

const out = { sessionId: null, mode: null, viewport: { width, height }, errors, steps: [] }
const sleep = ms => page.waitForTimeout(ms)
const skipCinematics = async (limit = 30) => {
  for (let i = 0; i < limit; i++) {
    if (!(await page.locator('.ah-cinematic').count())) return
    const skip = page.getByRole('button', { name: '跳过演出' })
    if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
    await sleep(150)
  }
}
const serverSession = () => page.evaluate(async id => {
  const r = await fetch('/api/session?sessionId=' + encodeURIComponent(id))
  const j = await r.json()
  const s = j.session
  if (!s) return { error: j.error || 'no session' }
  return {
    revision: s.state.revision, phase: s.state.phase, currentSeat: s.state.currentSeat,
    pendingChoice: s.state.pendingChoice ? { kind: s.state.pendingChoice.kind, options: s.state.pendingChoice.options?.length } : null,
    beneath: (s.state.investigators || []).map(inv => ({ seat: inv.seat, code: inv.code, beneath: inv.beneath || [], beneathCount: inv.beneathCount, hand: inv.hand?.length })),
    status: s.state.status,
  }
}, out.sessionId)

// ---------- 1. reach a live table with beneath cards ----------
await page.goto(BASE + '/index.html')
await sleep(1800)
let tableReady = await page.locator('.ah-table').count()
if (!tableReady) {
  await page.route('**/api/start', async route => {
    const postData = JSON.stringify({ modId: 'arkhamhorror', settings: {
      legacyAutoStart: true, playerCount: 1, playerInvestigator: '03003', seed: 'beneath-monitor-' + Date.now() } })
    const response = await route.fetch({ postData })
    const body = await response.json()
    await route.fulfill({ response, json: body })
  })
  await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
  await page.getByRole('button', { name: '开始新游戏' }).click()
  await page.waitForSelector('.ah-table', { timeout: 60000 })
  out.mode = 'fresh-start'
  out.sessionId = await page.evaluate(() => { try { return localStorage.getItem('boardgame-hall.sessionId') } catch { return null } })
  await skipCinematics()
  await sleep(600)
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
  await sleep(900)
} else {
  out.mode = 'resume'
  out.sessionId = sessionIdArg
}
out.sessionId ||= await page.evaluate(() => { try { return localStorage.getItem('boardgame-hall.sessionId') } catch { return null } })
if (!out.sessionId) { console.error('NO SESSION'); await browser.close(); process.exit(2) }
out.state0 = await serverSession()

// ---------- 2. in-page instrumentation ----------
await page.evaluate(() => {
  const mon = window.__mon = { frames: [], events: [], markers: [] }
  const esc = el => {
    if (!el) return null
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
    return { tag: el.tagName?.toLowerCase(), cls, interaction: el.closest?.('[data-interaction]')?.dataset?.interaction || null }
  }
  const describeNode = node => {
    if (!node || node.nodeType !== 1) return null
    const row = node.matches?.('.ah-beneath-row') ? node : node.querySelector?.('.ah-beneath-row')
    const table = node.matches?.('.ah-table') ? node : node.querySelector?.('.ah-table')
    return { row: !!row, table: !!table, tag: node.tagName?.toLowerCase(), cls: typeof node.className === 'string' ? node.className.slice(0, 80) : '' }
  }
  const rec = (kind, extra) => {
    mon.events.push({ t: Math.round(performance.now()), kind, ...extra })
    if (mon.events.length > 20000) mon.events.splice(0, 2000)
  }
  const mo = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'attributes') {
        const target = r.target
        if (target.closest?.('.ah-beneath-row') || target.matches?.('.ah-beneath-row')) {
          rec('attr', { attr: r.attributeName, value: target.getAttribute?.(r.attributeName)?.slice?.(0, 120), node: esc(target) })
        }
        continue
      }
      for (const n of r.removedNodes) {
        const d = describeNode(n)
        if (d?.row || d?.table) rec('removed', d)
      }
      for (const n of r.addedNodes) {
        const d = describeNode(n)
        if (d?.row) {
          const row = n.matches?.('.ah-beneath-row') ? n : n.querySelector('.ah-beneath-row')
          rec('beneathRowAdded', { count: row?.dataset?.beneathCount, cards: row?.querySelectorAll('.ah-minicard').length })
        }
        if (d?.table) {
          const table = n.matches?.('.ah-table') ? n : n.querySelector('.ah-table')
          const row = table?.querySelector('.ah-beneath-row')
          rec('tableAdded', { revision: table?.dataset?.revision, hasBeneathRow: !!row, beneathCount: row?.dataset?.beneathCount ?? null, cards: row?.querySelectorAll('.ah-minicard').length ?? null })
        }
      }
    }
  })
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-image-state', 'data-beneath-count'] })
  const rectObj = r => r ? { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +(r.x + r.width).toFixed(1), bottom: +(r.y + r.height).toFixed(1) } : null
  const snap = () => {
    const frame = { t: Math.round(performance.now()), vp: { w: innerWidth, h: innerHeight } }
    const rows = document.querySelectorAll('.ah-beneath-row')
    frame.rows = rows.length
    const table = document.querySelector('.ah-table')
    frame.rev = table?.dataset?.revision ?? null
    frame.presenting = !!table?.classList?.contains('ah-presenting')
    frame.cinematic = document.querySelectorAll('.ah-cinematic').length
    frame.banner = document.querySelectorAll('.ah-fx-banner').length
    frame.choice = document.querySelectorAll('.ah-choice').length
    const row = rows[0]
    if (row) {
      const rs = getComputedStyle(row)
      frame.row = {
        rect: rectObj(row.getBoundingClientRect()), display: rs.display, visibility: rs.visibility,
        opacity: rs.opacity, height: rs.height, width: rs.width,
        style: row.getAttribute('style'), cls: row.className, dataCount: row.dataset.beneathCount,
      }
      const cards = [...row.querySelectorAll('.ah-minicard')]
      frame.cards = cards.map(card => {
        const cs = getComputedStyle(card)
        const art = card.querySelector('.ah-table-art')
        const img = art?.querySelector('img')
        const r = card.getBoundingClientRect()
        const covers = (r.x + r.width / 2 > 0 && r.y + r.height / 2 > 0 && r.x + r.width / 2 < innerWidth && r.y + r.height / 2 < innerHeight)
          ? document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2) : []
        return {
          rect: rectObj(r), interaction: card.dataset.interaction, code: card.dataset.cardCode,
          visibility: cs.visibility, opacity: cs.opacity, display: cs.display,
          artState: art?.dataset?.imageState ?? null,
          img: img ? { complete: img.complete, nw: img.naturalWidth, hidden: img.hidden, src: (img.currentSrc || img.src || '').slice(-44) } : null,
          cover: covers.slice(0, 3).map(esc),
          coverInside: covers.length ? card.contains(covers[0]) : null,
        }
      })
      const bf = document.querySelector('.ah-equipment-battlefield')
      if (bf) {
        const br = bf.getBoundingClientRect()
        frame.bf = { rect: rectObj(br), scrollLeft: bf.scrollLeft, scrollWidth: bf.scrollWidth, clientWidth: bf.clientWidth }
        frame.rowInBf = !!(frame.row.rect && frame.row.rect.right > br.left + 1 && frame.row.rect.x < br.right - 1 &&
          frame.row.rect.bottom > br.y + 1 && frame.row.rect.y < br.bottom - 1)
      }
    }
    return frame
  }
  const loop = () => {
    try { mon.frames.push(snap()) } catch (e) { mon.events.push({ t: Math.round(performance.now()), kind: 'snapError', message: String(e) }) }
    if (mon.frames.length > 40000) mon.frames.splice(0, 4000)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
})

const mark = (label) => page.evaluate(label => { window.__mon.markers.push({ label, t: Math.round(performance.now()) }) }, label)
const collect = () => page.evaluate(() => {
  const m = window.__mon
  return { frames: m.frames.splice(0), events: m.events.splice(0), markers: m.markers.splice(0) }
})

// ---------- 3. helpers ----------
const refreshBtn = () => page.locator('.bg-game-actions button[aria-label="刷新局势"]')
const clickRefresh = async () => {
  const btn = refreshBtn()
  if (await btn.count()) await btn.first().evaluate(el => el.click())
}
const clickByText = async (text, root = '.ah-table-actions') => page.evaluate(({ text, root }) => {
  const scope = document.querySelector(root) || document.querySelector('.ah-table')
  const btn = [...scope.querySelectorAll('button')].find(b => b.textContent.includes(text) && !b.disabled)
  if (!btn) return false
  btn.click(); return true
}, { text, root })
const selectEntity = async selector => page.evaluate(selector => {
  const el = document.querySelector(selector)
  if (!el) return false
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 }
  el.dispatchEvent(new PointerEvent('pointerdown', opts))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(new PointerEvent('pointerup', opts))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', opts))
  return true
}, selector)
const directMove = async (move) => page.evaluate(async ({ sessionId, move }) => {
  const s = await (await fetch('/api/session?sessionId=' + encodeURIComponent(sessionId))).json()
  const revision = s.session.state.revision
  const r = await fetch('/api/move', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, revision, move }) })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok, error: j.error, revision: j.session?.state?.revision, pending: j.session?.state?.pendingChoice?.kind || null }
}, { sessionId: out.sessionId, move })

const ANOMALY_KINDS = {
  rowGone: 'rowGone', rowHidden: 'rowHidden', rowOutsideBf: 'rowOutsideBf', bfScrolled: 'bfScrolled',
  cardHidden: 'cardHidden', cardViewportClip: 'cardViewportClip', cardCovered: 'cardCovered',
  artRetentionLost: 'artRetentionLost', renderWithoutBeneathRow: 'renderWithoutBeneathRow',
  rowRebuilt: 'rowRebuilt', artInitialPending: 'artInitialPending',
}

const analyzeStep = (step, collected) => {
  const frames = collected.frames
  const result = { label: step.label, frames: frames.length, renders: 0, beneathRowAdded: 0, beneathRowRemoved: 0,
    rowStates: [], anomalyCounts: {}, anomalies: [], renderRevisions: [], tableEvents: [], attrEvents: [] }
  const addAnomaly = (kind, sample) => {
    result.anomalyCounts[kind] = (result.anomalyCounts[kind] || 0) + 1
    const limit = kind === 'artInitialPending' ? 0 : 4
    if ((result.anomalies.filter(a => a.kind === kind).length) < limit) result.anomalies.push({ kind, ...sample })
  }
  const show = f => `${f.rows ? 'row' : 'none'}${f.rows ? '/' + (f.cards?.length ?? '?') : ''}${f.row?.dataCount != null ? '#' + f.row.dataCount : ''}`
  let lastSig = null
  const prevArt = new Map() // interaction -> artState
  let lastRows = 0
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const sig = show(f)
    if (sig !== lastSig) { result.rowStates.push({ t: f.t, sig, rev: f.rev, presenting: f.presenting, cinematic: f.cinematic }); lastSig = sig }
    if (f.rows > lastRows) result.beneathRowAdded += f.rows - lastRows
    if (f.rows < lastRows) result.beneathRowRemoved += lastRows - f.rows
    lastRows = f.rows
    if (i > 0 && frames[i - 1].rows > 0 && f.rows === 0) {
      addAnomaly('rowGone', { t: f.t, prevRev: frames[i - 1].rev, rev: f.rev, presenting: f.presenting, cinematic: f.cinematic })
    }
    if (f.rows > 0) {
      const rs = f.row
      if (rs.display === 'none' || rs.visibility === 'hidden' || Number(rs.opacity) < 0.99) {
        addAnomaly('rowHidden', { t: f.t, display: rs.display, visibility: rs.visibility, opacity: rs.opacity, style: rs.style })
      }
      if (f.rowInBf === false) addAnomaly('rowOutsideBf', { t: f.t, row: rs.rect, bf: f.bf })
      if (f.bf && f.bf.scrollLeft !== 0) addAnomaly('bfScrolled', { t: f.t, scroll: f.bf.scrollLeft, bf: f.bf })
      for (const c of f.cards || []) {
        if (c.display === 'none' || c.visibility === 'hidden' || Number(c.opacity) < 0.99) {
          addAnomaly('cardHidden', { t: f.t, card: c.interaction, display: c.display, visibility: c.visibility, opacity: c.opacity })
        }
        if (c.rect && (c.rect.x < 0 || (f.bf && c.rect.right > f.bf.rect.right + 1) || c.rect.bottom > f.vp.h || c.rect.y < 0)) {
          addAnomaly('cardViewportClip', { t: f.t, card: c.interaction, rect: c.rect, bf: f.bf?.rect, vp: f.vp })
        }
        if (c.coverInside === false) addAnomaly('cardCovered', { t: f.t, card: c.interaction, cover: c.cover.slice(0, 2) })
        const was = prevArt.get(c.interaction)
        if (was === 'displayable' && c.artState !== 'displayable') {
          addAnomaly('artRetentionLost', { t: f.t, card: c.interaction, from: was, to: c.artState, img: c.img, rev: f.rev })
        }
        if (c.artState && c.artState !== 'displayable' && f.cards.length) addAnomaly('artInitialPending', { t: f.t, card: c.interaction, state: c.artState })
        if (c.artState) prevArt.set(c.interaction, c.artState)
      }
    }
    for (const e of collected.events) {
      if (e.t <= f.t && e.t > (frames[i - 1]?.t ?? -1)) {
        if (e.kind === 'tableAdded') {
          result.renders++
          if (!e.hasBeneathRow) addAnomaly('renderWithoutBeneathRow', { t: e.t, rev: e.revision, presenting: f.presenting })
        }
      }
    }
  }
  for (const e of collected.events) {
    if (e.kind === 'tableAdded') { result.renderRevisions.push(e.revision); result.tableEvents.push(e) }
  }
  result.tableEvents = result.tableEvents.slice(0, 25)
  result.attrEvents = collected.events.filter(e => e.kind === 'attr').slice(0, 15)
  result.eventCounts = {}
  for (const e of collected.events) result.eventCounts[e.kind] = (result.eventCounts[e.kind] || 0) + 1
  if (result.beneathRowRemoved > 0 && result.beneathRowAdded > 0) addAnomaly('rowRebuilt', { added: result.beneathRowAdded, removed: result.beneathRowRemoved })
  return { result, frames }
}

const step = async (label, action, waitMs = STEP_MS) => {
  await mark(label)
  const t0 = Date.now()
  let actionResult = null
  try { actionResult = action ? await action() : null } catch (e) { actionResult = { error: String(e) } }
  await sleep(waitMs)
  const collected = await collect()
  const { result, frames } = analyzeStep({ label }, collected)
  result.wallMs = Date.now() - t0
  result.actionResult = actionResult
  result.serverAfter = await serverSession()
  out.steps.push(result)
  writeFileSync(`${RUN}/${String(out.steps.length).padStart(2, '0')}-${label}.frames.json`, JSON.stringify(frames))
  console.log(`[${label}] frames=${result.frames} renders=${result.renders} revs=${JSON.stringify(result.renderRevisions)} anomalies=${JSON.stringify(result.anomalyCounts)}`)
  console.log('   rowStates=' + JSON.stringify(result.rowStates))
  if (result.anomalies.length) console.log('   samples=' + JSON.stringify(result.anomalies.slice(0, 5)))
  console.log('   serverAfter=' + JSON.stringify(result.serverAfter?.beneath))
  return result
}

// ---------- 4. trigger sequences ----------
try {
  await sleep(400)
  await step('baseline', null, 700)
  await step('refresh-1', clickRefresh)
  await step('refresh-2', clickRefresh)
  await step('refresh-3', clickRefresh)
  await step('timeline-toggle', async () => {
    const t = page.locator('.ah-timeline-toggle')
    if (await t.count()) await t.first().evaluate(el => el.click())
  })
  await step('timeline-toggle-back', async () => {
    const t = page.locator('.ah-timeline-toggle')
    if (await t.count()) await t.first().evaluate(el => el.click())
  })
  await step('refresh-spam-3', async () => {
    await clickRefresh(); await sleep(30); await clickRefresh(); await sleep(30); await clickRefresh()
  })
  await step('idle-1500-refresh', async () => { await sleep(1500); await clickRefresh() })
  await step('resolve-cinematics-then-refresh', async () => {
    await skipCinematics(60)
    await sleep(300)
    await clickRefresh()
  }, 2500)

  // Real UI move: select a hand card with a legal play move, then click its action.
  const playMove = await page.evaluate(async id => {
    const s = await (await fetch('/api/session?sessionId=' + encodeURIComponent(id))).json()
    const m = (s.session?.state?.legalMoves || []).find(m => m.action === 'play')
    return m ? { cardId: m.cardId, label: m.label } : null
  }, out.sessionId)
  if (playMove) {
    await step('ui-play-asset', async () => {
      await selectEntity(`.ah-hand-card[data-card-code="${playMove.cardId}"]`)
      await sleep(200)
      return clickByText(playMove.label.replace(/^[^\p{L}]+/u, '').slice(0, 8), '.ah-table-actions')
    }, 3500)
    await step('refresh-after-play', clickRefresh, 2200)
  }
  await step('direct-investigate-then-refresh', async () => {
    const inv = await directMove({ action: 'investigate' })
    await sleep(250)
    await clickRefresh()
    return inv
  }, 4200)

  // Sefina free action draws one card from beneath -> beneath array changes for real.
  await step('select-investigator-for-freeaction', async () => {
    await selectEntity('.ah-map-investigator')
  }, 1200)
  await step('ui-freeaction-beneath', async () => clickByText('抽取赛菲娜下方'), 2600)
  let uiSession = await serverSession()
  if (uiSession.pendingChoice) {
    await step('choose-beneath-card', async () => page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.ah-choice button, .ah-table-actions button')].filter(b => !b.disabled)
      const cand = buttons.find(b => /下方/.test(b.textContent) || b.querySelector('.ah-offer-cards, .ah-table-art'))
      const any = cand || buttons[0]
      if (any) { any.click(); return any.textContent.trim().slice(0, 40) }
      return null
    }), 2600)
  }
  await step('refresh-after-beneath-change', clickRefresh, 2200)

  // resize while refreshing (layout reflow + scroll restore)
  for (const [w, h] of [[1400, 950], [1000, 900], [1700, 950]]) {
    await step(`resize-${w}-refresh`, async () => {
      await page.setViewportSize({ width: w, height: h })
      await sleep(120)
      await clickRefresh()
    }, 1800)
  }

  // end turn + refresh during resolution/presentation
  await step('ui-end-turn', async () => clickByText('结束回合', '.ah-table'), 3800)
  await step('refresh-during-resolution', async () => {
    await clickRefresh()
    await sleep(120)
    await clickRefresh()
  }, 3200)
} catch (e) {
  out.fatal = String(e?.stack || e)
  console.log('FATAL ' + out.fatal)
}

out.stateFinal = await serverSession()
out.errorsFinal = errors
writeFileSync(`${RUN}/summary.json`, JSON.stringify(out, null, 2))
const totals = out.steps.reduce((acc, s) => ({ frames: acc.frames + s.frames, renders: acc.renders + s.renders, anomalies: acc.anomalies + s.anomalies.length }), { frames: 0, renders: 0, anomalies: 0 })
console.log('\n=== TOTAL ===', JSON.stringify(totals))
console.log('final beneath', JSON.stringify(out.stateFinal?.beneath), 'errors', errors.length)
console.log('out', RUN)
await browser.close()
