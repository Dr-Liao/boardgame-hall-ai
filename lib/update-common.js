// 自动更新与游戏商店共用的设置、下载与地址拼装。
//
// 设置保存在 <DSH_HOME 或 ~/.dsh>/boardgame-hall/updates.json：
//   autoCheck  是否在启动后与每 6 小时自动检查（默认 true；BOARDGAME_UPDATE_CHECK=0 强制关闭）
//   mirror     GitHub 加速前缀（如 https://ghfast.top/），直连失败时改走「前缀 + 原地址」
// 下载内容都有签名清单里的 sha256 兜底，所以镜像不需要被信任。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const DEFAULT_GITHUB = 'https://github.com'

export function hallDataDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'boardgame-hall')
}

export function userModsDir() {
  return path.join(hallDataDir(), 'mods')
}

const DEFAULT_SETTINGS = { autoCheck: true, mirror: '' }

export function loadUpdateSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(hallDataDir(), 'updates.json'), 'utf8'))
    return { ...DEFAULT_SETTINGS, ...pickSettings(data) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveUpdateSettings(patch) {
  const next = { ...loadUpdateSettings(), ...pickSettings(patch) }
  const file = path.join(hallDataDir(), 'updates.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2))
  fs.renameSync(file + '.tmp', file)
  return next
}

function pickSettings(data) {
  const result = {}
  if (typeof data?.autoCheck === 'boolean') result.autoCheck = data.autoCheck
  if (typeof data?.mirror === 'string') {
    const mirror = data.mirror.trim()
    if (mirror && !/^https:\/\/[^\s]+\/$/.test(mirror)) throw new Error('镜像前缀必须以 https:// 开头、以 / 结尾')
    result.mirror = mirror
  }
  return result
}

export function autoCheckAllowed(settings) {
  return process.env.BOARDGAME_UPDATE_CHECK !== '0' && settings.autoCheck !== false
}

export function githubBase() {
  return (process.env.BOARDGAME_GITHUB_BASE || DEFAULT_GITHUB).replace(/\/+$/, '')
}

export function latestAssetUrl(repo, file, base = githubBase()) {
  return `${base}/${repo}/releases/latest/download/${encodeURIComponent(file)}`
}

export function releaseAssetUrl(repo, tag, file, base = githubBase()) {
  return `${base}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`
}

export function releasePageUrl(repo, base = githubBase()) {
  return `${base}/${repo}/releases/latest`
}

export const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

function candidates(url, mirror) {
  return mirror && /^https:\/\/(github\.com|raw\.githubusercontent\.com)\//.test(url) ? [url, mirror + url] : [url]
}

/** 依次尝试直连与镜像，返回内容 Buffer。 */
export async function fetchBuffer(url, { mirror = '', fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let lastError
  for (const target of candidates(url, mirror)) {
    try {
      const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
    }
  }
  throw new Error('无法访问 ' + url + '：' + describeError(lastError))
}

export async function fetchText(url, options) {
  return new TextDecoder().decode(await fetchBuffer(url, options))
}

/**
 * 用 HTTP Range 取 [start, end]（含两端）字节。服务器必须回 206 且区间吻合；
 * 回 200（不支持 Range）时立即中止，避免把整个包拉下来。onProgress(delta) 报告新增字节，失败重试时报告负数回退。
 */
export async function fetchRange(url, start, end, { mirror = '', fetchImpl = fetch, onProgress } = {}) {
  const expected = end - start + 1
  let lastError
  for (const target of candidates(url, mirror)) {
    const controller = new AbortController()
    let idle
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error('下载超时')), 30000) }
    let received = 0
    try {
      touch()
      const response = await fetchImpl(target, { headers: { range: `bytes=${start}-${end}` }, signal: controller.signal, redirect: 'follow' })
      if (response.status !== 206 || !response.body) {
        controller.abort()
        throw new Error(response.status === 200 ? '服务器不支持分段下载' : 'HTTP ' + response.status)
      }
      const contentRange = response.headers.get('content-range')
      if (contentRange && !contentRange.startsWith(`bytes ${start}-${end}/`)) throw new Error('分段下载区间不符')
      const chunks = []
      for await (const chunk of response.body) {
        touch()
        received += chunk.length
        if (received > expected) throw new Error('分段内容超出预期大小')
        chunks.push(chunk)
        onProgress?.(chunk.length)
      }
      if (received !== expected) throw new Error('分段内容大小不符')
      return Buffer.concat(chunks)
    } catch (error) {
      lastError = error
      if (received) onProgress?.(-received)
    } finally {
      clearTimeout(idle)
    }
  }
  throw new Error('分段下载失败：' + describeError(lastError))
}

/**
 * 边下载边写入 destination 并计算 sha256，最后校验大小与哈希；校验失败时删除文件。
 * onProgress(received, total) 用于界面进度。30 秒没有收到新数据视为卡死，换下一个来源。
 */
export async function downloadVerified(url, destination, { sha256, size, mirror = '', fetchImpl = fetch, onProgress } = {}) {
  let lastError
  for (const target of candidates(url, mirror)) {
    const controller = new AbortController()
    let idle
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error('下载超时')), 30000) }
    let output
    try {
      touch()
      const response = await fetchImpl(target, { signal: controller.signal, redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
      const total = Number(size) || Number(response.headers.get('content-length')) || 0
      const hash = createHash('sha256')
      output = await fs.promises.open(destination, 'w')
      let received = 0
      for await (const chunk of response.body) {
        touch()
        received += chunk.length
        if (size && received > size) throw new Error('下载内容超出预期大小')
        hash.update(chunk)
        await output.write(chunk)
        onProgress?.(received, total)
      }
      await output.close()
      output = null
      if (size && received !== size) throw new Error('下载内容大小不符')
      if (sha256 && hash.digest('hex') !== sha256) throw new Error('下载内容校验失败')
      return destination
    } catch (error) {
      lastError = error
      await output?.close().catch(() => {})
      rmQuiet(destination)
    } finally {
      clearTimeout(idle)
    }
  }
  throw new Error('下载失败：' + describeError(lastError))
}

function describeError(error) {
  const cause = error?.cause?.message
  return String(error?.message || error) + (cause ? '（' + cause + '）' : '')
}

export function rmQuiet(target) {
  try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* ignore */ }
}
