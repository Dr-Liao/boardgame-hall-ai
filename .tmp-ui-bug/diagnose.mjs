// UI bug diagnosis: player-dock avatar layout + beneath-row disappearance on refresh.
// Run from workspace root:  node .tmp-ui-bug/diagnose.mjs
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/out'
mkdirSync(OUT, { recursive: true })

const avatarSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><circle cx='40' cy='34' r='18' fill='%23e8e8e8'/><circle cx='40' cy='34' r='8' fill='%23111'/><rect x='24' y='42' width='32' height='26' fill='%23111'/></svg>"

let session
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.route('**/api/start', async route => {
  const response = await route.fetch({
    postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '01001', seed: 'ui-bug' } }),
  })
  const body = await response.json()
  session = body.session
  const s = session.state
  s.pendingChoice = null; s.currentSeat = 0; s.phase = 'investigation'; s.enemies = []
  const inv = s.investigators[0]
  inv.location = 'hallway'
  inv.hand = ['01016', '01087', '01088', '01025', '01086']
  inv.resources = 7; inv.clues = 3
  inv.beneath = ['01016', '01087', '01088']
  inv.assets = [{ id: 'beat-cop', code: '01018', exhausted: false }]
  s.legalMoves = [{ action: 'play', cardId: '01016', label: '装备手枪' }]
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
  const box = sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +(r.x + r.width).toFixed(1), bottom: +(r.y + r.height).toFixed(1) }
  }
  const overlap = (a, b) => a && b && !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y)
  const bf = document.querySelector('.ah-equipment-battlefield')
  const beneath = document.querySelector('.ah-beneath-row')
  const beneathCard = document.querySelector('.ah-beneath-row .ah-minicard')
  const portrait = box('.ah-dock-portrait'), gear = box('.ah-reaction-mode')
  const rowRect = beneath?.getBoundingClientRect(), cardRect = beneathCard?.getBoundingClientRect()
  const rowClipped = !!(rowRect && cardRect && cardRect.width > 0 && (cardRect.right > rowRect.right + 0.5 || cardRect.left < rowRect.left - 0.5))
  const bfRect = bf?.getBoundingClientRect()
  const rowVisibleInBf = !!(rowRect && bfRect && rowRect.right > bfRect.left + 1 && rowRect.left < bfRect.right - 1)
  const arts = [...document.querySelectorAll('.ah-table-art')].map(el => ({
    code: el.dataset.artCode, state: el.dataset.imageState, hasImg: !!el.querySelector('img'),
    owner: el.closest('[data-interaction]')?.dataset.interaction || '',
  }))
  return {
    tablePlayer: box('.ah-table-player'), dock: box('.ah-player-dock'),
    investigator: box('.ah-dock-investigator'), kicker: box('.ah-dock-kicker'),
    avatar: box('.ah-player-avatar'), nameRow: box('.ah-dock-name-row'),
    name: box('.ah-dock-name'), gear, portrait, portraitGearOverlap: overlap(portrait, gear),
    battlefield: box('.ah-equipment-battlefield'),
    bfScrollLeft: bf ? bf.scrollLeft : null, bfScrollWidth: bf ? bf.scrollWidth : null, bfClientWidth: bf ? bf.clientWidth : null,
    beneathRow: box('.ah-beneath-row'), beneathCard: box('.ah-beneath-row .ah-minicard'),
    beneathRowCount: document.querySelectorAll('.ah-beneath-row').length,
    beneathCards: document.querySelectorAll('.ah-beneath-row .ah-minicard').length,
    beneathRowClipped: rowClipped, beneathVisibleInBf: rowVisibleInBf,
    beneathArt: arts.filter(a => a.owner.startsWith('beneath')),
    hand: box('.ah-hand-area'), tools: box('.ah-dock-tools'),
    docScrollW: document.documentElement.scrollWidth, winW: innerWidth,
    bodyClasses: document.querySelector('.ah-table')?.className,
  }
})

