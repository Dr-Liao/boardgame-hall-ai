// 游戏内反馈弹窗：把飞书多维表格表单嵌进大厅，顶部一键复制诊断信息。
//
// 两个设计约束：
//   1. 弹窗挂在 document.body 上，不进 app.js 的 render()。
//      大厅任何状态变化都会整页重绘（root.replaceChildren），重绘会重建 iframe，
//      玩家填到一半的内容就没了。这里做成独立 portal，只在打开/关闭时创建和销毁。
//   2. 表单是跨域的，不能预填、也读不到提交结果。版本信息只能通过剪贴板交给玩家自己粘贴；
//      「提交成功」由玩家在表单里看到，大厅这边不做假提示。
//
// 本地化（docs/localization.md §6.2）：所有用户可见文案走 t()。因为弹窗是 portal、不参与
// 大厅 render()，切换语言时由 onLocaleChange() 就地更新文本，不重建 iframe（避免丢失已填内容）。

import { t } from './i18n.js'

export const FEISHU_FORM_URL = 'https://my.feishu.cn/share/base/form/shrc6uDSVoM1wuWS7AB5K0pPtMg'

// 允许表单自己的脚本、表单提交、上传和弹窗；不给 top-navigation，
// 防止被嵌页面把整个大厅导航走（沙箱外它可以 top.location = ...）。
const IFRAME_SANDBOX = [
  'allow-scripts', 'allow-same-origin', 'allow-forms',
  'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-downloads', 'allow-modals',
].join(' ')

const LOAD_FALLBACK_MS = 12000
const COPY_RESET_MS = 4000
const ERROR_MAX_CHARS = 300

/**
 * 生成要复制的诊断信息。只带排障必需的环境信息，不带 API Key、密钥、存档路径或聊天内容。
 * 放在这里导出，方便单元测试在不启浏览器的情况下覆盖格式和脱敏。
 */
export function buildDiagnostics({ hallVersion = '', state = null, nav = globalThis.navigator, now = new Date() } = {}) {
  const head = [t('app.title') + (hallVersion ? ' v' + hallVersion : '')]
  const platform = describePlatform(nav)
  if (platform) head.push(platform)
  const game = state?.session?.modName || state?.setup?.game?.name
  if (game) head.push(t('feedback.diagnostics.game', { game }))
  const lines = [head.join(' · '), t('feedback.diagnostics.time', { time: formatTime(now) })]
  const error = typeof state?.error === 'string' ? state.error.replace(/\s+/g, ' ').trim() : ''
  if (error) lines.push(t('feedback.diagnostics.error', { error: error.slice(0, ERROR_MAX_CHARS) }))
  return lines.join('\n')
}

/** 平台 + 浏览器主版本，例如「Windows · Edge 140」；识别不出来时返回空串。 */
export function describePlatform(nav = globalThis.navigator) {
  if (!nav) return ''
  const ua = String(nav.userAgent || '')
  const platform = nav.userAgentData?.platform || platformFromUserAgent(ua)
  const browser = browserFromUserAgent(ua)
  return [platform, browser].filter(Boolean).join(' · ')
}

function platformFromUserAgent(ua) {
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return ''
}

function browserFromUserAgent(ua) {
  const edge = /Edg\/(\d+)/.exec(ua)
  if (edge) return 'Edge ' + edge[1]
  const chrome = /Chrome\/(\d+)/.exec(ua)
  if (chrome) return 'Chrome ' + chrome[1]
  const firefox = /Firefox\/(\d+)/.exec(ua)
  if (firefox) return 'Firefox ' + firefox[1]
  const safari = /Version\/(\d+).*Safari/.exec(ua)
  if (safari) return 'Safari ' + safari[1]
  return ''
}

// 诊断信息里的时间是给排障用的固定格式（YYYY-MM-DD HH:mm），刻意不随界面语言变化：
// 保持可读、可粘贴、可跨语言比对；feedback 单测也锁定这个格式。
function formatTime(date) {
  const pad = value => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

// 剪贴板：优先异步 API（localhost 属于安全上下文），被拒绝时退回 execCommand。
async function writeClipboard(text) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch { return false }
}

/**
 * @param {object} options
 * @param {(tag: string, props?: object, ...children: any[]) => HTMLElement} options.h 大厅的 DOM 构造器
 * @param {object} options.state 只读地读取 error / session / setup
 * @param {(method: string, pathname: string, body?: object) => Promise<any>} [options.request] 用于补取大厅版本
 * @param {string} [options.formUrl] 覆盖表单地址（测试或换表时用）
 */
