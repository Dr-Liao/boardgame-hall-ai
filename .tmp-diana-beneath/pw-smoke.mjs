import { chromium } from '@playwright/test'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
await page.setContent('<title>ok</title><h1>hello</h1>')
console.log('title=', await page.title(), 'h1=', await page.textContent('h1'))
await browser.close()
