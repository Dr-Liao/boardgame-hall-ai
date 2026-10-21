// 桌游大厅 · 浏览器端
// 纯原生 ES Module：无构建、无外部依赖，与 host 通过 /api 通信。

import { createChatNotifications, chatChannel } from './chat-notifications.js'
import { chatCompletionContext, chatFilterOptions, chatMessageKey } from './chat-compose.js'
import { createOnlineUI } from './online-ui.js'
import { createUpdatesUI } from './updates-ui.js'
import { createFeedbackUI } from './feedback-ui.js'

const root = document.getElementById('app')
const chatNotifications = createChatNotifications({
  load: id => JSON.parse(localStorage.getItem('boardgame-hall.chat-read.' + id) || 'null'),
  save: (id, cursors) => localStorage.setItem('boardgame-hall.chat-read.' + id, JSON.stringify(cursors)),
})
let chatToastTimer

// Mod 自带的浏览器模块：由 /api/catalog 下发地址，首次打开该游戏（开局、对局、读档）时才加载，
// 首页不为未打开的游戏下载任何脚本或样式。Mod 样式表只在该游戏处于当前界面时启用。
// 大厅不静态依赖任何具体桌游的代码；没有该模块时功能自动降级为通用界面。
const modUis = new Map()
const modLoading = new Map()
const modFailed = new Set()

function modUiFor(game) {
  return game ? modUis.get(game.id) || null : null
}

function modUiPending(game) {
  return !!game?.web?.client && !modUis.has(game.id) && !modFailed.has(game.id)
}

/** 返回该游戏的 UI 接口（无自带模块或加载失败时为 null）；重复调用共用同一次加载。 */
function loadModUi(game) {
  if (!modUiPending(game)) return Promise.resolve(modUiFor(game))
  if (modLoading.has(game.id)) return modLoading.get(game.id)
  let stylesLoaded = Promise.resolve()
  if (game.web.styles && !document.querySelector(`link[data-mod="${CSS.escape(game.id)}"]`)) {
    const link = h('link', { rel: 'stylesheet', href: game.web.styles, 'data-mod': game.id })
    // 样式加载失败不阻塞界面，只是缺少主题样式。
    stylesLoaded = new Promise(resolve => { link.onload = link.onerror = resolve })
    document.head.append(link)
  }
  const loading = Promise.all([import(game.web.client), stylesLoaded])
    .then(([module]) => {
      // 宿主能力：DOM 构造、大厅 API、重绘与共享应用状态。Mod 只能用这些接口接入。
      const ui = module.createUI({ h, api, render, state, game, reset, leave, beginInteraction,
        startGame, loadSavedSession, rememberSession, forgetSession, renderOnlineSetup: onlineUi.setupFields,
        // Mod 可以在自己的标题栏里放反馈入口；宿主负责弹窗本身，旧版 Mod 不调用也不受影响。
        openFeedback: () => feedbackUi.open() })
      modUis.set(game.id, ui)
      return ui
    })
    .catch(error => {
      modFailed.add(game.id)
      state.error = '加载「' + game.name + '」界面失败：' + error.message
      return null
    })
    .finally(() => { modLoading.delete(game.id); render() })
  modLoading.set(game.id, loading)
  return loading
}

// 用 media 切换而不是 disabled：Chromium 中对尚未加载完的 <link> 设 disabled 会取消下载，
// 之后再启用也不会重新请求，样式表就永远是空的。
function activateModStyles(game) {
  for (const link of document.querySelectorAll('link[data-mod]')) link.media = link.dataset.mod === game?.id ? 'all' : 'not all'
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'className') el.className = v
    else if (k === 'style' && v !== null && typeof v === 'object') {
      for (const [name, value] of Object.entries(v)) {
        if (name.startsWith('--')) el.style.setProperty(name, value)
        else el.style[name] = value
      }
    }
    else if (k === 'value') el.value = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) el.setAttribute(k, '')
    else if (v !== false && v != null) el.setAttribute(k, v)
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

function selectBox(options, value, onchange) {
  const el = h('select', { className: 'bg-select', onchange })
  for (const o of options) el.append(h('option', { value: o.value }, o.label))
  el.value = value == null ? '' : value
  return el
}

async function api(method, pathname, body) {
  if (state.online?.room && !pathname.startsWith('/online/')) {
    if (method === 'GET' && pathname.startsWith('/session?')) {
      const value = await rawApi('GET', '/online/status')
      return { ok: true, session: value.session, busy: value.busy }
    }
    const actions = {
      '/move': 'move', '/reset': 'reset', '/chat': 'chat', '/ai/retry': 'aiRetry',
      '/session/save': 'save', '/session/fork-checkpoint': 'forkCheckpoint',
    }
    if (method === 'POST' && actions[pathname]) return onlineUi.command(actions[pathname], body)
    if (pathname.startsWith('/notes/') || pathname.startsWith('/session/')) throw new Error('联机对局由房主统一管理存档与备忘')
  }
  return rawApi(method, pathname, body)
}

async function rawApi(method, pathname, body) {
  const res = await fetch('/api' + pathname, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(pathname.startsWith('/online/') ? { 'x-boardgame-online': '1' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data
  try { data = await res.json() } catch { data = { ok: false, error: '响应解析失败' } }
  if (!data || data.ok !== true) {
    const error = new Error(data?.error || ('HTTP ' + res.status))
    Object.assign(error, { status: res.status, code: data?.code, session: data?.session, revision: data?.revision })
    throw error
  }
  return data
}

// ---------------------------------------------------------------------------
// 应用状态
// ---------------------------------------------------------------------------

function isImageAvatar(value) {
  return typeof value === 'string' && (
    /^data:image\//i.test(value) ||
    /^blob:/i.test(value) ||
    /^https?:\/\//i.test(value) ||
    /^\/avatars\/[a-z0-9-]+\.webp$/i.test(value)
  )
}

function avatarContent(value) {
  if (isImageAvatar(value)) return h('img', { className: 'bg-avatar-img', src: value, alt: '' })
  return String(value == null ? '' : value)
}

function avatarLabel(value) {
  return isImageAvatar(value) ? '🖼️' : String(value == null ? '' : value)
}

function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    const looksLikeImage = file && (/^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || ''))
    if (!looksLikeImage) return reject(new Error('请选择图片文件'))
    if (file.size > 10 * 1024 * 1024) return reject(new Error('图片不能超过 10MB'))
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      try {
        const width = image.naturalWidth || image.width
        const height = image.naturalHeight || image.height
        if (!width || !height) throw new Error('无法读取图片尺寸')
        const side = Math.min(width, height)
        const size = 256
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('浏览器不支持图片处理')
        ctx.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size)
        const keepAlpha = ['image/png', 'image/webp', 'image/gif', 'image/svg+xml'].includes(file.type) || /\.(png|gif|webp|svg)$/i.test(file.name || '')
        let dataUrl = canvas.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.86)
        if (dataUrl.length > 700000) dataUrl = canvas.toDataURL('image/jpeg', 0.82)
        resolve(dataUrl)
      } catch (err) {
        reject(err)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('无法解析图片文件'))
    }
    image.src = objectUrl
  })
}

// 战术讨论抽屉的初始状态。开局/读档时也走这个工厂，避免重置时漏掉字段
// （漏掉 pendings 会让渲染抛错、界面停在"创建中…"）。
const emptyChatState = () => ({
  open: false,
  channel: 'table', // 'table' | 私聊座位号（字符串）
  draft: '',
  pendings: [],     // 已发出、等待服务端确认的玩家发言（显示在消息列表里）
  error: null,
  notice: null,
  notesOpen: false,
})

const state = {
  catalog: [],
  ais: [],
  config: null,    // agent 模型配置（来自 /api/config）
  view: 'library', // 'library' | 'game'
  setup: null,     // { game, form }
  movePending: null, // 当前请求中的动作（供 Mod 展示处理状态）
  settingsOpen: false,
  settingsTab: 'ais', // 'player' | 'ais' | 'model' | 'online' | 'stats' | 'updates'
  playerNameDraft: null,
  playerAvatarDraft: null,
  playerAvatarProcessing: false,
  playerSaving: false,
  playerResult: null,
  aiEdit: null,    // null = 列表视图；对象 = 正在编辑的 AI
  modelForm: null,   // 模型连接表单草稿（连接信息 + 高级参数）
  modelAdvancedOpen: true, // 模型连接页「高级参数」是否展开
  modelList: [],     // 从 /models 拉到的模型 id 列表
  modelResult: null, // 测试/保存结果 { ok, reply?, latencyMs?, error? }
  modelBusy: null,   // 'test' | 'models' | 'save'
  statsData: null,   // /api/agent-stats 快照
  statsBusy: false,
  statsError: null,
  chat: emptyChatState(),
  session: null,
  busy: false,
  error: null,
}

const onlineUi = createOnlineUI({ h, state, render, renderChrome: refreshOnlineBanner, request: rawApi, loadGame: loadModUi })
const updatesUi = createUpdatesUI({ h, state, render, request: rawApi, reloadCatalog })
// 反馈弹窗是 body 级 portal：挂在这里而不是 renderApp() 里，整页重绘时 iframe 不会被重建。
const feedbackUi = createFeedbackUI({ h, state, request: rawApi })

