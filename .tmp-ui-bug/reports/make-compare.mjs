// Render HEAD (buggy) and FIX dock at the user's inferred viewport/scale so the crops can
// be compared 1:1 with .tmp-ui-bug/screen.png.
// User screenshot inference: gear button outer box 40 device px (24 content + 2 border = 26 CSS)
// -> device/CSS ~1.54-1.6; portrait 30x35 CSS. Use viewport 1598x800, DPR 1.6.
// Usage: node .tmp-ui-bug/reports/make-compare.mjs
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const MOD = 'G:\\boardgame-hall-ai\\games\\arkhamhorror'
const OUT = '.tmp-ui-bug/reports'
const SHOTS = `${OUT}/shots/cmp`
mkdirSync(SHOTS, { recursive: true })
const gitShow = f => execSync(`git show HEAD:web/${f}`, { cwd: MOD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const HEAD = { 'game-ui.js': gitShow('game-ui.js'), 'player-dashboard.css': gitShow('player-dashboard.css') }
const AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><ellipse cx='40' cy='40' rx='29' ry='33' fill='%23e9e9e6'/><ellipse cx='47' cy='36' rx='10' ry='19' fill='%23141414'/></svg>"

// user screenshot crop (device px in screen.png) and gear box center in device px
const USER = { crop: { x: 252, y: 416, w: 1031, h: 391 }, gearCenter: { x: 605.5, y: 582.5 } }
const SCALE = 1.6

const browser = await chromium.launch({ channel: 'msedge' })

async function render(version) {
  const page = await browser.newPage({ viewport: { width: 1598, height: 800 }, deviceScaleFactor: SCALE })
  if (version === 'head') {
    await page.route('**/mods/arkhamhorror/game-ui.js', r => r.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: HEAD['game-ui.js'] }))
    await page.route('**/mods/arkhamhorror/player-dashboard.css', r => r.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: HEAD['player-dashboard.css'] }))
  }
  let session
  await page.route('**/api/start', async route => {
    const response = await route.fetch({ postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '05004', campaignId: 'thePathToCarcosa', seed: 'cmp-' + version } }) })
    const body = await response.json(); session = body.session
    const s = session.state
    s.pendingChoice = null; s.currentSeat = 0; s.phase = 'investigation'; s.enemies = []
    const inv = s.investigators[0]
    inv.location = (s.locations[0] && s.locations[0].id) || inv.location
    const deck = Array.isArray(inv.deck) ? inv.deck.slice() : []
    inv.discard = inv.hand?.length >= 3 ? inv.hand.slice(0, 3) : deck.slice(0, 3)
    inv.beneath = [inv.hand?.[0] || deck[0]].filter(Boolean)
    inv.resources = 6; inv.clues = 1; inv.damage = 0; inv.horror = 1
    inv.deckSize = deck.length || 30
    inv.actionsLeft = 0
    s.legalMoves = [{ action: 'draw', label: '抽一张牌' }]
    if (session.players?.[0]) { session.players[0].name = 'DrLiao'; session.players[0].avatar = AVATAR }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/session?*', route => route.fulfill({ json: { ok: true, session } }))
  await page.goto(BASE + '/index.html')
  await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
  await page.getByRole('button', { name: '开始新游戏' }).click()
  await page.waitForSelector('.ah-table', { timeout: 90000 })
  for (let i = 0; i < 40; i++) {
    if (!(await page.locator('.ah-cinematic').count())) break
    const skip = page.getByRole('button', { name: '跳过演出' })
    if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(1600)
  const cont = page.getByRole('button', { name: /继续/ })
  if (await cont.count()) await cont.first().evaluate(el => el.click()).catch(() => {})
  await page.waitForTimeout(700)
  // switch the dock reaction gear to "auto" so the icon is a cog like the user's screenshot
  await page.locator('.ah-dock-investigator .ah-reaction-mode').first().evaluate(el => el.click()).catch(() => {})
  await page.waitForTimeout(400)
  const m = await page.evaluate(() => {
    const R = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 } }
    return {
      gear: R(document.querySelector('.ah-dock-investigator .ah-reaction-mode')),
      gearClass: document.querySelector('.ah-dock-investigator .ah-reaction-mode')?.className,
      portrait: R(document.querySelector('.ah-dock-investigator .ah-dock-portrait')),
      inv: R(document.querySelector('.ah-dock-investigator')),
      kicker: R(document.querySelector('.ah-dock-kicker')),
      row: R(document.querySelector('.ah-dock-name-row')),
      dpr: devicePixelRatio, viewport: [innerWidth, innerHeight],
    }
  })
  const clip = {
    x: m.gear.cx - (USER.gearCenter.x - USER.crop.x) / SCALE,
    y: m.gear.cy - (USER.gearCenter.y - USER.crop.y) / SCALE,
    width: USER.crop.w / SCALE,
    height: USER.crop.h / SCALE,
  }
  await page.screenshot({ path: `${SHOTS}/${version}.png`, clip, animations: 'disabled' })
  // map element rects into crop device coordinates for annotations
  const map = r => r ? { x: (r.x - clip.x) * SCALE, y: (r.y - clip.y) * SCALE, w: r.w * SCALE, h: r.h * SCALE, cx: (r.cx - clip.x) * SCALE, cy: (r.cy - clip.y) * SCALE } : null
  const out = { version, measure: m, clip, cropPx: { x: USER.crop.x, y: USER.crop.y, w: USER.crop.w, h: USER.crop.h }, gear: map(m.gear), portrait: map(m.portrait), kicker: map(m.kicker), row: map(m.row), inv: map(m.inv), gearClass: m.gearClass }
  await page.close()
  return out
}

const head = await render('head')
const fix = await render('fix')
// user annotation geometry in crop coordinates
const user = {
  gear: { cx: USER.gearCenter.x - USER.crop.x, cy: USER.gearCenter.y - USER.crop.y, w: 40, h: 40, x: 586 - USER.crop.x, y: 563 - USER.crop.y },
  // portrait outer box inferred from HEAD geometry: top = kicker top = gearTop - 24*scale, centered x at column right - 15*scale
  portrait: { y: 563 - 24 * SCALE, h: 35 * SCALE, w: 30 * SCALE },
}
user.portrait.cy = user.portrait.y + user.portrait.h / 2
user.portrait.x = 686 - USER.crop.x - user.portrait.w
user.portrait.cx = user.portrait.x + user.portrait.w / 2
writeFileSync(`${SHOTS}/compare.json`, JSON.stringify({ user, head, fix }, null, 1))
console.log(JSON.stringify({ head: { gear: head.gear, portrait: head.portrait, gearClass: head.gearClass }, fix: { gear: fix.gear, portrait: fix.portrait, gearClass: fix.gearClass }, user }, null, 1))
await browser.close()
