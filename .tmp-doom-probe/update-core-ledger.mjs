// 更新 core 验收证据账本：重算被改测试文件的 sha256，并回写 src/cards/core-acceptance.js 的清单哈希。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = 'G:/boardgame-hall-ai'
const game = path.join(root, 'games/arkhamhorror')
const ledgerPath = path.join(game, 'audit/core-acceptance.json')
const raw = fs.readFileSync(ledgerPath)
const ledger = JSON.parse(raw.toString('utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
let changed = 0
for (const item of ledger.testFiles) {
  const file = path.join(root, item.file)
  const next = sha(fs.readFileSync(file))
  if (next !== item.sha256) {
    console.log('update', item.file, item.sha256.slice(0, 12), '->', next.slice(0, 12))
    item.sha256 = next
    changed++
  }
}
const body = JSON.stringify(ledger, null, 2) + '\n'
fs.writeFileSync(ledgerPath, body, 'utf8')
const ledgerSha = sha(Buffer.from(body, 'utf8'))
const constantsPath = path.join(game, 'src/cards/core-acceptance.js')
const constants = fs.readFileSync(constantsPath, 'utf8')
const updated = constants.replace(/CORE_ACCEPTANCE_SHA256 = '[0-9a-f]{64}'/, `CORE_ACCEPTANCE_SHA256 = '${ledgerSha}'`)
if (updated === constants) throw new Error('未找到 CORE_ACCEPTANCE_SHA256 常量')
fs.writeFileSync(constantsPath, updated, 'utf8')
console.log(`updated testFiles=${changed} ledgerSha=${ledgerSha.slice(0, 12)}`)
