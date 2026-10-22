// 联机同步开销基准（诊断用，不参与发布构建）。
//
//   node tools/perf-online-snapshot.mjs [--seats=4] [--moves=250] [--trim=1]
//
// 复刻大厅的热路径，量出「每一步」在房主进程里要花多少同步 CPU：
//   1. sessionView：publishOnline 会为每个真人席位重建一次个人视图
//      （克隆权威 state + 克隆整段事件历史 + 逐事件投影）；
//   2. publish：online.publish 里的 JSON 深拷贝、增量 diff、编码；
//   3. saveSnapshot：整局落盘（含场景检查点里的历史副本）；
//   4. 单机 / 联机两种下发体积。
// --trim=1（默认）按 lib/server.js 的 trimEventVisuals 剥掉旧事件的演出快照，
// --trim=0 保留全部快照，用来对比修复前后。
// 引擎按「自动选第一个合法行动」推进，只用于制造随步数增长的事件量，
// 不代表真实牌序或 AI 行为；绝对值看数量级，趋势看同一台机器上的前后对比。

import mod from '../games/arkhamhorror/index.js'
import { onlineEventHistory } from '../lib/online.js'
import { snapshotChanges } from '../lib/online-sync.js'
import { trimEventVisuals } from '../lib/server.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name, fallback) => {
  const found = process.argv.slice(2).find(value => value.startsWith(`--${name}=`))
  return found ? Number(found.split('=')[1]) : fallback
}
const SEATS = Math.max(1, Math.min(4, arg('seats', 4)))
const MOVES = Math.max(1, arg('moves', 250))
const TRIM = arg('trim', 1) !== 0

const now = () => performance.now()
const ms = since => +(performance.now() - since).toFixed(1)
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const kb = value => (bytes(value) / 1024).toFixed(0)

const players = Array.from({ length: SEATS }, (_, seat) => ({ seat, role: 'human', name: 'P' + seat }))
const settings = { ...mod.defaults, playerCount: SEATS, campaignId: 'nightOfTheZealot', legacyAutoStart: true, seed: 'perf' }
let state = mod.createState(settings, players)
let events = []
const checkpoints = []
// 稳定对象：trimEventVisuals 用它记录已裁剪位置。
const session = { sessionId: 'bg-perf', modId: 'arkhamhorror', players,
  get state() { return state }, get events() { return events } }

function chooseMove(s, seat) {
  const moves = mod.legalMoves(s, seat)
  if (!moves.length) return null
  if (s.pendingChoice) return ['done', 'skip', 'self'].map(id => moves.find(m => m.optionId === id)).find(Boolean) || moves[0]
  for (const action of ['investigate', 'draw', 'resource', 'endTurn', 'move', 'play', 'fight', 'evade']) {
    const found = moves.find(m => m.action === action)
    if (found) return found
  }
  return moves[0]
}

// 与 lib/server.js 的 sessionView 同构：克隆权威状态 -> 个人投影 -> 裁剪事件历史 -> 投影事件。
function sessionView(seat) {
  const view = mod.viewState(structuredClone(state), seat)
  const projected = mod.viewEvents(structuredClone(onlineEventHistory(events)), seat)
  return { sessionId: 'bg-perf', modId: 'arkhamhorror', players, online: true,
    state: { ...view, revision: state.revision }, events: projected, notes: [] }
}

// 与 lib/online.js 的 publish 同构：JSON 深拷贝 -> 与上一份快照 diff -> 编码 delta。
const sent = new Map()
function publish(member, value) {
  const started = now()
  const next = JSON.parse(JSON.stringify({ session: value, busy: false, lobby: null }))
  const deepCopy = ms(started)
  const previous = sent.get(member)
  const startedDiff = now()
  const changes = previous ? snapshotChanges(previous.value, next) : []
  const diff = ms(startedDiff)
  const startedEncode = now()
  const delta = JSON.stringify({ snapshotId: 's', baseId: previous ? 'p' : undefined, changes })
  const encode = ms(startedEncode)
  sent.set(member, { id: 's', value: next })
  return { total: ms(started), deepCopy, diff, encode, changes: changes.length,
    deltaBytes: Buffer.byteLength(delta), fullBytes: bytes(next) }
}

function publishOnline() {
  const started = now()
  const startedViews = now()
  const views = []
  for (let seat = 0; seat < SEATS; seat++) views.push(sessionView(seat))
  const build = ms(startedViews)
  const rows = views.map((view, seat) => publish(seat, view))
  return { total: ms(started), build, rows }
}

