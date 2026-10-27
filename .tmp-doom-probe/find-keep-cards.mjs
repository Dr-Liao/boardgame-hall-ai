import fs from 'node:fs'
const text = fs.readFileSync('src/cards/cards-data.js', 'utf8')
const patterns = ['不要从场上地点移除毁灭标记', '不要从场上任何地点移除毁灭标记', '不要移除敌人的毁灭标记', '不要移除其上任何毁灭标记', '不要移除那赫卜', 'do not remove doom from cards in play']
for (const pattern of patterns) {
  let i = -1
  const codes = []
  while ((i = text.indexOf(pattern, i + 1)) >= 0) {
    const before = text.slice(0, i)
    const codeIndex = before.lastIndexOf('"code": "')
    const code = codeIndex >= 0 ? /"code": "([0-9a-zA-Z]+)"/.exec(before.slice(codeIndex))?.[1] : '?'
    codes.push(code || '?')
  }
  console.log(pattern, '->', [...new Set(codes)].join(','))
}
