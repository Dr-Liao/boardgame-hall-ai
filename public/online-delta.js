// P3.1 浏览器 status 增量的纯逻辑（不依赖 DOM / fetch），可被 Node 单测直接 import。
//
// 大厅的 /api/online/status 在浏览器声明 baseStamp 且命中服务器基线时，会返回
//   { sessionOmitted: true, stamp }        内容与浏览器手上的完全一致
//   { sessionDelta: { stamp, baseStamp, changes } }  只回 snapshotChanges 增量
// 浏览器用 applySnapshotChanges(上一份 wire 会话, changes) 还原，再走 P1.4 的静态表 hydration。
// 任何异常/基线不符都由调用方丢弃增量、等下一次全量（失败模式只能是「多下一次全量」）。

const object = value => value !== null && typeof value === 'object'

/** 与大厅 statusStampOf 保持一致：sessionId:revision:eventCount[:staticVersion]。 */
export function statusStampOf(session) {
  if (!session || typeof session !== 'object') return ''
  const parts = [session.sessionId || '', session.state?.revision ?? -1,
    Array.isArray(session.events) ? session.events.length : 0]
  if (typeof session.staticVersion === 'string' && session.staticVersion) parts.push(session.staticVersion)
  return parts.join(':')
}

/**
 * 与 lib/online-sync.js 的 applySnapshotChanges 同语义（浏览器不能 import lib/，这里保留一份），
 * 额外校验 changes 形状；任何非法路径/数组操作直接抛错，由调用方回退全量。
 */
export function applySnapshotChanges(before, changes) {
  if (!Array.isArray(changes)) throw new Error('同步增量无效')
  let result = structuredClone(before)
  for (const change of changes) {
    if (!change || !Array.isArray(change.path)) throw new Error('同步路径无效')
    if (change.path.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('同步路径无效')
    let parent = result
    for (const key of change.path.slice(0, -1)) parent = parent[key]
    const key = change.path.at(-1)
    if (change.splice !== undefined) {
      const target = change.path.length ? parent[key] : result
      if (!Array.isArray(target) || !Number.isInteger(change.splice) || change.splice < 0 || change.splice > target.length) {
        throw new Error('同步数组无效')
      }
      target.splice(change.splice, target.length - change.splice, ...(Array.isArray(change.items) ? change.items : []))
    } else if (!change.path.length) result = change.value
    else if (change.remove) delete parent[key]
    else parent[key] = change.value
  }
  return result
}

/**
 * 把 status 响应里的增量应用到上一份会话，返回 { session, stamp }；无法应用时返回 null。
 * baseStamp 由调用方提供（浏览器是 state.online.session 的 stamp），避免误用到别的会话。
 */
export function applyStatusDelta(previous, payload) {
  const delta = payload?.sessionDelta
  if (!previous || !delta || !Array.isArray(delta.changes)) return null
  if (delta.baseStamp !== statusStampOf(previous)) return null
  try {
    return { session: applySnapshotChanges(previous, delta.changes), stamp: delta.stamp }
  } catch {
    return null
  }
}
