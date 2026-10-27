import fs from 'node:fs'
const text = fs.readFileSync('games/arkhamhorror/src/cards/cards-data.js', 'utf8')
const codes = process.argv.slice(2)
for (const code of codes) {
  const needle = '"code": "' + code + '"'
  const i = text.indexOf(needle)
  if (i < 0) { console.log('===== ' + code + ' NOT FOUND'); continue }
  const start = text.lastIndexOf('{', i)
  let depth = 0, end = start
  for (let j = start; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}') { depth--; if (!depth) { end = j + 1; break } }
  }
  const o = JSON.parse(text.slice(start, end))
  console.log('=====', code, o.nameZh || o.name, '| type:', o.type, '| traits:', JSON.stringify(o.traitsZh || o.traits), '| doom:', o.doom ?? '-', '| clues:', o.clues ?? '-')
  const body = (o.textZh || o.text || '').replace(/\n/g, ' ⏎ ')
  if (body) console.log('textZh:', body)
  const back = (o.backTextZh || o.backText || '').replace(/\n/g, ' ⏎ ')
  if (back) console.log('backTextZh:', back)
}
