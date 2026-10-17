import net from 'node:net'

// Use a separate browser origin from the development server (8787).
// Respect an explicit port, otherwise find a free portable-edition port.
if (!process.env.BOARDGAME_PORT) {
  const host = process.env.BOARDGAME_HOST || '127.0.0.1'
  for (let port = 18787; port < 18887; port++) {
    const available = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
      probe.listen(port, host, () => probe.close(() => resolve(true)))
    })
    if (available) {
      process.env.BOARDGAME_PORT = String(port)
      break
    }
  }
  if (!process.env.BOARDGAME_PORT) throw new Error('没有可用端口，请设置 BOARDGAME_PORT 后重试。')
}

console.log('  新存档与设置保存在：' + process.env.DSH_HOME)
await import('./server.js')
