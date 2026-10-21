#!/usr/bin/env node
// 用法：node tools/release/set-version.mjs <x.y.z> --target=hall|arkham|all
//   --target=hall    只更新大厅：package.json / package-lock.json
//   --target=arkham  只更新诡镇奇谈：games/arkhamhorror/package.json / boardgame-mod.json
//   --target=all     两边一起更新
// 只替换版本字段，保持原文件格式。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FILES = {
  hallPackage: path.join(ROOT, 'package.json'),
  hallLock: path.join(ROOT, 'package-lock.json'),
  arkhamPackage: path.join(ROOT, 'games', 'arkhamhorror', 'package.json'),
  arkhamManifest: path.join(ROOT, 'games', 'arkhamhorror', 'boardgame-mod.json'),
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TARGETS = new Set(['hall', 'arkham', 'all'])
const USAGE = '用法：node tools/release/set-version.mjs <x.y.z> --target=hall|arkham|all'

function fail(message) {
  console.error(`[错误] ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const flags = args.filter((arg) => arg.startsWith('--'))
const values = args.filter((arg) => !arg.startsWith('--'))
if (values.length !== 1) fail(USAGE)
if (flags.some((flag) => !flag.startsWith('--target='))) fail(USAGE)

const version = values[0]
const target = (flags.find((flag) => flag.startsWith('--target=')) ?? '').slice('--target='.length)
if (!TARGETS.has(target)) fail(USAGE)
if (!VERSION_RE.test(version)) fail(USAGE)

function read(file) {
  return readFileSync(file, 'utf8')
}

function readJson(file) {
  return parseJson(read(file), file)
}

function parseJson(text, file) {
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${path.relative(ROOT, file)} 不是合法 JSON：${error.message}`)
  }
}

function compare(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

const hall = readJson(FILES.hallPackage)
const arkham = readJson(FILES.arkhamPackage)
const arkhamManifest = readJson(FILES.arkhamManifest)

if (arkham.version !== arkhamManifest.version) {
  fail(
    `诡镇奇谈的 package.json 版本 ${arkham.version} 与 boardgame-mod.json 版本 ${arkhamManifest.version} 不一致，请先对齐`
  )
}

if (target !== 'arkham' && compare(version, hall.version) <= 0) {
  fail(`新版本号 ${version} 必须大于大厅当前版本 ${hall.version}`)
}
if (target !== 'hall' && compare(version, arkhamManifest.version) <= 0) {
  fail(`新版本号 ${version} 必须大于诡镇奇谈当前版本 ${arkhamManifest.version}`)
}

// 顶层版本字段固定为两格缩进，避免误改依赖里的 version。
const TOP_VERSION = /^(  "version"\s*:\s*")[^"]*(")/m
const LOCK_ROOT = /("":\s*\{\s*\n\s*"name":\s*"dsh-boardgame-hall",\s*\n\s*"version":\s*")[^"]*(")/
const LOCK_ARKHAM = /("games\/arkhamhorror":\s*\{\s*\n\s*"name":\s*"dsh-boardgame-arkhamhorror",\s*\n\s*"version":\s*")[^"]*(")/

function replaceVersion(text, pattern, label, next = version) {
  if (!pattern.test(text)) fail(`未找到 ${label} 的版本字段`)
  return text.replace(pattern, `$1${next}$2`)
}

function assertVersion(value, expected, label) {
  if (value !== expected) fail(`${label} 更新后版本是 ${value}，预期 ${expected}`)
}

const changes = []

if (target !== 'arkham') {
  const hallText = replaceVersion(read(FILES.hallPackage), TOP_VERSION, 'package.json')
  let lockText = read(FILES.hallLock)
  lockText = replaceVersion(lockText, TOP_VERSION, 'package-lock.json 顶层')
  lockText = replaceVersion(lockText, LOCK_ROOT, 'package-lock.json 大厅')
  // package-lock 里的诡镇奇谈条目镜像它自己的 package.json，跟随诡镇版本而不是大厅版本。
  lockText = replaceVersion(lockText, LOCK_ARKHAM, 'package-lock.json 诡镇奇谈', arkham.version)

  const hallAfter = parseJson(hallText, FILES.hallPackage)
  const lockAfter = parseJson(lockText, FILES.hallLock)
  assertVersion(hallAfter.version, version, 'package.json')
  assertVersion(lockAfter.version, version, 'package-lock.json 顶层')
  assertVersion(lockAfter.packages?.['']?.version, version, 'package-lock.json 大厅')
  assertVersion(lockAfter.packages?.['games/arkhamhorror']?.version, arkham.version, 'package-lock.json 诡镇奇谈')

  changes.push([FILES.hallPackage, hallText], [FILES.hallLock, lockText])
}

if (target !== 'hall') {
  const arkhamPackageText = replaceVersion(
    read(FILES.arkhamPackage),
    TOP_VERSION,
    'games/arkhamhorror/package.json'
  )
  const arkhamManifestText = replaceVersion(
    read(FILES.arkhamManifest),
    TOP_VERSION,
    'games/arkhamhorror/boardgame-mod.json'
  )

  const arkhamPackageAfter = parseJson(arkhamPackageText, FILES.arkhamPackage)
  const arkhamManifestAfter = parseJson(arkhamManifestText, FILES.arkhamManifest)
  assertVersion(arkhamPackageAfter.version, version, 'games/arkhamhorror/package.json')
  assertVersion(arkhamManifestAfter.version, version, 'games/arkhamhorror/boardgame-mod.json')

  changes.push([FILES.arkhamPackage, arkhamPackageText], [FILES.arkhamManifest, arkhamManifestText])
}

for (const [file, text] of changes) writeFileSync(file, text)

if (target !== 'arkham') {
  console.log(`大厅版本已更新：${hall.version} -> ${version}`)
  console.log('  package.json / package-lock.json')
}
if (target !== 'hall') {
  console.log(`诡镇奇谈版本已更新：${arkhamManifest.version} -> ${version}`)
  console.log('  games/arkhamhorror/package.json / boardgame-mod.json')
}