function saveCost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkham-perf-'))
  const record = { schema: 1, savedAt: new Date().toISOString(),
    session: { sessionId: 'bg-perf', modId: 'arkhamhorror', players, state, events, scenarioCheckpoints: checkpoints } }
  const started = now()
  const body = JSON.stringify(record)
  const stringify = ms(started)
  const file = path.join(dir, 'x.json')
  const startedWrite = now()
  fs.writeFileSync(file + '.tmp', body, 'utf8')
  fs.renameSync(file + '.tmp', file)
  const write = ms(startedWrite)
  fs.rmSync(dir, { recursive: true, force: true })
  return { mb: (Buffer.byteLength(body) / 1048576).toFixed(1), stringify, write, total: stringify + write }
}

const MB = value => (value / 1048576).toFixed(2) + 'MB'

function report(label, stats) {
  const moves = stats.moves || 1
  const last = stats.last
  const save = saveCost()
  console.log(`${label}\t事件 ${events.length}\tstate ${kb(state)}KB\tevents ${MB(bytes(events))}\t`
    + `publishOnline 平均 ${(stats.publish / moves).toFixed(0)}ms（最近 ${last.total.toFixed(0)}ms：`
    + `视图 ${last.build.toFixed(0)} + 每席位 ${(last.rows[0].deepCopy + last.rows[0].diff + last.rows[0].encode).toFixed(1)}`
    + `，其中深拷贝 ${last.rows[0].deepCopy}/diff ${last.rows[0].diff}/编码 ${last.rows[0].encode}）\t`
    + `快照 ${(last.rows[0].fullBytes / 1024).toFixed(0)}KB\tdelta ${(last.rows[0].deltaBytes / 1024).toFixed(1)}KB/${last.rows[0].changes} 处\t`
    + `存档 ${save.mb}MB 同步 ${save.total.toFixed(0)}ms`)
}

console.log(`席位数 ${SEATS}，推进 ${MOVES} 步；每步按一次 publishOnline（每个真人席位各一份个人视图）计；`
  + `事件快照裁剪 ${TRIM ? '开' : '关'}`)
const stats = { moves: 0, total: 0, publish: 0, last: publishOnline() }
let lastAppended = []
for (let move = 0; move < MOVES && state.status === 'playing'; move++) {
  // 每 100 步留一个场景检查点，模拟跨关后存档里叠加的历史副本。
  if (move > 0 && move % 100 === 0) {
    checkpoints.push({ checkpointId: 'ck' + move, snapshot: {
      state: structuredClone(state),
      events: events.map(event => { const copy = structuredClone(event); delete copy.tableState; delete copy.presentation?.tableState; return copy }),
    } })
  }
  const seat = mod.decisionSeat(state)
  const choice = chooseMove(state, seat)
  if (!choice) break
  const command = structuredClone(choice)
  delete command.label
  const next = structuredClone(state)
  if (mod.validateMove(structuredClone(next), seat, structuredClone(command))) break
  const produced = mod.applyMove(next, seat, command) || []
  state = next
  state.revision++
  const appended = produced.map((event, index) => ({ ...event, seq: events.length + index }))
  events.push(...appended)
  lastAppended = appended
  if (TRIM) trimEventVisuals(session)
  stats.moves++
  stats.total++
  const published = publishOnline()
  stats.publish += published.total
  stats.last = published
  if (stats.moves % 50 === 0) {
    report('第 ' + stats.total + ' 步', stats)
    stats.publish = 0
    stats.moves = 0
  }
}
if (stats.moves) report('收尾', stats)

// 单机路径同样会在提交时裁剪事件快照；这里量的是不做 onlineEventHistory 的完整下发。
const startedView = now()
const singleView = { state: mod.viewState(structuredClone(state), 0), events: mod.viewEvents(events, 0) }
const viewEvents = ms(startedView)
let started = now()
const single = JSON.stringify(singleView)
const stringify = ms(started)
started = now()
JSON.parse(single)
const parse = ms(started)
console.log(`\n单机每次行动下发 ${MB(Buffer.byteLength(single))}`
  + `（viewEvents ${viewEvents}ms、stringify ${stringify}ms、浏览器解析约 ${parse}ms）`)

// 修复前 commitMove 每次提交都把整局（含全部历史）序列化一次；现在只检查本次新内容。
const startedCommit = now()
JSON.stringify({ state, events: lastAppended, checkpoint: null })
console.log(`commitMove 现在只序列化本次新内容：${ms(startedCommit)}ms（修复前是整局 56ms 量级）`)
