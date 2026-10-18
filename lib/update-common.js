// 自动更新与游戏商店共用的设置、下载与地址拼装。
//
// 设置保存在 <DSH_HOME 或 ~/.dsh>/boardgame-hall/updates.json：
//   autoCheck  是否在启动后与每 6 小时自动检查（默认 true；BOARDGAME_UPDATE_CHECK=0 强制关闭）
//   mirror     GitHub 加速前缀（如 https://ghfast.top/），直连失败时改走「前缀 + 原地址」
// 下载内容都有签名清单里的 sha256 兜底，所以镜像不需要被信任。
//
// cdn 选项是 { 'GitHub 仓库': 'CDN 前缀' } 映射，前缀指向该仓库在 CDN 上的目录（如 https://dl.example.com/arkhamhorror/）。
// 命中的 GitHub 地址先按 CDN 地址试一次，来源顺序为 CDN → GitHub → 加速镜像。
// 前缀下的路径与 GitHub 一一对应（见 tools/release/r2.mjs）：
//   releases/download/<tag>/<file>、releases/latest/download/<file>、raw/<branch>/<path>

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

export const CDN_PATTERN = /^https:\/\/[^\s?#]+\/$/

export function cdnUrl(url, cdn) {
  const lookup = repo => Object.entries(cdn || {}).find(([key]) => key.toLowerCase() === repo.toLowerCase())?.[1]
  const routes = [
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(releases\/(?:latest\/download|download\/[^/]+)\/[^/?#]+)$/,
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+\/.+)$/,
  ]
  for (const [i, pattern] of routes.entries()) {
    const match = pattern.exec(url)
    if (!match) continue
    const base = REPO_PATTERN.test(match[1]) && lookup(match[1])
    return base && CDN_PATTERN.test(base) ? base + (i === 1 ? 'raw/' : '') + match[2] : null
  }
  return null
}

function candidates(url, { mirror, cdn }) {
  const github = /^https:\/\/(github\.com|raw\.githubusercontent\.com)\//.test(url)
  return [cdnUrl(url, cdn), url, github && mirror ? mirror + url : null].filter(Boolean)
}

/**
 * 依次尝试各来源，返回内容 Buffer；给了 parse 时返回 parse(buffer)。
 * parse 抛错（例如签名不符、镜像返回了网页）同样换下一个来源。
 */
export async function fetchBuffer(url, { mirror = '', cdn, fetchImpl = fetch, timeoutMs = 15000, parse } = {}) {
  let lastError
  for (const target of candidates(url, { mirror, cdn })) {
    try {
      const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const buffer = Buffer.from(await response.arrayBuffer())
      return parse ? parse(buffer) : buffer
    } catch (error) {
      lastError = error
    }
  }
  throw new Error('无法访问 ' + url + '：' + describeError(lastError))
}

export async function fetchText(url, { parse, ...options } = {}) {
  return fetchBuffer(url, { ...options, parse: buffer => {
    const text = new TextDecoder().decode(buffer)
    return parse ? parse(text) : text
  } })
}

/**
 * 用 HTTP Range 取 [start, end]（含两端）字节。服务器必须回 206 且区间吻合；
 * 回 200（不支持 Range）时立即中止，避免把整个包拉下来。onProgress(delta) 报告新增字节，失败重试时报告负数回退。
 */
export async function fetchRange(url, start, end, { mirror = '', cdn, fetchImpl = fetch, onProgress } = {}) {
  const expected = end - start + 1
  let lastError
  for (const target of candidates(url, { mirror, cdn })) {
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
export async function downloadVerified(url, destination, { sha256, size, mirror = '', cdn, fetchImpl = fetch, onProgress } = {}) {
  let lastError
  for (const target of candidates(url, { mirror, cdn })) {
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
