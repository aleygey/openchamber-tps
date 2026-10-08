"""Offline sandboxed-frame UI checks. Server origin is injected only in this fixture.
The real service/login/stream are separately tested by node --test.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-artifacts'
OUT.mkdir(exist_ok=True)
bridge=(ROOT/'ui/host-bridge.js').read_text()
# srcDoc has no HTTP origin: a test-only replacement, not shipped runtime code.
app=(ROOT/'ui/app.js').read_text().replace('new URL(window.location.href)', 'new URL("http://fixture.test:3000")')
css=(ROOT/'ui/style.css').read_text()
def guest(mode):
 html=(ROOT/f'{mode}/index.html').read_text()
 return html.replace('<link rel="stylesheet" href="../ui/style.css">','<style>'+css+'</style>').replace('<script src="../ui/host-bridge.js"></script>','<script>'+bridge+'</script>').replace('<script src="../ui/app.js"></script>','<script>'+app+'</script>')
HOST='''<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;padding:24px;background:#f5f5f5}iframe{display:block;width:340px;height:64px;border:1px solid #ddd}h1{font-size:16px}</style><h1>TPS · offline sandboxed UI fixture</h1><iframe id="guest" sandbox="allow-scripts"></iframe><script>
const f=document.querySelector('#guest');let state={origin:null,sessionId:null,connection:'auth-required',authRequired:true,authenticated:false,authRetryAfter:0,error:null,eventsSeen:0,charsPerSecond:0,tokensPerSecond:0,charsPerToken:.25,busy:false,active:false};
window.heightRequests=[];window.loginRequests=[];
window.fixtureReset=()=>{state.authRequired=true;state.authenticated=false;state.connection='auth-required';};
window.fixtureGenerate=()=>{state.busy=true;state.active=true;state.tokensPerSecond=65.4;state.charsPerSecond=261.6;state.eventsSeen++;};
const theme={mode:'light',tokens:{background:'#fff',foreground:'#222',muted:'#666',border:'#ddd',elevated:'#f7f7f7',selection:'#eee',primary:'#41846b',font:'system-ui,sans-serif',errorText:'#a22'}};
window.addEventListener('message',e=>{
 if(e.source!==f.contentWindow||e.data?.channel!=='openchamber.sdk'||e.data.v!==1)return;
 const m=e.data,send=data=>e.source.postMessage({channel:'openchamber.sdk',v:1,...data},'*');
 if(m.type==='hello'){send({type:'ready',payload:{session:{id:'session-test',title:'Synthetic test'},locale:'zh-CN',theme}});return;}
 if(m.type==='resize'){heightRequests.push(m.payload.height);f.style.height=m.payload.height+'px';send({type:'result',id:m.id,ok:true});return;}
 if(m.type==='service-request'){
  let status=200,body={ok:true};const p=m.payload;const data=p.body?JSON.parse(p.body):{};
  if(p.path==='/watch'){state.origin=data.origin;state.sessionId=data.sessionId;state.tokensPerSecond=0;}
  if(p.path==='/rate')body=state;
  if(p.path==='/auth/clear'){fixtureReset();}
  if(p.path==='/auth/login'){
   loginRequests.push({length:data.password.length,confirmed:data.allowHttp});
   if(data.password==='fake-test-password'){state.authRequired=false;state.authenticated=true;state.connection='live';body={authenticated:true};}
   else{status=401;body={error:'Wrong password',code:'INVALID_PASSWORD'};}
  }
  send({type:'result',id:m.id,ok:true,payload:{status,body:JSON.stringify(body)}});
 }
});
window.setSession=id=>f.contentWindow.postMessage({channel:'openchamber.sdk',v:1,type:'session',payload:{session:{id,title:id}}},'*');
</script>'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':900,'height':900})
 errors=[]
 page.on('pageerror', lambda e:errors.append(str(e)))
 page.on('console',lambda e:print('CONSOLE',e.type,e.text) if e.type=='error' else None)
 page.set_content(HOST)
 page.eval_on_selector('#guest','(el, html) => el.srcdoc = html',guest('status'))
 frame=page.frame_locator('#guest')
 frame.locator('#auth').wait_for(state='visible',timeout=5000)
 assert frame.locator('#badge').inner_text()=='需要登录'
 page.screenshot(path=str(OUT/'auth-form.png'))
 frame.locator('#password').fill('fake-test-password')
 frame.locator('#login').click()
 page.wait_for_timeout(200)
 print('auth check',frame.locator('#auth-error').inner_text())
 assert '确认' in frame.locator('#auth-error').inner_text()
 assert len(page.evaluate('loginRequests'))==0
 frame.locator('#allow-http').check()
 frame.locator('#login').click()
 frame.locator('#auth').wait_for(state='hidden',timeout=5000)
 assert frame.locator('#password').input_value()==''
 page.evaluate('fixtureGenerate()');page.wait_for_timeout(400)
 assert frame.locator('#value').inner_text()=='≈ 65.4'
 assert frame.locator('#badge').inner_text()=='生成中'
 assert page.evaluate('heightRequests.at(-1)')==64
 page.screenshot(path=str(OUT/'compact-live.png'))
 page.evaluate("setSession('other-session')");page.wait_for_timeout(400)
 assert frame.locator('#auth').is_hidden()
 assert frame.locator('#value').inner_text()=='≈ 0.0'
 page.eval_on_selector('#guest', '(el, html)=>{el.style.height="700px";el.style.width="480px";el.srcdoc=html}', guest('panel'))
 frame=page.frame_locator('#guest')
 frame.locator('#details dt').first.wait_for(timeout=5000)
 frame.locator('#forget').click();frame.locator('#auth').wait_for(state='visible',timeout=5000)
 frame.locator('#password').fill('wrong-password')
 frame.locator('#allow-http').check();frame.locator('#login').click()
 page.wait_for_timeout(400)
 assert '密码不正确' in frame.locator('#auth-error').inner_text()
 assert frame.locator('#password').input_value()==''
 frame.locator('#password').fill('fake-test-password');frame.locator('#password').press('Enter')
 frame.locator('#auth').wait_for(state='hidden',timeout=5000)
 page.evaluate('fixtureGenerate()');page.wait_for_timeout(350)
 page.screenshot(path=str(OUT/'panel-live.png'))
 assert not errors, errors
 browser.close()
 print('PASS: offline sandboxed iframe; compact/form/HTTP consent/login/64px/session-switch/full-panel/logout/wrong-password/relogin. Zero uncaught JS errors. Origin and host responses are mock fixtures.')