const results = { viewports: [], errors: null }
const viewports = [[1400, 950], [1920, 1080], [1700, 950], [1366, 768], [1120, 900], [1000, 900], [900, 900]]
for (const [w, h] of viewports) {
  await page.setViewportSize({ width: w, height: h })
  await page.waitForTimeout(500)
  const vp = { w, h, initial: null, renders: [], refreshes: [], scrollRestore: null }
  vp.initial = await measure()
  await page.screenshot({ path: `${OUT}/vp-${w}x${h}-initial.png`, animations: 'disabled' })

  const toggle = page.locator('.ah-timeline-toggle')
  for (let i = 0; i < 5; i++) {
    if (await toggle.count()) await toggle.first().evaluate(el => el.click())
    await page.waitForTimeout(120)
    vp.renders.push(await measure())
  }
  const refresh = page.getByRole('button', { name: '刷新局势' })
  for (let i = 0; i < 6; i++) {
    if (await refresh.count()) await refresh.first().evaluate(el => el.click())
    await page.waitForTimeout(160)
    vp.refreshes.push(await measure())
  }
  // scroll the battlefield fully right, then refresh: is the scroll position kept?
  vp.scrollRestore = await page.evaluate(() => {
    const bf = document.querySelector('.ah-equipment-battlefield')
    if (!bf) return null
    bf.scrollLeft = bf.scrollWidth
    return { before: bf.scrollLeft, max: bf.scrollWidth - bf.clientWidth }
  })
  if (await refresh.count()) await refresh.first().evaluate(el => el.click())
  await page.waitForTimeout(250)
  vp.scrollRestore.after = await page.evaluate(() => {
    const bf = document.querySelector('.ah-equipment-battlefield')
    return bf ? bf.scrollLeft : null
  })
  vp.scrollRestore.measure = await measure()
  results.viewports.push(vp)
}
results.errors = errors

// DOM snapshot of the dock for static analysis.
results.dockHTML = await page.evaluate(() => document.querySelector('.ah-dock-investigator')?.outerHTML || '')
results.beneathHTML = await page.evaluate(() => document.querySelector('.ah-beneath-row')?.outerHTML || '')
results.computed = await page.evaluate(() => {
  const pick = (sel, props) => {
    const el = document.querySelector(sel); if (!el) return null
    const cs = getComputedStyle(el); const out = {}
    for (const p of props) out[p] = cs.getPropertyValue(p)
    const r = el.getBoundingClientRect()
    out.rect = { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
    return out
  }
  return {
    dock: pick('.ah-player-dock', ['display', 'grid-template-columns', 'gap', 'width', 'overflow']),
    kicker: pick('.ah-dock-kicker', ['display', 'position', 'float', 'white-space', 'overflow', 'text-overflow', 'font-size', 'letter-spacing', 'margin', 'line-height']),
    portrait: pick('.ah-dock-portrait', ['position', 'float', 'top', 'right', 'left', 'bottom', 'width', 'height', 'margin', 'z-index']),
    nameRow: pick('.ah-dock-name-row', ['display', 'flex', 'gap', 'margin-right', 'min-width', 'width', 'overflow', 'position']),
    gear: pick('.ah-reaction-mode', ['position', 'width', 'height', 'flex', 'margin', 'order', 'z-index']),
    avatar: pick('.ah-player-avatar', ['display', 'width', 'height', 'margin-right', 'vertical-align', 'float', 'position']),
    battlefield: pick('.ah-equipment-battlefield', ['display', 'flex-wrap', 'overflow-x', 'justify-content', 'align-items', 'gap', 'width', 'padding']),
    beneathRow: pick('.ah-threat-row.ah-beneath-row', ['display', 'position', 'flex', 'width', 'max-width', 'min-width', 'height', 'overflow', 'padding', 'order']),
    beneathCard: pick('.ah-beneath-row .ah-minicard', ['width', 'min-width', 'height', 'flex', 'position']),
  }
})

writeFileSync(`${OUT}/diagnose.json`, JSON.stringify(results, null, 2))
const slim = m => m && ({ p: m.portrait, g: m.gear, a: m.avatar, nr: m.nameRow, bf: m.battlefield, bs: { l: m.bfScrollLeft, sw: m.bfScrollWidth, cw: m.bfClientWidth }, br: m.beneathRow, bc: m.beneathCard, cnt: m.beneathCards, clip: m.beneathRowClipped, vis: m.beneathVisibleInBf, art: m.beneathArt?.map(a => `${a.state}${a.hasImg ? '+img' : ''}`) })
for (const vp of results.viewports) {
  console.log(`== ${vp.w}x${vp.h} ==`)
  console.log('initial', JSON.stringify(slim(vp.initial)))
  console.log('renders', JSON.stringify(vp.renders.map(slim)))
  console.log('refreshes', JSON.stringify(vp.refreshes.map(slim)))
  console.log('scrollRestore', JSON.stringify({ s: vp.scrollRestore, m: slim(vp.scrollRestore.measure) }))
}
console.log('errors', JSON.stringify(errors.slice(0, 8)))
console.log('computed', JSON.stringify(results.computed, null, 1))
await browser.close()
