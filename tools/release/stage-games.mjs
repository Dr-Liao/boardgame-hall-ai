// 免安装发布包的游戏暂存：build-windows.ps1 与 build-macos.mjs 共用，大厅构建不认识任何具体游戏。
//
//   纯大厅版内置哪些游戏：根 package.json 的 boardgame.liteGames
//   每个游戏在自己的 boardgame-mod.json 里声明（均可选）：
//     assetPacks     [{ id, title, paths: string[], readme?: string[] }]
//                    paths 是相对游戏目录的前缀（如 "web/img/cards/"）；这些文件不进程序包，
//                    只在构建资源包时复制到 BoardgameHall-<Id 转大驼峰>-<时间戳>/app/games/<游戏>/
//     portableNotes  string[]  追加到免安装包「使用说明.txt」的条目
//     prepack        string    与游戏商店打包同一脚本：程序包调用 `node <prepack> <暂存游戏目录>`，
//                              资源包调用 `node <prepack> <资源包内游戏目录> --asset-pack=<id>`
//
// CLI（供 build-windows.ps1 调用；结果写入 --report，避免控制台编码问题）：
//   node tools/release/stage-games.mjs --report=<json> [--app=<app 目录>] [--assets=<资源包父目录>] [--stamp=<时间戳>] [--lite]

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readModManifest } from '../../lib/install.js'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

/** 发布包只带运行时文件：测试、工具、文档、审计数据、个人数据与日志一律不带。 */
export function shipsFile(relative) {
  if (/\/(tests|test-results|tools|docs|Develop|develop|sessions|user-data|node_modules)\//.test('/' + relative)) return false
  if (/\/audit\//.test('/' + relative)) return false
  if (/(^|\/)\.git(\/|$)|(^|\/)\.git(ignore|modules|attributes)$/.test(relative)) return false
  if (/(^|\/)(boardgame\.config\.json|ais\.json|decisions\.jsonl)$|\.(log|tmp|bak|md)$/i.test(relative)) return false
  return true
}

export function liteGames(root = projectRoot) {
  const games = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).boardgame?.liteGames
  if (!Array.isArray(games) || !games.length || !games.every(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id))) {
    throw new Error('package.json 的 boardgame.liteGames 必须是游戏 id 数组')
  }
  return games
}

export const packDirName = (pack, stamp) =>
  'BoardgameHall-' + pack.id.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('') + '-' + stamp

function validatePacks(id, manifest) {
  const packs = manifest?.assetPacks ?? []
  if (!Array.isArray(packs)) throw new Error(`${id}: assetPacks 必须是数组`)
  for (const pack of packs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(pack?.id || '')) throw new Error(`${id}: 资源包 id 无效`)
    if (typeof pack.title !== 'string' || !pack.title) throw new Error(`${id}: 资源包 ${pack.id} 缺少 title`)
    if (!Array.isArray(pack.paths) || !pack.paths.length
      || !pack.paths.every(item => typeof item === 'string' && item && !item.split('/').includes('..') && !path.isAbsolute(item))) {
      throw new Error(`${id}: 资源包 ${pack.id} 的 paths 无效`)
    }
  }
  return packs
}

function walk(root, visit) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) walk(target, visit)
    else if (entry.isFile()) visit(target)
  }
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

function runPrepack(gameDir, manifest, target, extra = []) {
  if (!manifest?.prepack) return
  const script = path.resolve(gameDir, manifest.prepack)
  if (!script.startsWith(gameDir + path.sep)) throw new Error('prepack 必须位于游戏目录内')
  // 子进程的输出转到 stderr，保持本脚本 stdout 干净。
  const result = spawnSync(process.execPath, [script, target, ...extra], { cwd: gameDir, stdio: ['ignore', 2, 2] })
  if (result.status !== 0) throw new Error(`prepack 失败：${manifest.prepack} ${extra.join(' ')}`)
}

function writePackReadme(pack, packRoot) {
  const lines = [
    '桌游大厅 · ' + pack.title,
    '',
    '1. 将本压缩包解压到桌游大厅文件夹（与启动程序同级），合并 app 文件夹。',
    '2. 重启桌游大厅；大厅启动时会把 app 文件夹中的文件自动并入当前版本。',
    ...(pack.readme || []).map((line, index) => `${index + 3}. ${line}`),
    `${(pack.readme || []).length + 3}. 资源包与程序包版本相互独立，更新程序包时无需重新下载本资源包。`,
    '',
  ]
  fs.writeFileSync(path.join(packRoot, pack.title + '说明.txt'), '\uFEFF' + lines.join('\r\n'))
}

