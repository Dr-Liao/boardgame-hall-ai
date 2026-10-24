// 大厅通用偏好设置：语言偏好（docs/localization.md §5.1）。
//
// 文件：<DSH_HOME 或 ~/.dsh>/boardgame-hall/settings.json
//   { "schema": 1, "locale": "zh-CN" }
//
// 规则：
//   - 文件不存在 → 默认 zh-CN，不报错；
//   - JSON 损坏 / schema 非 1 / locale 不受支持 → 回退 zh-CN 并 console.warn（不阻止启动）；
//   - 保存时保留未知字段（向前兼容未来设置项），先写 .tmp 再 rename，避免半截文件；
//   - 每次请求重新读盘（文件很小），不做进程内缓存，避免测试/多实例读到旧值；
//   - 不放进 updates.json（更新设置）或 boardgame.config.json（模型/玩家资料）；
//     v1 不新增环境变量覆盖，多实例隔离继续用 DSH_HOME。

import fs from 'node:fs'
import path from 'node:path'
import { hallDataDir } from './update-common.js'
import { HALL_LOCALES, SOURCE_LOCALE, normalizeLocale } from './i18n.js'

export const HALL_LOCALE_DEFAULT = SOURCE_LOCALE
export const SETTINGS_SCHEMA = 1

const ALLOWED_LOCALES = new Set(HALL_LOCALES.map((item) => item.id))
const WARNED = new Set()

function warnOnce(message) {
  if (WARNED.has(message)) return
  WARNED.add(message)
  console.warn(message)
}

export function settingsFile() {
  return path.join(hallDataDir(), 'settings.json')
}

function defaultSettings() {
  return { schema: SETTINGS_SCHEMA, locale: HALL_LOCALE_DEFAULT }
}

/** 校验并归一化从磁盘读到的内容；结构性问题一律回退默认值，不抛异常。 */
function sanitize(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    warnOnce('[settings] settings.json 不是 JSON 对象，已回退 ' + HALL_LOCALE_DEFAULT)
    return defaultSettings()
  }
  if (data.schema !== SETTINGS_SCHEMA) {
    warnOnce('[settings] settings.json schema 不是 ' + SETTINGS_SCHEMA + '，已回退 ' + HALL_LOCALE_DEFAULT)
    return defaultSettings()
  }
  const locale = normalizeLocale(data.locale)
  if (!locale || !ALLOWED_LOCALES.has(locale)) {
    warnOnce('[settings] settings.json 中的语言不受支持（' + String(data.locale) + '），已回退 ' + HALL_LOCALE_DEFAULT)
    return defaultSettings()
  }
  // 保留未知字段，向前兼容未来新增的设置项。
  return { ...data, schema: SETTINGS_SCHEMA, locale }
}

/** 读取大厅偏好；任何异常都回退默认值，绝不阻止大厅启动。 */
export function loadSettings() {
  let text
  try {
    text = fs.readFileSync(settingsFile(), 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') warnOnce('[settings] 无法读取 settings.json，已按默认设置运行：' + String(err?.message || err))
    return defaultSettings()
  }
  try {
    return sanitize(JSON.parse(text))
  } catch {
    warnOnce('[settings] settings.json 不是有效的 JSON，已回退 ' + HALL_LOCALE_DEFAULT)
    return defaultSettings()
  }
}

function invalidLocaleError(value) {
  return Object.assign(new Error('不支持的语言：' + String(value)), { code: 'INVALID_LOCALE', statusCode: 400 })
}

/**
 * 合并并保存偏好：patch 中出现的字段覆盖当前值，其余未知字段保留。
 * locale 用 normalizeLocale 规范化（zh → zh-CN）；规范化后仍不受支持时抛 code=INVALID_LOCALE。
 * 返回生效后的完整设置对象。
 */
export function saveSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('设置必须是 JSON 对象'), { code: 'INVALID_SETTINGS', statusCode: 400 })
  }
  const next = { ...loadSettings(), ...patch, schema: SETTINGS_SCHEMA }
  if (Object.hasOwn(patch, 'locale')) {
    const locale = normalizeLocale(patch.locale)
    if (!locale || !ALLOWED_LOCALES.has(locale)) throw invalidLocaleError(patch.locale)
    next.locale = locale
  }
  const file = settingsFile()
  const tmp = file + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw Object.assign(new Error('保存语言设置失败：' + String(err?.message || err)), { code: 'SETTINGS_WRITE_FAILED', statusCode: 500 })
  }
  return next
}

/** GET/POST /api/settings 的响应体：设置 + 可选语言列表（前端一次更新状态）。 */
export function settingsView() {
  return {
    ok: true,
    settings: loadSettings(),
    locales: HALL_LOCALES.map((item) => ({ ...item })),
  }
}
