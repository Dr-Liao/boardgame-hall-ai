import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { deflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.dirname(toolsDir)
const args = new Set(process.argv.slice(2))
const option = name => process.argv.slice(2).find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const archOption = option('--arch') || 'all'
const skipZip = args.has('--skip-zip')
const nodeVersion = option('--node-version') || process.versions.node
const supportedArchitectures = archOption === 'all' ? ['arm64', 'x64'] : [archOption]
const stamp = formatStamp(new Date())
const cardImagePattern = /^games\/arkhamhorror\/web\/img\/(zh\/)?cards\//
const cardInventoryPattern = /^(zh\/)?cards\//
let crcTable

if (!supportedArchitectures.every(value => ['arm64', 'x64'].includes(value))) {
  throw new Error('--arch 只支持 arm64、x64 或 all。')
}
if (compareVersions(nodeVersion, '22.15.0') < 0) {
  throw new Error('macOS 发布包需要 Node.js 22.15.0 或更新版本。')
}

for (const arch of supportedArchitectures) await build(arch)

async function build(arch) {
  const packageName = `BoardgameHall-macOS-${arch}-${stamp}`
  const releaseRoot = path.join(projectRoot, 'dist', packageName)
  const appRoot = path.join(releaseRoot, 'app')
  const runtimeRoot = path.join(releaseRoot, 'runtime')
  const zipPath = releaseRoot + '.zip'
  try {
    fs.mkdirSync(appRoot, { recursive: true })
    fs.mkdirSync(runtimeRoot, { recursive: true })

    copyRuntimeFiles(appRoot)
    writeLogicInventory(appRoot)
    fs.copyFileSync(path.join(projectRoot, 'server.js'), path.join(appRoot, 'server.js'))
    fs.copyFileSync(path.join(toolsDir, 'windows', 'portable.mjs'), path.join(appRoot, 'portable.mjs'))
    fs.writeFileSync(path.join(appRoot, 'package.json'), '{"name":"dsh-boardgame-hall","version":"1.0.0","private":true,"type":"module"}')

    await installNodeRuntime(runtimeRoot, arch)
    writeLauncher(releaseRoot)
    writeInstructions(releaseRoot, arch)
    verifyRelease(releaseRoot, appRoot)
    writeManifest(releaseRoot, arch)

    if (!skipZip) {
      createUnixZip(releaseRoot, zipPath, packageName)
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
  for (const folder of ['lib', 'public', 'games']) {
    const sourceRoot = path.join(projectRoot, folder)
    walk(sourceRoot, file => {
      const relative = path.relative(projectRoot, file).replaceAll('\\', '/')
      if (/\/(tests|test-results|tools|docs|Develop|develop|sessions|user-data|node_modules)\//.test('/' + relative)) return
      if (/\/audit\//.test('/' + relative)) return
      if (/(^|\/)\.git(\/|$)|(^|\/)\.git(ignore|modules|attributes)$/.test(relative)) return
      if (/(^|\/)(boardgame\.config\.json|ais\.json|decisions\.jsonl)$|\.(log|tmp|bak|md)$/i.test(relative)) return
      if (cardImagePattern.test(relative)) return
      const destination = path.join(appRoot, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(file, destination)
    })
  }
}

function writeLogicInventory(appRoot) {
  const imageRoot = path.join(projectRoot, 'games', 'arkhamhorror', 'web', 'img')
  const sourcePath = path.join(projectRoot, 'games', 'arkhamhorror', 'audit', 'local-images.json')
  if (!fs.existsSync(sourcePath)) return
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
  const files = (source.files || []).filter(relative =>
    !cardInventoryPattern.test(relative) && fs.existsSync(path.join(imageRoot, relative)))
  let bytes = 0
  let zh = 0
  const lines = files.map(relative => {
    const length = fs.statSync(path.join(imageRoot, relative)).size
    bytes += length
    if (relative.startsWith('zh/')) zh++
    return `${relative}:${length}`
  })
  const inventory = {
    schemaVersion: 1,
    host: source.host,
    scope: source.scope,
    languages: source.languages || [],
    package: 'logic',
    total: files.length,
    bytes,
    byLanguage: { en: files.length - zh, zh },
    fingerprint: createHash('sha256').update(lines.join('\n')).digest('hex'),
    note: source.note,
    files,
  }
  const destination = path.join(appRoot, 'games', 'arkhamhorror', 'audit', 'local-images.json')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, JSON.stringify(inventory, null, 2))
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
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', temporaryRoot], { stdio: 'inherit' })
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
  const launcher = `#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$ROOT/runtime/node"
APP="$ROOT/app"

if [ ! -x "$NODE" ]; then
  echo "无法启动：发布包不完整，缺少 macOS Node.js 运行时。"
  read -r -p "按回车关闭..."
  exit 1
fi

export DSH_HOME="$ROOT/user-data"
cd "$APP" || exit 1
"$NODE" portable.mjs
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo
  read -r -p "启动失败，请查看上方信息。按回车关闭..."
fi
exit "$STATUS"
`
  const destination = path.join(releaseRoot, '桌游大厅.command')
  fs.writeFileSync(destination, launcher)
  fs.chmodSync(destination, 0o755)
}

function writeInstructions(releaseRoot, arch) {
  const architectureName = arch === 'arm64' ? 'Apple 芯片（M1/M2/M3/M4 及后续型号）' : 'Intel 芯片'
  const instructions = `桌游大厅 · macOS ${arch} 免安装版

适用机型：${architectureName}

1. 完整解压文件夹，双击“桌游大厅.command”。无需安装 Node.js。
2. macOS 首次启动如有安全提示，请右键“桌游大厅.command”，选择“打开”，再确认打开。
3. 启动后自动打开浏览器；默认地址为 http://127.0.0.1:18787，端口占用时自动顺延。
4. 游戏期间保留终端窗口；结束时在终端按 Control+C。
5. 模型地址、密钥等请在大厅设置中重新填写。
6. 本包不含诡镇奇谈卡牌图片；联网时自动加载，离线时以文字显示。
   如需离线卡图，请将 BoardgameHall-ArkhamCards 资源包解压到本文件夹并合并 app 文件夹。

发布包不包含已有存档、个人 AI 角色、模型密钥或日志。
新存档及设置保存在本文件夹的 user-data 中；请把完整文件夹放在有写入权限的位置。
不要单独移动“桌游大厅.command”。
`
  fs.writeFileSync(path.join(releaseRoot, '使用说明.txt'), instructions)
}

function verifyRelease(releaseRoot, appRoot) {
  const files = listFiles(releaseRoot)
  const forbidden = files.filter(file => {
    const relative = path.relative(releaseRoot, file).replaceAll('\\', '/')
    return /(^|\/)(sessions|user-data)\//i.test(relative)
      || /(^|\/)(boardgame\.config\.json|ais\.json|decisions\.jsonl)$/i.test(relative)
      || /\.(log|tmp|bak)$/i.test(relative)
  })
  if (forbidden.length) throw new Error('发布包检查失败：包含个人数据文件。')
  const leakedCards = files.filter(file => cardImagePattern.test(path.relative(appRoot, file).replaceAll('\\', '/')))
  if (leakedCards.length) throw new Error('逻辑包检查失败：包含诡镇奇谈卡牌图片。')
}

function writeManifest(releaseRoot, arch) {
  const manifest = {
    builtAt: new Date().toISOString(),
    nodeVersion: `v${nodeVersion}`,
    platform: `darwin-${arch}`,
    package: 'logic',
    launcher: '桌游大厅.command',
    bundledSaves: false,
    bundledPersonalConfig: false,
    bundledArkhamCardImages: false,
    files: listFiles(releaseRoot).map(file => path.relative(releaseRoot, file).replaceAll('\\', '/')),
  }
  fs.writeFileSync(path.join(releaseRoot, 'build-manifest.json'), JSON.stringify(manifest, null, 2))
}

function createUnixZip(sourceRoot, destination, packageName) {
  const output = fs.openSync(destination, 'w')
  const central = []
  let offset = 0
  try {
    for (const file of listFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, file).replaceAll('\\', '/')
      const name = Buffer.from(`${packageName}/${relative}`)
      const source = fs.readFileSync(file)
      const stored = /\.(avif|gif|jpe?g|mp3|mp4|ogg|png|webp|woff2?|zip)$/i.test(relative)
      const compressed = stored ? source : deflateRawSync(source, { level: 1 })
      const method = stored ? 0 : 8
      const crc = crc32(source)
      const stat = fs.statSync(file)
      const { date, time } = dosDateTime(stat.mtime)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(source.length, 22)
      local.writeUInt16LE(name.length, 26)
      fs.writeSync(output, local)
      fs.writeSync(output, name)
      fs.writeSync(output, compressed)

      const executable = relative === '桌游大厅.command' || relative === 'runtime/node'
      const entry = Buffer.alloc(46)
      entry.writeUInt32LE(0x02014b50, 0)
      entry.writeUInt16LE(0x0314, 4)
      entry.writeUInt16LE(20, 6)
      entry.writeUInt16LE(0x0800, 8)
      entry.writeUInt16LE(method, 10)
      entry.writeUInt16LE(time, 12)
      entry.writeUInt16LE(date, 14)
      entry.writeUInt32LE(crc, 16)
      entry.writeUInt32LE(compressed.length, 20)
      entry.writeUInt32LE(source.length, 24)
      entry.writeUInt16LE(name.length, 28)
      entry.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38)
      entry.writeUInt32LE(offset, 42)
      central.push(entry, name)
      offset += local.length + name.length + compressed.length
    }
    const centralOffset = offset
    for (const part of central) {
      fs.writeSync(output, part)
      offset += part.length
    }
    const entries = central.length / 2
    if (entries > 0xffff || offset > 0xffffffff) throw new Error('发布包过大，当前 ZIP 写入器不支持 ZIP64。')
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries, 8)
    end.writeUInt16LE(entries, 10)
    end.writeUInt32LE(offset - centralOffset, 12)
    end.writeUInt32LE(centralOffset, 16)
    fs.writeSync(output, end)
  } finally {
    fs.closeSync(output)
  }
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

function dosDateTime(value) {
  const year = Math.max(1980, value.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
  }
}

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let item = index
      for (let bit = 0; bit < 8; bit++) item = (item & 1) ? 0xedb88320 ^ (item >>> 1) : item >>> 1
      crcTable[index] = item >>> 0
    }
  }
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
