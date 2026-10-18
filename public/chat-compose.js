// 聊天输入补全的纯函数层（无 DOM、无网络，可单测）。
//
// 负责三件小事：
//   1. 判断光标处是否处于 @ / 指令 的补全上下文；
//   2. 按已输入的内容过滤候选；
//   3. 生成消息去重用的键（本地占位与服务端事件对齐用）。

/**
 * 根据光标位置判断当前是否在输入 @ 或 / 的补全上下文。
 * 返回 { kind:'mention'|'command', start, end, query }：start/end 是要被替换的文本区间。
 * - 指令：整条发言以 /（含全角 ／）开头，且光标前还没有出现空白；
 * - 定向：@ 在词首（行首或空白之后），且 @ 到光标之间没有空白。
 */
export function chatCompletionContext(value, caret) {
  const text = String(value == null ? '' : value)
  const upto = text.slice(0, caret == null ? text.length : Math.max(0, caret))
  const slash = /^\s*[\/／]([^\s]*)$/.exec(upto)
  if (slash) return { kind: 'command', start: upto.search(/[\/／]/), end: upto.length, query: slash[1] }
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  const before = at > 0 ? upto[at - 1] : ''
  if (at > 0 && !/\s/.test(before)) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { kind: 'mention', start: at, end: upto.length, query }
}

/** 按已输入内容过滤候选：先比标签，再比候选本身（去掉开头的 @ 或 /）。 */
export function chatFilterOptions(options, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase()
  if (!q) return options || []
  return (options || []).filter((option) => {
    const label = String(option && option.label || '').toLowerCase()
    const name = String(option && option.value || '').trim().slice(1).toLowerCase()
    return label.startsWith(q) || label.includes(q) || name.startsWith(q)
  })
}

/** 消息去重键：同一频道 + 同一文本。 */
export function chatMessageKey(event) {
  if (!event) return ''
  return (event.to == null ? 'table' : 'seat:' + Number(event.to)) + '|' + String(event.text == null ? '' : event.text)
}
