import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../../lib/server.js'
import { loadTestMods } from '../helpers/mods.mjs'

test('反馈弹窗：内置 iframe、一键复制诊断信息、整页重绘不重建', async ({ page, context }) => {
  const previousHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-feedback-ui-'))
  process.env.DSH_HOME = home
  const server = createServer({ mods: await loadTestMods() })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await server.ready
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    await page.goto(origin)

    await page.getByRole('button', { name: '💬 反馈', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '反馈', exact: true })
    await expect(dialog).toBeVisible()

    const frame = dialog.locator('iframe')
    await expect(frame).toHaveAttribute('src', 'https://my.feishu.cn/share/base/form/shrc6uDSVoM1wuWS7AB5K0pPtMg')
    await expect(frame).toHaveAttribute('sandbox', /allow-forms/)
    await expect(dialog.locator('.bg-feedback-preview')).toContainText('桌游大厅 v')

    await dialog.getByRole('button', { name: '📋 一键复制诊断信息', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('已复制')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain('桌游大厅 v')
    expect(copied).toContain('Windows')
    expect(copied).toContain('时间：')
    expect(copied).not.toMatch(/sk-/)

    // 大厅整页重绘（打开设置）不能重建 iframe：portal 必须留在 body 上。
    await frame.evaluate(el => { el.dataset.keep = '1' })
    await page.evaluate(() => document.querySelector('.bg-settings-btn').click())
    await expect(dialog.locator('iframe')).toHaveAttribute('data-keep', '1')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    // 关掉反馈不应带走已经打开的设置弹窗。
    await expect(page.getByRole('heading', { name: '⚙️ 设置', exact: true })).toBeVisible()
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
