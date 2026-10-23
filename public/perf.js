// 浏览器侧联机性能埋点（P0）：纯逻辑，无 DOM / 网络依赖，可被 Node 单测直接 import。
// 只在 ?perf=1（app.js 的 PERF_RENDER）时由 app.js 动态加载；正常访问不会下载本文件。
// 所有数据只保存在内存里，每类只保留最近 PERF_SAMPLE_LIMIT 条，避免长时间对局无限增长。

export const PERF_SAMPLE_LIMIT = 500

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0

function push(list, item) {
  list.push(item)
  if (list.length > PERF_SAMPLE_LIMIT) list.splice(0, list.length - PERF_SAMPLE_LIMIT)
}

// nearest-rank 分位数：与手工采样口径一致，样本为空时返回 0。
function percentile(sorted, ratio) {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

function summarize(samples) {
  const values = samples.map(sample => sample.ms).sort((a, b) => a - b)
  let total = 0
  for (const value of values) total += value
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? values[values.length - 1] : 0,
    total,
  }
}

// status / command 字节分开统计，对应路线图 P0 的「status / command 字节」。
function byteKind(path) {
  if (path.startsWith('/online/status')) return 'status'
  if (path.startsWith('/online/command') || path.startsWith('/online/direct-command')) return 'command'
  return 'other'
}

/**
 * 建立一份浏览器联机性能记录器，并把同一份数据挂到 scope.__ONLINE_PERF__（浏览器里即 window）。
 * @param {object} [scope] 挂载作用域，默认 globalThis（浏览器 window）。
 */
export function createPerfRecorder(scope = globalThis) {
  const requests = []
  const commands = []
  const applies = []
  const renders = []

  const recorder = {
    enabled: true,
    requests,
    commands,
    applies,
    renders,
    /** 记录一次 /online/* 请求：耗时与响应字节（字节优先取 content-length，缺省回退文本字节）。 */
    recordRequest({ path = '', method = 'GET', ms = 0, bytes = 0 } = {}) {
      push(requests, { path: String(path), method: String(method).toUpperCase(), ms: number(ms), bytes: number(bytes), at: Date.now() })
    },
    /** 记录一次联机命令：动作、传输方式（direct / relay）与总耗时。 */
    recordCommand({ action = '', transport = 'relay', ms = 0 } = {}) {
      push(commands, { action: String(action), transport: String(transport), ms: number(ms), at: Date.now() })
    },
    /** 记录一次 accept() 同步 apply：serial、是否更换 session、耗时。 */
    recordApply({ serial = -1, sessionChanged = false, ms = 0 } = {}) {
      push(applies, { serial: number(serial), sessionChanged: !!sessionChanged, ms: number(ms), at: Date.now() })
    },
    /** 记录一次 render() 整树重绘耗时。 */
    recordRender(ms = 0) {
      push(renders, { ms: number(ms), at: Date.now() })
    },
    /** 汇总：每类 count / p50 / p95 / max / total；requests 另带字节合计。不修改已记录数据。 */
    summary() {
      const bytes = { total: 0, status: 0, command: 0, other: 0 }
      for (const request of requests) {
        bytes.total += request.bytes
        bytes[byteKind(request.path)] += request.bytes
      }
      const transports = { direct: 0, relay: 0 }
      for (const command of commands) transports[command.transport] = (transports[command.transport] || 0) + 1
      const changedApplies = applies.reduce((count, apply) => count + (apply.sessionChanged ? 1 : 0), 0)
      return {
        requests: { ...summarize(requests), bytes },
        commands: { ...summarize(commands), transports },
        applies: { ...summarize(applies), sessionChanged: changedApplies },
        renders: summarize(renders),
      }
    },
    /** 清空全部已记录样本（联机重开一局 / 重新采基线时用）。 */
    reset() {
      requests.length = 0
      commands.length = 0
      applies.length = 0
      renders.length = 0
    },
  }

  // 数据挂到作用域上：浏览器控制台可直接看 window.__ONLINE_PERF__.summary()。
  if (scope) scope.__ONLINE_PERF__ = recorder
  return recorder
}
