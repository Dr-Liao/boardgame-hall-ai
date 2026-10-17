// 免安装发布包的目录布局与启动器协议（协议版本 2）。
//
//   桌游大厅.exe / 桌游大厅.command   启动器
//   current.ini                         版本指针（key=value，每行一项）
//   app-<版本>/                         大厅程序（portable.mjs、server.js、lib、public、games）
//   runtime-<Node 版本>/                Node.js 运行时
//   user-data/                          存档、配置、下载的游戏，所有版本共用
//   edition.json                        可选；{"games":["gobang","ox"]} 表示精简版只内置这些游戏，
//                                       自动更新时跳过程序包里的其他内置游戏（可另从游戏商店安装）
//
// current.ini 字段：
//   app / runtime                   当前使用的目录
//   previousApp / previousRuntime   上一版本，供回滚
//   trial=1                         新版本尚未成功启动过；进程非正常退出时启动器会回滚到 previous*
//   failed                          回滚过的版本号（逗号分隔），更新器不再自动推荐
//
// 启动器通过环境变量 BOARDGAME_INSTALL_ROOT / BOARDGAME_LAUNCHER 告知安装根目录与协议版本；
// 进程以 RESTART_EXIT_CODE 退出表示「请按 current.ini 重新启动」。

import fs from 'node:fs'
import path from 'node:path'

export const RESTART_EXIT_CODE = 75
export const LAUNCHER_PROTOCOL = 2
const POINTER_KEYS = ['app', 'runtime', 'previousApp', 'previousRuntime', 'trial', 'failed']
const VERSION_DIR = /^(app|runtime)-[0-9A-Za-z][0-9A-Za-z._-]*$/

export function installContext(env = process.env) {
  if (!env.BOARDGAME_INSTALL_ROOT) return null
  return { root: path.resolve(env.BOARDGAME_INSTALL_ROOT), launcher: Number(env.BOARDGAME_LAUNCHER) || 0 }
}

export function isVersionDir(name, kind) {
  return typeof name === 'string' && VERSION_DIR.test(name) && (!kind || name.startsWith(kind + '-'))
}

/** 读取 edition.json，返回程序包相对路径的过滤函数；没有该文件（完整版）时返回 null。 */
export function bundledGamesFilter(root) {
  let games
  try { games = JSON.parse(fs.readFileSync(path.join(root, 'edition.json'), 'utf8').replace(/^\uFEFF/, '')).games } catch { return null }
  if (!Array.isArray(games) || !games.every(id => typeof id === 'string')) return null
  return relative => !relative.startsWith('games/') || games.includes(relative.split('/')[1])
}

export function readPointer(root) {
  let text
  try { text = fs.readFileSync(path.join(root, 'current.ini'), 'utf8') } catch { return null }
  const pointer = {}
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (POINTER_KEYS.includes(key)) pointer[key] = line.slice(index + 1).trim()
  }
  return pointer.app && pointer.runtime ? pointer : null
}

export function writePointer(root, pointer) {
  const lines = POINTER_KEYS.filter(key => pointer[key]).map(key => `${key}=${pointer[key]}`)
  const file = path.join(root, 'current.ini')
  const temporary = file + '.tmp'
  fs.writeFileSync(temporary, lines.join('\n') + '\n')
  fs.renameSync(temporary, file)
}

export function failedVersions(pointer) {
  return String(pointer?.failed || '').split(',').map(value => value.trim()).filter(Boolean)
}

/** 新版本已成功监听端口：去掉 trial 标记，此后异常退出不再触发回滚。 */
export function markHealthy(root) {
  const pointer = readPointer(root)
  if (!pointer?.trial) return false
  delete pointer.trial
  const version = pointer.app.replace(/^app-/, '')
  pointer.failed = failedVersions(pointer).filter(value => value !== version).join(',')
  writePointer(root, pointer)
  return true
}

/** 删除当前与上一版本之外的 app-* / runtime-* 目录，以及中断留下的 *.partial 目录与 *.partial.zip 下载。 */
export function cleanupInstall(root) {
  const pointer = readPointer(root)
  if (!pointer) return []
  const keep = new Set([pointer.app, pointer.runtime, pointer.previousApp, pointer.previousRuntime].filter(Boolean))
  const removed = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.partial.zip') && isVersionDir(entry.name.slice(0, -'.partial.zip'.length))) {
      try { fs.rmSync(path.join(root, entry.name)); removed.push(entry.name) } catch { /* 留到下次 */ }
      continue
    }
    if (!entry.isDirectory()) continue
    const partial = entry.name.endsWith('.partial') && isVersionDir(entry.name.slice(0, -'.partial'.length))
    if (!partial && (!isVersionDir(entry.name) || keep.has(entry.name))) continue
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch { /* 文件仍被占用时留到下次启动再清理 */ }
  }
  return removed
}

/**
 * 卡图资源包按旧说明解压会生成 <root>/app/；把其中的文件并入当前版本目录后删除，
 * 已存在的文件保持不变。
 */
export function mergeLooseAppFolder(root) {
  const pointer = readPointer(root)
  const loose = path.join(root, 'app')
  if (!pointer || pointer.app === 'app' || pointer.previousApp === 'app' || !fs.existsSync(loose)) return 0
  const moved = transferMissing(loose, path.join(root, pointer.app), 'move')
  fs.rmSync(loose, { recursive: true, force: true })
  return moved
}

/**
 * 把 fromDir 中在 toDir 缺失的文件补过去。mode='link' 优先硬链接（同盘瞬间完成且不占额外空间），
 * 失败时复制；mode='move' 直接移动。返回补齐的文件数。
 */
export function transferMissing(fromDir, toDir, mode = 'link') {
  if (!fs.existsSync(fromDir) || !fs.statSync(fromDir).isDirectory()) return 0
  let count = 0
  const walk = (source, target) => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name)
      const to = path.join(target, entry.name)
      if (entry.isDirectory()) { walk(from, to); continue }
      if (!entry.isFile() || fs.existsSync(to)) continue
      fs.mkdirSync(target, { recursive: true })
      if (mode === 'move') {
        try { fs.renameSync(from, to) } catch { fs.copyFileSync(from, to) }
      } else {
        try { fs.linkSync(from, to) } catch { fs.copyFileSync(from, to) }
      }
      count++
    }
  }
  walk(fromDir, toDir)
  return count
}

/** Windows 上杀毒软件或索引服务会短暂占用刚写入的文件，导致目录改名报 EPERM/EBUSY，稍后重试即可。 */
export async function renameWithRetry(from, to, attempts = 20) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (i >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 50 * i)))
    }
  }
}

/** 读取 Mod 目录的 boardgame-mod.json；不存在或损坏时返回 null。 */
export function readModManifest(modDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(modDir, 'boardgame-mod.json'), 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/** 按 Mod 清单的 preserve 列表，把旧目录里运行时生成的缓存（如卡图）补到新目录。 */
export function preserveModFiles(oldModDir, newModDir) {
  const manifest = readModManifest(newModDir) || readModManifest(oldModDir)
  let count = 0
  for (const item of Array.isArray(manifest?.preserve) ? manifest.preserve : []) {
    if (typeof item !== 'string' || !item || item.split(/[\\/]/).includes('..') || path.isAbsolute(item)) continue
    const from = path.join(oldModDir, item)
    const to = path.join(newModDir, item)
    if (!fs.existsSync(from)) continue
    if (fs.statSync(from).isDirectory()) count += transferMissing(from, to)
    else if (!fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      try { fs.linkSync(from, to) } catch { fs.copyFileSync(from, to) }
      count++
    }
  }
  return count
}
