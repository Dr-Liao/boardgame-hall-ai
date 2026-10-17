import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatNotifications } from '../../public/chat-notifications.js'

test('chat unread is per channel, own messages excluded, history does not toast', () => {
  let time=100000
  const saved=new Map(), options={now:()=>time,load:id=>saved.get(id),save:(id,read)=>saved.set(id,{...read})}
  const tracker=createChatNotifications(options), session={sessionId:'one',events:[{seq:0,type:'chat',seat:1,text:'history',ts:time}]}
  assert.equal(tracker.sync(session).total,0)
  session.events.push({seq:1,type:'chat',seat:1,text:'table',ts:time},{seq:2,type:'chat',seat:1,to:1,text:'private',ts:time},{seq:3,type:'chat',seat:0,text:'mine',ts:time})
  let result=tracker.sync(session)
  assert.deepEqual(result.unread,{table:1,'1':1});assert.equal(result.toasts.length,2)
  assert.equal(tracker.sync(session).toasts.length,2,'rerender does not duplicate toasts')
  tracker.dismiss('one',1)
  assert.equal(tracker.sync(session).total,2,'dismissing is not reading')
  result=tracker.sync(session,{open:true,channel:'table'})
  assert.deepEqual(result.unread,{'1':1})
  time+=8000
  result=tracker.sync(session);assert.equal(result.toasts.length,0);assert.equal(result.total,1)
  const restored=createChatNotifications(options)
  result=restored.sync(session);assert.equal(result.total,1);assert.equal(result.toasts.length,0)
  assert.equal(restored.sync(session,{open:true,channel:'1'}).total,0)
})

test('background and stale messages stay unread without toasts; sessions stay isolated',()=>{
  const tracker=createChatNotifications({now:()=>100000}), s={sessionId:'one',events:[]}
  tracker.sync(s)
  s.events.push({seq:1,type:'chat',seat:1,text:'hidden',ts:100000})
  let r=tracker.sync(s,{open:true,visible:false});assert.equal(r.total,1);assert.equal(r.toasts.length,0)
  s.events.push({seq:2,type:'chat',seat:1,text:'stale',ts:1})
  r=tracker.sync(s);assert.equal(r.total,2);assert.equal(r.toasts.length,0)
  s.events.push({seq:3,type:'chat',seat:1,text:'fresh',ts:100000})
  assert.equal(tracker.sync(s).toasts.length,1)
  assert.equal(tracker.sync({sessionId:'two',events:[]}).total,0)
  assert.equal(tracker.sync(s).toasts.length,0)
})
