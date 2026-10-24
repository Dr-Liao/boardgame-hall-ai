// 大厅侧国际化（i18n）：语言规范化、语言选择、Mod 元数据合并与逐字段回退。
//
// 设计文档：docs/localization.md §3（术语与语言标识）、§7（元数据本地化）、§9（回退规则）。
//
// 职责边界：
//   - 大厅只保存「当前语言」这一项偏好（lib/settings.js），具体翻译文本属于各自的所有者：
//     大厅文案在 public/locales/，游戏文案在游戏包自己的 web/locales/；
//   - 服务端在这里解析一次语言并合并 Mod 元数据，随 /api/catalog 下发「已解析结果」；
//     浏览器端不再实现第二套解析算法，避免两端结果不一致；
//   - 游戏正文（卡牌、战役、规则）大厅不翻译，只把 resolved 语言与语言包 URL 交给 Mod。
//
// 本模块不读盘、不缓存：每次调用都基于传入的 requested locale 重新解析（Mod 数量个位数，
// 字段很少，开销可忽略）；需要当前大厅语言时由调用方传入 loadSettings().locale。

export const SOURCE_LOCALE = 'zh-CN'

// 大厅支持的语言（v1）。语言名用该语言自己的写法（endonym），不随当前界面语言变化。
// 新增语言时：改这里、在 public/i18n.js 增加静态 import、新增 public/locales/<tag>.js。
export const HALL_LOCALES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
]

const HALL_LOCALE_IDS = new Set(HALL_LOCALES.map((item) => item.id))
// BCP 47 子集：本项目只使用「语言[-地区]」这样的 1–3 段 tag。
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const MAX_LOCALE_LENGTH = 35
const MAX_SUPPORTED = 20
// 只用于防止本地化结果被原型污染/改写未知字段；合法的 message key 永远不含这些名字。
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// 大厅自己生成、必须随请求语言下发的用户可见文案（目前只有自动注入的「对手 AI」设置项）。
// 与浏览器词典 public/locales/*.js 是两套资源：这里只服务服务端渲染的元数据，
// 值一旦变化要同时更新 public/locales 里的对应文案，避免目录与大厅界面不一致。
const HALL_MESSAGES = {
  'zh-CN': {
    'aiSlot.label': '对手 AI',
    'aiSlot.description': '由 AI 扮演的对家（从 AI 列表中选择）',
  },
  en: {
    'aiSlot.label': 'AI opponent',
    'aiSlot.description': 'An AI-controlled opponent (chosen from the AI list)',
  },
}

/** 规范化 BCP 47 子集：trim、`_`→`-`、大小写归一；非法返回 null，不抛异常。 */
export function normalizeLocale(input) {
  if (typeof input !== 'string') return null
  const value = input.trim().replace(/_/g, '-')
  if (!value || value.length > MAX_LOCALE_LENGTH) return null
  if (!LOCALE_PATTERN.test(value)) return null
  const [language, ...rest] = value.split('-')
  const parts = [language.toLowerCase()]
  for (const part of rest) {
    if (/^[A-Za-z]{4}$/.test(part)) parts.push(part[0].toUpperCase() + part.slice(1).toLowerCase())
    else if (/^(?:[A-Za-z]{2}|[0-9]{3})$/.test(part)) parts.push(part.toUpperCase())
    else parts.push(part.toLowerCase())
  }
  const tag = parts.join('-')
  // 别名只保留最小集合：zh → zh-CN（项目现有文案都是简体中文，别名含义明确）。
  // 不把 zh-Hant 自动映射到 zh-TW：简繁不是字符串替换，需要显式支持列表。
  return tag === 'zh' ? SOURCE_LOCALE : tag
}

/** 是否是当前大厅支持的语言（已规范化）。 */
export function isHallLocale(locale) {
  const tag = normalizeLocale(locale)
  return !!tag && HALL_LOCALE_IDS.has(tag)
}

/** 大厅自己生成、需要按请求语言下发的文案；缺失时回退源语言，再退到 key。 */
export function hallText(locale, key) {
  const tag = normalizeLocale(locale) || SOURCE_LOCALE
  const dict = Object.hasOwn(HALL_MESSAGES, tag) ? HALL_MESSAGES[tag] : null
  const value = dict && Object.hasOwn(dict, key) ? dict[key] : null
  if (typeof value === 'string' && value.trim()) return value
  const source = HALL_MESSAGES[SOURCE_LOCALE]
  return source && Object.hasOwn(source, key) ? source[key] : key
}

/**
 * 选语言（docs/localization.md §9.1）。
 *
 * requested → 精确匹配 → 同主语言（只接受唯一的、语言-only 候选，如 en-US→en）→ Mod 默认语言。
 * 没有声明任何语言的旧 Mod 返回源语言（source / fellBack=true）。
 *
 * @returns {{requested:string, resolved:string, defaultLocale:string,
 *            supportedLocales:string[], matched:'exact'|'base-language'|'mod-default'|'source',
 *            fellBack:boolean}}
 */
