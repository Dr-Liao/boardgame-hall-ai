import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
const BASE='http://127.0.0.1:8799'
const MOD='G:\\boardgame-hall-ai\\games\\arkhamhorror'
const gitShow=f=>execSync(`git show HEAD:web/${f}`,{cwd:MOD,encoding:'utf8',maxBuffer:64*1024*1024})
const HEAD={'game-ui.js':gitShow('game-ui.js'),'player-dashboard.css':gitShow('player-dashboard.css')}
const AVATAR="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23151515'/><ellipse cx='40' cy='40' rx='29' ry='33' fill='%23e9e9e6'/></svg>"
const browser=await chromium.launch({channel:'msedge'})
async function head(w,h){
 const page=await browser.newPage({viewport:{width:w,height:h},deviceScaleFactor:1})
 await page.route('**/mods/arkhamhorror/game-ui.js',r=>r.fulfill({status:200,contentType:'application/javascript; charset=utf-8',body:HEAD['game-ui.js']}))
 await page.route('**/mods/arkhamhorror/player-dashboard.css',r=>r.fulfill({status:200,contentType:'text/css; charset=utf-8',body:HEAD['player-dashboard.css']}))
 let session
 await page.route('**/api/start',async route=>{const response=await route.fetch({postData:JSON.stringify({modId:'arkhamhorror',settings:{legacyAutoStart:true,playerCount:1,playerInvestigator:'05004',campaignId:'thePathToCarcosa',seed:'hw'+w}})});const body=await response.json();session=body.session;if(session.players?.[0]){session.players[0].name='DrLiao';session.players[0].avatar=AVATAR};await route.fulfill({response,json:body})})
 await page.route('**/api/session?*',route=>route.fulfill({json:{ok:true,session}}))
 await page.goto(BASE+'/index.html');store=0
 await page.locator('.bg-card').filter({hasText:'vnb'}).click().catch(()=>{})
 // fallback for locale: use class-based click
 const card=page.locator('.bg-card').filter({hasText:'arkham'})
 await page.close()
 return null
}
// simpler: reuse localization-independent selectors by data attribute? inspect cards short
const page=await browser.newPage({viewport:{width:1000,height:900}})
let session
await page.route('**/mods/arkhamhorror/game-ui.js',r=>r.fulfill({status:200,contentType:'application/javascript; charset=utf-8',body:HEAD['game-ui.js']}))
await page.route('**/mods/arkhamhorror/player-dashboard.css',r=>r.fulfill({status:200,contentType:'text/css; charset=utf-8',body:HEAD['player-dashboard.css']}))
await page.route('**/api/start',async route=>{const response=await route.fetch({postData:JSON.stringify({modId:'arkhamhorror',settings:{legacyAutoStart:true,playerCount:1,playerInvestigator:'05004',campaignId:'thePathToCarcosa',seed:'hw1000'}})});const body=await response.json();session=body.session;if(session.players?.[0]){session.players[0].name='DrLiao';session.players[0].avatar=AVATAR};await route.fulfill({response,json:body})})
await page.route('**/api/session?*',route=>route.fulfill({json:{ok:true,session}}))
await page.goto(BASE+'/index.html')
await page.locator('.bg-card').filter({hasText:/诡镇奇谈/}).click()
await page.getByRole('button',{name:'开始新游戏'}).click()
await page.waitForSelector('.ah-table',{timeout:90000})
for(let i=0;i<40;i++){if(!(await page.locator('.ah-cinematic').count()))break;const skip=page.getByRole('button',{name:'跳过演出'});if(await skip.count())await skip.first().evaluate(el=>el.click()).catch(()=>{});await page.waitForTimeout(200)}
await page.waitForTimeout(1500)
for (const [w,h] of [[1000,900],[1598,800]]) {
  await page.setViewportSize({width:w,height:h}); await page.waitForTimeout(300)
  const m=await page.evaluate(()=>{const R=el=>{if(!el)return null;const r=el.getBoundingClientRect();return{x:+r.x.toFixed(2),y:+r.y.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2),right:+(r.right).toFixed(2),bottom:+(r.bottom).toFixed(2)}};const q=s=>document.querySelector(s);const row=q('.ah-dock-name-row');const gear=q('.ah-dock-investigator .ah-reaction-mode');const inv=q('.ah-dock-investigator');const p=q('.ah-dock-portrait');return{inv:R(inv),row:R(row),gear:R(gear),portrait:R(p),portraitDisplay:p?getComputedStyle(p).display:null,rowMarginRight:row?getComputedStyle(row).marginRight:null,rowPaddingRight:row?getComputedStyle(row).paddingRight:null}})
  console.log('HEAD@'+w, JSON.stringify(m))
}
await browser.close()
