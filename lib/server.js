// 桌游大厅 · HTTP 服务 + API + 对局进程
//
// 静态资源：public/（大厅网页）
// REST API（前缀 /api）：
//   GET  /api/catalog      桌游目录（含大厅注入的「对手 AI」座位 + 各 Mod 专属设置）
//   GET  /api/config       Agent 模型配置（model/baseUrl/hasKey，不含密钥）
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
import { persistEnabled, saveSnapshotAsync, readSnapshot, readSnapshots, deleteSnapshot, backupSnapshot, sessionsDir } from './sessions.js'
import { getActingSeats, getDecisionSeat, getSessionPolicy } from './mods.js'
import { createOnline, onlineEventHistory } from './online.js'
import { perf } from './perf.js'
import { loadUpdateSettings, saveUpdateSettings, autoCheckAllowed } from './update-common.js'
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
const OPPONENTS_SPEC = {
  key: 'opponents',
  type: 'aiList',
  label: '对手 AI',
  description: '由 AI 扮演的对家（从 AI 列表中选择）',
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

  const modById = (id) => mods.find((m) => m.id === id)

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
  const savedFingerprints = new WeakMap()
  const saveFingerprint = session => [
    session.state?.revision ?? -1,
    session.events?.length ?? 0,
    (Array.isArray(session.notes) ? session.notes : []).map(note => note?.text || '').join('\u0000'),
    session.saveDetached ? 1 : 0,
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
        publishOnline()
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

  function catalogView() {
    return mods.map((m) => ({
      id: m.id,
      name: m.name,
      nameEn: m.nameEn || '',
      players: m.players,
      seats: m.seats || m.players[1] || 2,
      cover: m.cover || '',
      coverEmoji: m.coverEmoji || '🎲',
      description: m.description || '',
      tags: m.tags || [],
      settingsSpec: (m.hideOpponentSettings ? [] : [Object.assign({}, OPPONENTS_SPEC, {
        label: m.aiSlotLabel || OPPONENTS_SPEC.label,
        description: m.aiSlotDescription || OPPONENTS_SPEC.description,
      })]).concat(m.settingsSpec || []),
      defaults: Object.assign({ opponents: [null] }, m.defaults || {}),
      render: m.render || { kind: 'board', size: 15, pieceStyle: 'stone' },
      clientData: m.clientData || null,
      // Mod 自带的浏览器模块／样式（相对 URL）；大厅不关心其内容，只告诉前端去哪取。
      web: m.web ? { client: m.web.clientUrl || null, styles: m.web.stylesUrl || null, mount: m.web.mount } : null,
      api: typeof m.handleApi === 'function' ? '/api/mods/' + m.id : null,
      version: m.package?.version || null,
    }))
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

  function sessionView(session, observerSeat) {
    const endPerf = perf.span('sessionView', { seat: observerSeat ?? null, online: !!session.online, eventCount: session.events?.length ?? 0 })
    const mod = modById(session.modId)
    const seat = observerSeat ?? session.players.find(player => player.role === 'human')?.seat
    const hasObserver = Number.isInteger(seat)
    const state = hasObserver && typeof mod.viewState === 'function' ? mod.viewState(structuredClone(session.state), seat) : session.state
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.then === 'function') {
      throw new TypeError('观察者状态必须是同步返回的对象')
    }
    // 先按大厅规则遮蔽私聊（私聊只对目标座位与人类可见），再叠加 Mod 自己的事件投影。
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
        render: session.render, players: session.players, settings: {}, online: true,
        saveError: session.saveError, saveDetached: session.saveDetached,
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
      session.saveError || '',
      session.saveDetached ? 1 : 0,
    ].join('|')
  }

  function cachedSessionView(session, seat) {
    if (session !== onlineSession) return sessionView(session, seat)
    const key = onlineViewKey(session)
    if (onlineViewCache?.key !== key) onlineViewCache = { key, views: new Map() }
    let value = onlineViewCache.views.get(seat)
    if (value) { perf.record('view.cache', { hit: true, seat }); return value }
    const endPerf = perf.span('view.build', { seat })
    value = sessionView(session, seat)
    onlineViewCache.views.set(seat, value)
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

  async function runAiTurnsInner(session) {
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
        publishAgentActionSpeech(session, receipt, outcome.speech || '')
        await runAgentReactions(session, receipt)
        if (mod.agentPlanning) {
          session.events.push({ seq: session.events.length, type: 'agentDecision', seat,
            action: outcome.move.action, fallback: !!outcome.fallback, refined: !!outcome.refined,
            reason: outcome.reason || 'model', attempts: outcome.attempts })
          await snapshotSession(session)
        }

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
    } finally {
      // 无论正常结束还是抛错，都要结算当前回合，统计才不会丢。
      closeTurn()
    }
  }

  // AI 回合是「一次行动」里最不可控的一段（模型延迟 + 多次提交/发布），单独记一条
  // 总耗时；未开埋点时只是空函数，不改变原有异常传播。
  async function runAiTurns(session) {
    const endPerf = perf.span('runAiTurns', { revision: session.state?.revision, seats: session.players?.length ?? 0 })
    try { return await runAiTurnsInner(session) } finally { endPerf() }
  }

  async function createSession(mod, settings, revision = 0, onlinePlayers = null) {
    const players = onlinePlayers || buildPlayers(mod, settings)
    const state = mod.createState(settings, players)
    state.revision = revision
    const session = {
      sessionId: 'bg-' + (++seq) + '-' + Date.now().toString(36),
      modId: mod.id,
      modName: mod.name,
      render: mod.render || {},
      players,
      state,
      settings,
      events: [],
      notes: [],
      scenarioCheckpoints: [],
    }
    // 若 AI 先手，则直接替 AI 走完回合（含开场台词）。
    if (!onlinePlayers) await runAiTurns(session)
    return session
  }

  function publishOnline() {
    if (!onlineSession || !online?.me()?.host) return
    const status = online.status()
    const room = status.room
    if (!room) return
    const endPerf = perf.span('publishOnline')
    const lobby = onlineLoadPending ? { savedGame: true, modName: onlineSession.modName,
      revision: onlineSession.state.revision, players: onlineSession.players.map(({ seat, role, name }) => ({ seat, role, name })) } : null
    const busyNow = busy.has(onlineSession)
    let onlineMembers = 0, published = 0, skipped = 0
    for (const member of room.members) {
      // 离线成员收不到快照，为它构建个人视图是纯浪费。
      if (!member.online) continue
      onlineMembers++
      const value = onlineLoadPending ? null : cachedSessionView(onlineSession, member.seat)
      // 同一次行动里同一个 revision 会被推送好几遍（提交后、每个 AI 动作后、finally、
      // 房间广播）：内容没变时直接跳过，连 deep copy 和 diff 都不用做。
      const previous = onlinePublishedViews.get(member.id)
      if (previous && previous.view === value && previous.busy === busyNow
          && previous.lobby === lobby && previous.online === member.online) { skipped++; continue }
      online.publish(member, value, busyNow, lobby)
      onlinePublishedViews.set(member.id, { view: value, busy: busyNow, lobby, online: member.online })
      published++
    }
    // 房间换过、成员离开后，旧成员的表项不该一直留着（每个表项都握着一份视图）。
    if (onlinePublishedViews.size > room.members.length) {
      const ids = new Set(room.members.map(member => member.id))
      for (const id of onlinePublishedViews.keys()) if (!ids.has(id)) onlinePublishedViews.delete(id)
    }
    endPerf({ seats: room.members.length, onlineSeats: onlineMembers, published, skipped,
      revision: onlineSession?.state?.revision ?? null, busy: busyNow, lobby: !!lobby })
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

  async function onlineCommandInner(message) {
    const { action, memberId, seat } = message
    const body = message.body || {}
    const room = online.status().room
    const member = room?.members.find(m => m.id === memberId && m.seat === seat)
    if (!member) throw new Error('你不在这个房间中')
    if (action === 'sync') { online.resetSnapshots(); onlinePublishedViews.clear(); publishOnline(); return { ok: true, session: onlineSession && !onlineLoadPending ? cachedSessionView(onlineSession, seat) : null } }
    if (['start', 'reset', 'save', 'aiRetry'].includes(action) && !member.host) throw new Error('此操作仅房主可用')
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
          try { await snapshotSession(onlineSession); await runAiTurns(onlineSession); await snapshotSession(onlineSession) }
          finally { busy.delete(onlineSession); publishOnline() }
          return { ok: true, session: cachedSessionView(onlineSession, seat) }
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
        try { await snapshotSession(onlineSession); await runAiTurns(onlineSession); await snapshotSession(onlineSession) }
        finally { busy.delete(onlineSession); publishOnline() }
        return { ok: true, session: cachedSessionView(onlineSession, seat) }
      } catch (err) {
        await online.phase(onlineSession && !onlineLoadPending ? 'playing' : 'waiting').catch(() => {})
        throw err
      } finally { onlineStarting = false }
    }
    const s = onlineSession
    if (onlineLoadPending || room.phase !== 'playing') throw new Error('请等待玩家入座并由房主继续对局')
    if (!s) throw new Error('请先开始游戏')
    // 讨论可以叠加（新发言只落库、不排队回复）；其余操作仍然串行。
    const chatOnly = action === 'chat' && busy.has(s) && chatRuntimeOf(s).inflight > 0
    if (busy.has(s) && !chatOnly) throw new Error('正在处理上一操作，请稍后重试')
    if (body.sessionId && body.sessionId !== s.sessionId) throw new Error('对局已变化，请刷新')
    if (!chatOnly) busy.add(s)
    let chatResult = null
    try {
      if (action === 'move') {
        if (!Number.isInteger(body.revision)) throw new Error('行动必须携带对局版本号')
        if (s.players[seat]?.role !== 'human') throw new Error('该席位不可操作')
        // 四段分开计时，基准里能直接看出点击时间花在提交、AI 回合、快照还是发布上。
        const endCommit = perf.span('phase.commit', { seat })
        let receipt
        try {
          receipt = body.batchChoices
            ? commitChoiceBatch(s, seat, body.batchChoices, body.revision)
            : commitMove(s, seat, body.move, body.revision)
        } finally { endCommit() }
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
        return { ok: true, sourceSessionId: s.sessionId, session: sessionView(branch, seat) }
      } else if (action === 'aiRetry') {
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
      return { ok: true, session: cachedSessionView(s, seat), ...(chatResult ? { chat: chatResult } : {}) }
    } finally { if (!chatOnly) { busy.delete(s); publishOnline() } }
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
    const operationId = message.body?.operationId
    if (typeof operationId !== 'string' || operationId.length > 100) throw new Error('缺少操作编号')
    const key = message.memberId + ':' + operationId
    const fingerprint = JSON.stringify([message.action, message.body])
    const previous = onlineOperations.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('操作编号已被使用')
      return previous.result.then(data => onlineSession ? { ...data, session: cachedSessionView(onlineSession, message.seat) } : data)
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
    '.woff', '.woff2', '.ttf', '.otf', '.ogg', '.mp3', '.wav', '.m4a', '.webm', '.mp4',
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
    const json = String(req.headers['content-type'] || '').startsWith('application/json')
    // POST is the only writing method a cross-site form can send without a CORS preflight.
    if (typeof mod.handleLocalApi === 'function' && localRequest(req) && (method !== 'POST' || json)) {
      const body = json && method !== 'GET' && method !== 'HEAD' ? await readBody(req) : undefined
      const local = await mod.handleLocalApi({ method, path: modPath, searchParams: url.searchParams, body })
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
    const result = await mod.handleApi({ method, path: modPath, searchParams: url.searchParams })
    if (!result) return sendJson(res, 404, { ok: false, error: 'not found' })
    if (result.status && result.status >= 400) return sendJson(res, result.status, { ok: false, error: result.error || 'not found' })
    const body = JSON.stringify({ ok: true, ...(version ? { resourceVersion: version } : {}), ...result.body })
    return sendPublic(req, res, body, 'application/json; charset=utf-8', version, version ? requested : null)
  }

  // 大厅更新与游戏商店：会下载并执行代码，只允许本机页面以 JSON 调用。
  const { updater = null, store = null, onRestart = null } = updates
  store?.bindUsage(id => [...sessions.values()].some(session => session.modId === id) || onlineSession?.modId === id)

  function updatesView() {
    const hall = updater ? updater.status() : null
    const storeView = store ? store.status() : null
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
        if (url.searchParams.get('wait') === '1' && url.searchParams.get('instanceId') === online.status().instanceId && Number(url.searchParams.get('after')) === online.status().serial) {
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); unsubscribe(); res.off('close', done); resolve() }
            const unsubscribe = online.subscribe(done)
            const timer = setTimeout(done, 25000)
            res.once('close', done)
          })
        }
        if (!res.destroyed) return sendJson(res, 200, online.status())
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
        return sendJson(res, 200, { ok: true, sessionId: result.session?.sessionId,
          revision: result.session?.state.revision, eventCount: result.session?.events.length })
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
          return sendJson(res, 200, online.status())
        } catch (error) { onlineSession = null; onlineLoadPending = false; throw error }
      }
      if (action === 'create' || action === 'join') {
        if (action === 'create') {
          if (online.status().room || online.status().connecting) throw new Error('请先退出当前房间')
          onlineSession = null; onlineLoadPending = false; onlineOperations.clear()
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
        return sendJson(res, 200, await online.open(action, body, agentConfig))
      }
      if (action === 'ready') { await online.ready(body.ready === true); return sendJson(res, 200, online.status()) }
      if (action === 'leave') {
        if (online.me()?.host && (onlineStarting || (onlineSession && busy.has(onlineSession)))) throw new Error('请等待当前行动完成后再解散房间')
        const result = await online.leave(); onlineSession = null; onlineLoadPending = false; onlineOperations.clear()
        return sendJson(res, 200, result)
      }
      if (action === 'command') return sendJson(res, 200, await online.command(body.action, body.body))
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
        const receipt = commitMove(s, seat, body.move, revision ?? s.state.revision)
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
      } catch (err) { console.warn('  [online] 无法自动恢复联机：' + err.message) }
    }
    return restored
  })
  server.on('close', () => online.close())
  server.online = online
  return server
}