export function resolveLocale(requested, i18n) {
  const declared = Array.isArray(i18n?.supportedLocales) ? i18n.supportedLocales : []
  const supported = [...new Set(declared.map(normalizeLocale).filter(Boolean))].slice(0, MAX_SUPPORTED)
  const wanted = normalizeLocale(requested) || SOURCE_LOCALE

  // 0. 没有声明任何语言：旧 Mod，按源语言。
  if (!supported.length) {
    return { requested: wanted, resolved: SOURCE_LOCALE, defaultLocale: SOURCE_LOCALE,
      supportedLocales: [], matched: 'source', fellBack: true }
  }

  // 0.1 归一化 defaultLocale，保证它一定在 supported 中。
  let defaultLocale = normalizeLocale(i18n?.defaultLocale)
  if (!defaultLocale || !supported.includes(defaultLocale)) {
    defaultLocale = supported.includes(SOURCE_LOCALE) ? SOURCE_LOCALE : supported[0]
    console.warn('[i18n] defaultLocale 不在 supportedLocales 中，已回退到 ' + defaultLocale)
  }

  // 1. 精确匹配（大小写不敏感，因为两边都已规范化）。
  if (supported.includes(wanted)) {
    return { requested: wanted, resolved: wanted, defaultLocale, supportedLocales: supported,
      matched: 'exact', fellBack: false }
  }

  // 2. 同主语言：只接受「唯一的、语言-only 的」候选。
  //    en-US → en 可以；zh-TW → zh-CN 不可以（简繁不同，必须走默认语言）。
  const base = wanted.split('-')[0]
  const sameBase = supported.filter((tag) => tag.split('-')[0] === base)
  if (sameBase.length === 1 && sameBase[0].split('-').length === 1) {
    return { requested: wanted, resolved: sameBase[0], defaultLocale, supportedLocales: supported,
      matched: 'base-language', fellBack: false }
  }

  // 3. 游戏自己的默认语言（上面已保证 defaultLocale ∈ supported）。
  return { requested: wanted, resolved: defaultLocale, defaultLocale, supportedLocales: supported,
    matched: 'mod-default', fellBack: true }
}

/** 只解析某个 Mod 的语言，不构建元数据（handleApi / createState 等热路径用）。 */
export function resolveModLocale(mod, requested) {
  return resolveLocale(requested, mod?.i18n)
}

// ---------------------------------------------------------------------------
// Mod 元数据本地化（catalog / 商店里「已安装」条目的展示）
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 只接受非空字符串作为有效翻译：空串/null/undefined 都继续用下一层（不要用 ??）。 */
function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function messageLayer(messages, locale) {
  if (!isPlainObject(messages) || typeof locale !== 'string') return null
  if (!Object.hasOwn(messages, locale)) return null
  return isPlainObject(messages[locale]) ? messages[locale] : null
}

/** 把一层 message 合并进展示视图；不修改入参对象。 */
function applyMessageLayer(result, layer) {
  if (!isPlainObject(layer)) return
  result.name = textOr(layer.name, result.name)
  result.description = textOr(layer.description, result.description)
  if (Array.isArray(layer.tags)) result.tags = layer.tags.filter((tag) => typeof tag === 'string' && tag.trim())
  result.aiSlotLabel = textOr(layer.aiSlotLabel, result.aiSlotLabel)
  result.aiSlotDescription = textOr(layer.aiSlotDescription, result.aiSlotDescription)
  result.settingsSpec = mergeSettings(result.settingsSpec, layer.settings)
}

/**
 * 设置项只允许覆盖展示文本（label / description / options 的 value → label），
 * 不允许改 type/default/选项集合，避免「翻译」意外改变玩法配置。
 * 返回新数组；未命中的项与未知 key 全部保持原样。
 */
function mergeSettings(spec, overrides) {
  if (!Array.isArray(spec) || !isPlainObject(overrides)) return spec
  const bases = Array.isArray(spec) ? spec : []
  return bases.map((item) => {
    if (!isPlainObject(item) || typeof item.key !== 'string') return item
    if (!Object.hasOwn(overrides, item.key) || BLOCKED_KEYS.has(item.key)) return item
    const override = overrides[item.key]
    if (!isPlainObject(override)) return item
    const next = { ...item }
    if (typeof override.label === 'string' && override.label.trim()) next.label = override.label
    if (typeof override.description === 'string' && override.description.trim()) next.description = override.description
    if (isPlainObject(override.options) && Array.isArray(item.options)) {
      next.options = item.options.map((option) => {
        if (!isPlainObject(option)) return option
        const label = override.options[String(option.value)]
        return typeof label === 'string' && label.trim() ? { ...option, label } : option
      })
    }
    return next
  })
}

