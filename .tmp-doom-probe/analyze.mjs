import fs from 'node:fs'
const r = JSON.parse(fs.readFileSync(new URL('./session.json', import.meta.url), 'utf8'))
const ev = r.session.events
console.log('events', ev.length)
const types = {}
for (const e of ev) types[e.type] = (types[e.type] || 0) + 1
console.log('types', types)
// print non-presentation events whose text mentions doom/agenda
const hits = []
for (const e of ev) {
  if (e.type === 'presentation') continue
  const text = String(e.text || '')
  if (/毁灭|密谋|doom|Agenda|agenda/.test(text)) hits.push(e)
}
console.log('matching events', hits.length)
for (const e of hits.slice(-120)) {
  console.log(`[${e.seq}] ${e.type}: ${String(e.text || '').slice(0, 220).replace(/\n/g, ' ⏎ ')}`)
}
