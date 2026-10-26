// 桌游大厅 · HTTP 服务 + API + 对局进程
//
// 静态资源：public/（大厅网页）
// REST API（前缀 /api）：
//   GET  /api/catalog      桌游目录（含大厅注入的「对手 AI」座位 + 各 Mod 专属设置，按当前语言本地化）
//   GET  /api/config       Agent 模型配置（model/baseUrl/hasKey，不含密钥）
//   GET  /api/settings     大厅偏好（语言）与可选语言列表（docs/localization.md §5.2）
//   POST /api/settings     保存大厅偏好（当前只支持 locale；同源 JSON 接口，无需重启）
//   GET  /api/ais          AI 角色列表
//   POST /api/ais          新增 / 修改一个 AI 角色（落盘）
//   POST /api/ais/delete   删除一个 AI 角色
//   POST /api/start        按设置开局（1 名玩家 + 1 名 AI）
//   POST /api/move         玩家落子；随后 AI 自动落子并发言
//   POST /api/reset        用相同设置重开一局
//   POST /api/leave        退出对局
//   GET  /api/updates      大厅更新与游戏商店状态（仅本机）；check / settings / hall/download / restart
//   POST /api/store/install | uninstall   安装、更新或卸载下载的游戏（仅本机）

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadAis, saveAis, normalizeAi, newAiId } from './ai.js'
import { loadConfig, saveConfig, envOverrides } from './agent/config.js'
import { listModels, testConnection } from './agent/client.js'
import { createAgent, createTurnContext } from './agent/orchestrator.js'
import { statsSnapshot, resetStats, recordChatMemory } from './agent/log.js'
import {
  visibleChat, clampChatText, clampNoteText, canWriteMemory, mergeNotes,
  parseChatCommand, resolveChatTargets, chatCommandList, MENTION_ALL_MARKERS,
} from './chat.js'
import { persistEnabled, saveSnapshotAsync, readSnapshot, readSnapshots, deleteSnapshot, deletePrefs, backupSnapshot, sessionsDir, readPrefs, savePrefsAsync } from './sessions.js'
import { getActingSeats, getDecisionSeat, getSessionPolicy } from './mods.js'
import { createOnline, onlineEventHistory, mergeStaticIntoView } from './online.js'
import { snapshotChanges } from './online-sync.js'
import { perf } from './perf.js'
import { loadUpdateSettings, saveUpdateSettings, autoCheckAllowed } from './update-common.js'
import { loadSettings, saveSettings, settingsView } from './settings.js'
import { localizeMod, localizeStoreGame, resolveModLocale, hallText } from './i18n.js'
import { HALL_VERSION } from './version.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const STARTUP_RESTORE_LIMIT = 16

// 每条事件里的整桌演出快照（`tableState`）只对「客户端还没看过的最近事件」有用：
// 前端只回放 seq 大于自己最后一条的事件（web/table-presentation.js），历史快照既不下发也不重放。
// 保留窗口之外的快照在提交时就地剥掉，否则事件日志会随对局无限增长（每条 5–10KB，
// 战役后期能到几十 MB），把视图克隆、增量 diff、单机响应和存档一起拖慢。
const EVENT_VISUAL_WINDOW = 24
const eventVisualCursors = new WeakMap()

/** 原地剥掉较旧事件的演出快照，返回剥掉的条数。只处理窗口之外的增量部分。 */
export function trimEventVisuals(session, window = EVENT_VISUAL_WINDOW) {
  const events = session?.events
  if (!Array.isArray(events) || !events.length) return 0
  const keepFrom = Math.max(0, events.length - Math.max(0, window))
  const cursor = Math.min(eventVisualCursors.get(session) ?? 0, keepFrom)
  let trimmed = 0
  for (let i = cursor; i < keepFrom; i++) {
    const event = events[i]
    if (!event || (event.tableState == null && event.presentation?.tableState == null)) continue
    if (event.tableState != null) delete event.tableState
    if (event.presentation?.tableState != null) delete event.presentation.tableState
    trimmed++
  }
  eventVisualCursors.set(session, keepFrom)
  return trimmed
}

// 大厅统一注入的「对手 AI」座位设置项（每个 Mod 都自动拥有）。
// label/description 是中文兜底（旧 Mod 的 aiSlotLabel 为空、当前语言又没有大厅文案时使用）；
// labelKey/descriptionKey 让浏览器端仍可用自己的词典覆盖（docs/localization.md §6.3）。
const OPPONENTS_SPEC = {
  key: 'opponents',
  type: 'aiList',
  label: '对手 AI',
  description: '由 AI 扮演的对家（从 AI 列表中选择）',
  labelKey: 'aiSlot.label',
  descriptionKey: 'aiSlot.description',
}

