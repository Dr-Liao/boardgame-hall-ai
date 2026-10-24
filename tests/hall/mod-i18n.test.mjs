// Mod 本地化契约测试（docs/localization.md §7.1 / §7.6 / §8.2 / §14.1）：
//   - i18n 校验与规范化：supportedLocales 规范化/去重/上限、defaultLocale 回退、messages 语言过滤；
//   - 结构非法降级：翻译字段写错不能让 Mod 消失；
//   - 原型污染/函数/数组的拒绝；
//   - 顶层 localize 必须是同步函数；
//   - web.locales 的路径安全（越界/绝对路径/不存在 → 拒绝加载）与 localeUrls URL 形状；
//   - fixture-cards / fixture-i18n 两个测试 Mod 的真实加载结果。
//
// 运行：node tests/hall/mod-i18n.test.mjs
// （沙箱下 node --test / npm 脚本会 EPERM，直接按文件运行。）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadModFrom } from '../../lib/mods.js'
import { localizeMod, normalizeLocale } from '../../lib/i18n.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '..', 'fixtures', 'mods')

// 任意临时 Mod 都具备的最小规则接口（本测试只关心加载/校验，不跑对局）。
const BASE_RULES = `
function createState() {
  return { status: 'playing', winnerSeat: null, currentSeat: 0, moveCount: 0, revision: 0, board: Array(9).fill(null) }
}
function decisionSeat(state) { return state.currentSeat }
function actingSeats(state) { return state.status === 'playing' ? [state.currentSeat] : [] }
function legalMoves() { return [] }
function validateMove() { return null }
function applyMove() { return [] }
`

/**
 * 在系统临时目录里创建一个最小 Mod，返回目录。
 * i18n / localize / web 传 JS 源码字符串（这样才能构造函数、JSON.parse('__proto__') 等用例）。
 */
