#!/usr/bin/env node
// 用法：node tools/release/set-version.mjs <x.y.z>
// 同步更新大厅与诡镇奇谈的版本号：
//   package.json / package-lock.json
//   games/arkhamhorror/package.json / games/arkhamhorror/boardgame-mod.json
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

function fail(message) {
  console.error(`[错误] ${message}`)
  process.exit(1)
}

const version = process.argv[2]
if (!version || !VERSION_RE.test(version)) {
  fail('用法：node tools/release/set-version.mjs <x.y.z>')
}

function read(file) {
  return readFileSync(file, 'utf8')
}

function readJson(file) {
  try {
    return JSON.parse(read(file))
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
const arkham = readJson(FILES.arkhamManifest)

if (compare(version, hall.version) <= 0) {
  fail(`新版本号 ${version} 必须大于大厅当前版本 ${hall.version}`)
}
if (compare(version, arkham.version) <= 0) {
  fail(`新版本号 ${version} 必须大于诡镇奇谈当前版本 ${arkham.version}`)
}

// 顶层版本字段固定为两格缩进，避免误改依赖里的 version。
const TOP_VERSION = /^(  "version"\s*:\s*")[^"]*(")/m
const LOCK_ROOT = /("":\s*\{\s*\n\s*"name":\s*"dsh-boardgame-hall",\s*\n\s*"version":\s*")[^"]*(")/
const LOCK_ARKHAM = /("games\/arkhamhorror":\s*\{\s*\n\s*"name":\s*"dsh-boardgame-arkhamhorror",\s*\n\s*"version":\s*")[^"]*(")/

function replaceVersion(text, pattern, label) {
  if (!pattern.test(text)) fail(`未找到 ${label} 的版本字段`)
  const next = text.replace(pattern, `$1${version}$2`)
  if (next === text) fail(`未能更新 ${label} 的版本字段`)
  return next
}

function assertVersion(value, expected, label) {
  if (value !== expected) fail(`${label} 更新后版本是 ${value}，预期 ${expected}`)
}

const hallText = replaceVersion(read(FILES.hallPackage), TOP_VERSION, 'package.json')
const arkhamPackageText = replaceVersion(read(FILES.arkhamPackage), TOP_VERSION, 'games/arkhamhorror/package.json')
const arkhamManifestText = replaceVersion(read(FILES.arkhamManifest), TOP_VERSION, 'games/arkhamhorror/boardgame-mod.json')

let lockText = read(FILES.hallLock)
lockText = replaceVersion(lockText, TOP_VERSION, 'package-lock.json 顶层')
lockText = replaceVersion(lockText, LOCK_ROOT, 'package-lock.json 大厅')
lockText = replaceVersion(lockText, LOCK_ARKHAM, 'package-lock.json 诡镇奇谈')

let hallAfter
let arkhamPackageAfter
let arkhamManifestAfter
let lockAfter
try {
  hallAfter = JSON.parse(hallText)
  arkhamPackageAfter = JSON.parse(arkhamPackageText)
  arkhamManifestAfter = JSON.parse(arkhamManifestText)
  lockAfter = JSON.parse(lockText)
} catch (error) {
  fail(`版本更新后 JSON 校验失败：${error.message}`)
}

assertVersion(hallAfter.version, version, 'package.json')
assertVersion(arkhamPackageAfter.version, version, 'games/arkhamhorror/package.json')
assertVersion(arkhamManifestAfter.version, version, 'games/arkhamhorror/boardgame-mod.json')
assertVersion(lockAfter.version, version, 'package-lock.json 顶层')
assertVersion(lockAfter.packages?.['']?.version, version, 'package-lock.json 大厅')
assertVersion(lockAfter.packages?.['games/arkhamhorror']?.version, version, 'package-lock.json 诡镇奇谈')

writeFileSync(FILES.hallPackage, hallText)
writeFileSync(FILES.hallLock, lockText)
writeFileSync(FILES.arkhamPackage, arkhamPackageText)
writeFileSync(FILES.arkhamManifest, arkhamManifestText)

console.log(`版本已更新：${hall.version} -> ${version}`)
console.log(`  大厅：package.json / package-lock.json`)
console.log(`  诡镇奇谈：games/arkhamhorror/package.json / boardgame-mod.json`)
