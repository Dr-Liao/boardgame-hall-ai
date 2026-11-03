import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../../lib/server.js'

test('simultaneous lanes yield to an actionable human after one AI step', async t => {
  const saved = Object.fromEntries(['DSH_HOME','AI_API_KEY','AI_CHAT_ENABLED'].map(key=>[key,process.env[key]]))
  process.env.DSH_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'hall-parallel-yield-'))
  delete process.env.AI_API_KEY
  process.env.AI_CHAT_ENABLED='false'
  t.after(()=>{for(const [key,value] of Object.entries(saved)) {
    if(value===undefined) delete process.env[key]; else process.env[key]=value
  }})
  const mod={id:'parallel-yield',name:'Parallel yield',players:[1,2],seats:2,
    cooperative:true,hideOpponentSettings:true,defaults:{},settingsSpec:[],
    render:{kind:'board',size:3},
    sessionPolicy:()=>({yieldAiToHuman:true}),
    createState:()=>({status:'playing',currentSeat:0,revision:0,aiSteps:0,humanSteps:0}),
    actingSeats:()=>[0,1],decisionSeat:()=>0,
    legalMoves:()=>[{action:'step'}],
    validateMove:()=>null,
    applyMove:(state,seat)=>{if(seat===0) state.humanSteps++;else state.aiSteps++;return []},
    describeState:state=>JSON.stringify(state),
  }
  const server=createServer({mods:[mod],persist:false})
  await server.ready
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{server.online?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const call=async(route,body)=>(await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  })).json()
  const started=await call('start',{modId:mod.id,settings:{playerCount:2}})
  assert.equal(started.ok,true,started.error)
  assert.equal(started.session.state.aiSteps,1)
  const moved=await call('move',{sessionId:started.session.sessionId,seat:0,
    revision:started.session.state.revision,move:{action:'step'}})
  assert.equal(moved.ok,true,moved.error)
  assert.equal(moved.session.state.humanSteps,1)
  assert.equal(moved.session.state.aiSteps,2)
})