async function reloadCatalog() {
  try {
    state.catalog = (await api('GET', '/catalog')).games || []
  } catch (e) { state.error = String(e.message) }
  render()
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------

let interactionHolds = 0
let heldRenderPending = false
let compositionRelease = null

function beginInteraction() {
  interactionHolds++
  let active = true
  let timer
  const release = () => {
    if (!active) return
    active = false
    clearTimeout(timer)
    interactionHolds = Math.max(0, interactionHolds - 1)
    if (!interactionHolds && heldRenderPending) render()
  }
  // Pointer cancellation and window blur normally release sooner. This is a
  // final guard against a lost pointer leaving the application frozen.
  timer = setTimeout(release, 10000)
  return release
}

document.addEventListener('compositionstart', event => {
  if (root.contains(event.target) && !compositionRelease) compositionRelease = beginInteraction()
})
document.addEventListener('compositionend', () => {
  compositionRelease?.()
  compositionRelease = null
})

function refreshOnlineBanner() {
  const oldBanner = root.querySelector('.bg-console > .bg-online-banner')
  const nextBanner = onlineUi.banner()
  if (oldBanner && nextBanner) oldBanner.replaceWith(nextBanner)
  else if (oldBanner) oldBanner.remove()
  else if (nextBanner) root.querySelector('.bg-console')?.prepend(nextBanner)
}

function patchAppWhileChatting(nextConsole, active) {
  if (!active?.classList?.contains('bg-chat-input') || active.value !== String(state.chat.draft || '')) return false
  const oldSurface = active.closest('.bg-chat-surface')
  const oldConsole = oldSurface?.parentElement
  const nextSurface = nextConsole.querySelector('.bg-chat-surface')
  const oldDrawer = oldSurface?.querySelector('.bg-chat-drawer')
  const nextDrawer = nextSurface?.querySelector('.bg-chat-drawer')
  if (oldConsole !== root.firstElementChild || !oldDrawer || !nextDrawer || nextSurface.parentElement !== nextConsole) return false

  // Keep the focused compose subtree connected so an Arkham presentation
  // repaint cannot cancel an in-progress IME composition.
  for (const selector of ['.bg-chat-head', '.bg-chat-notes', '.bg-chat-list', '.bg-chat-status']) {
    const oldPart = oldDrawer.querySelector(selector)
    const nextPart = nextDrawer.querySelector(selector)
    if (!!oldPart !== !!nextPart) return false
    if (oldPart) oldPart.replaceWith(nextPart)
  }
  const oldToasts = oldSurface.querySelector(':scope > .bg-chat-toasts')
  const nextToasts = nextSurface.querySelector(':scope > .bg-chat-toasts')
  if (oldToasts && nextToasts) oldToasts.replaceWith(nextToasts)
  else if (oldToasts) oldToasts.remove()
  else if (nextToasts) oldSurface.insertBefore(nextToasts, oldDrawer)

  const send = oldDrawer.querySelector('.bg-chat-send')
  if (send) send.disabled = state.busy || !active.value.trim()

  const nextChildren = [...nextConsole.childNodes]
  const surfaceIndex = nextChildren.indexOf(nextSurface)
  if (surfaceIndex < 0) return false
  for (const child of [...oldConsole.childNodes]) if (child !== oldSurface) child.remove()
  for (const child of nextChildren.slice(0, surfaceIndex)) oldConsole.insertBefore(child, oldSurface)
  for (const child of nextChildren.slice(surfaceIndex + 1)) oldConsole.append(child)
  return true
}

function render(options = {}) {
  if (interactionHolds && options?.force !== true) {
    heldRenderPending = true
    return
  }
  if (options?.force === true && interactionHolds) {
    interactionHolds = 0
    compositionRelease = null
  }
  heldRenderPending = false
  onlineUi.applyPending()
  const active = document.activeElement
  const label = active?.getAttribute('aria-label')
  const interactionKey = active?.dataset?.interaction
  const focusKey = active?.dataset?.focusKey
  const selection = active?.selectionStart
  const selectionEnd = active?.selectionEnd
  const selectionDirection = active?.selectionDirection
  const modalScroll = [...root.querySelectorAll('.bg-modal')].map(el => el.scrollTop)
  const next = renderApp()
  const keptChatInput = patchAppWhileChatting(next, active)
  if (!keptChatInput) root.replaceChildren(next)
  root.querySelectorAll('.bg-modal').forEach((el, index) => { el.scrollTop = modalScroll[index] || 0 })
  const chatList = root.querySelector('.bg-chat-list')
  if (chatList) chatList.scrollTop = chatList.scrollHeight
  if (keptChatInput) return
  const dialog = [...root.querySelectorAll('[role="dialog"]')].at(-1)
  const target = interactionKey ? root.querySelector(`[data-interaction="${CSS.escape(interactionKey)}"]`)
    : focusKey ? root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)
      : label && [...root.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === label)
  const focus = target || dialog?.querySelector('button, input, select')
  focus?.focus({ preventScroll: true })
  if (selection != null && focus?.setSelectionRange) focus.setSelectionRange(selection, selectionEnd ?? selection, selectionDirection || 'none')
}

function renderApp() {
  const consoleEl = h('div', { className: 'bg-console' })
  const banner = onlineUi.banner()
  if (banner) consoleEl.append(banner)
  if (state.view === 'room') {
    const room = onlineUi.waitingRoom()
    if (room) consoleEl.append(room)
  } else if (state.view === 'library') {
    consoleEl.append(renderLibrary())
  } else if (state.session) {
    const s = state.session
    const seat = Object.hasOwn(s, 'decisionSeat') ? s.decisionSeat : s.state.currentSeat
    const retry = (s.events || []).findLast(e => e.type === 'agentRetry' && e.revision === s.state.revision)
    if (state.busy && retry) {
      consoleEl.append(h('div', { className: 'bg-game-actions', role: 'status' },
        `AI 自动重试中（${retry.attempt}/${retry.maxAttempts}），正在从当前局面继续。`))
    }
    if (!state.busy && !state.online?.busy && (!s.online || s.mySeat === 0) && !state.chat.pendings.length && s.state.status === 'playing' && s.players[seat]?.role === 'ai') {
      consoleEl.append(h('div', { className: 'bg-game-actions', role: 'status' },
        h('span', null, 'AI 等待继续，已完成的行动会保留。'),
        h('button', { className: 'bg-btn secondary', onclick: retryAi }, '继续 AI 行动')))
    }
    consoleEl.append(renderGame(state.session))
  } else {
    consoleEl.append(renderLibrary())
  }
  if (state.setup) {
    const custom = modUiFor(state.setup.game)?.renderSetupModal?.(state.setup.game)
    consoleEl.append(custom || renderSetupModal(state.setup.game))
  }
  if (state.session) {
    const panel = renderTacticalChat(state.session)
    if (panel) consoleEl.append(panel)
  }
  if (state.settingsOpen) consoleEl.append(renderSettingsModal())
  if (state.view === 'library') {
    const gameCenter = updatesUi.gameCenterModal()
    if (gameCenter) consoleEl.append(gameCenter)
  }
  const onlineModal = onlineUi.joinModal()
  if (onlineModal) consoleEl.append(onlineModal)
  const overlayGame = state.setup?.game || (state.view === 'game' && state.catalog.find(game => game.id === state.session?.modId))
  activateModStyles(overlayGame)
  for (const [id, ui] of modUis) if (id !== overlayGame?.id) ui.onDeactivate?.()
  for (const overlay of modUiFor(overlayGame)?.renderOverlays?.() || []) consoleEl.append(overlay)
  if (state.error && !state.setup) {
    consoleEl.append(h('div', { className: 'bg-toast', onclick: () => { state.error = null; render() } }, state.error))
  }
  return consoleEl
}

// ---------------------------------------------------------------------------
// 大厅
// ---------------------------------------------------------------------------

function renderLibrary() {
  const cfg = state.config || {}
  return h('div', { className: 'bg-lib' },
    h('div', { className: 'bg-head' },
      h('div', null,
        h('h1', null, '🎲 桌游大厅'),
        h('div', { className: 'bg-sub' }, '选择一款桌游，与朋友联机或与 AI 对弈')
      ),
      h('div', { className: 'bg-model-pill' + (cfg.hasKey ? '' : ' bg-model-pill-off') },
        '🧠 ' + (cfg.hasKey ? (cfg.model || '已配置') : '未配置模型') + (cfg.hasKey ? '' : '，AI 由本地引擎代替落子且不说话')
      )
    ),
    h('div', { className: 'bg-online-entry' }, onlineUi.joinButton(), updatesUi.gameCenterButton(), feedbackUi.button()),
    h('div', { className: 'bg-grid' },
      state.catalog.length === 0
        ? h('div', { className: 'bg-empty' }, '加载中…')
        : state.catalog.map(renderGameCard)
    ),
    h('button', {
      className: 'bg-settings-btn' + (updatesUi.hasHallUpdates() ? ' bg-settings-btn-dot' : ''),
      title: updatesUi.hasHallUpdates() ? '设置 · 大厅有可用更新' : '设置 · 玩家与 AI',
      onclick: () => { state.settingsOpen = true; render() },
    }, '⚙️')
  )
}

function renderGameCard(g) {
  const loading = modLoading.has(g.id)
  return h('div', { className: 'bg-card' + (loading ? ' bg-card-loading' : ''), 'aria-busy': loading ? 'true' : null, onclick: () => openSetup(g) },
    h('div', { className: 'bg-cover', style: { background: g.cover } }, h('span', null, g.coverEmoji)),
    h('div', { className: 'bg-card-meta' },
      h('div', { className: 'bg-card-name' }, g.name),
      h('div', { className: 'bg-card-players' }, loading ? '正在加载…' : '👥 ' + g.players[0] + '–' + g.players[1] + ' 人'),
      h('div', { className: 'bg-card-tags' }, (g.tags || []).map((t) => h('span', { className: 'bg-tag' }, t)))
    )
  )
}

// ---------------------------------------------------------------------------
// 开局设置
// ---------------------------------------------------------------------------

async function openSetup(game) {
  if (modUiPending(game)) {
    const loading = loadModUi(game)
    render()
    await loading
    // 加载期间玩家可能已进入其他界面。
    if (state.setup || state.view === 'room' || (state.view === 'game' && state.session)) return
  }
  const form = {}
  for (const s of game.settingsSpec) {
    if (s.type === 'aiList') form[s.key] = (game.defaults[s.key] || []).slice().map((v) => (v == null ? '__random__' : v))
    else form[s.key] = s.default != null ? s.default : game.defaults[s.key]
  }
  state.setup = { game, form }
  state.error = null
  modUiFor(game)?.onOpenSetup?.(game)
  render()
}

function renderSetupModal(game) {
  const ui = modUiFor(game)
  const fields = [...(ui?.renderSetupFields?.(game, 'before') || [])]

  for (const s of game.settingsSpec) {
    if (s.type === 'aiList' || ['playerCount', 'teammates'].includes(s.key)) continue
    if (s.type === 'select') {
      fields.push(h('div', { className: 'bg-field' },
        h('label', null, s.label),
        selectBox(s.options || [], state.setup.form[s.key], (e) => {
          state.setup.form[s.key] = e.target.value
          ui?.onSetupChange?.(s.key, state.setup.form)
          render()
        })
      ))
    }
  }
  fields.push(...(ui?.renderSetupFields?.(game, 'after') || []))

  return h('div', { className: 'bg-backdrop' },
    h('div', { className: 'bg-modal', onclick: (e) => e.stopPropagation() },
      h('h2', null, '开始游戏 · ' + game.name),
      h('p', { className: 'bg-desc' }, game.description),
      fields,
      onlineUi.setupFields(game),
      state.error ? h('div', { className: 'bg-toast', style: { position: 'static', marginBottom: '12px', transform: 'none' } }, state.error) : null,
      h('div', { className: 'bg-modal-foot' },
        h('button', { className: 'bg-btn secondary', onclick: () => { state.setup = null; state.error = null; render() } }, '取消'),
        h('button', { className: 'bg-btn', disabled: state.busy, onclick: startGame }, state.busy ? '创建中…' : '开始对局')
      )
    )
  )
}

// ---------------------------------------------------------------------------
// 对局续玩：服务端会把每局原子落盘，前端只需记住 sessionId
// ---------------------------------------------------------------------------

const SESSION_KEY = 'boardgame-hall.sessionId'

function rememberSession(id) {
  if (state.online?.room) return
  try { if (id) localStorage.setItem(SESSION_KEY, id) } catch { /* 隐私模式等场景忽略 */ }
}

function forgetSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
}

async function resumeSession() {
  let id = null
  try { id = localStorage.getItem(SESSION_KEY) } catch { return false }
  if (!id) return false
  try {
    const r = await api('GET', '/session?sessionId=' + encodeURIComponent(id))
    if (!r.session || r.busy) { forgetSession(); return false }
    if (r.session.lifecycle?.manualLoad) return false
    state.session = r.session
    state.view = 'game'
    return true
  } catch {
    // 存档已被清理、服务端未开启持久化或对局已失效：安静回到游戏库
    forgetSession()
    return false
  }
}

async function loadSavedSession(id, mode = 'solo') {
  if (mode === 'online') return onlineUi.loadSave(id)
  const r = await api('POST', '/session/load', { sessionId: id })
  state.session = r.session
  state.chat = emptyChatState()
  rememberSession(r.session.sessionId)
  state.setup = null
  state.view = 'game'
  state.error = null
  render()
  return r.session
}

async function startGame() {
  const g = state.setup.game
  const settings = {}
  for (const s of g.settingsSpec) {
    if (s.type === 'aiList') settings[s.key] = state.setup.form[s.key].map((v) => (v === '__random__' ? null : v))
    else settings[s.key] = state.setup.form[s.key]
  }
  Object.assign(settings, modUiFor(g)?.setupSettings?.(state.setup.form) || {})
  Object.assign(settings, onlineUi.setupSettings(settings))
  state.busy = true; render()
  try {
    if (state.setup.online) {
      await onlineUi.create(g, settings)
      state.error = null
      return
    }
    const r = await api('POST', '/start', { modId: g.id, settings })
    state.session = r.session
    state.chat = emptyChatState()
    rememberSession(r.session.sessionId)
    state.setup = null
    state.view = 'game'
    state.error = null
  } catch (e) { state.error = String(e.message) }
  finally { state.busy = false; render() }
}

// ---------------------------------------------------------------------------
// 设置：AI 列表 + 编辑器
// ---------------------------------------------------------------------------

function renderSettingsModal() {
  if (state.aiEdit) return renderAiEditor(state.aiEdit)
  const tab = state.settingsTab || 'ais'
  const tabBtn = (key, label) => h('button', {
    className: 'bg-tab' + (tab === key ? ' bg-tab-active' : ''),
    onclick: () => {
      state.settingsTab = key
      state.aiEdit = null
      state.modelResult = null
      if (key === 'model') initModelForm()
      if (key === 'stats') loadStats()
      if (key === 'updates') updatesUi.open()
      render()
    },
  }, label)

  return h('div', { className: 'bg-backdrop' },
    h('div', { className: 'bg-modal', onclick: (e) => e.stopPropagation() },
      h('h2', null, '⚙️ 设置'),
      h('div', { className: 'bg-tabs' },
        tabBtn('player', '👤 玩家'),
        tabBtn('ais', '🤖 AI 角色'),
        tabBtn('model', '🔌 模型连接'),
        tabBtn('online', '🌐 联机'),
        tabBtn('stats', '📊 AI 指标'),
        tabBtn('updates', '🔄 大厅更新' + (updatesUi.hasHallUpdates() ? ' •' : ''))
      ),
      tab === 'player' ? renderPlayerTab() : tab === 'online' ? onlineUi.settingsPanel() : tab === 'model' ? renderModelTab()
        : tab === 'updates' ? updatesUi.panel() : (tab === 'stats' ? renderStatsTab() : renderAiList()),
      h('div', { className: 'bg-modal-foot' },
        h('button', { className: 'bg-btn secondary', onclick: () => feedbackUi.open() }, '💬 反馈'),
        h('button', { className: 'bg-btn secondary', onclick: () => { state.settingsOpen = false; render() } }, '关闭'),
        tab === 'ais' ? h('button', { className: 'bg-btn', disabled: state.busy, onclick: createAi }, '➕ 新增 AI')
          : tab === 'stats' ? h('button', { className: 'bg-btn secondary', disabled: state.statsBusy, onclick: loadStats }, '🔄 刷新')
          : null
      )
    )
  )
}

function renderPlayerTab() {
  const avatar = state.playerAvatarDraft ?? state.config?.playerAvatar ?? '👤'
  const disabled = state.playerSaving || state.playerAvatarProcessing
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', hidden: true, disabled,
    'aria-label': '上传玩家头像', onchange: async e => {
      const file = e.target.files?.[0]
      if (!file || state.playerAvatarProcessing || state.playerSaving) return
      state.playerAvatarProcessing = true
      state.playerResult = null
      render()
      try {
        state.playerAvatarDraft = await fileToAvatar(file)
      } catch (error) {
        state.playerResult = { ok: false, text: error.message }
      } finally {
        state.playerAvatarProcessing = false
        render()
      }
    },
  })
  return h('div', null,
    h('p', { className: 'bg-desc' }, '设置你在游戏中的头像和名字，AI 也能看到并识别这个名称。'),
    h('div', { className: 'bg-avatar-edit' },
      h('span', { className: 'bg-ai-avatar bg-ai-avatar-preview', role: 'img', 'aria-label': '玩家头像预览', style: { background: '#3aa0ff' } }, avatarContent(avatar)),
      h('div', { className: 'bg-avatar-edit-body' },
        h('div', { className: 'bg-avatar-actions' },
          h('button', { type: 'button', className: 'bg-btn secondary', disabled, onclick: () => fileInput.click() }, state.playerAvatarProcessing ? '处理中…' : '上传头像'),
          h('button', { type: 'button', className: 'bg-btn secondary', disabled, onclick: () => {
            state.playerAvatarDraft = '👤'; state.playerResult = null; render()
          } }, '恢复默认'),
        ),
        h('p', { className: 'bg-field-hint' }, '支持常见图片格式，最大 10MB。图片会居中裁剪为正方形，用于游戏玩家栏与聊天头像。'),
        fileInput,
      ),
    ),
    h('div', { className: 'bg-field' },
      h('label', { for: 'player-name' }, '玩家名称'),
      h('input', {
        id: 'player-name', className: 'bg-input', type: 'text', maxlength: 32,
        value: state.playerNameDraft ?? state.config?.playerName ?? 'player',
        placeholder: 'player', disabled: state.playerSaving,
        oninput: e => { state.playerNameDraft = e.target.value; state.playerResult = null },
      }),
      h('p', { className: 'bg-field-hint' }, '最多 32 个字符，留空恢复为 player。保存后用于新开或重开的对局，已有存档保留原名称。'),
    ),
    h('p', { className: 'bg-field-hint' }, '头像与名称一起保存。新开或重开的对局使用新头像，已有存档保留原头像。'),
    h('button', { className: 'bg-btn', disabled, onclick: savePlayerProfile }, state.playerSaving ? '保存中…' : '💾 保存玩家资料'),
    state.playerResult ? h('div', { className: 'bg-model-result ' + (state.playerResult.ok ? 'ok' : 'err'), role: 'status' }, state.playerResult.text) : null,
  )
}

async function savePlayerProfile() {
  if (state.playerSaving || state.playerAvatarProcessing) return
  const playerName = state.playerNameDraft ?? state.config?.playerName ?? 'player'
  const playerAvatar = state.playerAvatarDraft ?? state.config?.playerAvatar ?? '👤'
  state.playerSaving = true
  state.playerResult = null
  render()
  try {
    state.config = await api('POST', '/config', { playerName, playerAvatar })
    state.playerNameDraft = state.config.playerName
    state.playerAvatarDraft = state.config.playerAvatar
    state.playerResult = { ok: true, text: '已保存，下一局将使用「' + state.config.playerName + '」和当前头像。' }
  } catch (error) {
    state.playerResult = { ok: false, text: error.message }
  } finally {
    state.playerSaving = false
    render()
  }
}

function renderAiList() {
  return h('div', null,
    h('p', { className: 'bg-desc' }, '编辑 AI 的「人设」。人设会作为 system prompt 注入模型，由模型据此扮演：决定落子与台词。'),
    h('div', { className: 'bg-ai-list' },
      state.ais.length === 0 ? h('div', { className: 'bg-empty' }, '还没有 AI，点击下方「新增 AI」创建。') : null,
      state.ais.map((ai) =>
        h('div', { className: 'bg-ai-card' },
          h('div', { className: 'bg-ai-row' },
            h('span', { className: 'bg-ai-avatar', style: { background: ai.color } }, avatarContent(ai.avatar)),
            h('div', { className: 'bg-ai-info' },
              h('div', { className: 'bg-ai-name' }, ai.name),
              h('div', { className: 'bg-ai-meta' }, aiMetaText(ai))
            ),
            h('div', { className: 'bg-ai-actions' },
              h('button', { className: 'bg-btn secondary', style: { padding: '5px 10px', fontSize: '12px' }, onclick: () => { state.aiEdit = ai; render() } }, '编辑'),
              h('button', { className: 'bg-btn danger', style: { padding: '5px 10px', fontSize: '12px' }, onclick: () => deleteAi(ai.id) }, '删除')
            )
          )
        )
      )
    )
  )
}

// ---------------------------------------------------------------------------
// 设置：模型连接（API 地址 / 密钥 / 模型 / 测试连接）
// ---------------------------------------------------------------------------

