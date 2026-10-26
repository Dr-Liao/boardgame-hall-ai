// Probe: DOM node retention + image flicker across re-render paths.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const BASE = process.env.HALL_URL || 'http://127.0.0.1:8799'
const OUT = '.tmp-ui-bug/out'
mkdirSync(OUT, { recursive: true })
const avatarSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><circle cx='40' cy='34' r='18' fill='%23e8e8e8'/><circle cx='40' cy='34' r='8' fill='%23111'/></svg>"
let session
let revisionBase = 0
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.route('**/api/start', async route => {
  const response = await route.fetch({ postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '01001', seed: 'ui-bug' } }) })
  const body = await response.json()
  session = body.session
  revisionBase = session.state.revision || 0
  const s = session.state
  s.pendingChoice = null; s.currentSeat = 0; s.phase = 'investigation'; s.enemies = []
  const inv = s.investigators[0]
  inv.location = 'hallway'; inv.hand = ['01016', '01087', '01088', '01025', '01086']
  inv.resources = 7; inv.clues = 3; inv.beneath = ['01016', '01087', '01088']
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

const tagNodes = () => page.evaluate(() => {
  let n = 0
  for (const el of document.querySelectorAll('.ah-table-art')) el.dataset.probe = 'a' + (++n)
  const avatar = document.querySelector('.ah-player-avatar')
  if (avatar) avatar.dataset.probe = 'avatar'
})

const snapshot = () => page.evaluate(() => {
  const rows = []
  for (const el of document.querySelectorAll('.ah-table-art')) {
    const r = el.getBoundingClientRect()
    const img = el.querySelector('img')
    rows.push({
      probe: el.dataset.probe || null, code: el.dataset.artCode, state: el.dataset.imageState,
      hasImg: !!img, imgAnim: img?.getAnimations?.().length || 0,
      owner: el.closest('[data-interaction]')?.dataset.interaction || '',
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    })
  }
  const avatar = document.querySelector('.ah-player-avatar')
  const kicker = document.querySelector('.ah-dock-kicker')
  const portrait = document.querySelector('.ah-dock-portrait')
  const gear = document.querySelector('.ah-reaction-mode')
  const beneath = document.querySelector('.ah-beneath-row')
  const bf = document.querySelector('.ah-equipment-battlefield')
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } }
  return {
    arts: rows,
    avatar: { probe: avatar?.dataset.probe || null, box: rect(avatar), complete: avatar ? avatar.complete : null, nw: avatar?.naturalWidth },
    kicker: rect(kicker), portrait: rect(portrait), gear: rect(gear),
    beneathCount: beneath ? beneath.querySelectorAll('.ah-minicard').length : 0,
    beneathRow: rect(beneath),
    bfScroll: bf ? { left: bf.scrollLeft, sw: bf.scrollWidth, cw: bf.clientWidth } : null,
    kickerText: kicker?.textContent,
  }
})

const results = { steps: [], errors }
const step = async (label, action, wait = 150) => {
  if (action) await action()
  await page.waitForTimeout(wait)
  results.steps.push({ label, ...(await snapshot()) })
}

await tagNodes(); await page.waitForTimeout(120)
await step('initial')

const toggle = page.locator('.ah-timeline-toggle')
const refresh = page.getByRole('button', { name: '刷新局势' })
await step('render-toggle-1', () => toggle.first().evaluate(el => el.click()))
await step('render-toggle-2', () => toggle.first().evaluate(el => el.click()))
await step('refresh-1', () => refresh.first().evaluate(el => el.click()))
await step('refresh-2', () => refresh.first().evaluate(el => el.click()))

// dynamic changes: revision bump + beneath/hand changes
const mutate = fn => { fn(session.state); session.state.revision = (session.state.revision || 0) + 1 }
mutate(s => { s.investigators[0].beneath = ['01016'] })
await tagNodes()
await step('beneath-3-to-1', () => refresh.first().evaluate(el => el.click()))
mutate(s => { s.investigators[0].beneath = [] })
await step('beneath-1-to-0', () => refresh.first().evaluate(el => el.click()))
mutate(s => { s.investigators[0].beneath = ['01016', '01087'] })
await step('beneath-0-to-2', () => refresh.first().evaluate(el => el.click()))
mutate(s => { s.investigators[0].hand = ['01025'] })
await tagNodes()
await step('hand-5-to-1', () => refresh.first().evaluate(el => el.click()))

// busy double-render emulation: click refresh then measure immediately (no wait) and next frame
await tagNodes()
await page.evaluate(() => { window.__mutate = null })
const immediate = async label => {
  await refresh.first().evaluate(el => el.click())
  const sync = await snapshot()
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const afterFrame = await snapshot()
  results.steps.push({ label: label + ':sync', ...sync })
  results.steps.push({ label: label + ':after2frames', ...afterFrame })
}
await immediate('busy-click')

// viewport resize (media query boundary 1000/980)
for (const [w, h] of [[1500, 950], [1002, 900], [980, 900], [700, 900], [1400, 950]]) {
  await page.setViewportSize({ width: w, height: h })
  await page.waitForTimeout(250)
  results.steps.push({ label: `resize-${w}`, ...(await snapshot()) })
}

await browser.close()
writeFileSync(`${OUT}/probe.json`, JSON.stringify(results, null, 2))
const summary = results.steps.map(s => ({
  label: s.label,
  beneath: s.beneathCount,
  arts: s.arts.length,
  retained: s.arts.filter(a => a.probe).length,
  beneathArts: s.arts.filter(a => a.owner.startsWith('beneath')).map(a => `${a.code}:${a.probe || 'NEW'}:${a.hasImg ? 'img' : 'NOIMG'}`),
  handArtsCount: s.arts.filter(a => a.owner.startsWith('hand')).length,
  avatarProbe: s.avatar?.probe || null,
  kicker: s.kicker, portrait: s.portrait, gear: s.gear,
  bfScroll: s.bfScroll,
}))
console.log(JSON.stringify({ errors, summary }, null, 1))
