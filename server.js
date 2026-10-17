// 桌游大厅 · 独立服务端入口
//
// 启动：  node server.js    （或 npm start）
// 之后会自动打开浏览器到 http://<HOST>:<PORT>，显示桌游大厅网页。
//
// 环境变量：
//   BOARDGAME_PORT  监听端口（默认 8787）
//   BOARDGAME_HOST  监听地址（默认 127.0.0.1）
//   BOARDGAME_NO_OPEN=1  不自动打开浏览器

import { loadMods } from './lib/mods.js'
import { createServer } from './lib/server.js'
import { openBrowser } from './lib/open.js'
import { hallUrl, isHallRunning } from './lib/launch.js'

const PORT = Number(process.env.BOARDGAME_PORT) || 8787
const HOST = process.env.BOARDGAME_HOST || '127.0.0.1'
const url = hallUrl(HOST, PORT)

if (await isHallRunning(url)) {
  console.log('  🎲 桌游大厅已在运行，正在打开: ' + url)
  openBrowser(url)
} else {
  await startHall()
}

async function startHall() {
  // 扫描 games/ 目录，把每个桌游当做一个独立 Mod 插件加载进来。
  const mods = await loadMods()

  const server = createServer({ mods })
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
    console.log('')
    console.log('  🎲 桌游大厅已启动')
    console.log('     地址: ' + url)
    console.log('     已加载 ' + mods.length + ' 个桌游 Mod: ' + (mods.map((m) => m.name).join('、') || '（无）'))
    if (restored && restored.length) console.log('     已恢复 ' + restored.length + ' 局进行中的对战')
    console.log('     按 Ctrl+C 退出')
    console.log('')
    openBrowser(url)
  })
}