function numberOr(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function initModelForm() {
  if (!state.modelForm) {
    const c = state.config || {}
    state.modelForm = {
      baseUrl: c.baseUrl || 'https://api.deepseek.com/v1',
      model: c.model || 'deepseek-flash',
      apiKey: '',   // 永不预填密钥；留空 = 保持已保存的密钥
      showKey: false,
      temperature: numberOr(c.temperature, 0.7),
      topP: numberOr(c.topP, 0),
      maxRetries: numberOr(c.maxRetries, 3),
      timeoutMs: numberOr(c.timeoutMs, 60000),
      maxTokens: numberOr(c.maxTokens, 10000),
      maxTurnCalls: numberOr(c.maxTurnCalls, 24),
      jsonMode: c.jsonMode || 'auto',
      reasoningEffort: c.reasoningEffort || '',
      turnTimeoutMs: numberOr(c.turnTimeoutMs, 120000),
      maxPromptTokens: numberOr(c.maxPromptTokens, 131072),
      memorySteps: numberOr(c.memorySteps, 2),
      chatEnabled: c.chatEnabled !== false,
      chatNotesMax: numberOr(c.chatNotesMax, 12),
      chatMaxChars: numberOr(c.chatMaxChars, 500),
      chatWindow: numberOr(c.chatWindow, 8),
      chatReplyCooldownMs: numberOr(c.chatReplyCooldownMs, 4000),
    }
  }
  return state.modelForm
}

function modelPayload() {
  const f = state.modelForm || {}
  const c = state.config || {}
  const pickNumber = (key, fallback) => numberOr(f[key], numberOr(c[key], fallback))
  return {
    baseUrl: String(f.baseUrl || '').trim(),
    model: String(f.model || '').trim(),
    apiKey: String(f.apiKey || '').trim(),
    temperature: pickNumber('temperature', 0.7),
    topP: pickNumber('topP', 0),
    maxRetries: pickNumber('maxRetries', 3),
    timeoutMs: pickNumber('timeoutMs', 60000),
    maxTokens: pickNumber('maxTokens', 10000),
    maxTurnCalls: pickNumber('maxTurnCalls', 24),
    jsonMode: f.jsonMode || c.jsonMode || 'auto',
    reasoningEffort: f.reasoningEffort == null ? (c.reasoningEffort || '') : String(f.reasoningEffort),
    turnTimeoutMs: pickNumber('turnTimeoutMs', 120000),
    maxPromptTokens: pickNumber('maxPromptTokens', 131072),
    memorySteps: pickNumber('memorySteps', 2),
    chatEnabled: f.chatEnabled !== false,
    chatNotesMax: pickNumber('chatNotesMax', 12),
    chatMaxChars: pickNumber('chatMaxChars', 500),
    chatWindow: pickNumber('chatWindow', 8),
    chatReplyCooldownMs: pickNumber('chatReplyCooldownMs', 4000),
  }
}
function renderModelTab() {
  const f = initModelForm()
  const cfg = state.config || {}
  const env = cfg.envOverrides || []

  const input = (value, oninput, attrs) => {
    const el = h('input', Object.assign({ className: 'bg-input' }, attrs || {}))
    el.value = value == null ? '' : value
    el.addEventListener('input', oninput)
    return el
  }
  const numberInput = (key, attrs) => {
    const el = h('input', Object.assign({ className: 'bg-input', type: 'number', 'aria-label': key }, attrs || {}))
    el.value = f[key] == null ? '' : f[key]
    el.addEventListener('input', (e) => { f[key] = e.target.value })
    return el
  }
  const advancedNumber = (label, key, attrs, hint) => h('div', { className: 'bg-field' },
    h('label', null, label),
    numberInput(key, attrs),
    hint ? h('div', { className: 'bg-field-hint' }, hint) : null
  )
  const advancedSelect = (label, options, value, onchange, hint) => h('div', { className: 'bg-field' },
    h('label', null, label),
    selectBox(options, value, onchange),
    hint ? h('div', { className: 'bg-field-hint' }, hint) : null
  )

  const listId = 'bg-models-list'
  const result = state.modelResult
    ? h('div', { className: 'bg-model-result ' + (state.modelResult.ok ? 'ok' : 'err') },
        state.modelResult.ok
          ? '✅ ' + (state.modelResult.reply || '完成') + (state.modelResult.latencyMs != null ? '（耗时 ' + state.modelResult.latencyMs + 'ms）' : '')
          : '❌ ' + (state.modelResult.error || '失败'))
    : null
  const busy = state.modelBusy
  const currentBudget = '当前生效：单回合 ' + Math.round((cfg.turnTimeoutMs || 0) / 1000) + 's · 提示词 ≈' +
    (cfg.maxPromptTokens || 0) + ' token · 记忆窗口 ' + (cfg.memorySteps || 2) + ' 步 · ' +
    '结构化输出 ' + (cfg.jsonMode || 'auto')
  const advanced = h('details', {
    className: 'bg-advanced',
    open: state.modelAdvancedOpen,
    ontoggle: (e) => { state.modelAdvancedOpen = !!e.target.open },
  },
    h('summary', null, '⚙️ 高级参数'),
    h('p', { className: 'bg-field-hint', style: { marginTop: '8px' } }, '保存后写入 boardgame.config.json；若同名环境变量已设置，环境变量仍然优先。留空会回落到当前值或默认值。'),
    h('div', { className: 'bg-sec' }, '采样与单次调用'),
    h('div', { className: 'bg-grid-2' },
      advancedNumber('温度 temperature', 'temperature', { step: '0.1', min: '0', max: '2' }, '越高越随机；默认 0.7'),
      advancedNumber('Top P', 'topP', { step: '0.05', min: '0', max: '1' }, '<=0 表示不发送该参数'),
      advancedSelect('结构化输出 jsonMode', [
        { value: 'auto', label: 'auto' },
        { value: 'on', label: 'on' },
        { value: 'off', label: 'off' },
      ], f.jsonMode, (e) => { f.jsonMode = e.target.value }, '推荐 auto，后端不支持 response_format 时会自动降级；on 始终要求 JSON；off 只靠提示词约束'),
      advancedNumber('单步重试 maxRetries', 'maxRetries', { step: '1', min: '1', max: '20' }, '单个决策步内允许的模型调用次数'),
      advancedNumber('单次超时 timeoutMs (ms)', 'timeoutMs', { step: '1000', min: '1000', max: '600000' }, '单次 /chat/completions 请求的超时时间'),
      advancedNumber('输出上限 maxTokens', 'maxTokens', { step: '100', min: '0', max: '100000' }, '<=0 表示不发送该参数，由后端决定'),
      advancedSelect('推理强度 reasoningEffort', [
        { value: '', label: '不指定（后端默认）' },
        { value: 'minimal', label: 'minimal' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' },
      ], f.reasoningEffort || '', (e) => { f.reasoningEffort = e.target.value },
      '推理型模型（如 DeepSeek flash / pro）会先思考再回答：棋类建议 low，剧本推理可用 high；后端不支持该参数时会自动忽略'),
    ),
    h('div', { className: 'bg-sec' }, '回合与上下文预算'),
    h('div', { className: 'bg-grid-2' },
      advancedNumber('单回合调用上限 maxTurnCalls', 'maxTurnCalls', { step: '1', min: '1', max: '100' }, '一个 AI 回合内允许的模型调用总次数'),
      advancedNumber('单回合墙钟 turnTimeoutMs (ms)', 'turnTimeoutMs', { step: '1000', min: '0', max: '3600000' }, '<=0 表示关闭该回合的墙钟限制'),
      advancedNumber('提示词预算 maxPromptTokens', 'maxPromptTokens', { step: '1024', min: '0', max: '2000000' }, '超出后优先丢弃更早的对话历史'),
      advancedNumber('回合内记忆 memorySteps', 'memorySteps', { step: '1', min: '1', max: '20' }, '保留最近 N 步决策 + 当前步'),
    ),
    h('div', { className: 'bg-sec' }, '战术交流与备忘'),
    h('div', { className: 'bg-grid-2' },
      advancedSelect('战术交流 chatEnabled', [
        { value: 'true', label: '开启' },
        { value: 'false', label: '关闭' },
      ], String(f.chatEnabled !== false), (e) => { f.chatEnabled = e.target.value === 'true' }, '关闭后不会调用讨论模型，也不会注入战术备忘'),
      advancedNumber('备忘软上限 chatNotesMax', 'chatNotesMax', { step: '1', min: '4', max: '100' }, '超过后触发记忆压缩'),
      advancedNumber('单条发言上限 chatMaxChars', 'chatMaxChars', { step: '50', min: '50', max: '5000' }, '玩家单条讨论的字数上限'),
      advancedNumber('讨论窗口 chatWindow', 'chatWindow', { step: '1', min: '2', max: '100' }, '注入讨论提示词的最近聊天条数'),
      advancedNumber('回复冷却 chatReplyCooldownMs (ms)', 'chatReplyCooldownMs', { step: '500', min: '0', max: '60000' }, 'AI 每次回复后的冷却时间：冷却内的连续发言只记录，不逐条排队回复；0 表示关闭'),
    )
  )

  return h('div', null,
    h('p', { className: 'bg-desc' }, '配置大模型后端（OpenAI 兼容 /chat/completions 接口，支持 OpenAI / DeepSeek / Ollama 等）。保存后写入 boardgame.config.json。'),
    env.length ? h('div', { className: 'bg-model-result err' }, '⚠️ 以下字段正被环境变量覆盖，界面保存不会改变实际生效值：' + env.join('、')) : null,
    h('div', { className: 'bg-field-hint', style: { marginBottom: '14px' } }, currentBudget),
    h('div', { className: 'bg-field' },
      h('label', null, 'API 地址'),
      input(f.baseUrl, (e) => { f.baseUrl = e.target.value }, { 'aria-label': 'API 地址', placeholder: 'https://api.deepseek.com/v1', spellcheck: 'false' }),
      h('div', { className: 'bg-field-hint' }, '会拼接到 /chat/completions；Ollama 用 http://localhost:11434/v1。')
    ),
    h('div', { className: 'bg-field' },
      h('label', null, 'API 密钥'),
      h('div', { className: 'bg-model-row' },
        input(f.apiKey, (e) => { f.apiKey = e.target.value }, {
          'aria-label': 'API 密钥',
          type: f.showKey ? 'text' : 'password',
          placeholder: cfg.hasKey ? '已配置密钥（留空保持不变）' : 'sk-...',
          autocomplete: 'off', spellcheck: 'false',
        }),
        h('button', { className: 'bg-btn secondary bg-key-toggle', type: 'button', title: f.showKey ? '隐藏密钥' : '显示密钥', onclick: () => { f.showKey = !f.showKey; render() } }, f.showKey ? '🙈' : '👁')
      )
    ),
    h('div', { className: 'bg-field' },
      h('label', null, '模型'),
      h('div', { className: 'bg-model-row' },
        input(f.model, (e) => { f.model = e.target.value }, { 'aria-label': '模型', list: listId, placeholder: 'deepseek-flash', spellcheck: 'false' }),
        h('button', { className: 'bg-btn secondary', type: 'button', disabled: !!busy, style: { flex: 'none' }, onclick: fetchModelList }, busy === 'models' ? '获取中…' : '🔄 获取模型列表')
      ),
      h('datalist', { id: listId }, state.modelList.map((m) => h('option', { value: m }))),
      state.modelList.length
        ? selectBox(
            [{ value: '', label: '选择已获取的模型（' + state.modelList.length + '）' }]
              .concat(state.modelList.map((model) => ({ value: model, label: model }))),
            state.modelList.includes(f.model) ? f.model : '',
            (e) => { if (e.target.value) { f.model = e.target.value; render() } }
          )
        : null
    ),
    advanced,
    result,
    h('div', { className: 'bg-modal-foot', style: { marginTop: '16px' } },
      h('button', { className: 'bg-btn secondary', type: 'button', disabled: !!busy, onclick: testModelConnection }, busy === 'test' ? '测试中…' : '🔍 测试连接'),
      h('button', { className: 'bg-btn', type: 'button', disabled: !!busy, onclick: saveModelConfig }, busy === 'save' ? '保存中…' : '💾 保存')
    )
  )
}
async function testModelConnection() {
  if (state.modelBusy) return
  state.modelBusy = 'test'; state.modelResult = null; render()
  try {
    const r = await api('POST', '/config/test', modelPayload())
    state.modelResult = { ok: true, reply: r.test.reply, latencyMs: r.test.latencyMs }
  } catch (e) {
    state.modelResult = { ok: false, error: String(e.message) }
  }
  state.modelBusy = null; render()
}

async function fetchModelList() {
  if (state.modelBusy) return
  state.modelBusy = 'models'; state.modelResult = null; render()
  try {
    const r = await api('POST', '/config/models', modelPayload())
    state.modelList = r.models || []
    state.modelResult = state.modelList.length
      ? { ok: true, reply: '已获取 ' + state.modelList.length + ' 个模型，请在下拉列表中选择' }
      : { ok: false, error: '未获取到任何模型' }
  } catch (e) {
    state.modelResult = { ok: false, error: String(e.message) }
  }
  state.modelBusy = null; render()
}

async function saveModelConfig() {
  if (state.modelBusy) return
  state.modelBusy = 'save'; state.modelResult = null; render()
  try {
    const r = await api('POST', '/config', modelPayload())
    state.config = r
    state.modelForm = null
    state.modelResult = { ok: true, reply: '已保存' }
  } catch (e) {
    state.modelResult = { ok: false, error: String(e.message) }
  }
  state.modelBusy = null; render()
}

// ---------------------------------------------------------------------------
// 设置：AI 决策指标（GET /api/agent-stats）
// ---------------------------------------------------------------------------

async function loadStats() {
  if (state.statsBusy) return
  state.statsBusy = true
  state.statsError = null
  render()
  try {
    state.statsData = await api('GET', '/agent-stats')
  } catch (e) {
    state.statsError = String(e.message)
  }
  state.statsBusy = false
  render()
}

async function resetAgentStats() {
  if (state.statsBusy) return
  state.statsBusy = true
  render()
  try {
    state.statsData = await api('GET', '/agent-stats?reset=1')
    state.statsError = null
  } catch (e) {
    state.statsError = String(e.message)
  }
  state.statsBusy = false
  render()
}

const OUTCOME_LABEL = {
  ok: '✅ 成功',
  parseError: '⚠️ 解析失败',
  validateError: '🚫 非法行动',
  callError: '📡 调用失败',
  fallback: '🛟 兜底（本地引擎）',
  noKeyFallback: '🛟 兜底（未配置模型·本地引擎）',
  stall: '⛔ 中止',
}

function pctText(value) { return value == null ? '—' : (Number(value) * 100).toFixed(1) + '%' }
function msText(value) { return value == null ? '—' : Math.round(value) + ' ms' }

function statCell(label, value, hint) {
  return h('div', { className: 'bg-stat' },
    h('div', { className: 'bg-stat-value' }, String(value)),
    h('div', { className: 'bg-stat-label' }, label),
    hint ? h('div', { className: 'bg-stat-hint' }, hint) : null
  )
}

function renderStatsTab() {
  const d = state.statsData
  const head = h('p', { className: 'bg-desc' },
    '每次模型调用都会写入决策日志，并在这里聚合为可观测指标。「清空计数」只重置进程内计数，不删除 decisions.jsonl 历史。')
  if (!d) {
    return h('div', null, head,
      state.statsError ? h('div', { className: 'bg-model-result err' }, '❌ ' + state.statsError) : null,
      h('div', { className: 'bg-empty' }, state.statsBusy ? '读取中…' : '点击右下角「刷新」读取指标。'))
  }
  const t = d.totals || {}
  const mods = Object.entries(d.byMod || {})
  const recent = d.recent || []
  return h('div', null,
    head,
    state.statsError ? h('div', { className: 'bg-model-result err' }, '❌ ' + state.statsError) : null,
    h('div', { className: 'bg-stats-grid' },
      statCell('模型调用', t.calls || 0),
      statCell('AI 回合', t.turns || 0),
      statCell('非法行动率', pctText(t.illegalRate), (t.validateError || 0) + ' 次被打回'),
      statCell('兜底率', pctText(t.fallbackRate), ((t.fallback || 0) + (t.noKeyFallback || 0)) + ' 次未用模型'),
      statCell('超预算率', pctText(t.overBudgetRate), (t.overBudget || 0) + ' 次超 token 预算'),
      statCell('回合超时', t.turnTimeouts || 0, '墙钟预算中止'),
      statCell('平均延迟', msText(t.avgLatencyMs)),
      statCell('平均提示词', (t.avgPromptChars || 0) + ' 字', '≈ ' + (t.avgPromptTokensEst || 0) + ' token'),
      statCell('累计输入 token', t.promptTokensEst || 0, '本地估算 · 后端回报 ' + (t.promptTokens || 0))
    ),
    h('div', { className: 'bg-sec' }, '按桌游'),
    mods.length === 0 ? h('div', { className: 'bg-empty' }, '还没有 AI 决策记录。') : h('div', { className: 'bg-stats-mods' },
      mods.map(([id, m]) => h('div', { className: 'bg-stats-mod' },
        h('span', { className: 'bg-stats-mod-name' }, id),
        h('span', null, (m.calls || 0) + ' 次调用 · ' + (m.turns || 0) + ' 回合 · 平均 ' + (m.avgStepsPerTurn || 0) + ' 步/回合 · 兜底 ' + (m.fallback || 0) + ' · 非法 ' + (m.validateError || 0) + ' · ' + msText(m.avgLatencyMs))
      ))
    ),
    h('div', { className: 'bg-sec' }, '最近决策'),
    recent.length === 0 ? h('div', { className: 'bg-empty' }, '暂无记录。') : h('div', { className: 'bg-decisions' },
      recent.map((entry) => h('div', { className: 'bg-decision' },
        h('div', { className: 'bg-decision-head' },
          h('span', { className: 'bg-decision-outcome' }, (OUTCOME_LABEL[entry.outcome] || entry.outcome || entry.kind || '记录') + (entry.reason ? '（' + entry.reason + '）' : '')),
          h('span', { className: 'bg-decision-meta' },
            [entry.modId, entry.aiName, entry.model,
              entry.latencyMs != null ? entry.latencyMs + 'ms' : null,
              entry.promptTokensEst != null ? '≈' + entry.promptTokensEst + 'tk' : null,
              entry.promptOverBudget ? '⚠️ 超预算' : null].filter(Boolean).join(' · '))
        ),
        entry.error ? h('div', { className: 'bg-decision-line err' }, '错误：' + entry.error) : null,
        entry.move ? h('div', { className: 'bg-decision-line' }, '行动：' + JSON.stringify(entry.move)) : null,
        entry.replyExcerpt ? h('div', { className: 'bg-decision-line dim' }, '输出：' + entry.replyExcerpt) : null
      ))
    ),
    h('div', { className: 'bg-modal-foot' },
      h('button', { className: 'bg-btn danger', type: 'button', disabled: state.statsBusy, onclick: resetAgentStats }, state.statsBusy ? '处理中…' : '🧹 清空计数'),
      h('button', { className: 'bg-btn secondary', type: 'button', disabled: state.statsBusy, onclick: loadStats }, '🔄 刷新')
    )
  )
}

function aiMetaText(ai) {
  return ai.persona || '未设定人设'
}

function renderAiEditor(ai) {
  const draft = {
    id: ai.id,
    name: ai.name, avatar: ai.avatar, color: ai.color,
    persona: ai.persona || '',
  }

  const textInput = (value, oninput, attrs) => {
    const el = h('input', Object.assign({ className: 'bg-input' }, attrs || {}))
    el.value = value == null ? '' : value
    el.addEventListener('input', oninput)
    return el
  }
  const personaEl = h('textarea', {
    className: 'bg-input',
    style: { minHeight: '140px', lineHeight: '1.6' },
    placeholder: '用第二人称写扮演规则，如：你是墨玄子，沉稳老练……说话慢条斯理；落子先守后攻。',
  })
  personaEl.value = draft.persona
  personaEl.addEventListener('input', (e) => { draft.persona = e.target.value })

  const avatarPreview = h('span', { className: 'bg-ai-avatar bg-ai-avatar-preview', style: { background: draft.color } }, avatarContent(draft.avatar))
  const avatarHint = h('div', { className: 'bg-field-hint' }, isImageAvatar(draft.avatar) ? '当前使用图片头像' : '可上传图片，或输入 emoji / 图片 URL')
  const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, 'aria-label': '上传 AI 头像' })
  const avatarText = textInput(isImageAvatar(draft.avatar) ? '' : draft.avatar, (e) => {
    draft.avatar = e.target.value
    syncAvatar(true)
  }, { style: { width: '80px', flex: 'none' }, placeholder: 'emoji / URL', 'aria-label': 'AI 头像' })
  const colorInput = textInput(draft.color, (e) => {
    draft.color = e.target.value
    avatarPreview.style.background = draft.color
  }, { type: 'color', style: { width: '46px', flex: 'none', padding: '2px' }, 'aria-label': 'AI 头像底色' })

  function syncAvatar(keepInputValue) {
    avatarPreview.replaceChildren(avatarContent(draft.avatar))
    avatarPreview.style.background = draft.color
    const image = isImageAvatar(draft.avatar)
    avatarHint.textContent = image ? '当前使用图片头像' : '可上传图片，或输入 emoji / 图片 URL'
    avatarText.value = image && !keepInputValue ? '' : draft.avatar
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    avatarHint.textContent = '正在处理图片…'
    try {
      draft.avatar = await fileToAvatar(file)
      syncAvatar()
    } catch (err) {
      avatarHint.textContent = String(err && err.message ? err.message : err)
    }
  })

  const form = h('div', null,
    h('div', { className: 'bg-sec' }, '外观'),
    h('div', { className: 'bg-avatar-edit' },
      avatarPreview,
      h('div', { className: 'bg-avatar-edit-body' },
        h('div', { className: 'bg-avatar-actions' },
          h('button', { type: 'button', className: 'bg-btn secondary', onclick: () => fileInput.click() }, '上传图片'),
          h('button', { type: 'button', className: 'bg-btn secondary', onclick: () => { draft.avatar = '🤖'; syncAvatar() } }, '使用 emoji')
        ),
        avatarHint,
        fileInput
      )
    ),
    h('div', { className: 'bg-row-3' },
      avatarText,
      textInput(draft.name, (e) => { draft.name = e.target.value }, { style: { flex: 1 }, placeholder: '名字' }),
      colorInput
    ),
    h('div', { className: 'bg-sec' }, '人设'),
    h('div', { className: 'bg-field' },
      h('label', null, '这段文字会直接作为 system prompt，决定 AI 怎么下棋、怎么说话'),
      personaEl
    )
  )

  return h('div', { className: 'bg-backdrop' },
    h('div', { className: 'bg-modal', onclick: (e) => e.stopPropagation() },
      h('h2', null, '✏️ 编辑 AI · ' + draft.name),
      h('p', { className: 'bg-desc' }, '人设会被原样注入模型的 system prompt，越具体扮演越稳；留空则用默认人设。'),
      form,
      h('div', { className: 'bg-modal-foot' },
        h('button', { className: 'bg-btn secondary', onclick: () => { state.aiEdit = null; render() } }, '取消'),
        h('button', { className: 'bg-btn', disabled: state.busy, onclick: () => saveAi(draft) }, state.busy ? '保存中…' : '保存')
      )
    )
  )
}