/**
 * 把 games/ 下要发布的游戏复制到 appRoot/games/，资源包文件分拣到各自的资源包目录。
 * appRoot 为空时只构建资源包；assetsDir 为空时不构建资源包（资源文件也不进程序包）。
 */
export async function stageGames({ root = projectRoot, appRoot = null, assetsDir = null, stamp = 'local', lite = false } = {}) {
  const gamesRoot = path.join(root, 'games')
  const wanted = lite ? liteGames(root) : null
  const games = [], notes = [], assetPacks = []
  for (const entry of fs.readdirSync(gamesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const gameDir = path.join(gamesRoot, entry.name)
    if (!entry.isDirectory() || entry.name.startsWith('.') || !fs.existsSync(path.join(gameDir, 'index.js'))) continue
    if (wanted && !wanted.includes(entry.name)) continue
    const manifest = readModManifest(gameDir)
    const packs = validatePacks(entry.name, manifest)
    const packOf = relative => packs.find(pack => pack.paths.some(prefix => relative.startsWith(prefix)))
    const staged = packs.map(pack => ({ pack, root: assetsDir ? path.join(assetsDir, packDirName(pack, stamp)) : null, files: [] }))
    walk(gameDir, file => {
      const relative = path.relative(gameDir, file).replaceAll('\\', '/')
      if (!shipsFile('games/' + entry.name + '/' + relative)) return
      const pack = packOf(relative)
      if (pack) {
        const target = staged.find(item => item.pack === pack)
        if (!target.root) return
        copy(file, path.join(target.root, 'app', 'games', entry.name, relative))
        target.files.push(relative)
      } else if (appRoot) {
        copy(file, path.join(appRoot, 'games', entry.name, relative))
      }
    })
    if (appRoot) runPrepack(gameDir, manifest, path.join(appRoot, 'games', entry.name))
    for (const item of staged.filter(item => item.files.length)) {
      runPrepack(gameDir, manifest, path.join(item.root, 'app', 'games', entry.name), ['--asset-pack=' + item.pack.id])
      writePackReadme(item.pack, item.root)
      fs.writeFileSync(path.join(item.root, item.pack.id + '-manifest.json'), JSON.stringify({
        builtAt: new Date().toISOString(), package: item.pack.id, game: entry.name, files: item.files.length,
      }, null, 2))
      assetPacks.push({ id: item.pack.id, title: item.pack.title, game: entry.name, root: item.root, files: item.files.length })
    }
    const name = manifest?.name || (await import(pathToFileURL(path.join(gameDir, 'index.js')).href)).default?.name || entry.name
    games.push({ id: entry.name, name, assetPacks: packs.map(pack => pack.title) })
    if (Array.isArray(manifest?.portableNotes)) notes.push(...manifest.portableNotes.filter(note => typeof note === 'string' && note))
  }
  if (wanted) {
    const missing = wanted.filter(id => !games.some(game => game.id === id))
    if (missing.length) throw new Error('纯大厅版需要的游戏不存在：' + missing.join(', '))
  }
  if (appRoot) verifyNoPackFiles(appRoot, root)
  return { games, notes, assetPacks }
}

/** 程序包里不能出现任何资源包文件。 */
export function verifyNoPackFiles(appRoot, root = projectRoot) {
  const gamesRoot = path.join(appRoot, 'games')
  if (!fs.existsSync(gamesRoot)) return
  for (const id of fs.readdirSync(gamesRoot)) {
    const packs = validatePacks(id, readModManifest(path.join(root, 'games', id)))
    if (!packs.length) continue
    walk(path.join(gamesRoot, id), file => {
      const relative = path.relative(path.join(gamesRoot, id), file).replaceAll('\\', '/')
      const pack = packs.find(item => item.paths.some(prefix => relative.startsWith(prefix)))
      if (pack) throw new Error(`程序包检查失败：包含资源包 ${pack.id} 的文件 games/${id}/${relative}`)
    })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.slice(2).find(value => value.startsWith(name + '='))?.slice(name.length + 1)
  const report = option('--report')
  if (!report) throw new Error('缺少 --report=<json>')
  const result = await stageGames({
    appRoot: option('--app') ? path.resolve(option('--app')) : null,
    assetsDir: option('--assets') ? path.resolve(option('--assets')) : null,
    stamp: option('--stamp') || 'local',
    lite: process.argv.includes('--lite'),
  })
  fs.writeFileSync(report, JSON.stringify(result, null, 2))
}
