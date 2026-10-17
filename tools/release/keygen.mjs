// 生成更新签名密钥对（ed25519）。
//
//   node tools/release/keygen.mjs [--out=<私钥文件>]
//
// 公钥追加到 lib/update-keys.json（随大厅发布，用于校验清单）；
// 私钥写入 .release-keys/（已被 .gitignore 忽略），请把内容保存为 GitHub 仓库 Secret：
// BOARDGAME_UPDATE_PRIVATE_KEY（大厅仓库与每个游戏仓库都要配置），然后从本机删除或妥善备份。

import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { keyIdOf } from '../../lib/signing.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const option = name => process.argv.slice(2).find(value => value.startsWith(name + '='))?.slice(name.length + 1)

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const id = keyIdOf(publicKey)
const keysFile = path.join(projectRoot, 'lib', 'update-keys.json')
const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'))
keys.keys = (keys.keys || []).concat({ id, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), createdAt: new Date().toISOString() })
fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2) + '\n')

const out = path.resolve(option('--out') || path.join(projectRoot, '.release-keys', `boardgame-update-${id}.pem`))
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })

console.log('公钥 ' + id + ' 已写入 lib/update-keys.json（请提交）。')
console.log('私钥已写入 ' + out)
console.log('请把私钥文件的完整内容保存为 GitHub Secret「BOARDGAME_UPDATE_PRIVATE_KEY」：')
console.log('  gh secret set BOARDGAME_UPDATE_PRIVATE_KEY --repo Dr-Liao/boardgame-hall-ai < "' + out + '"')
console.log('  gh secret set BOARDGAME_UPDATE_PRIVATE_KEY --repo Dr-Liao/boardgame-arkhamhorror < "' + out + '"')
