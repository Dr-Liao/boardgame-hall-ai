// 设置 · 大厅更新 + 大厅「游戏中心」弹窗（游戏商店）。
// 只与 /api/updates、/api/store/* 通信；下载在服务端后台进行，这里轮询进度。
//
// 本地化（docs/localization.md §5.5/§6.2）：用户可见文案走 t()；日期走 formatDate()
// （跟随大厅当前语言，替代原来不指定语言的 toLocaleString()），数字走 formatNumber()。
// 本模块不缓存成句文案：每次 render 重新取 t()，onLocaleChange() 只需清错误提示并按需重拉视图。

import { t, formatDate, formatNumber } from './i18n.js'

export function createUpdatesUI({ h, state, render, request, reloadCatalog }) {
  state.updates = null
  state.gameCenterOpen = false
  state.updatesBusy = null       // 'check' | 'settings' | 'restart' | 'hall' | 'game:<id>'
  state.updatesError = null
  state.updatesMirrorDraft = null
  let pollTimer = null
  let restarting = false

  const activeWork = view => view?.hall?.download?.state === 'downloading'
    || (view?.store?.games || []).some(game => game.state === 'installing')

  function apply(view) {
    const before = new Map((state.updates?.store?.games || []).map(game => [game.id, game]))
    state.updates = view
    // 安装完成（新游戏已热加载）或卸载后刷新大厅目录。
    const changed = (view.store?.games || []).some(game => {
      const old = before.get(game.id)
      return old && ((old.state === 'installing' && game.state === 'idle') || (!!old.installed !== !!game.installed))
    })
    if (changed) reloadCatalog()
    clearTimeout(pollTimer)
    if (activeWork(view)) pollTimer = setTimeout(() => load().catch(() => {}), 1000)
    else if (view.checkPending) pollTimer = setTimeout(() => load().catch(() => {}), 2000)
  }

  async function load() {
    const view = await request('GET', '/updates')
    apply(view)
    render()
    return view
  }

  async function act(busy, method, pathname, body) {
    state.updatesBusy = busy
    state.updatesError = null
    render()
    try {
      apply(await request(method, pathname, body))
    } catch (error) {
      state.updatesError = error.message
    } finally {
      state.updatesBusy = null
      render()
    }
  }

  async function restart() {
    let body = {}
    for (;;) {
      try {
        state.updatesBusy = 'restart'
        render()
        await request('POST', '/updates/restart', body)
        break
      } catch (error) {
        if (error.code === 'ONLINE_ACTIVE' && !body.force && confirm(t('updates.confirm.restart'))) { body = { force: true }; continue }
        state.updatesError = error.message
        state.updatesBusy = null
        render()
        return
      }
    }
    restarting = true
    render()
    // 等旧进程退出、新版本监听后整页刷新。
    await new Promise(resolve => setTimeout(resolve, 1500))
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch('/api/catalog', { cache: 'no-store' })
        if (response.ok) { location.reload(); return }
      } catch { /* 仍在重启 */ }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    restarting = false
    state.updatesBusy = null
    state.updatesError = t('updates.restartManual')
    render()
  }

  // 数字/尺寸：formatNumber 跟随当前语言；小数位与原来的 toFixed(0/1) 保持一致。
  const mb = bytes => formatNumber(bytes / 1048576, {
    minimumFractionDigits: bytes >= 10485760 ? 0 : 1,
    maximumFractionDigits: bytes >= 10485760 ? 0 : 1,
  }) + ' MB'
  const percent = (received, total) => total ? formatNumber(Math.min(100, Math.floor(received / total * 100))) + '%' : mb(received)
  // 时间跟随大厅语言（替代原来不指定语言的 toLocaleString()）；字段形状保持原默认值，zh-CN 输出与原来一致。
  const dateTimeOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }
  const timeText = iso => {
    if (!iso) return t('updates.time.never')
    const date = new Date(iso)
    // 服务端时间戳异常时不抛 RangeError（Intl 对 Invalid Date 会抛），退回「尚未检查」。
    if (Number.isNaN(date.getTime())) return t('updates.time.never')
    return formatDate(date, dateTimeOptions)
  }
  const sizeText = latest => latest.fullSize && latest.size < latest.fullSize
    ? t('updates.size.delta', { size: mb(latest.size), full: mb(latest.fullSize) })
    : mb(latest.size)
  // kind: 'download' | 'install'；mode === 'delta' 时用「增量」句式。
  const progressText = (kind, { received, total, mode }) => t('updates.progress.' + kind + (mode === 'delta' ? 'Delta' : ''),
    { percent: percent(received, total) })

  function renderHall(view) {
    const hall = view.hall
    if (!hall) return h('div', { className: 'bg-empty' }, t('updates.hall.unavailable'))
    const modeText = hall.mode === 'dev' ? t('updates.hall.modeDev')
      : hall.mode === 'manual' ? t('updates.hall.modeManual') : ''
    const rows = [h('div', { className: 'bg-upd-line' }, t('updates.hall.currentVersion') + ' ',
      h('b', null, 'v' + view.hallVersion), modeText)]
    if (hall.rolledBack) rows.push(h('div', { className: 'bg-model-result err' }, t('updates.hall.rolledBack', { version: hall.rolledBack })))
    if (hall.error) rows.push(h('div', { className: 'bg-model-result err' }, t('updates.errorLine', { error: hall.error })))
    if (hall.mode === 'disabled') rows.push(h('div', { className: 'bg-field-hint' }, t('updates.hall.disabled')))
    if (hall.available && hall.latest) {
      const download = hall.download
      let action
      if (hall.mode === 'dev') action = h('div', { className: 'bg-field-hint' }, t('updates.hall.devHint'))
      else if (hall.mode === 'manual' || hall.needsFullPackage) {
        action = h('a', { className: 'bg-btn', href: hall.releaseUrl, target: '_blank', rel: 'noopener' },
          hall.needsFullPackage ? t('updates.hall.fullPackage') : t('updates.hall.releasePage'))
      } else if (download.state === 'downloading') {
        action = h('div', { className: 'bg-upd-progress' }, h('span', { style: { width: percent(download.received, download.total) } }), h('em', null, progressText('download', download)))
      } else if (download.state === 'ready') {
        action = h('div', { className: 'bg-field-hint' }, t('updates.hall.ready'))
      } else {
        action = h('button', { className: 'bg-btn', disabled: !!state.updatesBusy, onclick: () => act('hall', 'POST', '/updates/hall/download', {}) },
          t(download.state === 'error' ? 'updates.hall.retryDownload' : 'updates.hall.download', { size: sizeText(hall.latest) }))
      }
      rows.push(h('div', { className: 'bg-upd-card' },
        h('div', { className: 'bg-upd-title' }, t(hall.failedBefore ? 'updates.hall.availableRetry' : 'updates.hall.available', { version: hall.latest.version })),
        hall.latest.notes ? h('pre', { className: 'bg-upd-notes' }, hall.latest.notes) : null,
        download.state === 'error' ? h('div', { className: 'bg-model-result err' }, t('updates.errorLine', { error: download.error })) : null,
        action))
    } else if (hall.latest && !hall.error) {
      rows.push(h('div', { className: 'bg-field-hint' }, t('updates.hall.upToDate')))
    }
    rows.push(h('div', { className: 'bg-field-hint' }, t('updates.hall.lastChecked', { time: timeText(hall.checkedAt) })))
    return rows
  }

  function gameActions(game) {
    const busy = !!state.updatesBusy || game.state === 'installing'
    const buttons = []
    if (game.updateAvailable && game.latest) {
      const size = sizeText(game.latest)
      const label = game.installed || game.downloaded.length
        ? t('updates.game.updateTo', { version: game.latest.version, size })
        : t('updates.game.install', { size })
      buttons.push(h('button', { className: 'bg-btn', disabled: busy, onclick: () => {
        if (!game.installed && !confirm(t('updates.confirm.install', { game: game.name }))) return
        act('game:' + game.id, 'POST', '/store/install', { id: game.id })
      } }, label))
    }
    if (game.downloaded.length && !game.pendingUninstall) {
      buttons.push(h('button', { className: 'bg-btn danger', disabled: busy, onclick: () => {
        const builtin = game.installed?.source === 'builtin'
        if (!confirm(builtin ? t('updates.confirm.deleteDownloaded', { game: game.name }) : t('updates.confirm.uninstall', { game: game.name }))) return
        act('game:' + game.id, 'POST', '/store/uninstall', { id: game.id })
      } }, t('updates.game.uninstall')))
    }
    return buttons
  }

  function renderGame(game) {
    const notes = []
    const version = game.installed?.version && game.installed.version !== '0.0.0' ? ' v' + game.installed.version : ''
    if (game.installed) notes.push(t(game.installed.source === 'builtin' ? 'updates.game.installedBuiltin' : 'updates.game.installed', { version }))
    else if (game.downloaded.length) notes.push(t('updates.game.downloaded', { version: game.downloaded.at(-1) }))
    else notes.push(t('updates.game.notInstalled'))
    if (game.latest) notes.push(t('updates.game.latest', { version: game.latest.version }))
    const status = []
    if (game.state === 'installing') {
      const progress = game.progress || { received: 0, total: 0 }
      status.push(h('div', { className: 'bg-upd-progress' }, h('span', { style: { width: percent(progress.received, progress.total) } }), h('em', null, progressText('install', progress))))
    }
    if (game.needsHallUpdate) status.push(h('div', { className: 'bg-field-hint' }, t('updates.game.needsHallUpdate')))
    if (game.restartRequired) status.push(h('div', { className: 'bg-field-hint' }, t('updates.game.restartRequired')))
    if (game.pendingUninstall) status.push(h('div', { className: 'bg-field-hint' }, t('updates.game.pendingUninstall')))
    if (game.error) status.push(h('div', { className: 'bg-model-result err' }, t('updates.errorLine', { error: game.error })))
    return h('div', { className: 'bg-upd-game' },
      h('div', { className: 'bg-upd-emoji', style: game.cover ? { background: game.cover } : null }, game.coverEmoji),
      h('div', { className: 'bg-upd-info' },
        h('div', { className: 'bg-ai-name' }, game.name),
        h('div', { className: 'bg-ai-meta' }, notes.join(' · ')),
        game.description ? h('div', { className: 'bg-field-hint' }, game.description) : null,
        status),
      h('div', { className: 'bg-ai-actions' }, gameActions(game)))
  }

  function renderSettings(view) {
    const mirror = state.updatesMirrorDraft ?? view.settings.mirror ?? ''
    const input = h('input', { className: 'bg-input', placeholder: t('updates.settings.mirrorPlaceholder'), value: mirror })
    input.addEventListener('input', event => { state.updatesMirrorDraft = event.target.value })
    return [
      h('label', { className: 'bg-upd-check' },
        h('input', { type: 'checkbox', checked: view.settings.autoCheck !== false, disabled: !!state.updatesBusy,
          onchange: event => act('settings', 'POST', '/updates/settings', { autoCheck: event.target.checked }) }),
        ' ' + t('updates.settings.autoCheck')),
      h('div', { className: 'bg-field' },
        h('label', null, t('updates.settings.mirrorLabel')),
        h('div', { className: 'bg-model-row' }, input,
          h('button', { className: 'bg-btn secondary', disabled: !!state.updatesBusy, onclick: async () => {
            await act('settings', 'POST', '/updates/settings', { mirror: state.updatesMirrorDraft ?? mirror })
            if (!state.updatesError) state.updatesMirrorDraft = null
            render()
          } }, t('updates.settings.save'))),
        h('div', { className: 'bg-field-hint' }, t('updates.settings.mirrorHint'))),
    ]
  }

  const errorLine = () => state.updatesError ? h('div', { className: 'bg-model-result err' }, t('updates.errorLine', { error: state.updatesError })) : null
  const loading = () => h('div', null, errorLine(), h('div', { className: 'bg-empty' }, t('updates.loading')))

  function footActions(view) {
    const checking = state.updatesBusy === 'check' || view.hall?.checking || view.store?.registry.checking
    return [
      view.restartRequired && view.restartable
        ? h('button', { className: 'bg-btn', disabled: !!state.updatesBusy || restarting, onclick: restart }, restarting ? t('updates.foot.restarting') : t('updates.foot.restart'))
        : view.restartRequired ? h('div', { className: 'bg-field-hint' }, t('updates.foot.manualRestart')) : null,
      h('button', { className: 'bg-btn secondary', disabled: !!state.updatesBusy || checking, onclick: () => act('check', 'POST', '/updates/check', {}) },
        checking ? t('updates.foot.checking') : t('updates.foot.check')),
    ]
  }

  // 设置 · 大厅更新：大厅版本与下载设置。
  function panel() {
    const view = state.updates
    if (!view) return loading()
    return h('div', null,
      h('p', { className: 'bg-desc' }, t('updates.panel.desc')),
      errorLine(),
      h('div', { className: 'bg-sec' }, t('updates.panel.sectionHall')),
      renderHall(view),
      h('div', { className: 'bg-sec' }, t('updates.panel.sectionSettings')),
      renderSettings(view),
      h('div', { className: 'bg-modal-foot' }, footActions(view)))
  }

  function hasGameUpdates() {
    return (state.updates?.store?.games || []).some(game => game.installed && game.updateAvailable)
  }

  // 游戏中心：游戏商店的独立弹窗。
  function gameCenterModal() {
    if (!state.gameCenterOpen) return null
    const view = state.updates
    const games = view?.store?.games || []
    const close = () => { state.gameCenterOpen = false; render() }
    return h('div', { className: 'bg-backdrop', onclick: close },
      h('div', { className: 'bg-modal bg-game-center', role: 'dialog', 'aria-label': t('updates.gameCenter.label'), onclick: event => event.stopPropagation() },
        h('h2', null, t('updates.gameCenter.title')),
        h('p', { className: 'bg-desc' }, t('updates.gameCenter.desc')),
        !view ? loading() : [
          errorLine(),
          hasHallUpdates() ? h('div', { className: 'bg-upd-card' },
            h('div', { className: 'bg-upd-title' }, view.restartRequired && !view.hall?.available
              ? t('updates.gameCenter.readyToRestart')
              : t('updates.gameCenter.hallNewVersion', { version: view.hall.latest.version })),
            h('button', { className: 'bg-btn', onclick: () => {
              state.gameCenterOpen = false
              state.settingsOpen = true
              state.settingsTab = 'updates'
              render()
            } }, t('updates.gameCenter.goSettings'))) : null,
          view.store?.registry.error ? h('div', { className: 'bg-model-result err' }, t('updates.errorLine', { error: view.store.registry.error })) : null,
          games.length ? h('div', { className: 'bg-ai-list' }, games.map(renderGame)) : h('div', { className: 'bg-empty' }, t('updates.gameCenter.empty')),
          h('div', { className: 'bg-field-hint' }, t('updates.gameCenter.lastChecked', { time: timeText(view.store?.registry.checkedAt) })),
        ],
        h('div', { className: 'bg-modal-foot' },
          view ? footActions(view) : null,
          h('button', { className: 'bg-btn secondary', onclick: close }, t('updates.close')))))
  }

  function hasHallUpdates() {
    const view = state.updates
    return !!view?.hall?.available || !!view?.restartRequired
  }

  /**
   * 语言切换钩子（hall-shell 在 setLocale() 之后调用）：本模块的文案都在 render 时现取 t()，
   * 不缓存成句文案；这里只清掉保存瞬间生成的中文错误字符串，并在面板/游戏中心打开时
   * 重拉一次服务端视图（游戏名/描述由服务端按语言下发）。函数保持同步、不重置任何更新状态。
   */
  function onLocaleChange() {
    state.updatesError = null
    if (state.updates && (state.gameCenterOpen || state.settingsOpen || state.settingsTab === 'updates')) {
      load().catch(() => {})
    }
  }

  return {
    panel,
    hasHallUpdates,
    hasGameUpdates,
    gameCenterModal,
    onLocaleChange,
    gameCenterButton: () => h('button', {
      className: 'bg-btn secondary bg-game-center-btn' + (hasHallUpdates() || hasGameUpdates() ? ' bg-game-center-btn-dot' : ''),
      title: hasHallUpdates() ? t('updates.gameCenter.buttonTitleUpdate')
        : hasGameUpdates() ? t('updates.gameCenter.buttonTitleGameUpdate') : t('updates.gameCenter.buttonTitleDefault'),
      onclick: () => {
        state.gameCenterOpen = true
        render()
        load().catch(error => { state.updatesError = error.message; render() })
      },
    }, t('updates.gameCenter.button')),
    open() { load().catch(error => { state.updatesError = error.message; render() }) },
    boot() {
      const refresh = () => load().catch(() => {})
      refresh()
      setInterval(refresh, 5 * 60 * 1000)
    },
  }
}
