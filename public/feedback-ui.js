// 游戏内反馈弹窗：把飞书多维表格表单嵌进大厅，顶部一键复制诊断信息。
//
// 两个设计约束：
//   1. 弹窗挂在 document.body 上，不进 app.js 的 render()。
//      大厅任何状态变化都会整页重绘（root.replaceChildren），重绘会重建 iframe，
//      玩家填到一半的内容就没了。这里做成独立 portal，只在打开/关闭时创建和销毁。
//   2. 表单是跨域的，不能预填、也读不到提交结果。版本信息只能通过剪贴板交给玩家自己粘贴；
//      「提交成功」由玩家在表单里看到，大厅这边不做假提示。

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
  const head = ['桌游大厅' + (hallVersion ? ' v' + hallVersion : '')]
  const platform = describePlatform(nav)
  if (platform) head.push(platform)
  const game = state?.session?.modName || state?.setup?.game?.name
  if (game) head.push('游戏：' + game)
  const lines = [head.join(' · '), '时间：' + formatTime(now)]
  const error = typeof state?.error === 'string' ? state.error.replace(/\s+/g, ' ').trim() : ''
  if (error) lines.push('最近错误：' + error.slice(0, ERROR_MAX_CHARS))
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
  let preview = null
  let copyButton = null
  let status = null

  function open() {
    if (backdrop) return
    const body = h('div', { className: 'bg-feedback-body' })
    const loading = h('div', { className: 'bg-feedback-loading' }, '正在加载反馈表单…')
    const frame = h('iframe', {
      className: 'bg-feedback-frame',
      src: formUrl,
      title: '桌游大厅反馈表单',
      sandbox: IFRAME_SANDBOX,
      referrerpolicy: 'no-referrer',
      onload: () => { clearTimeout(loadTimer); loading.hidden = true },
    })
    body.append(frame, loading)

    copyButton = h('button', {
      type: 'button', className: 'bg-btn secondary bg-feedback-copy', disabled: true,
      onclick: copy,
    }, '📋 一键复制诊断信息')
    status = h('span', { className: 'bg-feedback-status', role: 'status', 'aria-live': 'polite' })
    preview = h('code', { className: 'bg-feedback-preview' }, '正在读取版本信息…')

    backdrop = h('div', {
      className: 'bg-feedback-backdrop',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': '反馈',
      onclick: event => { if (event.target === backdrop) close() },
    },
      h('section', { className: 'bg-feedback-modal' },
        h('header', { className: 'bg-feedback-head' },
          h('div', { className: 'bg-feedback-heading' },
            h('h2', null, '💬 反馈'),
            h('p', { className: 'bg-feedback-lead' }, '问题或建议都可以写在这里，提交后直接进「桌游大厅问卷」。首次打开如遇到飞书的「AI 语音录入」提示，点 × 关掉即可。')),
          h('div', { className: 'bg-feedback-tools' },
            copyButton,
            h('a', { className: 'bg-feedback-open', href: formUrl, target: '_blank', rel: 'noopener' }, '在浏览器打开'),
            h('button', { type: 'button', className: 'bg-feedback-close', 'aria-label': '关闭反馈', onclick: close }, '×'))),
        h('div', { className: 'bg-feedback-meta' },
          preview,
          status),
        body))
    document.body.append(backdrop)
    document.addEventListener('keydown', onKeydown)
    backdrop.querySelector('.bg-feedback-close')?.focus({ preventScroll: true })
    loadTimer = setTimeout(() => {
      if (loading.hidden) return
      loading.textContent = '表单加载较慢，可点右上角「在浏览器打开」'
    }, LOAD_FALLBACK_MS)
    void refreshDiagnostics()
  }

  async function refreshDiagnostics() {
    let hallVersion = state?.updates?.hallVersion || ''
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
    if (copyButton) copyButton.textContent = copied ? '✅ 已复制' : '复制失败，请手动选择'
    if (status) status.textContent = copied ? '已复制，粘贴到「游戏环境」或「问题描述」' : '浏览器拒绝了剪贴板访问，可手动复制预览'
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      if (copyButton) copyButton.textContent = '📋 一键复制诊断信息'
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
    diagnostics = ''
  }

  function onKeydown(event) {
    if (!backdrop || event.defaultPrevented || event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  /** 大厅里用的入口按钮：和「加入联机房间」同一套样式。 */
  function button() {
    return h('button', { type: 'button', className: 'bg-btn secondary', onclick: open }, '💬 反馈')
  }

  /** 对局顶部用的紧凑入口：只留图标，避免挤掉状态文字。 */
  function iconButton() {
    return h('button', { type: 'button', className: 'bg-btn secondary', title: '反馈', 'aria-label': '反馈', onclick: open }, '💬')
  }

  return { open, close, button, iconButton, isOpen: () => !!backdrop }
}
