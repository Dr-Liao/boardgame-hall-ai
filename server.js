// 桌游大厅 · 独立服务端入口
//
// 启动：  node server.js    （或 npm start）
// 之后会自动打开浏览器到 http://<HOST>:<PORT>，显示桌游大厅网页。
//
// 环境变量：
//   BOARDGAME_PORT  监听端口（默认 8787）
//   BOARDGAME_HOST  监听地址（默认 127.0.0.1）
//   BOARDGAME_NO_OPEN=1  不自动打开浏览器
//   BOARDGAME_UPDATE_CHECK=0  不自动检查大厅与游戏更新

import fs from 'node:fs'
import { loadMods } from './lib/mods.js'
import { createServer } from './lib/server.js'
import { openBrowser } from './lib/open.js'
import { hallUrl, isHallRunning } from './lib/launch.js'
import { installContext, markHealthy, cleanupInstall, mergeLooseAppFolder, RESTART_EXIT_CODE } from './lib/install.js'
import { createUpdater } from './lib/updater.js'
import { createStore } from './lib/store.js'
import { loadUpdateSettings, autoCheckAllowed } from './lib/update-common.js'

const PORT = Number(process.env.BOARDGAME_PORT) || 8787
const HOST = process.env.BOARDGAME_HOST || '127.0.0.1'
const url = hallUrl(HOST, PORT)
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// —— 退出：Ctrl+C 直接关服退出 ————————————————————————————————
// Windows 批处理窗口里按 Ctrl+C 时，cmd 会对每一层批处理各问一次「终止批处理操作吗(Y/N)?」，
// start.bat 为了切到 UTF-8 会再开一层 cmd，所以以前要按两次 y。
// 把控制台输入切成 raw 模式后，Ctrl+C 只作为 0x03 字节交给本进程，不再是控制台信号：
// cmd 不会被打断，也就不会问；退出由这里的 quit() 负责（关服、恢复控制台再退）。
let hallServer = null
let quitting = false

function quit(code = 0) {
  if (quitting) process.exit(code) // 退出中再按一次：立即退出
  quitting = true
  const server = hallServer
  if (!server || !server.listening) process.exit(code) // 还在启动：直接退出
  console.log('')
  console.log('  正在退出桌游大厅…')
  try { server.online?.close() } catch { /* 已经关闭 */ }
  try { server.closeAllConnections?.() } catch { /* 已经关闭 */ }
  server.close(() => process.exit(code))
  // 还有残留连接时最多等 2 秒，别让窗口卡住。
  setTimeout(() => process.exit(code), 2000)
}

function installQuitHandler() {
  const stdin = process.stdin
  let raw = false
  process.on('exit', () => {
    if (!raw) return
    raw = false
    try { stdin.setRawMode(false) } catch { /* 控制台已不可用 */ }
  })
  process.on('SIGINT', () => quit())
  process.on('SIGTERM', () => quit())
  // 只有真正的控制台才能切 raw 模式；管道、服务、测试里沿用信号退出。
  if (process.platform !== 'win32' || !stdin.isTTY || typeof stdin.setRawMode !== 'function') return
  try {
    stdin.setRawMode(true)
    raw = true
    stdin.setEncoding('utf8')
    stdin.on('data', text => { if (text.includes('\u0003')) quit() })
    stdin.resume()
  } catch (error) {
    console.warn('  [console] 无法接管 Ctrl+C，改用系统默认方式退出：' + error.message)
  }
}

if (await isHallRunning(url)) {
  console.log('  🎲 桌游大厅已在运行，正在打开: ' + url)
  openBrowser(url)
} else {
  await startHall()
}

async function startHall() {
  installQuitHandler()
  const install = installContext()
  if (install) {
    try {
      const merged = mergeLooseAppFolder(install.root)
      if (merged) console.log('  [update] 已把 app 文件夹中的 ' + merged + ' 个资源文件并入当前版本')
    } catch (error) { console.warn('  [update] 合并 app 文件夹失败：' + error.message) }
  }

  // 扫描 games/ 与已下载的游戏目录，把每个桌游当做一个独立 Mod 插件加载进来。
  const mods = await loadMods()
  const { repo, registry, cdn } = readReleaseConfig()
  const updater = createUpdater({ repo, cdnBase: cdn, install })
  const store = createStore({ mods, registryUrl: registry, cdn: repo && cdn ? { [repo]: cdn } : {} })
  store.cleanup()

  let server
  const restart = () => {
    console.log('  [update] 正在重启大厅…')
    server.online?.close()
    server.closeAllConnections?.()
    server.close(() => process.exit(RESTART_EXIT_CODE))
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 3000).unref()
  }
  server = createServer({ mods, updates: { updater, store, onRestart: restart } })
  hallServer = server
  // 恢复上一进程留下的对局存档（BOARDGAME_PERSIST=0 可整体关闭）。
  const restored = await server.ready

  server.on('error', async error => {
    server.online?.close()
    if (error.code === 'EADDRINUSE' && await isHallRunning(url)) {
      console.log('  🎲 桌游大厅已在运行，正在打开: ' + url)
      openBrowser(url)
      return
    }
    console.error(error.code === 'EADDRINUSE'
      ? `  启动失败：端口 ${PORT} 已被其他程序占用。请关闭占用程序，或通过 BOARDGAME_PORT 设置其他端口。`
      : '  启动失败：' + error.message)
    process.exitCode = 1
  })

  server.listen(PORT, HOST, () => {
    if (install) {
      // 端口已监听，确认新版本可用：此后异常退出不再回滚，并清理更早的版本目录。
      try {
        if (markHealthy(install.root)) console.log('  [update] 新版本启动成功')
        cleanupInstall(install.root)
      } catch (error) { console.warn('  [update] 更新收尾失败：' + error.message) }
    }
    console.log('')
    console.log('  🎲 桌游大厅已启动')
    console.log('     地址: ' + url)
    console.log('     已加载 ' + mods.length + ' 个桌游 Mod: ' + (mods.map((m) => m.name).join('、') || '（无）'))
    if (restored && restored.length) console.log('     已恢复 ' + restored.length + ' 局进行中的对战')
    console.log('     按 Ctrl+C 退出')
    console.log('')
    openBrowser(url)
    scheduleChecks(updater, store)
  })
}

function readReleaseConfig() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return { repo: pkg.boardgame?.repo || null, registry: pkg.boardgame?.registry || null, cdn: pkg.boardgame?.cdn || null }
  } catch {
    return { repo: null, registry: null, cdn: null }
  }
}

function scheduleChecks(updater, store) {
  const run = async () => {
    if (!autoCheckAllowed(loadUpdateSettings())) return
    const [hall] = await Promise.all([updater.mode === 'disabled' ? null : updater.check(), store.check()])
    if (hall?.available) console.log('  [update] 发现大厅新版本 ' + hall.latest.version + '，可在「设置 → 大厅更新」中更新')
    const games = store.status().games.filter(game => game.installed && game.updateAvailable)
    if (games.length) console.log('  [update] 有 ' + games.length + ' 个游戏可更新：' + games.map(game => game.name).join('、'))
  }
  setTimeout(() => run().catch(() => {}), 8000).unref()
  setInterval(() => run().catch(() => {}), CHECK_INTERVAL_MS).unref()
}
