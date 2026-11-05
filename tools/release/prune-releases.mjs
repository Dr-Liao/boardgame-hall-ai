// 发布成功后删掉超出上限的旧版本，避免 GitHub Release 附件和 R2 一直堆积。
// 玩家只读最新清单，旧的 releases/download/<tag>/ 可以删。
// git tag 保留：几乎不占空间，也避免版本号被重复使用（带版本号的 CDN 文件缓存一年）。
//
//   node tools/release/prune-releases.mjs --dir=hall --current=v1.2.0 [--keep=3] [--repo=owner/name]
//
// --keep 默认 3，也可用环境变量 RELEASE_KEEP，至少为 1。刚发布的 --current 永不删除。
// 未配置 R2_* 时只清理 GitHub Release。GitHub 仓库取 --repo，否则用当前 checkout。

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/
const R2_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']

export function parseSemver(tag) {
  const match = SEMVER.exec(tag)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

// tags 里只认 vX.Y.Z。保留最高的 keep 个，并永远留下 current（即使它不在最高的 keep 个里）。
export function chooseKept(tags, { keep, current }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep 必须是大于等于 1 的整数')
  if (!parseSemver(current)) throw new Error('--current 必须是 vX.Y.Z')
  const versions = [...new Set(tags.filter(tag => parseSemver(tag)))]
  if (!versions.includes(current)) versions.push(current)
  versions.sort(compareSemver)
  const kept = new Set(versions.slice(-keep))
  kept.add(current)
  return {
    kept: versions.filter(tag => kept.has(tag)),
    drop: versions.filter(tag => !kept.has(tag)),
  }
}

// 只从 <dir>/releases/download/<vX.Y.Z>/ 收集版本，不把 releases/latest 和 raw 算进去。
export function tagsInDownloadPrefix(keys, dir) {
  const prefix = `${dir}/releases/download/`
  const found = new Set()
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const tag = key.slice(prefix.length).split('/')[0]
    if (parseSemver(tag)) found.add(tag)
  }
  return [...found]
}

function option(name) {
  return process.argv.slice(2).find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3)
}

function keepCount() {
  const raw = option('keep') || process.env.RELEASE_KEEP || '3'
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('--keep 必须是大于等于 1 的整数')
  return Number(raw)
}

function requireDir() {
  const dir = option('dir')
  if (!/^[A-Za-z0-9._-]+$/.test(dir || '')) throw new Error('--dir 必须是存储桶里的目录名，如 hall 或 arkhamhorror')
  return dir
}

function requireRepo() {
  const repo = option('repo') || process.env.GITHUB_REPOSITORY || ''
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('--repo 必须是 owner/name')
  return repo
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`无法运行 ${command}：${result.error.message}`)
  if (result.status !== 0) {
    const message = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
    const error = new Error(message || `${command} 失败`)
    error.status = result.status
    throw error
  }
  return result
}

function githubTags(repo) {
  const args = ['release', 'list', '--limit', '1000', '--json', 'tagName']
  if (repo) args.push('--repo', repo)
  const result = run('gh', args)
  let releases
  try {
    releases = JSON.parse(result.stdout)
  } catch {
    throw new Error('无法解析 gh release list 的输出')
  }
  if (!Array.isArray(releases)) throw new Error('gh release list 返回的不是列表')
  return releases.map(release => release.tagName).filter(tag => typeof tag === 'string')
}

function r2Ready() {
  const present = R2_ENV.filter(name => process.env[name])
  if (present.length === 0) return false
  if (present.length !== R2_ENV.length) throw new Error('R2 环境变量不完整，需要 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET')
  return true
}

function r2Tags(dir) {
  const script = fileURLToPath(new URL('./r2.mjs', import.meta.url))
  const result = run(process.execPath, [script, 'keys', `--prefix=${dir}/releases/download/`])
  return tagsInDownloadPrefix(result.stdout.split(/\r?\n/).filter(Boolean), dir)
}

function deleteGithubRelease(tag, repo) {
  const args = ['release', 'delete', tag, '--yes']
  if (repo) args.push('--repo', repo)
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.error) throw new Error(`无法运行 gh：${result.error.message}`)
  if (result.status === 0) {
    console.log(`已删除 GitHub Release ${tag}（git tag 仍保留）`)
    return
  }
  const message = `${result.stderr || ''}\n${result.stdout || ''}`
  if (/not found|Could not resolve|release not found/i.test(message)) {
    console.log(`GitHub Release ${tag} 已不存在`)
    return
  }
  throw new Error(message.trim() || `删除 GitHub Release ${tag} 失败`)
}

function deleteR2Tag(dir, tag) {
  const script = fileURLToPath(new URL('./r2.mjs', import.meta.url))
  const result = run(process.execPath, [script, 'delete-tag', `--dir=${dir}`, `--tag=${tag}`])
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n')
}

async function main() {
  const dir = requireDir()
  const repo = requireRepo()
  const current = option('current')
  const keep = keepCount()
  if (!parseSemver(current)) throw new Error('缺少或无效的 --current，必须是 vX.Y.Z')

  const tags = [...githubTags(repo)]
  const cleanCdn = r2Ready()
  if (cleanCdn) tags.push(...r2Tags(dir))
  else console.log('未配置 R2，跳过 CDN 清理')

  const plan = chooseKept(tags, { keep, current })
  if (plan.drop.includes(current) || !plan.kept.includes(current)) throw new Error('拒绝清理当前版本 ' + current)
  console.log(`保留 ${plan.kept.length} 个版本：${plan.kept.join('、') || '（无）'}`)
  if (!plan.drop.length) {
    console.log(`没有超出上限的版本（上限 ${keep}）`)
    return
  }
  console.log(`将清理 ${plan.drop.length} 个旧版本：${plan.drop.join('、')}`)
  for (const tag of plan.drop) {
    deleteGithubRelease(tag, repo)
    if (cleanCdn) deleteR2Tag(dir, tag)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
