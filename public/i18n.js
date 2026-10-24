// 桌游大厅 · 浏览器端国际化（i18n）
//
// 设计文档：docs/localization.md §5.5 / §6。
//   - 词典随 app.js 静态加载（无额外网络请求、无构建、无依赖）；
//   - 当前语言由服务端 /api/settings 决定，boot() 在首次 render() 之前 setLocale()；
//   - 大厅只维护自己的文案；游戏正文由 Mod 自己的 web/locales/ 负责。
//
// 回退顺序：当前语言[key] → zh-CN[key] → key（开发模式 warn 一次）。
// 主路径不允许出现裸 key：由 tests/hall/i18n-dict.test.mjs 的词典完整性用例守住。

import zhCN from './locales/zh-CN.js'
import en from './locales/en.js'

export const SOURCE_LOCALE = 'zh-CN'

// 与服务端 lib/i18n.js 的 HALL_LOCALES 一一对应；服务端列表决定设置页能选什么。
export const HALL_LOCALES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
]

// dir 为 RTL 预留（v1 全部 ltr）；接入 RTL 语言时在这里声明并在 CSS 层做专门适配。
const PACKS = {
  'zh-CN': { dict: zhCN, dir: 'ltr' },
  en: { dict: en, dir: 'ltr' },
}

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const MAX_LOCALE_LENGTH = 35
const DEV = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')
const WARNED = new Set()

let currentLocale = SOURCE_LOCALE
let currentPack = PACKS[SOURCE_LOCALE]

/** 规范化 BCP 47 子集（与 lib/i18n.js 同一规则）：非法输入返回 null，不抛异常。 */
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
  return tag === 'zh' ? SOURCE_LOCALE : tag
}

/**
 * 切换当前语言：更新词典、<html lang/dir> 与 document.title。
 * 必须在首次 render() 之前调用，避免先渲染中文再闪成英文。
 * @returns {string} 实际生效的语言 tag
 */
export function setLocale(locale) {
  const tag = normalizeLocale(locale) || SOURCE_LOCALE
  currentLocale = Object.hasOwn(PACKS, tag) ? tag : SOURCE_LOCALE
  currentPack = PACKS[currentLocale]
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = currentLocale
    document.documentElement.dir = currentPack.dir || 'ltr'
    document.title = t('app.title')
  }
  return currentLocale
}

/** 当前生效的语言 tag（已规范化）。 */
export function getLocale() {
  return currentLocale
}

/** 可选语言列表（含 endonym 名称），供设置页在没有 /api/settings 时兜底。 */
export function hallLocales() {
  return HALL_LOCALES.map((item) => ({ ...item }))
}

function lookup(dict, key) {
  return dict && Object.hasOwn(dict, key) ? dict[key] : null
}

function interpolate(template, vars) {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match))
}

/**
 * 取当前语言的文案并做 {name} 插值。
 * 回退顺序：当前语言 → zh-CN → key；key 本身只作为开发期兜底，不允许出现在主路径。
 */
export function t(key, vars) {
  let value = lookup(currentPack.dict, key)
  if (typeof value !== 'string') value = lookup(PACKS[SOURCE_LOCALE].dict, key)
  if (typeof value !== 'string') {
    if (DEV && !WARNED.has(key)) { WARNED.add(key); console.warn('[i18n] 缺少文案：' + key) }
    return key
  }
  return interpolate(value, vars)
}

/** 该 key 在当前语言与源语言词典里是否存在（测试/诊断用）。 */
export function hasKey(key) {
  return typeof lookup(currentPack.dict, key) === 'string' || typeof lookup(PACKS[SOURCE_LOCALE].dict, key) === 'string'
}

/** Intl.DateTimeFormat(getLocale())；传 Date/时间戳/ISO 字符串。 */
export function formatDate(value, options) {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat(currentLocale, options).format(date)
}

/** Intl.NumberFormat(getLocale())。 */
export function formatNumber(value, options) {
  return new Intl.NumberFormat(currentLocale, options).format(value)
}
