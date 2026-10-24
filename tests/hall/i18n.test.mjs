// 大厅 i18n 单元 + API 集成测试（docs/localization.md §14.1/§14.2）。
//
// 运行：node tests/hall/i18n.test.mjs（直接执行；本机沙箱下 node --test 会因 spawn EPERM 失败）。
//
// 覆盖：
//   - normalizeLocale / resolveLocale 的匹配与回退矩阵、非法输入不抛异常；
//   - localizeMod 的逐字段回退、settings 合并、localize 钩子、旧 Mod nameEn 兼容；
//   - localizeStoreGame 的 registry 展示回退；
//   - settings.json 的缺省/损坏/未知字段保留/原子写、/api/settings 读写与重启保留；
//   - /api/catalog 按当前语言下发已本地化元数据；
//   - createSession 写 session.locale 并把语言上下文传给 createState；
//   - handleApi 收到 locale / requestedLocale；
//   - /api/updates 的商店条目按语言本地化（未安装读 registry、已安装以 Mod 为准）。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import gobang from '../../games/gobang/index.js'
import {
  HALL_LOCALES, SOURCE_LOCALE, normalizeLocale, resolveLocale, resolveModLocale,
  localizeMod, localizeStoreGame, hallText,
} from '../../lib/i18n.js'
import { loadSettings, saveSettings, settingsView, settingsFile } from '../../lib/settings.js'
import { parseRegistry } from '../../lib/store.js'
import { snapshotPath } from '../../lib/sessions.js'
import { createServer } from '../../lib/server.js'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function useTempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-i18n-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

async function startHall(t, { mods = [], updates, persist = false } = {}) {
  const server = createServer({ mods, persist, ...(updates ? { updates } : {}) })
  await server.ready
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const request = async (route, body) => {
    const response = await fetch(base + '/api' + route, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, ...await response.json() }
  }
  return { server, base, request }
}

