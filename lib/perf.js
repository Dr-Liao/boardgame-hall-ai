// 联机热路径性能埋点（BOARDGAME_PERF=1 开启；默认关闭，未开启时所有入口早退）。
//
// 设计边界：
//   1. 只观测、不改行为：不修改业务对象、不改变任何响应/线协议，只在内存里记一条记录。
//   2. 默认零开销：未设置 BOARDGAME_PERF=1 时 record() 直接返回，span() 返回空函数，
//      不做 Date.now()/performance.now()/JSON.stringify，也不挂事件循环监视器。
//   3. 能被进程内基准直接读：recordsSince()/count()/summary()/eventLoop() 给
//      tools/perf-online-latency.mjs 这类同进程 harness 用；跨进程时把记录异步追加到
//      <DSH_HOME>/perf.jsonl（BOARDGAME_PERF_FILE=0 可关闭，默认开启）。
//   4. 记录有界：内存环形缓冲最多保留 BUFFER_LIMIT 条，长跑不会把大厅内存拖垮。
//
// 记录格式（每条一行 JSON）：{ ts: 毫秒时间戳, event: 'publishOnline', ...data }
// span() 额外写入 ms（一位小数），summary() 会按 event 聚合 ms 的 count/sum/p50/p95/max。
//
// 用法：
//   BOARDGAME_PERF=1 node server.js
//   BOARDGAME_PERF=1 BOARDGAME_PERF_FILE=0 node tools/perf-online-latency.mjs
//
// 测试里可以 setEnabled(true) 打开，再 reset()/close() 收尾；生产代码不要调用它们。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const BUFFER_LIMIT = 50000
const FILE_FLUSH_MS = 1000

let enabled = process.env.BOARDGAME_PERF === '1'
let fileEnabled = enabled && process.env.BOARDGAME_PERF_FILE !== '0'
let histogram = null
let flushTimer = null
// records[0] 的绝对序号；缓冲裁剪后用它把 recordsSince(index) 映射回数组偏移。
let base = 0
let counter = 0
let written = 0
let records = []
let appending = Promise.resolve()

function defaultPerfFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'perf.jsonl')
}

function startHistogram() {
  if (histogram) return
  // resolution 单位毫秒；默认 10ms 会低估短阻塞，这里取 5ms。
  histogram = monitorEventLoopDelay({ resolution: 5 })
  histogram.enable()
  flushTimer = setInterval(() => { flush().catch(() => {}) }, FILE_FLUSH_MS)
  flushTimer.unref?.()
}

function stopHistogram() {
  if (histogram) { try { histogram.disable() } catch { /* 已关闭 */ } histogram = null }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
}

function nsToMs(value) {
  return Number.isFinite(value) ? +(value / 1e6).toFixed(3) : 0
}

function push(event, data) {
  counter++
  const entry = { ts: Date.now(), event, ...data }
  records.push(entry)
  if (records.length > BUFFER_LIMIT) {
    // 一次裁掉 1/4，避免每条记录都 shift 一次。
    const drop = Math.max(1, Math.floor(BUFFER_LIMIT / 4))
    records.splice(0, drop)
    base += drop
  }
  return counter
}

function serializeSince(from) {
  const first = Math.max(from, base)
  const offset = first - base
  if (offset >= records.length) return ''
  return records.slice(offset).map(entry => JSON.stringify(entry)).join('\n') + '\n'
}

/** 把尚未落盘的记录追加到 perf.jsonl（异步、失败静默；返回写入的字节数）。 */
export function flush() {
  if (!enabled) return Promise.resolve(0)
  if (!fileEnabled) return Promise.resolve(0)
  const body = serializeSince(written)
  if (!body) return Promise.resolve(0)
  const from = written
  // 同步推进水位，避免并发 flush 重复写同一批记录。
  written = Math.max(written, base + records.length)
  const file = defaultPerfFile()
  appending = appending.then(async () => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.appendFile(file, body, 'utf8')
    } catch { /* 埋点失败不影响大厅（例如 DSH_HOME 不可写） */ }
  })
  // from 只用于调试，不参与逻辑。
  void from
  return appending.then(() => Buffer.byteLength(body))
}

/** 同步落盘，供测试/进程退出时使用（不改变业务，只写文件）。 */
export function flushSync() {
  if (!enabled || !fileEnabled) return 0
  const body = serializeSince(written)
  if (!body) return 0
  written = Math.max(written, base + records.length)
  try {
    const file = defaultPerfFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, body, 'utf8')
    return Buffer.byteLength(body)
  } catch { return 0 }
}

