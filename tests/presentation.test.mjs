import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { TrackedMeter, SessionStatistics } from '../service/statistics.js';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../ui/presentation.js', import.meta.url), 'utf8'), context);
const { trend, LiveValue } = context.TPSPresentation;
const point = (x, tps, extra = {}) => ({ at: 10000 + x, activeMs: x, tps, breakBefore: false, ...extra });
const rate = (activeMs, raw = 100, extra = {}) => ({ origin: 'http://fixture:3000', sessionId: 's', connection: 'live',
  active: true, phase: 'generating', tokensPerSecond: raw, sessionStats: { activeMs, updatedAt: activeMs + 10000 }, ...extra });
const event = (m, type, at, data = {}) => m.event({ type, data: { sessionID: 's', ...data } }, at);
const chunk = (m, at, id = 'm') => event(m, 'session.text.delta', at, { assistantMessageID: id, delta: 'x'.repeat(100) });

test('trend uses 250ms display buckets without mutating numeric history', () => {
  const source = Object.freeze([Object.freeze(point(0,100)), Object.freeze(point(1000,100))]);
  const result = trend(source);
  assert.deepEqual(Array.from(result, p => p.activeMs), [0,250,500,750,1000]);
  assert.ok(result.every(p => p.value === 100));
  assert.equal(source.length,2);
});
test('EMA dampens a step and stays within the observed envelope', () => {
  const result = trend([point(0,50), point(1000,200)]);
  assert.ok(result.at(-1).value > 50 && result.at(-1).value < 200);
  assert.ok(result.every(p => p.value >= 50 && p.value <= 200));
});
test('short fragment boundary joins are display-only, never add active time', () => {
  const input = [point(0,100), point(1000,100), point(1000,40,{at:12000,breakBefore:true}),point(2000,100,{at:13000})];
  const before = JSON.stringify(input), output = trend(input);
  assert.equal(output.filter(p=>p.join==='hard').length,1);
  assert.equal(output.filter(p=>p.join==='soft').length,1);
  assert.equal(output.at(-1).activeMs,2000);
  assert.equal(JSON.stringify(input),before);
});
test('medium gaps get a dashed join; long tool pauses remain hard breaks with no fill', () => {
  for(const [gap,kind] of [[1200,'soft'],[1500,'dashed'],[2500,'dashed'],[2501,'hard'],[300000,'hard']]){
    const out=trend([point(0,100),point(1000,100),point(1000,80,{at:11000+gap,breakBefore:true}),point(2000,100,{at:12000+gap})]);
    assert.equal(out.find(p=>p.gapMs===gap).join,kind);
    assert.equal(out.at(-1).activeMs,2000);
    assert.ok(out.every(p=>p.value>0));
  }
});
test('unmarked slow intervals are not deleted from the chart', () => {
  const out=trend([point(0,10),point(6000,8)]);
  assert.equal(out.at(-1).activeMs,6000);
  assert.equal(out.filter(p=>p.join==='hard').length,1);
});
test('invalid, backwards and long histories remain bounded', () => {
  assert.equal(trend([null,point(0,NaN),point(0,-1)]).length,0);
  const out=trend([point(0,100),point(86400000,100)]);
  assert.ok(out.length<=4100); assert.equal(out.at(-1).activeMs,86400000);
  const back=trend([point(1000,100),point(1000,50,{at:1,breakBefore:true}),point(500,90)]);
  assert.equal(back.length,2); assert.equal(back.at(-1).join,'hard');
});
test('live value only advances on new measurements, not repeated polls', () => {
  const s = new LiveValue(); assert.equal(s.read(rate(1000),0),100);
  const second=s.read(rate(1250,200),250);
  assert.ok(second>100 && second<200);
  for(let i=0;i<50;i++) assert.equal(s.read(rate(1250,200),300+i),second);
  assert.equal(s.read(rate(1250,200),1501),null);
  assert.equal(s.read(rate(1500,80),1600),80);
});
test('tools, waits, failed transport, authentication and sampling never show a held rate', () => {
  for(const extra of [{phase:'tool',active:false},{phase:'waiting-model',active:false},{waiting:'permission'},
    {connection:'error'},{authRequired:true},{tokensPerSecond:null,phase:'sampling'}]){
    const s=new LiveValue();s.read(rate(1000),0);assert.equal(s.read(rate(1000,100,extra),10),null);
  }
});
test('session switch, reset and clock reversal cannot leak smoothing state', () => {
  const s=new LiveValue();s.read(rate(1000,100),0);s.read(rate(1250,200),250);
  assert.equal(s.read(rate(1500,30,{sessionId:'other'}),500),30);
  assert.equal(s.read(rate(250,20,{sessionId:'other'}),750),20);
  s.reset();assert.equal(s.read(rate(1000,70),0),70);
});
test('time-scaled number EMA is independent of polling frequency', () => {
  const a=new LiveValue(),b=new LiveValue();a.read(rate(1000,0),0);b.read(rate(1000,0),0);
  const one=a.read(rate(2000,100),1000);
  for(let x=1250;x<=2000;x+=250)b.read(rate(x,100),x-1000);
  assert.ok(Math.abs(one-b.value)<1e-10);
});
test('5-minute tool runtime never changes raw statistics, with or without display smoothing', () => {
  const stats=new SessionStatistics(),m=new TrackedMeter('s',stats);
  for(let t=1000;t<=2000;t+=250)chunk(m,t);
  const before=JSON.stringify(stats.serialize());
  event(m,'session.tool.called',2001,{id:'bash'});
  for(let t=2100;t<302000;t+=1000){
    event(m,'session.tool.progress',t,{id:'bash',output:'many logs'});
    trend(stats.history());assert.equal(m.rate(t).tokensPerSecond,null);
  }
  assert.equal(JSON.stringify(stats.serialize()),before);
  event(m,'session.tool.success',302000,{id:'bash'});
  for(let t=303000;t<=304000;t+=250)chunk(m,t,'next');
  assert.equal(stats.summary().activeMs,2000);
  assert.equal(stats.summary().averageTps,100);assert.equal(stats.summary().peakTps,100);
});
test('a genuine 3-second slow-stream interval is retained, not threshold-trimmed', () => {
  const stats=new SessionStatistics(),m=new TrackedMeter('s',stats);
  chunk(m,1000);chunk(m,4000);trend(stats.history());
  assert.equal(stats.summary().activeMs,3000);
  assert.equal(stats.summary().averageTps,25/3);
});
