// Dock-layout probe: render the user's reported state (Diana, TCU theme, gear) and
// measure/animate the bottom-left player dock across refresh + viewport sweep.
// Usage: node .tmp-ui-bug/reports/dock-probe.mjs
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/reports'
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })
const errors = []
let session

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1632, height: 800 }, deviceScaleFactor: 1.5625 })
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

// Hold /api/session responses to make the busy double-render window observable.
let sessionDelay = 0
await page.route('**/api/start', async route => {
  const response = await route.fetch({ postData: JSON.stringify({
    modId: 'arkhamhorror',
    settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '05004', campaignId: 'thePathToCarcosa', seed: 'dock-layout' },
  }) })
  const body = await response.json()
  session = body.session
  const s = session.state
  s.pendingChoice = null; s.currentSeat = 0; s.phase = 'investigation'; s.enemies = []
  const inv = s.investigators[0]
  inv.location = (s.locations[0] && s.locations[0].id) || inv.location
  const deckCards = Array.isArray(inv.deck) ? inv.deck.slice() : []
  if (inv.hand?.length >= 3) inv.discard = inv.hand.slice(0, 3)
  else inv.discard = deckCards.slice(0, 3)
  inv.beneath = [inv.hand?.[0] || deckCards[0]].filter(Boolean)
  inv.resources = 6; inv.clues = 1
  inv.damage = 0; inv.horror = 1
  inv.deckSize = deckCards.length || 30
  inv.actionsLeft = 0
  s.legalMoves = [{ action: 'draw', label: '抽一张牌' }, { action: 'resource', label: '拿取资源' }]
  // player name from user's screenshot; keep default avatar from the server session
  if (session.players?.[0]) session.players[0].name = 'DrLiao'
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
  // advance any presentation prompt
  const next = page.getByRole('button', { name: /继续|下一步/ })
  if (await next.count()) await next.first().evaluate(el => el.click()).catch(() => {})
}
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/userstate-initial-full.png`, animations: 'disabled' })

const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +(r.x + r.width).toFixed(2), bottom: +(r.y + r.height).toFixed(2) } }
const sample = () => page.evaluate(() => {
  const R = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +(r.x + r.width).toFixed(2), bottom: +(r.y + r.height).toFixed(2) } }
  const q = sel => document.querySelector(sel)
  const overlap = (a, b) => a && b && !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y)
  const portrait = q('.ah-dock-portrait'), gear = q('.ah-reaction-mode'), name = q('.ah-dock-name'),
    kicker = q('.ah-dock-kicker'), avatar = q('.ah-player-avatar'), row = q('.ah-dock-name-row'),
    invBlock = q('.ah-dock-investigator'), pool = q('.ah-token-pool'), dock = q('.ah-player-dock'),
    player = q('.ah-table-player'), bf = q('.ah-equipment-battlefield')
  const nameText = name?.querySelector('.ah-dock-name-text')
  const range = nameText && nameText.firstChild ? (() => { const rg = document.createRange(); rg.selectNodeContents(nameText); return rg.getBoundingClientRect() })() : null
  const cs = el => el ? getComputedStyle(el) : null
  const portraitArt = portrait?.querySelector('.ah-table-art')
  const img = portraitArtnode => portraitArtnode?.querySelector('img')
  const pa = portraitArt
  return {
    t: performance.now(),
    table: R(q('.ah-table')), player: R(player), dock: R(dock), invBlock: R(invBlock),
    kicker: R(kicker), kickerText: kicker?.textContent, avatar: R(avatar),
    row: R(row), name: R(name), nameText: range && { x: +range.x.toFixed(2), y: +range.y.toFixed(2), w: +range.width.toFixed(2), h: +range.height.toFixed(2), right: +range.right.toFixed(2) },
    gear: R(gear), gearClass: gear?.className, gearNext: gear?.dataset?.reactionMode, gearTitle: gear?.title,
    portrait: R(portrait), portraitArtState: pa?.dataset?.imageState, portraitHasImg: !!img(pa), portraitImgW: img(pa)?.naturalWidth,
    pool: R(pool),
    bf: R(bf), bfScroll: bf ? { l: bf.scrollLeft, sw: bf.scrollWidth, cw: bf.clientWidth } : null,
    overlaps: {
      gearPortrait: overlap(R(gear), R(portrait)),
      portraitPool: overlap(R(portrait), R(pool)),
      gearNameText: range ? overlap(R(gear), { x: range.x, y: range.y, right: range.right, bottom: range.y + range.height }) : null,
    },
    gearDisplay: cs(gear)?.display, portraitDisplay: cs(portrait)?.display, portraitPos: cs(portrait)?.position,
    docScrollW: document.documentElement.scrollWidth, winW: innerWidth, winH: innerHeight,
    dpr: devicePixelRatio,
    portArtInViewport: (() => { const r = pa?.getBoundingClientRect(); return r ? { w: +r.width.toFixed(1), h: +r.height.toFixed(1) } : null })(),
    theme: document.querySelector('.ah-table')?.className || null,
    palette: document.querySelector('.ah-table') ? getComputedStyle(document.querySelector('.ah-table')).getPropertyValue('--ah-theme-accent') : null,
    hasTable: !!document.querySelector('.ah-table'),
    bodyText: document.body.innerText.slice(0, 300),
  }
})

const step = async (label, action, wait = 200) => {
  if (action) await action()
  await page.waitForTimeout(wait)
  return { label, ...(await sample()) }
}

const results = { viewport: await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sw: document.documentElement.scrollWidth })), steps: [], dynamic: {}, errors }

// ---------- 1) baseline ----------
results.steps.push(await step('initial'))
const kickerCrop = { x: 0, y: 0, width: 1, height: 1 }
// crop the dock region for visual diff against the user's screenshot
const dockBox = await page.locator('.ah-table-player').boundingBox()
if (dockBox) {
  results.dockCrop = dockBox
  await page.screenshot({ path: `${SHOTS}/userstate-dock.png`, clip: { x: Math.max(0, dockBox.x - 4), y: Math.max(0, dockBox.y - 4), width: Math.min(1680, dockBox.width + 8), height: Math.min(800, dockBox.height + 8) }, animations: 'disabled' })
}

// ---------- 2) refresh dynamics (busy held 500ms) ----------
const refresh = page.getByRole('button', { name: '刷新局势' })
// start in-page per-frame recorder
await page.evaluate(() => {
  window.__rec = []
  const R = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }
  const q = s => document.querySelector(s)
  let frames = 0
  const tick = () => {
    const gear = q('.ah-reaction-mode')
    window.__rec.push({
      t: performance.now(), frames: ++frames,
      gear: R(gear), gearCls: gear?.className ?? null,
      portrait: R(q('.ah-dock-portrait')),
      kicker: R(q('.ah-dock-kicker')),
      row: R(q('.ah-dock-name-row')),
      avatar: R(q('.ah-player-avatar')),
      pool: R(q('.ah-token-pool')),
      portraitArt: q('.ah-dock-portrait .ah-table-art')?.dataset?.imageState ?? null,
      portraitImg: !!q('.ah-dock-portrait .ah-table-art img'),
      presenter: document.querySelector('.ah-table')?.classList.contains('ah-presenting') || false,
      busyBtn: document.querySelector('[aria-label="刷新局势"]')?.disabled ?? null,
      syncMsg: q('.ah-sync-message')?.textContent ?? null,
    })
    if (frames < 240) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
sessionDelay = 500
await refresh.first().evaluate(el => el.click())
await page.waitForTimeout(120)
results.busyShot = `${SHOTS}/refresh-busy.png`
await page.screenshot({ path: results.busyShot, animations: 'disabled' })
await page.waitForTimeout(1400)
sessionDelay = 0
results.dynamic.refreshHeld = await page.evaluate(() => window.__rec)
await page.screenshot({ path: `${SHOTS}/refresh-after.png`, animations: 'disabled' })

// second refresh toggling faster
await page.evaluate(() => { window.__rec = [] })
await refresh.first().evaluate(el => el.click())
await page.waitForTimeout(900)
results.dynamic.refreshFast = await page.evaluate(() => window.__rec)

// ---------- 3) viewport sweep ----------
results.sweep = []
const viewports = [[1920, 1080], [1700, 950], [1632, 800], [1536, 864], [1440, 900], [1366, 768], [1280, 800], [1240, 800], [1200, 800], [1100, 800], [1001, 900], [1000, 900], [980, 900], [900, 900], [800, 900], [760, 900], [700, 900], [699, 900], [600, 900], [390, 844]]
for (const [w, h] of viewports) {
  await page.setViewportSize({ width: w, height: h })
  await page.waitForTimeout(220)
  const s = await sample()
  results.sweep.push({ w, h, ...s })
  await page.screenshot({ path: `${SHOTS}/vp-${w}x${h}.png`, animations: 'disabled' })
}
await page.setViewportSize({ width: 1632, height: 800 })
await page.waitForTimeout(250)

// ---------- 4) variants: long name / no avatar / no gear / theme ----------
results.variants = []
const mutate = fn => { fn(session.state); session.state.revision = (session.state.revision || 0) + 1; }

// long investigator name + long player name
mutate(s => {
  const inv = s.investigators[0]
  inv.__origName = inv.name; inv.__origCode = inv.code
  inv.name = '黛安娜·史丹利·一个非常长的调查员名字'
  session.players[0].name = 'DrLiao的超级长玩家名字啊啊啊啊'
})
results.variants.push(await step('long-names-refresh', () => refresh.first().evaluate(el => el.click()), 700))
await page.screenshot({ path: `${SHOTS}/variant-long-names.png`, animations: 'disabled' })
mutate(s => { const inv = s.investigators[0]; inv.name = inv.__origName; session.players[0].name = 'DrLiao' })

// no avatar
mutate(s => { session.players[0].__avatar = session.players[0].avatar; session.players[0].avatar = '' })
results.variants.push(await step('no-avatar-refresh', () => refresh.first().evaluate(el => el.click()), 700))
await page.screenshot({ path: `${SHOTS}/variant-no-avatar.png`, animations: 'disabled' })
mutate(s => { session.players[0].avatar = session.players[0].__avatar })

// no gear: strip the auto-reaction flags of the investigator def in the projection
mutate(s => {
  const inv = s.investigators[0]
  const def = s.cards[inv.code]
  inv.__origDef = def ? { hasReactionPrompt: def.hasReactionPrompt, hasAutoReaction: def.hasAutoReaction } : null
  if (def) { def.hasReactionPrompt = false; def.hasAutoReaction = false }
})
results.variants.push(await step('no-gear-refresh', () => refresh.first().evaluate(el => el.click()), 700))
await page.screenshot({ path: `${SHOTS}/variant-no-gear.png`, animations: 'disabled' })
mutate(s => {
  const inv = s.investigators[0]
  const def = s.cards[inv.code]
  if (def && inv.__origDef) Object.assign(def, inv.__origDef)
})
results.variants.push(await step('gear-restored-refresh', () => refresh.first().evaluate(el => el.click()), 700))

// gear mode cycle: ask -> auto -> skip via real clicks
const gearLocator = page.locator('.ah-reaction-mode').first()
const modeCycle = []
for (let i = 0; i < 4; i++) {
  modeCycle.push(await sample())
  await gearLocator.evaluate(el => el.click()).catch(() => {})
  await page.waitForTimeout(180)
}
results.gearCycle = modeCycle.map(m => ({ cls: m.gearClass, gear: m.gear, portrait: m.portrait, row: m.row }))

// ---------- 5) hover/focus styles on gear? ----------
results.focus = await page.evaluate(() => {
  const gear = document.querySelector('.ah-reaction-mode')
  gear?.focus()
  const cs = getComputedStyle(gear)
  return { outline: cs.outline, boxShadow: cs.boxShadow, transform: cs.transform }
})

// ---------- 6) document-level overflow / clipping ----------
results.overflow = await page.evaluate(() => {
  const b = document.querySelector('.ah-dock-investigator')
  const p = document.querySelector('.ah-dock-portrait')
  const g = document.querySelector('.ah-reaction-mode')
  const info = el => el ? { scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight, overflow: getComputedStyle(el).overflow } : null
  return { investigator: info(b), portrait: info(p), gear: info(g), row: info(document.querySelector('.ah-dock-name-row')) }
})

// ---------- 7) computed styles of relevant elements ----------
results.computed = await page.evaluate(() => {
  const pick = (sel, props) => {
    const el = document.querySelector(sel); if (!el) return null
    const cs = getComputedStyle(el); const out = {}
    for (const p of props) out[p] = cs.getPropertyValue(p)
    return out
  }
  return {
    kicker: pick('.ah-dock-kicker', ['display', 'line-height', 'height', 'margin-bottom', 'overflow', 'text-overflow', 'white-space', 'font-size', 'letter-spacing']),
    row: pick('.ah-dock-name-row', ['display', 'gap', 'margin-right', 'height', 'align-items', 'min-width']),
    name: pick('.ah-dock-name', ['font-size', 'line-height', 'height', 'margin-right', 'flex', 'gap', 'padding', 'border']),
    gear: pick('.ah-reaction-mode', ['position', 'width', 'height', 'flex', 'order', 'margin', 'padding', 'border-width', 'border-radius', 'z-index', 'align-self']),
    portrait: pick('.ah-dock-portrait', ['position', 'top', 'right', 'width', 'height', 'float', 'z-index', 'display', 'overflow', 'border-radius', 'border-width']),
    avatar: pick('.ah-player-avatar', ['width', 'height', 'margin-right', 'vertical-align', 'border-radius']),
    dock: pick('.ah-player-dock', ['display', 'grid-template-columns', 'gap', 'align-items', 'padding', 'width']),
  }
})

// save
writeFileSync(`${OUT}/dock-probe.json`, JSON.stringify(results, null, 1))
console.log('viewport', JSON.stringify(results.viewport))
console.log('errors', JSON.stringify(errors.slice(0, 6)))
console.log('initial', JSON.stringify({ dock: results.steps[0].dock, inv: results.steps[0].invBlock, kicker: results.steps[0].kicker, avatar: results.steps[0].avatar, row: results.steps[0].row, name: results.steps[0].name, nameText: results.steps[0].nameText, gear: results.steps[0].gear, gearClass: results.steps[0].gearClass, portrait: results.steps[0].portrait, portraitArtState: results.steps[0].portraitArtState, pool: results.steps[0].pool, overlaps: results.steps[0].overlaps, bfScroll: results.steps[0].bfScroll }))
const dyn = arr => ({ frames: arr.length, gearMissing: arr.filter(f => !f.gear).length, portraitMissing: arr.filter(f => !f.portrait).length, kickerMissing: arr.filter(f => !f.kicker).length, rowHeights: [...new Set(arr.filter(f => f.row).map(f => f.row.h))], gearPos: [...new Set(arr.filter(f => f.gear).map(f => `${f.gear.x},${f.gear.y}`))].slice(0, 8), portraitPos: [...new Set(arr.filter(f => f.portrait).map(f => `${f.portrait.x},${f.portrait.y}`))].slice(0, 8), gearCls: [...new Set(arr.map(f => f.gearCls))], busyFrames: arr.filter(f => f.busyBtn === true).length, presentingFrames: arr.filter(f => f.presenter).length, syncMsgs: [...new Set(arr.map(f => f.syncMsg))] })
console.log('refreshHeld', JSON.stringify(dyn(results.dynamic.refreshHeld)))
console.log('refreshFast', JSON.stringify(dyn(results.dynamic.refreshFast)))
console.log('variants', JSON.stringify(results.variants.map(v => ({ label: v.label, kickerText: v.kickerText, avatar: v.avatar, row: v.row, gear: v.gear, portrait: v.portrait, overlaps: v.overlaps, nameText: v.nameText, kicker: v.kicker }))))
console.log('sweep', JSON.stringify(results.sweep.map(s => ({ w: s.w, h: s.h, dock: s.dock, inv: s.invBlock, kicker: s.kicker, avatar: s.avatar, row: s.row, name: s.name, nameText: s.nameText, gear: s.gear, portrait: s.portrait, portraitDisplay: s.portraitDisplay, overlaps: s.overlaps, pool: s.pool, bf: s.bf, docScrollW: s.docScrollW, winW: s.winW }))))
console.log('computed', JSON.stringify(results.computed, null, 1))
console.log('overflow', JSON.stringify(results.overflow))
await browser.close()
