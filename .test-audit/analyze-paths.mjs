// Print self-time grouped by full call path for a .cpuprofile (top paths).
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const top = Number(process.argv[3] || 15)
const file = path.join(dir, readdirSync(dir).find(name => name.endsWith('.cpuprofile')))
const profile = JSON.parse(readFileSync(file, 'utf8'))
const byId = new Map(profile.nodes.map(node => [node.id, node]))
const parent = new Map()
for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id)

const label = node => {
  const frame = node.callFrame
  const url = frame.url.replace(/^.*\/arkhamhorror\//, '').replace(/^node:/, 'node:')
  return `${frame.functionName || '(anon)'}@${url}:${frame.lineNumber + 1}`
}
const pathOf = id => {
  const chain = []
  let cursor = id
  while (cursor != null && chain.length < 40) {
    const node = byId.get(cursor)
    if (!node) break
    chain.push(label(node))
    cursor = parent.get(cursor)
  }
  return chain.reverse().join(' > ')
}
const byPath = new Map()
let totalUs = 0
for (let index = 0; index < profile.samples.length; index++) {
  const id = profile.samples[index]
  const delta = profile.timeDeltas[index] || 0
  totalUs += delta
  const key = pathOf(id)
  byPath.set(key, (byPath.get(key) || 0) + delta)
}
console.log(`total=${(totalUs / 1e6).toFixed(2)}s`)
for (const [key, us] of [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${(us / 1000).toFixed(0).padStart(7)}ms ${(100 * us / totalUs).toFixed(1).padStart(5)}%  ${key}`)
}
