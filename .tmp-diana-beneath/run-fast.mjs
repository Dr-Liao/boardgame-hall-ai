// 自定义 fast 套件执行器：沙箱里 `node --test` 的子进程管道会被拒（spawn EPERM），
// 这里改成「每个测试文件直接用 node 跑（stdio: inherit）」，用少量 worker 并发。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { FAST_TESTS } from '../games/arkhamhorror/tests/suites.mjs'

const cwd = fileURLToPath(new URL('../games/arkhamhorror', import.meta.url))
const GUARD = 'tests/suite-manifest.test.mjs'
const files = [GUARD, ...FAST_TESTS.map(name => `tests/${name}`)]
const WORKERS = Number(process.env.WORKERS || 4)

const results = new Map()
let cursor = 0

function next() {
  if (cursor >= files.length) return null
  return files[cursor++]
}

function runWorker() {
  return new Promise(resolve => {
    const runNext = () => {
      const file = next()
      if (!file) return resolve()
      const child = spawn(process.execPath, [file], { cwd, stdio: 'inherit' })
      child.on('exit', code => {
        results.set(file, code ?? 1)
        runNext()
      })
      child.on('error', error => {
        results.set(file, 127)
        console.error('[runner] spawn error', file, error.message)
        runNext()
      })
    }
    runNext()
  })
}

const started = Date.now()
await Promise.all(Array.from({ length: Math.min(WORKERS, files.length) }, () => runWorker()))
const failed = [...results.entries()].filter(([, code]) => code !== 0)
console.log(`\n[runner] files=${results.size} failed=${failed.length} elapsed=${Math.round((Date.now() - started) / 1000)}s`)
for (const [file, code] of failed) console.log(`[runner] FAIL(${code}) ${file}`)
process.exit(failed.length ? 1 : 0)
