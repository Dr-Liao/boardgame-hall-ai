// 大厅词典完整性回归（docs/localization.md §6.1 / §9.2 / §14.1）：
//   1. zh-CN 与 en 的 key 集合一一对应、值非空、{占位符} 集合一致（en 缺失会静默回退中文，必须靠测试守住）；
//   2. 词典源码里没有重复 key —— 两份文件由大厅壳与各 UI 模块共同追加，重复 key 会静默覆盖且难以发现；
//   3. public/*.js 中所有静态字面量 t('...') 都能在 zh-CN 词典命中（变量/拼接 key 跳过）；
//   4. 服务端 lib/i18n.js 的 HALL_LOCALES 与 public/locales/ 的词典文件、public/i18n.js 的 HALL_LOCALES 一一对应。
//
// 运行：node tests/hall/i18n-dict.test.mjs（沙箱下不要用 node --test / npm script）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PUBLIC_DIR = path.join(ROOT, 'public')
const LOCALES_DIR = path.join(PUBLIC_DIR, 'locales')

const load = async (file) => (await import(pathToFileURL(file).href)).default
const zh = await load(path.join(LOCALES_DIR, 'zh-CN.js'))
const en = await load(path.join(LOCALES_DIR, 'en.js'))

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

test('zh-CN 与 en 的 key 集合一一对应', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys.filter((key) => !zhKeys.includes(key)), [], 'en 多出的 key（zh-CN 缺失）')
  assert.deepEqual(zhKeys.filter((key) => !enKeys.includes(key)), [], 'en 缺少的 key')
})

test('词典值都是非空字符串', () => {
  for (const [name, dict] of [['zh-CN', zh], ['en', en]]) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', name + ' 的 ' + key + ' 不是字符串')
      assert.notEqual(value.trim(), '', name + ' 的 ' + key + ' 为空')
    }
  }
})

test('中英词典的 {占位符} 集合一致', () => {
  for (const key of Object.keys(zh)) {
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), key + ' 的占位符与中文不一致')
  }
})

test('词典源码没有重复 key（多人/多模块追加时的静默覆盖）', () => {
  for (const name of ['zh-CN', 'en']) {
    const source = fs.readFileSync(path.join(LOCALES_DIR, name + '.js'), 'utf8')
    const seen = new Map()
    for (const match of source.matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)) {
      const key = match[1]
      seen.set(key, (seen.get(key) || 0) + 1)
    }
    assert.deepEqual([...seen].filter(([, count]) => count > 1), [], name + '.js 存在重复 key')
  }
})

test('public/*.js 的静态 t(字面量) 都能在 zh-CN 词典命中', () => {
  const files = fs.readdirSync(PUBLIC_DIR).filter((name) => name.endsWith('.js'))
  assert.ok(files.includes('app.js'), 'public/app.js 必须存在')
  const missing = []
  for (const name of files) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8')
    // 只匹配 t('key') / t("key", {...}) 这种静态字符串首参；t('error.' + code) 因后随 '+' 被跳过。
    for (const match of source.matchAll(/\bt\(\s*(['"])([^'"\\\n]+)\1\s*(?=[,)])/g)) {
      const key = match[2]
      if (!Object.hasOwn(zh, key)) missing.push(name + ': ' + key)
    }
  }
  assert.deepEqual(missing, [], '以下 t() key 不在 public/locales/zh-CN.js 中')
})

test('服务端 HALL_LOCALES 与前端词典文件、前端 HALL_LOCALES 一一对应', async () => {
  const serverI18n = await import(pathToFileURL(path.join(ROOT, 'lib', 'i18n.js')).href)
  const clientI18n = await import(pathToFileURL(path.join(PUBLIC_DIR, 'i18n.js')).href)
  const serverIds = serverI18n.HALL_LOCALES.map((item) => item.id).sort()
  const clientIds = clientI18n.HALL_LOCALES.map((item) => item.id).sort()
  const packIds = fs.readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.slice(0, -3))
    .sort()
  assert.deepEqual(serverIds, clientIds, '服务端与浏览器端 HALL_LOCALES 不一致')
  assert.deepEqual(serverIds, packIds, 'public/locales/ 的词典文件与 HALL_LOCALES 不一致')

  // 每个语言包都能真正切换：t('app.title') 不能返回裸 key，且命中的是该语言自己的译文。
  const packs = Object.fromEntries(await Promise.all(packIds.map(async (id) => [id, await load(path.join(LOCALES_DIR, id + '.js'))])))
  for (const id of packIds) {
    assert.equal(clientI18n.setLocale(id), id, 'setLocale(' + id + ') 未生效')
    assert.equal(clientI18n.getLocale(), id)
    assert.equal(clientI18n.t('app.title'), packs[id]['app.title'], id + ' 的 app.title 未命中自身词典')
  }
  clientI18n.setLocale('zh-CN')
})
