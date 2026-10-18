// 在大厅根目录运行某个游戏自己的 npm 脚本，大厅 package.json 不再为每个游戏单独登记命令。
//
//   npm run test:mod -- <游戏 id> [脚本]
//     脚本省略时运行该游戏的 test；写 fast 时优先找 test:fast，找不到再按原名找。
//   npm run test:mod -- arkhamhorror fast      → games/arkhamhorror 的 npm run test:fast
//   npm run test:mod -- arkhamhorror test:p7   → games/arkhamhorror 的 npm run test:p7
//   npm run test:mod -- arkhamhorror           → 不认识的脚本或缺少参数时列出可用脚本

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const [id, requested = 'test', ...rest] = process.argv.slice(2)
const games = fs.readdirSync(path.join(projectRoot, 'games'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(projectRoot, 'games', entry.name, 'package.json')))
  .map(entry => entry.name)

if (!id || !games.includes(id)) {
  console.error('用法：npm run test:mod -- <游戏 id> [脚本]')
  console.error('带 package.json 的游戏：' + (games.join('、') || '（无）'))
  process.exit(id ? 1 : 0)
}

const scripts = JSON.parse(fs.readFileSync(path.join(projectRoot, 'games', id, 'package.json'), 'utf8')).scripts || {}
const script = [requested === 'test' ? 'test' : 'test:' + requested, requested].find(name => scripts[name])
if (!script) {
  console.error(`games/${id} 没有脚本「${requested}」。可用的测试脚本：`)
  for (const name of Object.keys(scripts).filter(name => name === 'test' || name.startsWith('test:'))) console.error('  ' + name)
  process.exit(1)
}

// npm 启动本脚本时会提供自身路径；直接用 node 运行时退回 shell 中的 npm。
const npm = process.env.npm_execpath
const args = ['run', script, '-w', 'games/' + id, ...(rest.length ? ['--', ...rest] : [])]
const result = npm
  ? spawnSync(process.execPath, [npm, ...args], { cwd: projectRoot, stdio: 'inherit' })
  : spawnSync('npm', args, { cwd: projectRoot, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(result.status ?? 1)
