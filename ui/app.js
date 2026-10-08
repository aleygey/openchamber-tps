(() => {
  'use strict';
  const host = window.TPSHost.connectHost();
  const $ = id => document.getElementById(id);
  const compact = document.body.dataset.mode === 'status';
  const en = {
    connecting: 'connecting', live: 'idle', generating: 'generating', error: 'disconnected',
    auth: 'sign-in required', idle: 'no connection', permission: 'waiting for permission', question: 'waiting for answer',
    login: 'Sign in', signing: 'Signing in…', password: 'OpenChamber UI password',
    server: 'Sign in to: ', http: 'I trust this server address. HTTP is not encrypted; use HTTPS or an approved tunnel on untrusted networks.',
    hint: 'Password is used only for login, not saved. The session stays in service memory.',
    authNeeded: 'Enter your OpenChamber UI password below. Do not disable server authentication.',
    noOrigin: 'This embedded/relay view has no usable server origin. Use a direct connection.',
    service: 'Approve Run a local service in Settings → Extensions.', disabled: 'The extension is paused in Settings → Extensions.',
    retry: 'Retry', forget: 'Forget TPS login', avg: 'Last turn average', chars: 'Characters/s',
    ratio: 'Estimated tokens/character', total: 'Session generated tokens', events: 'Events seen', state: 'Connection',
    none: '—', estimate: 'Live TPS is a rolling 5-second character-based estimate, including reasoning. Token counts settle at step end.',
    verifyHttp: 'Confirm the HTTP server address first.', wrong: 'Password rejected. Please check the server UI password.',
    limited: 'Too many login attempts. Try again in ', seconds: ' seconds.', failed: 'Login failed. ',
  };
  const zh = {
    ...en, connecting: '连接中', live: '空闲', generating: '生成中', error: '未连接',
    auth: '需要登录', idle: '未连接', permission: '等待授权', question: '等待回答',
    login: '登录', signing: '登录中…', password: 'OpenChamber 访问密码', server: '登录到：',
    http: '我确认这是自己的服务器。HTTP 不加密；非可信网络应使用 HTTPS 或经批准的隧道。',
    hint: '密码只用于本次登录，不保存；登录会话仅存于扩展服务内存。',
    authNeeded: '在下方输入 OpenChamber 访问密码，无需关闭服务器认证。',
    noOrigin: '此中继/嵌入页面无法确定服务器地址，请使用直接连接。',
    service: '请在 设置 → 扩展 中批准“运行本地服务”。', disabled: '扩展已在设置中暂停。',
    retry: '重试', forget: '清除 TPS 登录', avg: '上一轮平均速率', chars: '每秒字符数',
    ratio: '估算 Token/字符', total: '会话生成 Token', events: '收到的事件', state: '连接状态',
    estimate: '实时 TPS 是最近 5 秒的字符估算，包含推理文本；实际 Token 数在每个步骤结束时结算。',
    verifyHttp: '请先确认上面的 HTTP 服务器地址。', wrong: '密码不正确，请检查 OpenChamber 的访问密码。',
    limited: '登录尝试过多，请等待 ', seconds: ' 秒后再试。', failed: '登录失败：',
  };
  let copy = en;
  let origin = null;
  let sessionId = null;
  let sessionTitle = '';
  let configuredKey = '';
  let configuring = null;
  let polling = false;
  let timer = null;
  let disposed = false;
  let started = false;
  let loggingIn = false;
  let rate = null;
  let peak = 0;
  let height = 0;
  let transient = '';
  const key = () => `${origin}|${sessionId ?? ''}`;
  const resolveOrigin = () => {
    try { const u = new URL(window.location.href); return ['http:', 'https:'].includes(u.protocol) ? u.origin : null; }
    catch { return null; }
  };
  function describe(error) {
    if (error?.code === 'NO_SERVICE' || error?.code === 'SERVICE_FAILED') return copy.service;
    if (error?.code === 'DISABLED') return copy.disabled;
    return error?.message || copy.error;
  }
  async function request(method, path, body) {
    const result = await host.serviceRequest({ method, path, ...(body ? { body: JSON.stringify(body) } : {}) });
    let data;
    try { data = JSON.parse(result.body); } catch { throw new Error('Invalid TPS service JSON.'); }
    if (result.status >= 400) throw Object.assign(new Error(data.error || `HTTP ${result.status}`), data, { status: result.status });
    return data;
  }
  function resize() {
    if (!compact) return;
    const next = Math.max(64, Math.min(320, Math.ceil($('root').getBoundingClientRect().height + 12)));
    if (next === height) return;
    height = next; void host.setHeight(next).catch(() => {});
  }
  function draw() {
    const live = rate?.connection === 'live';
    const tps = live && Number.isFinite(rate.tokensPerSecond) ? Math.max(0, rate.tokensPerSecond) : 0;
    peak = Math.max(tps, peak * 0.99);
    $('value').textContent = live ? `≈ ${tps.toFixed(1)}` : '—';
    $('fill').style.transform = `scaleX(${peak > .05 && live ? Math.min(1, tps / peak) : 0})`;
    let label = rate ? (copy[rate.connection] || copy.error) : copy.connecting;
    if (rate?.authRequired) label = copy.auth;
    else if (live) label = rate.waiting ? copy[rate.waiting] : rate.active && rate.busy ? copy.generating : copy.live;
    $('badge').textContent = label;
    $('notice').textContent = transient || (rate?.authRequired ? copy.authNeeded : rate?.error || '');
    const needsLogin = Boolean(rate?.authRequired);
    $('auth').hidden = !needsLogin;
    $('server').textContent = copy.server + (origin || '—');
    $('http-confirm').hidden = !origin?.startsWith('http:');
    $('login').disabled = loggingIn || (rate?.authRetryAfter > 0);
    $('login').textContent = loggingIn ? copy.signing : copy.login;
    if (rate?.authRetryAfter > 0) $('auth-error').textContent = copy.limited + rate.authRetryAfter + copy.seconds;
    if (!compact) {
      $('session').textContent = sessionTitle || sessionId || '';
      const avg = rate?.lastTurn;
      const rows = [
        [copy.avg, avg ? `${avg.source === 'estimate' ? '≈ ' : ''}${avg.tokensPerSecond.toFixed(1)} tok/s` : '—'],
        [copy.chars, rate ? rate.charsPerSecond.toFixed(1) : '—'],
        [copy.ratio, rate ? rate.charsPerToken.toFixed(3) : '—'],
        [copy.total, rate?.sessionUsage?.generated?.toLocaleString() ?? '—'],
        [copy.events, String(rate?.eventsSeen ?? 0)], [copy.state, label],
      ];
      $('details').replaceChildren();
      for (const [title, value] of rows) {
        const dt = document.createElement('dt'); dt.textContent = title;
        const dd = document.createElement('dd'); dd.textContent = value;
        $('details').append(dt, dd);
      }
    }
    resize();
  }
  function configure() {
    if (configuring) return configuring;
    configuring = (async () => {
      while (origin && configuredKey !== key() && !disposed) {
        const currentKey = key();
        await request('POST', '/watch', { origin, sessionId });
        configuredKey = currentKey;
      }
    })().finally(() => { configuring = null; });
    return configuring;
  }
  async function poll() {
    if (disposed || polling) return;
    if (!origin) { transient = copy.noOrigin; draw(); return; }
    polling = true;
    try {
      await configure();
      const expected = key();
      const result = await request('GET', '/rate');
      if (expected !== key() || result.origin !== origin || result.sessionId !== sessionId) return;
      rate = result; transient = ''; draw();
    } catch (error) { transient = describe(error); draw(); }
    finally { polling = false; }
  }
  async function loop() {
    await poll();
    if (!disposed) timer = setTimeout(loop, document.hidden ? 1000 : 250);
  }
  function applyTheme(context) {
    const theme = context.theme;
    if (!theme?.tokens) return;
    document.documentElement.style.colorScheme = theme.mode;
    const tokens = { bg: 'background', fg: 'foreground', muted: 'muted', border: 'border', elevated: 'elevated', selection: 'selection', primary: 'primary', font: 'font', 'error-text': 'errorText' };
    for (const [name, field] of Object.entries(tokens)) {
      if (typeof theme.tokens[field] === 'string') document.documentElement.style.setProperty(`--oc-${name}`, theme.tokens[field]);
    }
  }
  function language(context) {
    copy = String(context.locale || navigator.language).toLowerCase().startsWith('zh') ? zh : en;
    document.documentElement.lang = copy === zh ? 'zh-CN' : 'en';
    $('password').placeholder = copy.password; $('password').setAttribute('aria-label', copy.password);
    $('http-text').textContent = copy.http; $('auth-hint').textContent = copy.hint;
    $('estimate-hint').textContent = copy.estimate;
    $('retry').textContent = copy.retry; $('forget').textContent = copy.forget;
  }
  // Guest frames intentionally have no allow-forms permission. All login
  // traffic uses serviceRequest, never browser form submission.
  async function submitLogin() {
    if (loggingIn || !origin) return;
    if (origin.startsWith('http:') && !$('allow-http').checked) { $('auth-error').textContent = copy.verifyHttp; resize(); return; }
    const password = $('password').value;
    if (!password) return;
    $('password').value = ''; // never persist in DOM/storage after submission
    loggingIn = true; $('auth-error').textContent = ''; draw();
    const submittedOrigin = origin;
    try {
      await configure();
      if (origin !== submittedOrigin) throw new Error('The active server changed.');
      await request('POST', '/auth/login', { origin, password, allowHttp: $('allow-http').checked });
      rate = null; transient = ''; draw();
      await poll();
    } catch (error) {
      if (origin !== submittedOrigin) return;
      $('auth-error').textContent = error.code === 'INVALID_PASSWORD' ? copy.wrong
        : error.code === 'LOGIN_RATE_LIMITED' ? copy.limited + (error.retryAfter || 60) + copy.seconds
        : copy.failed + describe(error);
    } finally { loggingIn = false; draw(); }
  }
  $('login').addEventListener('click', () => { void submitLogin(); });
  $('password').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void submitLogin(); }
  });
  $('retry').addEventListener('click', async () => {
    try { await configure(); await request('POST', '/retry', {}); await poll(); }
    catch (error) { transient = describe(error); draw(); }
  });
  $('forget').addEventListener('click', async () => {
    try { await request('POST', '/auth/clear', {}); $('password').value = ''; await poll(); }
    catch (error) { transient = describe(error); draw(); }
  });
  host.onReady(context => {
    applyTheme(context); language(context);
    const nextOrigin = resolveOrigin();
    if (origin !== nextOrigin) {
      origin = nextOrigin; configuredKey = ''; rate = null;
      $('password').value = ''; $('allow-http').checked = false; $('auth-error').textContent = '';
    }
    sessionId = context.session?.id ?? null;
    sessionTitle = context.session?.title ?? '';
    draw();
    if (!started) { started = true; void loop(); }
  });
  host.onSession(session => {
    const next = session?.id ?? null;
    if (sessionId !== next) { sessionId = next; rate = null; peak = 0; }
    sessionTitle = session?.title ?? '';
    if (started) void poll();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe($('root'));
  window.addEventListener('pagehide', () => {
    disposed = true; clearTimeout(timer); $('password').value = ''; host.dispose();
  }, { once: true });
})();
