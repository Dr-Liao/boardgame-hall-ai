// Diff only the already-redacted view for one player. Never diff authoritative state.
const object = value => value !== null && typeof value === 'object'
export function snapshotChanges(before, after, path = [], out = []) {
  if (before === after) return out
  if (!object(before) || !object(after) || Array.isArray(before) !== Array.isArray(after)) {
    out.push({ path, value: after }); return out
  }
  if (Array.isArray(after)) {
    const shared = Math.min(before.length, after.length)
    for (let i = 0; i < shared; i++) snapshotChanges(before[i], after[i], [...path, i], out)
    if (before.length !== after.length) out.push({ path, splice: shared, items: after.slice(shared) })
  } else {
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) out.push({ path: [...path, key], remove: true })
    for (const key of Object.keys(after)) snapshotChanges(before[key], after[key], [...path, key], out)
  }
  return out
}

export function applySnapshotChanges(before, changes) {
  let result = structuredClone(before)
  for (const change of changes) {
    if (!Array.isArray(change.path) || change.path.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('同步路径无效')
    let parent = result
    for (const key of change.path.slice(0, -1)) parent = parent[key]
    const key = change.path.at(-1)
    if (change.splice !== undefined) {
      const target = change.path.length ? parent[key] : result
      if (!Array.isArray(target) || !Number.isInteger(change.splice) || change.splice < 0 || change.splice > target.length) throw new Error('同步数组无效')
      target.splice(change.splice, target.length - change.splice, ...change.items)
    } else if (!change.path.length) result = change.value
    else if (change.remove) delete parent[key]
    else parent[key] = change.value
  }
  return result
}
