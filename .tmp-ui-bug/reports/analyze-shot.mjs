// Pixel-analyze a screenshot of the AH table to recover CSS geometry.
// Usage: node .tmp-ui-bug/reports/analyze-shot.mjs <png> [region JSON]
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const file = process.argv[2] || '.tmp-ui-bug/screen.png'
const buf = readFileSync(file)
const dataUrl = 'data:image/png;base64,' + buf.toString('base64')

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
await page.setContent('<html><body></body></html>')
const result = await page.evaluate(async ({ dataUrl }) => {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth; c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const { width: W, height: H } = c
  const data = ctx.getImageData(0, 0, W, H).data
  const at = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]] }
  const lum = (x, y) => { const [r, g, b] = at(x, y); return 0.299 * r + 0.587 * g + 0.114 * b }
  const isGold = (x, y) => { const [r, g, b] = at(x, y); return r > 140 && g > 105 && b < 100 && r - b > 60 }
  // connected components of a predicate inside a region
  const components = (pred, x0, y0, x1, y1, minPx = 8) => {
    const seen = new Uint8Array(W * H)
    const out = []
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (seen[y * W + x] || !pred(x, y)) continue
      let sx = 0, sy = 0, n = 0, minX = x, maxX = x, minY = y, maxY = y
      const stack = [x, y]; seen[y * W + x] = 1
      while (stack.length) {
        const cy = stack.pop(), cx = stack.pop()
        sx += cx; sy += cy; n++
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue
          const idx = ny * W + nx
          if (seen[idx] || !pred(nx, ny)) continue
          seen[idx] = 1; stack.push(nx, ny)
        }
      }
      if (n >= minPx) out.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, n, cx: Math.round(sx / n), cy: Math.round(sy / n) })
    }
    return out.sort((a, b) => b.n - a.n)
  }
  // raw info + a few component scans
  const gold = components(isGold, 0, 0, W, H, 12).slice(0, 80)
  // bright cream text pixels (name text #e5d6b6)
  const isCream = (x, y) => { const [r, g, b] = at(x, y); return r > 190 && g > 175 && b > 130 && Math.abs(r - g) < 45 }
  const cream = components(isCream, 0, 0, W, H, 6).slice(0, 120)
  return { W, H, gold, creamCount: cream.length, cream: cream.slice(0, 120) }
}, { dataUrl })

import { writeFileSync } from 'node:fs'
const outPath = process.argv[3] || '.tmp-ui-bug/reports/shots/shot-analysis.json'
writeFileSync(outPath, JSON.stringify(result, null, 1))
console.log('wrote', outPath, 'W,H', result.W, result.H)
await browser.close()
