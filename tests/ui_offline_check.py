"""Offline sandbox integration check, synthetic host/events only; not a real OpenChamber install."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'test-artifacts'
OUT.mkdir(exist_ok=True)
def guest(mode):
    html = (ROOT/f'{mode}/index.html').read_text()
    html = html.replace('<link rel="stylesheet" href="../ui/style.css">', '<style>'+(ROOT/'ui/style.css').read_text()+'</style>')
    for name in ['host-bridge','presentation','chart','app']:
        script=(ROOT/f'ui/{name}.js').read_text()
        if name=='app':
            # No usable HTTP origin in srcdoc: fixture injection never ships in runtime.
            script=script.replace('new URL(window.location.href)', 'new URL("http://fixture.test:3000")')
        html=html.replace(f'<script src="../ui/{name}.js"></script>', '<script>'+script+'</script>')
    return html
HOST='''<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;padding:32px;background:#f5f5f5}iframe{display:block;width:340px;height:112px;border:1px solid #ddd;border-radius:8px}h1{font-size:14px;font-weight:500;color:#555}</style><h1>TPS · synthetic browser fixture</h1><iframe id="guest" sandbox="allow-scripts"></iframe><script>
const f=document.querySelector('#guest');
const emptyStats=()=>({averageTps:null,peakTps:null,activeMs:0,observations:0,pointCount:0,revision:0,updatedAt:null});
let state={origin:null,sessionId:null,connection:'auth-required',authRequired:true,authenticated:false,authRetryAfter:0,error:null,eventsSeen:0,charsPerSecond:null,tokensPerSecond:null,charsPerToken:.25,busy:false,active:false,phase:'idle',sessionStats:emptyStats()};
let history=[], auto=false;
window.heightRequests=[];window.loginRequests=[];window.historyRequests=[];window.resetRequests=[];
const theme={mode:'light',tokens:{background:'#fff',foreground:'#222',muted:'#77818b',border:'#e4e8ec',elevated:'#f7f7f7',selection:'#eee',primary:'#50846c',font:'system-ui,sans-serif',errorText:'#a22'}};
window.fixtureReset=()=>{auto=false;state.authRequired=true;state.authenticated=false;state.connection='auth-required';};
window.fixtureGenerate=()=>{auto=true;state.busy=true;state.active=true;state.phase='generating';state.tokensPerSecond=132.4;state.charsPerSecond=529.6;state.sessionStats={averageTps:131.9,peakTps:214.4,activeMs:60000,updatedAt:Date.now(),observations:900,pointCount:90,revision:1};
history=[];let wall=Date.now()-70000;
for(let i=0;i<=60;i++){if(i===20||i===40)wall+=700;history.push({at:wall+i*1000,activeMs:i*1000,tps:130+15*Math.sin(i/5)+8*Math.sin(i*2),breakBefore:i===0||i===20||i===40});}};
window.fixtureTool=()=>{auto=false;state.active=false;state.phase='tool';state.tokensPerSecond=null;state.charsPerSecond=null;state.lastTurn={source:'estimate',tokensPerSecond:null};};
window.fixtureQuiet=()=>{auto=false;};
window.fixtureStatus=()=>JSON.stringify(state.sessionStats);
window.fixtureTheme=mode=>{theme.mode=mode;if(mode==='dark')Object.assign(theme.tokens,{background:'#151b22',foreground:'#e2e8ef',muted:'#91a1b1',border:'#2b3947',elevated:'#1c2530'});send({type:'ready',payload:{session:{id:state.sessionId,title:'Synthetic'},locale:'zh-CN',theme}});};
const send=data=>f.contentWindow.postMessage({channel:'openchamber.sdk',v:1,...data},'*');
window.addEventListener('message',e=>{
 if(e.source!==f.contentWindow||e.data?.channel!=='openchamber.sdk'||e.data.v!==1)return;
 const m=e.data;
 if(m.type==='hello'){send({type:'ready',payload:{session:{id:'session-test',title:'Synthetic test'},locale:'zh-CN',theme}});return;}
 if(m.type==='resize'){heightRequests.push(m.payload.height);f.style.height=m.payload.height+'px';send({type:'result',id:m.id,ok:true});return;}
 if(m.type==='service-request'){
  let status=200,body={ok:true};const p=m.payload,data=p.body?JSON.parse(p.body):{};
  if(p.path==='/watch'){state.origin=data.origin;if(state.sessionId!==data.sessionId){state.sessionId=data.sessionId;auto=false;state.active=false;state.phase='idle';state.tokensPerSecond=null;state.sessionStats=emptyStats();history=[];}}
  if(p.path==='/rate'){if(auto){state.sessionStats.updatedAt=Date.now();state.sessionStats.activeMs+=250;state.sessionStats.revision++;}body=state;}
  if(p.path==='/history'){historyRequests.push(p.query);const windowMs=Number(p.query?.windowMs||0);body={origin:state.origin,sessionId:state.sessionId,points:history.filter(p=>!windowMs||p.activeMs>=state.sessionStats.activeMs-windowMs-2000)};}
  if(p.path==='/stats/reset'){resetRequests.push(data);auto=false;state.active=false;state.phase='sampling';state.tokensPerSecond=null;state.sessionStats=emptyStats();history=[];}
  if(p.path==='/auth/clear')fixtureReset();
  if(p.path==='/auth/login'){loginRequests.push({length:data.password.length,confirmed:data.allowHttp});if(data.password==='fake-test-password'){state.authRequired=false;state.authenticated=true;state.connection='live';body={authenticated:true};}else{status=401;body={error:'Wrong password',code:'INVALID_PASSWORD'};}}
  send({type:'result',id:m.id,ok:true,payload:{status,body:JSON.stringify(body)}});
 }
});
window.setSession=id=>send({type:'session',payload:{session:{id,title:id}}});
</script>'''
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':900,'height':1000})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(HOST)
    page.eval_on_selector('#guest','(el,html)=>el.srcdoc=html',guest('status'))
    frame=page.frame_locator('#guest')
    frame.locator('#auth').wait_for(state='visible')
    assert frame.locator('#badge').get_attribute('title')=='需要登录'
    frame.locator('#password').fill('fake-test-password');frame.locator('#login').click()
    page.wait_for_timeout(150)
    assert '确认' in frame.locator('#auth-error').inner_text()
    assert len(page.evaluate('loginRequests'))==0
    frame.locator('#allow-http').check();frame.locator('#login').click()
    frame.locator('#auth').wait_for(state='hidden')
    assert frame.locator('#password').input_value()==''
    page.evaluate('fixtureGenerate()');page.wait_for_timeout(1100)
    assert frame.locator('#value').inner_text()=='≈ 132'
    assert frame.locator('#badge').get_attribute('title')=='生成中'
    assert frame.locator('#extra').is_hidden()
    assert frame.locator('.chart-label').count()==0
    assert frame.locator('#root').inner_text().strip().splitlines()==['≈ 132','tok/s','⋯']
    assert 'C' in frame.locator('.chart-line').get_attribute('d')
    assert frame.locator('.chart-line').get_attribute('d').count('M')==1
    for width in [260,340,480]:
        page.eval_on_selector('#guest','(el,w)=>el.style.width=w+"px"',width);page.wait_for_timeout(100)
        assert frame.locator('body').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
        assert 90<=page.evaluate('heightRequests.at(-1)')<=125
    page.eval_on_selector('#guest','el=>el.style.width="340px"');page.wait_for_timeout(100)
    page.locator('#guest').screenshot(path=str(OUT/'compact-live.png'))
    frame.locator('#chart').hover();assert frame.locator('#chart-tooltip').is_visible()
    assert '平滑' in frame.locator('#chart-tooltip').inner_text()
    frame.locator('#chart-toggle').click()
    assert frame.locator('#extra').is_visible()
    assert frame.locator('#average-value').inner_text()=='≈ 131.9'
    assert frame.locator('#peak-value').inner_text()=='≈ 214.4'
    frame.locator('#chart-window').select_option('0');page.wait_for_timeout(350)
    assert page.evaluate('historyRequests.at(-1).windowMs')=='0'
    assert page.evaluate('heightRequests.at(-1)')<=320
    page.locator('#guest').screenshot(path=str(OUT/'compact-details.png'))
    page.evaluate('fixtureTool()');page.wait_for_timeout(300)
    before=page.evaluate('fixtureStatus()');d=frame.locator('.chart-line').get_attribute('d')
    assert frame.locator('#value').inner_text()=='—'
    assert frame.locator('#badge').get_attribute('title')=='执行工具'
    page.wait_for_timeout(1500)
    assert page.evaluate('fixtureStatus()')==before
    assert frame.locator('.chart-line').get_attribute('d')==d
    assert frame.locator('#average-value').inner_text()=='≈ 131.9'
    frame.locator('#chart-toggle').click()
    page.locator('#guest').screenshot(path=str(OUT/'compact-tool.png'))
    page.evaluate('fixtureGenerate()');page.wait_for_timeout(400)
    assert frame.locator('#value').inner_text()=='≈ 132'
    page.evaluate('fixtureQuiet()');page.wait_for_timeout(1700)
    assert frame.locator('#value').inner_text()=='—'  # stale polls must not pretend new generation
    page.evaluate('fixtureGenerate()');page.wait_for_timeout(300)
    assert frame.locator('#value').inner_text()=='≈ 132'
    page.evaluate("fixtureTheme('dark')");page.wait_for_timeout(300)
    page.locator('#guest').screenshot(path=str(OUT/'compact-dark.png'))
    assert frame.locator('#extra').is_hidden()
    page.evaluate("setSession('other-session')");page.wait_for_timeout(400)
    assert frame.locator('#value').inner_text()=='—'
    assert frame.locator('.chart-line').count()==0
    frame.locator('#chart-toggle').click();frame.locator('#forget').click()
    frame.locator('#auth').wait_for(state='visible')
    frame.locator('#password').fill('wrong-password');frame.locator('#login').click();page.wait_for_timeout(300)
    assert '密码不正确' in frame.locator('#auth-error').inner_text()
    frame.locator('#password').fill('fake-test-password');frame.locator('#password').press('Enter')
    frame.locator('#auth').wait_for(state='hidden')
    page.evaluate('fixtureGenerate()');page.wait_for_timeout(350)
    if frame.locator('#extra').is_hidden():frame.locator('#chart-toggle').click()
    frame.locator('#reset-stats').click();assert len(page.evaluate('resetRequests'))==0
    frame.locator('#reset-stats').click();page.wait_for_timeout(400)
    assert len(page.evaluate('resetRequests'))==1
    assert frame.locator('#average-value').inner_text()=='—'
    page.eval_on_selector('#guest','(el,html)=>{el.style.width="520px";el.style.height="800px";el.srcdoc=html}',guest('panel'))
    frame=page.frame_locator('#guest');frame.locator('#extra').wait_for(state='visible')
    page.evaluate('fixtureGenerate()');page.wait_for_timeout(1100)
    assert frame.locator('#details dt').count()==6
    assert frame.locator('.chart-label').count()==5
    page.locator('#guest').screenshot(path=str(OUT/'panel-live.png'))
    page.evaluate('fixtureTool()');page.wait_for_timeout(350)
    assert frame.locator('#value').inner_text()=='—'
    assert frame.locator('#details dt').count()==6
    assert not errors, errors
    print('PASS: sandbox allow-scripts; HTTP consent, password and Enter login; no credential persistence.')
    print('PASS: 260/340/480px minimal readout + sparkline, 90-125px default height, details, range, hover, light/dark.')
    print('PASS: tools freeze chart and statistics; stale polls blank the rate; session switch, resume and reset.')
    print('PASS: full panel; no uncaught JavaScript errors. Synthetic fixture, not a real OpenChamber installation.')
    browser.close()
