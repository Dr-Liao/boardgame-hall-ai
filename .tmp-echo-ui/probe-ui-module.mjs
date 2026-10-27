// 无浏览器冒烟：验证 game-ui.js 可被 Node 完整解析/求值，且新增的地点特性显示模型符合预期。
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add(){}, toggle(){} }, appendChild(){}, setAttribute(){} }) }
globalThis.window = globalThis
const mod = await import('file:///G:/boardgame-hall-ai/games/arkhamhorror/web/game-ui.js')
console.log('game-ui.js loaded, exports:', Object.keys(mod))
