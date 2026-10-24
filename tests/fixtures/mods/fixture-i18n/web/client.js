// 测试 Mod（fixture-i18n）自带的浏览器界面：最小 createUI(host) + onLocaleChange。
//
// 大厅契约（docs/localization.md §8.1 / §8.3）：
//   - host.locale 可能不存在（旧版大厅），必须做防御：host.locale?.resolved || 'zh-CN'；
//   - onLocaleChange(next) 同步、幂等，只更新文案并 host.render()，绝不重置对局／重新请求存档；
//   - 语言包是本目录下的 ES module（随游戏包发布），大厅不替 Mod 加载词典。
//
// 浏览器用例可依赖的选择器（data-testid）：
//   fixture-i18n-game           游戏根节点
//   fixture-i18n-title          已本地化的标题（词典 key：game.title）
//   fixture-i18n-status         已本地化的状态文案（game.yourTurn / game.waiting / game.over）
//   fixture-i18n-locale         当前生效的 resolved locale（如 zh-CN / en）
//   fixture-i18n-locale-changes onLocaleChange 被调用的次数（初始 0）
import zhCN from './locales/zh-CN.js'
import en from './locales/en.js'

const SOURCE_LOCALE = 'zh-CN'
const DICTS = { 'zh-CN': zhCN, en }

function text(locale, key) {
  const dict = DICTS[locale] || DICTS[SOURCE_LOCALE]
  const value = dict && dict[key]
  if (typeof value === 'string' && value) return value
  const fallback = DICTS[SOURCE_LOCALE][key]
  return typeof fallback === 'string' ? fallback : key
}

export function createUI(host) {
  const { h } = host
  let locale = host.locale?.resolved || SOURCE_LOCALE
  let localeChanges = 0

  function statusKey(session) {
    if (session.state.status !== 'playing') return 'game.over'
    const decision = Object.hasOwn(session, 'decisionSeat') ? session.decisionSeat : session.state.currentSeat
    return decision === (session.mySeat ?? 0) ? 'game.yourTurn' : 'game.waiting'
  }

  function cellButton(session, x, y) {
    const index = y * 3 + x
    const value = session.state.board[index]
    return h('button', {
      class: 'bg-cell' + (value ? ' bg-' + value : ''),
      'data-testid': 'fixture-i18n-cell-' + x + '-' + y,
      'aria-label': '(' + x + ',' + y + ')',
      onclick: () => play(session, x, y),
    }, value === 'black' ? '●' : value === 'white' ? '○' : '')
  }

  async function play(session, x, y) {
    try {
      await host.api('POST', '/move', { sessionId: session.sessionId, move: { x, y } })
    } catch (error) {
      host.state.error = String(error && error.message ? error.message : error)
    }
    host.render()
  }

  return {
    renderGame(session) {
      return h('div', { class: 'bg-game', 'data-testid': 'fixture-i18n-game' },
        h('div', { class: 'bg-game-head' },
          h('div', { class: 'bg-game-title', 'data-testid': 'fixture-i18n-title' }, text(locale, 'game.title')),
          h('div', { class: 'bg-game-status', 'data-testid': 'fixture-i18n-status' }, text(locale, statusKey(session)))
        ),
        h('div', { class: 'bg-board fixture-i18n-board' },
          session.state.board.map((_, index) => cellButton(session, index % 3, Math.floor(index / 3)))
        ),
        h('div', { class: 'bg-game-meta' },
          h('span', { 'data-testid': 'fixture-i18n-locale' }, locale),
          h('span', { 'data-testid': 'fixture-i18n-locale-changes' }, String(localeChanges))
        )
      )
    },

    onLocaleChange(next) {
      const resolved = next && typeof next.resolved === 'string' && next.resolved ? next.resolved : locale
      locale = resolved
      localeChanges++
      // 只重绘文案；不重置对局、不重新加载模块、不请求存档。
      host.render()
    },

    onDeactivate() {},
  }
}
