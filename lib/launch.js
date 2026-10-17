// 启动前只读探测，避免重复进程恢复存档或重新连接联机房间。
export function hallUrl(host, port) {
  const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`
}

export async function isHallRunning(url) {
  try {
    const options = { signal: AbortSignal.timeout(2000), redirect: 'error' }
    const [catalogResponse, pageResponse] = await Promise.all([
      fetch(url + '/api/catalog', options), fetch(url + '/', options),
    ])
    if (!catalogResponse.ok || !pageResponse.ok) return false
    const [catalog, page] = await Promise.all([catalogResponse.json(), pageResponse.text()])
    return catalog.ok === true && Array.isArray(catalog.games)
      && catalog.games.every(game => typeof game.id === 'string' && typeof game.name === 'string')
      && /<title>\s*桌游大厅\s*<\/title>/.test(page)
  } catch {
    return false
  }
}
