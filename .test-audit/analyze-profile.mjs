// Aggregate a node --cpu-prof .cpuprofile into self-time by function.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const top = Number(process.argv[3] || 25)
const files = readdirSync(dir).filter(name => name.endsWith('.cpuprofile')).map(name => path.join(dir, name))
for (const file of files) {
  const profile = JSON.parse(readFileSync(file, 'utf8'))
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const self = new Map()
  let totalUs = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const id = profile.samples[index]
    const delta = profile.timeDeltas[index] || 0
    totalUs += delta
    const node = byId.get(id)
    if (!node) continue
    const frame = node.callFrame
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url.replace(/^.*\/arkhamhorror\//, '')}:${frame.lineNumber + 1}`
    self.set(key, (self.get(key) || 0) + delta)
  }
  console.log(`\n=== ${path.basename(file)}  total=${(totalUs / 1e6).toFixed(2)}s ===`)
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
  for (const [key, us] of rows) {
    console.log(`${(us / 1000).toFixed(0).padStart(7)}ms  ${(100 * us / totalUs).toFixed(1).padStart(5)}%  ${key}`)
  }
}
