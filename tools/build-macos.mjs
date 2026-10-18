import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { zipDirectory } from '../lib/zip.js'
import { shipsFile, stageGames } from './release/stage-games.mjs'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.dirname(toolsDir)
const args = new Set(process.argv.slice(2))
const option = name => process.argv.slice(2).find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const archOption = option('--arch') || 'all'
const skipZip = args.has('--skip-zip')
// 纯大厅版（--hall-only）：只内置 package.json 的 boardgame.liteGames，其他游戏从游戏商店安装；
// edition.json 让自动更新也跳过它们。游戏暂存与资源包拆分见 tools/release/stage-games.mjs。
const hallOnly = args.has('--hall-only')
const nodeVersion = option('--node-version') || process.versions.node
const supportedArchitectures = archOption === 'all' ? ['arm64', 'x64'] : [archOption]
const stamp = formatStamp(new Date())
const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const hallVersion = rootPackage.version
if (!/^\d+\.\d+\.\d+$/.test(hallVersion)) throw new Error('package.json 的 version 必须是 x.y.z。')
// 版本化布局（见 lib/install.js）：app-<大厅版本>/ + runtime-<Node 版本>/ + current.ini。
const appDirName = `app-${hallVersion}`
const runtimeDirName = `runtime-${nodeVersion}`

if (!supportedArchitectures.every(value => ['arm64', 'x64'].includes(value))) {
  throw new Error('--arch 只支持 arm64、x64 或 all。')
}
if (compareVersions(nodeVersion, '22.15.0') < 0) {
  throw new Error('macOS 发布包需要 Node.js 22.15.0 或更新版本。')
}

for (const arch of supportedArchitectures) await build(arch)

async function build(arch) {
  const packageName = `BoardgameHall-${hallOnly ? 'Lite-' : ''}macOS-${arch}-${stamp}`
  const releaseRoot = path.join(projectRoot, 'dist', packageName)
  const appRoot = path.join(releaseRoot, appDirName)
  const runtimeRoot = path.join(releaseRoot, runtimeDirName)
  const zipPath = releaseRoot + '.zip'
  try {
    fs.mkdirSync(appRoot, { recursive: true })
    fs.mkdirSync(runtimeRoot, { recursive: true })

    copyRuntimeFiles(appRoot)
    // macOS 只发程序包；资源包由 Windows 构建产出，两个平台通用。
    const staged = await stageGames({ appRoot, lite: hallOnly })
    fs.copyFileSync(path.join(projectRoot, 'server.js'), path.join(appRoot, 'server.js'))
    fs.copyFileSync(path.join(toolsDir, 'windows', 'portable.mjs'), path.join(appRoot, 'portable.mjs'))
    fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({
      name: 'dsh-boardgame-hall', version: hallVersion, private: true, type: 'module', boardgame: rootPackage.boardgame,
    }, null, 2))
    fs.writeFileSync(path.join(releaseRoot, 'current.ini'), `app=${appDirName}\nruntime=${runtimeDirName}\n`)
    if (hallOnly) fs.writeFileSync(path.join(releaseRoot, 'edition.json'), JSON.stringify({ edition: 'hall-only', games: staged.games.map(game => game.id) }, null, 2))

    await installNodeRuntime(runtimeRoot, arch)
    writeLauncher(releaseRoot)
    writeInstructions(releaseRoot, arch, staged)
    verifyRelease(releaseRoot)
    writeManifest(releaseRoot, arch)

    if (!skipZip) {
      zipDirectory(releaseRoot, zipPath, {
        prefix: packageName,
        executable: relative => relative === '桌游大厅.command' || relative === `${runtimeDirName}/node`,
      })
      console.log(`ZIP=${zipPath}`)
    }
    console.log(`RELEASE_DIR=${releaseRoot}`)
  } catch (error) {
    fs.rmSync(releaseRoot, { recursive: true, force: true })
    fs.rmSync(zipPath, { force: true })
    throw error
  }
}