function tempMod(t, { id = 'temp-i18n', i18n = null, localize = null, web = null, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hall-mod-i18n-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fields = [
    'id: ' + JSON.stringify(id) + ',',
    "name: '临时测试棋局',",
    'players: [1, 2],',
    'seats: 2,',
    "description: '仅用于大厅本地化契约测试的临时 Mod。',",
    "tags: ['测试'],",
    "render: { kind: 'board', size: 3, pieceStyle: 'stone' },",
    "settingsSpec: [{ key: 'mode', type: 'select', label: '模式', default: 'a', options: [{ value: 'a', label: '甲' }] }],",
    'moveFormat: \'{"x":0-2,"y":0-2}\',',
    'moveToText: move => JSON.stringify(move),',
    "describeState: () => '测试局面',",
    'decisionSeat, actingSeats, legalMoves, validateMove, applyMove, createState,',
  ]
  if (i18n !== null) fields.push('i18n: ' + i18n + ',')
  if (localize !== null) fields.push('localize: ' + localize + ',')
  if (web !== null) fields.push('web: ' + web + ',')
  fs.writeFileSync(path.join(dir, 'index.js'), BASE_RULES + '\nexport default {\n  ' + fields.join('\n  ') + '\n}\n')
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

function loadMod(dir, id = 'temp-i18n') {
  return loadModFrom({ id, version: '0.0.0', source: 'builtin', hallApi: 1, dir })
}

/** 收集 console.warn，测试结束后恢复（node:test 默认串行执行，不会互相串台）。 */
function captureWarnings(t) {
  const calls = []
  const original = console.warn
  console.warn = (...args) => { calls.push(args.map(String).join(' ')) }
  t.after(() => { console.warn = original })
  return calls
}

function assertWarned(calls, pattern) {
  assert.ok(calls.some((line) => pattern.test(line)), '应 console.warn：' + pattern + '；实际：\n' + calls.join('\n'))
}

const json = (value) => JSON.stringify(value)

// ---------------------------------------------------------------------------
// fixture-i18n：真实测试 Mod 能被 loadModFrom 正常加载
// ---------------------------------------------------------------------------

test('fixture-i18n：loadModFrom 加载成功，i18n 契约与 localeUrls 形状正确', async (t) => {
  const mod = await loadMod(path.join(FIXTURES, 'fixture-i18n'), 'fixture-i18n')
  assert.equal(mod.id, 'fixture-i18n')
  assert.equal(mod.name, '本地化测试棋局')

  assert.deepEqual(mod.i18n.defaultLocale, 'zh-CN')
  assert.deepEqual(mod.i18n.supportedLocales, ['zh-CN', 'en'])
  assert.equal(mod.i18n.messages.en.name, 'Localization Fixture')
  assert.deepEqual(mod.i18n.messages.en.tags, ['Test', 'Localization'])
  assert.equal(mod.i18n.messages.en.settings.mode.label, 'Game mode')
  assert.equal(mod.i18n.messages.en.settings.mode.options.quick, 'Quick')
  assert.equal(mod.i18n.messages['zh-CN'].settings.mode.label, '对局模式')
  // zh-CN 没声明 name/description/tags，加载后也不补：逐字段回退由 lib/i18n.js 负责。
  assert.equal(Object.hasOwn(mod.i18n.messages['zh-CN'], 'name'), false)

  assert.deepEqual(mod.web.localeUrls, {
    'zh-CN': '/mods/fixture-i18n/locales/zh-CN.js',
    en: '/mods/fixture-i18n/locales/en.js',
  })
  assert.equal(mod.web.clientUrl, '/mods/fixture-i18n/client.js')
  assert.equal(mod.web.mount, '/mods/fixture-i18n')
  for (const url of Object.values(mod.web.localeUrls)) {
    assert.match(url, /^\/mods\/fixture-i18n\/locales\/[A-Za-z-]+\.js$/)
    assert.equal(url.includes('..'), false)
    assert.equal(fs.existsSync(path.join(mod.web.root, url.slice('/mods/fixture-i18n/'.length))), true)
  }

  // 与大厅合并逻辑（lib/i18n.js）联调：英文视图取 en 词典，files 来自 localeUrls。
  const view = localizeMod(mod, 'en')
  assert.equal(view.name, 'Localization Fixture')
  assert.equal(view.i18n.resolved, 'en')
  assert.deepEqual(view.i18n.files, mod.web.localeUrls)
  assert.equal(view.settingsSpec[0].label, 'Game mode')
  const zhView = localizeMod(mod, 'zh-CN')
  assert.equal(zhView.name, '本地化测试棋局')
  assert.equal(zhView.settingsSpec[0].label, '对局模式')
})

// ---------------------------------------------------------------------------
// supportedLocales / defaultLocale / messages 规范化
// ---------------------------------------------------------------------------

test('i18n 规范化：supportedLocales 规范化 + 去重 + 最多 20；messages key 规范化到 supportedLocales', async (t) => {
  const warnings = captureWarnings(t)
  // 'aa'..'ay' 25 个合法语言，与前面的语言合计超过上限。
  const many = Array.from({ length: 25 }, (_, i) => String.fromCharCode(97, 97 + i))
  const dir = tempMod(t, {
    i18n: json({
      defaultLocale: 'ZH',
      supportedLocales: ['zh-cn', 'EN', 'zh', 'en-US', 'bad locale', 42, 'en-us', ...many],
      messages: { 'zh-CN': { name: '中文名' }, EN: { name: 'English Name' }, fr: { name: '法语' } },
    }),
    web: "{ dir: 'web', locales: { en: 'locales/en.js' } }",
    files: { 'web/locales/en.js': 'export default {}\n' },
  })
  const mod = await loadMod(dir)

  assert.equal(mod.i18n.supportedLocales.length, 20, '最多保留 20 个语言')
  assert.deepEqual(mod.i18n.supportedLocales.slice(0, 3), ['zh-CN', 'en', 'en-US'])
  assert.equal(new Set(mod.i18n.supportedLocales).size, 20, '规范化后必须去重')
  assert.equal(mod.i18n.defaultLocale, 'zh-CN', "defaultLocale 'ZH' 规范化为 zh-CN 且在支持列表中")
  assert.equal(mod.i18n.messages['zh-CN'].name, '中文名')
  assert.equal(mod.i18n.messages.en.name, 'English Name', 'messages 的大写语言 key 也要规范化')
  assert.equal(Object.hasOwn(mod.i18n.messages, 'fr'), false, '不在 supportedLocales 的语言忽略')
  assertWarned(warnings, /messages 的语言「fr」不在 supportedLocales 中/)
  assertWarned(warnings, /supportedLocales 超过 20 个/)
  assertWarned(warnings, /supportedLocales 含非法语言/)
  // web.locales 的 key 用规范化后的语言匹配 supportedLocales。
  assert.deepEqual(mod.web.localeUrls, { en: '/mods/temp-i18n/locales/en.js' })
})

test('defaultLocale 缺失/非法/不在列表：warn 并回退（支持 zh-CN 优先，其次 supported[0]）', async (t) => {
  const warnings = captureWarnings(t)
  const noZh = await loadMod(tempMod(t, {
    i18n: json({ supportedLocales: ['en', 'fr'], messages: {} }),
  }))
  assert.equal(noZh.i18n.defaultLocale, 'en', '不支持 zh-CN 时回退 supportedLocales[0]')
  assertWarned(warnings, /defaultLocale「undefined」.*回退到 en/)

  warnings.length = 0
  const withZh = await loadMod(tempMod(t, {
    i18n: json({ defaultLocale: 'de', supportedLocales: ['zh-CN', 'en'], messages: {} }),
  }))
  assert.equal(withZh.i18n.defaultLocale, 'zh-CN', '支持 zh-CN 时回退 zh-CN')
  assertWarned(warnings, /defaultLocale「de」.*回退到 zh-CN/)

  warnings.length = 0
  const badDefault = await loadMod(tempMod(t, {
    i18n: json({ defaultLocale: '不良值', supportedLocales: ['en', 'zh-CN'] }),
  }))
  assert.equal(badDefault.i18n.defaultLocale, 'zh-CN')
  assertWarned(warnings, /defaultLocale/)
})

// ---------------------------------------------------------------------------
// 结构非法 → 降级为「没有 i18n」，Mod 仍能加载
// ---------------------------------------------------------------------------

test('i18n 结构非法：warn 后按没有 i18n 继续加载，基础字段仍可用', async (t) => {
  const warnings = captureWarnings(t)
  const cases = [
    { label: 'i18n 不是对象', source: "'not-an-object'" },
    { label: 'supportedLocales 不是数组', source: "{ defaultLocale: 'en', supportedLocales: 'en', messages: {} }" },
    { label: 'supportedLocales 为空', source: "{ defaultLocale: 'en', supportedLocales: [], messages: {} }" },
    { label: 'supportedLocales 全非法', source: "{ supportedLocales: ['bad locale', '../x'], messages: {} }" },
    { label: 'messages 不是对象', source: "{ defaultLocale: 'en', supportedLocales: ['en'], messages: 'nope' }" },
    { label: 'messages 是数组', source: "{ defaultLocale: 'en', supportedLocales: ['en'], messages: [] }" },
  ]
  for (const item of cases) {
    const mod = await loadMod(tempMod(t, { i18n: item.source }))
    assert.equal(mod.i18n, undefined, item.label + '：应降级为没有 i18n')
    assert.equal(mod.name, '临时测试棋局', item.label + '：基础字段必须保留')
    assert.equal(typeof mod.createState, 'function')
  }
  assertWarned(warnings, /i18n：必须是普通对象/)
  assertWarned(warnings, /supportedLocales 必须是数组/)
  assertWarned(warnings, /supportedLocales 为空/)
  assertWarned(warnings, /messages 必须是普通对象/)
})

test('messages 单语言层非法：丢弃该语言/该语言层，其余语言保留，不影响加载', async (t) => {
  const warnings = captureWarnings(t)
  const dir = tempMod(t, {
    i18n: "{ defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'], messages: {\n" +
      "  'zh-CN': { name: '中文名' },\n" +
      '  en: [],\n' +
      "  fr: { name: 'Français' },\n" +
      '} }',
  })
  const mod = await loadMod(dir)
  assert.equal(mod.i18n.messages['zh-CN'].name, '中文名')
  assert.equal(Object.hasOwn(mod.i18n.messages, 'en'), false, '非对象语言层应被丢弃')
  assert.equal(Object.hasOwn(mod.i18n.messages, 'fr'), false, '不支持的语言忽略')
  assertWarned(warnings, /messages\.en 必须是普通对象，已丢弃该语言/)

  // settings 结构明显非法（不是普通对象）→ 按契约丢弃整个语言并 warn。
  warnings.length = 0
  const mod2 = await loadMod(tempMod(t, {
    i18n: json({
      defaultLocale: 'zh-CN',
      supportedLocales: ['zh-CN', 'en'],
      messages: { 'zh-CN': { name: '中文名' }, en: { name: '英文名', settings: ['bad'] } },
    }),
  }))
  assert.equal(Object.hasOwn(mod2.i18n.messages, 'en'), false)
  assert.equal(mod2.i18n.messages['zh-CN'].name, '中文名')
  assertWarned(warnings, /messages\.en\.settings 必须是普通对象，已丢弃该语言/)
})

test('messages 字段白名单：只保留展示文本字段；非法类型忽略；unknown 字段 warn', async (t) => {
  const warnings = captureWarnings(t)
  const dir = tempMod(t, {
    i18n: json({
      defaultLocale: 'zh-CN',
      supportedLocales: ['zh-CN', 'en'],
      messages: {
        'zh-CN': { name: '中文名' },
        en: {
          name: 123,
          description: '   ',
          tags: ['Test', '', 7],
          aiSlotLabel: 'AI',
          aiSlotDescription: ['nope'],
          type: '不许改行为字段',
          settings: {
            mode: { label: 'Mode', description: 'desc', type: 'select', default: 'b', unknown: 1 },
            missing: 'not-an-object',
          },
        },
      },
    }),
  })
  const mod = await loadMod(dir)
  const layer = mod.i18n.messages.en
  assert.equal(Object.hasOwn(layer, 'name'), false, 'name 非字符串应忽略')
  assert.equal(Object.hasOwn(layer, 'description'), false, '空串不是有效翻译')
  assert.deepEqual(layer.tags, ['Test'], 'tags 过滤非字符串/空串')
  assert.equal(layer.aiSlotLabel, 'AI')
  assert.equal(Object.hasOwn(layer, 'aiSlotDescription'), false, '数组不是合法文本')
  assert.equal(Object.hasOwn(layer, 'type'), false, '不允许覆盖行为字段')
  // 设置项只保留 label/description/options，type/default/unknown 全部丢弃。
  assert.deepEqual(layer.settings.mode, { label: 'Mode', description: 'desc' })
  assert.equal(Object.hasOwn(layer.settings, 'missing'), false)
  assertWarned(warnings, /messages\.en\.type 不是允许覆盖的展示字段/)
  assertWarned(warnings, /messages\.en\.settings\.missing 必须是/)
})

// ---------------------------------------------------------------------------
// 原型污染 / 函数 / 数组
// ---------------------------------------------------------------------------

test('原型污染键（__proto__ / constructor / prototype）与函数一律丢弃，不污染 Object.prototype', async (t) => {
  const warnings = captureWarnings(t)
  // JSON.parse 能造出 own 属性的 "__proto__"（对象字面量会改原型，不能用来测这个）。
  const dir = tempMod(t, {
    i18n: "{ defaultLocale: 'en', supportedLocales: ['en'], messages: JSON.parse(\n" +
      '  \'{"__proto__":{"name":"polluted"},"en":{"name":"EN","__proto__":{"hacked":true},"constructor":{"x":1},"prototype":"p"}}\'\n' +
      ') }',
    localize: '(locale) => ({ name: "x" })',
  })
  const mod = await loadMod(dir)
  assert.equal(mod.i18n.messages.en.name, 'EN')
  assert.equal(Object.hasOwn(mod.i18n.messages, '__proto__'), false)
  assert.equal(Object.hasOwn(mod.i18n.messages.en, '__proto__'), false)
  assert.equal(Object.hasOwn(mod.i18n.messages.en, 'constructor'), false)
  assert.equal(Object.hasOwn(mod.i18n.messages.en, 'prototype'), false)
  assert.equal({}.name, undefined)
  assert.equal({}.hacked, undefined)
  assert.equal(Object.getPrototypeOf(mod.i18n.messages.en), Object.prototype)
  assertWarned(warnings, /原型污染键/)

  // 函数放在 messages 里同样被拒绝（localize 必须放 Mod 顶层）。
  warnings.length = 0
  const dir2 = tempMod(t, {
    i18n: "{ defaultLocale: 'en', supportedLocales: ['en'], messages: { en: { name: () => 'fn', settings: { mode: { label: () => 'x' } }, localize: () => ({}) } } }",
  })
  const mod2 = await loadMod(dir2)
  assert.equal(Object.hasOwn(mod2.i18n.messages.en, 'name'), false, '函数不是有效文本')
  assert.equal(Object.hasOwn(mod2.i18n.messages.en, 'localize'), false, '禁止在 messages 里放函数')
  assert.equal(Object.hasOwn(mod2.i18n.messages.en.settings, 'mode'), false)
  assertWarned(warnings, /messages\.en\.localize 不是允许覆盖的展示字段/)
})

// ---------------------------------------------------------------------------
// 顶层 localize(locale) 钩子
// ---------------------------------------------------------------------------

test('顶层 localize 必须是同步函数：非函数/async 被拒绝，同步函数保留并生效', async (t) => {
  const warnings = captureWarnings(t)
  const notFunction = await loadMod(tempMod(t, {
    i18n: json({ defaultLocale: 'en', supportedLocales: ['en'], messages: {} }),
    localize: '42',
  }))
  assert.equal(notFunction.localize, undefined, '非函数 localize 应被删除')
  assertWarned(warnings, /localize：必须是同步函数，已忽略/)

  warnings.length = 0
  const asyncHook = await loadMod(tempMod(t, {
    i18n: json({ defaultLocale: 'en', supportedLocales: ['en'], messages: {} }),
    localize: 'async () => ({ name: "x" })',
  }))
  assert.equal(asyncHook.localize, undefined, 'async 函数不是同步钩子，应被删除')
  assertWarned(warnings, /localize：必须是同步函数（不能是 async）/)

  warnings.length = 0
  const good = await loadMod(tempMod(t, {
    i18n: json({ defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'], messages: { 'zh-CN': { name: '中文名' }, en: { name: 'Static' } } }),
    localize: "(locale) => locale === 'en' ? { name: 'Dynamic', description: 'from localize' } : null",
  }))
  assert.equal(typeof good.localize, 'function', '合法的同步 localize 必须保留')
  const view = localizeMod(good, 'en')
  assert.equal(view.name, 'Dynamic', 'localize 在静态 messages 之后应用')
  assert.equal(view.description, 'from localize')
})

// ---------------------------------------------------------------------------
// web.locales 路径安全与 localeUrls
// ---------------------------------------------------------------------------

test('web.locales：合法路径生成 localeUrls（key 规范化、绝对 URL、文件存在）', async (t) => {
  const warnings = captureWarnings(t)
  const dir = tempMod(t, {
    i18n: json({ defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'], messages: {} }),
    web: "{ dir: 'web', locales: { 'zh-cn': 'locales/zh-CN.js', en: 'locales/en.js' } }",
    files: {
      'web/locales/zh-CN.js': 'export default {}\n',
      'web/locales/en.js': 'export default {}\n',
    },
  })
  const mod = await loadMod(dir)
  assert.deepEqual(mod.web.localeUrls, {
    'zh-CN': '/mods/temp-i18n/locales/zh-CN.js',
    en: '/mods/temp-i18n/locales/en.js',
  }, 'localeUrls 的 key 用规范化 locale，值是挂载前缀 + 相对路径')
  assert.equal(warnings.length, 0, '合法声明不应产生告警：' + warnings.join('\n'))
})

test('web.locales：未声明的语言忽略并 warn，不生成 localeUrls', async (t) => {
  const warnings = captureWarnings(t)
  const dir = tempMod(t, {
    i18n: json({ defaultLocale: 'zh-CN', supportedLocales: ['zh-CN'], messages: {} }),
    web: "{ dir: 'web', locales: { fr: 'locales/fr.js' } }",
    files: { 'web/locales/fr.js': 'export default {}\n' },
  })
  const mod = await loadMod(dir)
  assert.equal(Object.hasOwn(mod.web, 'localeUrls'), false)
  assertWarned(warnings, /web.locales：语言「fr」不在 supportedLocales 中/)
})

test('web.locales：无 i18n 时全部忽略并 warn，Mod 正常加载', async (t) => {
  const warnings = captureWarnings(t)
  const dir = tempMod(t, {
    web: "{ dir: 'web', locales: { en: 'locales/en.js' } }",
    files: { 'web/locales/en.js': 'export default {}\n' },
  })
  const mod = await loadMod(dir)
  assert.equal(mod.i18n, undefined)
  assert.equal(Object.hasOwn(mod.web, 'localeUrls'), false)
  assertWarned(warnings, /不在 supportedLocales 中/)
})

test('web.locales：路径越界 / 绝对路径 / 文件不存在 → 拒绝加载该 Mod（路径安全硬失败）', async (t) => {
  captureWarnings(t)
  const baseI18n = json({ defaultLocale: 'en', supportedLocales: ['en'], messages: {} })
  const escaped = path.resolve(os.tmpdir(), 'hall-mod-i18n-escape.js')
  const cases = [
    { label: '含 ..', locales: "{ en: '../escape.js' }", pattern: /web\.locales\[en\] 文件名非法/ },
    { label: '绝对路径', locales: '{ en: ' + json(escaped) + ' }', pattern: /web\.locales\[en\] 文件名非法/ },
    { label: '文件不存在', locales: "{ en: 'locales/missing.js' }", pattern: /web\.locales\[en\] 不存在/ },
    { label: '不是字符串', locales: '{ en: 42 }', pattern: /web\.locales\[en\] 文件名非法/ },
  ]
  for (const item of cases) {
    const dir = tempMod(t, {
      i18n: baseI18n,
      web: "{ dir: 'web', locales: " + item.locales + ' }',
      files: { 'web/locales/en.js': 'export default {}\n' },
    })
    await assert.rejects(loadMod(dir), item.pattern, item.label + ' 应拒绝加载')
  }
})

test('web.locales：结构非法/重复语言只 warn 不阻断加载', async (t) => {
  const warnings = captureWarnings(t)
  const notObject = await loadMod(tempMod(t, {
    i18n: json({ defaultLocale: 'en', supportedLocales: ['en'], messages: {} }),
    web: "{ dir: 'web', locales: [] }",
    files: { 'web/locales/en.js': 'export default {}\n' },
  }))
  assert.equal(Object.hasOwn(notObject.web, 'localeUrls'), false)
  assertWarned(warnings, /web\.locales：必须是/)

  warnings.length = 0
  const duplicate = await loadMod(tempMod(t, {
    i18n: json({ defaultLocale: 'en', supportedLocales: ['en'], messages: {} }),
    web: "{ dir: 'web', locales: { en: 'locales/en.js', EN: 'locales/en-2.js' } }",
    files: {
      'web/locales/en.js': 'export default {}\n',
      'web/locales/en-2.js': 'export default {}\n',
    },
  }))
  assert.deepEqual(duplicate.web.localeUrls, { en: '/mods/temp-i18n/locales/en.js' }, '重复语言只保留第一份')
  assertWarned(warnings, /重复声明/)
})

// ---------------------------------------------------------------------------
// 旧 Mod 兼容
// ---------------------------------------------------------------------------

test('无 i18n 的旧 Mod：mod.i18n 保持 undefined（不塞空对象），加载不受影响', async (t) => {
  const mod = await loadMod(tempMod(t))
  assert.equal(mod.i18n, undefined)
  assert.equal(mod.web, undefined)

  const fixture = await loadMod(path.join(FIXTURES, 'fixture-static'), 'fixture-static')
  assert.equal(fixture.i18n, undefined, '库里的旧 fixture 也不应被塞入空 i18n')
  assert.equal(fixture.name, '静态表夹具牌局')
  assert.equal(typeof fixture.createState, 'function')
})

// ---------------------------------------------------------------------------
// fixture-cards：大厅回归用的真实 i18n 元数据
// ---------------------------------------------------------------------------

test('fixture-cards：loadModFrom 加载成功，i18n 覆盖展示字段且 localeUrls 可用', async (t) => {
  const mod = await loadMod(path.join(FIXTURES, 'fixture-cards'), 'fixture-cards')
  assert.deepEqual(mod.i18n.supportedLocales, ['zh-CN', 'en'])
  assert.equal(mod.i18n.defaultLocale, 'zh-CN')
  assert.equal(mod.i18n.messages.en.name, 'Fixture Card Game')
  assert.deepEqual(mod.i18n.messages.en.tags, ['Test'])
  assert.equal(mod.i18n.messages.en.settings.seed.label, 'Deck seed')
  assert.deepEqual(mod.web.localeUrls, {
    'zh-CN': '/mods/fixture-cards/locales/zh-CN.js',
    en: '/mods/fixture-cards/locales/en.js',
  })

  const en = localizeMod(mod, 'en')
  assert.equal(en.name, 'Fixture Card Game')
  assert.deepEqual(en.tags, ['Test'], 'tags 整体替换')
  assert.equal(en.settingsSpec.find((item) => item.key === 'seed').label, 'Deck seed')
  const zh = localizeMod(mod, 'zh-CN')
  assert.equal(zh.name, '测试牌局', 'zh-CN 没声明 name 时回退基础字段')
  assert.equal(zh.settingsSpec.find((item) => item.key === 'seed').label, '牌堆种子')
  const fr = localizeMod(mod, 'fr')
  assert.equal(fr.i18n.resolved, 'zh-CN', '不支持的语言回退 defaultLocale')
  assert.equal(fr.name, '测试牌局')
})
