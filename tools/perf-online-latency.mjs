#!/usr/bin/env node
// 联机延迟基准：「点击 → 桌面」的服务端分阶段数字（P0 交付物，诊断用，不参与发布构建）。
//
// 用法：
//   node tools/perf-online-latency.mjs                                  # 4 真人厅 + 本机 relay，真实 hub 开局，推进 100 步（前 5 步预热）
//   node tools/perf-online-latency.mjs --moves=20
//   node tools/perf-online-latency.mjs --setup=fast --moves=20           # legacyAutoStart 跳过 hub，只做快速冒烟
//   node tools/perf-online-latency.mjs --ai=2 --moves=10                # 4 人房，后 2 席留给 AI（合法动作兜底，不联网）
//   node tools/perf-online-latency.mjs --moves=20 --json=artifacts/perf/run.json
//   node tools/perf-online-latency.mjs --moves=20 --baseline=artifacts/perf/base.json   # 不存在则写基线；存在则比较，回归 exit 1
//   node tools/perf-online-latency.mjs --moves=20 --compare=artifacts/perf/run.json     # 并排对照，不影响退出码
//
// 进程模型（与 docs/arkham-performance-roadmap.md §1.1 基线口径一致）：
//   单 Node 进程内 createRelay + N 个 createServer（每个大厅随机端口；房主 persist=true、客人 persist=false），
//   DSH_HOME 指向本次运行的临时目录（--keep-home 可保留）。建号/加入/准备/开始全部走现有 /api/online/*
//   （header x-boardgame-online: 1），推进时按当前可行动席位 POST /api/online/command（action=move）。
//
// 开局口径（--setup，默认 hub）：
//   hub  真实 campaignHub：start 后先推进 hubGoSetup→选调查员→自动牌组→确认准备→选队长→开始剧本，
//        直到 state.uiState==='inScenario' 才开始计数。hub 步只打印、不计入统计。
//        这会使视图带完整卡池（state.cards ≈ 785KB），命令响应/status 回到路线图 §1.3/§1.4 的
//        1.1MB 量级——手工基线就是在这个口径下量的。
//   fast legacyAutoStart 跳过 hub：开局直接 inScenario，视图只带内嵌卡表（≈300KB），只用于快速冒烟。
//
// 关键环境：必须在动态 import lib 之前设置 process.env，否则 lib/perf.js 在模块加载时就把埋点关掉了。
//   BOARDGAME_PERF=1、BOARDGAME_PERF_FILE=0（不写 JSONL）、AI_CHAT_ENABLED=0、AI_API_KEY=''（强制兜底，绝不联网）。
//
// 指标口径（每个被统计的动作 = 一次真实联机 command；按 seat 0 / 非 0 分组成 host / guest）：
//   commandMs        该席位大厅 POST /api/online/command 的墙钟往返（含请求编码、服务端处理、响应读取）。
//                    P2.2 起 AI 回包解耦：带 AI 的动作这里量到的是「命令确认」耗时（不等模型）。
//   aiWaitMs         P2.2：命令返回 aiPending 后，等到大厅 busy=false（后台 AI 回合完成）的耗时；
//                    与 commandMs 一起给出「AI 确认 vs AI 完成」两条线。
//   commandBytes     该 POST 响应文本的字节数。房主响应仍含完整个人视图；客人默认按 P1.2 浏览器
//                    口径（body.client.slim）只收摘要，用 --client=legacy 可复现旧客户端的整份响应。
//   statusBytes      动作结束后房主 GET /api/online/status 的响应字节（浏览器「拉整份状态」的口径）。
//                    --client=browser 下 harness 会像浏览器一样缓存 staticVersion：首份回全量，
//                    之后的 status/command 都声明 clientStatic，静态表只收一次（P1.4）。
//   serialDelta      动作期间「行动席位」自己的 online status serial 变化次数（每次变化浏览器就会拉一次 status）。
//   statusDownlink   ≈ statusBytes × max(serialDelta + 1, 1)。为什么这样折算：online-ui 在收到每次 serial
//                    变化时拉一次 status（serialDelta 次），命令结束后还会显式 refresh() 一次（+1）；
//                    动作期间没有 serial 变化时至少也有那一次显式 refresh，所以下限取 1。
//   publishCount     该动作窗口内 perf 记录 event==='publishOnline' 的条数（房主每次重发视图算一次）。
//   publishBytes     publish.member 按 kind（full/delta/skip）聚合的条数与线协议字节合计。
//   publishMs        publishOnline 的 ms 合计；phaseMs = phase.commit / reactions / snapshot / ai 各自 ms 合计。
//   eventLoopMaxMs   命令前 perf.resetEventLoop()，命令完成后等 ~30ms 读 perf.eventLoop().maxMs：
//                    该动作期间事件循环延迟直方图的最大值（阻塞代理指标；同进程 harness 自身的大 JSON
//                    读取也会计入，所以只用于同机前后对比，不要把绝对值当线上浏览器指标）。
//
// 退出码：0 正常；1 执行失败 / --baseline 检测到回归；2 参数错误。
//
// --baseline 回归判定：对核心指标（hostCommandMs、guestCommandMs、commandBytes、statusDownlink、
//   publishCount、eventLoopMaxMs）用 summary.metrics.<key>.p50 与基线比较：比基线差 >20% 且绝对增量超过
//   该指标的「有意义阈值」才算回归（时延 20ms、字节 64KiB、publishCount 1；避免噪声误报）。
//
// 已知限制：
//   1. relay 与所有大厅同进程，命令往返比真实 WAN 低；绝对值看数量级，趋势/回归看同一台机器的前后对比。
//   2. 同进程共享事件循环：harness 读大响应仍会占事件循环，eventLoopMaxMs 只能作为阻塞代理指标。
//   3. 推进规则是「取当前席位合法动作里第一个非 hub 动作、pendingChoice 优先 done/skip/pass/keep」，
//      不代表真实牌序或人类策略；它只负责稳定地制造命令流量。hub 开局的准备动作不计入统计。
//   4. 需要 Arkham Horror Mod 自带的大厅接口（lib/mods.js 加载内置 games/arkhamhorror）。
//   5. stderr 可能打印「未配置 AI_API_KEY」——这是兜底路径的预期提示。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
// P3.1：status 增量还原（纯函数、无副作用，可安全静态 import）。
import { applySnapshotChanges } from '../lib/online-sync.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MOD_ID = 'arkhamhorror'
const SCHEMA_VERSION = 1
const TOOL = 'perf-online-latency'
// 事件循环延迟直方图在命令结束后再等一小段，确保收尾的 publish/定时器都落进窗口。
const EVENT_LOOP_SETTLE_MS = 30
const COMMAND_TIMEOUT_MS = 190000
const STATUS_TIMEOUT_MS = 60000
const VIEW_SYNC_TIMEOUT_MS = 5000
const MAX_CONSECUTIVE_FAILURES = 10

const USAGE = `联机延迟基准（同进程多厅 + 本机 relay）

用法：node tools/perf-online-latency.mjs [选项]

选项：
  --seats=4          大厅/房间席位数（Arkham 支持 2–4；默认 4）
  --moves=100        要统计的动作数（不含预热；默认 100）
  --warmup=5         预热动作数，不计入统计（默认 5）
  --setup=hub        开局流程：hub=真实 campaignHub（选调查员/牌组，匹配路线图基线口径，默认）；
                     fast=legacyAutoStart 跳过 hub（只用于快速冒烟，视图明显更小）
  --ai=0|2           预留后 N 个 AI 席位（合法动作兜底，不联网；默认 0）
  --seed=perf        Arkham 对局种子
  --status=host      动作后测哪些大厅的 status 响应：host|all|none（默认 host）
  --client=browser   客户端能力口径：browser=真实浏览器（默认；客人命令带 client.slim，浏览器缓存
                     静态表后 status/命令带 clientStatic/staticVersion，P1.4）；legacy=旧客户端
                     （无 slim、无静态表缓存，用于和 P1.2/P1.4 之前的基线对比）
  --json=<file>      把完整结果 JSON 写到文件（默认不写）
  --baseline=<file>  文件不存在：写本次结果为基线；存在：比较并检测回归（exit 1）
  --compare=<file>   读取另一份运行 JSON 并排对照（不影响退出码）
  --keep-home        保留本次临时 DSH_HOME 目录（默认结束后删除）
  --verbose          打印每个动作的明细
  --help             显示本帮助

退出码：0 正常；1 执行失败 / --baseline 回归；2 参数错误。`

