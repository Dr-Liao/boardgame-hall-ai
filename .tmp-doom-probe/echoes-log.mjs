import fs from 'node:fs'
const r = JSON.parse(fs.readFileSync(new URL('./session.json', import.meta.url), 'utf8'))
const ev = r.session.events
// start of the Echoes part: find last event mentioning 往事回声 or the first '埋藏的真相'
let startIdx = 0
for (let i = 0; i < ev.length; i++) {
  const t = String(ev[i].text || '')
  if (t.includes('往事回声')) startIdx = i
}
console.log('Echoes mention index', startIdx, 'seq', ev[startIdx]?.seq, 'text', String(ev[startIdx]?.text || '').slice(0, 120))
const from = Math.max(0, startIdx)
for (const e of ev.slice(from)) {
  if (e.type === 'presentation') continue
  const t = String(e.text || '')
  if (e.type === 'info') console.log(`[${e.seq}] ${t.replace(/\n/g, ' ⏎ ').slice(0, 200)}`)
}
