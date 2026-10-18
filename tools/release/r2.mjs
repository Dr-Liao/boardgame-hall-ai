// 把发布同步到 Cloudflare R2，供国内玩家优先下载（大厅按 CDN → GitHub → 加速镜像的顺序取文件）。
// 每个仓库占存储桶里的一个目录（--dir，如 hall、arkhamhorror），目录下的路径与 GitHub 一一对应，
// 大厅按 lib/update-common.js 的 cdnUrl 换算地址：
//
//   node tools/release/r2.mjs release <本地目录> --dir=arkhamhorror --tag=v1.2.0
//     上传到 <dir>/releases/download/<tag>/<文件>；清单（update-manifest.json、boardgame-mod.release.json）
//     最后上传，并另存一份到 <dir>/releases/latest/download/<文件>，
//     这样大厅从 CDN 读到最新清单时，清单引用的包已经在了。
//   node tools/release/r2.mjs file <本地文件> --dir=hall --path=registry/index.json [--branch=main]
//     上传到 <dir>/raw/<branch>/<path>（游戏目录）。
//   node tools/release/r2.mjs list [--prefix=…]
//     列出存储桶里的对象，用于核对。
//
// 直接调用 R2 的 S3 兼容接口（AWS SigV4 签名），不依赖其他工具。环境变量：
//   R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY（R2「管理 API 令牌」，需要对象读写权限）、R2_BUCKET

import fs from 'node:fs'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const MANIFESTS = new Set(['update-manifest.json', 'boardgame-mod.release.json'])
const IMMUTABLE = 'public, max-age=31536000, immutable'
const MUTABLE = 'public, max-age=300'
const TYPES = { '.json': 'application/json', '.zip': 'application/zip' }
const argv = process.argv.slice(2)
const option = name => argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3)
const [command, target] = argv.filter(value => !value.startsWith('--'))
const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKey, R2_SECRET_ACCESS_KEY: secretKey, R2_BUCKET: bucket } = process.env
if (!account || !accessKey || !secretKey || !bucket) throw new Error('缺少 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET')
const host = `${account}.r2.cloudflarestorage.com`

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

async function s3(method, key, { query = {}, body, headers = {} } = {}) {
  const uri = '/' + [bucket, ...(key ? key.split('/') : [])].map(encode).join('/')
  const search = Object.keys(query).sort().map(name => encode(name) + '=' + encode(query[name])).join('&')
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const scope = `${stamp.slice(0, 8)}/auto/s3/aws4_request`
  const signed = { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': stamp }
  const names = Object.keys(signed).join(';')
  const canonical = [method, uri, search, ...Object.entries(signed).map(([name, value]) => name + ':' + value), '', names, 'UNSIGNED-PAYLOAD'].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const signingKey = ['auto', 's3', 'aws4_request'].reduce(hmac, hmac('AWS4' + secretKey, stamp.slice(0, 8)))
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names}, Signature=${hmac(signingKey, toSign).toString('hex')}`
  const response = await fetch(`https://${host}${uri}${search ? '?' + search : ''}`, {
    method, body, headers: { ...headers, ...signed, authorization }, signal: AbortSignal.timeout(10 * 60_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`R2 ${method} ${key || '/'} 失败：HTTP ${response.status} ${text.slice(0, 300)}`)
  return text
}

async function upload(file, key, cacheControl) {
  const body = await fs.promises.readFile(file)
  const headers = { 'cache-control': cacheControl, 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }
  for (let attempt = 1; ; attempt++) {
    try {
      await s3('PUT', key, { body, headers })
      break
    } catch (error) {
      if (attempt >= 3) throw error
      console.warn(`上传 ${key} 失败（${error.cause?.code || error.message}），第 ${attempt + 1} 次重试`)
    }
  }
  console.log(`已上传 ${key}（${(body.length / 1048576).toFixed(1)} MB）`)
}

function repoPrefix() {
  const dir = option('dir')
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(dir || '')) throw new Error('--dir 必须是存储桶里的目录名，如 arkhamhorror')
  if (!target) throw new Error('缺少目录或文件参数')
  return dir + '/'
}

async function release() {
  const prefix = repoPrefix()
  const tag = option('tag')
  if (!tag || !/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error('缺少或无效的 --tag')
  const files = fs.readdirSync(target).filter(name => fs.statSync(path.join(target, name)).isFile())
    .sort((a, b) => Number(MANIFESTS.has(a)) - Number(MANIFESTS.has(b)) || a.localeCompare(b))
  for (const name of files) await upload(path.join(target, name), `${prefix}releases/download/${tag}/${name}`, IMMUTABLE)
  for (const name of files.filter(name => MANIFESTS.has(name))) await upload(path.join(target, name), `${prefix}releases/latest/download/${name}`, MUTABLE)
}

async function file() {
  const prefix = repoPrefix()
  const remote = option('path')
  const branch = option('branch') || 'main'
  if (!remote) throw new Error('缺少 --path')
  await upload(target, `${prefix}raw/${branch}/${remote}`, MUTABLE)
}

async function list() {
  const xml = await s3('GET', '', { query: { 'list-type': '2', prefix: option('prefix') || '' } })
  const items = [...xml.matchAll(/<Key>([^<]*)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)]
  for (const [, key, size] of items) console.log(`${(Number(size) / 1048576).toFixed(1).padStart(8)} MB  ${key}`)
  console.log(`共 ${items.length} 个对象${xml.includes('<IsTruncated>true') ? '（只列出前 1000 个）' : ''}`)
}

if (command === 'release') await release()
else if (command === 'file') await file()
else if (command === 'list') await list()
else throw new Error('用法：r2.mjs release <目录> … | file <文件> … | list [--prefix=…]')
