import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
await page.setContent('<html></html>')
const res = await page.evaluate(async ({ imgs }) => {
  const out = {}
  for (const [name, dataUrl] of Object.entries(imgs)) {
    const img = new Image(); img.src = dataUrl; await img.decode()
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0)
    const { width: W, height: H } = c; const d = ctx.getImageData(0, 0, W, H).data
    const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2] }
    // white kicker avatar in left area
    const pts = []
    for (let y = 80; y < 180; y++) for (let x = 0; x < 140; x++) if (lum(x, y) > 170) pts.push([x, y])
    const av = pts.length ? { x0: Math.min(...pts.map(p=>p[0])), x1: Math.max(...pts.map(p=>p[0])), y0: Math.min(...pts.map(p=>p[1])), y1: Math.max(...pts.map(p=>p[1])) } : null
    // portrait bbox: use magenta row from annotations? no—detect bright content in x 300..520 y 80..200
    const b = []
    for (let y = 60; y < 220; y++) for (let x = 300; x < 520; x++) if (lum(x, y) > 42) b.push([x, y])
    const por = b.length ? { x0: Math.min(...b.map(p=>p[0])), x1: Math.max(...b.map(p=>p[0])), y0: Math.min(...b.map(p=>p[1])), y1: Math.max(...b.map(p=>p[1])) } : null
    out[name] = { W, H, avatar: av, portraitBright: por }
  }
  return out
}, { imgs: Object.fromEntries(Object.entries({ user: '.tmp-ui-bug/reports/shots/cmp/user.png', head: '.tmp-ui-bug/reports/shots/cmp/head.png', fix: '.tmp-ui-bug/reports/shots/cmp/fix.png' }).map(([k, p]) => [k, 'data:image/png;base64,' + readFileSync(p).toString('base64')])) })
console.log(JSON.stringify(res, null, 1))
await browser.close()
