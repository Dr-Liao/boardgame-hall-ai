// 把发布同步到 Gitee，供国内玩家优先下载（大厅按 Gitee → GitHub → 加速镜像的顺序取文件）。
// 只用 Gitee OpenAPI，不推送源码：Gitee 仓库里只有 Release 附件和游戏目录文件。
//
//   node tools/release/gitee.mjs release <目录> --repo=<owner/name> --tag=v1.2.0 [--title=…] [--notes-file=…]
//     创建（或补全）该 tag 的 Release 并上传目录里的文件；tag 不存在时从默认分支创建。
//     清单（update-manifest.json、boardgame-mod.release.json）最后上传，
//     这样大厅从 Gitee 读到清单时，清单引用的包已经在了。超过 --max-mb（默认 100）的文件跳过，大厅会回退到 GitHub 下载。
//   node tools/release/gitee.mjs file <本地文件> --repo=<owner/name> --path=registry/index.json [--branch=main]
//     创建或更新仓库里的单个文件（游戏目录）。
//
// 令牌取环境变量 GITEE_TOKEN（Gitee「设置 → 私人令牌」，需要 projects 权限）。

import fs from 'node:fs'
import path from 'node:path'

const API = 'https://gitee.com/api/v5'
const MANIFESTS = new Set(['update-manifest.json', 'boardgame-mod.release.json'])
const argv = process.argv.slice(2)
const option = name => argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3)
const [command, target] = argv.filter(value => !value.startsWith('--'))
const token = process.env.GITEE_TOKEN
const repo = option('repo')
if (!token) throw new Error('缺少 GITEE_TOKEN')
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo || '')) throw new Error('--repo 必须是 owner/name')
if (!target) throw new Error('缺少目录或文件参数')

async function api(method, route, body) {
  const url = new URL(API + '/repos/' + repo + route)
  let payload
  if (method === 'GET') url.searchParams.set('access_token', token)
  else if (body instanceof FormData) { body.set('access_token', token); payload = body }
  else payload = new URLSearchParams({ access_token: token, ...body })
  const response = await fetch(url, { method, body: payload, signal: AbortSignal.timeout(method === 'GET' ? 60_000 : 4 * 60_000) })
  const text = await response.text()
  if (response.status === 404 && method === 'GET') return null
  if (!response.ok) throw new Error(`Gitee ${method} ${route} 失败：HTTP ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function release() {
  const tag = option('tag')
  if (!tag) throw new Error('缺少 --tag')
  const maxBytes = Number(option('max-mb') || 100) * 1024 * 1024
  const notes = option('notes-file') ? fs.readFileSync(option('notes-file'), 'utf8').trim() : ''
  const files = fs.readdirSync(target).filter(name => fs.statSync(path.join(target, name)).isFile())
    .sort((a, b) => Number(MANIFESTS.has(a)) - Number(MANIFESTS.has(b)) || a.localeCompare(b))
  const info = await api('GET', '')
  if (!info) throw new Error('Gitee 仓库 ' + repo + ' 不存在或令牌无权访问')
  const tags = await api('GET', '/tags?per_page=100') || []
  if (!tags.some(item => item.name === tag)) await api('POST', '/tags', { refs: info.default_branch, tag_name: tag, tag_message: tag })
  let item = await api('GET', '/releases/tags/' + encodeURIComponent(tag))
  if (!item?.id) {
    item = await api('POST', '/releases', {
      tag_name: tag, name: option('title') || tag, body: notes || tag, prerelease: 'false', target_commitish: info.default_branch,
    })
  }
  const existing = new Set(((await api('GET', `/releases/${item.id}/attach_files?per_page=100`)) || []).map(file => file.name))
  for (const name of files) {
    const file = path.join(target, name)
    const size = fs.statSync(file).size
    if (existing.has(name)) { console.log('已存在，跳过 ' + name); continue }
    if (size > maxBytes) { console.warn(`超过 ${maxBytes / 1048576} MB，跳过 ${name}（大厅会从 GitHub 下载）`); continue }
    const data = new Blob([await fs.promises.readFile(file)])
    // 从海外 CI 访问 Gitee 偶尔整个请求挂住；失败后先确认附件是否其实已到，再重传。
    for (let attempt = 1; ; attempt++) {
      try {
        const form = new FormData()
        form.set('file', data, name)
        await api('POST', `/releases/${item.id}/attach_files`, form)
        break
      } catch (error) {
        const uploaded = ((await api('GET', `/releases/${item.id}/attach_files?per_page=100`).catch(() => null)) || []).some(file => file.name === name)
        if (uploaded) break
        if (attempt >= 3) throw error
        console.warn(`上传 ${name} 失败（${error.cause?.code || error.message}），第 ${attempt + 1} 次重试`)
      }
    }
    console.log(`已上传 ${name}（${(size / 1048576).toFixed(1)} MB）`)
  }
}

async function file() {
  const remote = option('path')
  const branch = option('branch') || 'main'
  if (!remote) throw new Error('缺少 --path')
  const content = fs.readFileSync(target)
  const route = '/contents/' + remote.split('/').map(encodeURIComponent).join('/')
  const current = await api('GET', route + '?ref=' + encodeURIComponent(branch))
  if (current?.content && Buffer.from(current.content, 'base64').equals(content)) { console.log(remote + ' 未变化'); return }
  const body = { content: content.toString('base64'), message: 'sync ' + remote, branch }
  await (current?.sha ? api('PUT', route, { ...body, sha: current.sha }) : api('POST', route, body))
  console.log('已同步 ' + remote)
}

if (command === 'release') await release()
else if (command === 'file') await file()
else throw new Error('用法：gitee.mjs release <目录> … 或 gitee.mjs file <文件> …')
