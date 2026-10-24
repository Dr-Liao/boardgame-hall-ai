import { readFileSync } from 'node:fs'

function parse(path) {
  const xml = readFileSync(path, 'utf8')
  let total = 0, fail = 0, skip = 0
  const fails = []
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  let m
  while ((m = re.exec(xml))) {
    total++
    const attrs = m[1]
    const name = (attrs.match(/name="([^"]*)"/) || [])[1]
    const time = Number((attrs.match(/time="([^"]*)"/) || [])[1] || 0)
    const body = m[2] || ''
    if (body.includes('<failure')) {
      fail++
      const f = body.match(/<failure[^>]*>([\s\S]{0,500})/)
      fails.push({ name, time, message: (f ? f[1] : '').replace(/\s+/g, ' ').slice(0, 400) })
    }
    if (body.includes('<skipped')) skip++
  }
  return { total, fail, skip, fails }
}

for (const file of process.argv.slice(2)) {
  const r = parse(file)
  console.log(`\n=== ${file}: total=${r.total} fail=${r.fail} skip=${r.skip} ===`)
  for (const f of r.fails) console.log(`FAIL [${f.time}s] ${f.name}\n    ${f.message}`)
}