async function saveAi(draft) {
  state.busy = true; render()
  try {
    const r = await api('POST', '/ais', { ai: draft })
    state.ais = r.ais || []
    state.aiEdit = null
  } catch (e) { state.error = String(e.message) }
  state.busy = false; render()
}

async function createAi() {
  state.busy = true; render()
  try {
    const r = await api('POST', '/ais', {
      ai: { name: '新 AI', avatar: '🤖', color: '#8a8a8a', persona: '' },
    })
    state.ais = r.ais || []
    state.aiEdit = r.saved
  } catch (e) { state.error = String(e.message) }
  state.busy = false; render()
}

async function deleteAi(id) {
  state.busy = true; render()
  try {
    const r = await api('POST', '/ais/delete', { id })
    state.ais = r.ais || []
  } catch (e) { state.error = String(e.message) }
  state.busy = false; render()
}

// ---------------------------------------------------------------------------
// 对局
// ---------------------------------------------------------------------------

function renderGame(s) {
  const game = state.catalog.find((g) => g.id === s.modId)
  // Mod 自带界面优先；大厅只兜底通用的方格棋盘。
  const custom = modUiFor(game)?.renderGame?.(s)
  if (custom) return custom
  if (modUiPending(game)) loadModUi(game)
  if (modUiPending(game) || (s.render && s.render.kind !== 'board')) {
    return h('div', { className: 'bg-empty' }, '正在加载「' + s.modName + '」的界面…')
  }
  const over = s.state.status !== 'playing'
  const current = s.players[s.state.currentSeat]
  const pieceStyle = (s.render && s.render.pieceStyle) || 'stone'
  const sideLabel = pieceStyle === 'mark'
    ? (c) => (c === 'black' ? 'X' : 'O')
    : (c) => (c === 'black' ? '黑' : '白')
  let statusText
  if (s.state.status === 'over') statusText = s.state.winnerSeat != null ? s.players[s.state.winnerSeat].name + ' 获胜' : '平局'
  else statusText = current.seat === (s.mySeat ?? 0)
    ? '轮到你落子（' + sideLabel(current.color) + '）'
    : current.name + (current.role === 'ai' ? ' 思考中…' : ' 落子中…')

  const speeches = (s.events || []).filter((e) => e.type === 'speech').slice(-5).reverse()

  return h('div', { className: 'bg-game' },
    h('div', { className: 'bg-game-head' },
      h('div', { className: 'bg-game-title' }, s.modName),
      h('div', { className: 'bg-game-status' + (over ? ' bg-over' : '') }, statusText),
      h('div', { className: 'bg-game-actions' },
        feedbackUi.iconButton(),
        h('button', { className: 'bg-btn secondary', disabled: s.online && s.mySeat !== 0, onclick: reset }, '再来一局'),
        h('button', { className: 'bg-btn secondary', onclick: leave }, '退出')
      )
    ),
    h('div', { className: 'bg-game-body' },
      renderBoard(s)
    ),
    h('div', { className: 'bg-players' },
      speeches.length > 0 ? h('div', { className: 'bg-speeches' }, speeches.map((e) => {
        const p = s.players[e.seat]
        return h('div', { className: 'bg-speech' },
          h('span', { className: 'bg-speech-name', style: { color: p.colorHex } }, p.name + '：'),
          h('span', { className: 'bg-speech-text' }, e.text)
        )
      })) : null,
      h('div', { className: 'bg-chips' }, s.players.map((p) => {
        const active = !over && p.seat === s.state.currentSeat
        return h('div', { className: 'bg-chip' + (active ? ' bg-chip-active' : '') },
          h('span', { className: 'bg-chip-avatar', style: { background: p.colorHex } }, avatarContent(p.avatar)),
          h('span', { className: 'bg-chip-name' }, p.name),
          h('span', { className: 'bg-stone-mini bg-stone-mini-' + p.color })
        )
      }))
    )
  )
}

