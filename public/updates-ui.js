// 设置 · 大厅更新 + 大厅「游戏中心」弹窗（游戏商店）。
// 只与 /api/updates、/api/store/* 通信；下载在服务端后台进行，这里轮询进度。

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
        if (error.code === 'ONLINE_ACTIVE' && !body.force && confirm('重启会断开当前联机房间，确定继续？')) { body = { force: true }; continue }
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
    state.updatesError = '大厅没有自动重新启动，请手动打开桌游大厅。'
    render()
  }

  const mb = bytes => (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + ' MB'
  const percent = (received, total) => total ? Math.min(100, Math.floor(received / total * 100)) + '%' : mb(received)
  const timeText = iso => iso ? new Date(iso).toLocaleString() : '尚未检查'
  const sizeText = latest => latest.fullSize && latest.size < latest.fullSize
    ? `增量 ${mb(latest.size)}，完整包 ${mb(latest.fullSize)}`
    : mb(latest.size)
  const progressText = (verb, { received, total, mode }) => (mode === 'delta' ? '增量' : '') + verb + ' ' + percent(received, total)

  function renderHall(view) {
    const hall = view.hall
    if (!hall) return h('div', { className: 'bg-empty' }, '自动更新不可用。')
    const rows = [h('div', { className: 'bg-upd-line' }, '当前版本 ', h('b', null, 'v' + view.hallVersion),
      hall.mode === 'dev' ? '，开发版' : hall.mode === 'manual' ? '，当前安装方式不支持自动更新' : '')]
    if (hall.rolledBack) rows.push(h('div', { className: 'bg-model-result err' }, `⚠️ 新版本 v${hall.rolledBack} 启动失败，已自动回滚到当前版本。`))
    if (hall.error) rows.push(h('div', { className: 'bg-model-result err' }, '❌ ' + hall.error))
    if (hall.mode === 'disabled') rows.push(h('div', { className: 'bg-field-hint' }, '未配置发布仓库，无法检查大厅更新。'))
    if (hall.available && hall.latest) {
      const download = hall.download
      let action
      if (hall.mode === 'dev') action = h('div', { className: 'bg-field-hint' }, '开发版请在项目目录运行：git pull && git submodule update --init')
      else if (hall.mode === 'manual' || hall.needsFullPackage) {
        action = h('a', { className: 'bg-btn', href: hall.releaseUrl, target: '_blank', rel: 'noopener' },
          hall.needsFullPackage ? '此版本需要下载完整安装包' : '前往发布页下载')
      } else if (download.state === 'downloading') {
        action = h('div', { className: 'bg-upd-progress' }, h('span', { style: { width: percent(download.received, download.total) } }), h('em', null, progressText('下载中', download)))
      } else if (download.state === 'ready') {
        action = h('div', { className: 'bg-field-hint' }, '✔ 新版本已准备就绪，点击下方「重启大厅」后生效。')
      } else {
        action = h('button', { className: 'bg-btn', disabled: !!state.updatesBusy, onclick: () => act('hall', 'POST', '/updates/hall/download', {}) },
          (download.state === 'error' ? '重试下载' : '下载更新') + '（' + sizeText(hall.latest) + '）')
      }
      rows.push(h('div', { className: 'bg-upd-card' },
        h('div', { className: 'bg-upd-title' }, '🆕 发现新版本 v' + hall.latest.version + (hall.failedBefore ? '（上次启动失败，可重试）' : '')),
        hall.latest.notes ? h('pre', { className: 'bg-upd-notes' }, hall.latest.notes) : null,
        download.state === 'error' ? h('div', { className: 'bg-model-result err' }, '❌ ' + download.error) : null,
        action))
    } else if (hall.latest && !hall.error) {
      rows.push(h('div', { className: 'bg-field-hint' }, '✔ 已是最新版本'))
    }
    rows.push(h('div', { className: 'bg-field-hint' }, '上次检查：' + timeText(hall.checkedAt)))
    return rows
  }

  function gameActions(game) {
    const busy = !!state.updatesBusy || game.state === 'installing'
    const buttons = []
    if (game.updateAvailable && game.latest) {
      const label = game.installed || game.downloaded.length ? '更新到 v' + game.latest.version : '安装'
      buttons.push(h('button', { className: 'bg-btn', disabled: busy, onclick: () => {
        if (!game.installed && !confirm(`「${game.name}」会以完整权限在本机运行。只安装你信任的游戏，确定继续？`)) return
        act('game:' + game.id, 'POST', '/store/install', { id: game.id })
      } }, label + '（' + sizeText(game.latest) + '）'))
    }
    if (game.downloaded.length && !game.pendingUninstall) {
      buttons.push(h('button', { className: 'bg-btn danger', disabled: busy, onclick: () => {
        const builtin = game.installed?.source === 'builtin'
        if (!confirm(builtin ? `删除「${game.name}」已下载但未启用的版本？` : `卸载「${game.name}」？存档保留，但重新安装前无法读取。`)) return
        act('game:' + game.id, 'POST', '/store/uninstall', { id: game.id })
      } }, '卸载'))
    }
    return buttons
  }

  function renderGame(game) {
    const notes = []
    const version = game.installed?.version && game.installed.version !== '0.0.0' ? ' v' + game.installed.version : ''
    if (game.installed) notes.push('已安装' + version + (game.installed.source === 'builtin' ? '（内置）' : ''))
    else if (game.downloaded.length) notes.push('已下载 v' + game.downloaded.at(-1))
    else notes.push('未安装')
    if (game.latest) notes.push('最新 v' + game.latest.version)
    const status = []
    if (game.state === 'installing') {
      const progress = game.progress || { received: 0, total: 0 }
      status.push(h('div', { className: 'bg-upd-progress' }, h('span', { style: { width: percent(progress.received, progress.total) } }), h('em', null, progressText('安装中', progress))))
    }
    if (game.needsHallUpdate) status.push(h('div', { className: 'bg-field-hint' }, '新版本需要先更新大厅'))
    if (game.restartRequired) status.push(h('div', { className: 'bg-field-hint' }, '✔ 重启大厅后生效'))
    if (game.pendingUninstall) status.push(h('div', { className: 'bg-field-hint' }, '将在重启大厅后卸载'))
    if (game.error) status.push(h('div', { className: 'bg-model-result err' }, '❌ ' + game.error))
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
    const input = h('input', { className: 'bg-input', placeholder: '例如 https://ghfast.top/（可留空）', value: mirror })
    input.addEventListener('input', event => { state.updatesMirrorDraft = event.target.value })
    return [
      h('label', { className: 'bg-upd-check' },
        h('input', { type: 'checkbox', checked: view.settings.autoCheck !== false, disabled: !!state.updatesBusy,
          onchange: event => act('settings', 'POST', '/updates/settings', { autoCheck: event.target.checked }) }),
        ' 启动后自动检查更新（之后每 6 小时一次）'),
      h('div', { className: 'bg-field' },
        h('label', null, 'GitHub 加速镜像'),
        h('div', { className: 'bg-model-row' }, input,
          h('button', { className: 'bg-btn secondary', disabled: !!state.updatesBusy, onclick: async () => {
            await act('settings', 'POST', '/updates/settings', { mirror: state.updatesMirrorDraft ?? mirror })
            if (!state.updatesError) state.updatesMirrorDraft = null
            render()
          } }, '保存')),
        h('div', { className: 'bg-field-hint' }, '直连 GitHub 失败时改走「镜像前缀 + 原地址」。所有下载都会校验签名和 sha256，镜像无法篡改内容。')),
    ]
  }

  const errorLine = () => state.updatesError ? h('div', { className: 'bg-model-result err' }, '❌ ' + state.updatesError) : null
  const loading = () => h('div', null, errorLine(), h('div', { className: 'bg-empty' }, '读取中…'))

  function footActions(view) {
    const checking = state.updatesBusy === 'check' || view.hall?.checking || view.store?.registry.checking
    return [
      view.restartRequired && view.restartable
        ? h('button', { className: 'bg-btn', disabled: !!state.updatesBusy || restarting, onclick: restart }, restarting ? '正在重启…' : '🔁 重启大厅')
        : view.restartRequired ? h('div', { className: 'bg-field-hint' }, '请关闭并重新打开大厅以完成更新。') : null,
      h('button', { className: 'bg-btn secondary', disabled: !!state.updatesBusy || checking, onclick: () => act('check', 'POST', '/updates/check', {}) },
        checking ? '检查中…' : '🔄 检查更新'),
    ]
  }

  // 设置 · 大厅更新：大厅版本与下载设置。
  function panel() {
    const view = state.updates
    if (!view) return loading()
    return h('div', null,
      h('p', { className: 'bg-desc' }, '大厅从 GitHub Release 获取更新，下载内容经过签名校验。存档、设置和 AI 角色不受更新影响。游戏的安装与更新请到大厅的「🎮 游戏中心」。'),
      errorLine(),
      h('div', { className: 'bg-sec' }, '大厅'),
      renderHall(view),
      h('div', { className: 'bg-sec' }, '设置'),
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
      h('div', { className: 'bg-modal bg-game-center', role: 'dialog', 'aria-label': '游戏中心', onclick: event => event.stopPropagation() },
        h('h2', null, '🎮 游戏中心'),
        h('p', { className: 'bg-desc' }, '浏览、安装和更新游戏。游戏从 GitHub Release 下载并经过签名校验，卸载后存档仍会保留。'),
        !view ? loading() : [
          errorLine(),
          hasHallUpdates() ? h('div', { className: 'bg-upd-card' },
            h('div', { className: 'bg-upd-title' }, view.restartRequired && !view.hall?.available
              ? '🔁 更新已就绪，重启大厅后生效'
              : '🆕 大厅有新版本 v' + view.hall.latest.version),
            h('button', { className: 'bg-btn', onclick: () => {
              state.gameCenterOpen = false
              state.settingsOpen = true
              state.settingsTab = 'updates'
              render()
            } }, '前往「设置 → 大厅更新」')) : null,
          view.store?.registry.error ? h('div', { className: 'bg-model-result err' }, '❌ ' + view.store.registry.error) : null,
          games.length ? h('div', { className: 'bg-ai-list' }, games.map(renderGame)) : h('div', { className: 'bg-empty' }, '点击「检查更新」获取可下载的游戏。'),
          h('div', { className: 'bg-field-hint' }, '游戏目录上次检查：' + timeText(view.store?.registry.checkedAt)),
        ],
        h('div', { className: 'bg-modal-foot' },
          view ? footActions(view) : null,
          h('button', { className: 'bg-btn secondary', onclick: close }, '关闭'))))
  }

  function hasHallUpdates() {
    const view = state.updates
    return !!view?.hall?.available || !!view?.restartRequired
  }

  return {
    panel,
    hasHallUpdates,
    hasGameUpdates,
    gameCenterModal,
    gameCenterButton: () => h('button', {
      className: 'bg-btn secondary bg-game-center-btn' + (hasHallUpdates() || hasGameUpdates() ? ' bg-game-center-btn-dot' : ''),
      title: hasHallUpdates() ? '游戏中心 · 大厅有可用更新'
        : hasGameUpdates() ? '游戏中心 · 有游戏可更新' : '游戏中心 · 安装与更新游戏',
      onclick: () => {
        state.gameCenterOpen = true
        render()
        load().catch(error => { state.updatesError = error.message; render() })
      },
    }, '🎮 游戏中心'),
    open() { load().catch(error => { state.updatesError = error.message; render() }) },
    boot() {
      const refresh = () => load().catch(() => {})
      refresh()
      setInterval(refresh, 5 * 60 * 1000)
    },
  }
}
