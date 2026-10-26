// Debug: why does the fix page's dock lack the reaction gear in head-vs-fix run?
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
const BASE = 'http://127.0.0.1:8799'
const MOD = 'G:\\boardgame-hall-ai\\games\\arkhamhorror'
const gitShow = file => execSync(`git show HEAD:web/${file}`, { cwd: MOD, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const HEAD_FILES = { 'game-ui.js': gitShow('game-ui.js'), 'player-dashboard.css': gitShow('player-dashboard.css') }
const AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><ellipse cx='40' cy='40' rx='30' ry='34' fill='%23e9e9e6'/></svg>"
const browser = await chromium.launch({ channel: 'msedge' })

async function run(version) {
  const page = await browser.newPage({ viewport: { width: 1632, height: 800 }, deviceScaleFactor: 1.5625 })
  const errs = []
  page.on('pageerror', e => errs.push('pageerror: ' + e.message))
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)) })
  if (version === 'head') {
    await page.route('**/mods/arkhamhorror/game-ui.js', route => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: HEAD_FILES['game-ui.js'] }))
    await page.route('**/mods/arkhamhorror/player-dashboard.css', route => route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: HEAD_FILES['player-dashboard.css'] }))
  }
  let session
  await page.route('**/api/start', async route => {
    const response = await route.fetch({ postData: JSON.stringify({ modId: 'arkhamhorror', settings: { legacyAutoStart: true, playerCount: 1, playerInvestigator: '05004', campaignId: 'thePathToCarcosa', seed: 'dbg-' + version } }) })
    const body = await response.json(); session = body.session
    if (session.players?.[0]) { session.players[0].name = 'DrLiao'; session.players[0].avatar = AVATAR }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/session?*', route => route.fulfill({ json: { ok: true, session } }))
  await page.goto(BASE + '/index.html')
  await page.locator('.bg-card').filter({ hasText: '诡镇奇谈' }).click()
  await page.getByRole('button', { name: '开始新游戏' }).click()
  await page.waitForSelector('.ah-table', { timeout: 90000 })
  for (let i = 0; i < 30; i++) {
    if (!(await page.locator('.ah-cinematic').count())) break
    const skip = page.getByRole('button', { name: '跳过演出' })
    if (await skip.count()) await skip.first().evaluate(el => el.click()).catch(() => {})
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(1800)
  const info = await page.evaluate(() => {
    const dockGear = document.querySelectorAll('.ah-dock-investigator .ah-reaction-mode')
    const allGear = [...document.querySelectorAll('.ah-reaction-mode')].map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, cls: el.className, owner: el.closest('[data-interaction]')?.dataset?.interaction || '', parentCls: el.parentElement?.className } })
    const row = document.querySelector('.ah-dock-name-row')
    return {
      dockGearCount: dockGear.length,
      allGear,
      rowHTML: row?.outerHTML.slice(0, 700),
      invHTML: document.querySelector('.ah-dock-investigator')?.innerHTML.slice(0, 900),
      presenting: document.querySelector('.ah-table')?.classList?.contains('ah-presenting'),
      tableClass: document.querySelector('.ah-table')?.className,
    }
  })
  console.log('=== ' + version + ' errors:', JSON.stringify(errs.slice(0, 8)))
  console.log(version, JSON.stringify(info, null, 1))
  await page.close()
}
await run('head')
await run('fix')
await browser.close()