export function createFeedbackUI({ h, state, request, formUrl = FEISHU_FORM_URL }) {
  let backdrop = null
  let loadTimer = null
  let resetTimer = null
  let diagnostics = ''
  let hallVersion = ''
  let preview = null
  let copyButton = null
  let status = null
  let copyState = 'idle'          // 'idle' | 'copied' | 'failed'
  let loadingSlow = false
  // 本地化绑定：语言切换时就地重写文本/属性，不重建 DOM（iframe 里填了一半的内容要保留）。
  let bindings = []

  const copyButtonText = () => copyState === 'copied' ? t('feedback.copied')
    : copyState === 'failed' ? t('feedback.copyFailed') : t('feedback.copyDiagnostics')
  const copyStatusText = () => copyState === 'copied' ? t('feedback.copiedStatus')
    : copyState === 'failed' ? t('feedback.copyDeniedStatus') : ''

  function bindText(el, get) { bindings.push({ el, get }); el.textContent = get() }
  function bindAttr(el, attr, get) { bindings.push({ el, get, attr }); el.setAttribute(attr, get()) }
  function applyTexts() {
    for (const item of bindings) {
      const text = item.get()
      if (item.attr) item.el.setAttribute(item.attr, text)
      else item.el.textContent = text
    }
  }

  function open() {
    if (backdrop) return
    copyState = 'idle'
    loadingSlow = false
    bindings = []
    const body = h('div', { className: 'bg-feedback-body' })
    const loading = h('div', { className: 'bg-feedback-loading' })
    const frame = h('iframe', {
      className: 'bg-feedback-frame',
      src: formUrl,
      sandbox: IFRAME_SANDBOX,
      referrerpolicy: 'no-referrer',
      onload: () => { clearTimeout(loadTimer); loading.hidden = true },
    })
    bindAttr(frame, 'title', () => t('feedback.frameTitle'))
    bindText(loading, () => loadingSlow ? t('feedback.slowLoad') : t('feedback.loadingForm'))
    body.append(frame, loading)

    copyButton = h('button', { type: 'button', className: 'bg-btn secondary bg-feedback-copy', disabled: true, onclick: copy })
    bindText(copyButton, copyButtonText)
    status = h('span', { className: 'bg-feedback-status', role: 'status', 'aria-live': 'polite' })
    bindText(status, copyStatusText)
    preview = h('code', { className: 'bg-feedback-preview' })
    bindText(preview, () => diagnostics ? diagnostics.split('\n')[0] : t('feedback.readingVersion'))

    const heading = h('h2', null)
    bindText(heading, () => t('feedback.title'))
    const lead = h('p', { className: 'bg-feedback-lead' })
    bindText(lead, () => t('feedback.lead'))
    const openLink = h('a', { className: 'bg-feedback-open', href: formUrl, target: '_blank', rel: 'noopener' })
    bindText(openLink, () => t('feedback.openInBrowser'))
    const closeButton = h('button', { type: 'button', className: 'bg-feedback-close', onclick: close }, '×')
    bindAttr(closeButton, 'aria-label', () => t('feedback.closeLabel'))

    backdrop = h('div', {
      className: 'bg-feedback-backdrop',
      role: 'dialog', 'aria-modal': 'true',
      onclick: event => { if (event.target === backdrop) close() },
    },
      h('section', { className: 'bg-feedback-modal' },
        h('header', { className: 'bg-feedback-head' },
          h('div', { className: 'bg-feedback-heading' }, heading, lead),
          h('div', { className: 'bg-feedback-tools' },
            copyButton,
            openLink,
            closeButton)),
        h('div', { className: 'bg-feedback-meta' },
          preview,
          status),
        body))
    bindAttr(backdrop, 'aria-label', () => t('feedback.dialogLabel'))
    document.body.append(backdrop)
    document.addEventListener('keydown', onKeydown)
    closeButton.focus({ preventScroll: true })
    loadTimer = setTimeout(() => {
      if (loading.hidden) return
      loadingSlow = true
      loading.textContent = t('feedback.slowLoad')
    }, LOAD_FALLBACK_MS)
    void refreshDiagnostics()
  }

  async function refreshDiagnostics() {
    if (!hallVersion) hallVersion = state?.updates?.hallVersion || ''
    if (!hallVersion && typeof request === 'function') {
      try { hallVersion = (await request('GET', '/updates'))?.hallVersion || '' } catch {}
    }
    // 读取期间玩家可能已经关掉弹窗。
    if (!backdrop) return
    diagnostics = buildDiagnostics({ hallVersion, state })
    if (preview) preview.textContent = diagnostics.split('\n')[0]
    if (copyButton) {
      copyButton.disabled = false
      copyButton.title = diagnostics
    }
  }

  async function copy() {
    if (!diagnostics) return
    const copied = await writeClipboard(diagnostics)
    copyState = copied ? 'copied' : 'failed'
    if (copyButton) copyButton.textContent = copyButtonText()
    if (status) status.textContent = copyStatusText()
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copyState = 'idle'
      if (copyButton) copyButton.textContent = copyButtonText()
      if (status) status.textContent = ''
    }, COPY_RESET_MS)
  }

  function close() {
    if (!backdrop) return
    clearTimeout(loadTimer)
    clearTimeout(resetTimer)
    document.removeEventListener('keydown', onKeydown)
    backdrop.remove()
    backdrop = null
    preview = null
    copyButton = null
    status = null
    bindings = []
    diagnostics = ''
    copyState = 'idle'
  }

  function onKeydown(event) {
    if (!backdrop || event.defaultPrevented || event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  /**
   * 语言切换钩子（hall-shell 在 setLocale() 之后调用）：就地刷新弹窗文案，保留 iframe 状态与已填内容。
   * 弹窗未打开时无需处理——下次 open() 会用当前语言重新构造。
   */
  function onLocaleChange() {
    if (!backdrop || !bindings.length) return
    applyTexts()
    void refreshDiagnostics()
  }

  /** 大厅里用的入口按钮：和「加入联机房间」同一套样式。 */
  function button() {
    return h('button', { type: 'button', className: 'bg-btn secondary', onclick: open }, t('feedback.entryButton'))
  }

  /** 对局顶部用的紧凑入口：只留图标，避免挤掉状态文字。 */
  function iconButton() {
    return h('button', { type: 'button', className: 'bg-btn secondary', title: t('feedback.iconTitle'), 'aria-label': t('feedback.iconTitle'), onclick: open }, '💬')
  }

  return { open, close, button, iconButton, onLocaleChange, isOpen: () => !!backdrop }
}