function localeFiles(mod) {
  const files = mod?.web?.localeUrls
  return isPlainObject(files) ? { ...files } : null
}

/** 可选钩子 `localize(locale)`：同步纯函数，在静态 messages 之后应用，优先级最高。 */
function applyLocalizeHook(mod, locale, result) {
  if (typeof mod?.localize !== 'function') return
  let layer
  try {
    layer = mod.localize(locale)
  } catch (err) {
    console.warn('[i18n] ' + (mod.id || 'mod') + '.localize(' + locale + ') 抛错，已忽略：' +
      String(err && err.message ? err.message : err))
    return
  }
  // null 表示「该语言没有动态覆盖」，是正常返回值；其它非法形状 / 异步返回值忽略并告警。
  if (layer == null) return
  if (!isPlainObject(layer) || typeof layer.then === 'function') {
    console.warn('[i18n] ' + (mod.id || 'mod') + '.localize(' + locale + ') 必须同步返回对象或 null，已忽略')
    return
  }
  applyMessageLayer(result, layer)
}

/**
 * 生成某个 Mod 在指定语言下的展示视图（docs/localization.md §7.3）。
 *
 * 返回只含展示字段的对象，不修改 mod、也不展开整个 Mod（clientData/settingsSpec 可能是 getter）。
 * 回退顺序：messages[resolved] → messages[defaultLocale] → 基础字段；最后应用 localize 钩子。
 * 没有 i18n 的旧 Mod：基础字段 + source/legacy-name 标记，行为与现在一致。
 */
export function localizeMod(mod, requested) {
  if (!mod || typeof mod !== 'object') throw new TypeError('localizeMod 需要 Mod 对象')
  const canonical = normalizeLocale(requested) || SOURCE_LOCALE
  const info = { ...resolveModLocale(mod, canonical), files: localeFiles(mod) }
  const messages = isPlainObject(mod.i18n) ? mod.i18n.messages : null

  const result = {
    name: mod.name,
    description: typeof mod.description === 'string' ? mod.description : '',
    tags: Array.isArray(mod.tags) ? mod.tags.filter((tag) => typeof tag === 'string') : [],
    aiSlotLabel: typeof mod.aiSlotLabel === 'string' ? mod.aiSlotLabel : undefined,
    aiSlotDescription: typeof mod.aiSlotDescription === 'string' ? mod.aiSlotDescription : undefined,
    settingsSpec: Array.isArray(mod.settingsSpec) ? mod.settingsSpec : [],
    i18n: info,
  }

  const applied = new Set()
  for (const locale of [info.defaultLocale, info.resolved]) {
    if (!locale || applied.has(locale)) continue
    applied.add(locale)
    applyMessageLayer(result, messageLayer(messages, locale))
  }
  applyLocalizeHook(mod, info.resolved, result)

  // §7.5：没有 i18n 的旧 Mod 在英文下至少显示 nameEn；只有名称是英文，其余仍为默认语言。
  const declared = Array.isArray(info.supportedLocales) && info.supportedLocales.length > 0
  if (!declared && canonical === 'en') {
    const legacyName = textOr(mod.nameEn, '')
    if (legacyName) {
      result.name = legacyName
      result.i18n = { ...result.i18n, matched: 'legacy-name', fellBack: true }
    }
  }
  return result
}

/**
 * 游戏商店里「未安装」条目的展示文案（docs/localization.md §7.7）。
 * registry 没有 defaultLocale，所以匹配不到就回退基础中文文案。
 */
export function localizeStoreGame(game, requested) {
  const canonical = normalizeLocale(requested) || SOURCE_LOCALE
  const base = {
    name: typeof game?.name === 'string' ? game.name : '',
    description: typeof game?.description === 'string' ? game.description : '',
  }
  if (!isPlainObject(game?.localized)) return base
  const entries = []
  for (const key of Object.keys(game.localized)) {
    const tag = normalizeLocale(key)
    const value = game.localized[key]
    if (!tag || !isPlainObject(value) || BLOCKED_KEYS.has(key)) continue
    entries.push([tag, value])
  }
  if (!entries.length) return base
  let picked = entries.find(([tag]) => tag === canonical)
  if (!picked) {
    const baseLanguage = canonical.split('-')[0]
    const sameBase = entries.filter(([tag]) => tag.split('-')[0] === baseLanguage && tag.split('-').length === 1)
    if (sameBase.length === 1) picked = sameBase[0]
  }
  if (!picked) return base
  return {
    name: textOr(picked[1].name, base.name),
    description: textOr(picked[1].description, base.description),
  }
}