function renderBoard(s) {
  const render = s.render || {}
  const pieceStyle = render.pieceStyle || 'stone'
  const size = render.size || (s.state && s.state.board ? Math.round(Math.sqrt(s.state.board.length)) : 15)
  const st = s.state
  const disabled = st.status !== 'playing' || state.busy || st.currentSeat !== (s.mySeat ?? 0) || (s.online && (!state.online?.connected || state.online?.busy))
  const boardEl = h('div', {
    className: 'bg-board' + (pieceStyle === 'mark' ? ' bg-board-mark' : ''),
    style: {
      gridTemplateColumns: 'repeat(' + size + ', 1fr)',
      gridTemplateRows: 'repeat(' + size + ', 1fr)',
    },
  })

  if (size === 15 && pieceStyle === 'stone') {
    [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]].forEach(([sx, sy]) => {
      boardEl.append(h('span', { className: 'bg-star', style: { left: ((sx + 0.5) / size * 100) + '%', top: ((sy + 0.5) / size * 100) + '%' } }))
    })
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = st.board[y * size + x]
      const isLast = st.lastMove && st.lastMove.x === x && st.lastMove.y === y
      const cell = h('button', {
        className: 'bg-cell' + (v ? ' bg-cell-' + v : '') + (isLast ? ' bg-cell-last' : ''),
        disabled: disabled || !!v,
        onclick: () => move(x, y),
      })
      if (v) {
        cell.append(pieceStyle === 'mark'
          ? h('span', { className: 'bg-piece bg-mark bg-mark-' + v })
          : h('span', { className: 'bg-piece bg-stone bg-stone-' + v }))
      }
      boardEl.append(cell)
    }
  }
  return boardEl
}

function applyOptimisticMove(session, x, y) {
  const st = session.state
  if (!st || st.status !== 'playing') return null
  const size = (session.render && session.render.size) || (st.board ? Math.round(Math.sqrt(st.board.length)) : 15)
  const seat = st.currentSeat
  const color = session.players[seat].color
  if (st.board[y * size + x]) return null
  const board = st.board.slice()
  board[y * size + x] = color
  return {
    ...session,
    state: {
      ...st,
      board,
      lastMove: { x, y },
      moveCount: st.moveCount + 1,
      currentSeat: (seat + 1) % session.players.length,
      revision: st.revision + 1,
    },
  }
}

async function move(x, y) {
  if (!state.session || state.busy) return
  const original = state.session
  // 乐观落子：先把自己这步显示出来，不用等 AI 回合一起返回。
  state.session = applyOptimisticMove(original, x, y) || original
  state.busy = true; render()
  try {
    const r = await api('POST', '/move', { sessionId: original.sessionId, revision: original.state.revision, move: { x, y } })
    state.session = r.session
    rememberSession(r.session.sessionId)
  } catch (e) {
    // 服务端拒绝时回滚到服务端返回的最新状态（或落子前状态）。
    state.session = e.session || original
    state.error = String(e.message)
  }
  state.busy = false; render()
}

async function retryAi() {
  const session = state.session
  if (!session || state.busy || state.chat.pendings.length) return
  state.busy = true
  state.error = null
  state.movePending = { sessionId: session.sessionId, action: 'aiRetry' }
  render()
  let waiting = true, progressTimer
  const poll = async () => {
    if (!waiting || state.session?.sessionId !== session.sessionId) return
    try {
      const result = await api('GET', '/session?sessionId=' + encodeURIComponent(session.sessionId))
      if (waiting && state.session?.sessionId === session.sessionId && result.session &&
          (result.session.state.revision > state.session.state.revision || result.session.events.length > state.session.events.length)) {
        state.session = result.session
        render()
      }
    } catch { /* The retry response remains authoritative. */ }
    if (waiting) progressTimer = setTimeout(poll, 500)
  }
  progressTimer = setTimeout(poll, 150)
  try {
    const r = await api('POST', '/ai/retry', { sessionId: session.sessionId, revision: session.state.revision })
    if (state.session?.sessionId === session.sessionId) state.session = r.session
  } catch (e) {
    if (state.session?.sessionId === session.sessionId) {
      if (e.session) state.session = e.session
      state.error = String(e.message)
    }
  } finally {
    waiting = false
    clearTimeout(progressTimer)
    if (state.movePending?.sessionId === session.sessionId) state.movePending = null
    state.busy = false
    render()
  }
}

async function reset() {
  state.busy = true; render()
  try {
    const r = await api('POST', '/reset', { sessionId: state.session.sessionId })
    state.session = r.session
    rememberSession(r.session.sessionId)
  } catch (e) { state.error = String(e.message) }
  state.busy = false; render()
}

function leave() {
  if (state.online?.room) {
    onlineUi.leave().catch(error => { state.error = error.message; render() })
    return
  }
  if (state.session && !state.session.lifecycle?.retainOnLeave) {
    api('POST', '/leave', { sessionId: state.session.sessionId }).catch(() => {})
  }
  forgetSession()
  state.chat.open = false
  state.chat.draft = ''
  state.chat.error = null
  state.session = null
  state.view = 'library'
  state.error = null
  render()
}

// ---------------------------------------------------------------------------
// 战术讨论（公开桌聊 / 私聊 + 本局备忘）
//
// 挂载在大厅层：Mod 可以自带 renderGame，但都能白拿这个抽屉。
// 未展开时只显示一个悬浮按钮；展开后左侧停靠（右下角已被玩家气泡与设置按钮占用）。
// ---------------------------------------------------------------------------

function chatSeatName(session, seat) {
  const player = session.players.find((item) => item.seat === seat)
  return player && player.name ? player.name : '座位' + seat
}

function resetChatState() {
  state.chat.error = null
  state.chat.notice = null
}

function chatAvatar(session, seat) {
  const player = session.players.find(item => item.seat === seat)
  return h('span', { className: 'bg-chat-avatar', role: 'img', 'aria-label': chatSeatName(session, seat) + '的头像' },
    avatarContent(player?.avatar || player?.name?.slice(0,1) || '👤'))
}

function refreshChatSurface() {
  const old = root.querySelector('.bg-chat-surface')
  if (!old || !state.session) return
  const next = renderTacticalChat(state.session)
  if (next) {
    // Toast expiry must not recreate the compose box or interrupt typing.
    const drawer = old.querySelector('.bg-chat-drawer'), nextDrawer = next.querySelector('.bg-chat-drawer')
    const focused = document.activeElement
    if (drawer && nextDrawer) {
      for (const selector of ['.bg-chat-head', '.bg-chat-notes', '.bg-chat-list', '.bg-chat-status']) {
        const oldPart = drawer.querySelector(selector)
        const nextPart = nextDrawer.querySelector(selector)
        if (oldPart && nextPart) oldPart.replaceWith(nextPart)
      }
      nextDrawer.replaceWith(drawer)
    }
    old.replaceWith(next)
    if (focused?.isConnected) focused.focus({preventScroll:true})
  } else old.remove()
}
document.addEventListener('visibilitychange', refreshChatSurface)

