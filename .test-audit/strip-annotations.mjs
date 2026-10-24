// One-off: strip hard-coded per-file second annotations from suites.mjs (kept descriptions).
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'G:/boardgame-hall-ai/games/arkhamhorror/tests/suites.mjs'
const source = readFileSync(file, 'utf8')
const lines = source.split('\n')
let changed = 0
const next = lines.map(line => {
  const match = /^(\s*)'([^']+\.test\.mjs)',\s*(?:\/\/\s*(.*))?$/.exec(line)
  if (!match) return line
  const indent = match[1]
  const name = match[2]
  let comment = (match[3] ?? '').trim()
  const before = comment
  comment = comment.replace(/^[\d.]+\s*/, '').replace(/^—+\s*/, '').trim()
  if (comment !== before) changed++
  return comment ? `${indent}'${name}', // ${comment}` : `${indent}'${name}',`
})
writeFileSync(file, next.join('\n'))
console.log(`cleaned ${changed} annotation lines`)
