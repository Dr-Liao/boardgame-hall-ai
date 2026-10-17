// 大厅浏览器回归：战术讨论抽屉（公开桌聊 / 私聊 + 本局备忘）。
//
// 与诡镇的浏览器回归一致，使用系统 Edge（channel: msedge），不下载额外浏览器。
// 运行：npm run test:hall:browser
//
// 本文件不配置 webServer：聊天用例需要同时起一个 stub 模型服务与大厅，
// 两者的端口由用例自己挑空闲端口，避免与并行/本地环境冲突。
import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: fileURLToPath(new URL('./browser/', import.meta.url)),
  outputDir: fileURLToPath(new URL('../../.playwright-cli/hall/', import.meta.url)),
  testMatch: '**/*.browser.mjs',
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 90_000,
  use: {
    channel: 'msedge',
    // Two test peers run on one machine; expose loopback ICE candidates so
    // the browser can verify the direct path without external STUN access.
    launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
    viewport: { width: 1400, height: 950 },
  },
})
