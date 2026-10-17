// 自动打开浏览器（跨平台）。BOARDGAME_NO_OPEN=1 时跳过。

import { exec } from 'node:child_process'

export function openBrowser(url) {
  if (process.env.BOARDGAME_NO_OPEN === '1') return
  let cmd
  if (process.platform === 'win32') cmd = `start "" "${url}"`
  else if (process.platform === 'darwin') cmd = `open "${url}"`
  else cmd = `xdg-open "${url}"`
  exec(cmd, (err) => {
    if (err) console.log('  无法自动打开浏览器，请手动访问: ' + url)
  })
}
