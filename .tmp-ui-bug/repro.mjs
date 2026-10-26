// UI bug repro: player-dock avatar layout + beneath-row flicker on refresh.
// Usage: node .tmp-ui-bug/repro.mjs [width] [height] [tag]
import { chromium } from '@playwright/test'

const BASE = 'http://127.0.0.1:8799'
const width = Number(process.argv[2] || 1700)
const height = Number(process.argv[3] || 950)
const tag = process.argv[4] || `${width}x${height}`
const OUT = '.tmp-ui-bug/out'
import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync(OUT, { recursive: true })

let session
const avatarSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='%23111'/><circle cx='20' cy='18' r='9' fill='%23eee'/><circle cx='20' cy='18' r='4' fill='%23111'/><rect x='10' y='20' width='20' height='14' fill='%23111'/></svg>"

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', msg => { if (msg.type() === 'error') errors.push('console: ' + msg.text()) })

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
  inv.beneath = ['01016', '01087']
  inv.name = '黛安娜·史丹利'
  inv.effectiveStats = { willpower: inv.willpower - 1, intellect: inv.intellect, combat: inv.combat + 1, agility: inv.agility }
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
await page.waitForSelector('.ah-table', { timeout: 30000 })
for (let i = 0; i < 20; i++) {
  if (!(await page.locator('.ah-cinematic').count())) break
  const skip = page.getByRole('button', { name: '跳过演出' })
  if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
  await page.waitForTimeout(200)
}
await page.waitForTimeout(1200)

const boxes = () => page.evaluate(() => {
  const pick = sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  }
  const arts = [...document.querySelectorAll('.ah-table-art')].map(el => ({
    code: el.dataset.artCode, state: el.dataset.imageState, hasImg: !!el.querySelector('img'),
    owner: el.closest('[data-interaction]')?.dataset.interaction || '',
    box: (() => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } })(),
  }))
  const rows = [...document.querySelectorAll('.ah-threat-row')].map(el => ({
    cls: el.className, box: (() => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } })(),
    cards: el.querySelectorAll('.ah-minicard').length,
  }))
  return {
    tablePlayer: pick('.ah-table-player'), dock: pick('.ah-player-dock'),
    investigator: pick('.ah-dock-investigator'), kicker: pick('.ah-dock-kicker'),
    avatar: pick('.ah-player-avatar'), nameRow: pick('.ah-dock-name-row'),
    name: pick('.ah-dock-name'), gear: pick('.ah-reaction-mode'), portrait: pick('.ah-dock-portrait'),
    battlefield: pick('.ah-equipment-battlefield'),
    hand: pick('.ah-hand-area'), tools: pick('.ah-dock-tools'),
    scrollW: { doc: document.documentElement.scrollWidth, win: window.innerWidth },
    arts, rows,
  }
})

const snap = {}
snap.initial = await boxes()
await page.screenshot({ path: `${OUT}/${tag}-initial.png`, animations: 'disabled' })

// Repeat pure re-render (no server round-trip) and record shift.
const toggle = page.locator('.ah-timeline-toggle')
const renders = []
for (let i = 0; i < 6; i++) {
  if (await toggle.count()) await toggle.first().evaluate(el => el.click())
  else await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  renders.push(await boxes())
}
snap.renders = renders

// Real refresh path (fetches /api/session then rerenders).
const refresh = page.getByRole('button', { name: '刷新局势' })
const refreshes = []
for (let i = 0; i < 6; i++) {
  if (await refresh.count()) await refresh.first().evaluate(el => el.click())
  await page.waitForTimeout(150)
  refreshes.push(await boxes())
}
snap.refreshes = refreshes
await page.screenshot({ path: `${OUT}/${tag}-after-refresh.png`, animations: 'disabled' })

writeFileSync(`${OUT}/${tag}.json`, JSON.stringify({ tag, viewport: { width, height }, errors, snap }, null, 2))
console.log('TAG', tag)
console.log('errors', JSON.stringify(errors.slice(0, 5)))
console.log('initial', JSON.stringify({ tablePlayer: snap.initial.tablePlayer, dock: snap.initial.dock, investigator: snap.initial.investigator, kicker: snap.initial.kicker, avatar: snap.initial.avatar, nameRow: snap.initial.nameRow, gear: snap.initial.gear, portrait: snap.initial.portrait, battlefield: snap.initial.battlefield, scrollW: snap.initial.scrollW }))
console.log('rows', JSON.stringify(snap.initial.rows))
console.log('beneath arts', JSON.stringify(snap.initial.arts.filter(a => a.owner.startsWith('beneath'))))
const brief = arr => arr.map(b => ({ p: b.portrait, a: b.avatar, g: b.gear, n: b.nameRow, bf: b.battlefield && b.battlefield.w, body: b.beneathRow }))
console.log('render drift', JSON.stringify(brief(renders)))
console.log('refresh drift', JSON.stringify(brief(refreshes)))
await browser.close()
