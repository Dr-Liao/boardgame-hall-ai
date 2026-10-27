import fs from 'node:fs'
const r = JSON.parse(fs.readFileSync(new URL('./session.json', import.meta.url), 'utf8'))
const ev = r.session.events
const pres = ev.filter(e => e.type === 'presentation' && e.tableState)
console.log('presentations', pres.length)
const keys = new Set()
for (const p of pres) for (const k of Object.keys(p.tableState)) keys.add(k)
console.log('tableState keys:', [...keys].join(','))
console.log('sample:', JSON.stringify({ seq: pres[0].seq, kind: pres[0].kind, round: pres[0].tableState.round, phase: pres[0].tableState.phase, doom: pres[0].tableState.doom, agendaDoom: pres[0].tableState.agendaDoom, totalDoom: pres[0].tableState.totalDoom }).slice(0, 400))
// print series of doom-related values for last 80 presentations, with kind
for (const p of pres.slice(-70)) {
  const t = p.tableState
  const enemyDoom = (t.enemies || []).reduce((s, e) => s + (e.doom || 0), 0)
  const locDoom = (t.locations || []).reduce((s, l) => s + (l.doom || 0), 0)
  console.log(`${p.seq}\t${p.kind || ''}\tr${t.round}\t${t.phase}\tagendaIdx=${t.agendaIndex}\tdoom=${t.doom}\tagendaDoom=${t.agendaDoom}\ttotalDoom=${t.totalDoom}\tenemyDoom=${enemyDoom}\tlocDoom=${locDoom}`)
}
