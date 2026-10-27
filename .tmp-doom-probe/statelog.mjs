import fs from 'node:fs'
const r = JSON.parse(fs.readFileSync(new URL('./session.json', import.meta.url), 'utf8'))
const s = r.session.state
console.log('log entries', s.log.length)
console.log('sample', JSON.stringify(s.log[0]).slice(0, 500))
for (const [i, e] of s.log.entries()) {
  console.log(`${i}\t${e.kind || ''}\t${String(e.text || e.title || '').replace(/\n/g, ' ⏎ ').slice(0, 240)}`)
}
