// Precisely locate the user screenshot's dock elements (tight windows + connected components).
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'

const dataUrl = 'data:image/png;base64,' + readFileSync('.tmp-ui-bug/screen.png').toString('base64')
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
await page.setContent('<html><body></body></html>')
const result = await page.evaluate(async ({ dataUrl }) => {
  const img = new Image(); img.src = dataUrl; await img.decode()
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0)
  const { width: W, height: H } = c
  const d = ctx.getImageData(0, 0, W, H).data
  const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]] }
  const lum = (x, y) => { const [r, g, b] = at(x, y); return 0.299 * r + 0.587 * g + 0.114 * b }

  const components = (pred, x0, y0, x1, y1, minPx = 12) => {
    const seen = new Uint8Array(W * H); const out = []
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (seen[y * W + x] || !pred(x, y)) continue
      let n = 0, minX = x, maxX = x, minY = y, maxY = y, sx = 0, sy = 0
      const st = [x, y]; seen[y * W + x] = 1
      while (st.length) {
        const cy = st.pop(), cx = st.pop(); n++; sx += cx; sy += cy
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue
          const idx = ny * W + nx; if (seen[idx] || !pred(nx, ny)) continue
          seen[idx] = 1; st.push(nx, ny)
        }
      }
      if (n >= minPx) out.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, n, cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1) })
    }
    return out.sort((a, b) => b.n - a.n)
  }
  // portrait: bright image content in a tight window (below the equipment card, right of gear)
  const bright = (x, y) => lum(x, y) > 42
  const portraitCandidates = components(bright, 615, 515, 715, 625, 200)
  // kicker avatar: bright/white round icon at the very start of the kicker line
  const whiteish = (x, y) => lum(x, y) > 120
  const avatarCandidates = components(whiteish, 240, 505, 420, 585, 80)
  // name text (cream) bbox for sanity: y 560..620, x 420..900
  const cream = (x, y) => { const [r, g, b] = at(x, y); return r > 185 && g > 165 && b > 115 }
  const textCandidates = components(cream, 400, 555, 1000, 625, 30)
  return { W, H, portraitCandidates, avatarCandidates, textCandidates }
}, { dataUrl })

const p = result.portraitCandidates[0]
const a = result.avatarCandidates[0]
const out = {
  image: [result.W, result.H],
  portrait: p,
  kickerAvatar: a,
  // gear border box measured earlier by gold-edge components: 586..625 x 563..602
  gear: { x0: 586, x1: 625, y0: 563, y1: 602, w: 40, h: 40, cx: 605.5, cy: 582.5 },
  nameText: result.textCandidates.slice(0, 4),
}
if (p) {
  out.portraitVsGear = {
    dCx: +(p.cx - out.gear.cx).toFixed(1),
    dCy: +(p.cy - out.gear.cy).toFixed(1),
    dTop: +(p.y0 - out.gear.y0).toFixed(1),
    dBottom: +(p.y1 - out.gear.y1).toFixed(1),
  }
}
if (a && p) {
  out.invColumnWidthDevice = p.x1 - a.x0
  out.scaleFromColumn250 = +((p.x1 - a.x0) / 250).toFixed(4)
}
out.scaleFromGear26 = +(out.gear.w / 26).toFixed(4)
writeFileSync('.tmp-ui-bug/reports/user-dock-measure.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
await browser.close()
