// 打包并签名一个游戏 Mod，供游戏商店下载。
//
//   node tools/release/pack-mod.mjs <Mod 目录> [--out=dist] [--tag=v1.2.0] [--notes-file=<文件>] [--key-file=<私钥>]
//
// Mod 目录根部的 boardgame-mod.json：
//   id, name, version, hallApi     必填；version 须与 tag 一致
//   exclude   string[]             不打包的路径前缀（如 "tests/"）或扩展名（如 "*.md"）；.git、.github、node_modules 总是排除
//   preserve  string[]             运行时生成、更新时要从旧版本带过来的路径（如卡图缓存 "web/img/"）
//   prepack   string               可选脚本：node <脚本> <暂存目录>，用于在打包前改写暂存内容
// 输出：<id>-<版本>.zip（归档根部即 Mod 根目录）、增量更新用的文件索引 <id>-<版本>.files.json
// 与签名清单 boardgame-mod.release.json。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { zipDirectory, listFiles } from '../../lib/zip.js'
import { signEnvelope, verifyEnvelope, loadTrustedKeys } from '../../lib/signing.js'
import { validateModRelease, MOD_RELEASE_FILE } from '../../lib/store.js'
import { buildIndex, indexFileName } from '../../lib/delta.js'
import { modExcludeMatcher } from '../../lib/install.js'

const argv = process.argv.slice(2)
const option = name => argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const modDir = path.resolve(argv.find(value => !value.startsWith('--')) || '.')
const out = path.resolve(option('--out') || 'dist')
const manifest = JSON.parse(fs.readFileSync(path.join(modDir, 'boardgame-mod.json'), 'utf8'))
const { id, name, version, hallApi } = manifest
const tag = option('--tag') || 'v' + version
if (tag.replace(/^v/, '') !== version) throw new Error(`tag ${tag} 与 boardgame-mod.json 版本 ${version} 不一致`)
const privateKey = option('--key-file') ? fs.readFileSync(option('--key-file'), 'utf8') : process.env.BOARDGAME_UPDATE_PRIVATE_KEY
if (!privateKey) throw new Error('缺少签名私钥：设置 BOARDGAME_UPDATE_PRIVATE_KEY 或传 --key-file')

const excluded = modExcludeMatcher(['.git/', '.github/', 'node_modules/', '.gitignore', '.gitattributes', '.gitmodules']
  .concat(Array.isArray(manifest.exclude) ? manifest.exclude : []))

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-mod-'))
try {
  let count = 0
  for (const file of listFiles(modDir)) {
    const relative = path.relative(modDir, file).replaceAll('\\', '/')
    if (excluded(relative)) continue
    const target = path.join(staging, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
    count++
  }
  if (manifest.prepack) {
    const script = path.resolve(modDir, manifest.prepack)
    if (!script.startsWith(modDir + path.sep)) throw new Error('prepack 必须位于 Mod 目录内')
    const result = spawnSync(process.execPath, [script, staging], { cwd: modDir, stdio: 'inherit' })
    if (result.status !== 0) throw new Error('prepack 脚本失败')
  }
  if (!fs.existsSync(path.join(staging, 'index.js'))) throw new Error('打包结果缺少 index.js')

  const file = `${id}-${version}.zip`
  const zipPath = path.join(out, file)
  zipDirectory(staging, zipPath)
  const data = fs.readFileSync(zipPath)
  const indexData = Buffer.from(JSON.stringify(await buildIndex(zipPath)))
  const indexFile = indexFileName(file)
  fs.writeFileSync(path.join(out, indexFile), indexData)
  const digest = buffer => createHash('sha256').update(buffer).digest('hex')
  const payload = validateModRelease({
    schema: 1, kind: 'mod', id, name, version, hallApi, tag,
    file, sha256: digest(data), size: data.length,
    index: { file: indexFile, sha256: digest(indexData), size: indexData.length },
    notes: option('--notes-file') ? fs.readFileSync(option('--notes-file'), 'utf8').trim() : '',
    publishedAt: new Date().toISOString(),
  }, id)
  const text = signEnvelope(payload, privateKey)
  const keysFile = option('--keys-file')
  verifyEnvelope(text, loadTrustedKeys(keysFile ? path.resolve(keysFile) : undefined))
  fs.writeFileSync(path.join(out, MOD_RELEASE_FILE), text)
  console.log(`PACKAGE=${zipPath}（${count} 个文件，${(data.length / 1048576).toFixed(1)} MB）`)
  console.log('INDEX=' + path.join(out, indexFile))
  console.log('MANIFEST=' + path.join(out, MOD_RELEASE_FILE))
} finally {
  fs.rmSync(staging, { recursive: true, force: true })
}
