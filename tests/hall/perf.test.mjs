// lib/perf.js 的自测：默认关闭零副作用、开启后记录/计时/事件循环窗口/JSONL 落盘。
//
// 这些用例直接操作模块级开关，所以每个开启埋点的用例都先建临时 DSH_HOME，
// 结束时关闭埋点并恢复环境变量，避免把 perf.jsonl 写进真实 home。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { perf, flush, flushSync } from '../../lib/perf.js'

function withPerf(t, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-perf-'))
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    BOARDGAME_PERF_FILE: process.env.BOARDGAME_PERF_FILE,
  }
  process.env.DSH_HOME = home
  if (env.BOARDGAME_PERF_FILE !== undefined) process.env.BOARDGAME_PERF_FILE = env.BOARDGAME_PERF_FILE
  perf.setEnabled(true)
  perf.reset()
  t.after(() => {
    perf.setEnabled(false)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

test('默认关闭：record/span/summary/eventLoop 全部零副作用', () => {
  // 即使外部环境带着 BOARDGAME_PERF=1 跑测试，这里也先关掉再断言默认路径。
  if (perf.enabled) perf.setEnabled(false)
  assert.equal(perf.enabled, false)
  assert.equal(perf.record('demo.record', { bytes: 1 }), -1)
  assert.equal(perf.count(), 0)
  assert.deepEqual(perf.recordsSince(0).records, [])
  assert.equal(perf.summary().demo, undefined)
  const end = perf.span('demo.span', { n: 1 })
  assert.equal(typeof end, 'function')
  assert.equal(end({ extra: true }), 0)
  assert.equal(perf.count(), 0, '关闭时 span 不产生记录')
  assert.equal(perf.eventLoop(), null)
  assert.equal(flushSync(), 0)
})

test('开启后：record/span 写入带序号的记录，recordsSince 按窗口取', t => {
  withPerf(t, { BOARDGAME_PERF_FILE: '0' })
  assert.equal(perf.enabled, true)
  const first = perf.record('demo.single', { bytes: 10 })
  assert.equal(first, 1)
  const end = perf.span('demo.span', { kind: 'publish' })
  const ms = end({ extra: 2 })
  assert.ok(Number.isFinite(ms) && ms >= 0)
  assert.equal(perf.count(), 2)
  const window = perf.recordsSince(0)
  assert.equal(window.records.length, 2)
  assert.equal(window.next, 2)
  assert.equal(window.truncated, false)
  const tail = perf.recordsSince(1)
  assert.equal(tail.records.length, 1)
  assert.equal(tail.records[0].event, 'demo.span')
  assert.equal(tail.records[0].kind, 'publish')
  assert.equal(tail.records[0].extra, 2)
  assert.ok(tail.records[0].ts > 0)
  // 空窗口也能正常返回。
  assert.deepEqual(perf.recordsSince(2).records, [])
})

test('开启后：summary 按事件聚合 count/ms 分位/bytes', t => {
  withPerf(t, { BOARDGAME_PERF_FILE: '0' })
  for (const [ms, bytes] of [[1, 100], [3, 200], [5, 300], [7, 400]]) perf.record('demo.publish', { ms, bytes })
  perf.record('demo.skip', { kind: 'skip' })
  const summary = perf.summary(perf.recordsSince(0).records)
  assert.equal(summary['demo.publish'].count, 4)
  assert.equal(summary['demo.publish'].sumMs, 16)
  assert.equal(summary['demo.publish'].maxMs, 7)
  assert.equal(summary['demo.publish'].p50Ms, 3)
  assert.equal(summary['demo.publish'].p95Ms, 7)
  assert.equal(summary['demo.publish'].bytes, 1000)
  assert.equal(summary['demo.skip'].count, 1)
  assert.equal(summary['demo.skip'].fields.kind, undefined, '字符串字段不参与数值聚合')
})

test('开启后：事件循环延迟窗口可复位读取', async t => {
  withPerf(t, { BOARDGAME_PERF_FILE: '0' })
  perf.resetEventLoop()
  // 先让监视器的采样定时器跑起来，否则紧接着的阻塞会让第一次采样错过窗口。
  await new Promise(resolve => setTimeout(resolve, 20))
  const until = Date.now() + 120
  while (Date.now() < until) { /* 故意同步阻塞，制造可观测的事件循环延迟 */ }
  await new Promise(resolve => setTimeout(resolve, 60))
  const before = perf.eventLoop()
  assert.ok(before, '开启埋点后应有事件循环直方图')
  assert.ok(before.maxMs >= 30, `同步阻塞 120ms 后 max 应明显大于 0，实际 ${before.maxMs}`)
  perf.resetEventLoop()
  await new Promise(resolve => setTimeout(resolve, 30))
  const after = perf.eventLoop()
  assert.ok(after && after.maxMs <= before.maxMs, '复位后的窗口不应保留上一段的最大值')
})

test('开启后：flush 把记录追加到 DSH_HOME/perf.jsonl 且不修改业务对象', async t => {
  const home = withPerf(t)
  const payload = { revision: 7, seats: 4 }
  perf.record('demo.flush', payload)
  assert.deepEqual(payload, { revision: 7, seats: 4 }, '埋点不能修改传入对象')
  flushSync()
  const file = path.join(home, 'perf.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].event, 'demo.flush')
  assert.equal(lines[0].revision, 7)
  assert.equal(lines[0].seats, 4)
  assert.ok(lines[0].ts > 0)
  assert.equal(await flush(), 0, '没有新记录时异步 flush 不重复写')
  perf.record('demo.flush2', { n: 1 })
  assert.ok(await flush() > 0)
  const all = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(all.map(line => line.event), ['demo.flush', 'demo.flush2'])
})

test('开启后：缓冲有界，裁剪后 recordsSince 返回 truncated', t => {
  withPerf(t, { BOARDGAME_PERF_FILE: '0' })
  // 记录上限 50000；多写 32 条确认从头部裁剪且序号仍然连续。
  for (let i = 0; i < 50032; i++) perf.record('demo.bulk', { i })
  assert.equal(perf.count(), 50032)
  const window = perf.recordsSince(0)
  assert.equal(window.truncated, true)
  assert.ok(window.records.length <= 50000)
  assert.equal(window.records.at(-1).i, 50031, '最新记录必须保留')
  const tail = perf.recordsSince(50031)
  assert.equal(tail.records.length, 1)
  assert.equal(tail.records[0].i, 50031)
})
