// 浏览器回归的前置检查：本仓库的浏览器用例复用系统 Edge（playwright.config.mjs 里 channel: 'msedge'），
// 不下载 Playwright 内核，所以别提示 npx playwright install。
// 这里真启动一次再关掉，让「通道不存在 / 被策略禁用」在跑用例之前就暴露，而不是等 webServer 起来才炸。
const CHANNEL = 'msedge' // 与 tests/hall/playwright.config.mjs、games/arkhamhorror/playwright.config.mjs 保持一致

let chromium
try {
  ({ chromium } = await import('@playwright/test'))
} catch {
  console.error('✖ 未安装 @playwright/test，浏览器回归无法运行。\n  先执行： npm install')
  process.exit(1)
}

try {
  const browser = await chromium.launch({ channel: CHANNEL })
  await browser.close()
} catch (error) {
  console.error([
    `✖ 浏览器回归无法启动：系统 Edge 通道不可用（channel: ${CHANNEL}）。`,
    '  本仓库的浏览器用例复用系统 Edge，不需要 npx playwright install。',
    '  请安装 Microsoft Edge；或在 playwright.config.mjs 里把 use.channel 改成已安装的通道。',
    `  原始错误：${String(error?.message || error).split('\n')[0]}`,
  ].join('\n'))
  process.exit(1)
}
