import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../lib/server.js'
import { loadModFrom, modCandidates } from '../../../lib/mods.js'
import { sortedHandOrder } from '../../../games/poker/web/hand-order.js'

let server
let origin
let session
let home
let previousHome
let previousKey

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-poker-browser-'))
  previousHome = process.env.DSH_HOME
  previousKey = process.env.AI_API_KEY
  process.env.DSH_HOME = home
  delete process.env.AI_API_KEY
  const poker = await loadModFrom(modCandidates({ userDir: null }).find(candidate => candidate.id === 'poker'))
  server = createServer({ mods: [poker], persist: false })
  await server.ready
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(origin + '/api/start', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modId: 'poker', settings: { opponents: ['__random__', '__random__', '__random__'] } }) })
  const value = await response.json()
  expect(value.ok, value.error).toBe(true)
  session = value.session
})

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousKey === undefined) delete process.env.AI_API_KEY
  else process.env.AI_API_KEY = previousKey
  if (home) fs.rmSync(home, { recursive: true, force: true })
})

test('掼蛋开局自动理牌，并可拖动换序和再次理牌', async ({ page }) => {
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.evaluate(id => localStorage.setItem('boardgame-hall.sessionId', id), session.sessionId)
  await page.reload({ waitUntil: 'networkidle' })
  const cards = page.locator('.gd-hand .gd-card')
  await expect(cards).toHaveCount(27)
  const ordered = await cards.evaluateAll(elements => elements.map(element => element.dataset.cardId))
  expect(ordered).toEqual(sortedHandOrder(session.state.hands[0], session.state.level))

  const from = await cards.nth(0).boundingBox()
  const to = await cards.nth(4).boundingBox()
  await page.mouse.move(from.x + 8, from.y + 35)
  await page.mouse.down()
  await page.mouse.move(to.x + 8, to.y + 35, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => cards.evaluateAll(elements => elements.map(element => element.dataset.cardId))).toEqual([
    ...ordered.slice(1, 5), ordered[0], ...ordered.slice(5),
  ])
  await expect(page.locator('.gd-hand .gd-card[aria-pressed="true"]')).toHaveCount(0)
  await page.getByRole('button', { name: '一键理牌' }).click()
  expect(await cards.evaluateAll(elements => elements.map(element => element.dataset.cardId))).toEqual(ordered)
})

test('每副结算和还贡阶段显示对应操作', async ({ page }) => {
  const fake = structuredClone(session)
  fake.state.phase = 'between'
  fake.state.currentSeat = 0
  fake.state.handSummary = { winnerTeam: 0, gained: 3, nextLevel: 5, passedA: false }
  await page.route('**/api/session*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, session: fake }),
  }))
  await page.goto(origin + '/', { waitUntil: 'networkidle' })
  await page.evaluate(id => localStorage.setItem('boardgame-hall.sessionId', id), session.sessionId)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByRole('button', { name: '开始下一副' })).toBeEnabled()
  await expect(page.locator('.gd-hint')).toContainText(['我方获胜，升 3 级'])

  fake.state.phase = 'return'
  fake.state.tributePairs = [{ giver: 1, receiver: 0, card: fake.state.hands[0][0], returned: false }]
  await page.reload({ waitUntil: 'networkidle' })
  const returnButton = page.getByRole('button', { name: '还贡' })
  await expect(returnButton).toBeDisabled()
  const low = fake.state.hands[0].find(card => card.rank <= 10)
  await page.locator(`.gd-hand .gd-card[data-card-id="${low.id}"]`).click({ position: { x: 8, y: 35 } })
  await expect(returnButton).toBeEnabled()
})
