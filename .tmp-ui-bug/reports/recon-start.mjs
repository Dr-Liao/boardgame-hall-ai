// Recon: start a REAL hall game with Sefina Rousseau (03003) whose setup places
// events beneath the investigator, so the beneath row exists in genuine server state.
// No session/start response tampering: everything comes from the real server.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/reports/out'
mkdirSync(OUT, { recursive: true })
const INVESTIGATOR = process.argv[2] || '03003'
const PLAYERS = Number(process.argv[3] || 1)

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1700, height: 950 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

let startBody = null
await page.route('**/api/start', async route => {
  const postData = JSON.stringify({
    modId: 'arkhamhorror',
    settings: {
      legacyAutoStart: true, playerCount: PLAYERS,
      playerInvestigator: INVESTIGATOR, seed: 'beneath-flicker-' + Date.now(),
    },
  })
  const response = await route.fetch({ postData })
  const body = await response.json()
  startBody = { ok: body.ok, sessionId: body.session?.sessionId, error: body.error }
  await route.fulfill({ response, json: body })
})

const apiSession = () => page.evaluate(async id => {
  const r = await fetch('/api/session?sessionId=' + encodeURIComponent(id))
  return (await r.json()).session
}, startBody?.sessionId)

await page.goto(BASE + '/index.html')
await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
await page.getByRole('button', { name: '开始新游戏' }).click()
await page.waitForSelector('.ah-table', { timeout: 60000 })
const skipCinematics = async (limit = 40) => {
  for (let i = 0; i < limit; i++) {
    if (!(await page.locator('.ah-cinematic').count())) {
      if (await page.locator('.ah-table').count()) return
      await page.waitForTimeout(200)
      continue
    }
    const skip = page.getByRole('button', { name: '跳过演出' })
    if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
    await page.waitForTimeout(200)
  }
}
await skipCinematics()
await page.waitForTimeout(800)

let session = await apiSession()
const report = {
  startBody, errors,
  state0: session ? {
    revision: session.state.revision, uiState: session.state.uiState, phase: session.state.phase,
    pendingChoice: session.state.pendingChoice ? {
      kind: session.state.pendingChoice.kind, source: session.state.pendingChoice.source,
      seat: session.state.pendingChoice.seat,
      optionCount: session.state.pendingChoice.options?.length,
      options: session.state.pendingChoice.options?.slice(0, 15),
    } : null,
    investigators: session.state.investigators.map(inv => ({
      seat: inv.seat, code: inv.code, name: inv.name, hand: (inv.hand || []).length,
      beneath: inv.beneath || null, actionsLeft: inv.actionsLeft,
    })),
    legalMoves: (session.state.legalMoves || []).slice(0, 8).map(m => ({ action: m.action, optionId: m.optionId, label: m.label })),
  } : null,
  tableHtml: null, choiceHtml: null,
}

report.choiceHtml = await page.evaluate(() => {
  const el = document.querySelector('.ah-table-actions .ah-choice, .ah-choice')
  return el ? el.outerHTML.slice(0, 8000) : null
})
report.beneathHtml = await page.evaluate(() => document.querySelector('.ah-beneath-row')?.outerHTML.slice(0, 3000) || null)
await page.screenshot({ path: `${OUT}/recon-${INVESTIGATOR}-p${PLAYERS}.png` })

// Try to auto-answer the openingHand choice: pick the first N event options then "done".
if (session?.state.pendingChoice?.kind === 'openingHand') {
  const btnSel = '.ah-choice .ah-action, .ah-choice button, .ah-action'
  for (let round = 0; round < 8; round++) {
    session = await apiSession()
    const pc = session.state.pendingChoice
    if (!pc || pc.kind !== 'openingHand') break
    const picked = await page.evaluate(() => {
      const choice = document.querySelector('.ah-choice')
      if (!choice) return { clicked: null, buttons: [] }
      const buttons = [...choice.querySelectorAll('button')].map(b => ({ text: b.textContent.trim().slice(0, 30), disabled: b.disabled }))
      const clear = [...choice.querySelectorAll('button')].find(b => /完成下方事件选择/.test(b.textContent))
      const candidates = [...choice.querySelectorAll('button')].filter(b =>
        !b.disabled && !/完成|跳过|保留|确认/.test(b.textContent))
      if (candidates.length) { candidates[0].click(); return { clicked: candidates[0].textContent.trim().slice(0, 30), buttons } }
      if (clear) { clear.click(); return { clicked: 'done', buttons } }
      return { clicked: null, buttons }
    })
    if (!picked.clicked) break
    await page.waitForTimeout(600)
    await skipCinematics(10)
  }
  await page.waitForTimeout(1200)
  session = await apiSession()
  report.afterOpeningHand = session ? {
    revision: session.state.revision,
    pendingChoice: session.state.pendingChoice?.kind || null,
    investigators: session.state.investigators.map(inv => ({ seat: inv.seat, code: inv.code, hand: (inv.hand || []).length, beneath: inv.beneath || null })),
  } : null
  report.beneathHtmlAfter = await page.evaluate(() => document.querySelector('.ah-beneath-row')?.outerHTML.slice(0, 3000) || null)
  await page.screenshot({ path: `${OUT}/recon-${INVESTIGATOR}-p${PLAYERS}-after.png` })
}

writeFileSync(`${OUT}/recon-${INVESTIGATOR}-p${PLAYERS}.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({
  startBody, errors: errors.slice(0, 6),
  pending: report.state0?.pendingChoice,
  investigators: report.state0?.investigators,
  after: report.afterOpeningHand,
  beneathRowPresent: !!report.beneathHtml,
}, null, 1))
await browser.close()