function renderTacticalChat(session) {
  const config = state.config || {}
  if (config.chatEnabled === false) return null
  if (!session || !Array.isArray(session.players)) return null
  // Count incoming messages even while an unrelated modal hides the chat.
  const hidden = state.setup || state.settingsOpen || modUiFor(state.catalog.find(game => game.id === session.modId))?.isModalOpen?.()
  const notifications = chatNotifications.sync(session, { open: state.chat.open, channel: state.chat.channel, visible: !hidden && !document.hidden })
  clearTimeout(chatToastTimer)
  if (hidden) return null
  const surface = h('div', { className: 'bg-chat-surface' })
  const openChannel = channel => { state.chat.channel = channel; state.chat.open = true; resetChatState(); render() }
  if (notifications.toasts.length) {
    surface.append(h('div', { className: 'bg-chat-toasts', role: 'status', 'aria-live': 'polite', 'aria-label': '新聊天消息' },
      notifications.toasts.map(({event}) => h('div', { className: 'bg-chat-toast', 'data-chat-seq': event.seq },
        h('button', { className: 'bg-chat-toast-open', onclick: () => openChannel(chatChannel(event, session.mySeat ?? 0)), 'aria-label': '查看 ' + chatSeatName(session,event.seat) + ' 的消息' },
          chatAvatar(session,event.seat), h('span', { className: 'bg-chat-toast-copy' },
            h('strong', {}, chatSeatName(session,event.seat), event.to == null ? '' : ' · 私聊'), h('span', {}, event.text))),
        h('button', { className: 'bg-chat-toast-close', 'aria-label': '关闭消息气泡', onclick: () => { chatNotifications.dismiss(session.sessionId,event.seq); refreshChatSurface() } }, '×')))))
    chatToastTimer = setTimeout(refreshChatSurface, Math.max(1, Math.min(...notifications.toasts.map(t => t.expires)) - Date.now()))
  }
  if (!state.chat.open) {
    surface.append(h('button', {
      className: 'bg-chat-fab',
      title: notifications.total ? `${notifications.total} 条未读消息` : '战术讨论',
      'aria-label': '打开战术讨论', 'aria-description': notifications.total ? `${notifications.total} 条未读消息` : '没有未读消息',
      onclick: () => { state.chat.open = true; resetChatState(); render() },
    }, '💬', notifications.total ? h('span', { className: 'bg-chat-unread', 'aria-label': `${notifications.total} 条未读消息` }, notifications.total > 99 ? '99+' : notifications.total) : null))
    return surface
  }
  surface.append(h('div', { className: 'bg-chat-drawer', role: 'dialog', 'aria-label': '战术讨论' },
    renderChatHead(session, notifications.unread),
    renderChatNotes(session),
    renderChatList(session),
    renderChatStatus(),
    renderChatCompose(session)
  ))
  return surface
}

function renderChatHead(session, unread = {}) {
  const ais = session.players.filter((player) => session.online ? player.seat !== session.mySeat : player.role === 'ai')
  const channel = state.chat.channel
  const channelBtn = (value, label, title) => h('button', {
    className: 'bg-chat-tab' + (channel === value ? ' bg-chat-tab-active' : ''),
    title,
    onclick: () => { state.chat.channel = value; resetChatState(); render() },
  }, label, unread[value] ? h('span', { className: 'bg-chat-tab-unread' }, unread[value]) : null)
  return h('div', { className: 'bg-chat-head' },
    h('div', { className: 'bg-chat-tabs' },
      channelBtn('table', '📣 公开桌聊', '所有玩家都能看到'),
      ...ais.map((player) => channelBtn(String(player.seat), '🔒 ' + player.name, '只有这位队友能看到'))
    ),
    h('button', {
      className: 'bg-chat-close',
      title: '收起',
      'aria-label': '收起战术讨论',
      onclick: () => { state.chat.open = false; render() },
    }, '✕')
  )
}

function renderChatNotes(session) {
  const notes = Array.isArray(session.notes) ? session.notes : []
  const max = (state.config && state.config.chatNotesMax) || 12
  const open = state.chat.notesOpen
  // 联机房间的备忘由房主落盘：成员只能看，改动走 /备忘 与 /清除备忘 指令。
  const readOnly = !!session.online
  const head = h('button', {
    className: 'bg-chat-notes-head',
    'aria-label': '展开或收起战术备忘',
    onclick: () => { state.chat.notesOpen = !open; render() },
  }, '🧠 本局备忘（' + notes.length + '/' + max + '）' + (open ? ' ▾' : ' ▸'))
  if (!open) return h('div', { className: 'bg-chat-notes' }, head)

  const body = h('div', { className: 'bg-chat-notes-body' })
  if (!notes.length) {
    body.append(h('div', { className: 'bg-chat-empty' }, '还没有战术备忘。试试说「记住，以后先推进主线」，或输入 /备忘 <内容>。'))
  }
  for (const note of notes) {
    body.append(h('div', { className: 'bg-chat-note' },
      h('span', { className: 'bg-chat-note-scope' }, note.scope === 'seat' ? ('🔒 ' + chatSeatName(session, note.seat)) : '队伍'),
      h('span', { className: 'bg-chat-note-text' }, note.text),
      readOnly ? null : h('button', { className: 'bg-chat-note-btn', title: '编辑', 'aria-label': '编辑备忘', onclick: () => editNote(note) }, '✏️'),
      readOnly ? null : h('button', { className: 'bg-chat-note-btn', title: '删除', 'aria-label': '删除备忘', onclick: () => deleteNote(note.id) }, '🗑')
    ))
  }
  body.append(readOnly
    ? h('div', { className: 'bg-chat-note-hint' }, '用 /清除备忘 清空你能看到的备忘')
    : h('button', { className: 'bg-btn secondary bg-chat-note-clear', onclick: clearNotes }, '清空本局记忆'))
  return h('div', { className: 'bg-chat-notes' }, head, body)
}

function renderChatList(session) {
  const channel = state.chat.channel
  const to = channel === 'table' ? null : Number(channel)
  const messages = (session.events || []).filter((event) => {
    if (!event || event.type !== 'chat') return false
    const eventTo = event.to == null ? null : Number(event.to)
    return event.participants ? to !== null && event.participants.includes(to) : eventTo === to
  })
  // 本地占位：已发出但服务端还没回显的发言。服务端一旦记录同一条（且 seq 在发送之后），占位就撤掉。
  for (const pending of state.chat.pendings) {
    if (pending.sessionId !== session.sessionId) continue
    if ((pending.to == null ? null : Number(pending.to)) !== to) continue
    if (messages.some((event) => event.seat === pending.seat
      && Number(event.seq) >= (pending.sinceSeq ?? 0)
      && chatMessageKey(event) === chatMessageKey(pending))) continue
    messages.push(pending)
  }
  const list = h('div', { className: 'bg-chat-list', 'aria-label': '讨论记录' })
  if (!messages.length) {
    list.append(h('div', { className: 'bg-chat-empty' }, to === null
      ? '还没有讨论。输入 @ 指定回复的队友、@全体 让所有人回应，输入 / 查看指令。'
      : '还没有和这位队友私聊过。私聊内容其它 AI 看不到。'))
  }
  for (const event of messages) {
    const mine = event.seat === (session.mySeat ?? 0)
    const name = chatSeatName(session, event.seat)
    const player = session.players.find((item) => item.seat === event.seat)
    list.append(h('div', { className: 'bg-chat-msg ' + (mine ? 'bg-chat-msg-me' : 'bg-chat-msg-ai') + (event.pending ? ' bg-chat-msg-pending' : '') },
      h('div', { className: 'bg-chat-msg-head' },
        chatAvatar(session,event.seat),
        h('span', { className: 'bg-chat-msg-name', style: { color: (player && player.colorHex) || '#8ea2c8' } }, name),
        to === null ? null : h('span', { className: 'bg-chat-lock' }, '🔒'),
        mine && !event.pending ? h('button', {
          className: 'bg-chat-pin',
          title: '钉住为战术备忘',
          'aria-label': '钉住为战术备忘',
          onclick: () => pinChat(event),
        }, '📌') : null
      ),
      h('div', { className: 'bg-chat-msg-text' }, event.text)
    ))
  }
  return list
}

// —— 输入补全：@ 定向队友 / @全体，以及 / 指令 ——

function chatAiSeats(session) {
  return (session.players || []).filter((player) => player && player.role === 'ai')
}

function chatMentionOptions(session) {
  return [
    { value: '@全体 ', label: '全体成员', hint: '所有 AI 队友都会回复', icon: '📣' },
    ...chatAiSeats(session).map((player) => ({
      value: '@' + player.name + ' ',
      label: player.name,
      hint: '只有 ' + player.name + ' 会回复',
      avatar: player.avatar,
    })),
  ]
}

function chatCommandOptions() {
  const fallback = [
    { usage: '/备忘 <内容>', summary: '把这句话记进本局战术备忘' },
    { usage: '/清除备忘', summary: '清空本局全部战术备忘' },
    { usage: '/help', summary: '查看可用聊天指令' },
  ]
  const commands = (state.config && Array.isArray(state.config.chatCommands) && state.config.chatCommands.length)
    ? state.config.chatCommands : fallback
  return commands.map((command) => {
    const usage = String(command.usage || '')
    const value = usage.includes('<') ? usage.split(/\s+</)[0].trim() + ' ' : usage
    return { value, label: usage, hint: command.summary || '', icon: '⌨️' }
  })
}

/**
 * 把补全弹层挂到输入框上：打字时更新，方向键选择，Enter/Tab 采用。
 * @/ 的上下文判定与候选过滤是纯函数（见 public/chat-compose.js），这里只负责交互与 DOM。
 */
