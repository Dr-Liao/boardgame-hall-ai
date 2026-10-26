// Final validation: clean refresh dynamics (no data change) + portrait art retention +
// kicker/portrait occlusion for HEAD vs FIX.
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:8799'
const MOD = 'G:\\boardgame-hall-ai\\games\\arkhamhorror'
const SHOTS = '.tmp-ui-bug/reports/shots'
mkdirSync(SHOTS, { recursive: true })
const gitShow = f => execSync(`git show HEAD:web/${f}`, { cwd: MOD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const HEAD = { 'game-ui.js': gitShow('game-ui.js'), 'player-dashboard.css': gitShow('player-dashboard.css') }
const AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><ellipse cx='40' cy='40' rx='29' ry='33' fill='%23e9e9e6'/></svg>"

const browser = await chromium.launch({ channel: 'msedge' })
async function open(version) {
  const page = await browser.newPage({ viewport: { width: 1598, height: 800 }, deviceScaleFactor: 1.6 })
  if (version === 'head') {
    await page.route('**/mods/arkhamhorror/game-ui.js', r => r.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: HEAD['game-ui.js'] }))
    await page.route('**/mods/arkhamhorror/player-dashboard.css', r => r.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: HEAD['player-dashboard.css'] }))
  }
  let session, delay = 0
  await page.route('**/api/start', async route => {
    const response = await route.fetch({ postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '05004', campaignId: 'thePathToCarcosa', seed: 'final-' + version } }) })
    const body = await response.json(); session = body.session
    const s = session.state
    s.pendingChoice = null; s.currentSeat = 0; s.phase = 'investigation'; s.enemies = []
    const inv = s.investigators[0]
    const deck = Array.isArray(inv.deck) ? inv.deck.slice() : []
    inv.discard = inv.hand?.length >= 3 ? inv.hand.slice(0, 3) : deck.slice(0, 3)
    inv.beneath = [inv.hand?.[0] || deck[0]].filter(Boolean)
    inv.resources = 6; inv.clues = 1; inv.damage = 0; inv.horror = 1; inv.deckSize = deck.length || 30; inv.actionsLeft = 0
    if (session.players?.[0]) { session.players[0].name = 'DrLiao'; session.players[0].avatar = AVATAR }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/session?*', async route => {
    if (delay) await new Promise(r => setTimeout(r, delay))
    await route.fulfill({ json: { ok: true, session } })
  })
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
  await page.waitForTimeout(1500)
  return {
    page,
    setDelay: v => { delay = v },
    mutate: fn => { fn(session); session.state.revision = (session.state.revision || 0) + 1 },
    session: () => session,
  }
}

const out = {}
for (const version of ['head', 'fix']) {
  const ctx = await open(version)
  const page = ctx.page
  // tag the portrait art/img nodes to test retention across a refresh
  await page.evaluate(() => {
    const art = document.querySelector('.ah-dock-portrait .ah-table-art')
    const img = art?.querySelector('img')
    if (art) art.dataset.tagged = 'art'
    if (img) img.dataset.tagged = 'img'
  })
  // Element occlusion: is the kicker text painted under the portrait with a long player name?
  const occlusion = await page.evaluate(() => {
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } }
    const portrait = r(document.querySelector('.ah-dock-portrait'))
    const kicker = r(document.querySelector('.ah-dock-kicker'))
    const overlap = portrait && kicker && !(portrait.right <= kicker.x || kicker.right <= portrait.x || portrait.bottom <= kicker.y || kicker.bottom <= portrait.y)
    // what element paints at the portrait's center and at the kicker's right end?
    const atPortrait = portrait ? document.elementFromPoint(portrait.x + portrait.w / 2, portrait.y + portrait.h / 2) : null
    const atKickerRight = kicker ? document.elementFromPoint(kicker.right - 4, kicker.y + kicker.h / 2) : null
    const describe = el => el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}` : null
    return {
      portrait, kicker, portraitOverlapsKickerRow: !!overlap,
      portraitTopVsKickerTop: portrait && kicker ? +(portrait.y - kicker.y).toFixed(2) : null,
      portraitBottomVsKickerBottom: portrait && kicker ? +(portrait.bottom - kicker.bottom).toFixed(2) : null,
      atPortraitCenter: describe(atPortrait), atKickerRightEnd: describe(atKickerRight),
    }
  })
  // start frame recorder
  await page.evaluate(() => {
    window.__rec = []
    const R = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } }
    let frames = 0
    const tick = () => {
      const gear = document.querySelector('.ah-dock-investigator .ah-reaction-mode')
      const art = document.querySelector('.ah-dock-portrait .ah-table-art')
      window.__rec.push({
        f: ++frames, t: Math.round(performance.now()),
        gear: R(gear), gearCls: gear?.className || null,
        portrait: R(document.querySelector('.ah-dock-portrait')),
        kicker: R(document.querySelector('.ah-dock-kicker')),
        row: R(document.querySelector('.ah-dock-name-row')),
        avatar: R(document.querySelector('.ah-player-avatar')),
        artTagged: art?.dataset.tagged || null,
        artState: art?.dataset.imageState || null,
        imgTagged: art?.querySelector('img')?.dataset.tagged || null,
        presenting: document.querySelector('.ah-table')?.classList.contains('ah-presenting') || false,
        busy: document.querySelector('[aria-label="刷新局势"]')?.disabled ?? null,
      })
      if (frames < 260) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  ctx.setDelay(700)
  await page.getByRole('button', { name: '刷新局势' }).first().evaluate(el => el.click())
  await page.waitForTimeout(1800)
  // a second refresh without artificial delay
  ctx.setDelay(0)
  await page.getByRole('button', { name: '刷新局势' }).first().evaluate(el => el.click())
  await page.waitForTimeout(900)
  const rec = await page.evaluate(() => window.__rec)
  const uniq = key => [...new Set(rec.map(r => r[key]).filter(v => v != null).map(v => typeof v === 'object' ? `${v.x},${v.y},${v.w},${v.h}` : String(v)))]
  out[version] = {
    occlusion,
    frames: rec.length,
    gearPositions: uniq('gear'), gearClasses: uniq('gearCls'),
    portraitPositions: uniq('portrait'), kickerPositions: uniq('kicker'), rowPositions: uniq('row'),
    avatarPositions: uniq('avatar'),
    gearMissingFrames: rec.filter(r => !r.gear).length,
    portraitMissingFrames: rec.filter(r => !r.portrait).length,
    artTaggedFrames: rec.filter(r => r.artTagged === 'art').length,
    imgTaggedFrames: rec.filter(r => r.imgTagged === 'img').length,
    presentingFrames: rec.filter(r => r.presenting).length,
    busyFrames: rec.filter(r => r.busy).length,
    artStates: uniq('artState'),
  }
  await page.close()
}
writeFileSync('.tmp-ui-bug/reports/final-validation.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
await browser.close()
