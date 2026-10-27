// 无浏览器探针：直接从 web/game-ui.js 源码里取出地点特性显示模型（纯函数）执行，
// 验证「已揭示显示印刷特性 / 未揭示只显示授予特性 / 地图只给通道」三条规则；
// 然后用源码级断言确认地点档案的帷幕不再重复叠加、地图徽记带 data-map-info 与特性聚焦。
// 说明：本机未安装 Playwright 浏览器，无法做真实渲染截图，这里退化为纯逻辑验证。
import fs from 'node:fs'

const file = new URL('../games/arkhamhorror/web/game-ui.js', import.meta.url)
const source = fs.readFileSync(file, 'utf8')

function extract(name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('找不到函数 ' + name)
  let depth = 0
  let started = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (char === '{') { depth++; started = true }
    else if (char === '}') { depth--; if (started && depth === 0) return source.slice(start, index + 1) }
  }
  throw new Error('函数未闭合 ' + name)
}

const factory = new Function('currentLanguage',
  extract('locationTraitPairs') + '\n' + extract('locationTraitLabel') + '\n' + extract('locationTraitBadges') +
  '\nreturn { locationTraitPairs, locationTraitLabel, locationTraitBadges }')

const failures = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ' != ' + JSON.stringify(expected)}`)
  if (!ok) failures.push(label)
}
const labels = (api, loc) => api.locationTraitPairs(loc).map(api.locationTraitLabel)
const badgeLabels = (api, loc) => api.locationTraitBadges(loc).map(api.locationTraitLabel)

const zh = factory(() => 'zh-cn')
const en = factory(() => 'en')

const revealed = { revealed: true, traits: ['Ground Floor', 'Passageway'], traitsZh: ['一楼', '通道'] }
const hiddenPlain = { revealed: false, traits: ['Ground Floor', 'Passageway'], traitsZh: ['一楼', '通道'] }
const hiddenGranted = {
  revealed: false, traits: ['Ground Floor', 'Passageway'], traitsZh: ['一楼', '通道'],
  grantedTraits: ['Passageway'], grantedTraitsZh: ['通道'],
}
const revealedGranted = {
  revealed: true, traits: ['Third Floor'], traitsZh: ['三楼'],
  grantedTraits: ['Passageway'], grantedTraitsZh: ['通道'],
}

check('中文界面：已揭示地点的印刷特性全部显示', labels(zh, revealed), ['一楼', '通道'])
check('中文界面：未揭示地点不显示印刷特性', labels(zh, hiddenPlain), [])
check('中文界面：未揭示地点显示授予的通道', labels(zh, hiddenGranted), ['通道'])
check('中文界面：已揭示地点合并印刷与授予特性', labels(zh, revealedGranted), ['三楼', '通道'])
check('中文界面：地图只渲染通道关键字', badgeLabels(zh, hiddenGranted), ['通道'])
check('中文界面：没有通道的地图不渲染关键字', badgeLabels(zh, { revealed: true, traits: ['Ground Floor'], traitsZh: ['一楼'] }), [])

check('英文界面：已揭示地点显示英文特性', labels(en, revealed), ['Ground Floor', 'Passageway'])
check('英文界面：未揭示地点只显示授予的英文特性', labels(en, hiddenGranted), ['Passageway'])
check('英文界面：地图徽记英文文案', badgeLabels(en, revealedGranted), ['Passageway'])
check('特性去重：印刷与授予重复时只显示一次', labels(zh, {
  revealed: true, traits: ['Passageway'], traitsZh: ['通道'], grantedTraits: ['Passageway'], grantedTraitsZh: ['通道'],
}), ['通道'])

// 源码级断言：详情帷幕用投影后的 loc.shroud，不得再叠加 shroudMod/fogMod。
check('详情帷幕不再重复计算 shroudMod/fogMod',
  /\(loc\.shroud \?\? 0\) \+ \(loc\.shroudMod/.test(source) || /\(loc\.shroud \?\? 0\) \+ \(st\.fogMod/.test(source), false)
check('详情帷幕读取投影 loc.shroud', source.includes("loc.revealed ? (loc.shroud ?? 0) : t('game.value.unknown')"), true)
check('地图特性徽记带 data-map-info', source.includes("'data-map-info': 'traits'"), true)
check('地图特性徽记聚焦详情特性小节', source.includes("openCardDetailDef({ ...loc, type: 'location' }, { focusInfo: 'traits' })"), true)
check('详情特性小节复用 ah-kw', source.includes("className:'ah-kw','data-trait'"), true)

if (failures.length) {
  console.error('\nFAILED:', failures.join(', '))
  process.exit(1)
}
console.log('\nALL PASS')