function mountChatSuggest(session, textarea, container, send) {
  let items = []
  let active = 0

  const hide = () => {
    items = []
    active = 0
    container.hidden = true
    container.replaceChildren()
  }

  const refresh = () => {
    const context = chatCompletionContext(textarea.value, textarea.selectionStart)
    if (!context) return hide()
    // 私聊频道已经指定了对象，不再提供 @ 定向；指令两种频道都可用。
    const candidates = context.kind === 'command'
      ? chatCommandOptions()
      : state.chat.channel === 'table' ? chatMentionOptions(session) : []
    const options = chatFilterOptions(candidates, context.query)
    if (!options.length) return hide()
    items = options
    active = Math.min(active, options.length - 1)
    container.hidden = false
    container.replaceChildren(
      h('div', { className: 'bg-chat-suggest-title' }, context.kind === 'command' ? '指令' : '回复对象'),
      ...options.map((option, index) => h('button', {
        type: 'button',
        className: 'bg-chat-suggest-item' + (index === active ? ' is-active' : ''),
        'aria-selected': index === active ? 'true' : 'false',
        onmousedown: (event) => { event.preventDefault(); accept(option) },
      },
        h('span', { className: 'bg-chat-suggest-icon' }, option.avatar ? avatarContent(option.avatar) : option.icon || '💬'),
        h('span', { className: 'bg-chat-suggest-copy' },
          h('span', { className: 'bg-chat-suggest-label' }, option.label),
          option.hint ? h('span', { className: 'bg-chat-suggest-hint' }, option.hint) : null))),
    )
  }

  const accept = (option) => {
    const context = chatCompletionContext(textarea.value, textarea.selectionStart)
    if (!context || !option) return
    const next = textarea.value.slice(0, context.start) + option.value + textarea.value.slice(context.end)
    textarea.value = next
    const caret = context.start + option.value.length
    if (textarea.setSelectionRange) textarea.setSelectionRange(caret, caret)
    state.chat.draft = next
    send.disabled = state.busy || !next.trim()
    refresh()
    textarea.focus({ preventScroll: true })
  }

  // 返回 true 表示这次按键已被补全弹层消费。
  const handleKey = (event) => {
    if (!items.length) return false
    if (event.key === 'ArrowDown') { event.preventDefault(); active = (active + 1) % items.length; refresh(); return true }
    if (event.key === 'ArrowUp') { event.preventDefault(); active = (active - 1 + items.length) % items.length; refresh(); return true }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); accept(items[active]); return true }
    if (event.key === 'Escape') { event.preventDefault(); hide(); return true }
    return false
  }

  return { refresh, handleKey, hide }
}

/** 抽屉里的临时状态（错误 / 提示 / 正在回应）。放在输入框外面，局部刷新时才能更新。 */
function renderChatStatus() {
  return h('div', { className: 'bg-chat-status' },
    state.chat.error ? h('div', { className: 'bg-chat-error' }, '⚠️ ' + state.chat.error) : null,
    state.chat.notice ? h('div', { className: 'bg-chat-notice' }, state.chat.notice) : null,
    state.chat.pendings.length ? h('div', { className: 'bg-chat-pending-status', role: 'status' }, '队友正在回应…') : null
  )
}

function renderChatCompose(session) {
  const maxChars = (state.config && state.config.chatMaxChars) || 500
  const textarea = h('textarea', {
    className: 'bg-chat-input',
    rows: 2,
    maxlength: maxChars,
    'aria-label': '战术讨论输入',
    placeholder: state.chat.channel === 'table' ? '和大家讨论战术…（Enter 发送，Shift+Enter 换行）' : '私聊这位队友…',
  })
  textarea.value = state.chat.draft || ''
  const suggest = h('div', { className: 'bg-chat-suggest', role: 'listbox', 'aria-label': '聊天补全', hidden: true })
  const send = h('button', {
    className: 'bg-btn bg-chat-send',
    disabled: state.busy,
    onclick: () => sendChat(),
  }, '发送')
  const controller = mountChatSuggest(session, textarea, suggest, send)
  // 打字不触发全量重绘（否则光标会跳），只同步状态、补全弹层与发送按钮可用性
  textarea.addEventListener('input', () => {
    state.chat.draft = textarea.value
    send.disabled = state.busy || !textarea.value.trim()
    controller.refresh()
  })
  textarea.addEventListener('keydown', (event) => {
    if (controller.handleKey(event)) return
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat() }
    else if (event.key === 'Escape') { state.chat.open = false; render() }
  })
  textarea.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== textarea) controller.hide()
  }, 120))
  send.disabled = state.busy || !String(state.chat.draft || '').trim()

  return h('div', { className: 'bg-chat-compose' },
    suggest,
    h('div', { className: 'bg-chat-compose-row' }, textarea, send),
    h('div', { className: 'bg-chat-hint' }, chatAiSeats(session).length
      ? '输入 @ 指定队友、@全体 让所有人回应；输入 / 使用指令。'
      : '输入 / 使用指令。')
  )
}

/** 用服务端返回的会话替换本地视图，并撤掉已经落库的本地占位发言。 */
function applyChatSession(next) {
  state.session = next
  const mine = (next.events || []).filter((event) => event.type === 'chat' && event.seat === (next.mySeat ?? 0))
  state.chat.pendings = state.chat.pendings.filter((pending) => !mine.some((event) =>
    Number(event.seq) >= (pending.sinceSeq ?? 0) && chatMessageKey(event) === chatMessageKey(pending)))
}

let chatPollTimer = null

function stopChatPoll() {
  if (chatPollTimer) { clearTimeout(chatPollTimer); chatPollTimer = null }
}

/** 回复可能分多条到达（@全体），轮询会话让它们逐条出现，而不是等最后一个字回来。 */
function startChatPoll(sessionId) {
  if (chatPollTimer) return
  const tick = async () => {
    chatPollTimer = null
    const session = state.session
    if (!session || session.sessionId !== sessionId) return
    if (!state.chat.pendings.length) return
    if (session.online || state.busy) { chatPollTimer = setTimeout(tick, 1200); return }
    try {
      const result = await api('GET', '/session?sessionId=' + encodeURIComponent(sessionId))
      if (state.session?.sessionId === sessionId && result.session) {
        const current = state.session
        const next = result.session
        const grew = (next.events || []).length > (current.events || []).length
        const newer = (next.state?.revision ?? 0) > (current.state?.revision ?? 0)
        if (grew || newer) {
          applyChatSession(next)
          render()
        }
      }
    } catch { /* 轮询失败不影响最终响应 */ }
    if (state.chat.pendings.length) chatPollTimer = setTimeout(tick, 1200)
  }
  chatPollTimer = setTimeout(tick, 500)
}

let chatSendToken = 0

async function sendChat() {
  const session = state.session
  if (!session || state.busy) return
  const text = String(state.chat.draft || '').trim()
  if (!text) return
  const channel = state.chat.channel
  const to = channel === 'table' ? null : Number(channel)
  const pending = {
    type: 'chat', seat: session.mySeat ?? 0, to, text,
    pending: true, sessionId: session.sessionId, token: ++chatSendToken,
    sinceSeq: Array.isArray(session.events) ? session.events.length : 0,
  }

  // 立即清空输入、恢复发送按钮：不等模型，连续发言由服务端阈值决定是否逐条回复。
  state.chat.pendings.push(pending)
  state.chat.draft = ''
  state.chat.error = null
  state.chat.notice = null
  render()
  startChatPoll(session.sessionId)
  try {
    const result = await api('POST', '/chat', { sessionId: session.sessionId, text, to })
    if (state.session?.sessionId === session.sessionId && result.session) applyChatSession(result.session)
    const chat = result.chat || {}
    if (chat.error) state.chat.error = chat.error
    if (chat.warning) state.chat.notice = chat.warning
    if (chat.notice) state.chat.notice = chat.notice
    if (chat.skipped === 'inflight') {
      state.chat.notice = 'AI 还在回应上一条，这条只记入讨论，不再排队回复。'
    } else if (chat.skipped === 'cooldown') {
      state.chat.notice = '连续发言只记录不逐条回复（冷却 ' + Math.ceil((chat.retryAfterMs || 0) / 1000) + ' 秒）。'
    }
    if (chat.compacted) state.chat.notice = '记忆已自动压缩，精简 ' + chat.compacted + ' 条。'
    else if (chat.notesAdded || chat.notesUpdated || chat.notesRemoved) {
      if (!chat.notice) {
        const parts = []
        if (chat.notesAdded) parts.push('记住 ' + chat.notesAdded + ' 条')
        if (chat.notesUpdated) parts.push('更新 ' + chat.notesUpdated + ' 条')
        if (chat.notesRemoved) parts.push('忘记 ' + chat.notesRemoved + ' 条')
        state.chat.notice = '已' + parts.join('、') + '（可在上方备忘里修改或删除）'
      }
      state.chat.notesOpen = true
    }
  } catch (err) {
    state.chat.error = String(err.message)
    if (!state.chat.draft) state.chat.draft = text // 失败保留输入，方便重试
  } finally {
    state.chat.pendings = state.chat.pendings.filter((item) => item.token !== pending.token)
    if (!state.chat.pendings.length) stopChatPoll()
    render()
  }
}

async function pinChat(event) {
  const session = state.session
  if (!session) return
  resetChatState()
  try {
    if (session.online) {
      // 联机房间的备忘由房主落盘：把这条发言当成一次 /备忘 指令发给房主。
      const text = '/备忘 ' + String(event.text == null ? '' : event.text).replace(/\s+/g, ' ').trim()
      const result = await api('POST', '/chat', {
        sessionId: session.sessionId, text, to: event.to == null ? null : Number(event.to),
      })
      if (result.session) applyChatSession(result.session)
      state.chat.notice = (result.chat && result.chat.notice) || '已钉住这条发言为战术备忘。'
      state.chat.notesOpen = true
    } else {
      const result = await api('POST', '/notes/add', {
        sessionId: session.sessionId,
        text: event.text,
        to: event.to == null ? null : Number(event.to),
        evidence: Number.isInteger(event.seq) ? event.seq : null,
      })
      state.session = result.session
      state.chat.notice = '已钉住这条发言为战术备忘。'
      state.chat.notesOpen = true
    }
  } catch (err) {
    state.chat.error = String(err.message)
  }
  render()
}

async function deleteNote(noteId) {
  const session = state.session
  if (!session) return
  resetChatState()
  try {
    const result = await api('POST', '/notes/delete', { sessionId: session.sessionId, noteId })
    state.session = result.session
  } catch (err) {
    state.chat.error = String(err.message)
  }
  render()
}

async function editNote(note) {
  const session = state.session
  if (!session) return
  const next = window.prompt('修改战术备忘（不超过 30 字）', note.text)
  if (next == null) return
  resetChatState()
  try {
    const result = await api('POST', '/notes/update', { sessionId: session.sessionId, noteId: note.id, text: String(next).trim() })
    state.session = result.session
  } catch (err) {
    state.chat.error = String(err.message)
  }
  render()
}

async function clearNotes() {
  const session = state.session
  if (!session) return
  if (!window.confirm('清空本局全部战术备忘？此操作不可撤销。')) return
  resetChatState()
  try {
    const result = await api('POST', '/notes/clear', { sessionId: session.sessionId })
    state.session = result.session
    state.chat.notice = '已清空本局记忆。'
  } catch (err) {
    state.chat.error = String(err.message)
  }
  render()
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const [g, a, c] = await Promise.all([api('GET', '/catalog'), api('GET', '/ais'), api('GET', '/config')])
    state.catalog = g.games || []
    state.ais = a.ais || []
    state.config = c
    updatesUi.boot()
    // 刷新 / 服务端重启后自动回到上一局（服务端已把对局落盘）
    await onlineUi.boot()
    if (!state.online?.room) await resumeSession()
  } catch (e) { state.error = String(e.message) }
  render()
}

boot()