export function createServer({ mods, persist, updates = {} } = {}) {
  let ais = loadAis()
  let seq = 0
  const sessions = new Map()
  const busy = new WeakSet()
  let online, onlineSession = null, onlineSettings = {}, onlineFillAi = true, onlineStarting = false
  let onlineLoadPending = false
  let onlineViewCache = null
  let onlineRoomSignature = ''
  const onlinePublishedViews = new Map()
  const onlineOperations = new Map()
  // P1.1：busy / lobby 单独变化时只发轻量 status 消息，不重发整份会话。
  // 独立开关便于单独回滚（BOARDGAME_ONLINE_BUSY=0 回到「busy 变化也发全量」的旧行为）。
  const onlineBusyStatus = process.env.BOARDGAME_ONLINE_BUSY !== '0'
  // P1.2：浏览器客人用 body.client.slim 声明「命令响应只要摘要」，整份视图由随后的快照送达。
  // 不带的调用方（旧客户端、测试、房主）继续拿完整 session；BOARDGAME_ONLINE_SLIM=0 可整体回滚。
  const onlineSlimResponse = process.env.BOARDGAME_ONLINE_SLIM !== '0'
  const wantsSlimCommand = (body, member) => onlineSlimResponse && !!body && body.client?.slim === true && !member?.host
  // P1.4：静态表只发一次。会话级公共静态表（cards/investigatorDefs）由 mod.staticTables 生成一次，
  // 视图带 staticVersion；客户端声明同一版本时省略两表，未声明/版本不符/异常一律回全量。
  // BOARDGAME_ONLINE_STATIC=0 一键回滚（所有视图恢复带全量静态表）。
  const onlineStaticEnabled = process.env.BOARDGAME_ONLINE_STATIC !== '0'
  const onlineStaticCache = new WeakMap()  // session -> { version, baseVersion, patchSeq, cards, investigatorDefs } | null
  const onlineMemberStatic = new Map()     // 远程成员 id -> 已随快照发给它的静态表版本
  // P1.5：发布合并。一次行动里 snapshotSession 往往被调用多次（提交后、每个 AI 动作后、命令末尾），
  // 旧实现每次都立即 publishOnline，其中大部分内容相同或只差 busy。这里把窗口内的发布只标脏，
  // 命令返回前统一 flush 一次最终视图；AI 连续动作的累积事件随最终快照用 events.seq 回放。
  // 失败模式只能是「晚一拍」：flush 时才构建视图，所以发的永远是最新 revision，绝不丢最终状态。
  // BOARDGAME_ONLINE_COALESCE=0 回滚为「每次 snapshotSession 立即发布」的 P1.4 行为。
  const onlineCoalesce = process.env.BOARDGAME_ONLINE_COALESCE !== '0'
  let onlinePublishPending = false   // 有待发布的视图（内容取 flush 时的最新状态）
  let onlinePublishScheduled = null  // setImmediate 句柄：命令窗口外的兜底 flush
  let onlinePublishHold = 0          // >0 = 命令处理中，发布推迟到命令末尾的 flush
  // P2.1：非行动者视图延后（默认关闭）。命令返回前只构建/下发行动者自己的结果，其他在线席位
  // 的视图构建与序列化放到命令响应之后的后台 setImmediate。
  // 默认关闭的原因：P1.4 静态表落地后，单席位视图构建已降到 ~1–5ms（4 人 publishMs ~35ms 含 3 次
  // 发布），同机 harness 实测 host/guest 往返与阻塞都在 ±3ms 噪声内，而开启后其他玩家会晚一拍看到
  // 行动。需要时用 BOARDGAME_ONLINE_DEFER=1 打开（保留独立开关便于 A/B）。
  const onlineDeferViews = process.env.BOARDGAME_ONLINE_DEFER === '1'
  // P2.2：AI 回合与回包解耦（默认开启）。人类动作提交后立即返回（aiPending/busy=true），
  // AI 反应与后续回合在后台 runner 里继续：每步落盘 + flush，客户端随 events.seq 逐步看到；
  // 失败写 agentError 事件并清 busy；最终一次 flush 携带 busy=false。
  // 没有配置模型时 AI 走本地合法动作兜底（纯 CPU、毫秒级），保持旧的同步语义：
  // 既让离线大厅行为不变，也不为「本来就没有模型延迟」的回合引入异步切换。
  // BOARDGAME_ONLINE_AI_BACKGROUND=0 一键回滚为「命令等待 AI 跑完」的旧行为。
  const onlineAiBackground = process.env.BOARDGAME_ONLINE_AI_BACKGROUND !== '0'
  const aiBackgroundSessions = new WeakSet()  // session -> 后台 AI runner 正在跑（含事件回应）
  // P3.2 A1′：共享 state clone（默认关闭）。Mod 声明 viewStateSharesState 能力时，每个 revision 只把
  // 权威 state structuredClone 一次，作为隔离副本交给各席位 viewState 共用（Mod 保证不写它）。
  // 任何异常 / 能力缺失 / 开关关闭都回退逐席位拷贝——失败模式只能是变慢，不会显示错状态。
  // BOARDGAME_ONLINE_SHARED_VIEW=1 打开；Arkham 先声明能力。
  const onlineSharedViewEnabled = process.env.BOARDGAME_ONLINE_SHARED_VIEW === '1'
  // 按权威 state 的对象身份缓存隔离副本：commitMove 每个 revision 都换新 state 对象，因此每个
  // revision 至多 clone 一次；同一 revision 的多次发布（busy 变化、多个席位）复用同一份副本。
  let onlineSharedStateCache = null  // { session, source, isolated } | null
  const onlineSharedViewFailed = new WeakSet()  // session -> 共享路径异常过，本局永久回退逐席位拷贝
  // 自动结算（默认开启，BOARDGAME_AUTOPASS=0 回滚）：
  //   客户端随 move 带 body.client.autoPrefs（本机三态覆盖），并用 prefs 命令异步全量同步；
  //   房主进程按座位缓存，在发布之前把待决窗口代答成 choose/trigger 或 choose/skip。
  //   覆盖存在会话里（sidecar 轻量落盘），离线座位按「没有覆盖」处理；旧 autoPass.codes 兼容成 skip。
  //   代答走 commitMove，所以校验收支、actionLog、回放与玩家手点完全一致。
  const autoPassEnabled = process.env.BOARDGAME_AUTOPASS !== '0'
  const AUTO_PASS_GUARD = 32        // 单次命令内最多代答的窗口数，防病态连锁
  const AUTO_PASS_MAX_CODES = 256   // 偏好集合上限，防异常 payload

  const modById = (id) => mods.find((m) => m.id === id)

  // 可选 Mod 能力：只有大厅进程负责代答时，才把「自动奖励窗口」暴露给真人。
  // 纯引擎消费者（单测 / replay-fixtures / 审计）不经过这里，保持旧的直接领取行为。
  for (const mod of mods || []) {
    try { mod.enableAutoReactionHosted?.() } catch (err) {
      console.warn('  [mods] 启用自动反应代答失败（' + mod.id + '）：' + String(err && err.message ? err.message : err))
    }
  }

  // -------------------------------------------------------------------------
  // 对局持久化（默认开启；BOARDGAME_PERSIST=0 或 createServer({ persist:false }) 关闭）
  //
  // 每次成功提交后把整局原子落盘，进程重启时自动恢复；前端只需记住 sessionId
  // 即可在刷新/重启后继续同一局。快照不是权威状态，恢复后每一步仍要过 Mod 校验。
  // -------------------------------------------------------------------------
  const persistOn = persist === undefined ? persistEnabled() : !!persist
  const onlineStateFile = persistOn ? path.join(sessionsDir(), '..', 'online-connection.json') : null
  let persistWarned = false
  // 已经落盘的内容指纹：同一 revision、同样多的事件再保存一次只是白等一次写盘。
  // P2.2：pendingAi 也是必须落盘的状态（重启恢复依据），内容相同但标记变化时不能跳过。
  const savedFingerprints = new WeakMap()
  const saveFingerprint = session => [
    session.state?.revision ?? -1,
    session.events?.length ?? 0,
    (Array.isArray(session.notes) ? session.notes : []).map(note => note?.text || '').join('\u0000'),
    session.saveDetached ? 1 : 0,
    session.pendingAi ? 1 : 0,
  ].join(':')

  async function snapshotSession(session) {
    // P0 埋点：把一次快照拆成「发布在线视图 / 落盘」两段；未开 BOARDGAME_PERF 时
    // perf.span 返回空函数，这里只剩一次函数调用，不改变任何行为。
    const endPerf = perf.span('snapshotSession', { revision: session.state?.revision, eventCount: session.events?.length })
    let publishMs = null, saveMs = null, saved = false, skipped = false
    try {
      trimEventVisuals(session)
      if (session === onlineSession) {
        const endPublish = perf.span('snapshotSession.publish')
        // P1.5：标脏即可；命令末尾 flushPublish() 一次发最终视图（AI 各步的累积事件都在里面）。
        schedulePublish()
        publishMs = endPublish()
      }
      if (!persistOn) { skipped = true; return }
      const mod = modById(session.modId)
      if (session.saveDetached) {
        throw Object.assign(new Error('当前存档已删除，请先另存为新存档'), { statusCode: 409, code: 'SAVE_DELETED' })
      }
      const fingerprint = saveFingerprint(session)
      // 内容与上次成功落盘完全一致（同一个 revision、同样的事件条数）时直接跳过。
      // saveError 非空说明上次没写成功，必须重试。
      if (!session.saveError && savedFingerprints.get(session) === fingerprint) { skipped = true; return }
      try {
        let resourceVersion = null
        if (mod && typeof mod.resourceVersion === 'function') {
          if (mod.requireReliableSaves) resourceVersion = await modResourceVersion(mod)
          else try { resourceVersion = await modResourceVersion(mod) } catch { resourceVersion = null }
        }
        session.saveError = null
        const startedSave = perf.enabled ? performance.now() : 0
        await saveSnapshotAsync(session, { resourceVersion })
        if (perf.enabled) saveMs = +(performance.now() - startedSave).toFixed(3)
        saved = true
        savedFingerprints.set(session, fingerprint)
        if (session === onlineSession) online.remember()
      } catch (err) {
        session.saveError = mod?.requireReliableSaves ? String(err?.message || err) : null
        if (mod?.requireReliableSaves) {
          throw Object.assign(new Error('自动保存失败：' + session.saveError), { statusCode: 507, code: 'SAVE_FAILED' })
        }
        if (!persistWarned) {
          persistWarned = true
          console.warn('  [sessions] 对局存档失败（不影响对局）：' + String(err && err.message ? err.message : err))
        }
      }
    } finally {
      endPerf({ publishMs, saveMs, saved, skipped })
    }
  }

  function randomAi() {
    return ais[Math.floor(Math.random() * ais.length)] || {
      id: 'ai-fb', name: '神秘棋手', avatar: '🎭', color: '#888888', persona: '',
    }
  }

  // AI/agent 编排器（全 agent：落子 + 台词都由模型产出）。
  // 配置可在运行时通过 /api/config 更新，因此用 getConfig 动态读取最新值。
  let agentConfig = loadConfig()
  const agent = createAgent({
    modById,
    getAi: (id) => ais.find((a) => a.id === id) || randomAi(),
    getConfig: () => agentConfig,
  })

  // 战术讨论的运行时状态（不落盘）：正在回复的请求数 + 每个频道上一条回复的开始时间。
  // 用于「频繁发言不逐条排队回复」的阈值判断，重启后归零即可。
  const chatRuntime = new WeakMap()
  function chatRuntimeOf(session) {
    let value = chatRuntime.get(session)
    if (!value) { value = { inflight: 0, channels: new Map() }; chatRuntime.set(session, value) }
    return value
  }
  function chatCommandHelp() {
    return chatCommandList().map((item) => item.usage + '：' + item.summary)
  }

  /**
   * 备忘对某个座位的可见性。
   * 本地对局只有一名人类，直接返回全部；联机时队伍备忘所有人可见，
   * 私聊备忘只给发起那次私聊的成员看（AI 提示词注入不受影响）。
   */
  function chatNotesView(session, seat) {
    const notes = Array.isArray(session.notes) ? session.notes : []
    if (!session.online) return notes
    const bySeq = new Map()
    for (const event of session.events || []) if (event && event.type === 'chat') bySeq.set(event.seq, event)
    return notes.filter((note) => {
      if (!note || !note.text) return false
      if (note.scope !== 'seat') return true
      const origin = Number.isInteger(note.evidence) ? bySeq.get(note.evidence) : null
      return !!origin && origin.seat === seat
    })
  }

  /**
   * 执行 / 指令。返回的字段会并进 /api/chat 的 chat 结果里。
   * 指令不调用模型，也不参与回复冷却。
   */
  function runChatCommand(session, command, to, evidence, context = {}) {
    const chat = { command: { name: command.name } }
    if (command.unknown) {
      chat.command.unknown = true
      chat.error = '未知指令：' + (command.name ? '/' + command.name : '/') + '（可用 /备忘、/清除备忘、/help）'
      return chat
    }
    if (command.name === 'help') {
      chat.command.lines = chatCommandHelp()
      chat.notice = '支持：/备忘 <内容>、/清除备忘、/help'
      return chat
    }
    if (command.name === 'note') {
      const text = clampNoteText(command.args)
      if (!text) {
        chat.error = '用法：/备忘 <内容>（不超过 30 字）'
        return chat
      }
      // 私聊备忘会注入到「那个 AI 座位」的记忆；私聊对象是真人时没有意义。
      if (to !== null && context.online && session.players[to] && session.players[to].role !== 'ai') {
        chat.error = '只有和 AI 队友的私聊才能用 /备忘；队伍备忘请在公开桌聊里输入。'
        return chat
      }
      const scope = to === null ? 'team' : 'seat'
      const merged = mergeNotes(session.notes, { add: [text], update: [], remove: [] }, {
        scope, seat: to, evidence, origin: 'manual', now: Date.now(),
      })
      session.notes = merged.notes
      chat.notesAdded = merged.added
      chat.notesUpdated = merged.updated
      chat.command.text = text
      chat.command.scope = scope
      chat.notice = merged.added
        ? '已记入' + (scope === 'team' ? '队伍' : '这位队友的') + '战术备忘：' + text
        : '这条备忘已经记过了，没有重复添加。'
      return chat
    }
    if (command.name === 'clear') {
      // 联机只清掉自己看得见的备忘，避免一个成员清空别人私聊里的约定。
      const visible = context.online ? chatNotesView(session, context.seat) : session.notes
      const ids = new Set((visible || []).map((note) => note && note.id).filter(Boolean))
      const before = Array.isArray(session.notes) ? session.notes.length : 0
      session.notes = (Array.isArray(session.notes) ? session.notes : []).filter((note) => !ids.has(note && note.id))
      const removed = before - session.notes.length
      chat.notesRemoved = removed
      chat.command.removed = removed
      chat.notice = removed ? '已清空 ' + removed + ' 条战术备忘。' : '当前没有战术备忘。'
      return chat
    }
    chat.error = '未知指令：' + command.name
    return chat
  }

  /**
   * 一条讨论的完整流程，本地 / 联机共用：记录发言 → 指令 / 定向回复 → 阈值 → 记忆。
   * 调用方负责忙状态、压缩与落盘（见 finishChat）。
   * 关键约束：不创建 AI 回合上下文、不消耗 maxTurnCalls、不产生 move、不推进 revision。
   */
  async function runChatTurn(session, seat, text, to, options = {}) {
    const online = !!options.online
    const mod = modById(session.modId)
    const previousEvent = session.events.length ? session.events[session.events.length - 1] : null
    const playerEvent = { seq: session.events.length, type: 'chat', seat, to, text, ts: Date.now() }
    // 联机私聊用 participants 标记频道成员；本地私聊靠 to 即可。
    if (online && to !== null) playerEvent.participants = [seat, to]
    session.events.push(playerEvent)
    if (typeof options.onPlayerEvent === 'function') options.onPlayerEvent()

    const chat = {
      reply: '', replies: [], notesAdded: 0, notesUpdated: 0, notesRemoved: 0, compacted: 0,
    }
    const command = parseChatCommand(text)
    if (command) {
      Object.assign(chat, runChatCommand(session, command, to, playerEvent.seq, { seat, online }))
      return chat
    }

    const targets = to !== null
      ? { mode: 'seat', seats: [to], unknown: [] }
      : resolveChatTargets(text, session.players, { humanSeat: seat })
    if (targets.unknown.length) {
      chat.warning = '没找到 ' + targets.unknown.map((name) => '@' + name).join('、')
        + '，这条按普通讨论处理，由一名队友回应。'
    }

    // 回复座位：私聊 → 目标是 AI 才回；公开 → @ 指定的座位 / @全体 / 旧规则（待决座位或第一个 AI 座位）
    const privateToAi = to !== null && session.players[to] && session.players[to].role === 'ai'
    const decisionSeat = getDecisionSeat(mod, session.state)
    const defaultSeat = session.players[decisionSeat] && session.players[decisionSeat].role === 'ai'
      ? decisionSeat
      : (session.players.find((p) => p.role === 'ai') || {}).seat
    const replySeats = to !== null
      ? (privateToAi ? [to] : [])
      : targets.mode === 'all' || targets.mode === 'some' ? targets.seats
        : Number.isInteger(defaultSeat) ? [defaultSeat] : []

    const replyEvent = (aiSeat, replyText) => (online && to !== null
      ? { seq: session.events.length, type: 'chat', seat: aiSeat, to: seat, participants: [seat, to], text: replyText, ts: Date.now() }
      : { seq: session.events.length, type: 'chat', seat: aiSeat, to, text: replyText, ts: Date.now() })

    const runtime = chatRuntimeOf(session)
    const cooldown = Math.max(0, Number(agentConfig.chatReplyCooldownMs) || 0)
    // 冷却按「发言人 + 频道」分别计时：联机时别人刚问过不会连带压住你的发言。
    const channelKey = (to === null ? 'table' : 'seat:' + to) + ':' + seat
    const lastReplyAt = runtime.channels.get(channelKey) || 0
    const elapsed = Date.now() - lastReplyAt
    if (!replySeats.length) {
      // 联机房间里没有 AI 队友时，公开聊天就是玩家之间的聊天，不算错误；
      // 但私聊 AI、或 @ 了 AI 却没座位可回，仍然提示。联机私聊真人同样不报错。
      const privateHuman = to !== null && !privateToAi
      const anyAi = session.players.some((p) => p && p.role === 'ai')
      if (!privateHuman && (!online || targets.mode !== 'default' || anyAi)) chat.error = '没有可对话的 AI 座位'
    } else if (runtime.inflight > 0) {
      chat.skipped = 'inflight'
      chat.retryAfterMs = cooldown
    } else if (cooldown > 0 && lastReplyAt > 0 && elapsed < cooldown) {
      chat.skipped = 'cooldown'
      chat.retryAfterMs = cooldown - elapsed
    } else {
      runtime.inflight++
      runtime.channels.set(channelKey, Date.now())
      let outcomes = []
      try {
        // 每个座位独立调用模型；回复一到位就追加事件，前端轮询可以逐条看到。
        outcomes = await Promise.all(replySeats.map(async (aiSeat) => {
          try {
            const outcome = await agent.agentChat(session, aiSeat, text, to === null ? 'table' : 'seat')
            if (outcome && outcome.reply) {
              session.events.push(replyEvent(aiSeat, outcome.reply))
              chat.replies.push({ seat: aiSeat, text: outcome.reply })
            }
            return outcome || {}
          } catch (err) {
            return { reply: '', error: String(err && err.message ? err.message : err) }
          }
        }))
      } finally {
        runtime.inflight = Math.max(0, runtime.inflight - 1)
      }

      if (chat.replies[0]) chat.reply = chat.replies[0].text
      if (outcomes.some((item) => item && item.noModel) && !chat.replies.length) chat.noModel = true
      if (!chat.replies.length) {
        chat.error = (outcomes.find((item) => item && item.error) || {}).error || '讨论失败'
      } else if (outcomes.some((item) => item && item.error)) {
        chat.warning = chat.warning || (outcomes.find((item) => item && item.error) || {}).error
      }
      // 记忆写入：只有玩家发言能触发；对局结束后只记录不提炼。@全体 时逐条合并。
      if (session.state.status === 'playing' && canWriteMemory(text, previousEvent)) {
        for (const outcome of outcomes) {
          if (!outcome || !outcome.memory) continue
          const merged = mergeNotes(session.notes, outcome.memory, {
            scope: to === null ? 'team' : 'seat',
            seat: to,
            evidence: playerEvent.seq,
            origin: 'auto',
            now: Date.now(),
          })
          session.notes = merged.notes
          chat.notesAdded += merged.added
          chat.notesUpdated += merged.updated
          chat.notesRemoved += merged.removed
        }
      }
    }
    return chat
  }

  /** 讨论收尾：按需压缩备忘并记录指标。落盘与响应由调用方负责。 */
  async function finishChat(session, chat) {
    const compact = await agent.compactNotes(session)
    session.notes = compact.notes
    if (compact.compressed) chat.compacted = compact.dropped
    if (chat.notesAdded || chat.notesUpdated || chat.notesRemoved || chat.compacted) {
      recordChatMemory({
        modId: session.modId, sessionId: session.sessionId,
        seat: chat.replies[0] ? chat.replies[0].seat : null,
        added: chat.notesAdded, updated: chat.notesUpdated, removed: chat.notesRemoved, compacted: chat.compacted,
      })
    }
    return chat
  }

  function configView() {
    return {
      playerName: agentConfig.playerName,
      playerAvatar: agentConfig.playerAvatar,
      model: agentConfig.model,
      baseUrl: agentConfig.baseUrl,
      hasKey: !!agentConfig.apiKey,
      temperature: agentConfig.temperature,
      maxRetries: agentConfig.maxRetries,
      timeoutMs: agentConfig.timeoutMs,
      maxTokens: agentConfig.maxTokens,
      maxTokensCeiling: agentConfig.maxTokensCeiling,
      reasoningRetries: agentConfig.reasoningRetries,
      reasoningEffort: agentConfig.reasoningEffort,
      maxTurnCalls: agentConfig.maxTurnCalls,
      topP: agentConfig.topP,
      jsonMode: agentConfig.jsonMode,
      turnTimeoutMs: agentConfig.turnTimeoutMs,
      maxPromptTokens: agentConfig.maxPromptTokens,
      memorySteps: agentConfig.memorySteps,
      chatEnabled: agentConfig.chatEnabled,
      chatNotesMax: agentConfig.chatNotesMax,
      chatMaxChars: agentConfig.chatMaxChars,
      chatWindow: agentConfig.chatWindow,
      chatReplyCooldownMs: agentConfig.chatReplyCooldownMs,
      chatCommands: chatCommandList(),
      chatAllMarkers: MENTION_ALL_MARKERS,
      envOverrides: envOverrides(),
    }
  }

  // 当前大厅语言：每次请求重新读盘（文件很小，与 loadUpdateSettings 一致），不做进程内缓存，
  // 避免测试和多实例读到旧值（docs/localization.md §5.1）。
  function currentLocale() {
    return loadSettings().locale
  }

  // 大厅注入给每个 Mod 的「对手 AI」设置项：按当前语言下发，Mod 自己的 i18n 优先。
  function opponentSpecFor(locale, meta) {
    return Object.assign({}, OPPONENTS_SPEC, {
      label: (meta && meta.aiSlotLabel) || hallText(locale, OPPONENTS_SPEC.labelKey),
      description: (meta && meta.aiSlotDescription) || hallText(locale, OPPONENTS_SPEC.descriptionKey),
    })
  }

  // 目录条目：游戏名称/描述/标签/设置项都由大厅按当前语言渲染（Mod 前端脚本只在打开该游戏时
  // 才加载，不能等它来翻译），因此本地化在服务端完成，随 catalog 下发「已解析结果」。
  function catalogView(locale = currentLocale()) {
    return mods.map((m) => {
      const meta = localizeMod(m, locale)
      return {
        id: m.id,
        name: meta.name,
        nameEn: m.nameEn || '',
        players: m.players,
        seats: m.seats || m.players[1] || 2,
        cover: m.cover || '',
        coverEmoji: m.coverEmoji || '🎲',
        description: meta.description || '',
        tags: meta.tags || [],
        settingsSpec: (m.hideOpponentSettings ? [] : [opponentSpecFor(locale, meta)]).concat(meta.settingsSpec || []),
        defaults: Object.assign({ opponents: [null] }, m.defaults || {}),
        render: m.render || { kind: 'board', size: 15, pieceStyle: 'stone' },
        clientData: m.clientData || null,
        // Mod 自带的浏览器模块／样式（相对 URL）；大厅不关心其内容，只告诉前端去哪取。
        web: m.web ? { client: m.web.clientUrl || null, styles: m.web.stylesUrl || null, mount: m.web.mount } : null,
        // 语言解析结果 + 已校验的语言包 URL（docs/localization.md §7.4）：Mod 前端通过 host.locale 使用。
        i18n: meta.i18n,
        api: typeof m.handleApi === 'function' ? '/api/mods/' + m.id : null,
        version: m.package?.version || null,
      }
    })
  }

  // -------------------------------------------------------------------------
  // 开局：组装座位 + 创建 Mod 状态
  // -------------------------------------------------------------------------

  function resolveOpponent(id) {
    if (id === '__random__' || id == null || id === '') return randomAi().id
    return id
  }

  // AI 座位数量：默认 = 最大 AI 数（seats-1，保持旧行为）；
  // 合作类 Mod 可通过 settings.teammates 指定实际 AI 队友数量（0..seats-1）。
  function aiCount(mod, settings) {
    const maxAi = (mod.seats || mod.players[1] || 2) - 1
    if (mod.hideOpponentSettings && settings.playerCount != null) {
      const total = Number(settings.playerCount)
      if (!Number.isSafeInteger(total) || total < 1 || total > maxAi + 1) throw new Error('玩家人数必须在 1–' + (maxAi + 1) + ' 之间')
      return total - 1
    }
    if (settings.teammates == null || settings.teammates === '') return maxAi
    const n = Math.round(Number(settings.teammates))
    if (!Number.isFinite(n) || n < 0) return 0
    return Math.min(maxAi, n)
  }

  function buildPlayers(mod, settings) {
    const n = aiCount(mod, settings)
    const opp = (settings.opponents || []).map(resolveOpponent)
    while (opp.length < n) opp.push(randomAi().id)

    const players = [{ seat: 0, role: 'human', color: 'black', name: agentConfig.playerName, avatar: agentConfig.playerAvatar, colorHex: '#3aa0ff' }]
    for (let i = 0; i < n; i++) {
      const ai = ais.find((a) => a.id === opp[i]) || randomAi()
      players.push({
        seat: i + 1, role: 'ai', aiId: ai.id, color: 'white',
        name: ai.name, avatar: ai.avatar, colorHex: ai.color,
      })
    }
    // 先手：默认玩家执黑；firstMove='ai' 时 AI 执黑先走。
    const first = settings.firstMove || 'player'
    const humanBlack = first !== 'ai'
    players.forEach((p) => {
      p.color = p.seat === 0 ? (humanBlack ? 'black' : 'white') : (humanBlack ? 'white' : 'black')
    })
    return players
  }

  function validateSettings(mod, settings) {
    const n = aiCount(mod, settings)
    const opp = settings.opponents || []
    if (!mod.hideOpponentSettings && opp.length < n) return 'AI 座位数量不足（需要 ' + n + ' 个，实际 ' + opp.length + ' 个）'
    for (const id of opp.slice(0, n)) {
      if (id === '__random__' || id == null || id === '') continue
      if (!ais.some((a) => a.id === id)) return '未找到所选 AI：' + id
    }
    return null
  }

  // -------------------------------------------------------------------------
  // P1.4：会话级静态表（公共卡面 + 调查员定义）
  // -------------------------------------------------------------------------

  function modSupportsStatic(mod) {
    return !!mod && onlineStaticEnabled && typeof mod.staticTables === 'function'
  }

  // 版本 = mod.id + mod.version + sha256(两张公共表) 的短 hash；patchSeq 让 cardsPatch 合并后版本
  // 必然变化（客户端据此再收一次全量静态表）。
  function computeStaticVersion(mod, cards, investigatorDefs) {
    const hash = createHash('sha256')
    hash.update(String(mod.id || ''))
    hash.update('\u0000')
    hash.update(String(mod.package?.version || ''))
    hash.update('\u0000')
    hash.update(JSON.stringify(cards))
    hash.update('\u0000')
    hash.update(JSON.stringify(investigatorDefs))
    return (mod.id || 'mod') + '@' + (mod.package?.version || '0.0.0') + '-' + hash.digest('hex').slice(0, 16)
  }

  /**
   * 会话级公共静态表。只在首次需要时调用 mod.staticTables(state) 生成一次；失败/能力缺失时返回 null，
   * 调用方必须回退到全量视图（失败模式只能是「变慢」）。这里不读写任何席位视图的 cards。
   */
  function staticFor(session) {
    if (!session || typeof session !== 'object' || !session.state || typeof session.state !== 'object') return null
    const mod = modById(session.modId)
    if (!modSupportsStatic(mod)) return null
    if (onlineStaticCache.has(session)) return onlineStaticCache.get(session)
    let tables
    try {
      tables = mod.staticTables(session.state)
    } catch (err) {
      console.warn('  [online] 静态表生成失败，回到全量视图：' + String(err && err.message ? err.message : err))
      onlineStaticCache.set(session, null)
      return null
    }
    const cards = tables && typeof tables === 'object' && tables.cards && typeof tables.cards === 'object' ? tables.cards : null
    const investigatorDefs = tables && typeof tables === 'object' && tables.investigatorDefs && typeof tables.investigatorDefs === 'object' ? tables.investigatorDefs : null
    if (!cards || !investigatorDefs) {
      console.warn('  [online] mod.staticTables 返回值无效，回到全量视图')
      onlineStaticCache.set(session, null)
      return null
    }
    const baseVersion = computeStaticVersion(mod, cards, investigatorDefs)
    const info = { cards, investigatorDefs, baseVersion, patchSeq: 0, version: baseVersion }
    onlineStaticCache.set(session, info)
    return info
  }

  function staticPayload(info) {
    return { version: info.version, cards: info.cards, investigatorDefs: info.investigatorDefs }
  }

  /** 把 Mod 自愈产生的公共卡面补丁并进会话静态表；内容真的变化时 bump patchSeq 并换版本。 */
  function mergeCardsPatch(session, patch) {
    const info = staticFor(session)
    if (!info || !patch || typeof patch !== 'object' || Array.isArray(patch)) return false
    let cards = null
    for (const [code, def] of Object.entries(patch)) {
      if (typeof code !== 'string' || !def || typeof def !== 'object' || Array.isArray(def)) continue
      const current = info.cards[code]
      if (current && JSON.stringify(current) === JSON.stringify(def)) continue
      if (!cards) cards = { ...info.cards }
      cards[code] = def
    }
    if (!cards) return false
    info.cards = cards
    info.patchSeq += 1
    info.version = info.baseVersion + '-p' + info.patchSeq
    return true
  }

  /** Mod 是否声明「viewState 可接收共享隔离副本」能力（boolean 或 () => boolean；异常视为不支持）。 */
  function modSharesViewState(mod) {
    try {
      const capability = mod?.viewStateSharesState
      return typeof capability === 'function' ? capability() === true : capability === true
    } catch {
      return false
    }
  }

  /**
   * P3.2 A1′：取本 revision 的「隔离副本」——权威 state 的 structuredClone，多个席位视图共用。
   * 只在线会话 + 开关打开 + Mod 声明能力时启用；未启用/能力缺失/异常时返回 null，调用方回退
   * 逐席位拷贝（失败模式只能是变慢）。缓存键是权威 state 的对象身份：commitMove 每个 revision
   * 都换新对象，所以每个 revision 至多 clone 一次，同一 revision 的多次发布复用同一份副本。
   * Mod 收到这份副本后不得修改它（含嵌套对象）：视图字段可以浅拷贝、与副本共享结构。
   */
  function sharedViewStateFor(session) {
    if (!onlineSharedViewEnabled || session !== onlineSession) return null
    if (!modSharesViewState(modById(session.modId))) return null
    if (onlineSharedViewFailed.has(session)) return null
    const cache = onlineSharedStateCache
    if (cache && cache.session === session && cache.source === session.state) return cache.isolated
    try {
      const isolated = structuredClone(session.state)
      onlineSharedStateCache = { session, source: session.state, isolated }
      perf.record('view.shared.clone', { revision: session.state?.revision ?? null })
      return isolated
    } catch (err) {
      onlineSharedViewFailed.add(session)
      console.warn('  [online] 共享视图 clone 失败，本局回退逐席位拷贝：' + String(err && err.message ? err.message : err))
      return null
    }
  }

  /**
   * 构建单席位精简视图（A1′）。共享副本可用时用它 + stateIsolated=true：Mod 可跳过字段深拷；
   * 共享路径异常则本局回退逐席位浅拷贝（失败模式只能是变慢）；逐席位也异常由调用方退回全量。
   */
  function slimSessionViewState(session, mod, seat, slimStatic) {
    const options = {
      includeStatic: false,
      publicCardCodes: new Set(Object.keys(slimStatic.cards)),
      publicCards: slimStatic.cards,
    }
    const sharedState = sharedViewStateFor(session)
    if (!sharedState) return mod.viewState({ ...session.state }, seat, options)
    try {
      return mod.viewState(sharedState, seat, { ...options, stateIsolated: true })
    } catch (err) {
      onlineSharedViewFailed.add(session)
      console.warn('  [online] 共享视图失败，本局回退逐席位拷贝：' + String(err && err.message ? err.message : err))
      return mod.viewState({ ...session.state }, seat, options)
    }
  }

  // 浏览器声明：command 用 body.client.staticVersion；status / 其它 GET 用 clientStatic 查询参数。
  // declared=false 表示旧客户端（不认识这套协议），必须给完整视图；declared=true 而 version='' 表示
  // 「新客户端但本地没有缓存」，需要随本次响应补发静态表。
  function staticDeclaration(url, body) {
    if (body && typeof body === 'object' && body.client && typeof body.client.staticVersion === 'string') {
      return { declared: true, version: body.client.staticVersion }
    }
    if (url && url.searchParams.has('clientStatic')) {
      return { declared: true, version: url.searchParams.get('clientStatic') || '' }
    }
    return { declared: false, version: '' }
  }

  /**
   * 按浏览器声明补全或省略静态表。host 大厅直接构建视图；guest 大厅用 receiveSnapshot 缓存的静态表
   * 补发（两层缓存）。任何异常都保持原 payload（最多是变慢，不会显示错状态）。
   */
  function decorateOnlineViewPayload(payload, declaration) {
    const session = payload && payload.session
    if (!session || typeof session !== 'object' || Array.isArray(session)) return payload
    try {
      const host = !!online.me()?.host
      if (host) {
        if (!onlineSession || session.sessionId !== onlineSession.sessionId) return payload
        const info = staticFor(onlineSession)
        if (!info) return payload  // 能力缺失 / BOARDGAME_ONLINE_STATIC=0：保持全量
        // 顶层的 staticVersion 是给「想自己缓存静态表、但还没声明」的客户端的探测字段（可选、只增）。
        payload.staticVersion = info.version
        if (!declaration.declared) {
          payload.session = cachedSessionView(onlineSession, online.me().seat)
          return payload
        }
        payload.session = cachedSessionView(onlineSession, online.me().seat, { includeStatic: false })
        const current = staticFor(onlineSession) || info
        payload.staticVersion = current.version
        if (declaration.version !== current.version) payload.static = staticPayload(current)
        return payload
      }
      // guest 大厅：session 是房主投影好的席位视图；这里只负责补发/合并静态表。
      if (typeof session.staticVersion !== 'string') return payload  // 房主未启用静态表：本来就是全量
      const info = online.staticFor(session.sessionId)
      if (!info) {
        // 本厅没有缓存（刚重启/缓存被清）：请求房主重发带 static 的全量；本次响应保持现状。
        try { online.requestSync() } catch { /* 连接不可用时等下一次快照 */ }
        return payload
      }
      payload.staticVersion = info.version
      // 缓存版本必须和会话视图里的 staticVersion 一致；不一致说明本厅漏收过一次静态表，
      // 此时不要拿旧表 hydrate（会把旧卡面画成当前状态），改为请求房主重发并保持原响应。
      if (typeof session.staticVersion === 'string' && session.staticVersion !== info.version) {
        try { online.requestSync() } catch { /* 连接不可用时等下一次快照 */ }
        return payload
      }
      if (!declaration.declared) payload.session = mergeStaticIntoView(session, info)
      else if (declaration.version !== info.version) payload.static = staticPayload(info)
      return payload
    } catch (err) {
      console.warn('  [online] 静态表补发失败，保持原响应：' + String(err && err.message ? err.message : err))
      return payload
    }
  }

  // -------------------------------------------------------------------------
  // P3.1：浏览器 status 增量
  //
  // 长轮询每次 serial 变化都会返回整份 session（P1.4 后仍有 ~277KB），其中绝大多数字段没变。
  // 新浏览器在 status 请求里带 baseStamp=<上次收到的 stamp>；命中服务器基线时只回
  //   - sessionOmitted: true（内容与上次完全相同），或
  //   - sessionDelta: { stamp, baseStamp, changes }（snapshotChanges，通常几 KB）。
  // 未声明 baseStamp 的旧客户端、基线不匹配、delta 不够小、snapshotChanges 异常时一律回全量
  // （失败模式只能是「多下一次全量」，不会显示错状态）。BOARDGAME_ONLINE_STATUS_DELTA=0 回滚。
  const onlineStatusDelta = process.env.BOARDGAME_ONLINE_STATUS_DELTA !== '0'
  let onlineStatusSent = null  // { stamp, view }：本大厅上一次经 /status 发给浏览器的视图与 stamp
  function statusStampOf(view) {
    if (!view || typeof view !== 'object') return ''
    const parts = [view.sessionId || '', view.state?.revision ?? -1, Array.isArray(view.events) ? view.events.length : 0]
    if (typeof view.staticVersion === 'string' && view.staticVersion) parts.push(view.staticVersion)
    return parts.join(':')
  }
  function jsonByteLength(value) {
    try { return Buffer.byteLength(JSON.stringify(value)) } catch { return Infinity }
  }
  function applyStatusDelta(payload, url) {
    if (!onlineStatusDelta) return payload
    const view = payload && payload.session
    if (!view || typeof view !== 'object' || Array.isArray(view)) return payload
    try {
      const stamp = statusStampOf(view)
      const baseStamp = url && url.searchParams.has('baseStamp') ? (url.searchParams.get('baseStamp') || '') : null
      // 旧客户端（未声明）：保持全量，同时记录基线供下次声明增量的客户端使用。
      // stamp 是只增的可选字段（旧客户端会忽略），方便新客户端/测试读取。
      if (baseStamp === null) { payload.stamp = stamp; onlineStatusSent = { stamp, view }; return payload }
      if (onlineStatusSent && baseStamp === stamp && onlineStatusSent.stamp === stamp) {
        // 内容与浏览器手上的完全一致：省掉 session，只保留 busy/lobby/aiPending/static 等运行状态。
        delete payload.session
        payload.sessionOmitted = true
        payload.stamp = stamp
        return payload
      }
      if (onlineStatusSent && onlineStatusSent.stamp === baseStamp) {
        const changes = snapshotChanges(onlineStatusSent.view, view)
        if (changes && changes.length) {
          const delta = { stamp, baseStamp, changes }
          const deltaBytes = jsonByteLength(delta)
          // 只有确实比全量小才发增量；否则回全量（并重建基线）。
          if (deltaBytes < jsonByteLength(view)) {
            delete payload.session
            payload.sessionDelta = delta
            payload.stamp = stamp
            onlineStatusSent = { stamp, view }
            return payload
          }
        }
      }
      // 未命中 / 无法取得更小表示：回全量并记录新基线。
      payload.stamp = stamp
      onlineStatusSent = { stamp, view }
      return payload
    } catch (err) {
      console.warn('  [online] status 增量失败，回全量：' + String(err && err.message ? err.message : err))
      onlineStatusSent = null
      return payload
    }
  }

  function sessionView(session, observerSeat, options = {}) {
    const endPerf = perf.span('sessionView', { seat: observerSeat ?? null, online: !!session.online, eventCount: session.events?.length ?? 0 })
    const mod = modById(session.modId)
    const seat = observerSeat ?? session.players.find(player => player.role === 'human')?.seat
    const hasObserver = Number.isInteger(seat)
    // P1.4：只有在线会话、Mod 提供 staticTables 且调用方要求省略时才走精简视图。此时把权威 state
    // 浅拷贝交给 Mod（不能深拷一份 833KB 的 cards），并要求它不得修改入参；自愈补出的私有卡面放进
    // view.privateCards、公共卡面放进 view.cardsPatch，由大厅并进会话静态表。
    // P3.2 A1′：开关 + Mod 能力就绪时改为「每 revision 只 clone 一次、各席位共用」，见 slimSessionViewState。
    const slimStatic = options.includeStatic === false ? staticFor(session) : null
    let state
    if (hasObserver && typeof mod.viewState === 'function') {
      if (slimStatic) {
        try {
          state = slimSessionViewState(session, mod, seat, slimStatic)
        } catch (err) {
          // 能力实现异常：本会话永久回退全量（失败模式只能是变慢）。
          console.warn('  [online] 精简视图失败，本局回到全量视图：' + String(err && err.message ? err.message : err))
          onlineStaticCache.set(session, null)
          state = mod.viewState(structuredClone(session.state), seat)
        }
      } else {
        state = mod.viewState(structuredClone(session.state), seat)
      }
    } else {
      state = slimStatic ? { ...session.state } : session.state
    }
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.then === 'function') {
      throw new TypeError('观察者状态必须是同步返回的对象')
    }
    // 先按大厅规则遮蔽私聊（私聊只对目标席位与人类可见），再叠加 Mod 自己的事件投影。
    const history = session.online ? onlineEventHistory(session.events) : session.events
    const hallEvents = visibleChat(structuredClone(history), hasObserver ? seat : null, session.online ? 0 : hasObserver ? seat : 0)
    if (session.online && mod.viewState) for (const event of hallEvents) {
      if (event.type === 'move' && event.seat !== seat && event.move) event.move = { action: event.move.action }
    }
    const events = hasObserver && typeof mod.viewEvents === 'function'
      ? mod.viewEvents(hallEvents, seat) : hallEvents
    if (!Array.isArray(events)) throw new TypeError('观察者事件必须是同步返回的数组')
    const view = {
      ...(session.online ? {
        sessionId: session.sessionId, modId: session.modId, modName: session.modName,
        // 联机分支是显式挑字段的，新字段要加进来，否则客人视图读不到（docs/localization.md §8.6）。
        locale: session.locale || null,
        render: session.render, players: session.players, settings: {}, online: true,
        saveError: session.saveError, saveDetached: session.saveDetached,
        // P2.2：AI 后台回合未完成时随视图下发（只增可选字段），客户端据此显示「AI 思考中」。
        ...(session.pendingAi ? { pendingAi: true } : {}),
      } : session),
      // Never expose authoritative checkpoint snapshots (private hands, deck
      // order, RNG and continuation data). Mods may publish safe summaries.
      scenarioCheckpoints: typeof mod.checkpointView === 'function'
        ? mod.checkpointView(session, hasObserver ? seat : null) : undefined,
      observerSeat: seat,
      mySeat: seat,
      state: { ...state, revision: session.state.revision },
      events,
      notes: chatNotesView(session, seat),
      agentPlans: mod.agentPlanning ? mod.agentPlanning.view(session, hasObserver ? seat : null) : undefined,
      lifecycle: getSessionPolicy(mod, session.state),
      decisionSeat: getDecisionSeat(mod, session.state),
      actingSeats: getActingSeats(mod, session.state),
      // 只下发本座位的三态覆盖；默认值由客户端按 hasAutoReaction 计算，没有 defaults 字段。
      autoPrefs: autoReactionViewFor(session, hasObserver ? seat : null),
    }
    if (slimStatic) {
      // 公共卡面补丁并进会话静态表（版本随之变化 → 客户端会再收一次全量静态表）。
      if (state.cardsPatch) mergeCardsPatch(session, state.cardsPatch)
      delete view.state.cardsPatch
      // 静态表只允许来自 mod.staticTables：即便 Mod 没遵守 includeStatic=false 契约，也从 wire 上剥掉。
      delete view.state.cards
      delete view.state.investigatorDefs
      const current = staticFor(session)
      view.staticVersion = current ? current.version : slimStatic.version
    }
    endPerf({ eventCount: events.length, stateBytes: null })
    return view
  }

  // 一次行动里 publishOnline 会被调用很多次（提交后、每个 AI 动作后、finally、
  // 中转房间广播），其中不少次 state 与事件完全相同。个人视图只跟 revision、
  // 事件条数、备忘和存档状态有关，按这组指纹缓存一份即可，不必每个席位重算整局。
  function onlineViewKey(session) {
    const notes = Array.isArray(session.notes) ? session.notes : []
    return [
      session.state?.revision ?? -1,
      session.events?.length ?? 0,
      notes.map(note => note?.text || '').join('\u0000'),
      session.saveError === undefined ? '' : session.saveError === null ? 'null' : String(session.saveError),
      session.saveDetached ? 1 : 0,
      session.pendingAi ? 1 : 0,
      session.autoPrefs?.version ?? 0,
    ].join('|')
  }

  function cachedSessionView(session, seat, options = {}) {
    if (session !== onlineSession) return sessionView(session, seat, options)
    const key = onlineViewKey(session)
    if (onlineViewCache?.key !== key) onlineViewCache = { key, views: new Map() }
    // 缓存键必须包含「带静态表 / 省略静态表 + 静态表版本」维度：静态表版本变化（cardsPatch）
    // 会改变自愈结果与 staticVersion，不能和旧版本的精简视图混用。
    const slim = options.includeStatic === false
    const infoBefore = slim ? staticFor(session) : null
    const modeBefore = infoBefore ? 'slim:' + infoBefore.version : 'full'
    const cacheKey = seat + '|' + modeBefore
    let value = onlineViewCache.views.get(cacheKey)
    if (value) { perf.record('view.cache', { hit: true, seat }); return value }
    const endPerf = perf.span('view.build', { seat })
    value = sessionView(session, seat, options)
    const infoAfter = slim ? staticFor(session) : null
    const modeAfter = infoAfter ? 'slim:' + infoAfter.version : 'full'
    onlineViewCache.views.set(seat + '|' + modeAfter, value)
    endPerf({ hit: false })
    return value
  }

  function moveError(message, statusCode = 400, code = 'INVALID_MOVE') {
    return Object.assign(new Error(message), { statusCode, code })
  }

  function sendMoveError(res, session, err) {
    const status = Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400
    return sendJson(res, status, {
      ok: false, error: String(err?.message || err), code: err?.code || 'INVALID_MOVE',
      revision: session.state.revision,
      decisionSeat: getDecisionSeat(modById(session.modId), session.state),
      session: sessionView(session),
    })
  }

  function expectedRevision(body) {
    const fields = ['revision', 'expectedRevision'].filter(key => Object.hasOwn(body, key))
    for (const key of fields) {
      if (!Number.isSafeInteger(body[key]) || body[key] < 0) throw moveError('版本号必须是非负安全整数', 400, 'INVALID_REVISION')
    }
    if (fields.length === 2 && body.revision !== body.expectedRevision) throw moveError('版本号参数不一致', 400, 'INVALID_REVISION')
    return fields.length ? body[fields[0]] : undefined
  }

  function commitMove(session, seat, move, revision) {
    const mod = modById(session.modId)
    const command = structuredClone(move)
    if (session.state.revision !== revision) {
      const rebase = session.state.status === 'playing' && typeof mod.seatLocalMove === 'function'
        && getActingSeats(mod, session.state).includes(seat)
        && mod.seatLocalMove(structuredClone(session.state), seat, structuredClone(command))
      if (!rebase) throw moveError('对局版本已变化，请刷新后重试', 409, 'STALE_REVISION')
      revision = session.state.revision
      // Mods may also check a revision embedded in the command itself.
      if (command && typeof command === 'object' && Object.hasOwn(command, 'revision')) command.revision = revision
    }
    if (session.state.status !== 'playing') throw moveError('对局已结束', 409, 'GAME_OVER')
    if (!getActingSeats(mod, session.state).includes(seat)) throw moveError('当前应答座位已变化', 403, 'WRONG_SEAT')
    const before = session.state
    const state = structuredClone(before)
    const invalid = mod.validateMove ? mod.validateMove(structuredClone(state), seat, structuredClone(command)) : null
    if (invalid) throw moveError(String(invalid))
    const events = mod.applyMove(state, seat, command) || []
    if (!Array.isArray(events)) throw moveError('动作必须同步返回事件数组')
    state.revision = revision + 1
    if (!Number.isSafeInteger(state.revision)) throw moveError('对局版本号已达上限')
    const committedEvents = structuredClone(events).map((event, i) => ({ ...event, seq: session.events.length + i }))
    const nextEvents = session.events.concat(committedEvents)
    const receipt = { before, after: state, events: committedEvents, seat, move: command, revision: state.revision }
    const checkpoint = typeof mod.createSessionCheckpoint === 'function'
      ? mod.createSessionCheckpoint({ ...session, state, events: nextEvents }, receipt) : null
    const nextCheckpoints = checkpoint
      ? [...(session.scenarioCheckpoints || []), checkpoint]
      : session.scenarioCheckpoints
    // 提前暴露不可序列化的状态（循环引用等）：只需要检查这次新提交产生的内容。
    // 历史事件在写入时已经验证过，把整段历史再序列化一次会让每个动作多花几十毫秒。
    JSON.stringify({ state, events: committedEvents, checkpoint })
    session.state = state
    session.events = nextEvents
    if (nextCheckpoints) session.scenarioCheckpoints = nextCheckpoints
    trimEventVisuals(session)
    return receipt
  }

  function commitChoiceBatch(session, seat, batch, revision) {
    const mod = modById(session.modId)
    if (typeof mod?.commitChoiceBatch !== 'function' || !batch) throw moveError('不支持的批量选择')
    if (session.state.revision !== revision) throw moveError('对局版本已变化，请刷新后重试', 409, 'STALE_REVISION')
    return mod.commitChoiceBatch(session, seat, batch, { commitMove, moveError })
  }

  /**
   * 客户端上报的「快速反应已关闭」卡号集合（旧协议，保留兼容）：
   * 只接受有界字符串数组。返回 null 表示「没有这个字段」。
   */
  function normalizeAutoPassCodes(value) {
    if (!Array.isArray(value)) return null
    return value.filter(code => typeof code === 'string' && code.length > 0 && code.length <= 64)
      .slice(0, AUTO_PASS_MAX_CODES)
  }

  // 偏好序号：客户端每次上报带一个单调递增的安全整数；房主据此丢弃网络重排/重试带来的旧值。
  function normalizeAutoPassSeq(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  /** 旧协议：body.client.autoPass = { codes, seq? }（也兼容裸数组）。 */
  function autoPassPayloadOf(body) {
    const value = body && body.client && body.client.autoPass
    const codes = Array.isArray(value) ? value : value && Array.isArray(value.codes) ? value.codes : null
    if (!codes) return null
    return { codes: normalizeAutoPassCodes(codes), seq: normalizeAutoPassSeq(value?.seq) }
  }

  const AUTO_REACTION_STATES = new Set(['skip', 'ask', 'auto'])

  /** 逐卡三态覆盖：{ code: 'skip'|'ask'|'auto' }，有界、丢未知值。 */
  function normalizeAutoReactionStates(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const states = {}
    let count = 0
    for (const [code, state] of Object.entries(value)) {
      if (typeof code !== 'string' || !code || code.length > 64) continue
      if (!AUTO_REACTION_STATES.has(state)) continue
      if (++count > AUTO_PASS_MAX_CODES) break
      states[code] = state
    }
    return states
  }

  /** 新协议：body.client.autoPrefs = { states, seq? }。 */
  function autoReactionPayloadOf(body) {
    const value = body && body.client && body.client.autoPrefs
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const states = normalizeAutoReactionStates(value.states)
    if (!states) return null
    return { states, seq: normalizeAutoPassSeq(value.seq) }
  }

  function autoPrefsOf(session) {
    if (!session.autoPrefs || typeof session.autoPrefs !== 'object') session.autoPrefs = { version: 0, seats: {} }
    if (!session.autoPrefs.seats || typeof session.autoPrefs.seats !== 'object' || Array.isArray(session.autoPrefs.seats)) {
      session.autoPrefs.seats = {}
    }
    return session.autoPrefs
  }

  // 偏好不靠整局快照：改一个开关只写一个很小的 sidecar（500ms 去抖）。
  const autoPrefsSaveTimers = new WeakMap()
  function scheduleAutoPrefsSave(session) {
    if (!persistOn || session.saveDetached || autoPrefsSaveTimers.has(session)) return
    const timer = setTimeout(() => {
      autoPrefsSaveTimers.delete(session)
      const model = autoPrefsOf(session)
      savePrefsAsync(session.sessionId, session.modId, model.seats)
        .catch(err => {
          // 会话/临时目录被删掉时（测试 teardown、用户清理）不值得刷警告。
          if (err?.code === 'ENOENT') return
          console.warn('  [prefs] 保存反应偏好失败：' + String(err && err.message ? err.message : err))
        })
    }, 500)
    timer.unref?.()
    autoPrefsSaveTimers.set(session, timer)
  }

  /** 读档时把 sidecar 合并进会话；没有 sidecar 时保留快照里的副本（或空覆盖）。 */
  function hydrateAutoPrefs(session) {
    const stored = persistOn ? readPrefs(session.sessionId) : null
    if (!stored) { autoPrefsOf(session); return }
    const seats = {}
    for (const [seatKey, entry] of Object.entries(stored.seats)) {
      const seat = Number(seatKey)
      if (!Number.isInteger(seat) || !entry || typeof entry !== 'object') continue
      const states = normalizeAutoReactionStates(entry.states)
      if (!states) continue
      seats[seat] = { states, seq: Number.isSafeInteger(entry.seq) ? entry.seq : 0 }
    }
    session.autoPrefs = { version: 1, seats }
  }

  /**
   * 记住某座位的三态覆盖（空对象 = 清除该座位）。
   * 带 seq 时只接受「不旧于已存 seq」的更新；返回是否采纳。
   */
  function rememberAutoReactionStates(session, seat, states, seq = null) {
    if (!autoPassEnabled || !session || !Number.isInteger(seat) || !states) return false
    const model = autoPrefsOf(session)
    const previous = model.seats[seat]
    if (previous && seq != null && Number.isSafeInteger(previous.seq) && seq < previous.seq) return false
    if (Object.keys(states).length) model.seats[seat] = { states, seq, at: Date.now() }
    else delete model.seats[seat]
    model.version++
    scheduleAutoPrefsSave(session)
    return true
  }

  function autoReactionStatesFor(session, seat) {
    if (session === onlineSession) {
      const members = online.status().room?.members
      if (!Array.isArray(members) || !members.some(member => member.seat === seat && member.online)) return {}
    }
    return autoPrefsOf(session).seats[seat]?.states || {}
  }

  function autoReactionViewFor(session, seat) {
    const entry = autoPrefsOf(session).seats[seat]
    return { mine: entry?.states || {}, seq: entry?.seq ?? 0 }
  }

  function skipCodesFromStates(states) {
    return Object.entries(states || {}).filter(([, state]) => state === 'skip').map(([code]) => code)
  }

  function legacyAutoPassStates(codes) {
    const states = {}
    for (const code of codes || []) states[code] = 'skip'
    return states
  }

  /**
   * 自动结算：把待决窗口按该座位当前的三态覆盖代答掉。
   * - `auto`：给 isAutomaticReward 的窗口补 choose/trigger；
   * - `skip`：给所有选项都已关闭的窗口补 choose/skip（沿用 reactionSkipPlan）；
   * - `ask`：不接管，窗口照常发布。
   *
   * 离线座位按「没有覆盖」处理（默认：自动资格的卡 auto），避免全桌等缺席玩家。
   * 走 commitMove，与手点同一条路径；Mod 未声明 autoChoice/autoPassChoice 时不做任何事。
   */
  function settleAutoChoices(session) {
    if (!autoPassEnabled) return 0
    const mod = modById(session.modId)
    const hook = typeof mod?.autoChoice === 'function' ? mod.autoChoice
      : typeof mod?.autoPassChoice === 'function' ? mod.autoPassChoice : null
    if (!hook) return 0
    let settled = 0
    for (let guard = 0; guard < AUTO_PASS_GUARD; guard++) {
      const state = session.state
      if (!state || state.status !== 'playing') break
      const choice = state.pendingChoice
      if (!choice) break
      const states = autoReactionStatesFor(session, choice.seat)
      let move
      try {
        move = hook({ state, seat: choice.seat, states, disabledCodes: skipCodesFromStates(states) })
      } catch (err) {
        console.warn('  [autopass] Mod 判定失败：' + String(err && err.stack ? err.stack : err))
        break
      }
      if (!move) break
      const revision = state.revision
      try {
        commitMove(session, choice.seat, move, revision)
      } catch (err) {
        // 失败模式只能是「没省下这一次请求」：窗口照常发布，客户端仍有兜底。
        console.warn('  [autopass] 提交自动结算失败：' + String(err && err.message ? err.message : err))
        break
      }
      if (session.state.revision <= revision) break
      settled++
    }
    return settled
  }

  function frequencyPass(session, key, rawFrequency) {
    const frequency = Math.max(0, Math.min(100, Math.round(Number(rawFrequency) || 0)))
    if (frequency <= 0) return false
    if (frequency >= 100) return true
    const seed = `${session.state.seed || session.sessionId}|${key}`
    const sample = createHash('sha256').update(seed).digest().readUInt32BE(0) % 100
    return sample < frequency
  }

  function actionSpeechEnabled(session, receipt) {
    const mod = modById(session.modId)
    const frequency = typeof mod.agentActionSpeechFrequency === 'function'
      ? mod.agentActionSpeechFrequency({ ...receipt, settings: session.settings || {} })
      : 100
    return frequencyPass(session, `action-speech:${receipt.revision}:${receipt.seat}`, frequency)
  }

  function publishAgentActionSpeech(session, receipt, speech) {
    const mod = modById(session.modId)
    if (!actionSpeechEnabled(session, receipt)) return
    if (speech) session.events.push({ seq: session.events.length, type: 'speech', seat: receipt.seat, text: speech })
    if (typeof mod.agentActionMessage !== 'function') return
    const text = clampChatText(mod.agentActionMessage({
      before: receipt.before, after: receipt.after, seat: receipt.seat, move: receipt.move, speech: speech || '',
    }), agentConfig.chatMaxChars)
    if (text) session.events.push({ seq: session.events.length, type: 'chat', seat: receipt.seat, to: null,
      text, ts: Date.now(), origin: 'action', revision: receipt.revision, replyRequested: false })
  }

  function reactionSeats(session, trigger) {
    const seats = session.players.filter(player => player.role === 'ai').map(player => player.seat)
    if (!seats.length || trigger.audience === 'none') return []
    if (trigger.audience === 'all') return seats
    if (seats.includes(trigger.preferredSeat)) return [trigger.preferredSeat]
    const digest = createHash('sha256').update(`${session.state.seed || session.sessionId}|speaker:${trigger.key}`).digest()
    return [seats[digest.readUInt32BE(0) % seats.length]]
  }

  function reactionFrequency(trigger, seat) {
    if (trigger.frequencyByRole && typeof trigger.frequencyByRole === 'object') {
      return seat === trigger.subjectSeat ? trigger.frequencyByRole.self : trigger.frequencyByRole.other
    }
    return trigger.frequency
  }

  async function runAgentReactions(session, receipt) {
    const mod = modById(session.modId)
    if (!receipt || typeof mod.agentReactionTriggers !== 'function' || agentConfig.chatEnabled === false) return
    let triggers
    try {
      triggers = mod.agentReactionTriggers({ ...receipt, settings: session.settings || {} }) || []
    } catch (err) {
      console.warn('  [agent] 事件触发分析失败：' + String(err && err.stack ? err.stack : err))
      return
    }
    for (const trigger of triggers) {
      if (!trigger || !trigger.key) continue
      for (const seat of reactionSeats(session, trigger)) {
        if (!frequencyPass(session, `reaction:${trigger.key}:${seat}`, reactionFrequency(trigger, seat))) continue
        if (session.events.some(event => event.type === 'chat' && event.origin === 'reaction'
          && event.triggerKey === trigger.key && event.seat === seat)) continue
        try {
          const outcome = await agent.agentReact(session, seat, trigger)
          const text = clampChatText(outcome.reply, agentConfig.chatMaxChars)
          if (text) session.events.push({ seq: session.events.length, type: 'chat', seat, to: null,
            text, ts: Date.now(), origin: 'reaction', triggerKind: trigger.kind,
            triggerKey: trigger.key, revision: receipt.revision, replyRequested: false })
        } catch (err) {
          console.warn('  [agent] 事件回应失败：' + String(err && err.stack ? err.stack : err))
        }
      }
    }
  }

  // 连续跑同一个 AI 座位的多步决策。
  //
  // 回合内记忆：只要仍然轮到同一个 AI 座位，就复用同一个 turn 上下文，让模型的多步
  // 决策共享一段对话历史（见 lib/agent/orchestrator.js 顶部说明）。座位改变、局面变化
  // 或模型被中止时立即结算并作废该回合，绝不把别的回合的历史带过去。
  const AI_TURN_CALL_GUARD = 200
  const AI_AUTO_RETRIES = 2

  // 同时操作阶段可能有多个 AI 座位待行动：优先沿用当前回合的座位，其次是主应答座位。
  function nextAiSeat(mod, session, preferred) {
    const seats = getActingSeats(mod, session.state)
    const primary = getDecisionSeat(mod, session.state)
    const ordered = [preferred, primary, ...seats].filter(seat => seats.includes(seat))
    return ordered.find(seat => session.players[seat]?.role === 'ai') ?? null
  }

  async function runAiTurnsInner(session, options = {}) {
    const mod = modById(session.modId)
    let guard = 0
    let turn = null
    let turnSeat = null
    let turnKey = null
    let recoveries = 0

    // 结束当前 AI 回合：结算统计并丢弃上下文（幂等）。
    const closeTurn = () => {
      if (!turn) return
      agent.endTurn(turn)
      turn = null
      turnSeat = null
    }

    try {
      while (session.state.status === 'playing' && guard++ < AI_TURN_CALL_GUARD) {
        // 自动结算：上一次 AI 步骤可能留下可选反应窗口；先按三态覆盖代答再决定 AI 下一步。
        settleAutoChoices(session)
        const seat = nextAiSeat(mod, session, turnSeat)
        if (seat === null) break

        const state = session.state
        const revision = state.revision

        // 座位变了就必须结算上一个回合并换上下文；同一座位则沿用同一回合记忆。
        const nextTurnKey = mod.agentTurnKey?.(state, seat)
        if (!turn || turnSeat !== seat || nextTurnKey !== turnKey) {
          closeTurn()
          turn = createTurnContext(seat, mod.id, session.sessionId)
          turnSeat = seat
          turnKey = nextTurnKey
        }

        let outcome
        try {
          outcome = await agent.agentPlay(session, seat, turn)
        } catch (err) {
          // 编排器自身抛错（非模型错误）属于大厅缺陷，明确失败而不是静默停住。
          console.warn('  [agent] 回合中止：' + String(err && err.stack ? err.stack : err))
          throw Object.assign(new Error('AI 回合执行失败：' + String(err && err.message ? err.message : err)), { statusCode: 500, code: 'AGENT_FAILED' })
        }

        // 状态/座位/角色在模型返回期间发生变化：本次结果作废，按新状态重新取回合。
        if (session.state !== state || state.revision !== revision ||
            state.status !== 'playing' || !getActingSeats(mod, state).includes(seat) ||
            session.players[seat]?.role !== 'ai') {
          closeTurn()
          continue
        }

        if (outcome.move == null) {
          const reason = outcome.reason || 'unknown'
          if (['turn-timeout', 'turn-budget'].includes(reason) && recoveries < AI_AUTO_RETRIES) {
            const previousSteps = (turn.priorSteps || 0) + turn.steps
            const lastMoveText = turn.lastMoveText
            closeTurn()
            recoveries++
            const delayMs = recoveries * 1000
            session.events.push({ seq: session.events.length, type: 'agentRetry', seat,
              reason, attempt: recoveries, maxAttempts: AI_AUTO_RETRIES, revision,
              text: `AI 暂时中断，${delayMs / 1000} 秒后自动重试（${recoveries}/${AI_AUTO_RETRIES}）。` })
            await snapshotSession(session)
            await new Promise(resolve => setTimeout(resolve, delayMs))
            // Rebuild from the latest committed state; never replay the failed command.
            // Keep the session busy during backoff to prevent duplicate AI runners.
            if (session.state !== state || state.revision !== revision || state.status !== 'playing' ||
                !getActingSeats(mod, state).includes(seat) || session.players[seat]?.role !== 'ai') continue
            turn = createTurnContext(seat, mod.id, session.sessionId)
            turn.priorSteps = previousSteps
            turn.lastMoveText = lastMoveText
            turnSeat = seat
            turnKey = nextTurnKey
            continue
          }
          console.warn('  [agent] 座位 ' + seat + ' 无法行动（' + reason + '）：' + (outcome.error || ''))
          throw Object.assign(
            new Error('AI 队友无法行动（' + reason + '）：' + (outcome.error || '未知原因')
              + (recoveries >= AI_AUTO_RETRIES ? '；自动重试已达上限，可点击“继续 AI 行动”重试。' : '')),
            { statusCode: 502, code: 'AGENT_STALLED' },
          )
        }

        let receipt
        try {
          receipt = commitMove(session, seat, outcome.move, revision)
          if (mod.agentPlanning) mod.agentPlanning.commit(session, seat, outcome.plan, state)
        } catch (err) {          console.warn('  [agent] 本次行动未提交：' + String(err && err.message ? err.message : err))
          closeTurn()
          throw err
        }
        // 自动结算：AI 这一步可能打开了可选反应窗口；在任何 snapshot / onStep 发布之前代答，
        // 否则后台 runner 的中间快照会先把窗口发给客户端。
        settleAutoChoices(session)
        publishAgentActionSpeech(session, receipt, outcome.speech || '')
        await runAgentReactions(session, receipt)
        if (mod.agentPlanning) {
          session.events.push({ seq: session.events.length, type: 'agentDecision', seat,
            action: outcome.move.action, fallback: !!outcome.fallback, refined: !!outcome.refined,
            reason: outcome.reason || 'model', attempts: outcome.attempts })
          await snapshotSession(session)
        }
        // P2.2：后台 runner 在每个 AI 步骤提交后落盘 + 发布（客户端逐步看到 AI 行动）。
        // 同步路径不传 onStep，行为与旧版完全一致。
        if (typeof options.onStep === 'function') await options.onStep(session, receipt)

        // 中途被预算中止：保留已提交的合法行动，让人类可以继续，但不再往下走。
        if (outcome.stalled) {
          console.warn('  [agent] 座位 ' + seat + ' 回合提前结束：' + (outcome.error || ''))
          closeTurn()
          break
        }

        // 行动点用尽说明该座位的「回合」已经结束：即便 decisionSeat 还停在它身上
        // （等它自己走 endTurn 之类的收尾动作），也不应把下个回合的记忆接上来。
        // 未声明行动点的游戏（如五子棋）不受影响，仍按座位切换划分回合。
        const remaining = mod.actionsRemaining?.(session.state, seat)
        if (Number.isFinite(remaining) && remaining <= 0) closeTurn()
      }

      if (guard >= AI_TURN_CALL_GUARD) {
        console.warn('  [agent] AI 连续回合数超过安全上限（' + AI_TURN_CALL_GUARD + '），已中止本次行动。')
        throw Object.assign(new Error('AI 连续行动次数异常（超过 ' + AI_TURN_CALL_GUARD + ' 步），已中止本次行动'), { statusCode: 502, code: 'AGENT_LOOP_LIMIT' })
      }
    } catch (err) {
      // P2.2：后台 runner 用 seat 定位失败座位，写进 agentError 事件（同步路径不受影响）。
      if (err && typeof err === 'object' && !Number.isInteger(err.seat)) {
        let failedSeat = Number.isInteger(turnSeat) ? turnSeat : null
        if (failedSeat === null) { try { failedSeat = nextAiSeat(mod, session, null) } catch { failedSeat = null } }
        if (Number.isInteger(failedSeat)) err.seat = failedSeat
      }
      throw err
    } finally {
      // 无论正常结束还是抛错，都要结算当前回合，统计才不会丢。
      closeTurn()
    }
  }

  // AI 回合是「一次行动」里最不可控的一段（模型延迟 + 多次提交/发布），单独记一条
  // 总耗时；未开埋点时只是空函数，不改变原有异常传播。
  async function runAiTurns(session, options = {}) {
    const endPerf = perf.span('runAiTurns', { revision: session.state?.revision, seats: session.players?.length ?? 0 })
    try { return await runAiTurnsInner(session, options) } finally { endPerf() }
  }

  // -------------------------------------------------------------------------
  // P2.2：后台 AI runner
  // -------------------------------------------------------------------------
  // 有模型时 AI 决策最不可控（几秒~几十秒）；没有模型时 agentPlay 走本地合法动作兜底，
  // 是同步计算，保持旧语义（也是离线/无密钥大厅的既有行为）。
  function aiBackgroundEligible() {
    return onlineAiBackground && !!agentConfig?.apiKey
  }

  /** 当前局面是否还有 AI 步骤要跑（与 runAiTurns 的取座规则一致）。 */
  function aiTurnPending(session) {
    if (!session || !session.state) return false
    try { return nextAiSeat(modById(session.modId), session) !== null } catch { return false }
  }

  /** 这次行动提交后是否可能有 AI 模型调用：AI 回合，或事件触发回应（需要 AI 座位）。 */
  function aiWorkPossible(session) {
    if (aiTurnPending(session)) return true
    if (!session.players?.some(player => player.role === 'ai')) return false
    const mod = modById(session.modId)
    return typeof mod?.agentReactionTriggers === 'function' && agentConfig?.chatEnabled !== false
  }

  /** 把失败的 AI 回合写入公共事件日志：客户端 / status 据此显示「AI 失败，可重试」。 */
  function appendAgentError(session, err) {
    const mod = modById(session.modId)
    let seat = Number.isInteger(err?.seat) ? err.seat : null
    if (seat === null) { try { seat = nextAiSeat(mod, session, null) } catch { seat = null } }
    const code = String(err?.code || 'AGENT_FAILED')
    const message = String(err?.message || err || 'AI 回合失败')
    session.events.push({ seq: session.events.length, type: 'agentError', seat, code, message,
      retryable: true, ts: Date.now(), revision: session.state.revision })
    console.warn('  [agent] 后台 AI 回合失败（' + code + '）：' + message)
  }

  /**
   * 启动后台 AI runner（每会话至多一个）。调用方必须先写 session.pendingAi=true 并落盘/发布，
   * 保证崩溃后能按存档恢复。这里负责最终一致性：
   *   - AI 每步 commit 后 snapshotSession + flush，客户端按 events.seq 逐步看到；
   *   - 失败追加 agentError 事件（不改变已经返回的命令响应）；
   *   - finally 一定清 pendingAi / busy、落盘并下发 final busy=false 快照。
   */
  function startAiBackground(session, { receipt = null } = {}) {
    if (aiBackgroundSessions.has(session)) return null
    aiBackgroundSessions.add(session)
    const runStep = async () => {
      await snapshotSession(session)
      try { flushPublish() } catch (err) { console.warn('  [online] 后台 AI 步骤发布失败：' + String(err && err.message ? err.message : err)) }
    }
    const task = (async () => {
      try {
        if (receipt) {
          // 事件回应也可能调用模型：先跑完并发布一次，再进入 AI 回合。
          await runAgentReactions(session, receipt)
          await runStep()
        }
        await runAiTurns(session, { onStep: runStep })
      } catch (err) {
        try { appendAgentError(session, err) } catch (error) {
          console.warn('  [agent] agentError 写入失败：' + String(error && error.message ? error.message : error))
        }
      } finally {
        aiBackgroundSessions.delete(session)
        session.pendingAi = false
        try { await snapshotSession(session) } catch (err) {
          console.warn('  [sessions] 后台 AI 收尾落盘失败：' + String(err && err.message ? err.message : err))
        }
        busy.delete(session)
        // 最终一次 flush 必须携带 busy=false；没有待发视图时补一条轻量 status。
        try { if (!flushPublish()) publishOnline({ mode: 'ai-done' }) } catch (err) {
          console.warn('  [online] 后台 AI 收尾发布失败：' + String(err && err.message ? err.message : err))
        }
      }
    })()
    // 后台任务不允许把异常漏成 unhandled rejection（内部 catch/finally 已兜底，这里再保险一次）。
    task.catch(() => {})
    return task
  }

  /** 构造「人类动作已提交、AI 回合在后台」的命令响应（只增可选字段，旧客户端可忽略）。 */
  function aiPendingResult(session, seat, body, member, chatResult = null) {
    const revision = session.state.revision
    const eventCount = session.events.length
    if (wantsSlimCommand(body, member)) {
      const view = staticFor(session) ? cachedSessionView(session, seat, { includeStatic: false }) : cachedSessionView(session, seat)
      return { ok: true, slim: true, sessionId: view.sessionId, revision, eventCount, busy: true, aiPending: true,
        ...(view.staticVersion ? { staticVersion: view.staticVersion } : {}),
        ...(chatResult ? { chat: chatResult } : {}) }
    }
    return { ok: true, session: commandSessionView(session, seat, body), revision, eventCount,
      busy: true, aiPending: true, ...(chatResult ? { chat: chatResult } : {}) }
  }

  async function createSession(mod, settings, revision = 0, onlinePlayers = null) {
    const players = onlinePlayers || buildPlayers(mod, settings)
    // 会话语言快照（docs/localization.md §8.6）：开局时把 Mod 的 resolved 写进 session.locale，
    // 并作为可选上下文传给 createState（旧 Mod 忽略第三个参数）。旧存档没有该字段也能读。
    const localeInfo = resolveModLocale(mod, currentLocale())
    const state = mod.createState(settings, players, {
      locale: localeInfo.resolved,
      requestedLocale: localeInfo.requested,
    })
    state.revision = revision
    const session = {
      sessionId: 'bg-' + (++seq) + '-' + Date.now().toString(36),
      modId: mod.id,
      modName: mod.name,
      locale: localeInfo.resolved,
      render: mod.render || {},
      players,
      state,
      settings,
      events: [],
      notes: [],
      scenarioCheckpoints: [],
      autoPrefs: { version: 0, seats: {} },
    }
    // 若 AI 先手，则直接替 AI 走完回合（含开场台词）。
    if (!onlinePlayers) await runAiTurns(session)
    return session
  }

  function publishOnline(options = {}) {
    if (!onlineSession || !online?.me()?.host) return
    const status = online.status()
    const room = status.room
    if (!room) return
    // P2.1：只有行动者的同步发布（mode='actor'）与后台补齐（mode='background'）会带 onlySeats。
    const onlySeats = Array.isArray(options.onlySeats) ? new Set(options.onlySeats) : null
    const mode = options.mode || 'full'
    const endPerf = perf.span('publishOnline', { mode })
    const lobby = onlineLoadPending ? { savedGame: true, modName: onlineSession.modName,
      revision: onlineSession.state.revision, players: onlineSession.players.map(({ seat, role, name }) => ({ seat, role, name })) } : null
    const busyNow = busy.has(onlineSession)
    const revision = onlineSession?.state?.revision ?? null
    let onlineMembers = 0, published = 0, skipped = 0, statusSent = 0, deferred = 0
    for (const member of room.members) {
      // 离线成员收不到快照，为它构建个人视图是纯浪费。
      if (!member.online) continue
      onlineMembers++
      // P2.1：本次只发部分席位时，其余成员留给响应之后的后台发布（不标记已发）。
      if (onlySeats && !onlySeats.has(member.seat)) { deferred++; continue }
      // P1.4：在线视图始终按「省略静态表」构建（房主浏览器与 guest 大厅再用各自缓存补发），
      // 这样每个 revision 不再为每席位深拷两份大表。
      const staticEnabled = !onlineLoadPending && !!staticFor(onlineSession)
      const value = onlineLoadPending ? null
        : (staticEnabled ? cachedSessionView(onlineSession, member.seat, { includeStatic: false }) : cachedSessionView(onlineSession, member.seat))
      // 同一次行动里同一个 revision 会被推送好几遍（提交后、每个 AI 动作后、finally、
      // 房间广播）：内容没变时直接跳过，连 deep copy 和 diff 都不用做。
      const info = staticEnabled ? staticFor(onlineSession) : null
      const staticVersion = info ? info.version : null
      const sendStatic = !!info && onlineMemberStatic.get(member.id) !== staticVersion
      const previous = onlinePublishedViews.get(member.id)
      if (previous) {
        const sameContent = previous.view === value && previous.lobby === lobby && previous.online === member.online
          && previous.staticVersion === staticVersion
        if (sameContent && previous.busy === busyNow) { skipped++; continue }
        // P1.1：内容没变、只有 busy（如命令 finally 里 busy true→false）变化时，
        // 用一条几十字节的 status 代替整份会话，既省发布 CPU 也省中转流量。
        if (sameContent && onlineBusyStatus) {
          online.publishStatus(member, { busy: busyNow, revision, lobby })
          onlinePublishedViews.set(member.id, { view: value, busy: busyNow, lobby, online: member.online, staticVersion })
          statusSent++
          continue
        }
      }
      // 静态表只在「该席位还没收到当前版本」时随这一份完整快照下发一次；之后只带 staticVersion。
      online.publish(member, value, busyNow, lobby, sendStatic ? { static: staticPayload(info) } : null)
      if (sendStatic) onlineMemberStatic.set(member.id, staticVersion)
      onlinePublishedViews.set(member.id, { view: value, busy: busyNow, lobby, online: member.online, staticVersion })
      published++
    }
    // 房间换过、成员离开后，旧成员的表项不该一直留着（每个表项都握着一份视图/静态表版本）。
    if (onlinePublishedViews.size > room.members.length) {
      const ids = new Set(room.members.map(member => member.id))
      for (const id of onlinePublishedViews.keys()) if (!ids.has(id)) onlinePublishedViews.delete(id)
      for (const id of onlineMemberStatic.keys()) if (!ids.has(id)) onlineMemberStatic.delete(id)
    }
    endPerf({ seats: room.members.length, onlineSeats: onlineMembers, published, skipped, statusSent, deferred,
      revision, busy: busyNow, lobby: !!lobby })
  }

  /**
   * P1.5：安排一次合并发布。窗口内多次调用只标脏（合成为一次），下一次事件循环（或命令末尾
   * 的 flushPublish）按「flush 时的最新状态」发布，因此不会发旧 revision。
   * 命令处理期间（onlinePublishHold > 0）连 setImmediate 也不排：AI 连续动作、多次快照都等
   * 命令末尾统一 flush，客户端靠最终快照里累积的 events.seq 回放。
   * BOARDGAME_ONLINE_COALESCE=0 时退化为立即 publishOnline（P1.4 行为）。
   */
  function schedulePublish() {
    if (!onlineCoalesce) { publishOnline(); return false }
    onlinePublishPending = true
    if (onlinePublishHold > 0 || onlinePublishScheduled) return false
    onlinePublishScheduled = setImmediate(() => {
      onlinePublishScheduled = null
      if (onlinePublishHold > 0) return
      try { flushPublish() } catch (err) { console.warn('  [online] 合并发布失败：' + String(err && err.message ? err.message : err)) }
    })
    onlinePublishScheduled.unref?.()
    return false
  }

  // P2.1：命令响应之后补发非行动者席位。走和命令末尾相同的 flush 通道，因此发的仍是最新 revision；
  // 若期间又开始了新命令（onlinePublishHold > 0），回调会直接返回，由那条命令的 flush 接手。
  function scheduleBackgroundPublish() {
    onlinePublishPending = true
    if (onlinePublishScheduled) return
    onlinePublishScheduled = setImmediate(() => {
      onlinePublishScheduled = null
      if (onlinePublishHold > 0 || !onlinePublishPending) return
      onlinePublishPending = false
      try { publishOnline({ mode: 'background' }) } catch (err) { console.warn('  [online] 后台发布失败：' + String(err && err.message ? err.message : err)) }
    })
    onlinePublishScheduled.unref?.()
  }

  /**
   * P1.5 / P2.1：若有待发布视图立即发布并清除，返回是否真的发了一次。
   * 传入 actorSeat 且开启 DEFER 时，先只同步发布行动者自己的快照（客人的命令依赖它），
   * 其他在线席位安排到命令响应之后的后台发布；否则一次性发布所有席位。
   */
  /**
   * P1.5 / P2.1：若有待发布视图，按需发布并清除，返回是否接手了这次发布。
   * P2.1 开启时（默认）命令内的最终视图整体推到命令响应之后的后台发布：响应不再等任何席位
   * 的视图构建/序列化/下发；命令响应里的 session 由调用方单独构建。失败模式仍是「晚一拍」。
   * 解析不到 actorSeat（非命令窗口）时保持同步 flush。
   */
  function flushPublish(options = {}) {
    if (onlinePublishScheduled) { clearImmediate(onlinePublishScheduled); onlinePublishScheduled = null }
    if (!onlinePublishPending) return false
    onlinePublishPending = false
    const actorSeat = Number.isInteger(options.actorSeat) ? options.actorSeat : null
    if (onlineDeferViews && actorSeat !== null) {
      scheduleBackgroundPublish()
      return true
    }
    publishOnline({ mode: 'flush' })
    return true
  }

  // 房间广播（别人加入/准备/断线/阶段变化）才需要重发个人视图；
  // 中转在每条消息后都会广播一次，不设门槛的话每次客人操作都白算一遍。
  function roomSignature(room) {
    if (!room) return ''
    const members = room.members
      .map(m => [m.id, m.seat, m.host ? 'host' : '', m.ready ? 'ready' : '', m.online ? 'online' : 'offline'].join(':'))
      .join(',')
    const aiSeats = (room.aiSeats || []).map(item => item.seat + ':' + item.name).join(',')
    return [room.code, room.phase, members, aiSeats].join('|')
  }

  // P1.4：命令响应里的 session 按浏览器声明决定是否带静态表；未声明（旧客户端）保持全量。
  function commandSessionView(session, seat, body) {
    const declared = typeof body?.client?.staticVersion === 'string'
    if (declared && staticFor(session)) return cachedSessionView(session, seat, { includeStatic: false })
    return cachedSessionView(session, seat)
  }

  /**
   * 反应偏好异步上行（每次 move 也会捎带刷新；prefs 用于「只切换开关、还没行动」）。
   * 只更新房主进程的座位覆盖，**不改变对局状态**：
   *   - 不占 busy、不进入 P1.5 的发布合并窗口；
   *   - 不主动代答已经在等的窗口（否则会和该座位客户端抢 revision），由客户端的命令结算；
   *   - 带 seq 时丢弃乱序到达的旧偏好；`states` 为空对象 = 清除该座位覆盖。
   *   旧协议 `codes` 仍接受，按 `{ code: 'skip' }` 迁移。
   */
  async function onlinePrefsCommand(message) {
    const { memberId, seat } = message
    const body = message.body || {}
    const room = online.status().room
    const member = room?.members.find(m => m.id === memberId && m.seat === seat)
    if (!member) throw new Error('你不在这个房间中')
    if (!onlineSession || onlineLoadPending) throw new Error('对局尚未开始')
    if (body.sessionId && body.sessionId !== onlineSession.sessionId) throw new Error('对局已变化，请刷新')
    if (onlineSession.players[seat]?.role !== 'human') throw new Error('该席位不可操作')
    let states = normalizeAutoReactionStates(body.states)
    if (!states) {
      const codes = normalizeAutoPassCodes(body.codes)
      if (!codes) throw new Error('反应偏好格式无效')
      states = legacyAutoPassStates(codes)
    }
    const accepted = rememberAutoReactionStates(onlineSession, seat, states, normalizeAutoPassSeq(body.seq))
    return { ok: true, revision: onlineSession.state.revision, accepted, stale: !accepted,
      autoPrefs: autoReactionViewFor(onlineSession, seat) }
  }

  async function onlineCommandImpl(message) {
    const { action, memberId, seat } = message
    const body = message.body || {}
    const room = online.status().room
    const member = room?.members.find(m => m.id === memberId && m.seat === seat)
    if (!member) throw new Error('你不在这个房间中')
    if (action === 'sync') { online.resetSnapshots(); onlinePublishedViews.clear(); onlineMemberStatic.clear(); publishOnline(); return { ok: true, session: onlineSession && !onlineLoadPending ? commandSessionView(onlineSession, seat, body) : null } }
    if (['start', 'reset', 'save', 'aiRetry'].includes(action) && !member.host) throw new Error('此操作仅房主可用')

    /**
     * P2.2：同步段收尾 + 启动后台 AI runner。
     * 调用方必须已经 busy.add(session) 且完成提交；这里负责把 pendingAi 标记连同权威状态整体落盘
     * （存档仍是全量），先把「人类动作 + busy=true」快照发出去，再启动后台 runner 并返回 aiPending 响应。
     * 已返回的响应不等待模型；后台失败只会追加 agentError 事件。
     */
    async function beginBackgroundAi(session, receipt = null) {
      session.pendingAi = true
      const endSnapshot = perf.span('phase.snapshot', { seat })
      try { await snapshotSession(session) } catch (err) {
        // 落盘失败（极少见）：撤销标记并把错误交给命令层，绝不留下一个没有 runner 的 pendingAi。
        session.pendingAi = false
        throw err
      } finally { endSnapshot() }
      try { flushPublish() } catch (err) {
        console.warn('  [online] 后台 AI 启动发布失败：' + String(err && err.message ? err.message : err))
      }
      let result
      try {
        result = aiPendingResult(session, seat, body, member)
      } catch (err) {
        // 视图构建失败（Mod 缺陷）时不留下没有 runner 的 pendingAi 标记。
        session.pendingAi = false
        throw err
      }
      startAiBackground(session, { receipt })
      // 标记「本命令启动了后台 AI」：命令边界不再 flush/清 busy（由 runner 收尾）。
      // 后台运行期间的其他命令（例如聊天）仍要正常 flush 自己的快照。
      message.aiStarted = true
      return result
    }

    if (action === 'start' || action === 'reset') {
      if (onlineStarting || room.phase === 'starting' || (onlineSession && busy.has(onlineSession))) throw new Error('对局正在处理，请稍后再试')
      if (action === 'start' && onlineSession && !onlineLoadPending) throw new Error('对局已经开始')
      if (action === 'reset' && onlineLoadPending) throw new Error('请先等待玩家加入并继续存档')
      if (action === 'reset' && !onlineSession) throw new Error('对局尚未开始')
      if (!onlineFillAi && room.members.length + (room.aiSeats?.length || 0) !== room.capacity) throw new Error('请等待所有玩家席位加入')
      if (room.members.some(m => !m.online || !m.ready)) throw new Error('请等待所有玩家上线并准备')
      onlineStarting = true
      try {
        await online.phase('starting')
        if (onlineLoadPending) {
          await online.phase('playing')
          onlineLoadPending = false
          sessions.set(onlineSession.sessionId, onlineSession)
          busy.add(onlineSession)
          if (onlineCoalesce && onlineBusyStatus) publishOnline()
          try {
            // P2.2：读档恢复时，存档里的 pendingAi 标记或「先手/待行动是 AI」都先回包再后台继续；
            // 回滚开关关闭（或没有模型）时仍保持「命令内跑完 AI」的旧行为。
            if ((onlineAiBackground && onlineSession.pendingAi) || (aiBackgroundEligible() && aiTurnPending(onlineSession))) {
              return await beginBackgroundAi(onlineSession)
            }
            await snapshotSession(onlineSession)
            await runAiTurns(onlineSession)
            await snapshotSession(onlineSession)
            // 旧进程留下的 pendingAi 标记在同步路径也要清掉，避免下次重启重复恢复。
            if (onlineSession.pendingAi) { onlineSession.pendingAi = false; await snapshotSession(onlineSession) }
          } finally { if (!aiBackgroundSessions.has(onlineSession)) busy.delete(onlineSession) }
          return { ok: true, session: commandSessionView(onlineSession, seat, body) }
        }
        const mod = modById(room.game.id)
        const settings = { ...mod.defaults, ...onlineSettings, playerCount: room.capacity, teammates: room.capacity - 1 }
        settings.opponents = Array.from({ length: room.capacity - 1 }, (_, i) => settings.opponents?.[i] || null)
        const settingsError = validateSettings(mod, settings)
        if (settingsError) throw new Error(settingsError)
        const players = buildPlayers(mod, settings)
        for (const m of room.members) players[m.seat] = { ...players[m.seat], seat: m.seat, role: 'human', aiId: undefined,
          name: m.name, avatar: m.host ? agentConfig.playerAvatar : '👤' }
        const old = onlineSession
        onlineSession = await createSession(mod, settings, old ? old.state.revision + 1 : 0, players)
        onlineSession.online = true
        if (old) onlineSession.sessionId = old.sessionId
        sessions.set(onlineSession.sessionId, onlineSession)
        await online.phase('playing')
        busy.add(onlineSession)
        if (onlineCoalesce && onlineBusyStatus) publishOnline()
        try {
          // P2.2：先手是 AI 时先完成阶段切换 + 首份快照并回包，后台再跑先手 AI 回合。
          if (aiBackgroundEligible() && aiTurnPending(onlineSession)) return await beginBackgroundAi(onlineSession)
          await snapshotSession(onlineSession)
          await runAiTurns(onlineSession)
          await snapshotSession(onlineSession)
        } finally { if (!aiBackgroundSessions.has(onlineSession)) busy.delete(onlineSession) }
        return { ok: true, session: commandSessionView(onlineSession, seat, body) }
      } catch (err) {
        await online.phase(onlineSession && !onlineLoadPending ? 'playing' : 'waiting').catch(() => {})
        throw err
      } finally { onlineStarting = false }
    }
    const s = onlineSession
    if (onlineLoadPending || room.phase !== 'playing') throw new Error('请等待玩家入座并由房主继续对局')
    if (!s) throw new Error('请先开始游戏')
    // P2.2：AI 后台运行期间允许聊天继续提交（聊天不推进局面，不会与 AI 抢座位）；
    // 其余命令仍返回 SESSION_BUSY，绝不重入第二个 AI runner。
    const aiThinking = s.pendingAi === true && aiBackgroundSessions.has(s)
    // 讨论可以叠加（新发言只落库、不排队回复）；其余操作仍然串行。
    const chatOnly = action === 'chat' && busy.has(s) && (aiThinking || chatRuntimeOf(s).inflight > 0)
    if (busy.has(s) && !chatOnly) throw moveError('正在处理上一操作，请稍后重试', 409, 'SESSION_BUSY')
    if (body.sessionId && body.sessionId !== s.sessionId) throw new Error('对局已变化，请刷新')
    if (!chatOnly) busy.add(s)
    // P1.5：命令一开始就用 P1.1 轻量 status 同步 busy=true（最终快照在命令末尾统一 flush）。
    if (!chatOnly && onlineCoalesce && onlineBusyStatus) publishOnline()
    let chatResult = null
    try {
      if (action === 'move') {
        if (!Number.isInteger(body.revision)) throw new Error('行动必须携带对局版本号')
        if (s.players[seat]?.role !== 'human') throw new Error('该席位不可操作')
        // 四段分开计时，基准里能直接看出点击时间花在提交、AI 回合、快照还是发布上。
        const endCommit = perf.span('phase.commit', { seat })
        // 本命令携带的三态覆盖：先按 seq 写房主进程缓存（空对象=清除），再提交人类动作，
        // 最后在任何 snapshot / beginBackgroundAi 发布之前代答。旧 autoPass.codes 兼容成 skip。
        const autoPrefsPayload = autoReactionPayloadOf(body)
        if (autoPrefsPayload) {
          rememberAutoReactionStates(s, seat, autoPrefsPayload.states, autoPrefsPayload.seq)
        } else {
          const legacyAutoPass = autoPassPayloadOf(body)
          if (legacyAutoPass) rememberAutoReactionStates(s, seat, legacyAutoPassStates(legacyAutoPass.codes), legacyAutoPass.seq)
        }
        let receipt
        try {
          receipt = body.batchChoices
            ? commitChoiceBatch(s, seat, body.batchChoices, body.revision)
            : commitMove(s, seat, body.move, body.revision)
        } finally { endCommit() }
        settleAutoChoices(s)
        // P2.2：人类动作提交后立即回包（目标 <200ms），模型调用全部进后台：
        // 事件回应 + AI 回合在 runner 里逐步落盘/发布；失败写 agentError，不改变本响应。
        if (aiBackgroundEligible() && aiWorkPossible(s)) return await beginBackgroundAi(s, receipt)
        const endReactions = perf.span('phase.reactions', { seat })
        try { await runAgentReactions(s, receipt) } finally { endReactions() }
        const endSnapshot = perf.span('phase.snapshot', { seat })
        try { await snapshotSession(s) } finally { endSnapshot() }
        const endAi = perf.span('phase.ai', { seat })
        try { await runAiTurns(s) } finally { endAi() }
      } else if (action === 'forkCheckpoint') {
        if (body.confirm !== true) throw moveError('重新开始关卡需要二次确认', 400, 'CONFIRM_REQUIRED')
        const revision = expectedRevision(body)
        if (revision === undefined || revision !== s.state.revision) {
          throw moveError('对局版本已变化，请刷新后重试', 409, 'STALE_REVISION')
        }
        const mod = modById(s.modId)
        if (typeof mod?.forkSessionCheckpoint !== 'function') {
          throw moveError('该桌游不支持关卡回溯', 400, 'CHECKPOINT_UNSUPPORTED')
        }
        const nextRevision = s.state.revision + 1
        if (!Number.isSafeInteger(nextRevision)) throw moveError('对局版本号已达上限')
        const branch = mod.forkSessionCheckpoint(s, body.checkpointId, {
          sessionId: 'bg-' + (++seq) + '-' + Date.now().toString(36),
          revision: nextRevision,
          seat,
        })
        await snapshotSession(branch)
        sessions.set(branch.sessionId, branch)
        onlineSession = branch
        online.remember()
        return { ok: true, sourceSessionId: s.sessionId, session: commandSessionView(branch, seat, body) }
      } else if (action === 'aiRetry') {
        // P2.2：显式重试同样立即回包，AI 回合在后台继续（失败会再次写 agentError）。
        // P1：AI 继续跑时也可能给出反应窗口，用已缓存的座位偏好一并代答。
        if (aiBackgroundEligible() && aiTurnPending(s)) return await beginBackgroundAi(s, null)
        await runAiTurns(s)
      } else if (action === 'chat') {
        if (!agentConfig.chatEnabled) throw new Error('聊天功能已关闭')
        const text = clampChatText(body.text, agentConfig.chatMaxChars || 500)
        if (!text) throw new Error('聊天内容不能为空')
        const to = body.to == null ? null : body.to
        if (to !== null && (!Number.isInteger(to) || to === seat || !s.players[to])) throw new Error('私聊对象无效')
        chatResult = await runChatTurn(s, seat, text, to, { online: true, onPlayerEvent: publishOnline })
        await finishChat(s, chatResult)
      } else if (action !== 'save') throw new Error('不支持的房间操作')
      await snapshotSession(s)
      // P2.2：AI 后台运行期间提交的聊天不持有 busy，但仍要告诉客户端 AI 还在思考。
      const stillAiPending = s.pendingAi === true && aiBackgroundSessions.has(s)
      // P1.2：浏览器客人可以只拿摘要，省掉随命令再传一遍整份视图（快照随后由长轮询送达）。
      if (wantsSlimCommand(body, member)) {
        // P1.4：摘要只需要 revision/事件条数，用缓存的精简视图即可（不再为客人命令构建全量视图）；
        // 同时带回 staticVersion，浏览器可据此继续 hydrate / 校验本地静态表。
        const view = staticFor(s) ? cachedSessionView(s, seat, { includeStatic: false }) : cachedSessionView(s, seat)
        return { ok: true, slim: true, sessionId: view.sessionId, revision: view.state.revision,
          eventCount: view.events.length, busy: stillAiPending,
          ...(stillAiPending ? { aiPending: true } : {}),
          ...(view.staticVersion ? { staticVersion: view.staticVersion } : {}),
          ...(chatResult ? { chat: chatResult } : {}) }
      }
      return { ok: true, session: commandSessionView(s, seat, body), ...(chatResult ? { chat: chatResult } : {}),
        ...(stillAiPending ? { aiPending: true, busy: true, revision: s.state.revision, eventCount: s.events.length } : {}) }
    } finally { if (!chatOnly && !aiBackgroundSessions.has(s)) busy.delete(s) }
  }

  /**
   * P1.5：命令边界 = 发布合并窗口。
   * 命令进行中所有 schedulePublish 只标脏；这里在成功或失败返回前 flush 一次最终视图，
   * 保证「命令响应 = 最终状态已发出」，同时绝不把旧 revision 当最终状态。
   * 没有待发视图时补一次 publishOnline，让 busy true→false 仍走 P1.1 的轻量 status。
   * 开关关闭时保持 P1.4 行为：snapshotSession / 命令末尾各自立即发布。
   */
  async function onlineCommandInner(message) {
    if (!onlineCoalesce) {
      try { return await onlineCommandImpl(message) }
      finally {
        // P2.2：启动后台 AI 的命令不在这里清 busy / 发最终快照（runner 负责 busy=false 的最终 flush）。
        if (!message.aiStarted) publishOnline()
      }
    }
    onlinePublishHold++
    try {
      return await onlineCommandImpl(message)
    } finally {
      onlinePublishHold--
      // P2.2：本命令启动了后台 AI runner 时，busy 与最终快照归 runner 管（它自己的 flush 会带
      // busy=false），命令边界不再 flush/清 busy；后台运行期间的其他命令（如聊天）仍正常 flush。
      if (!message.aiStarted) {
        // P2.1：行动者的快照在响应前同步发出，其他在线席位留到响应之后的后台发布。
        // flush 返回 true 说明最终快照已发出（其中带 busy=false）；
        // false 说明本次命令没有新视图（如校验失败/同步），补一条 busy status。
        if (!flushPublish({ actorSeat: Number.isInteger(message.seat) ? message.seat : null })) publishOnline({ mode: 'fallback' })
      }
    }
  }

  // P0 埋点：一次联机操作的总耗时 + 期间 publishOnline 次数 / serial 变化。
  // 关闭埋点时直接调用原实现，不额外扫描记录、不改变返回/异常。
  async function onlineCommand(message) {
    if (!perf.enabled) return onlineCommandInner(message)
    const recordFrom = perf.count()
    const serialBefore = online?.status().serial ?? 0
    const endPerf = perf.span('onlineCommand', { action: message.action, seat: message.seat })
    try {
      return await onlineCommandInner(message)
    } finally {
      const { records } = perf.recordsSince(recordFrom)
      let publishes = 0
      for (const entry of records) if (entry.event === 'publishOnline') publishes++
      endPerf({ publishes, serialDelta: (online?.status().serial ?? 0) - serialBefore })
    }
  }

  online = createOnline({ mods, stateFile: onlineStateFile,
    resumeState: () => ({ sessionId: onlineSession?.sessionId || null, settings: onlineSettings, fillAi: onlineFillAi, loadPending: onlineLoadPending }),
    onRoom: () => {
      const stamp = roomSignature(online.status().room)
      if (stamp !== onlineRoomSignature) {
        onlineRoomSignature = stamp
        onlinePublishedViews.clear()
        publishOnline()
      }
      if (online?.me()?.host && online.status().connected && online.status().room?.phase === 'starting' && !onlineStarting) {
        online.phase(onlineSession && !onlineLoadPending ? 'playing' : 'waiting').catch(() => {})
      }
    }, onCommand: message => {
    if (message.action === 'sync') return onlineCommand(message)
    // P1：偏好同步是轻量、幂等、不推进局面的缓存写入；不进命令合并窗口/幂等表（避免与
    // 正在执行的命令抢发布），空闲时可能就地代答窗口。
    if (message.action === 'prefs') return onlinePrefsCommand(message)
    const operationId = message.body?.operationId
    if (typeof operationId !== 'string' || operationId.length > 100) throw new Error('缺少操作编号')
    const key = message.memberId + ':' + operationId
    const fingerprint = JSON.stringify([message.action, message.body])
    const previous = onlineOperations.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('操作编号已被使用')
      // 重复操作直接回放第一次的响应；P1.2 的瘦身响应（slim）、P2.2 的 aiPending 响应与
      // P1.4 的精简视图保持原样（幂等回放不得再启动一次 AI runner）；旧客户端的完整会话
      // 仍按当前 revision 补齐。
      return previous.result.then(data => (data?.slim || data?.aiPending || !onlineSession || data?.session?.staticVersion
        ? data
        : { ...data, session: cachedSessionView(onlineSession, message.seat) }))
    }
    const result = Promise.resolve().then(() => onlineCommand(message))
    onlineOperations.set(key, { fingerprint, result })
    if (onlineOperations.size > 256) onlineOperations.delete(onlineOperations.keys().next().value)
    return result
  } })

  // -------------------------------------------------------------------------
  // HTTP 工具
  // -------------------------------------------------------------------------

  function sendJson(res, status, data) {
    const body = JSON.stringify(data)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        chunks.push(c); size += c.length
        if (size > limit) { reject(new Error('body too large')); req.destroy() }
      })
      req.on('end', () => {
        if (chunks.length === 0) return resolve({})
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (err) { reject(err) }
      })
      req.on('error', reject)
    })
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.avif': 'image/avif',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ogg': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
  }

  function requestedVersion(url) {
    const values = [...url.searchParams.getAll('version'), ...url.searchParams.getAll('v')]
    if (values.length > 1) throw new RangeError('重复的资源版本参数')
    return values.length ? values[0] : null
  }

  /** 条件请求是否可以直接 304（`if-none-match` 优先，其次 `if-modified-since`）。 */
  function notModified(req, etag, modifiedAt) {
    const match = req.headers['if-none-match']
    if (match) return match.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
    return !!(modifiedAt && req.headers['if-modified-since'] &&
      Math.floor(modifiedAt.getTime() / 1000) <= Math.floor(Date.parse(req.headers['if-modified-since']) / 1000))
  }

  function sendPublic(req, res, body, contentType, version, requested, modifiedAt, options = {}) {
    if (requested !== null && requested !== version) return sendJson(res, 409, { ok: false, error: '资源版本已变化，请刷新', resourceVersion: version })
    const etag = '"' + (options.etag || createHash('sha256').update(body).digest('hex')) + '"'
    const headers = {
      'content-type': contentType,
      'cache-control': options.cacheControl || (requested === null ? 'public, max-age=0, must-revalidate' : 'public, max-age=31536000, immutable'),
      'etag': etag,
      'x-content-type-options': 'nosniff',
    }
    if (modifiedAt) headers['last-modified'] = modifiedAt.toUTCString()
    if (notModified(req, etag, modifiedAt)) {
      res.writeHead(304, headers)
      return res.end()
    }
    // Audio seeking: serve a single byte range, retaining ordinary cache validation.
    if (contentType.startsWith('audio/')) {
      headers['accept-ranges'] = 'bytes'
      const size = Buffer.byteLength(body)
      const range = req.headers.range
      const ifRange = req.headers['if-range']
      const canRange = !ifRange || ifRange === etag || (modifiedAt && Math.floor(modifiedAt.getTime() / 1000) <= Math.floor(Date.parse(ifRange) / 1000))
      if (req.method === 'GET' && range && canRange && /^bytes=\d*-\d*$/.test(range)) {
        const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(range)
        const start = first ? Number(first) : Math.max(0, size - Number(last))
        const end = first && last ? Math.min(Number(last), size - 1) : size - 1
        if ((!first && !last) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
          return res.end()
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
        return res.end(body.subarray(start, end + 1))
      }
    }
    res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function isInside(root, file) {
    const relative = path.relative(root, file)
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }

  /** 解析请求路径对应的静态根目录：/mods/<id>/... 走该 Mod 自带的 web 目录，其余走大厅 public/。 */
  function staticRootFor(decoded) {
    const match = /^\/mods\/([^/]+)\/(.+)$/.exec(decoded)
    if (!match) return { root: PUBLIC_DIR, rel: decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '') }
    const mod = modById(match[1])
    if (!mod || !mod.web || !mod.web.root) return null
    return { root: mod.web.root, rel: match[2], mod }
  }

  // -------------------------------------------------------------------------
  // 静态资源：摘要缓存 + 媒体长缓存
  //
  // 静态请求里绝大多数是「浏览器拿着上次的 ETag 来复验」（cache-control 是
  // must-revalidate 时，每一次重新显示卡图/标记都要走一轮）。原来的实现每次复验都
  // `readFile` 整个文件再算两遍 sha256——一张卡图 100–700 KB，一屏几十张，全部排在
  // 同一个单线程事件循环上，于是卡图、混乱标记会一张一张「过一会儿才出来」。
  //
  // 这里按 (mtime, size) 记住摘要：命中时 304 不再读盘、也不再算哈希；
  // 内容没有变化时 200 也只读一次盘。mtime 或大小变了立刻重新计算，不会发陈旧 ETag。
  // 二进制媒体（卡图 / 标记 / 字体 / 音频）改成长缓存 + immutable：这些文件由 Mod
  // 随包发布，内容稳定，让浏览器直接命中本地缓存，连复验都不用发。
  // -------------------------------------------------------------------------
  const staticDigests = new Map()
  const STATIC_DIGEST_LIMIT = 4096
  const MEDIA_TYPES = new Set([
    '.avif', '.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.woff', '.woff2', '.ttf', '.otf', '.ogg', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.webm', '.mp4',
  ])
  // 媒体缓存有效期：一局游戏通常几小时，一天足够让同一次游玩零复验；
  // 同时把「Mod 更新后卡图变旧」的窗口限制在一天内。
  const MEDIA_MAX_AGE = 24 * 60 * 60
  const realRoots = new Map()

  function knownStaticDigest(file, stats) {
    const cached = staticDigests.get(file)
    if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) return null
    staticDigests.delete(file); staticDigests.set(file, cached) // LRU：命中后放到队尾
    return cached.digest
  }

  function rememberStaticDigest(file, stats, digest) {
    staticDigests.delete(file)
    staticDigests.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, digest })
    if (staticDigests.size > STATIC_DIGEST_LIMIT) staticDigests.delete(staticDigests.keys().next().value)
  }

  /** 静态根目录的 realpath 在进程内不会变，缓存它省掉每次请求的一次系统调用。 */
  async function staticRootReal(root) {
    const cached = realRoots.get(root)
    if (cached) return cached
    const real = await fs.promises.realpath(root)
    if (realRoots.size > 64) realRoots.delete(realRoots.keys().next().value)
    realRoots.set(root, real)
    return real
  }

  async function serveStatic(url, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    }
    try {
      const decoded = decodeURIComponent((req.url || '/').split('?')[0])
      if (/[\\\x00:]/.test(decoded) || decoded.split('/').includes('..')) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const resolved = staticRootFor(decoded)
      if (!resolved) return sendJson(res, 404, { ok: false, error: 'not found' })
      const file = path.resolve(resolved.root, resolved.rel)
      if (!isInside(resolved.root, file)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const root = await staticRootReal(resolved.root)
      let real
      try {
        real = await fs.promises.realpath(file)
      } catch (error) {
        const missing = ['ENOENT', 'ENOTDIR'].includes(error.code)
        const canCache = req.method === 'GET' && missing && typeof resolved.mod?.cacheWebAsset === 'function'
        if (!canCache || !await resolved.mod.cacheWebAsset({ relative: resolved.rel, searchParams: url.searchParams })) throw error
        real = await fs.promises.realpath(file)
      }
      if (!isInside(root, real)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const stats = await fs.promises.stat(real)
      if (!stats.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' })
      const extension = path.extname(real).toLowerCase()
      const requested = requestedVersion(url)
      const digest = knownStaticDigest(real, stats)
      // 带版本参数（?v=）的资源本来就可以永久缓存；其余二进制媒体给一天的长缓存，
      // 让「重新显示同一张卡图」完全不打网络请求。
      const cacheControl = requested !== null
        ? 'public, max-age=31536000, immutable'
        : MEDIA_TYPES.has(extension) ? `public, max-age=${MEDIA_MAX_AGE}, immutable` : undefined
      // 摘要已知：条件请求直接 304，不读盘、不算哈希。
      if (digest !== null) {
        const etag = '"' + digest + '"'
        if (requested !== null && requested !== digest) {
          return sendJson(res, 409, { ok: false, error: '资源版本已变化，请刷新', resourceVersion: digest })
        }
        if (notModified(req, etag, stats.mtime)) {
          const headers = {
            'content-type': MIME[extension] || 'application/octet-stream',
            'cache-control': cacheControl || 'public, max-age=0, must-revalidate',
            etag,
            'x-content-type-options': 'nosniff',
            'last-modified': stats.mtime.toUTCString(),
          }
          res.writeHead(304, headers)
          return res.end()
        }
      }
      const data = await fs.promises.readFile(real)
      const version = digest ?? createHash('sha256').update(data).digest('hex')
      if (digest === null) rememberStaticDigest(real, stats, version)
      return sendPublic(req, res, data, MIME[extension] || 'application/octet-stream', version, requested, stats.mtime,
        { etag: version, cacheControl })
    } catch (err) {
      const status = err instanceof URIError || err instanceof RangeError ? 400 : ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(err.code) ? 404 : err.code === 'EACCES' ? 403 : 500
      return sendJson(res, status, { ok: false, error: status === 400 ? '无效资源请求' : status === 404 ? 'not found' : status === 403 ? 'forbidden' : '读取资源失败' })
    }
  }

  // -------------------------------------------------------------------------
  // API 路由
  // -------------------------------------------------------------------------

  // Mod 专属只读接口：/api/mods/<id>/<path>
  // 大厅只做派发、版本化缓存与错误归一化，不理解具体桌游的数据语义。
  const modVersions = new Map()
  async function modResourceVersion(mod) {
    if (!modVersions.has(mod.id)) modVersions.set(mod.id, Promise.resolve(mod.resourceVersion()).catch(err => {
      modVersions.delete(mod.id)
      throw err
    }))
    return modVersions.get(mod.id)
  }

  async function snapshotCompatibility(record) {
    const mod = modById(record.session.modId)
    if (!mod) return '桌游模块不可用'
    // Some games version their saved rules/data inside the state separately
    // from browser artwork and UI. Let that explicit validator own compatibility.
    if (mod.saveCompatibilityFromState && typeof mod.saveCompatibilityError === 'function') {
      return mod.saveCompatibilityError(record.session.state)
    }
    if (typeof mod.resourceVersion === 'function') {
      const current = await modResourceVersion(mod)
      if (record.resourceVersion !== current) return '资源版本不兼容'
    }
    if (typeof mod.saveCompatibilityError === 'function') {
      const error = mod.saveCompatibilityError(record.session.state)
      if (error) return error
    }
    return null
  }

  // 存档向下兼容：Mod 实现 migrateState 时先在副本上把旧存档迁移到当前版本，再做兼容性检查。
  // 只计算结果，不写盘；真正读取或修复时由 commitMigration 备份原档并写回。
  async function prepareSnapshot(record, { force = false } = {}) {
    const mod = modById(record.session.modId)
    // 反应偏好 sidecar：读档时优先用它（比整局快照新），没有则保留快照里的副本。
    hydrateAutoPrefs(record.session)
    // 旧版本会在每条事件里保留整桌演出快照（战役后期可达几十 MB），而且历史越久越多。
    // 读取时按当前的提交策略就地压缩，让旧存档只需要升级一次就能回到正常体积；
    // 这条改动不改变状态与键顺序，只是删掉本来就不会再回放的 tableState。
    const trimmedVisuals = trimEventVisuals(record.session)
    let state = record.session.state
    let scenarioCheckpoints = record.session.scenarioCheckpoints
    let changes = trimmedVisuals ? [`压缩 ${trimmedVisuals} 条历史事件的演出快照`] : []
    if (mod && typeof mod.migrateState === 'function') {
      try {
        const migrated = mod.migrateState(state, { force })
        state = migrated.state
        changes = changes.concat(migrated.changes)
      } catch (err) {
        return { error: String(err?.message || err), state: record.session.state, scenarioCheckpoints, changes: [] }
      }
    }
    if (mod && typeof mod.migrateSessionCheckpoints === 'function') {
      const migrated = mod.migrateSessionCheckpoints({ ...record.session, state }, { force })
      scenarioCheckpoints = migrated.checkpoints
      changes = changes.concat(migrated.changes)
    }
    const checked = changes.length
      ? { ...record, session: { ...record.session, state, scenarioCheckpoints } }
      : record
    return { error: await snapshotCompatibility(checked), state, scenarioCheckpoints, changes }
  }

  // 把迁移结果写回会话：先备份原存档，再原子写入新状态；写入失败时恢复原状态。
  async function commitMigration(session, prepared) {
    if (!prepared.changes.length) return null
    const previous = session.state
    const previousCheckpoints = session.scenarioCheckpoints
    const backup = persistOn ? backupSnapshot(session.sessionId, 'pre-migrate') : null
    session.state = prepared.state
    session.scenarioCheckpoints = prepared.scenarioCheckpoints
    try { await snapshotSession(session) } catch (err) {
      session.state = previous
      session.scenarioCheckpoints = previousCheckpoints
      throw err
    }
    console.log('  [sessions] 已迁移存档 ' + session.sessionId + '：' + prepared.changes.join('；') + (backup ? '（原档备份：' + path.basename(backup) + '）' : ''))
    return backup
  }

  function localRequest(req) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false
    return !req.headers.origin || req.headers.origin === 'http://' + req.headers.host || req.headers.origin === 'https://' + req.headers.host
  }

  async function handleModApi(method, pathname, req, res, url) {
    const [, , , id, ...rest] = pathname.split('/')
    const mod = modById(id)
    if (!mod || (typeof mod.handleApi !== 'function' && typeof mod.handleLocalApi !== 'function')) return sendJson(res, 404, { ok: false, error: '未知桌游接口: ' + id })
    const modPath = rest.map(decodeURIComponent).join('/')
    // 语言上下文（docs/localization.md §8.4）：这里只解析语言、不构建 settingsSpec；
    // 新增参数全部是增量参数，旧 Mod 忽略即可。
    const localeInfo = resolveModLocale(mod, currentLocale())
    const json = String(req.headers['content-type'] || '').startsWith('application/json')
    // POST is the only writing method a cross-site form can send without a CORS preflight.
    if (typeof mod.handleLocalApi === 'function' && localRequest(req) && (method !== 'POST' || json)) {
      const body = json && method !== 'GET' && method !== 'HEAD' ? await readBody(req) : undefined
      const local = await mod.handleLocalApi({ method, path: modPath, searchParams: url.searchParams, body,
        locale: localeInfo.resolved, requestedLocale: localeInfo.requested })
      if (local) {
        if (local.status && local.status >= 400) return sendJson(res, local.status, { ok: false, error: local.error || 'not found' })
        return sendJson(res, 200, { ok: true, ...local.body })
      }
    }
    if (typeof mod.handleApi !== 'function') return sendJson(res, 404, { ok: false, error: 'not found' })
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    }
    const version = typeof mod.resourceVersion === 'function' ? await modResourceVersion(mod) : null
    const requested = requestedVersion(url)
    if (version && requested !== null && requested !== version) {
      return sendJson(res, 409, { ok: false, error: '资源版本已变化，请刷新', resourceVersion: version })
    }
    const result = await mod.handleApi({ method, path: modPath, searchParams: url.searchParams,
      locale: localeInfo.resolved, requestedLocale: localeInfo.requested })
    if (!result) return sendJson(res, 404, { ok: false, error: 'not found' })
    if (result.status && result.status >= 400) return sendJson(res, result.status, { ok: false, error: result.error || 'not found' })
    const body = JSON.stringify({ ok: true, ...(version ? { resourceVersion: version } : {}), ...result.body })
    return sendPublic(req, res, body, 'application/json; charset=utf-8', version, version ? requested : null)
  }

  // 大厅更新与游戏商店：会下载并执行代码，只允许本机页面以 JSON 调用。
  const { updater = null, store = null, onRestart = null } = updates
  store?.bindUsage(id => [...sessions.values()].some(session => session.modId === id) || onlineSession?.modId === id)

  // 商店视图：未安装的游戏只能读 registry，已安装的以 Mod 自己的 i18n 为准
  // （docs/localization.md §7.7）。store.status() 保持中立，展示名与排序在这里按当前语言处理。
  function localizeStoreView(storeView, locale) {
    if (!storeView || !Array.isArray(storeView.games)) return storeView
    const games = storeView.games.map((game) => {
      const mod = modById(game.id)
      if (mod) {
        const meta = localizeMod(mod, locale)
        return { ...game, name: meta.name || game.name, description: meta.description || game.description }
      }
      const localized = localizeStoreGame(game, locale)
      return { ...game, name: localized.name || game.name, description: localized.description || game.description }
    })
    games.sort((a, b) => Number(!a.installed) - Number(!b.installed) ||
      String(a.name).localeCompare(String(b.name), locale))
    return { ...storeView, games }
  }

  function updatesView(locale = currentLocale()) {
    const hall = updater ? updater.status() : null
    const storeView = store ? localizeStoreView(store.status(), locale) : null
    const settings = loadUpdateSettings()
    const registry = storeView?.registry
    const neverChecked = (hall && hall.mode !== 'disabled' && !hall.checkedAt) || (registry?.url && !registry.checkedAt)
    return {
      ok: true,
      hallVersion: HALL_VERSION,
      hall,
      store: storeView,
      settings,
      // 启动后的自动检查尚未完成：页面据此短间隔轮询，及时显示更新红点。
      checkPending: !!(hall?.checking || registry?.checking || (autoCheckAllowed(settings) && neverChecked)),
      restartable: !!updater?.restartable && typeof onRestart === 'function',
      restartRequired: hall?.download.state === 'ready' || !!store?.restartRequired,
    }
  }

  async function handleUpdatesApi(method, pathname, req, res) {
    if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: '更新管理仅允许本机大厅调用' })
    if (method === 'GET' && pathname === '/api/updates') return sendJson(res, 200, updatesView())
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '不支持的请求方式' })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { ok: false, error: '需要 JSON 请求' })
    const body = await readBody(req)
    const action = pathname.slice('/api/'.length)
    if (action === 'updates/check') {
      await Promise.all([updater?.check(), store?.check()])
      return sendJson(res, 200, updatesView())
    }
    if (action === 'updates/settings') {
      saveUpdateSettings(body)
      return sendJson(res, 200, updatesView())
    }
    if (action === 'updates/hall/download') {
      if (!updater) throw new Error('自动更新不可用')
      updater.download()
      return sendJson(res, 200, updatesView())
    }
    if (action === 'updates/restart') {
      if (!updater?.restartable || typeof onRestart !== 'function') throw new Error('当前环境无法自动重启，请手动关闭并重新打开大厅')
      if ([...sessions.values()].some(session => busy.has(session)) || onlineStarting) {
        return sendJson(res, 409, { ok: false, error: '有对局正在处理行动，请稍后再重启', code: 'SESSION_BUSY' })
      }
      if (online.status().room && body.force !== true) {
        return sendJson(res, 409, { ok: false, error: '重启会断开当前联机房间', code: 'ONLINE_ACTIVE' })
      }
      sendJson(res, 200, { ok: true })
      res.once('finish', () => onRestart())
      return
    }
    if (action === 'store/install' || action === 'store/uninstall') {
      if (!store) throw new Error('游戏商店不可用')
      if (typeof body.id !== 'string') throw new Error('缺少游戏 id')
      if (action === 'store/install') store.install(body.id)
      else store.uninstall(body.id)
      return sendJson(res, 200, updatesView())
    }
    return sendJson(res, 404, { ok: false, error: '未知更新操作' })
  }

  async function handleApi(method, pathname, req, res, url) {
    if (pathname === '/api/updates' || pathname.startsWith('/api/updates/') || pathname.startsWith('/api/store/')) {
      return handleUpdatesApi(method, pathname, req, res)
    }
    if (pathname.startsWith('/api/online/')) {
      const remote = req.socket.remoteAddress
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || req.headers['x-boardgame-online'] !== '1') {
        return sendJson(res, 403, { ok: false, error: '联机管理仅允许本机大厅调用' })
      }
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) {
        return sendJson(res, 403, { ok: false, error: '请求来源不匹配' })
      }
      const action = pathname.slice('/api/online/'.length)
      if (method === 'GET' && action === 'status') {
        // 强制全量：用户点击「强制同步」时绕过长轮询等待、增量/省略判定，始终下发完整会话。
        // 用于客户端自愈失败（丢过快照、界面停在旧 revision）时手动拉回权威状态；
        // 正常轮询不带该参数，行为不变。
        const forceFull = url.searchParams.get('full') === '1'
        if (!forceFull && url.searchParams.get('wait') === '1' && url.searchParams.get('instanceId') === online.status().instanceId && Number(url.searchParams.get('after')) === online.status().serial) {
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); unsubscribe(); res.off('close', done); resolve() }
            const unsubscribe = online.subscribe(done)
            const timer = setTimeout(done, 25000)
            res.once('close', done)
          })
        }
        if (!res.destroyed) {
          // P1.4：按浏览器声明补全/省略静态表（旧客户端未声明 → 完整视图，行为不变）。
          // P3.1：按 baseStamp 决定回全量 / sessionDelta / sessionOmitted（旧客户端无 baseStamp → 全量）。
          const payload = online.status()
          decorateOnlineViewPayload(payload, staticDeclaration(url, null))
          if (!forceFull) applyStatusDelta(payload, url)
          return sendJson(res, 200, payload)
        }
        return
      }
      if (method === 'GET' && action === 'direct-stream') {
        const target = url.searchParams.get('memberId')
        const unsubscribe = online.directSubscribe(target, packet => {
          if (!res.destroyed) res.write(JSON.stringify(packet) + '\n')
        })
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write('\n')
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n') }, 15000)
        heartbeat.unref()
        res.once('close', () => { clearInterval(heartbeat); unsubscribe() })
        publishOnline()
        return
      }
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '不支持的请求方式' })
      const body = await readBody(req, action === 'direct-snapshot' ? 8 * 1024 * 1024 : undefined)
      if (action === 'signal') { await online.signal(body.target, body.data); return sendJson(res, 200, { ok: true }) }
      if (action === 'direct-command') {
        const result = await online.directCommand(body.memberId, body.action, body.body)
        // P2.2：直连命令的等待者只按 revision 唤醒；把 aiPending/busy 一并带回（只增可选字段），
        // 浏览器可以立刻显示「AI 思考中」，不必等下一份快照。
        return sendJson(res, 200, { ok: true, sessionId: result.session?.sessionId,
          revision: result.session?.state.revision, eventCount: result.session?.events.length,
          ...(result.aiPending ? { aiPending: true, busy: true } : {}) })
      }
      if (action === 'direct-snapshot') return sendJson(res, 200, online.directSnapshot(body.data))
      if (action === 'load') {
        if (online.status().room || online.status().connecting) throw new Error('请先退出当前房间')
        const record = persistOn ? readSnapshot(body.sessionId) : null
        if (!record) throw new Error('指定存档不存在')
        const saved = record.session
        if (!saved.online) throw new Error('这是单人存档，请从单人存档列表读取')
        const prepared = await prepareSnapshot(record)
        if (prepared.error) throw new Error(prepared.error)
        if (!Array.isArray(saved.players) || saved.players.length < 2 || saved.players[0]?.role !== 'human' || saved.players.some((p, i) => p.seat !== i || !['human', 'ai'].includes(p.role))) throw new Error('联机存档席位信息无效')
        await commitMigration(saved, prepared)
        onlineSession = saved; onlineSettings = saved.settings || {}; onlineFillAi = false; onlineLoadPending = true; onlineOperations.clear()
        try {
          await online.open('create', { relayUrl: body.relayUrl, modId: saved.modId, capacity: saved.players.length,
            aiSeats: saved.players.filter(p => p.role === 'ai').map(p => ({ seat: p.seat, name: p.name })) }, agentConfig)
          publishOnline(); online.remember()
          const payload = online.status()
          decorateOnlineViewPayload(payload, staticDeclaration(url, null))
          return sendJson(res, 200, payload)
        } catch (error) { onlineSession = null; onlineLoadPending = false; throw error }
      }
      if (action === 'create' || action === 'join') {
        if (action === 'create') {
          if (online.status().room || online.status().connecting) throw new Error('请先退出当前房间')
          onlineSession = null; onlineLoadPending = false; onlineOperations.clear()
          onlineSharedStateCache = null
          onlineSettings = body.settings && typeof body.settings === 'object' ? body.settings : {}
          onlineFillAi = body.fillAi !== false
          if (body.aiSeats !== undefined) {
            const capacity = Number(body.capacity)
            if (!Number.isInteger(capacity) || capacity < 2 || capacity > 8) throw new Error('房间席位数量无效')
            if (!Array.isArray(body.aiSeats) || body.aiSeats.length >= capacity) throw new Error('AI 席位设置无效')
            const seen = new Set()
            const opponents = Array.from({ length: capacity - 1 }, (_, i) => onlineSettings.opponents?.[i] || null)
            body.aiSeats = body.aiSeats.map(item => {
              if (!item || !Number.isInteger(item.seat) || item.seat <= 0 || item.seat >= capacity || seen.has(item.seat)) throw new Error('AI 席位设置无效')
              seen.add(item.seat)
              const ai = item.aiId == null ? randomAi() : ais.find(ai => ai.id === item.aiId)
              if (!ai) throw new Error('选择的 AI 已不存在，请重新选择')
              opponents[item.seat - 1] = ai.id
              return { seat: item.seat, name: ai.name }
            })
            onlineSettings = { ...onlineSettings, opponents }
            onlineFillAi = false
          }
        }
        {
          const payload = await online.open(action, body, agentConfig)
          decorateOnlineViewPayload(payload, staticDeclaration(url, null))
          return sendJson(res, 200, payload)
        }
      }
      if (action === 'ready') {
        await online.ready(body.ready === true)
        const payload = online.status()
        decorateOnlineViewPayload(payload, staticDeclaration(url, null))
        return sendJson(res, 200, payload)
      }
      if (action === 'leave') {
        if (online.me()?.host && (onlineStarting || (onlineSession && busy.has(onlineSession)))) throw new Error('请等待当前行动完成后再解散房间')
        const result = await online.leave(); onlineSession = null; onlineLoadPending = false; onlineOperations.clear(); onlineSharedStateCache = null
        return sendJson(res, 200, result)
      }
      if (action === 'command') {
        try {
          const result = await online.command(body.action, body.body)
          // P1.4：房主浏览器的命令响应按 body.client.staticVersion 决定省略/补发静态表；
          // 客人 slim 摘要与旧客户端全量视图保持原样。
          decorateOnlineViewPayload(result, staticDeclaration(url, body.body))
          return sendJson(res, 200, result)
        } catch (err) {
          // P2.2：把 SESSION_BUSY 等稳定错误码带给机器可读的客户端（旧客户端只看 error 文本）。
          const status = Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400
          return sendJson(res, status, { ok: false, error: String(err?.message || err), ...(err?.code ? { code: err.code } : {}) })
        }
      }
      return sendJson(res, 404, { ok: false, error: '未知联机操作' })
    }
    const route = method + ' ' + pathname
    if (pathname.startsWith('/api/mods/')) return handleModApi(method, pathname, req, res, url)

    if (route === 'GET /api/catalog') {
      return sendJson(res, 200, { ok: true, games: catalogView() })
    }

    if (route === 'GET /api/session') {
      const ids = url.searchParams.getAll('sessionId')
      if (ids.length !== 1 || !ids[0]) return sendJson(res, 400, { ok: false, error: '需要唯一的对局编号' })
      let session = sessions.get(ids[0])
      if (!session && persistOn) {
        const record = readSnapshot(ids[0])
        if (record) {
          try { session = await restoreStoredSession(record) }
          catch { session = null }
        }
      }
      if (!session) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      return sendJson(res, 200, { ok: true, busy: busy.has(session), session: sessionView(session) })
    }

    if (route === 'GET /api/ais') {
      return sendJson(res, 200, { ok: true, ais: ais.slice() })
    }

    if (route === 'GET /api/config') {
      return sendJson(res, 200, Object.assign({ ok: true }, configView()))
    }

    // 大厅偏好（docs/localization.md §5.2）：
    //   GET  返回设置 + 可选语言列表；
    //   POST { locale } 立即落盘并返回与 GET 相同的结构（前端一次更新状态）。
    // 只改本机偏好，不下载/执行代码，不需要像 /api/updates/* 那样限制本机；
    // 仍是同源 JSON 接口，沿用 readBody 校验。无需重启，只影响之后创建的会话和接下来的渲染。
    if (route === 'GET /api/settings') {
      return sendJson(res, 200, settingsView())
    }

    if (route === 'POST /api/settings') {
      let body
      try {
        body = await readBody(req)
      } catch {
        return sendJson(res, 400, { ok: false, code: 'INVALID_SETTINGS', error: '设置必须是 JSON 对象' })
      }
      try {
        saveSettings(body)
        return sendJson(res, 200, settingsView())
      } catch (err) {
        const status = Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500
        return sendJson(res, status, { ok: false, code: err?.code || 'SETTINGS_WRITE_FAILED', error: String(err?.message || err) })
      }
    }

    // 决策指标（只读）：调用次数、非法率、兜底率、平均提示词长度与耗时、每回合步数。
    // ?reset=1 清零进程内计数（不删除 decisions.jsonl 历史日志）。
    if (route === 'GET /api/agent-stats') {
      if (url.searchParams.get('reset') === '1') resetStats()
      return sendJson(res, 200, Object.assign({ ok: true }, statsSnapshot()))
    }

    // —— 战术讨论：公开桌聊（to=null）+ 私聊（to=座位号）——
    // 关键：不创建 AI 回合上下文、不消耗 maxTurnCalls、不产生 move、不推进 revision。
    // 公开桌聊支持定向发言：@某人 → 只有这些 AI 回复；@全体 → 所有 AI 回复；
    // 支持 / 指令（/备忘、/清除备忘、/help），指令不调用模型。
    // 阈值：上一条回复还在生成、或距上次回复开始不足 chatReplyCooldownMs 时，
    // 新发言只落库、不再排队回复（返回 chat.skipped），避免连续发言把模型调用堆起来。
    if (route === 'POST /api/chat') {
      const body = await readBody(req)
      const session = sessions.get(body.sessionId)
      if (!session) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      if (!agentConfig.chatEnabled) return sendJson(res, 404, { ok: false, error: '聊天功能已关闭', code: 'CHAT_DISABLED' })
      const runtime = chatRuntimeOf(session)
      // 允许「AI 正在回复上一条」时继续发言（只记录、不排队）；其余忙碌场景仍然拒绝。
      const chatOnly = busy.has(session) && runtime.inflight > 0
      if (busy.has(session) && !chatOnly) return sendMoveError(res, session, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      const text = clampChatText(body.text, agentConfig.chatMaxChars)
      if (!text) return sendJson(res, 400, { ok: false, error: '发言内容为空' })
      const to = body.to === null || body.to === undefined || body.to === '' ? null : Number(body.to)
      if (to !== null && (!Number.isSafeInteger(to) || !session.players.some((p) => p.seat === to && p.role === 'ai'))) {
        return sendJson(res, 400, { ok: false, error: '无效的私聊对象', code: 'INVALID_TARGET' })
      }

      if (!chatOnly) busy.add(session)
      try {
        const chat = await runChatTurn(session, 0, text, to, { online: false })
        await finishChat(session, chat)
        await snapshotSession(session)
        return sendJson(res, 200, { ok: true, session: sessionView(session), chat })
      } finally {
        if (!chatOnly) busy.delete(session)
      }
    }

    // —— 战术备忘管理：手动钉住 / 编辑 / 删除 / 清空 ——
    if (route === 'POST /api/notes/add' || route === 'POST /api/notes/update' || route === 'POST /api/notes/delete' || route === 'POST /api/notes/clear') {
      const body = await readBody(req)
      const session = sessions.get(body.sessionId)
      if (!session) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      if (busy.has(session)) return sendMoveError(res, session, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      if (!Array.isArray(session.notes)) session.notes = []

      if (route === 'POST /api/notes/clear') {
        session.notes = []
      } else if (route === 'POST /api/notes/delete') {
        session.notes = session.notes.filter((note) => !note || note.id !== body.noteId)
      } else if (route === 'POST /api/notes/update') {
        const text = clampNoteText(body.text)
        const note = session.notes.find((item) => item && item.id === body.noteId)
        if (!text || !note) return sendJson(res, 400, { ok: false, error: '备忘不存在或内容为空' })
        note.text = text
        note.updatedAt = Date.now()
        note.edited = true
      } else {
        const text = clampNoteText(body.text)
        if (!text) return sendJson(res, 400, { ok: false, error: '内容为空' })
        const to = body.to === null || body.to === undefined || body.to === '' ? null : Number(body.to)
        if (to !== null && (!Number.isSafeInteger(to) || !session.players.some((p) => p.seat === to && p.role === 'ai'))) {
          return sendJson(res, 400, { ok: false, error: '无效的私聊对象', code: 'INVALID_TARGET' })
        }
        const merged = mergeNotes(session.notes, { add: [text] }, {
          scope: to === null ? 'team' : 'seat',
          seat: to,
          evidence: Number.isInteger(body.evidence) ? body.evidence : null,
          origin: 'manual',
          now: Date.now(),
        })
        session.notes = merged.notes
      }

      const compact = await agent.compactNotes(session)
      session.notes = compact.notes
      await snapshotSession(session)
      return sendJson(res, 200, { ok: true, session: sessionView(session) })
    }

    // 对局存档：只读列表 + 删除。用于排查"重启后为什么没恢复"以及清理旧局。
    if (route === 'GET /api/sessions') {
      const snapshots = persistOn ? readSnapshots() : []
      const summaries = await Promise.all(snapshots.map(async record => {
        const session = record.session
        const state = session.state || {}
        const { error: compatibilityError, changes } = await prepareSnapshot(record)
        return {
          ...modById(session.modId)?.saveSummary?.(state),
          sessionId: session.sessionId, modId: session.modId, modName: session.modName || null,
          savedAt: record.savedAt, resourceVersion: record.resourceVersion,
          revision: state.revision ?? null, status: state.status ?? null,
          compatible: !compatibilityError, compatibilityError,
          needsMigration: !compatibilityError && changes.length > 0,
          migrationChanges: compatibilityError ? [] : changes,
          playerCount: session.players?.length || 0,
          mode: session.online ? 'online' : 'solo', online: !!session.online,
          humanCount: session.players?.filter(p => p.role === 'human').length || 0,
          aiCount: session.players?.filter(p => p.role === 'ai').length || 0,
        }
      }))
      return sendJson(res, 200, {
        ok: true,
        persist: persistOn,
        dir: sessionsDir(),
        sessions: summaries,
      })
    }

    if (route === 'POST /api/session/load') {
      const body = await readBody(req)
      const active = sessions.get(body.sessionId)
      if (active && busy.has(active)) return sendMoveError(res, active, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      const record = persistOn ? readSnapshot(body.sessionId) : null
      if (!record) return sendJson(res, 404, { ok: false, error: '指定存档不存在' })
      const prepared = await prepareSnapshot(record)
      if (prepared.error) return sendJson(res, 409, { ok: false, error: prepared.error, code: 'SAVE_INCOMPATIBLE' })
      const session = record.session
      if (session.online) return sendJson(res, 409, { ok: false, code: 'ONLINE_SAVE', error: '这是联机存档，请选择“创建房间继续”并邀请玩家加入' })
      try { await commitMigration(session, prepared) } catch (err) { return sendMoveError(res, session, err) }
      sessions.set(session.sessionId, session)
      return sendJson(res, 200, { ok: true, session: sessionView(session), migrationChanges: prepared.changes })
    }

    // 修复存档：把旧存档迁移到当前版本并写回（先备份原档），不激活对局。
    // force=true 时版本一致也重新刷新内嵌资源、补齐缺失字段并做续玩校验。
    if (route === 'POST /api/session/repair') {
      const body = await readBody(req)
      const active = sessions.get(body.sessionId)
      if (active && busy.has(active)) return sendMoveError(res, active, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      const stored = persistOn ? readSnapshot(body.sessionId) : null
      const target = active || stored?.session
      if (!target) return sendJson(res, 404, { ok: false, error: '指定存档不存在' })
      if (typeof modById(target.modId)?.migrateState !== 'function') return sendJson(res, 400, { ok: false, error: '该桌游不支持存档修复', code: 'REPAIR_UNSUPPORTED' })
      const prepared = await prepareSnapshot({ ...stored, session: target }, { force: body.force === true })
      if (prepared.error) return sendJson(res, 409, { ok: false, error: prepared.error, code: 'SAVE_INCOMPATIBLE' })
      let backup
      try { backup = await commitMigration(target, prepared) } catch (err) { return sendMoveError(res, target, err) }
      return sendJson(res, 200, { ok: true, sessionId: target.sessionId, repaired: prepared.changes.length > 0,
        changes: prepared.changes, backup: backup ? path.basename(backup) : null })
    }

    if (route === 'POST /api/session/delete') {
      const body = await readBody(req)
      const active = sessions.get(body.sessionId)
      const stored = persistOn ? readSnapshot(body.sessionId) : null
      const target = active || stored?.session
      const policy = getSessionPolicy(modById(target?.modId), target?.state)
      if (policy.confirmDelete && body.confirm !== true) {
        return sendJson(res, 400, { ok: false, error: '删除此存档需要二次确认', code: 'CONFIRM_REQUIRED' })
      }
      const removed = deleteSnapshot(body.sessionId)
      if (active && policy.detachOnDelete) active.saveDetached = true
      else sessions.delete(body.sessionId)
      return sendJson(res, 200, { ok: true, removed })
    }

    if (route === 'POST /api/session/save' || route === 'POST /api/session/save-as') {
      const body = await readBody(req)
      const session = sessions.get(body.sessionId)
      if (!session || !getSessionPolicy(modById(session.modId), session.state).manualSave) return sendJson(res, 404, { ok: false, error: '可手动保存的会话不存在' })
      if (busy.has(session)) return sendMoveError(res, session, moveError('对局正在处理行动', 409, 'SESSION_BUSY'))
      if (route === 'POST /api/session/save-as') {
        if (!session.saveDetached) return sendJson(res, 400, { ok: false, error: '当前存档仍存在' })
        const oldId = session.sessionId
        session.sessionId = 'bg-' + (++seq) + '-' + Date.now().toString(36)
        session.saveDetached = false
        try { await snapshotSession(session) } catch (err) {
          session.sessionId = oldId
          session.saveDetached = true
          return sendMoveError(res, session, err)
        }
        sessions.delete(oldId)
        sessions.set(session.sessionId, session)
      } else {
        try { await snapshotSession(session) } catch (err) { return sendMoveError(res, session, err) }
      }
      return sendJson(res, 200, { ok: true, session: sessionView(session) })
    }

    if (route === 'POST /api/session/fork-checkpoint') {
      const body = await readBody(req)
      const source = sessions.get(body.sessionId)
      if (!source) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      if (busy.has(source)) return sendMoveError(res, source, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      const mod = modById(source.modId)
      if (typeof mod?.forkSessionCheckpoint !== 'function') {
        return sendJson(res, 400, { ok: false, error: '该桌游不支持关卡回溯', code: 'CHECKPOINT_UNSUPPORTED' })
      }
      if (source.online) {
        return sendJson(res, 409, { ok: false, error: '联机对局暂不能直接切换到分支存档，请先从单机存档读取', code: 'ONLINE_CHECKPOINT_UNSUPPORTED' })
      }
      if (body.confirm !== true) {
        return sendJson(res, 400, { ok: false, error: '重新开始关卡需要二次确认', code: 'CONFIRM_REQUIRED' })
      }
      busy.add(source)
      try {
        const revision = expectedRevision(body)
        if (revision === undefined || revision !== source.state.revision) {
          throw moveError('对局版本已变化，请刷新后重试', 409, 'STALE_REVISION')
        }
        const seat = Number(body.seat)
        if (!Number.isInteger(seat) || source.players.find(player => player.seat === seat)?.role !== 'human') {
          throw moveError('只有真人玩家可以创建关卡分支', 403, 'HUMAN_REQUIRED')
        }
        const nextRevision = source.state.revision + 1
        if (!Number.isSafeInteger(nextRevision)) throw moveError('对局版本号已达上限')
        const branchId = 'bg-' + (++seq) + '-' + Date.now().toString(36)
        const branch = mod.forkSessionCheckpoint(source, body.checkpointId, {
          sessionId: branchId,
          revision: nextRevision,
          seat,
        })
        sessions.set(branch.sessionId, branch)
        try { await snapshotSession(branch) } catch (error) {
          sessions.delete(branch.sessionId)
          throw error
        }
        return sendJson(res, 200, { ok: true, sourceSessionId: source.sessionId, session: sessionView(branch, seat) })
      } catch (error) {
        return sendMoveError(res, source, error)
      } finally {
        busy.delete(source)
      }
    }

    if (route === 'POST /api/ais') {
      const body = await readBody(req)
      const ai = normalizeAi(body.ai)
      if (!ai.id) ai.id = newAiId()
      const i = ais.findIndex((a) => a.id === ai.id)
      if (i >= 0) ais[i] = ai
      else ais.push(ai)
      saveAis(ais)
      return sendJson(res, 200, { ok: true, ais: ais.slice(), saved: ai })
    }

    if (route === 'POST /api/ais/delete') {
      const body = await readBody(req)
      ais = ais.filter((a) => a.id !== body.id)
      saveAis(ais)
      return sendJson(res, 200, { ok: true, ais: ais.slice() })
    }

    if (route === 'POST /api/start') {
      const body = await readBody(req)
      const mod = modById(body.modId)
      if (!mod) return sendJson(res, 200, { ok: false, error: '未知桌游：' + body.modId })
      const settings = body.settings || {}
      const err = validateSettings(mod, settings)
      if (err) return sendJson(res, 200, { ok: false, error: err })
      const session = await createSession(mod, settings)
      sessions.set(session.sessionId, session)
      try { await snapshotSession(session) } catch (err) { return sendMoveError(res, session, err) }
      return sendJson(res, 200, { ok: true, session: sessionView(session) })
    }

    if (route === 'POST /api/ai/retry') {
      const body = await readBody(req)
      const session = sessions.get(body.sessionId)
      if (!session) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      if (busy.has(session)) return sendMoveError(res, session, moveError('AI 正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      busy.add(session)
      try {
        const revision = expectedRevision(body)
        if (revision === undefined || revision !== session.state.revision) throw moveError('对局版本已变化，请刷新后重试', 409, 'STALE_REVISION')
        if (session.saveDetached) throw moveError('当前存档已删除，请先另存为新存档', 409, 'SAVE_DELETED')
        if (session.state.status !== 'playing') throw moveError('对局已结束', 409, 'GAME_OVER')
        if (nextAiSeat(modById(session.modId), session) === null) throw moveError('当前需要玩家行动', 403, 'WRONG_SEAT')
        await runAiTurns(session)
        await snapshotSession(session)
        return sendJson(res, 200, { ok: true, session: sessionView(session) })
      } catch (err) {
        return sendMoveError(res, session, err)
      } finally {
        busy.delete(session)
      }
    }

    if (route === 'POST /api/prefs') {
      const body = await readBody(req)
      const session = sessions.get(body.sessionId)
      if (!session) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      const seat = Number.isInteger(body.seat) ? body.seat
        : session.players.find(player => player.role === 'human')?.seat
      if (!Number.isInteger(seat) || session.players[seat]?.role !== 'human') {
        return sendJson(res, 403, { ok: false, error: '该席位不可操作' })
      }
      let states = normalizeAutoReactionStates(body.states)
      if (!states) {
        const codes = normalizeAutoPassCodes(body.codes)
        if (!codes) return sendJson(res, 400, { ok: false, error: '反应偏好格式无效' })
        states = legacyAutoPassStates(codes)
      }
      const accepted = rememberAutoReactionStates(session, seat, states, normalizeAutoPassSeq(body.seq))
      return sendJson(res, 200, { ok: true, accepted, stale: !accepted,
        autoPrefs: autoReactionViewFor(session, seat) })
    }

    if (route === 'POST /api/move') {
      const body = await readBody(req)
      const s = sessions.get(body.sessionId)
      if (!s) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      if (busy.has(s)) return sendMoveError(res, s, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      busy.add(s)
      try {
        const mod = modById(s.modId)
        const revision = expectedRevision(body)
        if (getSessionPolicy(mod, s.state).requireRevision && revision === undefined) {
          throw moveError('此对局操作必须携带当前版本号', 400, 'INVALID_REVISION')
        }
        if (s.saveDetached) throw moveError('当前存档已删除，请先另存为新存档', 409, 'SAVE_DELETED')
        if (s.state.status !== 'playing') throw moveError('对局已结束', 409, 'GAME_OVER')
        const acting = getActingSeats(mod, s.state)
        const primary = getDecisionSeat(mod, s.state)
        const seat = Object.hasOwn(body, 'seat') ? body.seat
          : [primary, ...acting].find(item => acting.includes(item) && s.players[item]?.role === 'human')
        if (!acting.includes(seat) || s.players[seat]?.role !== 'human') {
          throw moveError('现在不是你的应答时机', 403, 'WRONG_SEAT')
        }
        // 单机同样由本机大厅代答：本命令携带的三态覆盖先写入会话，再提交动作，
        // 最后在发布前把该座位的 auto/skip 窗口结算掉。
        const autoPrefsPayload = autoReactionPayloadOf(body)
        if (autoPrefsPayload) {
          rememberAutoReactionStates(s, seat, autoPrefsPayload.states, autoPrefsPayload.seq)
        } else {
          const legacyAutoPass = autoPassPayloadOf(body)
          if (legacyAutoPass) rememberAutoReactionStates(s, seat, legacyAutoPassStates(legacyAutoPass.codes), legacyAutoPass.seq)
        }
        const receipt = commitMove(s, seat, body.move, revision ?? s.state.revision)
        settleAutoChoices(s)
        await runAgentReactions(s, receipt)
        if (getSessionPolicy(modById(s.modId), s.state).saveBeforeAi) await snapshotSession(s)
        await runAiTurns(s)
        await snapshotSession(s)
        return sendJson(res, 200, { ok: true, session: sessionView(s) })
      } catch (err) {
        return sendMoveError(res, s, err)
      } finally {
        busy.delete(s)
      }
    }

    if (route === 'POST /api/reset') {
      const body = await readBody(req)
      const old = sessions.get(body.sessionId)
      if (!old) return sendJson(res, 404, { ok: false, error: '对局不存在' })
      if (busy.has(old)) return sendMoveError(res, old, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      busy.add(old)
      try {
        const mod = modById(old.modId)
        const fresh = await createSession(mod, old.settings, old.state.revision + 1)
        fresh.sessionId = old.sessionId
        // 重开一局 = 覆盖结束：清掉旧 sidecar，避免下次读档把上一局的开关带回来。
        if (persistOn) deletePrefs(old.sessionId)
        sessions.set(old.sessionId, fresh)
        await snapshotSession(fresh)
        return sendJson(res, 200, { ok: true, session: sessionView(fresh) })
      } finally {
        busy.delete(old)
      }
    }

    if (route === 'POST /api/leave') {
      const body = await readBody(req)
      const session = sessions.get(body.sessionId)
      if (session && busy.has(session)) return sendMoveError(res, session, moveError('对局正在处理行动，请稍后重试', 409, 'SESSION_BUSY'))
      if (session && getSessionPolicy(modById(session.modId), session.state).retainOnLeave) {
        return sendJson(res, 200, { ok: true })
      }
      sessions.delete(body.sessionId)
      if (persistOn) deleteSnapshot(body.sessionId)
      return sendJson(res, 200, { ok: true })
    }

    // —— 模型连接配置（写入 boardgame.config.json，环境变量优先级更高）——
    if (route === 'POST /api/config') {
      const body = await readBody(req)
      try {
        const patch = {}
        if (Object.hasOwn(body, 'playerAvatar')) patch.playerAvatar = body.playerAvatar
        if (Object.hasOwn(body, 'playerName') && typeof body.playerName !== 'string') {
          return sendJson(res, 400, { ok: false, error: '玩家名称必须是文字' })
        }
        for (const key of ['baseUrl', 'model', 'apiKey', 'jsonMode', 'reasoningEffort', 'playerName']) {
          if (typeof body[key] === 'string') patch[key] = body[key]
        }
        for (const key of [
          'temperature', 'topP', 'maxRetries', 'timeoutMs', 'maxTokens', 'maxTokensCeiling', 'reasoningRetries', 'maxTurnCalls',
          'turnTimeoutMs', 'maxPromptTokens', 'memorySteps', 'chatNotesMax', 'chatMaxChars', 'chatWindow',
          'chatReplyCooldownMs',
        ]) {
          if (body[key] === undefined || body[key] === null || body[key] === '') continue
          const value = Number(body[key])
          if (!Number.isFinite(value)) {
            return sendJson(res, 400, { ok: false, error: '参数 ' + key + ' 必须是数字' })
          }
          patch[key] = value
        }
        if (typeof body.chatEnabled === 'boolean') patch.chatEnabled = body.chatEnabled
        else if (body.chatEnabled === 'true' || body.chatEnabled === 'false') patch.chatEnabled = body.chatEnabled === 'true'
        agentConfig = saveConfig(patch)
        return sendJson(res, 200, Object.assign({ ok: true }, configView()))
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: '保存配置失败：' + String(err && err.message ? err.message : err) })
      }
    }

    if (route === 'POST /api/config/test') {
      const body = await readBody(req)
      const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : agentConfig.baseUrl
      const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : agentConfig.model
      const apiKey = typeof body.apiKey === 'string' && body.apiKey !== '' ? body.apiKey : agentConfig.apiKey
      if (!apiKey) return sendJson(res, 200, { ok: false, error: '未配置 API 密钥' })
      try {
        const test = await testConnection({ baseUrl, apiKey, model, temperature: agentConfig.temperature, timeoutMs: 20000 })
        return sendJson(res, 200, { ok: true, test })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: '连接失败：' + String(err && err.message ? err.message : err) })
      }
    }

    if (route === 'POST /api/config/models') {
      const body = await readBody(req)
      const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : agentConfig.baseUrl
      const apiKey = typeof body.apiKey === 'string' && body.apiKey !== '' ? body.apiKey : agentConfig.apiKey
      try {
        const models = await listModels({ baseUrl, apiKey, timeoutMs: 15000 })
        return sendJson(res, 200, { ok: true, models })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: '获取模型列表失败：' + String(err && err.message ? err.message : err) })
      }
    }

    return sendJson(res, 404, { ok: false, error: '未知接口: ' + route })
  }

  // P2.2：上次进程在 AI 回合中途退出时，存档里带着 pendingAi 标记。恢复联机会话后立刻在后台
  // 继续：从存档的最新 revision 往下跑（已提交的动作都在存档里，不会重复提交），每步落盘；
  // 完成/失败后清标记并落盘。写回联机状态失败时保持标记，下次启动再继续。
  function resumePendingAiAfterRestore() {
    if (!onlineSession || onlineLoadPending) return false
    if (!onlineSession.pendingAi || busy.has(onlineSession) || aiBackgroundSessions.has(onlineSession)) return false
    if (!onlineAiBackground) {
      // 回滚模式 = 旧行为：没有后台恢复，清掉标记避免之后被误判；AI 回合留待房主显式 aiRetry。
      onlineSession.pendingAi = false
      snapshotSession(onlineSession).catch(err => {
        console.warn('  [sessions] 清理 pendingAi 标记失败：' + String(err && err.message ? err.message : err))
      })
      return false
    }
    busy.add(onlineSession)
    try { publishOnline() } catch (err) {
      console.warn('  [online] 恢复 AI 回合前的状态发布失败：' + String(err && err.message ? err.message : err))
    }
    console.log('  [agent] 检测到未完成的 AI 回合（存档 revision ' + onlineSession.state.revision + '），后台继续')
    startAiBackground(onlineSession)
    return true
  }

  // 启动只预载最近的少量存档，避免大型手动存档目录阻塞 HTTP 监听。
  // 未预载的普通对局会在 GET /api/session 时按编号惰性恢复；手动存档仍由 load 接口读取。
  async function restoreSessions() {
    if (!persistOn) return []
    const restored = []
    for (const record of readSnapshots({ limit: STARTUP_RESTORE_LIMIT })) {
      const session = record.session
      try {
        const active = await restoreStoredSession(record)
        if (active) restored.push(active.sessionId)
      } catch (err) {
        if (persistOn && modById(session.modId) && !getSessionPolicy(modById(session.modId), session.state).preserveInvalid) deleteSnapshot(session.sessionId)
        console.warn('  [sessions] 丢弃存档 ' + String(session.sessionId) + '：' + String(err && err.message ? err.message : err))
      }
    }
    if (restored.length) console.log('  [sessions] ✔ 已从磁盘恢复 ' + restored.length + ' 局对战')
    return restored
  }

  async function restoreStoredSession(record) {
    const session = record.session
    const mod = modById(session.modId)
    if (!mod) throw new Error('未知桌游 ' + session.modId)
    if (!session.state || typeof session.state !== 'object' || Array.isArray(session.state)) throw new Error('缺少合法的对局状态')
    if (!Array.isArray(session.players) || !session.players.some((p) => p && p.role === 'human')) throw new Error('缺少人类座位')
    if (!Array.isArray(session.events)) session.events = []
    hydrateAutoPrefs(session)
    // 自动恢复的旧存档同样先剥掉历史演出快照；下一次落盘就是压缩后的版本。
    trimEventVisuals(session)
    // 显式读档与联机存档在真正读取时再迁移写回，自动恢复只登记普通单机对局。
    if (getSessionPolicy(mod, session.state).manualLoad || session.online) return null
    if (!mod.saveCompatibilityFromState && typeof record.resourceVersion === 'string' && typeof mod.resourceVersion === 'function') {
      let current = null
      try { current = await modResourceVersion(mod) } catch { current = null }
      if (current && current !== record.resourceVersion) throw new Error('资源版本已变化，旧存档不再兼容')
    }
    const migrated = typeof mod.migrateState === 'function' ? mod.migrateState(session.state) : { state: session.state, changes: [] }
    if (typeof mod.saveCompatibilityError === 'function') {
      const compatibilityError = mod.saveCompatibilityError(migrated.state)
      if (compatibilityError) throw new Error(compatibilityError)
    }
    await commitMigration(session, migrated)
    sessions.set(session.sessionId, session)
    return session
  }

  const server = http.createServer(async (req, res) => {
    let url
    try { url = new URL(req.url || '/', 'http://localhost') }
    catch { return sendJson(res, 400, { ok: false, error: '无效请求地址' }) }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      try {
        return await handleApi(method, pathname, req, res, url)
      } catch (err) {
        const invalid = err instanceof RangeError || err instanceof URIError
        if (pathname.startsWith('/api/mods/')) {
          return sendJson(res, invalid ? 400 : 500, { ok: false, error: invalid ? '无效请求：' + err.message : '该桌游资源暂不可用' })
        }
        return sendJson(res, 400, { ok: false, error: String(err && err.message ? err.message : err) })
      }
    }

    return serveStatic(url, req, res)
  })

  // 入口 server.js 会 await server.ready 之后再 listen，避免恢复期间的竞态。
  server.ready = restoreSessions().then(async restored => {
    if (onlineStateFile && fs.existsSync(onlineStateFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(onlineStateFile, 'utf8'))
        if (saved.room?.members?.find(m => m.id === saved.memberId)?.host) {
          if (saved.sessionId) {
            const record = readSnapshot(saved.sessionId)
            if (!record) throw new Error('联机存档不存在')
            const prepared = await prepareSnapshot(record)
            if (prepared.error) throw new Error(prepared.error)
            await commitMigration(record.session, prepared)
            onlineSession = record.session
            sessions.set(onlineSession.sessionId, onlineSession)
          }
          onlineSettings = saved.settings || {}; onlineFillAi = saved.fillAi !== false; onlineLoadPending = saved.loadPending === true
        }
        online.restore(saved)
        // P2.2：恢复联机会话后，若存档标记了未完成的 AI 回合，后台继续（不阻塞 ready）。
        resumePendingAiAfterRestore()
      } catch (err) { console.warn('  [online] 无法自动恢复联机：' + err.message) }
    }
    return restored
  })
  server.on('close', () => online.close())
  server.online = online
  return server
}
