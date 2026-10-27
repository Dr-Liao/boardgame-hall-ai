import fs from 'node:fs'
const oldFile = 'tests/fixtures/replay/golden-replays.json'
const newFile = 'G:/boardgame-hall-ai/.tmp-doom-probe/golden-replays.json'
const oldP = JSON.parse(fs.readFileSync(oldFile, 'utf8'))
const newP = JSON.parse(fs.readFileSync(newFile, 'utf8'))
console.log('old fixtures', oldP.fixtures.length, 'new', newP.fixtures.length)
for (let i = 0; i < newP.fixtures.length; i++) {
  const a = oldP.fixtures[i], b = newP.fixtures[i]
  const changes = []
  if (a.id !== b.id) changes.push('id')
  if (JSON.stringify(a.log) !== JSON.stringify(b.log)) changes.push('log')
  if (JSON.stringify(a.final) !== JSON.stringify(b.final)) changes.push('final')
  if (JSON.stringify(a.hashes) !== JSON.stringify(b.hashes)) {
    const n = Math.max(a.hashes.length, b.hashes.length)
    let diff = 0, first = -1
    for (let k = 0; k < n; k++) if (a.hashes[k] !== b.hashes[k]) { diff++; if (first < 0) first = k }
    changes.push(`hashes(${diff}/${n}, first ${first}, len ${a.hashes.length}->${b.hashes.length})`)
  }
  if (changes.length) console.log(b.id, '=>', changes.join(', '))
}
// top-level metadata
for (const key of ['version', 'generator', 'rulesVersion', 'schemaVersion', 'hashVersion']) {
  if (JSON.stringify(oldP[key]) !== JSON.stringify(newP[key])) console.log('top-level', key, JSON.stringify(oldP[key]), '->', JSON.stringify(newP[key]))
}