// ---------------------------------------------------------------------------
// 1. 参数解析（必须在 import lib 之前完成，因为下面要按参数设置环境变量）
// ---------------------------------------------------------------------------

class ArgError extends Error {}

const BOOLEAN_FLAGS = new Set(['keep-home', 'verbose', 'help'])

function parseInteger(name, raw, min, max) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ArgError(`--${name} 需要 ${min}–${max} 的整数，收到 ${raw}`)
  }
  return value
}

function parseArgs(argv) {
  const options = {
    seats: 4, moves: 100, warmup: 5, ai: 0, seed: 'perf', status: 'host', setup: 'hub', client: 'browser',
    json: '', baseline: '', compare: '', keepHome: false, verbose: false, help: false,
  }
  for (const raw of argv) {
    if (typeof raw !== 'string' || !raw.startsWith('--') || raw.length < 3) {
      throw new ArgError(`无法识别的参数：${raw}`)
    }
    const equal = raw.indexOf('=')
    const key = equal === -1 ? raw.slice(2) : raw.slice(2, equal)
    const value = equal === -1 ? undefined : raw.slice(equal + 1)
    if (BOOLEAN_FLAGS.has(key)) {
      if (value !== undefined) throw new ArgError(`--${key} 不接受取值`)
      if (key === 'keep-home') options.keepHome = true
      else if (key === 'verbose') options.verbose = true
      else options.help = true
      continue
    }
    if (value === undefined) throw new ArgError(`--${key} 需要一个取值，例如 --${key}=...`)
    if (key === 'seats') options.seats = parseInteger('seats', value, 2, 8)
    else if (key === 'moves') options.moves = parseInteger('moves', value, 1, 100000)
    else if (key === 'warmup') options.warmup = parseInteger('warmup', value, 0, 100000)
    else if (key === 'ai') {
      const ai = Number(value)
      if (ai !== 0 && ai !== 2) throw new ArgError(`--ai 只支持 0 或 2，收到 ${value}`)
      options.ai = ai
    } else if (key === 'seed') options.seed = value
    else if (key === 'setup') {
      if (!['hub', 'fast'].includes(value)) throw new ArgError(`--setup 只支持 hub|fast，收到 ${value}`)
      options.setup = value
    } else if (key === 'status') {
      if (!['host', 'all', 'none'].includes(value)) throw new ArgError(`--status 只支持 host|all|none，收到 ${value}`)
      options.status = value
    } else if (key === 'client') {
      if (!['browser', 'legacy'].includes(value)) throw new ArgError(`--client 只支持 browser|legacy，收到 ${value}`)
      options.client = value
    } else if (key === 'json') options.json = value
    else if (key === 'baseline') options.baseline = value
    else if (key === 'compare') options.compare = value
    else throw new ArgError(`未知选项 --${key}`)
  }
  if (options.ai > 0 && options.seats - options.ai < 1) {
    throw new ArgError(`--ai=${options.ai} 至少需要 ${options.ai + 1} 个席位（人机双方都要有人类推进）`)
  }
  return options
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`[参数错误] ${error.message}\n\n${USAGE}`)
  process.exit(2)
}
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 2. 环境变量：必须在动态 import lib 之前设置。
//    lib/perf.js 在模块加载时读取 BOARDGAME_PERF/BOARDGAME_PERF_FILE；lib/agent/config.js
//    在 createAgent() 时读取 AI_API_KEY。这里强制离线兜底，保证基准不依赖外网模型。
// ---------------------------------------------------------------------------

const previousDSHHome = process.env.DSH_HOME
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-online-latency-'))
process.env.DSH_HOME = home
process.env.BOARDGAME_PERF = '1'
process.env.BOARDGAME_PERF_FILE = '0'
process.env.AI_CHAT_ENABLED = '0'
// 空字符串会被 lib/agent/config.js 的 pick() 视为「未配置」，从而走 legalMoves 兜底。
process.env.AI_API_KEY = ''

const { createRelay } = await import('../relay/server.js')
const { createServer } = await import('../lib/server.js')
const { perf } = await import('../lib/perf.js')
const { loadMods } = await import('../lib/mods.js')

// ---------------------------------------------------------------------------
// 3. 通用工具
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const round3 = value => +Number(value).toFixed(3)

