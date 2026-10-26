// HEAD (v0.3.1, buggy portrait absolute top:0) vs WIP fix comparison + regression matrix.
// The HEAD version of the changed web files is served via route interception so the
// working tree (which the Lead is editing) is NOT touched.
// Usage: node .tmp-ui-bug/reports/head-vs-fix.mjs
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const MOD = 'G:\\boardgame-hall-ai\\games\\arkhamhorror'
const OUT = '.tmp-ui-bug/reports'
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })
const gitShow = file => execSync(`git show HEAD:web/${file}`, { cwd: MOD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const HEAD_FILES = { 'game-ui.js': gitShow('game-ui.js'), 'player-dashboard.css': gitShow('player-dashboard.css') }

const AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><ellipse cx='40' cy='40' rx='30' ry='34' fill='%23e9e9e6'/><ellipse cx='46' cy='36' rx='10' ry='18' fill='%23141414'/></svg>"

const errors = []
const browser = await chromium.launch({ channel: 'msedge' })

const R = `const R = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), cx: +(r.x + r.width / 2).toFixed(2), cy: +(r.y + r.height / 2).toFixed(2), right: +(r.x + r.width).toFixed(2), bottom: +(r.y + r.height).toFixed(2) } }`
const MEASURE_FN = new Function(`
  ${R}
  const q = sel => document.querySelector(sel)
  const overlap = (a, b) => a && b && !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y)
  const portrait = q('.ah-dock-investigator .ah-dock-portrait'), gear = q('.ah-dock-investigator .ah-reaction-mode'), kicker = q('.ah-dock-kicker'),
    row = q('.ah-dock-name-row'), name = q('.ah-dock-name'), avatar = q('.ah-player-avatar'), inv = q('.ah-dock-investigator')
  const art = portrait?.querySelector('.ah-table-art')
  const pr = R(portrait), gr = R(gear)
  return {
    inv: R(inv), kicker: R(kicker), kickerText: kicker?.textContent, avatar: R(avatar),
    row: R(row), name: R(name), nameText: q('.ah-dock-name-text')?.textContent,
    gear: gr, gearClass: gear?.className || null, portrait: pr,
    portraitDisplay: portrait ? getComputedStyle(portrait).display : null,
    playerAvatarVisible: !!avatar && avatar.getBoundingClientRect().width > 0,
    offsetPortraitVsGear: pr && gr ? +(pr.cy - gr.cy).toFixed(2) : null,
    offsetPortraitVsKicker: pr && kicker ? +(pr.cy - R(kicker).cy).toFixed(2) : null,
    gearPortraitGap: pr && gr ? +(pr.x - gr.right).toFixed(2) : null,
    nameRoom: row && name ? +(R(row).right - R(name).right).toFixed(2) : null,
    overlaps: {
      gearPortrait: overlap(gr, pr),
      portraitVitals: overlap(pr, R(q('.ah-dock-vitals'))),
      portraitKicker: overlap(pr, R(kicker)),
      gearKicker: overlap(gr, R(kicker)),
    },
    portraitArtState: art?.dataset?.imageState ?? null,
    portraitHasImg: !!art?.querySelector('img'),
    css: {
      portrait: portrait ? { position: getComputedStyle(portrait).position, top: getComputedStyle(portrait).top, right: getComputedStyle(portrait).right, transform: getComputedStyle(portrait).transform, display: getComputedStyle(portrait).display } : null,
      row: row ? { position: getComputedStyle(row).position, paddingRight: getComputedStyle(row).paddingRight, marginRight: getComputedStyle(row).marginRight, height: getComputedStyle(row).height } : null,
    },
    dom: inv ? inv.innerHTML.slice(0, 500) : null,
  }
`)

async function open(version) {
  const page = await browser.newPage({ viewport: { width: 1632, height: 800 }, deviceScaleFactor: 1.5625 })
  page.on('pageerror', e => errors.push(version + ' pageerror: ' + e.message))
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(version + ' console: ' + m.text()) })
  if (version === 'head') {
    await page.route('**/mods/arkhamhorror/game-ui.js', route => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: HEAD_FILES['game-ui.js'] }))
    await page.route('**/mods/arkhamhorror/player-dashboard.css', route => route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: HEAD_FILES['player-dashboard.css'] }))
  }
  let session, sessionDelay = 0
  await page.route('**/api/start', async route => {
    const response = await route.fetch({ postData: JSON.stringify({
      modId: 'arkhamhorror',
      settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '05004', campaignId: 'thePathToCarcosa', seed: 'dock-layout-' + version },
    }) })
    const body = await response.json()
    session = body.session
    const s = session.state
    s.pendingChoice = null; s.currentSeat = 0; s.phase = 'investigation'; s.enemies = []
    const inv = s.investigators[0]
    inv.location = (s.locations[0] && s.locations[0].id) || inv.location
    const deckCards = Array.isArray(inv.deck) ? inv.deck.slice() : []
    inv.discard = inv.hand?.length >= 3 ? inv.hand.slice(0, 3) : deckCards.slice(0, 3)
    inv.beneath = [inv.hand?.[0] || deckCards[0]].filter(Boolean)
    inv.resources = 6; inv.clues = 1; inv.damage = 0; inv.horror = 1
    inv.deckSize = deckCards.length || 30
    inv.actionsLeft = 0
    s.legalMoves = [{ action: 'draw', label: '抽一张牌' }, { action: 'resource', label: '拿取资源' }]
    if (session.players?.[0]) { session.players[0].name = 'DrLiao'; session.players[0].avatar = AVATAR }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/session?*', async route => {
    if (sessionDelay) await new Promise(r => setTimeout(r, sessionDelay))
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
  await page.waitForTimeout(1400)
  const cont = page.getByRole('button', { name: /继续/ })
  if (await cont.count()) await cont.first().evaluate(el => el.click()).catch(() => {})
  await page.waitForTimeout(500)
  return {
    page,
    measure: () => page.evaluate(MEASURE_FN),
    refresh: () => page.getByRole('button', { name: '刷新局势' }).first().evaluate(el => el.click()),
    setDelay: v => { sessionDelay = v },
    mutate: fn => { fn(session); session.state.revision = (session.state.revision || 0) + 1 },
    sessionRef: () => session,
  }
}

