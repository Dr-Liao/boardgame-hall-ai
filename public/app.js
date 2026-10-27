// 桌游大厅 · 浏览器端
// 纯原生 ES Module：无构建、无外部依赖，与 host 通过 /api 通信。

import { createChatNotifications, chatChannel } from './chat-notifications.js'
import { chatCompletionContext, chatFilterOptions, chatMessageKey } from './chat-compose.js'
import { createOnlineUI } from './online-ui.js'
import { createUpdatesUI } from './updates-ui.js'
import { createFeedbackUI } from './feedback-ui.js'
import { applyStatusDelta, statusStampOf } from './online-delta.js'
import { getLocale, hasKey, setLocale, t } from './i18n.js'

const root = document.getElementById('app')
const query = new URLSearchParams(location.search)
// ?perf=1：渲染耗时埋点 + 基准钩子（Playwright 渲染回归用，正常使用不生效）。
const PERF_RENDER = query.has('perf')
// P0 联机性能埋点：只在 ?perf=1 时动态加载 public/perf.js，正常访问不下载、不额外汇总。
// 用顶层 await 保证 recorder 在 boot() 之前就绪；加载失败只丢埋点，不影响大厅启动。
const perf = PERF_RENDER ? await loadPerfRecorder() : null

async function loadPerfRecorder() {
  try { return (await import('./perf.js')).createPerfRecorder(window) } catch { return null }
}

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
// 记住加载失败的原因：打开开局界面时不能把它清掉，否则玩家只看到「通用界面」却不知道哪里坏了。
const modErrors = new Map()
// 已加载的 Mod 宿主对象（含 host.locale）；语言切换时按最新 catalog 更新并调用 ui.onLocaleChange。
const modHosts = new Map()

/** Mod 的语言信息（docs/localization.md §8.1）：来自 catalog 的 game.i18n；旧 Mod 给安全的源语言兜底。 */
function localeFor(game) {
  if (game?.i18n && typeof game.i18n === 'object') return game.i18n
  return { requested: getLocale(), resolved: 'zh-CN', defaultLocale: 'zh-CN',
    supportedLocales: [], matched: 'source', fellBack: true, files: null }
}

/** 渲染 Mod 名称时优先用当前 catalog 里的（已本地化）名称，不只信创建对局时缓存的 session.modName。 */
function localizedModName(modId, fallback) {
  return state.catalog.find((game) => game.id === modId)?.name || fallback || modId
}

/**
 * 语言切换后把最新 catalog 的 i18n 推给每个已加载的 Mod UI（§8.3）：
 * 只更新 host.locale 并调用幂等的 onLocaleChange，不重载 Mod 模块、不重置对局。
 */
function notifyModLocales() {
  for (const [id, ui] of modUis) {
    const host = modHosts.get(id)
    const game = state.catalog.find((item) => item.id === id)
    if (host && game) host.locale = localeFor(game)
    try { ui.onLocaleChange?.(host?.locale) } catch (error) {
      console.warn('[i18n] Mod ' + id + ' 的 onLocaleChange 执行失败：' + (error?.message || error))
    }
  }
  // 更新/联机/反馈面板各自缓存文案或挂在 body 上（portal）：实现了 onLocaleChange 时重绘，旧模块静默跳过。
  try { updatesUi.onLocaleChange?.() } catch { /* 旧模块没有该钩子 */ }
  try { onlineUi.onLocaleChange?.() } catch { /* 旧模块没有该钩子 */ }
  try { feedbackUi.onLocaleChange?.() } catch { /* 旧模块没有该钩子 */ }
}

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
      // host.locale：服务端已解析好的语言（docs/localization.md §8.1）；不读它的旧 Mod 也不受影响。
      const host = { h, api, render, state, game, reset, leave, beginInteraction,
        startGame, loadSavedSession, rememberSession, forgetSession, renderOnlineSetup: onlineUi.setupFields,
        // Mod 可以在自己的标题栏里放反馈入口；宿主负责弹窗本身，旧版 Mod 不调用也不受影响。
        openFeedback: () => feedbackUi.open(),
        locale: localeFor(game) }
      modHosts.set(game.id, host)
      const ui = module.createUI(host)
      modUis.set(game.id, ui)
      return ui
    })
    .catch(error => {
      modFailed.add(game.id)
      modErrors.set(game.id, error.message)
      state.error = t('error.loadModUi', { game: localizedModName(game.id, game.name), error: errorText(error) })
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
      // P1：自动跳过偏好同步（Mod 在开关变化/进局/重连时调用；与 move 走同一联机命令通道）。
      '/prefs': 'prefs',
    }
    if (method === 'POST' && actions[pathname]) return onlineUi.command(actions[pathname], body)
    if (pathname.startsWith('/notes/') || pathname.startsWith('/session/')) throw new Error(t('error.hostManaged'))
  }
  return rawApi(method, pathname, body)
}

// perf 只在 /online/* 且 ?perf=1 时读响应文本以拿字节；非 perf 路径仍走 res.json()，不新增
// await / 序列化开销，也不为埋点额外 clone 响应体（大响应只读一遍）。
function responseBytes(text, contentLength) {
  if (contentLength != null) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared >= 0) return declared
  }
  return new TextEncoder().encode(text || '').length
}

async function rawApi(method, pathname, body) {
  const onlineRequest = pathname.startsWith('/online/')
  const trackPerf = !!perf && onlineRequest
  const perfStarted = trackPerf ? performance.now() : 0
  // P1.4：声明浏览器已缓存的公共静态表版本（status 用查询参数；command 用 body.client.staticVersion）。
  // 永远带上声明（即使为空），大厅据此区分「新客户端但没有缓存」（补发 static）与旧客户端（全量）。
  let requestPath = pathname
  let requestBody = body
  if (onlineRequest) {
    const version = currentStaticVersion()
    const separator = pathname.includes('?') ? '&' : '?'
    requestPath = pathname + separator + 'clientStatic=' + encodeURIComponent(version)
    // P3.1：status 请求声明本地会话的 stamp，命中服务器基线时只回 sessionDelta / sessionOmitted。
    if (method === 'GET' && pathname.startsWith('/online/status')) {
      const baseStamp = currentStatusStamp()
      if (baseStamp) requestPath += '&baseStamp=' + encodeURIComponent(baseStamp)
    }
    if (method === 'POST' && pathname === '/online/command' && body && typeof body === 'object' && body.body && typeof body.body === 'object') {
      requestBody = { ...body, body: { ...body.body, client: { ...(body.body.client || {}), staticVersion: version } } }
    }
  }
  const res = await fetch('/api' + requestPath, {
    method,
    headers: { ...(requestBody !== undefined ? { 'content-type': 'application/json' } : {}), ...(onlineRequest ? { 'x-boardgame-online': '1' } : {}) },
    body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
  })
  let data, responseText = null
  try {
    if (trackPerf) { responseText = await res.text(); data = JSON.parse(responseText) }
    else data = await res.json()
  } catch { data = { ok: false, error: t('error.responseParse') } }
  if (trackPerf) {
    perf.recordRequest({ path: pathname, method, ms: performance.now() - perfStarted,
      bytes: responseBytes(responseText, res.headers.get('content-length')) })
  }
  // P1.4：把 static 信封记进本地缓存，并让所有调用方（accept / 直连命令 / p2p 轮询）都拿到 hydrate 后的会话。
  // P3.1：先应用 status 增量（baseStamp 命中时），再走静态表 hydration。
  if (onlineRequest) {
    applyOnlineStatusDelta(data)
    hydrateOnlinePayload(data)
  }
  if (!data || data.ok !== true) {
    const error = new Error(data?.error || ('HTTP ' + res.status))
    Object.assign(error, { status: res.status, code: data?.code, session: data?.session, revision: data?.revision })
    throw error
  }
  return data
}