// 带完整 en 词典的测试 Mod；基础字段保持中文，和真实 Mod 一样。
function demoMod(overrides = {}) {
  return {
    ...gobang,
    id: 'i18n-demo',
    name: '五子棋',
    nameEn: 'Gobang',
    description: '黑白对弈，在 15×15 棋盘上率先五子连珠（横/竖/斜）者获胜。',
    tags: ['棋类', '双人', '策略'],
    i18n: {
      defaultLocale: 'zh-CN',
      supportedLocales: ['zh-CN', 'en'],
      messages: {
        en: {
          name: 'Gobang',
          description: 'Place five stones in a row on a 15×15 board to win.',
          tags: ['Abstract', '2 players', 'Strategy'],
          aiSlotLabel: 'AI opponent',
          aiSlotDescription: 'An AI-controlled opponent',
          settings: {
            firstMove: {
              label: 'First move',
              options: { player: 'Player (black moves first)', ai: 'AI (black moves first)' },
            },
          },
        },
      },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// normalizeLocale / resolveLocale（§3.2 / §9.1 / §9.3）
// ---------------------------------------------------------------------------

test('normalizeLocale 规范化大小写、分隔符与最小别名，非法输入返回 null', () => {
  assert.equal(normalizeLocale('zh-cn'), 'zh-CN')
  assert.equal(normalizeLocale('ZH'), 'zh-CN', '语言小写；zh 是最小别名')
  assert.equal(normalizeLocale('en_us'), 'en-US')
  assert.equal(normalizeLocale('  en  '), 'en')
  assert.equal(normalizeLocale('zh_hans_cn'), 'zh-Hans-CN', '4 字母 script 首字母大写')
  assert.equal(normalizeLocale('en'), 'en')
  for (const bad of ['', ' ', null, undefined, 42, {}, [], '../../x', 'en us', 'a', 'x'.repeat(36)]) {
    assert.equal(normalizeLocale(bad), null, String(bad))
  }
})

test('resolveLocale 的语言匹配矩阵（§9.3）', () => {
  const i18n = { defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'] }
  assert.equal(resolveLocale('zh-CN', i18n).matched, 'exact')
  assert.equal(resolveLocale('en', i18n).resolved, 'en')
  assert.equal(resolveLocale('en-US', i18n).matched, 'base-language', 'en-US → en')
  assert.equal(resolveLocale('fr', i18n).matched, 'mod-default')
  assert.equal(resolveLocale('fr', i18n).resolved, 'zh-CN')
  assert.equal(resolveLocale('fr', i18n).fellBack, true)

  // 同主语言多候选（简体/繁体都声明）时不猜，走 defaultLocale。
  const chinese = { defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'zh-TW'] }
  assert.equal(resolveLocale('zh-HK', chinese).resolved, 'zh-CN')
  assert.equal(resolveLocale('zh-HK', chinese).matched, 'mod-default')
  assert.equal(resolveLocale('zh-HK', chinese).fellBack, true)

  // 没有声明任何语言的旧 Mod。
  const legacy = resolveLocale('en', undefined)
  assert.equal(legacy.resolved, SOURCE_LOCALE)
  assert.equal(legacy.matched, 'source')
  assert.equal(legacy.fellBack, true)
  assert.deepEqual(legacy.supportedLocales, [])

  // 非法请求不抛异常，按 zh-CN 处理。
  for (const bad of ['', null, undefined, '../../x', 'x'.repeat(40), 'en us']) {
    const result = resolveLocale(bad, i18n)
    assert.equal(result.requested, SOURCE_LOCALE, String(bad))
    assert.ok(['exact', 'mod-default', 'base-language'].includes(result.matched))
  }
})

test('resolveLocale 归一化非法的 defaultLocale，保证 resolved 一定在 supportedLocales 中', (t) => {
  t.mock.method(console, 'warn', () => {})
  const badDefault = resolveLocale('fr', { defaultLocale: 'fr-FR', supportedLocales: ['zh-CN', 'en'] })
  assert.equal(badDefault.defaultLocale, 'zh-CN')
  assert.equal(badDefault.resolved, 'zh-CN')
  const noZh = resolveLocale('fr', { defaultLocale: 'fr-FR', supportedLocales: ['ja', 'en'] })
  assert.equal(noZh.defaultLocale, 'ja', '不支持 zh-CN 时回退 supported[0]')
  assert.ok(noZh.supportedLocales.includes(noZh.resolved))
  const dedup = resolveLocale('en', { defaultLocale: 'en', supportedLocales: ['zh-CN', 'EN', 'en', 'en-US'] })
  assert.deepEqual(dedup.supportedLocales, ['zh-CN', 'en', 'en-US'])
})

test('resolveModLocale 只读 mod.i18n；hallText 回退源语言', () => {
  assert.equal(resolveModLocale({ i18n: { defaultLocale: 'en', supportedLocales: ['en'] } }, 'zh-CN').resolved, 'en')
  assert.equal(hallText('en', 'aiSlot.label'), 'AI opponent')
  assert.equal(hallText('fr', 'aiSlot.label'), '对手 AI', '不支持的语言回退源语言')
  assert.equal(hallText('en', 'missing.key'), 'missing.key')
  assert.deepEqual(HALL_LOCALES.map((item) => item.id), ['zh-CN', 'en'])
})

// ---------------------------------------------------------------------------
// localizeMod（§7.3）
// ---------------------------------------------------------------------------

test('localizeMod 逐字段合并：提供即覆盖，未提供保留基础字段', () => {
  const mod = demoMod()
  const originalSettings = JSON.stringify(mod.settingsSpec)
  const en = localizeMod(mod, 'en')
  assert.equal(en.name, 'Gobang')
  assert.equal(en.description, 'Place five stones in a row on a 15×15 board to win.')
  assert.deepEqual(en.tags, ['Abstract', '2 players', 'Strategy'])
  assert.equal(en.aiSlotLabel, 'AI opponent')
  assert.equal(en.aiSlotDescription, 'An AI-controlled opponent')
  assert.deepEqual(en.i18n, {
    requested: 'en', resolved: 'en', defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en'], matched: 'exact', fellBack: false, files: null,
  })
  // 设置项只覆盖文本，不改 type/default/选项集合。
  const firstMove = en.settingsSpec.find((item) => item.key === 'firstMove')
  assert.equal(firstMove.label, 'First move')
  assert.equal(firstMove.type, 'select')
  assert.equal(firstMove.default, 'player')
  assert.deepEqual(firstMove.options, [
    { value: 'player', label: 'Player (black moves first)' },
    { value: 'ai', label: 'AI (black moves first)' },
  ])
  assert.equal(JSON.stringify(mod.settingsSpec), originalSettings, '不得修改 Mod 本体')

  // 只翻译了 name 的 Mod：其余字段继续用基础中文值。
  const partial = localizeMod(demoMod({
    i18n: { defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'], messages: { en: { name: 'Gobang' } } },
  }), 'en')
  assert.equal(partial.name, 'Gobang')
  assert.equal(partial.description, gobang.description)
  assert.deepEqual(partial.tags, ['棋类', '双人', '策略'])

  // 空字符串不算有效翻译（不能用 ?? 把空串当好值）。
  const empty = localizeMod(demoMod({
    i18n: { defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'], messages: { en: { name: '  ', description: '' } } },
  }), 'en')
  assert.equal(empty.name, '五子棋')
  assert.equal(empty.description, gobang.description)
})

test('localizeMod：defaultLocale 层先于 resolved 层；zh 请求回退到源语言词典', () => {
  const mod = demoMod({
    i18n: {
      defaultLocale: 'en',
      supportedLocales: ['en', 'ja'],
      messages: { en: { name: 'English name' }, ja: { description: '日本語の説明' } },
    },
  })
  assert.equal(localizeMod(mod, 'en').name, 'English name')
  const ja = localizeMod(mod, 'ja')
  assert.equal(ja.name, 'English name', 'resolved 缺 name 时取 defaultLocale 层')
  assert.equal(ja.description, '日本語の説明', 'resolved 提供的字段优先')
  // mod 不支持请求语言：走它自己的 defaultLocale。
  assert.equal(localizeMod(mod, 'zh-CN').i18n.matched, 'mod-default')
})

test('localizeMod：localize 钩子最后应用、只接受同步对象；抛错/异步返回值被忽略', (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')))
  const mod = demoMod()
  mod.localize = (locale) => (locale === 'en' ? { name: 'Hook name', settings: { firstMove: { label: 'Hook label' } } } : null)
  const en = localizeMod(mod, 'en')
  assert.equal(en.name, 'Hook name', '钩子优先级最高')
  assert.equal(en.settingsSpec.find((item) => item.key === 'firstMove').label, 'Hook label')

  const throwing = demoMod()
  throwing.localize = () => { throw new Error('boom') }
  const safe = localizeMod(throwing, 'en')
  assert.equal(safe.name, 'Gobang', '抛错的钩子被忽略，保留静态结果')
  assert.ok(warnings.some((line) => line.includes('boom')))

  const asyncHook = demoMod()
  asyncHook.localize = async () => ({ name: 'async' })
  assert.equal(localizeMod(asyncHook, 'en').name, 'Gobang', '异步返回值不被采用')
})

test('localizeMod：旧 Mod 的 nameEn 兼容标记，以及无 i18n 时 files=null', () => {
  const legacy = { ...gobang, id: 'legacy-one', name: '旧游戏', nameEn: 'Legacy Game' }
  const en = localizeMod(legacy, 'en')
  assert.equal(en.name, 'Legacy Game')
  assert.equal(en.description, gobang.description, '只兼容名称，描述仍是基础文案')
  assert.equal(en.i18n.matched, 'legacy-name')
  assert.equal(en.i18n.fellBack, true)
  assert.equal(localizeMod(legacy, 'zh-CN').name, '旧游戏')

  const files = localizeMod(demoMod({
    web: { localeUrls: { 'zh-CN': '/mods/i18n-demo/locales/zh-CN.js', en: '/mods/i18n-demo/locales/en.js' } },
  }), 'en')
  assert.deepEqual(files.i18n.files, {
    'zh-CN': '/mods/i18n-demo/locales/zh-CN.js', en: '/mods/i18n-demo/locales/en.js',
  })
})

test('localizeMod：i18n 结构非法时按无 i18n 处理，不抛异常', () => {
  const broken = { ...gobang, id: 'broken', i18n: { supportedLocales: 'en', messages: [] } }
  const view = localizeMod(broken, 'en')
  // 非法 i18n 等同没有 i18n：可用的只有 nameEn 兼容层。
  assert.equal(view.i18n.matched, 'legacy-name')
  assert.deepEqual(view.i18n.supportedLocales, [])
  assert.equal(view.name, 'Gobang')
  assert.equal(typeof view.description, 'string')
})

// ---------------------------------------------------------------------------
// localizeStoreGame / registry（§7.7）
// ---------------------------------------------------------------------------

test('localizeStoreGame：精确 → 同主语言 → 基础中文；非法条目被忽略', () => {
  const game = {
    name: '诡镇奇谈：卡牌版', description: '合作卡牌，1~4 人',
    localized: {
      en: { name: 'Arkham Horror: The Card Game', description: 'Cooperative card game for 1–4 players' },
      'fr-FR': { name: 'Horreur à Arkham' },
      '../x': { name: 'evil' },
      bad: { name: 42 },
    },
  }
  assert.deepEqual(localizeStoreGame(game, 'en'), {
    name: 'Arkham Horror: The Card Game', description: 'Cooperative card game for 1–4 players',
  })
  assert.equal(localizeStoreGame(game, 'en-US').name, 'Arkham Horror: The Card Game', 'en-US → en')
  assert.equal(localizeStoreGame(game, 'ja').name, '诡镇奇谈：卡牌版', '没有匹配语言时回退基础文案')
  assert.deepEqual(localizeStoreGame(null, 'en'), { name: '', description: '' })

  const parsed = parseRegistry(JSON.stringify({
    schema: 1,
    games: [{
      id: 'arkhamhorror', repo: 'Dr-Liao/boardgame-arkhamhorror',
      name: '诡镇奇谈：卡牌版', description: '合作卡牌，1~4 人',
      localized: { en: { name: 'Arkham Horror: The Card Game' }, '__proto__': { name: 'x' }, de: { name: '' } },
    }],
  }))
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].localized, { en: { name: 'Arkham Horror: The Card Game' } })
  const noLocalized = parseRegistry(JSON.stringify({
    schema: 1, games: [{ id: 'plain', repo: 'x/y', name: '纯中文', description: '' }],
  }))
  assert.equal(noLocalized[0].localized, null)
})

// ---------------------------------------------------------------------------
// settings.json（§5.1）
// ---------------------------------------------------------------------------

test('settings.json：缺省、损坏、schema/语言非法都安全回退 zh-CN', (t) => {
  const home = useTempHome(t)
  assert.deepEqual(loadSettings(), { schema: 1, locale: 'zh-CN' }, '文件不存在 → 默认值')

  fs.mkdirSync(path.join(home, 'boardgame-hall'), { recursive: true })
  const file = settingsFile()
  fs.writeFileSync(file, '{not json')
  assert.equal(loadSettings().locale, 'zh-CN', '损坏的 JSON 回退默认值')

  fs.writeFileSync(file, JSON.stringify({ schema: 2, locale: 'en' }))
  assert.equal(loadSettings().locale, 'zh-CN', 'schema 非 1 回退默认值')

  fs.writeFileSync(file, JSON.stringify({ schema: 1, locale: 'fr' }))
  assert.equal(loadSettings().locale, 'zh-CN', '不受支持的语言回退默认值')

  fs.writeFileSync(file, JSON.stringify({ schema: 1, locale: 'en-US' }))
  assert.equal(loadSettings().locale, 'zh-CN', 'en-US 不是大厅可选语言（v1 只有 en）')
})

test('settings.json：保存保留未知字段、别名规范化、原子写且不残留 tmp', (t) => {
  const home = useTempHome(t)
  fs.mkdirSync(path.join(home, 'boardgame-hall'), { recursive: true })
  const file = settingsFile()
  fs.writeFileSync(file, JSON.stringify({ schema: 1, locale: 'en', futureSetting: 42 }))

  assert.equal(loadSettings().futureSetting, 42)
  saveSettings({ locale: 'zh' })
  assert.equal(loadSettings().locale, 'zh-CN', 'zh 别名存成 zh-CN')
  assert.equal(loadSettings().futureSetting, 42, '保存不得丢未知字段')
  assert.equal(fs.existsSync(file + '.tmp'), false, '原子写不能残留 tmp')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 1, locale: 'zh-CN', futureSetting: 42 })

  assert.throws(() => saveSettings({ locale: 'fr' }), (err) => err.code === 'INVALID_LOCALE')
  assert.equal(loadSettings().locale, 'zh-CN', '非法保存不改变现有设置')

  const view = settingsView()
  assert.equal(view.ok, true)
  assert.deepEqual(view.settings, { schema: 1, locale: 'zh-CN', futureSetting: 42 })
  assert.deepEqual(view.locales.map((item) => item.id), ['zh-CN', 'en'])
})

// ---------------------------------------------------------------------------
// API：/api/settings + /api/catalog（§5.2 / §7.4 / §14.2）
// ---------------------------------------------------------------------------

test('API：默认 zh-CN；改成 en 后 catalog 立即英文；非法语言 400 且设置不变；重启后保留', async (t) => {
  useTempHome(t)
  const mods = [demoMod()]
  let hall = await startHall(t, { mods })

  const initial = await hall.request('/settings')
  assert.equal(initial.ok, true)
  assert.deepEqual(initial.settings, { schema: 1, locale: 'zh-CN' })
  assert.deepEqual(initial.locales, HALL_LOCALES)

  const zhCatalog = await hall.request('/catalog')
  const zhEntry = zhCatalog.games.find((game) => game.id === 'i18n-demo')
  assert.equal(zhEntry.name, '五子棋')
  assert.equal(zhEntry.i18n.requested, 'zh-CN')
  assert.equal(zhEntry.i18n.resolved, 'zh-CN')
  assert.equal(zhEntry.i18n.matched, 'exact')
  assert.deepEqual(zhEntry.i18n.files, null)

  const saved = await hall.request('/settings', { locale: 'en' })
  assert.equal(saved.ok, true)
  assert.equal(saved.settings.locale, 'en')

  const enCatalog = await hall.request('/catalog')
  const enEntry = enCatalog.games.find((game) => game.id === 'i18n-demo')
  assert.equal(enEntry.name, 'Gobang')
  assert.equal(enEntry.description, 'Place five stones in a row on a 15×15 board to win.')
  assert.deepEqual(enEntry.tags, ['Abstract', '2 players', 'Strategy'])
  assert.equal(enEntry.i18n.resolved, 'en')
  assert.equal(enEntry.i18n.fellBack, false)
  // 大厅注入的「对手 AI」设置项也本地化（Mod 自己的 aiSlotLabel 优先）。
  const opponents = enEntry.settingsSpec.find((item) => item.key === 'opponents')
  assert.equal(opponents.label, 'AI opponent')
  assert.equal(opponents.labelKey, 'aiSlot.label')
  const firstMove = enEntry.settingsSpec.find((item) => item.key === 'firstMove')
  assert.equal(firstMove.label, 'First move')

  const invalid = await hall.request('/settings', { locale: '../../x' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.code, 'INVALID_LOCALE')
  assert.equal((await hall.request('/settings')).settings.locale, 'en', '非法请求不改变设置')

  // 关闭服务器再启动（同一 DSH_HOME）→ 仍是 en。
  hall.server.closeAllConnections()
  await new Promise((resolve) => hall.server.close(resolve))
  hall = await startHall(t, { mods })
  assert.equal((await hall.request('/settings')).settings.locale, 'en')
  assert.equal((await hall.request('/catalog')).games[0].name, 'Gobang')
})

test('API：旧 Mod（无 i18n）在 en 下只用 nameEn，其余保持中文；不完整 messages 不 500', async (t) => {
  useTempHome(t)
  const legacy = { ...gobang, id: 'legacy-one', name: '旧游戏', nameEn: 'Legacy Game', description: '中文描述' }
  const partial = demoMod({
    id: 'partial-one',
    i18n: { defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'], messages: { en: { name: 'Partial Game' } } },
  })
  const hall = await startHall(t, { mods: [legacy, partial] })
  assert.equal((await hall.request('/settings', { locale: 'en' })).ok, true)
  const games = (await hall.request('/catalog')).games
  const legacyEntry = games.find((game) => game.id === 'legacy-one')
  assert.equal(legacyEntry.name, 'Legacy Game')
  assert.equal(legacyEntry.description, '中文描述')
  assert.equal(legacyEntry.i18n.matched, 'legacy-name')
  assert.equal(legacyEntry.i18n.fellBack, true)
  const partialEntry = games.find((game) => game.id === 'partial-one')
  assert.equal(partialEntry.name, 'Partial Game')
  assert.equal(partialEntry.description, gobang.description, '缺字段回退基础值')
  assert.equal(partialEntry.i18n.matched, 'exact')
})

test('API：start 写 session.locale 并把语言上下文传给 createState', async (t) => {
  useTempHome(t)
  const contexts = []
  const mod = demoMod({
    createState(settings, players, context) {
      contexts.push(context)
      return gobang.createState(settings, players)
    },
  })
  const hall = await startHall(t, { mods: [mod] })
  await hall.request('/settings', { locale: 'en' })
  const started = await hall.request('/start', { modId: 'i18n-demo', settings: { opponents: [null], firstMove: 'player' } })
  assert.equal(started.ok, true, started.error)
  assert.equal(started.session.locale, 'en')
  assert.deepEqual(contexts.at(-1), { locale: 'en', requestedLocale: 'en' })

  // 读取会话时 locale 随 session 返回（单机分支展开 session）。
  const loaded = await hall.request('/session?sessionId=' + started.session.sessionId)
  assert.equal(loaded.session.locale, 'en')
})

test('API：旧存档没有 session.locale 仍可读取，且读档不会反向修改大厅语言', async (t) => {
  useTempHome(t)
  const mods = [demoMod()]
  const hall = await startHall(t, { mods, persist: true })
  await hall.request('/settings', { locale: 'en' })
  const started = await hall.request('/start', { modId: 'i18n-demo', settings: { opponents: [null], firstMove: 'player' } })
  assert.equal(started.ok, true, started.error)
  assert.equal(started.session.locale, 'en')

  // 模拟本地化实现之前落盘的旧存档：删掉 locale 字段后原样写回，再显式读档。
  const file = snapshotPath(started.session.sessionId)
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete record.session.locale
  fs.writeFileSync(file, JSON.stringify(record))

  const loaded = await hall.request('/session/load', { sessionId: started.session.sessionId })
  assert.equal(loaded.ok, true, loaded.error)
  assert.equal(loaded.session.locale, undefined, '旧存档不迁移、不补写 locale')
  assert.equal((await hall.request('/settings')).settings.locale, 'en', '读旧档不能反向修改大厅语言')
})

test('API：handleApi / handleLocalApi 收到 locale 与 requestedLocale', async (t) => {
  useTempHome(t)
  const seen = []
  const mod = {
    ...demoMod({ id: 'api-locale' }),
    handleApi({ path: modPath, locale, requestedLocale }) {
      seen.push({ modPath, locale, requestedLocale })
      return { body: { path: modPath, locale, requestedLocale } }
    },
  }
  const hall = await startHall(t, { mods: [mod] })
  await hall.request('/settings', { locale: 'en' })
  const result = await hall.request('/mods/api-locale/ping')
  assert.equal(result.ok, true)
  assert.deepEqual(seen.at(-1), { modPath: 'ping', locale: 'en', requestedLocale: 'en' })
})

test('API：/api/updates 商店条目按当前语言本地化，已安装以 Mod i18n 为准并重新排序', async (t) => {
  useTempHome(t)
  const installed = demoMod({ id: 'arkhamhorror', name: '诡镇奇谈：卡牌版' })
  const store = {
    bindUsage() {},
    status: () => ({
      registry: { url: null, checking: false, checkedAt: null, error: null },
      games: [
        {
          id: 'arkhamhorror', name: '诡镇奇谈：卡牌版', description: '合作卡牌，1~4 人', installed: null,
          localized: { en: { name: 'Registry Arkham', description: 'from registry' } },
        },
        {
          id: 'ghost', name: '幽灵游戏', description: '中文描述', installed: null,
          localized: { en: { name: 'Ghost Game', description: 'English description' } },
        },
        {
          id: 'localized-uninstalled', name: '未安装游戏', description: '中文', installed: null,
          localized: { en: { name: 'Uninstalled Game', description: 'An uninstalled game' } },
        },
      ],
    }),
  }
  const hall = await startHall(t, { mods: [installed], updates: { store } })
  assert.equal((await hall.request('/settings', { locale: 'en' })).ok, true)
  const view = await hall.request('/updates')
  assert.equal(view.ok, true)
  const names = Object.fromEntries(view.store.games.map((game) => [game.id, game.name]))
  // 已安装：以 Mod 的 i18n 为准（demoMod 的 en name 是 Gobang），registry 文案不覆盖它。
  assert.equal(names.arkhamhorror, 'Gobang')
  assert.equal(names.ghost, 'Ghost Game')
  assert.equal(names['localized-uninstalled'], 'Uninstalled Game')
  const order = view.store.games.map((game) => game.id)
  // 全部未安装：按英文名排序（Ghost Game < Gobang < Uninstalled Game）。
  assert.deepEqual(order, ['ghost', 'arkhamhorror', 'localized-uninstalled'])
})