const out = { errors, head: {}, fix: {}, widths: [], variants: [], dynamics: {} }

// ---------------- HEAD ----------------
{
  const ctx = await open('head')
  out.head.measure = await ctx.measure()
  const box = await ctx.page.locator('.ah-dock-investigator').boundingBox()
  out.head.clip = { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 70), width: 660, height: 250 }
  await ctx.page.screenshot({ path: `${SHOTS}/compare-head-dock.png`, clip: out.head.clip, animations: 'disabled' })
  // avatar absent variant (session.players[0].avatar persistence on refresh)
  await ctx.mutate(s => { s.players[0].__avatar = s.players[0].avatar; s.players[0].avatar = '' })
  await ctx.refresh(); await ctx.page.waitForTimeout(700)
  out.head.noAvatar = await ctx.measure()
  await ctx.mutate(s => { s.players[0].avatar = s.players[0].__avatar })
  // dynamics
  await ctx.page.evaluate(() => {
    window.__rec = []
    const R = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }
    let frames = 0
    const tick = () => {
      window.__rec.push({ f: ++frames, gear: R(document.querySelector('.ah-dock-investigator .ah-reaction-mode')), portrait: R(document.querySelector('.ah-dock-portrait')), row: R(document.querySelector('.ah-dock-name-row')), kicker: R(document.querySelector('.ah-dock-kicker')), art: document.querySelector('.ah-dock-portrait .ah-table-art')?.dataset?.imageState ?? null, disabled: document.querySelector('[aria-label="刷新局势"]')?.disabled ?? null })
      if (frames < 200) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  ctx.setDelay(600)
  await ctx.refresh()
  await ctx.page.waitForTimeout(1500)
  ctx.setDelay(0)
  out.dynamics.head = await ctx.page.evaluate(() => window.__rec)
  await ctx.page.close()
}

// ---------------- FIX (working tree) ----------------
{
  const ctx = await open('fix')
  out.fix.measure = await ctx.measure()
  const box = await ctx.page.locator('.ah-dock-investigator').boundingBox()
  out.fix.clip = { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 70), width: 660, height: 250 }
  await ctx.page.screenshot({ path: `${SHOTS}/compare-fix-dock.png`, clip: out.fix.clip, animations: 'disabled' })

  const variant = async (label, fn, wait = 700) => {
    if (fn) await fn()
    await ctx.refresh()
    await ctx.page.waitForTimeout(wait)
    const m = await ctx.measure()
    await ctx.page.screenshot({ path: `${SHOTS}/fix-${label}.png`, animations: 'disabled' })
    out.variants.push({ label, ...m })
  }
  // no gear: strip auto/reaction flags from the investigator's projected def
  await variant('no-gear', () => ctx.mutate(s => {
    const inv = s.state.investigators[0]
    const def = s.state.cards?.[inv.code]
    if (def) { inv.__def = { hasReactionPrompt: def.hasReactionPrompt, hasAutoReaction: def.hasAutoReaction }; def.hasReactionPrompt = false; def.hasAutoReaction = false }
  }))
  await variant('gear-restored', () => ctx.mutate(s => {
    const inv = s.state.investigators[0]
    const def = s.state.cards?.[inv.code]
    if (def && inv.__def) Object.assign(def, inv.__def)
  }))
  // long names (investigator + player)
  await variant('long-names', () => ctx.mutate(s => {
    const inv = s.state.investigators[0]
    inv.__name = inv.name; s.players[0].__pname = s.players[0].name
    inv.name = '黛安娜·史丹利·一个非常长的调查员名字'
    s.players[0].name = 'DrLiao的超级长玩家名字啊啊啊啊'
  }))
  await variant('long-names-restored', () => ctx.mutate(s => {
    const inv = s.state.investigators[0]
    inv.name = inv.__name; s.players[0].name = s.players[0].__pname
  }))
  // long player name only (kicker)
  await ctx.mutate(s => { s.players[0].name = 'DrLiao的超级长玩家名字啊啊啊啊' })
  await ctx.refresh(); await ctx.page.waitForTimeout(600)
  out.variants.push({ label: 'long-player-name', ...(await ctx.measure()) })
  await ctx.page.screenshot({ path: `${SHOTS}/fix-long-player-name.png`, animations: 'disabled' })
  await ctx.mutate(s => { s.players[0].name = 'DrLiao' })

  // no avatar
  await variant('no-avatar', () => ctx.mutate(s => { s.players[0].__avatar = s.players[0].avatar; s.players[0].avatar = '' }))
  await variant('avatar-restored', () => ctx.mutate(s => { s.players[0].avatar = s.players[0].__avatar }))

  // gear mode cycle via real clicks
  out.gearModes = []
  for (let i = 0; i < 4; i++) {
    out.gearModes.push(await ctx.measure())
    await ctx.page.locator('.ah-dock-investigator .ah-reaction-mode').first().evaluate(el => el.click()).catch(() => {})
    await ctx.page.waitForTimeout(200)
  }

  // dynamics on fix
  await ctx.page.evaluate(() => {
    window.__rec = []
    const R = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }
    let frames = 0
    const tick = () => {
      window.__rec.push({ f: ++frames, gear: R(document.querySelector('.ah-dock-investigator .ah-reaction-mode')), portrait: R(document.querySelector('.ah-dock-portrait')), row: R(document.querySelector('.ah-dock-name-row')), kicker: R(document.querySelector('.ah-dock-kicker')), art: document.querySelector('.ah-dock-portrait .ah-table-art')?.dataset?.imageState ?? null, disabled: document.querySelector('[aria-label="刷新局势"]')?.disabled ?? null })
      if (frames < 200) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  ctx.setDelay(600)
  await ctx.refresh()
  await ctx.page.waitForTimeout(1500)
  ctx.setDelay(0)
  out.dynamics.fix = await ctx.page.evaluate(() => window.__rec)

  // widths
  for (const [w, h] of [[1920, 1080], [1700, 950], [1632, 800], [1440, 900], [1366, 768], [1240, 800], [1100, 800], [1001, 900], [1000, 900], [980, 900], [700, 900], [600, 900], [390, 844]]) {
    await ctx.page.setViewportSize({ width: w, height: h })
    await ctx.page.waitForTimeout(260)
    const m = await ctx.measure()
    out.widths.push({ w, h, ...m })
    await ctx.page.screenshot({ path: `${SHOTS}/fix-vp-${w}x${h}.png`, animations: 'disabled' })
  }
  await ctx.page.close()
}

out.errors = errors
writeFileSync(`${OUT}/head-vs-fix.json`, JSON.stringify(out, null, 1))
const brief = m => m && ({
  kicker: m.kicker, avatar: m.avatar, row: m.row, name: m.name, gear: m.gear, portrait: m.portrait,
  portraitDisplay: m.portraitDisplay, offsets: { vsGear: m.offsetPortraitVsGear, vsKicker: m.offsetPortraitVsKicker },
  gearPortraitGap: m.gearPortraitGap, nameRoom: m.nameRoom, overlaps: m.overlaps, art: m.portraitArtState, css: m.css,
})
console.log('HEAD', JSON.stringify(brief(out.head.measure), null, 1))
console.log('HEAD no-avatar', JSON.stringify(brief(out.head.noAvatar)))
console.log('FIX', JSON.stringify(brief(out.fix.measure), null, 1))
const dyn = arr => arr && ({ frames: arr.length, gearMissing: arr.filter(f => !f.gear).length, portraitMissing: arr.filter(f => !f.portrait).length, rowH: [...new Set(arr.filter(f => f.row).map(f => f.row.h))], gearPos: [...new Set(arr.filter(f => f.gear).map(f => `${f.gear.x},${f.gear.y}`))], portraitPos: [...new Set(arr.filter(f => f.portrait).map(f => `${f.portrait.x},${f.portrait.y}`))], artStates: [...new Set(arr.map(f => f.art))], busyFrames: arr.filter(f => f.disabled).length })
console.log('HEAD dynamics', JSON.stringify(dyn(out.dynamics.head)))
console.log('FIX dynamics', JSON.stringify(dyn(out.dynamics.fix)))
console.log('VARIANTS', JSON.stringify(out.variants.map(v => ({ label: v.label, kickerText: v.kickerText, avatar: v.avatar && { w: v.avatar.w, h: v.avatar.h }, row: v.row && { y: v.row.y, h: v.row.h }, name: v.name && { x: v.name.x, w: v.name.w }, gear: v.gear, portrait: v.portrait && { x: v.portrait.x, y: v.portrait.y, w: v.portrait.w, h: v.portrait.h }, portraitDisplay: v.portraitDisplay, offsets: { vsGear: v.offsetPortraitVsGear, vsKicker: v.offsetPortraitVsKicker }, gap: v.gearPortraitGap, nameRoom: v.nameRoom, overlaps: v.overlaps })), null, 1))
console.log('GEAR MODES', JSON.stringify(out.gearModes.map(m => ({ cls: m.gearClass, gear: m.gear, portrait: m.portrait, offset: m.offsetPortraitVsGear }))))
console.log('WIDTHS', JSON.stringify(out.widths.map(w => ({ w: w.w, kicker: w.kicker && { y: w.kicker.y, h: w.kicker.h }, avatar: w.avatar && { w: w.avatar.w, h: w.avatar.h }, row: w.row && { x: w.row.x, y: w.row.y, w: w.row.w, h: w.row.h }, name: w.name && { x: w.name.x, w: w.name.w }, gear: w.gear, portrait: w.portrait, portraitDisplay: w.portraitDisplay, offsets: { vsGear: w.offsetPortraitVsGear, vsKicker: w.offsetPortraitVsKicker }, gap: w.gearPortraitGap, nameRoom: w.nameRoom, overlaps: w.overlaps, css: w.css && w.css.row })), null, 1))
console.log('errors', JSON.stringify(errors.slice(0, 8)))
await browser.close()