/**
 * 服务端错误 → 用户可见文案（docs/localization.md §6.3）：
 * 有 error.<CODE> 词典项时用当前语言，否则显示服务端 error（中文兜底，已知限制）。
 */
function errorText(err) {
  const code = err && typeof err === 'object' ? err.code : null
  if (typeof code === 'string' && code && hasKey('error.' + code)) return t('error.' + code)
  if (err && typeof err === 'object' && typeof err.message === 'string' && err.message) return err.message
  return String(err == null ? '' : err)
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
    if (!looksLikeImage) return reject(new Error(t('player.avatarNotImage')))
    if (file.size > 10 * 1024 * 1024) return reject(new Error(t('player.avatarTooLarge')))
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      try {
        const width = image.naturalWidth || image.width
        const height = image.naturalHeight || image.height
        if (!width || !height) throw new Error(t('player.avatarBadDimension'))
        const side = Math.min(width, height)
        const size = 256
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error(t('player.avatarUnsupported'))
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
      reject(new Error(t('player.avatarParseFailed')))
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
  // 顶层页签：AI 角色 / 模型连接 / AI 指标已合并进 'ai'，由 aiSubTab 选择二级页签。
  settingsTab: 'ai', // 'player' | 'ai' | 'online' | 'updates' | 'language'
  aiSubTab: 'roles', // 'roles' | 'model' | 'stats'
  settings: null,     // GET /api/settings 的 settings 字段（{ schema, locale }）
  locales: [],        // GET /api/settings 的 locales 字段（[{ id, label }]）
  localeSaving: false, // 语言下拉框正在保存（禁用下拉，避免并发切换）
  localeError: null,  // 保存语言失败时的错误文案（role="status" 播报）
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

// ---------------------------------------------------------------------------
// P1.4：联机公共静态表（cards / investigatorDefs）只下发一次
//
// 大厅在会话首份响应里带 static:{version, cards, investigatorDefs}，之后只带 staticVersion；
// 浏览器按 sessionId 缓存这两张表，在把会话交给界面渲染前 hydrate 回去（引用缓存对象，不深拷）。
// 每次 /online/* 请求都声明本地缓存的版本（没缓存就声明空串，表示「支持省略协议但请给全量表」），
// 版本不符/未命中时大厅会随响应补发 static 信封——失败模式只会是「多下一次全量」，不会画错状态。
// ---------------------------------------------------------------------------
const staticTables = new Map()
const STATIC_CACHE_LIMIT = 4

function currentStaticVersion() {
  const sessionId = state.session?.sessionId
  if (!sessionId) return ''
  return staticTables.get(sessionId)?.version || ''
}

function rememberStaticTables(payload) {
  const info = payload?.static
  const sessionId = payload?.session?.sessionId
  if (!info || !sessionId || typeof info.version !== 'string' || !info.cards || typeof info.cards !== 'object') return
  staticTables.delete(sessionId)
  staticTables.set(sessionId, { version: info.version, cards: info.cards, investigatorDefs: info.investigatorDefs || {} })
  while (staticTables.size > STATIC_CACHE_LIMIT) staticTables.delete(staticTables.keys().next().value)
}

/** 把精简视图恢复成可直接渲染的完整视图；本地没有匹配版本的静态表时返回 null（等下一次带表的响应）。 */
function hydrateOnlineSession(session) {
  if (!session || typeof session !== 'object') return session
  const version = typeof session.staticVersion === 'string' ? session.staticVersion : null
  if (!version) return session  // 旧客户端/回滚/无能力 Mod：响应本来就是完整视图
  const cached = staticTables.get(session.sessionId)
  const stateValue = session.state
  if (!stateValue || typeof stateValue !== 'object') return session
  if (!cached || cached.version !== version) {
    // 已经是完整视图（例如回滚开关中途切换）时保持不变，等大厅补发静态表。
    if (stateValue.cards && stateValue.investigatorDefs) return session
    return null
  }
  const privateCards = stateValue.privateCards
  const cards = privateCards && typeof privateCards === 'object' && Object.keys(privateCards).length
    ? { ...cached.cards, ...privateCards }
    : cached.cards
  return { ...session, state: { ...stateValue, cards, investigatorDefs: cached.investigatorDefs } }
}

function hydrateOnlinePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  rememberStaticTables(payload)
  if (payload.session) {
    const hydrated = hydrateOnlineSession(payload.session)
    if (hydrated) payload.session = hydrated
  }
  return payload
}

// P3.1：status 增量。状态里的会话来自 state.online.session（上一次 status 的 wire 视图）；
// 基线不符/应用失败就丢弃本次增量，等下一次全量（失败模式只会多一次全量）。
function currentStatusStamp() {
  return statusStampOf(state.online?.session)
}

function applyOnlineStatusDelta(payload) {
  if (!payload || typeof payload !== 'object') return false
  const applied = applyStatusDelta(state.online?.session, payload)
  if (!applied) return false
  payload.session = applied.session
  payload.stamp = applied.stamp
  delete payload.sessionDelta
  return true
}

const onlineUi = createOnlineUI({ h, state, render, renderChrome: refreshOnlineBanner, request: rawApi, loadGame: loadModUi, perf,
  hydrate: hydrateOnlineSession,
  // 「强制同步」成功后让当前 Mod 也清掉自己的本地演出/选择门闩（旧 Mod 没有该钩子时跳过）。
  // 只重置展示状态，不提交动作；权威局面由大厅全量快照重画。
  recover: () => {
    const game = state.session ? state.catalog.find(g => g.id === state.session.modId) : null
    try { modUiFor(game)?.recoverAfterStall?.() } catch { /* Mod 恢复钩子异常不影响大厅恢复 */ }
  } })
const updatesUi = createUpdatesUI({ h, state, render, request: rawApi, reloadCatalog })
// 反馈弹窗是 body 级 portal：挂在这里而不是 renderApp() 里，整页重绘时 iframe 不会被重建。
const feedbackUi = createFeedbackUI({ h, state, request: rawApi })

async function reloadCatalog() {
  try {
    state.catalog = (await api('GET', '/catalog')).games || []
    // 语言切换后开局弹窗仍持有旧 catalog 对象：按 game.id 换成新对象，表单标签才会跟着变。
    if (state.setup) {
      const next = state.catalog.find((game) => game.id === state.setup.game.id)
      if (next) state.setup.game = next
    }
  } catch (e) { state.error = errorText(e) }
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
  if (!PERF_RENDER) return renderNow(options)
  const started = performance.now()
  try {
    return renderNow(options)
  } finally {
    const ms = performance.now() - started
    ;(window.__HALL_RENDER_MS__ ||= []).push(ms)
    perf?.recordRender(ms)
  }
}

function renderNow(options = {}) {
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
        t('game.autoRetry', { attempt: retry.attempt, max: retry.maxAttempts })))
    }
    if (!state.busy && !state.online?.busy && (!s.online || s.mySeat === 0) && !state.chat.pendings.length && s.state.status === 'playing' && s.players[seat]?.role === 'ai') {
      consoleEl.append(h('div', { className: 'bg-game-actions', role: 'status' },
        h('span', null, t('game.aiWaiting')),
        h('button', { className: 'bg-btn secondary', onclick: retryAi }, t('game.continueAi'))))
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
    const onlineRoom = !!state.online?.room
    consoleEl.append(h('div', { className: 'bg-toast', onclick: () => { state.error = null; render() } },
      h('span', {}, state.error),
      // 联机错误就地给一个恢复入口：不用滚回房间栏找「强制同步」。
      onlineRoom ? h('button', { className: 'bg-toast-action', type: 'button', onclick: event => {
        event.stopPropagation()
        state.error = null
        render()
        onlineUi.forceResync().catch(() => { state.error = t('online.resync.failed'); render() })
      } }, t('online.resync.label')) : null))
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
        h('h1', null, t('library.title')),
        h('div', { className: 'bg-sub' }, t('library.subtitle'))
      ),
      h('div', { className: 'bg-model-pill' + (cfg.hasKey ? '' : ' bg-model-pill-off') },
        '🧠 ' + (cfg.hasKey ? (cfg.model || t('library.modelConfigured')) : t('library.modelMissing')) + (cfg.hasKey ? '' : t('library.modelMissingSuffix'))
      )
    ),
    h('div', { className: 'bg-online-entry' }, onlineUi.joinButton(), updatesUi.gameCenterButton(), feedbackUi.button()),
    h('div', { className: 'bg-grid' },
      state.catalog.length === 0
        ? h('div', { className: 'bg-empty' }, t('library.loading'))
        : state.catalog.map(renderGameCard)
    ),
    h('button', {
      className: 'bg-settings-btn' + (updatesUi.hasHallUpdates() ? ' bg-settings-btn-dot' : ''),
      title: updatesUi.hasHallUpdates() ? t('library.settingsTitleUpdates') : t('library.settingsTitle'),
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
      h('div', { className: 'bg-card-players' }, loading ? t('library.loadingGame') : t('game.players', { min: g.players[0], max: g.players[1] })),
      h('div', { className: 'bg-card-tags' }, (g.tags || []).map((tag) => h('span', { className: 'bg-tag' }, tag)))
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
  // Mod 界面加载失败时保留原因：退回通用弹窗也要让玩家看见失败信息。
  state.error = modErrors.get(game.id) || null
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
      h('h2', null, t('setup.title', { game: game.name })),
      h('p', { className: 'bg-desc' }, game.description),
      fields,
      onlineUi.setupFields(game),
      state.error ? h('div', { className: 'bg-toast', style: { position: 'static', marginBottom: '12px', transform: 'none' } }, state.error) : null,
      h('div', { className: 'bg-modal-foot' },
        h('button', { className: 'bg-btn secondary', onclick: () => { state.setup = null; state.error = null; render() } }, t('setup.cancel')),
        h('button', { className: 'bg-btn', disabled: state.busy, onclick: startGame }, state.busy ? t('setup.starting') : t('setup.start'))
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
  } catch (e) { state.error = errorText(e) }
  finally { state.busy = false; render() }
}

// ---------------------------------------------------------------------------
// 设置：页签容器 + 各面板
//
// AI 角色 / 模型连接 / AI 指标合并为单个「AI」顶层页签，内部用二级页签切换，
// 保证顶部页签在一行内放下（窄屏不换行），且页签文案不再带 emoji。
// ---------------------------------------------------------------------------

function renderSettingsModal() {
  if (state.aiEdit) return renderAiEditor(state.aiEdit)
  const tab = state.settingsTab || 'ai'
  const aiSubTab = state.aiSubTab || 'roles'
  const tabBtn = (key, label) => h('button', {
    className: 'bg-tab' + (tab === key ? ' bg-tab-active' : ''),
    onclick: () => {
      state.settingsTab = key
      state.aiEdit = null
      state.modelResult = null
      // 回到 AI 页签时按上次停留的二级页签补齐数据（model 表单 / stats 快照）。
      if (key === 'ai') {
        if (aiSubTab === 'model') initModelForm()
        if (aiSubTab === 'stats') loadStats()
      }
      if (key === 'updates') updatesUi.open()
      render()
    },
  }, label)
  // 合并后的 AI 页签：原来的三个顶层页签收成这里的二级页签，避免顶部页签换行。
  const aiSubBtn = (key, label) => h('button', {
    className: 'bg-subtab' + (aiSubTab === key ? ' bg-subtab-active' : ''),
    'aria-pressed': aiSubTab === key ? 'true' : 'false',
    onclick: () => {
      if (aiSubTab === key) return
      state.aiSubTab = key
      state.aiEdit = null
      state.modelResult = null
      if (key === 'model') initModelForm()
      if (key === 'stats') loadStats()
      render()
    },
  }, label)
  const aiPanel = h('div', null,
    h('div', { className: 'bg-subtabs', role: 'group', 'aria-label': t('settings.tabs.ai') },
      aiSubBtn('roles', t('settings.tabs.ais')),
      aiSubBtn('model', t('settings.tabs.model')),
      aiSubBtn('stats', t('settings.tabs.stats'))
    ),
    aiSubTab === 'model' ? renderModelTab() : aiSubTab === 'stats' ? renderStatsTab() : renderAiList()
  )

  return h('div', { className: 'bg-backdrop' },
    h('div', { className: 'bg-modal', onclick: (e) => e.stopPropagation() },
      h('h2', null, t('settings.title')),
      h('div', { className: 'bg-tabs' },
        tabBtn('player', t('settings.tabs.player')),
        tabBtn('ai', t('settings.tabs.ai')),
        tabBtn('online', t('settings.tabs.online')),
        tabBtn('updates', t('settings.tabs.updates') + (updatesUi.hasHallUpdates() ? ' •' : '')),
        tabBtn('language', t('settings.tabs.language'))
      ),
      tab === 'player' ? renderPlayerTab() : tab === 'ai' ? aiPanel : tab === 'online' ? onlineUi.settingsPanel()
        : tab === 'updates' ? updatesUi.panel() : renderLanguageTab(),
      h('div', { className: 'bg-modal-foot' },
        h('button', { className: 'bg-btn secondary', onclick: () => { state.settingsOpen = false; render() } }, t('settings.close')),
        // 指标面板自带刷新/清空按钮，footer 只在 AI 角色列表下提供「新增 AI」。
        tab === 'ai' && aiSubTab === 'roles'
          ? h('button', { className: 'bg-btn', disabled: state.busy, onclick: createAi }, t('settings.addAi'))
          : null
      )
    )
  )
}

// ---------------------------------------------------------------------------
// 设置 · 语言（docs/localization.md §5.3）
// ---------------------------------------------------------------------------

function renderLanguageTab() {
  const current = state.settings?.locale || getLocale()
  const options = state.locales.length ? state.locales : [{ id: 'zh-CN', label: '简体中文' }]
  const select = h('select', {
    id: 'hall-locale',
    className: 'bg-select bg-lang-select',
    'data-testid': 'hall-locale',
    // renderNow() 按 data-interaction 恢复焦点；保存中下拉是 disabled，保存结束后再显式聚焦一次。
    'data-interaction': 'hall-locale',
    disabled: state.localeSaving,
    onchange: (event) => saveLocale(event.target.value),
  })
  for (const option of options) select.append(h('option', { value: option.id }, option.label))
  select.value = current
  return h('div', null,
    h('div', { className: 'bg-sec' }, t('settings.language.title')),
    h('p', { className: 'bg-desc' }, t('settings.language.desc')),
    h('div', { className: 'bg-field' },
      h('label', { for: 'hall-locale' }, t('settings.language.selectLabel')),
      select
    ),
    state.session ? h('p', { className: 'bg-field-hint bg-lang-playing' }, t('settings.language.playing')) : null,
    state.localeError ? h('div', { className: 'bg-model-result err bg-lang-status', role: 'status' },
      t('settings.language.saveFailed', { error: state.localeError })) : null
  )
}

function focusLocaleSelect() {
  if (!state.settingsOpen) return
  root.querySelector('[data-testid="hall-locale"]')?.focus({ preventScroll: true })
}

/** 选择语言后立即保存（与「大厅更新」页一致）；失败回滚下拉、不改语言。 */
async function saveLocale(locale) {
  if (state.localeSaving || !locale || locale === (state.settings?.locale || getLocale())) return
  state.localeSaving = true
  state.localeError = null
  render()
  try {
    const response = await api('POST', '/settings', { locale })
    state.settings = response.settings || { ...(state.settings || {}), locale }
    if (Array.isArray(response.locales) && response.locales.length) state.locales = response.locales
    setLocale(state.settings.locale || locale)
    // setLocale 之后必须重新拉 catalog：目录/开局表单元数据由服务端按新语言解析后下发。
    await reloadCatalog()
    notifyModLocales()
  } catch (error) {
    // 失败不改变当前语言：state.settings 保持旧值，重绘后下拉框自然回到旧选项。
    state.localeError = errorText(error)
  } finally {
    state.localeSaving = false
    render()
    focusLocaleSelect()
  }
}

// 浏览器回归用（docs/localization.md §14.3）：已开局时设置页不可达，用例通过
// `await import('/app.js')` 调用同一个切换流程，验证 onLocaleChange 与对局不重置。
export { saveLocale }

function renderPlayerTab() {
  const avatar = state.playerAvatarDraft ?? state.config?.playerAvatar ?? '👤'
  const disabled = state.playerSaving || state.playerAvatarProcessing
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', hidden: true, disabled,
    'aria-label': t('player.uploadAvatarAria'), onchange: async e => {
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
    h('p', { className: 'bg-desc' }, t('player.desc')),
    h('div', { className: 'bg-avatar-edit' },
      h('span', { className: 'bg-ai-avatar bg-ai-avatar-preview', role: 'img', 'aria-label': t('player.avatarPreview'), style: { background: '#3aa0ff' } }, avatarContent(avatar)),
      h('div', { className: 'bg-avatar-edit-body' },
        h('div', { className: 'bg-avatar-actions' },
          h('button', { type: 'button', className: 'bg-btn secondary', disabled, onclick: () => fileInput.click() }, state.playerAvatarProcessing ? t('common.processing') : t('player.uploadAvatar')),
          h('button', { type: 'button', className: 'bg-btn secondary', disabled, onclick: () => {
            state.playerAvatarDraft = '👤'; state.playerResult = null; render()
          } }, t('player.resetAvatar')),
        ),
        h('p', { className: 'bg-field-hint' }, t('player.avatarHint')),
        fileInput,
      ),
    ),
    h('div', { className: 'bg-field' },
      h('label', { for: 'player-name' }, t('player.nameLabel')),
      h('input', {
        id: 'player-name', className: 'bg-input', type: 'text', maxlength: 32,
        value: state.playerNameDraft ?? state.config?.playerName ?? 'player',
        placeholder: 'player', disabled: state.playerSaving,
        oninput: e => { state.playerNameDraft = e.target.value; state.playerResult = null },
      }),
      h('p', { className: 'bg-field-hint' }, t('player.nameHint')),
    ),
    h('p', { className: 'bg-field-hint' }, t('player.saveHint')),
    h('button', { className: 'bg-btn', disabled, onclick: savePlayerProfile }, state.playerSaving ? t('common.saving') : t('player.save')),
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
    state.playerResult = { ok: true, text: t('player.saved', { name: state.config.playerName }) }
  } catch (error) {
    state.playerResult = { ok: false, text: errorText(error) }
  } finally {
    state.playerSaving = false
    render()
  }
}

function renderAiList() {
  return h('div', null,
    h('p', { className: 'bg-desc' }, t('ai.desc')),
    h('div', { className: 'bg-ai-list' },
      state.ais.length === 0 ? h('div', { className: 'bg-empty' }, t('ai.empty')) : null,
      state.ais.map((ai) =>
        h('div', { className: 'bg-ai-card' },
          h('div', { className: 'bg-ai-row' },
            h('span', { className: 'bg-ai-avatar', style: { background: ai.color } }, avatarContent(ai.avatar)),
            h('div', { className: 'bg-ai-info' },
              h('div', { className: 'bg-ai-name' }, ai.name),
              h('div', { className: 'bg-ai-meta' }, aiMetaText(ai))
            ),
            h('div', { className: 'bg-ai-actions' },
              h('button', { className: 'bg-btn secondary', style: { padding: '5px 10px', fontSize: '12px' }, onclick: () => { state.aiEdit = ai; render() } }, t('ai.edit')),
              h('button', { className: 'bg-btn danger', style: { padding: '5px 10px', fontSize: '12px' }, onclick: () => deleteAi(ai.id) }, t('ai.delete'))
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
    // aria-label 保持内部参数名（如 maxTurnCalls）：这是既有浏览器用例使用的稳定选择器，
    // 可见文案仍走本地化 label；不要把它换成会随语言变化的文本。
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
          ? (state.modelResult.latencyMs != null
              ? t('model.testOkLatency', { reply: state.modelResult.reply || t('model.doneFallback'), ms: state.modelResult.latencyMs })
              : t('model.testOk', { reply: state.modelResult.reply || t('model.doneFallback') }))
          : t('model.testFailed', { error: state.modelResult.error || t('model.failedFallback') }))
    : null
  const busy = state.modelBusy
  const currentBudget = t('model.currentBudget', {
    seconds: Math.round((cfg.turnTimeoutMs || 0) / 1000),
    tokens: cfg.maxPromptTokens || 0,
    steps: cfg.memorySteps || 2,
    mode: cfg.jsonMode || 'auto',
  })
  const advanced = h('details', {
    className: 'bg-advanced',
    open: state.modelAdvancedOpen,
    ontoggle: (e) => { state.modelAdvancedOpen = !!e.target.open },
  },
    h('summary', null, t('model.advanced')),
    h('p', { className: 'bg-field-hint', style: { marginTop: '8px' } }, t('model.advancedHint')),
    h('div', { className: 'bg-sec' }, t('model.sectionSampling')),
    h('div', { className: 'bg-grid-2' },
      advancedNumber(t('model.temperatureLabel'), 'temperature', { step: '0.1', min: '0', max: '2' }, t('model.temperatureHint')),
      advancedNumber('Top P', 'topP', { step: '0.05', min: '0', max: '1' }, t('model.topPHint')),
      advancedSelect(t('model.jsonModeLabel'), [
        { value: 'auto', label: 'auto' },
        { value: 'on', label: 'on' },
        { value: 'off', label: 'off' },
      ], f.jsonMode, (e) => { f.jsonMode = e.target.value }, t('model.jsonModeHint')),
      advancedNumber(t('model.maxRetriesLabel'), 'maxRetries', { step: '1', min: '1', max: '20' }, t('model.maxRetriesHint')),
      advancedNumber(t('model.timeoutLabel'), 'timeoutMs', { step: '1000', min: '1000', max: '600000' }, t('model.timeoutHint')),
      advancedNumber(t('model.maxTokensLabel'), 'maxTokens', { step: '100', min: '0', max: '100000' }, t('model.maxTokensHint')),
      advancedSelect(t('model.effortLabel'), [
        { value: '', label: t('model.effortDefault') },
        { value: 'minimal', label: 'minimal' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' },
      ], f.reasoningEffort || '', (e) => { f.reasoningEffort = e.target.value },
      t('model.effortHint')),
    ),
    h('div', { className: 'bg-sec' }, t('model.sectionBudget')),
    h('div', { className: 'bg-grid-2' },
      advancedNumber(t('model.maxTurnCallsLabel'), 'maxTurnCalls', { step: '1', min: '1', max: '100' }, t('model.maxTurnCallsHint')),
      advancedNumber(t('model.turnTimeoutLabel'), 'turnTimeoutMs', { step: '1000', min: '0', max: '3600000' }, t('model.turnTimeoutHint')),
      advancedNumber(t('model.maxPromptTokensLabel'), 'maxPromptTokens', { step: '1024', min: '0', max: '2000000' }, t('model.maxPromptTokensHint')),
      advancedNumber(t('model.memoryStepsLabel'), 'memorySteps', { step: '1', min: '1', max: '20' }, t('model.memoryStepsHint')),
    ),
    h('div', { className: 'bg-sec' }, t('model.sectionChat')),
    h('div', { className: 'bg-grid-2' },
      advancedSelect(t('model.chatEnabledLabel'), [
        { value: 'true', label: t('model.chatOn') },
        { value: 'false', label: t('model.chatOff') },
      ], String(f.chatEnabled !== false), (e) => { f.chatEnabled = e.target.value === 'true' }, t('model.chatEnabledHint')),
      advancedNumber(t('model.chatNotesMaxLabel'), 'chatNotesMax', { step: '1', min: '4', max: '100' }, t('model.chatNotesMaxHint')),
      advancedNumber(t('model.chatMaxCharsLabel'), 'chatMaxChars', { step: '50', min: '50', max: '5000' }, t('model.chatMaxCharsHint')),
      advancedNumber(t('model.chatWindowLabel'), 'chatWindow', { step: '1', min: '2', max: '100' }, t('model.chatWindowHint')),
      advancedNumber(t('model.chatCooldownLabel'), 'chatReplyCooldownMs', { step: '500', min: '0', max: '60000' }, t('model.chatCooldownHint')),
    )
  )

  return h('div', null,
    h('p', { className: 'bg-desc' }, t('model.desc')),
    env.length ? h('div', { className: 'bg-model-result err' }, t('model.envOverrides', { fields: env.join(t('common.listSeparator')) })) : null,
    h('div', { className: 'bg-field-hint', style: { marginBottom: '14px' } }, currentBudget),
    h('div', { className: 'bg-field' },
      h('label', null, t('model.apiUrlLabel')),
      input(f.baseUrl, (e) => { f.baseUrl = e.target.value }, { 'aria-label': t('model.apiUrlLabel'), placeholder: 'https://api.deepseek.com/v1', spellcheck: 'false' }),
      h('div', { className: 'bg-field-hint' }, t('model.apiUrlHint'))
    ),
    h('div', { className: 'bg-field' },
      h('label', null, t('model.apiKeyLabel')),
      h('div', { className: 'bg-model-row' },
        input(f.apiKey, (e) => { f.apiKey = e.target.value }, {
          'aria-label': t('model.apiKeyLabel'),
          type: f.showKey ? 'text' : 'password',
          placeholder: cfg.hasKey ? t('model.apiKeyPlaceholder') : 'sk-...',
          autocomplete: 'off', spellcheck: 'false',
        }),
        h('button', { className: 'bg-btn secondary bg-key-toggle', type: 'button', title: f.showKey ? t('model.hideKey') : t('model.showKey'), onclick: () => { f.showKey = !f.showKey; render() } }, f.showKey ? '🙈' : '👁')
      )
    ),
    h('div', { className: 'bg-field' },
      h('label', null, t('model.modelLabel')),
      h('div', { className: 'bg-model-row' },
        input(f.model, (e) => { f.model = e.target.value }, { 'aria-label': t('model.modelLabel'), list: listId, placeholder: 'deepseek-flash', spellcheck: 'false' }),
        h('button', { className: 'bg-btn secondary', type: 'button', disabled: !!busy, style: { flex: 'none' }, onclick: fetchModelList }, busy === 'models' ? t('model.fetching') : t('model.fetchList'))
      ),
      h('datalist', { id: listId }, state.modelList.map((m) => h('option', { value: m }))),
      state.modelList.length
        ? selectBox(
            [{ value: '', label: t('model.pickModel', { count: state.modelList.length }) }]
              .concat(state.modelList.map((model) => ({ value: model, label: model }))),
            state.modelList.includes(f.model) ? f.model : '',
            (e) => { if (e.target.value) { f.model = e.target.value; render() } }
          )
        : null
    ),
    advanced,
    result,
    h('div', { className: 'bg-modal-foot', style: { marginTop: '16px' } },
      h('button', { className: 'bg-btn secondary', type: 'button', disabled: !!busy, onclick: testModelConnection }, busy === 'test' ? t('model.testing') : t('model.test')),
      h('button', { className: 'bg-btn', type: 'button', disabled: !!busy, onclick: saveModelConfig }, busy === 'save' ? t('model.saving') : t('model.save'))
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
    state.modelResult = { ok: false, error: errorText(e) }
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
      ? { ok: true, reply: t('model.fetched', { count: state.modelList.length }) }
      : { ok: false, error: t('model.noModels') }
  } catch (e) {
    state.modelResult = { ok: false, error: errorText(e) }
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
    state.modelResult = { ok: true, reply: t('model.saved') }
  } catch (e) {
    state.modelResult = { ok: false, error: errorText(e) }
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
    state.statsError = errorText(e)
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
    state.statsError = errorText(e)
  }
  state.statsBusy = false
  render()
}

// 决策结果标签是展示文案，做成函数延迟到渲染时取当前语言。
const OUTCOME_LABEL = {
  ok: () => t('stats.outcome.ok'),
  parseError: () => t('stats.outcome.parseError'),
  validateError: () => t('stats.outcome.validateError'),
  callError: () => t('stats.outcome.callError'),
  fallback: () => t('stats.outcome.fallback'),
  noKeyFallback: () => t('stats.outcome.noKeyFallback'),
  stall: () => t('stats.outcome.stall'),
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
  const head = h('p', { className: 'bg-desc' }, t('stats.desc'))
  if (!d) {
    return h('div', null, head,
      state.statsError ? h('div', { className: 'bg-model-result err' }, '❌ ' + state.statsError) : null,
      h('div', { className: 'bg-empty' }, state.statsBusy ? t('stats.loading') : t('stats.empty')))
  }
  const totals = d.totals || {}
  const mods = Object.entries(d.byMod || {})
  const recent = d.recent || []
  return h('div', null,
    head,
    state.statsError ? h('div', { className: 'bg-model-result err' }, '❌ ' + state.statsError) : null,
    h('div', { className: 'bg-stats-grid' },
      statCell(t('stats.calls'), totals.calls || 0),
      statCell(t('stats.turns'), totals.turns || 0),
      statCell(t('stats.illegalRate'), pctText(totals.illegalRate), t('stats.illegalHint', { count: totals.validateError || 0 })),
      statCell(t('stats.fallbackRate'), pctText(totals.fallbackRate), t('stats.fallbackHint', { count: (totals.fallback || 0) + (totals.noKeyFallback || 0) })),
      statCell(t('stats.overBudgetRate'), pctText(totals.overBudgetRate), t('stats.overBudgetHint', { count: totals.overBudget || 0 })),
      statCell(t('stats.turnTimeouts'), totals.turnTimeouts || 0, t('stats.turnTimeoutsHint')),
      statCell(t('stats.avgLatency'), msText(totals.avgLatencyMs)),
      statCell(t('stats.avgPrompt'), t('stats.avgPromptChars', { count: totals.avgPromptChars || 0 }), t('stats.avgPromptHint', { tokens: totals.avgPromptTokensEst || 0 })),
      statCell(t('stats.promptTokens'), totals.promptTokensEst || 0, t('stats.promptTokensHint', { reported: totals.promptTokens || 0 }))
    ),
    h('div', { className: 'bg-sec' }, t('stats.byMod')),
    mods.length === 0 ? h('div', { className: 'bg-empty' }, t('stats.noRecords')) : h('div', { className: 'bg-stats-mods' },
      mods.map(([id, m]) => h('div', { className: 'bg-stats-mod' },
        h('span', { className: 'bg-stats-mod-name' }, id),
        h('span', null, t('stats.modLine', {
          calls: m.calls || 0,
          turns: m.turns || 0,
          steps: m.avgStepsPerTurn || 0,
          fallback: m.fallback || 0,
          illegal: m.validateError || 0,
          latency: msText(m.avgLatencyMs),
        }))
      ))
    ),
    h('div', { className: 'bg-sec' }, t('stats.recent')),
    recent.length === 0 ? h('div', { className: 'bg-empty' }, t('stats.recentEmpty')) : h('div', { className: 'bg-decisions' },
      recent.map((entry) => h('div', { className: 'bg-decision' },
        h('div', { className: 'bg-decision-head' },
          h('span', { className: 'bg-decision-outcome' }, (OUTCOME_LABEL[entry.outcome]?.() || entry.outcome || entry.kind || t('stats.record')) + (entry.reason ? t('stats.reasonSuffix', { reason: entry.reason }) : '')),
          h('span', { className: 'bg-decision-meta' },
            [entry.modId, entry.aiName, entry.model,
              entry.latencyMs != null ? entry.latencyMs + 'ms' : null,
              entry.promptTokensEst != null ? '≈' + entry.promptTokensEst + 'tk' : null,
              entry.promptOverBudget ? t('stats.overBudgetTag') : null].filter(Boolean).join(' · '))
        ),
        entry.error ? h('div', { className: 'bg-decision-line err' }, t('stats.errorPrefix', { error: entry.error })) : null,
        entry.move ? h('div', { className: 'bg-decision-line' }, t('stats.movePrefix', { move: JSON.stringify(entry.move) })) : null,
        entry.replyExcerpt ? h('div', { className: 'bg-decision-line dim' }, t('stats.replyPrefix', { reply: entry.replyExcerpt })) : null
      ))
    ),
    h('div', { className: 'bg-modal-foot' },
      h('button', { className: 'bg-btn danger', type: 'button', disabled: state.statsBusy, onclick: resetAgentStats }, state.statsBusy ? t('common.processing') : t('stats.clear')),
      h('button', { className: 'bg-btn secondary', type: 'button', disabled: state.statsBusy, onclick: loadStats }, t('common.refresh'))
    )
  )
}

function aiMetaText(ai) {
  return ai.persona || t('ai.noPersona')
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
    placeholder: t('ai.personaPlaceholder'),
  })
  personaEl.value = draft.persona
  personaEl.addEventListener('input', (e) => { draft.persona = e.target.value })

  const avatarPreview = h('span', { className: 'bg-ai-avatar bg-ai-avatar-preview', style: { background: draft.color } }, avatarContent(draft.avatar))
  const avatarHint = h('div', { className: 'bg-field-hint' }, isImageAvatar(draft.avatar) ? t('ai.avatarImage') : t('ai.avatarHint'))
  const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, 'aria-label': t('ai.uploadAvatarAria') })
  const avatarText = textInput(isImageAvatar(draft.avatar) ? '' : draft.avatar, (e) => {
    draft.avatar = e.target.value
    syncAvatar(true)
  }, { style: { width: '80px', flex: 'none' }, placeholder: t('ai.avatarPlaceholder'), 'aria-label': t('ai.avatarAria') })
  const colorInput = textInput(draft.color, (e) => {
    draft.color = e.target.value
    avatarPreview.style.background = draft.color
  }, { type: 'color', style: { width: '46px', flex: 'none', padding: '2px' }, 'aria-label': t('ai.colorAria') })

  function syncAvatar(keepInputValue) {
    avatarPreview.replaceChildren(avatarContent(draft.avatar))
    avatarPreview.style.background = draft.color
    const image = isImageAvatar(draft.avatar)
    avatarHint.textContent = image ? t('ai.avatarImage') : t('ai.avatarHint')
    avatarText.value = image && !keepInputValue ? '' : draft.avatar
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    avatarHint.textContent = t('ai.processingImage')
    try {
      draft.avatar = await fileToAvatar(file)
      syncAvatar()
    } catch (err) {
      avatarHint.textContent = String(err && err.message ? err.message : err)
    }
  })

  const form = h('div', null,
    h('div', { className: 'bg-sec' }, t('ai.sectionAppearance')),
    h('div', { className: 'bg-avatar-edit' },
      avatarPreview,
      h('div', { className: 'bg-avatar-edit-body' },
        h('div', { className: 'bg-avatar-actions' },
          h('button', { type: 'button', className: 'bg-btn secondary', onclick: () => fileInput.click() }, t('ai.uploadImage')),
          h('button', { type: 'button', className: 'bg-btn secondary', onclick: () => { draft.avatar = '🤖'; syncAvatar() } }, t('ai.useEmoji'))
        ),
        avatarHint,
        fileInput
      )
    ),
    h('div', { className: 'bg-row-3' },
      avatarText,
      textInput(draft.name, (e) => { draft.name = e.target.value }, { style: { flex: 1 }, placeholder: t('ai.namePlaceholder') }),
      colorInput
    ),
    h('div', { className: 'bg-sec' }, t('ai.sectionPersona')),
    h('div', { className: 'bg-field' },
      h('label', null, t('ai.personaLabel')),
      personaEl
    )
  )

  return h('div', { className: 'bg-backdrop' },
    h('div', { className: 'bg-modal', onclick: (e) => e.stopPropagation() },
      h('h2', null, t('ai.editorTitle', { name: draft.name })),
      h('p', { className: 'bg-desc' }, t('ai.editorDesc')),
      form,
      h('div', { className: 'bg-modal-foot' },
        h('button', { className: 'bg-btn secondary', onclick: () => { state.aiEdit = null; render() } }, t('common.cancel')),
        h('button', { className: 'bg-btn', disabled: state.busy, onclick: () => saveAi(draft) }, state.busy ? t('common.saving') : t('common.save'))
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
  } catch (e) { state.error = errorText(e) }
  state.busy = false; render()
}

async function createAi() {
  state.busy = true; render()
  try {
    const r = await api('POST', '/ais', {
      ai: { name: t('ai.defaultName'), avatar: '🤖', color: '#8a8a8a', persona: '' },
    })
    state.ais = r.ais || []
    state.aiEdit = r.saved
  } catch (e) { state.error = errorText(e) }
  state.busy = false; render()
}

async function deleteAi(id) {
  state.busy = true; render()
  try {
    const r = await api('POST', '/ais/delete', { id })
    state.ais = r.ais || []
  } catch (e) { state.error = errorText(e) }
  state.busy = false; render()
}

// ---------------------------------------------------------------------------
// 对局
// ---------------------------------------------------------------------------

// Mod 自带的界面模块加载失败时，非棋盘游戏没有可用的通用界面：
// 不要让玩家永远停在「正在加载…」，把原因和退出口一起给出来。
function modGameUnavailable(game, session) {
  return !!game && modFailed.has(game.id) && !(session.render && session.render.kind === 'board')
}

function renderGameUnavailable(game, session) {
  const detail = modErrors.get(game.id)
  const name = localizedModName(session.modId, session.modName)
  return h('div', { className: 'bg-empty' },
    h('p', { role: 'alert' }, detail
      ? t('game.uiFailedWithDetail', { game: name, error: detail })
      : t('game.uiFailedPlain', { game: name })),
    h('p', null, t('game.uiFailedHint')),
    h('button', { className: 'bg-btn secondary', onclick: leave }, t('game.backToLibrary')))
}

function renderGame(s) {
  const game = state.catalog.find((g) => g.id === s.modId)
  // Mod 自带界面优先；大厅只兜底通用的方格棋盘。
  const custom = modUiFor(game)?.renderGame?.(s)
  if (custom) return custom
  if (modGameUnavailable(game, s)) return renderGameUnavailable(game, s)
  if (modUiPending(game)) loadModUi(game)
  const modName = localizedModName(s.modId, s.modName)
  if (modUiPending(game) || (s.render && s.render.kind !== 'board')) {
    return h('div', { className: 'bg-empty' }, t('game.loadingUi', { game: modName }))
  }
  const over = s.state.status !== 'playing'
  const current = s.players[s.state.currentSeat]
  const pieceStyle = (s.render && s.render.pieceStyle) || 'stone'
  const sideLabel = pieceStyle === 'mark'
    ? (c) => (c === 'black' ? 'X' : 'O')
    : (c) => (c === 'black' ? t('game.sideBlack') : t('game.sideWhite'))
  let statusText
  if (s.state.status === 'over') statusText = s.state.winnerSeat != null ? t('game.winner', { name: s.players[s.state.winnerSeat].name }) : t('game.draw')
  else statusText = current.seat === (s.mySeat ?? 0)
    ? t('game.yourTurn', { side: sideLabel(current.color) })
    : (current.role === 'ai' ? t('game.aiThinking', { name: current.name }) : t('game.opponentMoving', { name: current.name }))

  const speeches = (s.events || []).filter((e) => e.type === 'speech').slice(-5).reverse()

  return h('div', { className: 'bg-game' },
    h('div', { className: 'bg-game-head' },
      h('div', { className: 'bg-game-title' }, modName),
      h('div', { className: 'bg-game-status' + (over ? ' bg-over' : '') }, statusText),
      h('div', { className: 'bg-game-actions' },
        feedbackUi.iconButton(),
        h('button', { className: 'bg-btn secondary', disabled: s.online && s.mySeat !== 0, onclick: reset }, t('game.playAgain')),
        h('button', { className: 'bg-btn secondary', onclick: leave }, t('game.leave'))
      )
    ),
    h('div', { className: 'bg-game-body' },
      renderBoard(s)
    ),
    h('div', { className: 'bg-players' },
      speeches.length > 0 ? h('div', { className: 'bg-speeches' }, speeches.map((e) => {
        const p = s.players[e.seat]
        return h('div', { className: 'bg-speech' },
          h('span', { className: 'bg-speech-name', style: { color: p.colorHex } }, t('game.speechName', { name: p.name })),
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
    // P1.2：联机客人拿到的命令响应不含 session（快照随后由长轮询送达），此时保留乐观状态，
    // 等 accept() 用权威快照覆盖；只有房主 / 本地对局才会直接拿到 session。
    if (r.session) { state.session = r.session; rememberSession(r.session.sessionId) }
    else if (r.sessionId) rememberSession(r.sessionId)
  } catch (e) {
    // 服务端拒绝时回滚到服务端返回的最新状态（或落子前状态）。
    state.session = e.session || original
    state.error = errorText(e)
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
      state.error = errorText(e)
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
  } catch (e) { state.error = errorText(e) }
  state.busy = false; render()
}

function leave() {
  if (state.online?.room) {
    onlineUi.leave().catch(error => { state.error = errorText(error); render() })
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
  return player && player.name ? player.name : t('chat.seatName', { seat })
}

function resetChatState() {
  state.chat.error = null
  state.chat.notice = null
}

function chatAvatar(session, seat) {
  const player = session.players.find(item => item.seat === seat)
  return h('span', { className: 'bg-chat-avatar', role: 'img', 'aria-label': t('chat.avatarAria', { name: chatSeatName(session, seat) }) },
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
  // 牌桌 Mod 可自行在座位旁显示新消息；这里只抑制消息 toast，聊天入口和未读红点照常保留。
  const chatAtSeats = modUiFor(state.catalog.find(game => game.id === session.modId))?.chatPresentation === 'seats'
  clearTimeout(chatToastTimer)
  if (hidden) return null
  const surface = h('div', { className: 'bg-chat-surface' })
  const openChannel = channel => { state.chat.channel = channel; state.chat.open = true; resetChatState(); render() }
  if (notifications.toasts.length && !chatAtSeats) {
    surface.append(h('div', { className: 'bg-chat-toasts', role: 'status', 'aria-live': 'polite', 'aria-label': t('chat.newMessagesAria') },
      notifications.toasts.map(({event}) => h('div', { className: 'bg-chat-toast', 'data-chat-seq': event.seq },
        h('button', { className: 'bg-chat-toast-open', onclick: () => openChannel(chatChannel(event, session.mySeat ?? 0)), 'aria-label': t('chat.viewMessageAria', { name: chatSeatName(session,event.seat) }) },
          chatAvatar(session,event.seat), h('span', { className: 'bg-chat-toast-copy' },
            h('strong', {}, chatSeatName(session,event.seat), event.to == null ? '' : t('chat.privateSuffix')), h('span', {}, event.text))),
        h('button', { className: 'bg-chat-toast-close', 'aria-label': t('chat.closeToastAria'), onclick: () => { chatNotifications.dismiss(session.sessionId,event.seq); refreshChatSurface() } }, '×')))))
    chatToastTimer = setTimeout(refreshChatSurface, Math.max(1, Math.min(...notifications.toasts.map(t => t.expires)) - Date.now()))
  }
  if (!state.chat.open) {
    surface.append(h('button', {
      className: 'bg-chat-fab',
      title: notifications.total ? t('chat.unreadTitle', { count: notifications.total }) : t('chat.title'),
      'aria-label': t('chat.openAria'), 'aria-description': notifications.total ? t('chat.unreadTitle', { count: notifications.total }) : t('chat.noUnread'),
      onclick: () => { state.chat.open = true; resetChatState(); render() },
    }, '💬', notifications.total ? h('span', { className: 'bg-chat-unread', 'aria-label': t('chat.unreadTitle', { count: notifications.total }) }, notifications.total > 99 ? '99+' : notifications.total) : null))
    return surface
  }
  surface.append(h('div', { className: 'bg-chat-drawer', role: 'dialog', 'aria-label': t('chat.title') },
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
      channelBtn('table', t('chat.tabTable'), t('chat.tabTableTitle')),
      ...ais.map((player) => channelBtn(String(player.seat), t('chat.tabPrivate', { name: player.name }), t('chat.tabPrivateTitle')))
    ),
    h('button', {
      className: 'bg-chat-close',
      title: t('chat.collapse'),
      'aria-label': t('chat.collapseAria'),
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
    'aria-label': t('chat.notesToggleAria'),
    onclick: () => { state.chat.notesOpen = !open; render() },
  }, t('chat.notesHead', { used: notes.length, max }) + (open ? ' ▾' : ' ▸'))
  if (!open) return h('div', { className: 'bg-chat-notes' }, head)

  const body = h('div', { className: 'bg-chat-notes-body' })
  if (!notes.length) {
    body.append(h('div', { className: 'bg-chat-empty' }, t('chat.notesEmpty')))
  }
  for (const note of notes) {
    body.append(h('div', { className: 'bg-chat-note' },
      h('span', { className: 'bg-chat-note-scope' }, note.scope === 'seat' ? t('chat.tabPrivate', { name: chatSeatName(session, note.seat) }) : t('chat.scopeTeam')),
      h('span', { className: 'bg-chat-note-text' }, note.text),
      readOnly ? null : h('button', { className: 'bg-chat-note-btn', title: t('chat.editNoteTitle'), 'aria-label': t('chat.editNoteAria'), onclick: () => editNote(note) }, '✏️'),
      readOnly ? null : h('button', { className: 'bg-chat-note-btn', title: t('chat.deleteNoteTitle'), 'aria-label': t('chat.deleteNoteAria'), onclick: () => deleteNote(note.id) }, '🗑')
    ))
  }
  body.append(readOnly
    ? h('div', { className: 'bg-chat-note-hint' }, t('chat.notesReadOnlyHint'))
    : h('button', { className: 'bg-btn secondary bg-chat-note-clear', onclick: clearNotes }, t('chat.clearNotes')))
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
  const list = h('div', { className: 'bg-chat-list', 'aria-label': t('chat.listAria') })
  if (!messages.length) {
    list.append(h('div', { className: 'bg-chat-empty' }, to === null
      ? t('chat.emptyTable')
      : t('chat.emptyPrivate')))
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
          title: t('chat.pinTitle'),
          'aria-label': t('chat.pinTitle'),
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
    { value: '@全体 ', label: t('chat.mentionAll'), hint: t('chat.mentionAllHint'), icon: '📣' },
    ...chatAiSeats(session).map((player) => ({
      value: '@' + player.name + ' ',
      label: player.name,
      hint: t('chat.mentionOneHint', { name: player.name }),
      avatar: player.avatar,
    })),
  ]
}

function chatCommandOptions() {
  const fallback = [
    { usage: '/备忘 <内容>', summary: t('chat.cmdRemember') },
    { usage: '/清除备忘', summary: t('chat.cmdClear') },
    { usage: '/help', summary: t('chat.cmdHelp') },
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
      h('div', { className: 'bg-chat-suggest-title' }, context.kind === 'command' ? t('chat.suggestCommands') : t('chat.suggestRecipients')),
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
    state.chat.pendings.length ? h('div', { className: 'bg-chat-pending-status', role: 'status' }, t('chat.pending')) : null
  )
}

function renderChatCompose(session) {
  const maxChars = (state.config && state.config.chatMaxChars) || 500
  const textarea = h('textarea', {
    className: 'bg-chat-input',
    rows: 2,
    maxlength: maxChars,
    'aria-label': t('chat.inputAria'),
    placeholder: state.chat.channel === 'table' ? t('chat.placeholderTable') : t('chat.placeholderPrivate'),
  })
  textarea.value = state.chat.draft || ''
  const suggest = h('div', { className: 'bg-chat-suggest', role: 'listbox', 'aria-label': t('chat.suggestAria'), hidden: true })
  const send = h('button', {
    className: 'bg-btn bg-chat-send',
    disabled: state.busy,
    onclick: () => sendChat(),
  }, t('chat.send'))
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
      ? t('chat.hintMentions')
      : t('chat.hintCommands'))
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
      state.chat.notice = t('chat.noticeInflight')
    } else if (chat.skipped === 'cooldown') {
      state.chat.notice = t('chat.noticeCooldown', { seconds: Math.ceil((chat.retryAfterMs || 0) / 1000) })
    }
    if (chat.compacted) state.chat.notice = t('chat.noticeCompacted', { count: chat.compacted })
    else if (chat.notesAdded || chat.notesUpdated || chat.notesRemoved) {
      if (!chat.notice) {
        const parts = []
        if (chat.notesAdded) parts.push(t('chat.noteAdded', { count: chat.notesAdded }))
        if (chat.notesUpdated) parts.push(t('chat.noteUpdated', { count: chat.notesUpdated }))
        if (chat.notesRemoved) parts.push(t('chat.noteRemoved', { count: chat.notesRemoved }))
        state.chat.notice = t('chat.noticeNotes', { parts: parts.join(t('common.listSeparator')) })
      }
      state.chat.notesOpen = true
    }
  } catch (err) {
    state.chat.error = errorText(err)
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
      state.chat.notice = (result.chat && result.chat.notice) || t('chat.noticePinned')
      state.chat.notesOpen = true
    } else {
      const result = await api('POST', '/notes/add', {
        sessionId: session.sessionId,
        text: event.text,
        to: event.to == null ? null : Number(event.to),
        evidence: Number.isInteger(event.seq) ? event.seq : null,
      })
      state.session = result.session
      state.chat.notice = t('chat.noticePinned')
      state.chat.notesOpen = true
    }
  } catch (err) {
    state.chat.error = errorText(err)
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
    state.chat.error = errorText(err)
  }
  render()
}

async function editNote(note) {
  const session = state.session
  if (!session) return
  const next = window.prompt(t('chat.notePrompt'), note.text)
  if (next == null) return
  resetChatState()
  try {
    const result = await api('POST', '/notes/update', { sessionId: session.sessionId, noteId: note.id, text: String(next).trim() })
    state.session = result.session
  } catch (err) {
    state.chat.error = errorText(err)
  }
  render()
}

async function clearNotes() {
  const session = state.session
  if (!session) return
  if (!window.confirm(t('chat.clearConfirm'))) return
  resetChatState()
  try {
    const result = await api('POST', '/notes/clear', { sessionId: session.sessionId })
    state.session = result.session
    state.chat.notice = t('chat.noticeCleared')
  } catch (err) {
    state.chat.error = errorText(err)
  }
  render()
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot() {
  try {
    // /api/settings 用 .catch(() => null) 隔离：旧服务端 / 临时失败不阻塞大厅（docs/localization.md §5.4）。
    const [g, a, c, s] = await Promise.all([
      api('GET', '/catalog'),
      api('GET', '/ais'),
      api('GET', '/config'),
      api('GET', '/settings').catch(() => null),
    ])
    state.settings = s?.settings || { schema: 1, locale: 'zh-CN' }
    state.locales = Array.isArray(s?.locales) && s.locales.length ? s.locales : [{ id: 'zh-CN', label: '简体中文' }]
    // setLocale() 必须在首次 render() 之前执行，避免先渲染中文再闪成英文。
    if (!s) console.warn('[i18n] GET /api/settings 不可用，回退 zh-CN')
    setLocale(state.settings.locale)
    state.catalog = g.games || []
    state.ais = a.ais || []
    state.config = c
    updatesUi.boot()
    // 刷新 / 服务端重启后自动回到上一局（服务端已把对局落盘）
    await onlineUi.boot()
    if (!state.online?.room) await resumeSession()
  } catch (e) { state.error = errorText(e) }
  render()
}

boot()

// 渲染基准：在同一份状态上反复整树重绘，并强制同步布局，得到可对比的渲染耗时。
if (PERF_RENDER) {
  window.__HALL_RENDER_MS__ = window.__HALL_RENDER_MS__ || []
  window.__HALL_BENCH_RENDER__ = (times = 20) => {
    const out = []
    for (let i = 0; i < times; i++) {
      const started = performance.now()
      render({ force: true })
      document.body.offsetHeight
      out.push(performance.now() - started)
    }
    return out
  }
}