function copyRuntimeFiles(appRoot) {
  for (const folder of ['lib', 'public']) {
    walk(path.join(projectRoot, folder), file => {
      const relative = path.relative(projectRoot, file).replaceAll('\\', '/')
      if (!shipsFile(relative)) return
      const destination = path.join(appRoot, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(file, destination)
    })
  }
}

async function installNodeRuntime(runtimeRoot, arch) {
  const archiveName = `node-v${nodeVersion}-darwin-${arch}.tar.gz`
  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-hall-macos-'))
  const archivePath = path.join(temporaryRoot, archiveName)
  try {
    console.log(`Downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok || !response.body) throw new Error(`下载 Node.js 失败：HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archivePath))
    const extractedRoot = path.join(temporaryRoot, `node-v${nodeVersion}-darwin-${arch}`)
    const archiveRoot = `node-v${nodeVersion}-darwin-${arch}`
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', temporaryRoot, `${archiveRoot}/bin/node`, `${archiveRoot}/LICENSE`], { stdio: 'inherit' })
    if (result.error) throw new Error('无法运行 tar 解压 Node.js：' + result.error.message)
    if (result.status !== 0) throw new Error('Node.js 运行时解压失败。')
    fs.copyFileSync(path.join(extractedRoot, 'bin', 'node'), path.join(runtimeRoot, 'node'))
    fs.chmodSync(path.join(runtimeRoot, 'node'), 0o755)
    fs.copyFileSync(path.join(extractedRoot, 'LICENSE'), path.join(runtimeRoot, 'LICENSE.txt'))
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function writeLauncher(releaseRoot) {
  const launcher = fs.readFileSync(path.join(toolsDir, 'macos', 'launcher.command'), 'utf8').replaceAll('\r\n', '\n')
  const destination = path.join(releaseRoot, '桌游大厅.command')
  fs.writeFileSync(destination, launcher)
  fs.chmodSync(destination, 0o755)
}

function writeInstructions(releaseRoot, arch, staged) {
  const architectureName = arch === 'arm64' ? 'Apple 芯片（M1/M2/M3/M4 及后续型号）' : 'Intel 芯片'
  const names = staged.games.map(game => game.name).join('、')
  const notes = hallOnly ? [
    `本版只内置${names}。其他游戏可在大厅的“游戏中心”中安装，下载到 user-data 文件夹。`,
    `自动更新：在“设置 → 大厅更新”中可一键更新大厅；更新时只下载变化的文件，并保持纯大厅版。
   重启后切换，启动失败会自动回滚到上一版本。存档与设置始终保留在 user-data。`,
  ] : [
    ...staged.notes,
    `自动更新：在“设置 → 大厅更新”中可一键更新大厅，在大厅的“游戏中心”中安装或更新游戏；新版本准备到旁边的 app-版本号 文件夹（只下载变化的文件），
   重启后切换，启动失败会自动回滚到上一版本。存档与设置始终保留在 user-data。`,
  ]
  const games = notes.map((note, index) => `${index + 6}. ${note}`).join('\n')
  const instructions = `桌游大厅 · macOS ${arch} 免安装版${hallOnly ? '（纯大厅）' : ''}

适用机型：${architectureName}

1. 完整解压文件夹，双击“桌游大厅.command”。无需安装 Node.js。
2. macOS 首次启动如有安全提示，请右键“桌游大厅.command”，选择“打开”，再确认打开。
3. 启动后自动打开浏览器；默认地址为 http://127.0.0.1:18787，端口占用时自动顺延。
4. 游戏期间保留终端窗口；结束时在终端按 Control+C。
5. 模型地址、密钥等请在大厅设置中重新填写。
${games}

发布包不包含已有存档、个人 AI 角色、模型密钥或日志。
新存档及设置保存在本文件夹的 user-data 中；请把完整文件夹放在有写入权限的位置。
不要单独移动“桌游大厅.command”。
`
  fs.writeFileSync(path.join(releaseRoot, '使用说明.txt'), instructions)
}

function verifyRelease(releaseRoot) {
  const files = listFiles(releaseRoot)
  const forbidden = files.filter(file => {
    const relative = path.relative(releaseRoot, file).replaceAll('\\', '/')
    return /(^|\/)(sessions|user-data)\//i.test(relative)
      || /(^|\/)(boardgame\.config\.json|ais\.json|decisions\.jsonl)$/i.test(relative)
      || /\.(log|tmp|bak)$/i.test(relative)
  })
  if (forbidden.length) throw new Error('发布包检查失败：包含个人数据文件。')
}

function writeManifest(releaseRoot, arch) {
  const manifest = {
    builtAt: new Date().toISOString(),
    nodeVersion: `v${nodeVersion}`,
    hallVersion,
    appDir: appDirName,
    runtimeDir: runtimeDirName,
    platform: `darwin-${arch}`,
    package: hallOnly ? 'hall-only' : 'logic',
    bundledGames: fs.readdirSync(path.join(releaseRoot, appDirName, 'games')),
    launcher: '桌游大厅.command',
    bundledSaves: false,
    bundledPersonalConfig: false,
    bundledAssetPacks: [],
    files: listFiles(releaseRoot).map(file => path.relative(releaseRoot, file).replaceAll('\\', '/')),
  }
  fs.writeFileSync(path.join(releaseRoot, 'build-manifest.json'), JSON.stringify(manifest, null, 2))
}

function walk(root, visit) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) walk(target, visit)
    else if (entry.isFile()) visit(target)
  }
}

function listFiles(root) {
  const result = []
  walk(root, file => result.push(file))
  return result.sort((a, b) => a.localeCompare(b))
}

function formatStamp(date) {
  const part = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference) return difference
  }
  return 0
}