export const perf = {
  get enabled() { return enabled },

  /** 记一条事件。返回绝对序号（关闭时返回 -1）。 */
  record(event, data = {}) {
    if (!enabled) return -1
    return push(event, data)
  },

  /**
   * 同步耗时探针：span('publishOnline', { revision }) 返回 end(extra)，调用后记录一条
   * { event, ...data, ...extra, ms } 并返回 ms。关闭时返回空函数，不取时间。
   */
  span(event, data = {}) {
    if (!enabled) return () => 0
    const started = performance.now()
    let done = false
    return (extra = {}) => {
      if (done) return 0
      done = true
      const ms = +(performance.now() - started).toFixed(3)
      push(event, { ...data, ...extra, ms })
      return ms
    }
  },

  /** 当前已记录条数（绝对序号）。 */
  count() { return counter },

  /** 取从绝对序号 from 开始的记录（含被裁剪时只返回还留着的部分）。 */
  recordsSince(from = 0) {
    const requested = Number(from) || 0
    const first = Math.max(requested, base)
    const offset = Math.max(0, first - base)
    return {
      next: base + records.length,
      truncated: requested < base,
      records: offset >= records.length ? [] : records.slice(offset),
    }
  },

  /** 事件循环延迟直方图（毫秒）；未开启时返回 null。 */
  eventLoop() {
    if (!histogram) return null
    try {
      return {
        count: histogram.count,
        maxMs: nsToMs(histogram.max),
        meanMs: nsToMs(histogram.mean),
        p50Ms: nsToMs(histogram.percentile(50)),
        p95Ms: nsToMs(histogram.percentile(95)),
        p99Ms: nsToMs(histogram.percentile(99)),
      }
    } catch { return null }
  },

  /** 清空事件循环延迟窗口（一次行动前后各调一次，读到的 max 就是该行动的阻塞）。 */
  resetEventLoop() {
    if (histogram) try { histogram.reset() } catch { /* 已关闭 */ }
  },

  /**
   * 按 event 聚合记录：count、ms 的 sum/min/max/p50/p95、bytes 系列字段的合计。
   * 只用于基准/测试，不参与大厅运行时热路径。
   */
  summary(input = null) {
    const rows = input || records
    const groups = new Map()
    for (const entry of rows) {
      if (!entry || typeof entry.event !== 'string') continue
      let group = groups.get(entry.event)
      if (!group) { group = { count: 0, ms: [], bytes: 0, fields: {} }; groups.set(entry.event, group) }
      group.count++
      if (Number.isFinite(entry.ms)) group.ms.push(entry.ms)
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'ms' || key === 'ts' || key === 'event' || !Number.isFinite(value)) continue
        if (/bytes/i.test(key)) group.bytes += value
        if (key !== 'count') group.fields[key] = (group.fields[key] || 0) + value
      }
    }
    const out = {}
    for (const [event, group] of groups) {
      const sorted = group.ms.slice().sort((a, b) => a - b)
      // nearest-rank：p95 = 第 ceil(0.95*n) 个样本，避免小样本时 p95 被算成 p50。
      const pick = ratio => {
        if (!sorted.length) return 0
        const rank = Math.min(sorted.length, Math.max(1, Math.ceil(ratio * sorted.length)))
        return sorted[rank - 1]
      }
      out[event] = {
        count: group.count,
        sumMs: +sorted.reduce((sum, value) => sum + value, 0).toFixed(3),
        maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
        p50Ms: +pick(0.5).toFixed(3),
        p95Ms: +pick(0.95).toFixed(3),
        bytes: group.bytes,
        fields: group.fields,
      }
    }
    return out
  },

  /** 清空内存记录与事件循环延迟窗口（测试/基准分段用；先把已有记录落盘再清）。 */
  reset() {
    flushSync()
    records = []
    base = 0
    written = 0
    counter = 0
    perf.resetEventLoop()
  },

  /** 把缓冲落盘并停止监视器（进程退出/测试收尾）。 */
  close() {
    flushSync()
    stopHistogram()
  },

  /** 测试专用：打开/关闭埋点并初始化事件循环监视器。生产代码不要调用。 */
  setEnabled(value) {
    const next = !!value
    if (next === enabled) return enabled
    enabled = next
    if (enabled) {
      fileEnabled = process.env.BOARDGAME_PERF_FILE !== '0'
      records = []
      base = 0
      counter = 0
      written = 0
      startHistogram()
    } else {
      stopHistogram()
      fileEnabled = false
    }
    return enabled
  },
}

// 开启时提前挂上监视器与落盘定时器；关闭时完全不创建。
if (enabled) startHistogram()
