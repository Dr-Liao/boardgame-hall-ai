// 把免安装发布目录拆成自动更新用的包。
//
//   node tools/release/pack-update.mjs <发布目录>... [--app] [--out=dist/release]
//
// 每个发布目录（build-windows.ps1 / build-macos.mjs 的产物，需含 build-manifest.json）生成：
//   BoardgameHall-<平台>-<版本>.zip               完整包（首次安装用；取同名 .zip 产物）
//   BoardgameHall-runtime-<平台>-<Node 版本>.zip  运行时包（顶层目录 runtime-<Node 版本>/）
// 加 --app 时再从第一个目录生成平台无关的程序包（所有用户都从它更新，发布纯大厅版时程序包也不含其他游戏）：
//   BoardgameHall-app-<版本>.zip                   （顶层目录 app-<版本>/）
//   BoardgameHall-app-<版本>.files.json            增量更新用的文件索引（见 lib/delta.js）

import fs from 'node:fs'
import path from 'node:path'
import { zipDirectory } from '../../lib/zip.js'
import { buildIndex, indexFileName } from '../../lib/delta.js'

const argv = process.argv.slice(2)
const option = name => argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const dirs = argv.filter(value => !value.startsWith('--')).map(value => path.resolve(value))
const out = path.resolve(option('--out') || 'dist/release')
if (!dirs.length) throw new Error('用法：pack-update.mjs <发布目录>... [--app] [--out=dist/release]')
fs.mkdirSync(out, { recursive: true })

let appPacked = !argv.includes('--app')
for (const dir of dirs) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''))
  const { platform, hallVersion, appDir, runtimeDir } = manifest
  if (!platform || !hallVersion || !appDir || !runtimeDir) throw new Error(dir + ' 的 build-manifest.json 缺少版本化布局字段，请用新版构建脚本重新构建')
  const runtimeVersion = runtimeDir.replace(/^runtime-/, '')
  const runtimeZip = path.join(out, `BoardgameHall-runtime-${platform}-${runtimeVersion}.zip`)
  zipDirectory(path.join(dir, runtimeDir), runtimeZip, { prefix: runtimeDir, executable: relative => relative === 'node' })
  console.log('RUNTIME=' + runtimeZip)
  if (!appPacked) {
    const appZip = path.join(out, `BoardgameHall-app-${hallVersion}.zip`)
    zipDirectory(path.join(dir, appDir), appZip, { prefix: appDir })
    console.log('APP=' + appZip)
    const indexPath = path.join(out, indexFileName(path.basename(appZip)))
    fs.writeFileSync(indexPath, JSON.stringify(await buildIndex(appZip, { prefix: appDir })))
    console.log('INDEX=' + indexPath)
    appPacked = true
  }
  if (fs.existsSync(dir + '.zip')) {
    const full = path.join(out, `BoardgameHall-${platform}-${hallVersion}.zip`)
    fs.copyFileSync(dir + '.zip', full)
    console.log('FULL=' + full)
  }
}
