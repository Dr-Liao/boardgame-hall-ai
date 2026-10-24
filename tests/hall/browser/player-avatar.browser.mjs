import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../lib/server.js'
import { loadTestMods } from '../helpers/mods.mjs'

test('玩家头像：上传预览、错误处理、保存刷新、棋盘局内显示、恢复默认', async ({ page }) => {
  const previousHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-avatar-ui-'))
  process.env.DSH_HOME = home
  const server = createServer({ mods: await loadTestMods() })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await server.ready
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const call = async (url, body) => (await page.request.post(origin + '/api' + url, { data: body })).json()
    const openSettings = async () => {
      await page.locator('.bg-settings-btn').click()
      await page.getByRole('button', { name: '玩家', exact: true }).click()
    }
    await page.goto(origin)
    await openSettings()
    const preview = page.getByRole('img', { name: '玩家头像预览', exact: true })
    const file = page.getByLabel('上传玩家头像', { exact: true })
    const save = page.getByRole('button', { name: '💾 保存玩家资料', exact: true })
    await expect(preview).toHaveText('👤')
    await page.getByLabel('玩家名称', { exact: true }).fill('头像测试玩家')
    await file.setInputFiles({ name: 'avatar.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#527bc2"/><circle cx="240" cy="115" r="50" fill="#fff"/><path d="M140 280a100 100 0 0 1 200 0" fill="#fff"/></svg>') })
    const image = preview.locator('img')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(el => el.naturalWidth)).toBe(256)
    expect(await image.evaluate(el => el.naturalHeight)).toBe(256)
    const avatar = await image.getAttribute('src')
    expect(avatar).toMatch(/^data:image\/png;base64,/)
    expect((await (await page.request.get(origin + '/api/config')).json()).playerAvatar).toBe('👤')
    for (const invalid of [
      { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('text'), error: '请选择图片文件' },
      { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image'), error: '无法解析图片文件' },
      { name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1), error: '图片不能超过 10MB' },
    ]) {
      const { error, ...upload } = invalid
      await file.setInputFiles(upload)
      await expect(page.getByRole('status')).toHaveText(error)
      await expect(image).toHaveAttribute('src', avatar)
    }
    await save.click()
    await expect(page.getByRole('status')).toContainText('已保存')
    await page.reload()
    await openSettings()
    await expect(image).toHaveAttribute('src', avatar)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: 'artifacts/player-avatar-settings.png' })
    await page.setViewportSize({ width: 1400, height: 950 })

    const started = await call('/start', { modId: 'gobang', settings: { firstMove: 'player', opponents: ['__random__'] } })
    expect(started.session.players[0].avatar).toBe(avatar)
    await page.evaluate(id => localStorage.setItem('boardgame-hall.sessionId', id), started.session.sessionId)
    await page.reload()
    await expect(page.locator('.bg-chip-avatar img').first()).toHaveAttribute('src', avatar)
    await page.locator('.bg-chat-fab').click()
    await page.locator('.bg-chat-input').fill('测试头像')
    await page.locator('.bg-chat-send').click()
    await expect(page.locator('.bg-chat-msg-me .bg-chat-avatar img')).toHaveAttribute('src', avatar)

    await page.getByRole('button', { name: '退出', exact: true }).click()
    await openSettings()
    await page.getByRole('button', { name: '恢复默认', exact: true }).click()
    await expect(preview).toHaveText('👤')
    await save.click()
    await expect(page.getByRole('status')).toContainText('已保存')
    await page.reload()
    await openSettings()
    await expect(preview).toHaveText('👤')
    const restored = await call('/start', { modId: 'ox', settings: { firstMove: 'player', opponents: ['__random__'] } })
    expect(restored.ok, restored.error).toBe(true)
    expect(restored.session.players[0].avatar).toBe('👤')
    expect(errors).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected test directory')
    fs.rmSync(home, { recursive: true, force: true })
  }
})
