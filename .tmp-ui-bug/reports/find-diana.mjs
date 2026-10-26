// find investigator entry by chinese name in cards-data.js
import { readFileSync } from 'node:fs'
const txt = readFileSync('games/arkhamhorror/src/cards/cards-data.js', 'utf8')
const needle = process.argv[2] || '黛安娜·史丹利'
let idx = -1, found = 0
while ((idx = txt.indexOf(needle, idx + 1)) >= 0 && found < 8) {
  found++
  const before = txt.slice(Math.max(0, idx - 6000), idx)
  const m = [...before.matchAll(/"code": "([0-9]+)"/g)]
  const code = m.length ? m[m.length - 1][1] : '?'
  const typeM = [...before.matchAll(/"type": "([a-z]+)"/g)]
  const type = typeM.length ? typeM[typeM.length - 1][1] : '?'
  console.log(found, 'offset', idx, 'code', code, 'type', type)
}
// also dump the object containing the investigator code
for (const code of ['02002', '01003']) {
  const i = txt.indexOf(`"code": "${code}"`)
  console.log('---', code, 'at', i, i >= 0 ? txt.slice(i, i + 420).replace(/\n\s*/g, ' ') : '')
}