function listen(server) {
  return new Promise((resolve, reject) => {
    const fail = error => reject(error)
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

function closeServer(server) {
  return new Promise(resolve => {
    try { server.online?.close() } catch { /* 已关闭 */ }
    try { server.closeAllConnections?.() } catch { /* 已关闭 */ }
    try { server.close(() => resolve()) } catch { resolve() }
  })
}

function closeRelay(relay) {
  return new Promise(resolve => {
    try { relay.closeAllConnections?.() } catch { /* 已关闭 */ }
    try { relay.close(resolve) } catch { resolve() }
  })
}

function displayPath(file) {
  const absolute = path.resolve(file)
  const relative = path.relative(ROOT, absolute)
  return relative && !relative.startsWith('..') ? relative.replaceAll('\\', '/') : absolute
}

function writeJsonFile(file, data) {
  const absolute = path.resolve(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return displayPath(absolute)
}

// 中英混排的定宽填充（CJK 字符占两列）。
function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1
  }
  return width
}

function padEndDisplay(text, width) {
  const value = String(text)
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}

function padStartDisplay(text, width) {
  const value = String(text)
  return ' '.repeat(Math.max(0, width - displayWidth(value))) + value
}

// 最近邻百分位：p95 = 第 ceil(0.95n) 个样本（与 lib/perf.js 的 summary 口径一致）。
function stats(values) {
  const list = values.filter(value => typeof value === 'number' && Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (!list.length) return { count: 0, mean: null, p50: null, p95: null, max: null, min: null }
  const pick = ratio => list[Math.min(list.length - 1, Math.max(0, Math.ceil(ratio * list.length) - 1))]
  return {
    count: list.length,
    mean: round3(list.reduce((sum, value) => sum + value, 0) / list.length),
    p50: pick(0.5),
    p95: pick(0.95),
    max: list[list.length - 1],
    min: list[0],
  }
}

// 所有大厅共用的 HTTP 调用；返回响应文本字节数（不解析大响应，避免污染事件循环指标）。
async function request(hall, route, body, timeoutMs) {
  const started = performance.now()
  const response = await fetch(hall.origin + '/api/online/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-boardgame-online': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  return {
    httpStatus: response.status,
    bytes: Buffer.byteLength(text),
    ms: round3(performance.now() - started),
    text,
  }
}

function createHall(server, origin, guest = false) {
  const hall = {
    server,
    origin,
    guest,
    // 浏览器侧静态表缓存版本（P1.4）：首次 status/命令回全量后记下 staticVersion，
    // 之后的请求都声明这个版本，服务器才省略两张公共表。
    staticVersion: null,
    // P3.1：浏览器侧 status 增量基线（上一次收到的会话视图 + stamp）。
    statusView: null,
    statusStamp: '',
    call: (route, body, timeoutMs = STATUS_TIMEOUT_MS) => {
      let finalRoute = route
      if (options.client === 'browser' && route.startsWith('status')) {
        const separator = route.includes('?') ? '&' : '?'
        if (hall.staticVersion) finalRoute = finalRoute + separator + 'clientStatic=' + encodeURIComponent(hall.staticVersion)
        if (hall.statusStamp) {
          finalRoute = finalRoute + (finalRoute.includes('?') ? '&' : '?') + 'baseStamp=' + encodeURIComponent(hall.statusStamp)
        }
      }
      return request(hall, finalRoute, body, timeoutMs)
    },
    // 联机命令统一带 operationId（大厅用它做幂等）。
    // P1.2 起浏览器客人用 body.client.slim 声明只要摘要；--client=legacy 保留旧客户端口径。
    // P1.4：浏览器把已知 staticVersion 放进 body.client，服务器据此省略静态表。
    command: (action, body = {}, timeoutMs = COMMAND_TIMEOUT_MS) => request(hall, 'command', {
      action,
      body: {
        operationId: randomUUID(),
        ...(options.client === 'browser'
          ? { client: { ...(guest ? { slim: true } : {}), ...(hall.staticVersion ? { staticVersion: hall.staticVersion } : {}) } }
          : {}),
        ...body,
      },
    }, timeoutMs),
  }
  return hall
}

// 从 status / 命令响应里记住当前 hall 视角的 staticVersion（浏览器缓存的等价物）。
function noteStaticVersion(hall, json) {
  const version = json?.session?.staticVersion ?? json?.staticVersion
  if (typeof version === 'string' && version) hall.staticVersion = version
}

async function readStatus(hall) {
  const response = await hall.call('status')
  let json
  try { json = JSON.parse(response.text) } catch { throw new Error(`status 响应不是合法 JSON（${response.httpStatus}）`) }
  // P3.1：像浏览器一样把 sessionDelta 应用到上一份视图；sessionOmitted 表示内容未变。
  if (json.sessionDelta) {
    try {
      if (!hall.statusView) throw new Error('缺少本地基线')
      json.session = applySnapshotChanges(hall.statusView, json.sessionDelta.changes)
    } catch {
      json.session = undefined  // 交给调用方重试：下一次请求会因基线不符拿到全量
    }
    delete json.sessionDelta
  } else if (json.sessionOmitted) {
    json.session = hall.statusView || undefined
    delete json.sessionOmitted
  }
  noteStaticVersion(hall, json)
  if (json.session) {
    hall.statusView = json.session
    hall.statusStamp = typeof json.stamp === 'string' ? json.stamp : ''
  }
  return { bytes: response.bytes, ms: response.ms, json }
}

// P2.2：AI 回包解耦后，命令响应会在 AI 回合完成前返回（busy=true）；测量「AI 确认」用命令响应
// 本身的耗时，然后必须等大厅空闲（busy=false）才能推进下一步，否则会收到 SESSION_BUSY。
async function waitForIdle(hall, timeoutMs = 180000) {
  const started = performance.now()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!hall.server.online?.status().busy) return round3(performance.now() - started)
    await sleep(20)
  }
  throw new Error(`大厅 busy 在 ${timeoutMs}ms 内没有恢复（AI 回合未完成？）`)
}

// 等某个大厅通过中转收到指定 revision 的视角（客人视角异步到达；只读进程内状态，不发 HTTP）。
async function waitForView(hall, revision, timeoutMs = VIEW_SYNC_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const view = hall.server.online?.status().session
    if (view?.state?.revision === revision) return view
    await sleep(5)
  }
  return null
}

// 当前应行动的人类席位：优先 decisionSeat，其次 actingSeats 里第一个有人类大厅的席位。
function pickActingSeat(view, humans) {
  if (!view?.state) return null
  const acting = Array.isArray(view.actingSeats) && view.actingSeats.length
    ? view.actingSeats
    : Number.isInteger(view.decisionSeat) ? [view.decisionSeat] : []
  const humanActing = acting.filter(seat => Number.isInteger(seat) && seat >= 0 && seat < humans)
  if (!humanActing.length) return null
  return humanActing.includes(view.decisionSeat) ? view.decisionSeat : humanActing[0]
}

const HUB_PRIORITY = [
  'hubContinue', 'hubGoSetup', 'hubBeginScenario', 'hubAutoDeck', 'hubDoneSeat',
  'hubSelectInvestigator', 'hubSetLeader', 'hubSelectScenario', 'hubSetDifficulty',
  'hubAutoUpgrade', 'hubPurchase', 'hubConfirmUpgrades', 'hubSetDeck', 'hubCancelUpgrades',
]

// hub 开局（选调查员/牌组 → 选队长 → 开始剧本）的候选顺序。lead 在基线口径里要求默认走
// 真实 campaignHub：视图里带完整卡池（state.cards ≈ 785KB），命令响应/status 才是路线图
// §1.3/§1.4 的 1.1MB 量级；--setup=fast 的 legacyAutoStart 只带最小卡表。
// 说明：hubBeginScenario 只在队长已确认后才出现在 legalMoves 里，所以能选到它时优先开始，
// 避免 hubSetLeader 在不同队长候选之间来回切换。
const HUB_PREP_PRIORITY = [
  'hubGoSetup', 'hubBeginScenario',
  'hubSelectInvestigator', 'hubAutoDeck', 'hubDoneSeat',
  'hubSetLeader', 'hubSelectScenario', 'hubSetDifficulty', 'hubReopenSetup',
  'hubAutoUpgrade', 'hubPurchase', 'hubConfirmUpgrades', 'hubSetDeck', 'hubContinue',
]

function hubPrepareCandidates(state, seat) {
  const moves = Array.isArray(state?.legalMoves) ? state.legalMoves : []
  const ordered = []
  const push = list => { for (const move of list) if (!ordered.includes(move)) ordered.push(move) }
  for (const action of HUB_PREP_PRIORITY) {
    // 已经选过调查员的座位不再重复选，否则会在多个候选人之间来回切换（revision 涨但不推进）。
    if (action === 'hubSelectInvestigator' && state?.hubSeatSelected?.[seat]) continue
    push(moves.filter(move => move.action === action))
  }
  push(moves)
  return ordered
}

function byteSize(value) {
  if (value === undefined) return 0
  try { return Buffer.byteLength(JSON.stringify(value)) } catch { return null }
}

// 视图构成诊断（对齐 docs/arkham-performance-roadmap.md §1.3 的分项口径）。
function viewComposition(view) {
  if (!view?.state) return null
  const totalBytes = byteSize(view)
  const cardsBytes = byteSize(view.state.cards)
  const eventsBytes = byteSize(view.events)
  const investigatorDefsBytes = byteSize(view.state.investigatorDefs)
  return {
    revision: view.state.revision ?? null,
    uiState: view.state.uiState ?? null,
    totalBytes,
    cardsBytes,
    eventsBytes,
    investigatorDefsBytes,
    otherBytes: totalBytes === null ? null : totalBytes - cardsBytes - eventsBytes - investigatorDefsBytes,
    eventCount: Array.isArray(view.events) ? view.events.length : null,
  }
}

function investigatorStatus(view) {
  return (view?.state?.investigators || []).map(inv => ({
    seat: inv.seat, name: inv.name, defeated: !!inv.defeated, resigned: !!inv.resigned,
    health: inv.health, sanity: inv.sanity,
  }))
}

// hub 开局：从 campaignHub 一路推进到 uiState==='inScenario'（选调查员/牌组/队长/开始剧本）。
// 这些步骤会打印在日志里，但不计入延迟统计；返回最终房主视角与逐步明细。
async function driveHubPrep({ host, halls, humans, startView, startBytes }) {
  const hubSteps = []
  let hostStatus = { json: { session: startView }, bytes: startBytes, ms: null }
  const maxSteps = 200
  let attempt = 0
  let lastSignature = ''
  let repeats = 0
  let rotations = 0
  let failures = 0
  for (let index = 0; index < maxSteps; index++) {
    const view = hostStatus?.json?.session
    if (!view?.state) throw new Error('hub 开局：房主视角缺失')
    if (view.state.uiState === 'inScenario') break
    const seat = pickActingSeat(view, humans)
    if (seat === null) {
      // 并发准备阶段 AI 席位可能短暂成为唯一应答者：等大厅 AI 兜底把手里的准备走完。
      await sleep(50)
      hostStatus = await readStatus(host)
      continue
    }
    let actingView
    if (seat === 0) actingView = view
    else {
      if (!(await waitForView(halls[seat], view.state.revision))) {
        throw new Error(`hub 开局：seat${seat} 视角在 ${VIEW_SYNC_TIMEOUT_MS}ms 内没有同步到 revision ${view.state.revision}`)
      }
      actingView = (await readStatus(halls[seat])).json.session
    }
    const state = actingView?.state
    const candidates = hubPrepareCandidates(state, seat)
    if (!candidates.length) {
      throw new Error(`hub 开局卡住：uiState=${state?.uiState} seat=${seat} 没有合法动作`)
    }
    const move = candidates[attempt % candidates.length]
    const signature = `${move.action || ''}|${JSON.stringify(move)}`
    // 同一动作重复两次还没有推进（例如队长候选之间来回切换）：换下一个候选，最多轮转一轮。
    if (signature === lastSignature && repeats >= 2 && rotations < candidates.length) {
      attempt++
      rotations++
      continue
    }
    const revision = state.revision
    const command = await halls[seat].command('move', { revision, move }).catch(error => ({
      httpStatus: 0, bytes: 0, ms: 0, text: JSON.stringify({ ok: false, error: error.message }),
    }))
    const ok = !/"ok"\s*:\s*false/.test(command.text.slice(0, 200))
    let errorText = ''
    if (!ok) { try { errorText = JSON.parse(command.text).error || '' } catch { /* 非 JSON */ } }
    // P2.2：hub 阶段一般没有 AI 先手，但若命令返回 aiPending（后续版本），等后台 AI 完成再推进。
    if (ok) await waitForIdle(halls[seat])
    hubSteps.push({
      step: hubSteps.length + 1, seat, action: describeMove(move), revision, ok,
      error: errorText || undefined, commandMs: command.ms, commandBytes: command.bytes,
    })
    console.log(`  hub ${hubSteps.length}: seat${seat} ${describeMove(move)} ${command.ms}ms `
      + `${(command.bytes / 1024).toFixed(0)}KB${ok ? '' : ' 失败：' + errorText}（不计入统计）`)
    if (!ok) {
      failures++
      attempt++
      if (failures >= MAX_CONSECUTIVE_FAILURES) throw new Error(`hub 开局连续失败 ${failures} 次：${errorText}`)
      hostStatus = await readStatus(host)
      continue
    }
    failures = 0
    if (signature === lastSignature) repeats++
    else { lastSignature = signature; repeats = 1; rotations = 0 }
    hostStatus = await readStatus(host)
  }
  const finalView = hostStatus?.json?.session
  if (!finalView?.state) throw new Error('hub 开局：最终视角缺失')
  if (finalView.state.uiState !== 'inScenario') {
    throw new Error(`hub 开局在 ${maxSteps} 步内没有进入 inScenario（当前 uiState=${finalView.state.uiState}，`
      + `revision=${finalView.state.revision}，legalMoves=${finalView.state.legalMoves?.length ?? 0}）`)
  }
  for (const guest of halls.slice(1)) {
    if (!(await waitForView(guest, finalView.state.revision))) {
      throw new Error(`hub 开局结束后 seat${halls.indexOf(guest)} 视角未同步到 revision ${finalView.state.revision}`)
    }
  }
  return { hostStatus, hubSteps }
}

// 候选动作顺序：
//   pendingChoice 优先 done/skip/pass/keep（拒绝/跳过不会改变局面，快速穿过选择窗口）；
//   hub 阶段用固定优先级（依次推进关卡/准备/开始）；
//   正式调查阶段取 legalMoves[0] 且优先非 hub* 动作（与任务口径一致）。
function moveCandidates(state) {
  const moves = Array.isArray(state?.legalMoves) ? state.legalMoves : []
  const isHub = move => String(move?.action || '').startsWith('hub')
  if (state?.pendingChoice) {
    const preferred = moves.filter(move => ['done', 'skip', 'pass', 'keep'].includes(String(move?.optionId)))
    const rest = moves.filter(move => !preferred.includes(move))
    return [...preferred, ...rest]
  }
  if (state?.uiState && state.uiState !== 'inScenario') {
    const hub = moves.filter(isHub)
    const nonHub = moves.filter(move => !isHub(move))
    const ordered = []
    for (const action of HUB_PRIORITY) {
      for (const move of hub) if (move.action === action && !ordered.includes(move)) ordered.push(move)
    }
    for (const move of hub) if (!ordered.includes(move)) ordered.push(move)
    for (const move of nonHub) if (!ordered.includes(move)) ordered.push(move)
    if (ordered.length) return ordered
  }
  return [...moves.filter(move => !isHub(move)), ...moves.filter(isHub)]
}

function describeMove(move) {
  if (!move) return '—'
  const action = move.action || 'choose'
  return move.optionId != null ? `${action}/${move.optionId}` : action
}

// 把一个动作窗口内的 perf 记录聚合成 publish / phase 指标。
function summarizePerfWindow(records) {
  const memberKinds = { full: 0, delta: 0, skip: 0 }
  const memberBytes = { full: 0, delta: 0, skip: 0 }
  let publishCount = 0
  let publishMs = 0
  const phaseMs = { commit: 0, reactions: 0, snapshot: 0, ai: 0 }
  let onlineCommand = null
  for (const entry of records) {
    if (!entry || typeof entry.event !== 'string') continue
    if (entry.event === 'publishOnline') {
      publishCount++
      publishMs += Number(entry.ms) || 0
    } else if (entry.event === 'publish.member') {
      if (memberKinds[entry.kind] !== undefined) {
        memberKinds[entry.kind]++
        memberBytes[entry.kind] += Number(entry.bytes) || 0
      }
    } else if (entry.event.startsWith('phase.')) {
      const name = entry.event.slice('phase.'.length)
      if (phaseMs[name] !== undefined) phaseMs[name] += Number(entry.ms) || 0
    } else if (entry.event === 'onlineCommand') {
      onlineCommand = { publishes: Number(entry.publishes) || 0, serialDelta: Number(entry.serialDelta) || 0, ms: Number(entry.ms) || 0 }
    }
  }
  return {
    publishCount,
    publishMs: round3(publishMs),
    memberKinds,
    memberBytes,
    phaseMs: Object.fromEntries(Object.entries(phaseMs).map(([name, value]) => [name, round3(value)])),
    onlineCommand,
  }
}

// ---------------------------------------------------------------------------
// 4. 汇总表格与对照
// ---------------------------------------------------------------------------

const TABLE_ROWS = [
  { label: '房主命令往返 host commandMs', key: 'hostCommandMs', unit: 'ms' },
  { label: '客人命令往返 guest commandMs', key: 'guestCommandMs', unit: 'ms' },
  { label: '房主命令响应 host commandBytes', key: 'hostCommandBytes', unit: 'bytes' },
  { label: '客人命令响应 guest commandBytes', key: 'guestCommandBytes', unit: 'bytes' },
  { label: '命令响应 commandBytes（合计）', key: 'commandBytes', unit: 'bytes' },
  { label: 'status 响应 statusBytes', key: 'statusBytes', unit: 'bytes' },
  { label: 'status 下行折算 statusDownlink', key: 'statusDownlink', unit: 'bytes' },
  { label: 'status 响应（全厅合计 --status=all）', key: 'statusBytesAll', unit: 'bytes' },
  { label: 'status 下行（全厅合计 --status=all）', key: 'statusDownlinkAll', unit: 'bytes' },
  { label: 'serial 变化 serialDelta', key: 'serialDelta', unit: 'count' },
  { label: 'publishOnline 次数', key: 'publishCount', unit: 'count' },
  { label: 'publishOnline 耗时 publishMs', key: 'publishMs', unit: 'ms' },
  { label: '事件循环阻塞 eventLoopMaxMs', key: 'eventLoopMaxMs', unit: 'ms' },
  { label: 'phase.commit', key: 'phaseCommitMs', unit: 'ms' },
  { label: 'phase.reactions', key: 'phaseReactionsMs', unit: 'ms' },
  { label: 'phase.snapshot', key: 'phaseSnapshotMs', unit: 'ms' },
  { label: 'phase.ai', key: 'phaseAiMs', unit: 'ms' },
  { label: 'publish.member full', key: 'publishMemberFull', unit: 'count' },
  { label: 'publish.member delta', key: 'publishMemberDelta', unit: 'count' },
  { label: 'publish.member skip', key: 'publishMemberSkip', unit: 'count' },
  // P2.2：AI 后台确认口径——命令响应本身（aiPending 动作）与随后等待 AI 回合完成的时间。
  { label: 'AI 后台等待 aiWaitMs', key: 'aiWaitMs', unit: 'ms' },
]

// --baseline 严格判定用的核心指标与「绝对增量有意义」阈值。
const CORE_REGRESSION = [
  { key: 'hostCommandMs', label: '房主命令往返', abs: 20, unit: 'ms' },
  { key: 'guestCommandMs', label: '客人命令往返', abs: 20, unit: 'ms' },
  { key: 'commandBytes', label: '命令响应字节', abs: 64 * 1024, unit: 'bytes' },
  { key: 'statusDownlink', label: 'status 下行折算', abs: 64 * 1024, unit: 'bytes' },
  { key: 'publishCount', label: 'publishOnline 次数', abs: 1, unit: 'count' },
  { key: 'eventLoopMaxMs', label: '事件循环阻塞', abs: 20, unit: 'ms' },
]
const CORE_KEYS = new Set(CORE_REGRESSION.map(item => item.key))

function formatValue(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (unit === 'bytes') return `${(value / 1024).toFixed(1)}KB`
  if (unit === 'ms') return value.toFixed(1)
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function printStatsTable(metrics) {
  const columns = [['指标', 38], ['n', 5], ['mean', 11], ['p50', 11], ['p95', 11], ['max', 11]]
  console.log(columns.map(([text, width], index) => index === 0 ? padEndDisplay(text, width) : padStartDisplay(text, width)).join(''))
  console.log('-'.repeat(columns.reduce((sum, [, width]) => sum + width, 0)))
  for (const row of TABLE_ROWS) {
    const item = metrics[row.key]
    if (!item) continue
    const cells = [
      padEndDisplay(row.label, columns[0][1]),
      padStartDisplay(String(item.count ?? 0), columns[1][1]),
      padStartDisplay(formatValue(item.mean, row.unit), columns[2][1]),
      padStartDisplay(formatValue(item.p50, row.unit), columns[3][1]),
      padStartDisplay(formatValue(item.p95, row.unit), columns[4][1]),
      padStartDisplay(formatValue(item.max, row.unit), columns[5][1]),
    ]
    console.log(cells.join(''))
  }
}

function loadRunFile(file, label) {
  const absolute = path.resolve(file)
  let data
  try { data = JSON.parse(fs.readFileSync(absolute, 'utf8')) } catch (error) {
    throw new Error(`${label} 文件读取/解析失败（${displayPath(absolute)}）：${error.message}`)
  }
  if (!data || data.schemaVersion !== SCHEMA_VERSION || data.tool !== TOOL || !data.summary?.metrics) {
    throw new Error(`${label} 不是 ${TOOL} v${SCHEMA_VERSION} 的结果文件：${displayPath(absolute)}`)
  }
  return data
}

// 打印并排对照；strict=true 时额外给出回归判定与退出码。
function compareAgainst(reference, current, file, { strict }) {
  console.log(`\n${strict ? '与基线对照' : '并排对照'}：${displayPath(file)}`)
  console.log(strict
    ? '对照口径：summary.metrics.*.p50；回归 = 比基线差 >20% 且绝对增量 > 有意义阈值（时延 20ms / 字节 64KiB / publishCount 1）'
    : '对照口径：summary.metrics.*.p50；仅参考，不影响退出码')
  const CONFIG_LABELS = { setup: '开局口径', seats: '席位数', ai: 'AI 席位数', moves: '统计步数', warmup: '预热步数', statusMode: 'status 口径', client: '客户端口径' }
  const mismatches = []
  for (const [key, label] of Object.entries(CONFIG_LABELS)) {
    const before = reference.config?.[key]
    const after = current.config?.[key]
    if (before !== undefined && after !== undefined && before !== after) mismatches.push(`${label} ${before}→${after}`)
  }
  if (mismatches.length) console.log(`注意：对照配置不一致（${mismatches.join('、')}），字节/时延差异会混入口径变化。`)
  const columns = [['指标', 38], ['基准', 11], ['本次', 11], ['变化', 11], ['判定', 8]]
  console.log(columns.map(([text, width], index) => index === 0 ? padEndDisplay(text, width) : padStartDisplay(text, index === 4 ? width - 1 : width)).join(''))
  console.log('-'.repeat(columns.reduce((sum, [, width]) => sum + width, 0)))
  const regressions = []
  const worsens = []
  for (const row of TABLE_ROWS) {
    const referenceStats = reference.summary.metrics?.[row.key]
    const currentStats = current.summary.metrics?.[row.key]
    const before = referenceStats?.p50
    const after = currentStats?.p50
    let deltaText = '—'
    let verdict = '—'
    if (Number.isFinite(before) && Number.isFinite(after)) {
      const diff = after - before
      const pct = before > 0 ? (diff / before) * 100 : (after > 0 ? Infinity : 0)
      deltaText = Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '新增'
      const core = CORE_REGRESSION.find(item => item.key === row.key)
      // 变差：数值上升。只有核心指标 + 绝对增量超过阈值才参与 strict 回归判定。
      const worse = diff > 0 && core && (before === 0 ? diff > core.abs : pct > 20 && diff > core.abs)
      // 改善：下降 >10% 且绝对变化有意义（避免 0.001ms 级噪声显示成「改善」）。
      const floor = core ? core.abs : row.unit === 'bytes' ? 16 * 1024 : 1
      const better = diff < 0 && before > 0 && pct < -10 && Math.abs(diff) > floor
      if (worse) {
        verdict = strict ? '回归' : '变差'
        regressions.push({ ...row, before, after, diff, pct })
      } else if (better) {
        verdict = '改善'
      } else {
        verdict = 'OK'
      }
      if (worse) worsens.push(row)
    }
    console.log([
      padEndDisplay(row.label, columns[0][1]),
      padStartDisplay(formatValue(before, row.unit), columns[1][1]),
      padStartDisplay(formatValue(after, row.unit), columns[2][1]),
      padStartDisplay(deltaText, columns[3][1]),
      padEndDisplay(' ' + verdict, columns[4][1]),
    ].join(''))
  }
  if (strict) {
    if (regressions.length) {
      console.log(`\n结论：检测到 ${regressions.length} 项核心指标回归（${regressions.map(item => item.label).join('、')}），退出码 1。`)
      return 1
    }
    console.log('\n结论：核心指标相对基线无回归，退出码 0。')
    return 0
  }
  console.log(worsens.length
    ? `\n结论：${worsens.length} 项指标变差（仅参考，退出码不受影响）。`
    : '\n结论：没有指标变差（仅参考）。')
  return 0
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = Date.now()
  const halls = []
  let relay = null
  const summary = {
    createMs: null, createBytes: null, joinMs: [], readyMs: [],
    startMs: null, startBytes: null, setupMs: null, prepMs: null, hubSteps: 0,
    driveMs: null, totalMs: null,
  }

  try {
    // ---- 5.1 加载 Mod / 校验席位数 ----
    const mods = (await loadMods({ userDir: null })).filter(mod => mod.id === MOD_ID)
    const mod = mods[0]
    if (!mod) throw new Error(`未找到内置游戏 ${MOD_ID}（games/ 目录不完整？）`)
    const minSeats = Math.max(2, Number(mod.players?.[0]) || 2)
    const maxSeats = Number(mod.seats || mod.players?.[1]) || minSeats
    if (options.seats < minSeats || options.seats > maxSeats) {
      throw new ArgError(`${MOD_ID} 支持 ${minSeats}–${maxSeats} 人，收到 --seats=${options.seats}`)
    }
    const humans = options.seats - options.ai
    if (humans < 1) throw new ArgError(`--ai=${options.ai} 与 --seats=${options.seats} 组合后没有人类席位`)

    // ---- 5.2 起 relay + 大厅 ----
    relay = createRelay({ secret: 'perf-online-latency-' + randomUUID() })
    const relayUrl = await listen(relay)
    for (let index = 0; index < humans; index++) {
      const server = createServer({ mods, persist: index === 0 })
      await server.ready
      const origin = await listen(server)
      halls.push(createHall(server, origin, index > 0))
    }
    const host = halls[0]
    summary.setupMs = Date.now() - startedAt

    // ---- 5.3 建房 / 加入 / 准备 / 开始 ----
    const aiSeats = options.ai > 0
      ? Array.from({ length: options.ai }, (_, offset) => ({ seat: humans + offset, name: `AI 队友 ${offset + 1}` }))
      : []
    // hub：真实开局（campaignHub，视图带完整卡池，匹配路线图基线口径）；
    // fast：legacyAutoStart 跳过 hub，视图只带内嵌卡表，只用于快速冒烟。
    const gameSettings = options.setup === 'fast'
      ? { legacyAutoStart: true, seed: options.seed, playerCount: options.seats }
      : { seed: options.seed, playerCount: options.seats }
    const createdResponse = await host.call('create', {
      relayUrl,
      modId: MOD_ID,
      capacity: options.seats,
      fillAi: false,
      ...(aiSeats.length ? { aiSeats } : {}),
      settings: gameSettings,
    })
    const createdJson = JSON.parse(createdResponse.text)
    if (!createdJson.ok || !createdJson.room?.code) throw new Error(`建房失败：${createdJson.error || createdResponse.httpStatus}`)
    summary.createMs = createdResponse.ms
    summary.createBytes = createdResponse.bytes
    const roomCode = createdJson.room.code

    for (const guest of halls.slice(1)) {
      const joined = await guest.call('join', { relayUrl, code: roomCode })
      const joinedJson = JSON.parse(joined.text)
      if (!joinedJson.ok) throw new Error(`加入房间失败：${joinedJson.error || joined.httpStatus}`)
      summary.joinMs.push(joined.ms)
      const ready = await guest.call('ready', { ready: true })
      const readyJson = JSON.parse(ready.text)
      if (!readyJson.ok) throw new Error(`准备失败：${readyJson.error || ready.httpStatus}`)
      summary.readyMs.push(ready.ms)
    }

    const start = await host.command('start')
    let startJson
    try { startJson = JSON.parse(start.text) } catch { throw new Error('开局响应不是合法 JSON') }
    if (!startJson.ok) throw new Error(`开局失败：${startJson.error || start.httpStatus}`)
    summary.startMs = start.ms
    summary.startBytes = start.bytes
    // P2.2：start 可能先返回 aiPending，等先手 AI 回合跑完再取权威 revision（普通局 busy 已为 false）。
    summary.startAiWaitMs = await waitForIdle(host)
    const startView = (await readStatus(host)).json.session
    const startRevision = startView.state.revision
    // 等所有客人收到开局快照（否则第一步拿到的是旧 revision）。
    for (const guest of halls.slice(1)) {
      if (!(await waitForView(guest, startRevision))) {
        throw new Error(`客人视角在 ${VIEW_SYNC_TIMEOUT_MS}ms 内没有同步到 revision ${startRevision}`)
      }
    }
    // hub 模式：先走真实 campaignHub 开局（选调查员/牌组/队长/开始剧本），这些步骤不计入统计。
    let hubSteps = []
    let driveHostStatus = { json: { session: startView }, bytes: start.bytes, ms: null }
    const prepStarted = Date.now()
    if (options.setup === 'hub') {
      const prepared = await driveHubPrep({ host, halls, humans, startView, startBytes: start.bytes })
      driveHostStatus = prepared.hostStatus
      hubSteps = prepared.hubSteps
    }
    summary.prepMs = Date.now() - prepStarted
    summary.hubSteps = hubSteps.length
    const initialView = driveHostStatus.json.session
    const initialComposition = viewComposition(initialView)

    console.log(`联机延迟基准：${options.seats} 席（人类 ${humans}${options.ai ? ` + AI ${options.ai}` : ''}），`
      + `setup=${options.setup}，统计 ${options.moves} 步（预热 ${options.warmup} 步），seed=${options.seed}，status=${options.status}`)
    console.log(`启动：大厅 ${halls.length} 个 + 本机 relay（${relayUrl}）；建房 ${summary.createMs}ms / `
      + `加入 ${summary.joinMs.map(value => value.toFixed(0)).join('+') || 0}ms / `
      + `开局 ${summary.startMs}ms（${(summary.startBytes / 1024).toFixed(0)}KB，revision ${startRevision}）；`
      + `hub 开局 ${hubSteps.length} 步（不计入统计，${(summary.prepMs / 1000).toFixed(1)}s）`)
    if (initialComposition) {
      console.log(`初始视图构成（host，revision ${initialComposition.revision}，${initialComposition.uiState}）：`
        + `总计 ${(initialComposition.totalBytes / 1024).toFixed(0)}KB = `
        + `state.cards ${(initialComposition.cardsBytes / 1024).toFixed(0)}KB / `
        + `events ${(initialComposition.eventsBytes / 1024).toFixed(0)}KB / `
        + `investigatorDefs ${(initialComposition.investigatorDefsBytes / 1024).toFixed(0)}KB / `
        + `其余 ${(initialComposition.otherBytes / 1024).toFixed(0)}KB`)
    }

    // ---- 5.4 推进循环 ----
    const driveStarted = Date.now()
    // 最近一次实测到的房主 status（既是 driving 输入，也是上一动作的 statusBytes 指标）。
    let hostStatus = driveHostStatus
    const actions = []
    const failedActions = []
    let consecutiveFailures = 0
    let recorded = 0
    let retryIndex = 0
    let completed = false
    let stoppedReason = 'completed'
    let lastMoveSignature = ''
    let sameMoveRepeats = 0
    const totalSteps = options.moves + options.warmup

    while (!completed) {
      const hostView = hostStatus?.json?.session
      if (!hostView) {
        await sleep(20)
        try { hostStatus = await readStatus(host) } catch { /* relay 断开时重试 */ }
        continue
      }
      if (hostView.state?.status !== 'playing') {
        stoppedReason = 'game-over'
        break
      }
      const seat = pickActingSeat(hostView, humans)
      if (seat === null) {
        // 理论上 AI 回合在命令处理末尾就已完成；走到这里说明局面没有可行动的人类席位。
        failedActions.push({ reason: 'no-acting-human-seat', view: debugView(hostView) })
        stoppedReason = 'no-acting-human-seat'
        break
      }
      const hall = halls[seat]
      const revision = hostView.state.revision

      // 客人视角可能比房主慢一个快照；等到同一 revision 再读它的 legalMoves。
      if (seat > 0 && !(await waitForView(hall, revision))) {
        consecutiveFailures++
        failedActions.push({ reason: 'guest-view-stale', seat, revision, view: debugView(hostView) })
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break
        try { hostStatus = await readStatus(host) } catch { /* 稍后重试 */ }
        continue
      }

      let actingView
      if (options.status === 'none') {
        actingView = seat === 0 ? hostView : hall.server.online.status().session
      } else if (seat === 0) {
        actingView = hostView
      } else {
        try { actingView = (await readStatus(hall)).json.session } catch (error) {
          failedActions.push({ reason: 'acting-status-failed', seat, revision, error: error.message })
          consecutiveFailures++
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break
          continue
        }
      }
      const state = actingView?.state
      const candidates = state ? moveCandidates(state) : []
      if (!candidates.length) {
        failedActions.push({ reason: 'no-legal-move', seat, revision, view: debugView(actingView) })
        stoppedReason = 'no-legal-move'
        break
      }
      // 失败重试时换下一个候选；正常成功时回到首选。
      const move = candidates[retryIndex % candidates.length]
      const moveSignature = `${seat}|${describeMove(move)}|${JSON.stringify(move)}`
      if (moveSignature === lastMoveSignature) sameMoveRepeats++
      else { lastMoveSignature = moveSignature; sameMoveRepeats = 1 }
      if (sameMoveRepeats > 15) {
        failedActions.push({ reason: 'stuck-repeating-move', seat, revision, move, view: debugView(actingView) })
        stoppedReason = 'stuck-repeating-move'
        break
      }

      // ---- 一次动作的完整测量 ----
      const serialBeforeByHall = halls.map(item => item.server.online.status().serial)
      const perfFrom = perf.count()
      perf.resetEventLoop()
      const command = await hall.command('move', { revision, move }).catch(error => ({
        httpStatus: 0, bytes: 0, ms: 0, text: JSON.stringify({ ok: false, error: error.message }),
      }))
      // 成功响应可能 1MB+，只取字节数不解析；失败响应很小，解析出 error。
      const success = !/"ok"\s*:\s*false/.test(command.text.slice(0, 200))
      // P2.2：AI 回包解耦后命令会在 AI 回合完成前返回（busy=true）；命令耗时即「AI 确认」，
      // 之后必须等后台 AI 空闲再测最终 revision / status（否则会读到中间态或触发 SESSION_BUSY）。
      const aiPending = !!hall.server.online?.status().busy
      const aiWaitMs = aiPending && success ? await waitForIdle(hall) : 0
      await sleep(EVENT_LOOP_SETTLE_MS)
      const eventLoop = perf.eventLoop()
      const perfWindow = summarizePerfWindow(perf.recordsSince(perfFrom).records)
      const serialDeltaByHall = halls.map((item, index) => item.server.online.status().serial - serialBeforeByHall[index])

      if (!success) {
        consecutiveFailures++
        let errorText = ''
        try { errorText = JSON.parse(command.text).error || '' } catch { /* 非 JSON */ }
        failedActions.push({
          reason: 'command-failed', seat, revision, move,
          httpStatus: command.httpStatus, error: errorText,
          view: debugView(actingView),
        })
        if (options.verbose) console.log(`  [失败] step=${recorded} seat=${seat} rev=${revision} move=${describeMove(move)}: ${errorText}`)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { stoppedReason = 'too-many-failures'; break }
        retryIndex++
        // 失败后刷新权威状态再重试（STALE_REVISION 会自然被这一步吸收）。
        try { hostStatus = await readStatus(host) } catch { /* 稍后重试 */ }
        continue
      }
      consecutiveFailures = 0
      retryIndex = 0

      // ---- 动作后的 status 测量 ----
      const measuredHalls = []
      if (options.status !== 'none') {
        const targets = options.status === 'all' ? halls : [host]
        try {
          for (const target of targets) measuredHalls.push({ hall: target, ...(await readStatus(target)) })
        } catch (error) {
          failedActions.push({ reason: 'post-status-failed', seat, revision, error: error.message })
        }
      }
      const hostMeasured = measuredHalls.find(item => item.hall === host)
      if (hostMeasured) hostStatus = hostMeasured
      else if (options.status === 'none') hostStatus = { json: { session: host.server.online.status().session }, bytes: null, ms: null }

      const afterView = hostStatus?.json?.session
      const revisionAfter = afterView?.state?.revision ?? revision + 1
      const serialDelta = serialDeltaByHall[seat]
      const statusBytes = hostMeasured?.bytes ?? null
      const statusDownlink = statusBytes === null ? null : Math.round(statusBytes * Math.max(serialDelta + 1, 1))
      let statusBytesAll = null
      let statusDownlinkAll = null
      if (options.status === 'all' && measuredHalls.length) {
        statusBytesAll = measuredHalls.reduce((sum, item) => sum + item.bytes, 0)
        statusDownlinkAll = Math.round(measuredHalls.reduce((sum, item) => {
          const index = halls.indexOf(item.hall)
          return sum + item.bytes * Math.max(serialDeltaByHall[index] + 1, 1)
        }, 0))
      }

      if (recorded >= options.warmup) {
        actions.push({
          step: actions.length,
          seat,
          seatRole: seat === 0 ? 'host' : 'guest',
          uiState: state.uiState ?? null,
          phase: state.phase ?? null,
          round: state.round ?? null,
          pendingChoice: state.pendingChoice?.kind ?? null,
          move: { action: move.action ?? null, optionId: move.optionId ?? null },
          revision,
          revisionAfter,
          revisionDelta: revisionAfter - revision,
          attempts: 1,
          commandMs: command.ms,
          commandBytes: command.bytes,
          aiPending,
          aiWaitMs,
          statusBytes,
          statusMs: hostMeasured?.ms ?? null,
          statusBytesAll,
          statusDownlink,
          statusDownlinkAll,
          serialDelta,
          serialDeltaByHall,
          publishCount: perfWindow.publishCount,
          publishMs: perfWindow.publishMs,
          publishMemberKinds: perfWindow.memberKinds,
          publishMemberBytes: perfWindow.memberBytes,
          phaseMs: perfWindow.phaseMs,
          eventLoopMaxMs: eventLoop?.maxMs ?? 0,
          hostPerf: perfWindow.onlineCommand,
        })
        if (options.verbose) {
          console.log(`  step=${actions.length - 1} seat=${seat} ${state.uiState}/${state.phase} r${state.round} `
            + `rev ${revision}→${revisionAfter} ${describeMove(move)} `
            + `cmd ${command.ms}ms/${(command.bytes / 1024).toFixed(0)}KB `
            + `status ${statusBytes === null ? '—' : (statusBytes / 1024).toFixed(0) + 'KB'} `
            + `serialΔ=${serialDelta} publish=${perfWindow.publishCount} elMax=${(eventLoop?.maxMs ?? 0).toFixed(1)}ms`)
        } else if (actions.length % 10 === 0) {
          const hostActions = actions.filter(action => action.seatRole === 'host')
          const guestActions = actions.filter(action => action.seatRole === 'guest')
          const avg = list => list.length ? (list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(1) : '—'
          console.log(`  推进 ${actions.length}/${options.moves} 步：host ${avg(hostActions.map(a => a.commandMs))}ms / `
            + `guest ${avg(guestActions.map(a => a.commandMs))}ms，publish ${avg(actions.map(a => a.publishCount))} 次/动作`)
        }
      }
      recorded++
      if (recorded >= totalSteps) { completed = true; break }
      if (afterView?.state?.status !== 'playing') { stoppedReason = 'game-over'; break }
    }
    summary.driveMs = Date.now() - driveStarted

    // ---- 5.5 汇总 ----
    const metrics = buildMetrics(actions)
    summary.totalMs = Date.now() - startedAt
    const finalView = hostStatus?.json?.session
    const finalComposition = viewComposition(finalView)
    const finalInvestigators = investigatorStatus(finalView)
    const run = buildRunData({ options, humans, aiSeats, summary, actions, failedActions, metrics, stoppedReason, completed,
      hubSteps, initialComposition, finalComposition, finalInvestigators })

    if (!actions.length) {
      console.error('\n没有采集到任何动作样本；诊断信息：')
      console.error(JSON.stringify(failedActions.slice(-5), null, 2))
      return 1
    }

    console.log('')
    printStatsTable(metrics)
    console.log(`\n样本：${actions.length} 个动作（host ${actions.filter(a => a.seatRole === 'host').length} / `
      + `guest ${actions.filter(a => a.seatRole === 'guest').length}），失败重试 ${failedActions.length} 次，`
      + `推进墙钟 ${(summary.driveMs / 1000).toFixed(1)}s，总墙钟 ${(summary.totalMs / 1000).toFixed(1)}s`)
    const seatCounts = new Map()
    for (const action of actions) seatCounts.set(action.seat, (seatCounts.get(action.seat) || 0) + 1)
    console.log(`席位分布：${[...seatCounts].sort((a, b) => a[0] - b[0]).map(([seat, count]) => `seat${seat} ${count}`).join(' / ')}`
      + `（动作顺序由引擎决定，并非严格轮转）`)
    if (finalComposition) {
      console.log(`结束视图构成（host，revision ${finalComposition.revision}）：`
        + `总计 ${(finalComposition.totalBytes / 1024).toFixed(0)}KB = `
        + `state.cards ${(finalComposition.cardsBytes / 1024).toFixed(0)}KB / `
        + `events ${(finalComposition.eventsBytes / 1024).toFixed(0)}KB / `
        + `investigatorDefs ${(finalComposition.investigatorDefsBytes / 1024).toFixed(0)}KB / `
        + `其余 ${(finalComposition.otherBytes / 1024).toFixed(0)}KB`)
    }
    if (finalInvestigators.length) {
      console.log(`结束调查员：${finalInvestigators.map(inv => `seat${inv.seat} ${inv.defeated ? '阵亡' : inv.resigned ? '撤退' : '正常'}`
        + `（HP ${inv.health ?? '?'} / SAN ${inv.sanity ?? '?'}）`).join('；')}`)
      if (finalInvestigators.some(inv => inv.defeated || inv.resigned)) {
        console.log('注意：有调查员阵亡/撤退（游戏机制），其席位后续不再产生动作，host/guest 样本量可能因此不均。')
      }
    }
    if (!completed) {
      console.log(`注意：未达到请求的 ${options.moves} 步（停止原因：${stoppedReason}，已完成 ${actions.length} 步）。`)
      if (failedActions.length) {
        const reasons = [...new Set(failedActions.map(item => item.reason))]
        console.log(`失败/异常记录 ${failedActions.length} 条（${reasons.join('、')}）；最后一次诊断：`)
        console.log(JSON.stringify(failedActions[failedActions.length - 1], null, 2).slice(0, 2000))
      }
    }

    // JSON / 基线 / 对照
    if (options.json) console.log(`\n完整结果 JSON：${writeJsonFile(options.json, run)}（schema v${SCHEMA_VERSION}）`)

    let exitCode = 0
    if (options.baseline) {
      const baselinePath = path.resolve(options.baseline)
      if (!fs.existsSync(baselinePath)) {
        const written = writeJsonFile(baselinePath, run)
        console.log(`\n基线文件不存在，已把本次结果写成基线：${written}（下次运行同一命令会与它比较）`)
      } else {
        const reference = loadRunFile(baselinePath, '基线')
        exitCode = compareAgainst(reference, run, baselinePath, { strict: true })
      }
    }
    if (options.compare) {
      const comparePath = path.resolve(options.compare)
      const reference = loadRunFile(comparePath, '对照')
      // 并排对照不影响退出码；若同时用了 --baseline 且是同一文件，就不重复打印。
      if (!options.baseline || path.resolve(options.baseline) !== comparePath) {
        compareAgainst(reference, run, comparePath, { strict: false })
      }
    }
    if (!completed && stoppedReason !== 'game-over') exitCode = exitCode || 1
    return exitCode
  } finally {
    for (const hall of halls) await closeServer(hall.server).catch(() => {})
    if (relay) await closeRelay(relay).catch(() => {})
    try { perf.close() } catch { /* 已关闭 */ }
    if (options.keepHome) console.log(`\n临时 DSH_HOME 已保留：${home}`)
    else fs.rmSync(home, { recursive: true, force: true })
    if (previousDSHHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDSHHome
  }
}

function debugView(view) {
  const state = view?.state
  if (!state) return { hasSession: !!view }
  const moves = Array.isArray(state.legalMoves) ? state.legalMoves : []
  return {
    seat: view.mySeat,
    uiState: state.uiState ?? null,
    phase: state.phase ?? null,
    round: state.round ?? null,
    status: state.status ?? null,
    revision: state.revision ?? null,
    pendingChoice: state.pendingChoice?.kind ?? null,
    actingSeats: view.actingSeats ?? null,
    decisionSeat: view.decisionSeat ?? null,
    legalMoves: moves.length,
    sampleMoves: moves.slice(0, 6).map(move => describeMove(move)),
    eventCount: view.events?.length ?? null,
  }
}

function buildMetrics(actions) {
  const host = actions.filter(action => action.seatRole === 'host')
  const guest = actions.filter(action => action.seatRole === 'guest')
  const values = (list, read) => list.map(read)
  return {
    hostCommandMs: stats(values(host, action => action.commandMs)),
    guestCommandMs: stats(values(guest, action => action.commandMs)),
    commandMs: stats(values(actions, action => action.commandMs)),
    hostCommandBytes: stats(values(host, action => action.commandBytes)),
    guestCommandBytes: stats(values(guest, action => action.commandBytes)),
    commandBytes: stats(values(actions, action => action.commandBytes)),
    statusBytes: stats(values(actions, action => action.statusBytes)),
    statusMs: stats(values(actions, action => action.statusMs)),
    statusDownlink: stats(values(actions, action => action.statusDownlink)),
    statusBytesAll: stats(values(actions, action => action.statusBytesAll)),
    statusDownlinkAll: stats(values(actions, action => action.statusDownlinkAll)),
    serialDelta: stats(values(actions, action => action.serialDelta)),
    publishCount: stats(values(actions, action => action.publishCount)),
    publishMs: stats(values(actions, action => action.publishMs)),
    eventLoopMaxMs: stats(values(actions, action => action.eventLoopMaxMs)),
    phaseCommitMs: stats(values(actions, action => action.phaseMs.commit)),
    phaseReactionsMs: stats(values(actions, action => action.phaseMs.reactions)),
    phaseSnapshotMs: stats(values(actions, action => action.phaseMs.snapshot)),
    phaseAiMs: stats(values(actions, action => action.phaseMs.ai)),
    publishMemberFull: stats(values(actions, action => action.publishMemberKinds.full)),
    publishMemberDelta: stats(values(actions, action => action.publishMemberKinds.delta)),
    publishMemberSkip: stats(values(actions, action => action.publishMemberKinds.skip)),
    aiPendingActions: actions.filter(action => action.aiPending).length,
    aiWaitMs: stats(values(actions.filter(action => action.aiPending), action => action.aiWaitMs)),
  }
}

function buildRunData({ options, humans, aiSeats, summary, actions, failedActions, metrics, stoppedReason, completed,
  hubSteps, initialComposition, finalComposition, finalInvestigators }) {
  const publishMember = { full: { count: 0, bytes: 0 }, delta: { count: 0, bytes: 0 }, skip: { count: 0, bytes: 0 } }
  const publishTotals = { onlineCount: 0, onlineMs: 0 }
  for (const action of actions) {
    publishTotals.onlineCount += action.publishCount
    publishTotals.onlineMs += action.publishMs
    for (const kind of ['full', 'delta', 'skip']) {
      publishMember[kind].count += action.publishMemberKinds[kind]
      publishMember[kind].bytes += action.publishMemberBytes[kind]
    }
  }
  publishTotals.onlineMs = round3(publishTotals.onlineMs)
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    config: {
      modId: MOD_ID,
      seats: options.seats,
      humans,
      ai: options.ai,
      aiSeats,
      setup: options.setup,
      moves: options.moves,
      warmup: options.warmup,
      seed: options.seed,
      statusMode: options.status,
      client: options.client,
      statusDelta: options.client === 'browser',
      relay: 'in-process',
      relayUrl: 'http://127.0.0.1:<random-port>',
      keepHome: options.keepHome,
      eventLoopSettleMs: EVENT_LOOP_SETTLE_MS,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      env: { BOARDGAME_PERF: '1', BOARDGAME_PERF_FILE: '0', AI_CHAT_ENABLED: '0', AI_API_KEY: '<forced empty>' },
    },
    timing: {
      createMs: summary.createMs,
      createBytes: summary.createBytes,
      joinMs: summary.joinMs,
      readyMs: summary.readyMs,
      startMs: summary.startMs,
      startBytes: summary.startBytes,
      setupMs: summary.setupMs,
      hubPrepMs: summary.prepMs,
      hubSteps: summary.hubSteps,
      driveMs: summary.driveMs,
      totalMs: summary.totalMs,
    },
    views: {
      initial: initialComposition,
      final: finalComposition,
      finalInvestigators,
    },
    hubSteps,
    summary: {
      actions: actions.length,
      hostActions: actions.filter(action => action.seatRole === 'host').length,
      guestActions: actions.filter(action => action.seatRole === 'guest').length,
      failures: failedActions.length,
      completed,
      stoppedReason,
      publish: { ...publishTotals, member: publishMember },
      metrics,
    },
    failedActions,
    actions,
  }
}

// 顶层收尾：main() 的 finally 负责关闭服务器/临时目录；这里只负责退出码。
let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  if (error instanceof ArgError) {
    console.error(`[参数错误] ${error.message}`)
    exitCode = 2
  } else {
    console.error('[执行失败] ' + (error && error.stack ? error.stack : String(error)))
    exitCode = 1
  }
}
process.exitCode = exitCode
