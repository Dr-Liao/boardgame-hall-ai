// 生成并签名大厅更新清单 update-manifest.json。
//
//   node tools/release/make-manifest.mjs <包目录> [--tag=v1.2.0] [--notes-file=<文件>] [--key-file=<私钥>]
//
// 包目录里须有 pack-update.mjs 生成的 BoardgameHall-app-<版本>.zip，可选若干运行时包；
// 同目录有 BoardgameHall-app-<版本>.files.json 时一并签入，客户端据此增量更新。
// 根 package.json 的 boardgame.liteGames 也会签入清单：纯大厅版更新时据此决定下载哪些内置游戏，
// 并把新清单写回本地 edition.json（见 lib/updater.js）。
// 私钥取 --key-file 或环境变量 BOARDGAME_UPDATE_PRIVATE_KEY；签名公钥必须已登记在 lib/update-keys.json，
// 否则已发布的大厅会拒绝这份清单，脚本直接报错。

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { signEnvelope, verifyEnvelope, loadTrustedKeys } from '../../lib/signing.js'
import { validateHallManifest } from '../../lib/updater.js'
import { LAUNCHER_PROTOCOL, validLiteGames } from '../../lib/install.js'
import { indexFileName, parseIndex } from '../../lib/delta.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const argv = process.argv.slice(2)
const option = name => argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const dir = path.resolve(argv.find(value => !value.startsWith('--')) || 'dist/release')
const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const version = rootPackage.version
const liteGames = validLiteGames(rootPackage.boardgame?.liteGames)
if (!liteGames) throw new Error('根 package.json 的 boardgame.liteGames 必须是游戏 id 数组')
const tag = option('--tag') || 'v' + version
if (tag.replace(/^v/, '') !== version) throw new Error(`tag ${tag} 与 package.json 版本 ${version} 不一致`)

const privateKey = option('--key-file') ? fs.readFileSync(option('--key-file'), 'utf8') : process.env.BOARDGAME_UPDATE_PRIVATE_KEY
if (!privateKey) throw new Error('缺少签名私钥：设置 BOARDGAME_UPDATE_PRIVATE_KEY 或传 --key-file')

const asset = file => {
  const data = fs.readFileSync(path.join(dir, file))
  return { file, sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
}
const files = fs.readdirSync(dir)
const appFile = `BoardgameHall-app-${version}.zip`
if (!files.includes(appFile)) throw new Error('缺少程序包 ' + appFile)
const runtimes = {}
for (const file of files) {
  const match = /^BoardgameHall-runtime-([a-z0-9]+-[a-z0-9]+)-(\d+\.\d+\.\d+)\.zip$/.exec(file)
  if (match) runtimes[match[1]] = { ...asset(file), version: match[2], dir: 'runtime-' + match[2] }
}
const app = { ...asset(appFile), dir: 'app-' + version }
const indexFile = indexFileName(appFile)
if (files.includes(indexFile)) {
  app.index = asset(indexFile)
  parseIndex(fs.readFileSync(path.join(dir, indexFile)), { indexAsset: app.index, asset: app, prefix: app.dir })
} else {
  console.warn('未找到 ' + indexFile + '，本次发布只能整包更新')
}

const payload = validateHallManifest({
  schema: 1,
  kind: 'hall',
  version,
  tag,
  publishedAt: new Date().toISOString(),
  notes: option('--notes-file') ? fs.readFileSync(option('--notes-file'), 'utf8').trim() : '',
  minLauncher: LAUNCHER_PROTOCOL,
  liteGames,
  app,
  runtimes,
})
const text = signEnvelope(payload, privateKey)
verifyEnvelope(text, loadTrustedKeys(option('--keys-file') ? path.resolve(option('--keys-file')) : undefined))
fs.writeFileSync(path.join(dir, 'update-manifest.json'), text)
console.log('MANIFEST=' + path.join(dir, 'update-manifest.json'))
console.log('平台运行时：' + (Object.keys(runtimes).join('、') || '（无）'))
