import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fixture, service, event, delay, waitFor } from './helpers.mjs';
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../ui/presentation.js',import.meta.url),'utf8'),ctx);

test('authenticated HTTP/SSE keeps tools out of metrics and display; history remains numeric-only', async t=>{
  const upstream=await fixture(t),srv=await service(t);
  assert.equal((await srv.call('GET','/health',undefined,false)).status,401);
  assert.equal((await srv.call('GET','/health')).data.version,'1.3.0');
  await srv.call('POST','/watch',{origin:upstream.origin,sessionId:'s'});
  await waitFor(async()=> (await srv.rate()).authRequired);
  assert.equal((await srv.call('POST','/auth/login',{origin:upstream.origin,password:upstream.password,allowHttp:true})).status,200);
  await waitFor(async()=> (await srv.rate()).connection==='live');
  const delta=id=>upstream.send(event('session.text.delta',{sessionID:'s',assistantMessageID:id,ordinal:0,delta:'x'.repeat(100)}));
  delta('m');await delay(300);delta('m');await delay(300);delta('m');
  let r=await waitFor(async()=>{const r=await srv.rate();return r.sessionStats?.activeMs>500&&r;});
  const live=new ctx.TPSPresentation.LiveValue();
  assert.ok(live.read(r,0)>0);
  const initial=r.sessionStats;
  upstream.send(event('session.tool.called',{sessionID:'s',id:'bash'}));
  r=await waitFor(async()=>{const r=await srv.rate();return r.phase==='tool'&&r;});
  assert.equal(live.read(r,10),null);
  const h=await srv.call('GET','/history?sessionId=s');
  const trend=ctx.TPSPresentation.trend(h.data.points);
  assert.ok(trend.length>0);
  for(let i=0;i<3;i++){
    upstream.send(event('session.tool.progress',{sessionID:'s',id:'bash',output:'not LLM output'.repeat(1000)}));await delay(80);
    assert.deepEqual((await srv.rate()).sessionStats,initial);
  }
  assert.equal((await srv.call('GET','/history?sessionId=s',undefined,false)).status,401);
  await srv.stop();
  const names=fs.readdirSync(srv.directory).filter(n=>n.endsWith('.json'));assert.equal(names.length,1);
  const raw=fs.readFileSync(path.join(srv.directory,names[0]),'utf8');
  assert.equal(JSON.parse(raw).schema,2);
  assert.ok(!raw.includes(upstream.password)&&!raw.includes(upstream.secret)&&!raw.includes('not LLM'));
});

test('a loaded metrics-v2 record is unchanged by all display transforms',()=>{
  // Mirrors the current schema: copying/rendering is never a persistence migration.
  const saved={schema:2,activeMs:2000,generatedTokens:200,peak:100,peakSamples:8,observations:8,since:1000,updatedAt:304000,
    droppedPoints:0,revision:8,points:[{at:1000,activeMs:0,tps:100,breakBefore:true},{at:2000,activeMs:1000,tps:100,breakBefore:false},
    {at:303000,activeMs:1000,tps:100,breakBefore:true},{at:304000,activeMs:2000,tps:100,breakBefore:false}]};
  const before=JSON.stringify(saved);
  for(let i=0;i<30;i++)ctx.TPSPresentation.trend(saved.points);
  assert.equal(JSON.stringify(saved),before);
});
