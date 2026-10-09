(() => {
  'use strict';
  const host = window.TPSHost.connectHost();
  const $ = id => document.getElementById(id);
  const compact = document.body.dataset.mode === 'status';
  const en = {
    average: 'Average', peak: 'Peak', chart: 'Activity chart', axis: 'Cumulative generation time',
    active: 'Generated ', empty: 'Waiting for streamed output', recent60: 'Last 60s', recent300: 'Last 5m', all: 'Retained history',
    historyNote: 'Display smoothing only; pause ticks omit waiting time', reset: 'Reset statistics', confirmReset: 'Confirm reset',
    persistenceWarning: 'Statistics could not be saved/loaded; current readings still work.',
    averageHint: 'Timed token estimates / matching duration; unsmoothed, tool runtime excluded.',
    peakHint: 'Highest unsmoothed 0.25–5s generation-window estimate.',
    connecting: 'connecting', live: 'idle', generating: 'generating', tool: 'running tool', sampling: 'sampling', 'waiting-model': 'waiting for model', 'waiting-output': 'waiting for output', error: 'disconnected',
    auth: 'sign-in required', idle: 'no connection', permission: 'waiting for permission', question: 'waiting for answer',
    login: 'Sign in', signing: 'Signing in…', password: 'OpenChamber UI password',
    server: 'Sign in to: ', http: 'I trust this server address. HTTP is not encrypted; use HTTPS or an approved tunnel on untrusted networks.',
    hint: 'Password is used only for login, not saved. The session stays in service memory.',
    authNeeded: 'Enter your OpenChamber UI password below. Do not disable server authentication.',
    noOrigin: 'This embedded/relay view has no usable server origin. Use a direct connection.',
    service: 'Approve Run a local service in Settings → Extensions.', disabled: 'The extension is paused in Settings → Extensions.',
    retry: 'Retry', forget: 'Forget TPS login', avg: 'Last turn average', chars: 'Characters/s',
    ratio: 'Estimated tokens/character', total: 'Session generated tokens', events: 'Events seen', state: 'Connection',
    none: '—', estimate: 'Displayed rate and chart are smoothed estimates. Average and peak use unsmoothed timed generation. Tool runtime is excluded.',
    verifyHttp: 'Confirm the HTTP server address first.', wrong: 'Password rejected. Please check the server UI password.',
    limited: 'Too many login attempts. Try again in ', seconds: ' seconds.', failed: 'Login failed. ',
  };
  const zh = {
    ...en, average: '平均', peak: '峰值', chart: '活跃曲线', axis: '累计生成时间',
    active: '生成 ', empty: '等待生成输出', recent60: '近60秒', recent300: '近5分钟', all: '全部保留',
    historyNote: '仅显示平滑；短竖线标记省略的等待', reset: '重置本会话统计', confirmReset: '确认重置',
    persistenceWarning: '统计存储读写失败；当前数值仍可使用。',
    averageHint: '原始计时 Token 估算量 ÷ 生成时长；不含工具运行和首字等待，不使用平滑值。',
    peakHint: '原始0.25至5秒生成窗口的最高估算值，不使用平滑值。',
    connecting: '连接中', live: '空闲', generating: '生成中', tool: '执行工具', sampling: '采样中', 'waiting-model': '等待模型', 'waiting-output': '等待输出', error: '未连接',
    auth: '需要登录', idle: '未连接', permission: '等待授权', question: '等待回答',
    login: '登录', signing: '登录中…', password: 'OpenChamber 访问密码', server: '登录到：',
    http: '我确认这是自己的服务器。HTTP 不加密；非可信网络应使用 HTTPS 或经批准的隧道。',
    hint: '密码只用于本次登录，不保存；登录会话仅存于扩展服务内存。',
    authNeeded: '在下方输入 OpenChamber 访问密码，无需关闭服务器认证。',
    noOrigin: '此中继/嵌入页面无法确定服务器地址，请使用直接连接。',
    service: '请在 设置 → 扩展 中批准“运行本地服务”。', disabled: '扩展已在设置中暂停。',
    retry: '重试', forget: '清除 TPS 登录', avg: '上一轮平均速率', chars: '每秒字符数',
    ratio: '估算 Token/字符', total: '会话生成 Token', events: '收到的事件', state: '连接状态',
    estimate: '数字与图形仅作显示平滑；平均、峰值使用未平滑的生成计时数据。不含工具运行，仍是客户端估算。',
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
  const liveValue = new window.TPSPresentation.LiveValue();
  let detailsOpen = !compact;
  let height = 0;
  let transient = '';
  let history = [];
  let historyKey = '';
  let historyPolledAt = 0;
  let historyBusy = false;
  let historyError = '';
  let resetUntil = 0;
  const chart = window.TPSChart.create($('chart'), $('chart-tooltip'));
  $('chart-window').value = compact ? '60000' : '0';
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
  async function request(method, path, body, query) {
    const result = await host.serviceRequest({ method, path, ...(body ? { body: JSON.stringify(body) } : {}), ...(query ? { query } : {}) });
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
    const value = liveValue.read(transient ? null : rate, performance.now());
    $('value').textContent = Number.isFinite(value) ? `≈ ${Math.round(value)}` : '—';
    $('value').title = copy === zh ? '平滑估算；平均和峰值使用未平滑数据' : 'Smoothed estimate; average and peak use unsmoothed measurements';
    let label = rate ? (copy[rate.connection] || copy.error) : copy.connecting;
    if (rate?.authRequired) label = copy.auth;
    else if (transient) label = copy.error;
    else if (live) label = (rate.phase === 'idle' ? copy.live : copy[rate.phase]) || copy.live;
    if (live && rate?.phase === 'generating' && value === null) label = copy['waiting-output'];
    const badge = $('badge');
    badge.textContent = ''; badge.title = label; badge.setAttribute('aria-label', label);
    badge.dataset.state = rate?.authRequired || transient || !live ? 'warning'
      : rate?.phase === 'tool' ? 'tool' : Number.isFinite(value) ? 'live' : 'idle';
    $('extra').hidden = !detailsOpen || Boolean(rate?.authRequired);
    $('chart-toggle').setAttribute('aria-expanded', String(!$('extra').hidden));
    $('chart-toggle').hidden = Boolean(rate?.authRequired);
    $('notice').textContent = transient || (rate?.authRequired ? copy.authNeeded : rate?.error || '');
    const needsLogin = Boolean(rate?.authRequired);
    $('auth').hidden = !needsLogin;
    $('server').textContent = copy.server + (origin || '—');
    $('http-confirm').hidden = !origin?.startsWith('http:');
    $('login').disabled = loggingIn || (rate?.authRetryAfter > 0);
    $('login').textContent = loggingIn ? copy.signing : copy.login;
    if (rate?.authRetryAfter > 0) $('auth-error').textContent = copy.limited + rate.authRetryAfter + copy.seconds;
    drawStatistics();
    if (!compact) {
      $('session').textContent = sessionTitle || sessionId || '';
      const avg = rate?.lastTurn;
      const rows = [
        [copy.avg, Number.isFinite(avg?.tokensPerSecond) ? `${avg.source === 'estimate' ? '≈ ' : ''}${avg.tokensPerSecond.toFixed(1)} tok/s` : '—'],
        [copy.chars, Number.isFinite(rate?.charsPerSecond) ? rate.charsPerSecond.toFixed(1) : '—'],
        [copy.ratio, Number.isFinite(rate?.charsPerToken) ? rate.charsPerToken.toFixed(3) : '—'],
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
  function drawStatistics() {
    const statistics = rate?.sessionStats;
    $('metrics').hidden = !statistics || !sessionId || Boolean(rate?.authRequired);
    const format = n => Number.isFinite(n) ? `≈ ${n.toFixed(1)}` : '—';
    $('average-value').textContent = format(statistics?.averageTps);
    $('peak-value').textContent = format(statistics?.peakTps);
    $('average-value').title = copy.averageHint;
    $('peak-value').title = copy.peakHint;
    $('active-time').textContent = copy.active + window.TPSChart.duration(statistics?.activeMs || 0);
    $('stats-warning').textContent = rate?.statisticsWarning ? copy.persistenceWarning : '';
    if (rate?.statisticsWarning || historyError) { $('badge').dataset.state = 'warning'; $('badge').title += ' · ' + (historyError || copy.persistenceWarning); }
    $('history-note').textContent = historyError || copy.historyNote;
    $('reset-stats').textContent = Date.now() < resetUntil ? copy.confirmReset : copy.reset;
  }
  const chartKey = () => `${key()}|${$('chart-window').value}`;
  function paintChart() {
    chart.render(history, { compact, identity: key(), averageTps: rate?.sessionStats?.averageTps,
      empty: copy.empty, locale: document.documentElement.lang });
  }
  async function pollHistory() {
    if (disposed || historyBusy || !sessionId || !rate?.sessionStats || $('chart-body').hidden || rate.authRequired) return;
    const expected = chartKey();
    if (historyKey === expected && Date.now() - historyPolledAt < 1000) return;
    historyBusy = true;
    try {
      const result = await request('GET', '/history', undefined, { sessionId, windowMs: $('chart-window').value });
      if (expected !== chartKey() || result.origin !== origin || result.sessionId !== sessionId) return;
      history = result.points; historyKey = expected; historyPolledAt = Date.now(); historyError = '';
      paintChart(); drawStatistics(); resize();
    } catch (error) { if (expected === chartKey()) { historyError = describe(error); drawStatistics(); } }
    finally { historyBusy = false; }
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
      const result = await request('GET', '/rate', undefined, sessionId ? { sessionId } : undefined);
      if (expected !== key() || result.origin !== origin || result.sessionId !== sessionId) return;
      rate = result; transient = ''; draw(); void pollHistory();
    } catch (error) {
      if (error.code === 'SESSION_NOT_WATCHED') { configuredKey = ''; rate = null; }
      transient = describe(error); draw();
    }
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
    $('average-label').textContent = copy.average; $('peak-label').textContent = copy.peak;
    $('chart-toggle').textContent = '⋯';
    $('chart-toggle').title = copy === zh ? '详情' : 'Details';
    $('chart-toggle').setAttribute('aria-label', $('chart-toggle').title);
    $('chart-axis').textContent = copy.axis;
    $('chart').setAttribute('aria-label', copy.chart + ': ' + copy.axis + ' / tok/s');
    for (const [index, label] of [copy.recent60, copy.recent300, copy.all].entries()) $('chart-window').options[index].textContent = label;
    $('reset-stats').textContent = copy.reset;
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
  $('chart-toggle').addEventListener('click', () => {
    detailsOpen = !detailsOpen; draw(); paintChart(); resize();
  });
  $('chart-window').addEventListener('change', () => {
    history = []; historyKey = ''; paintChart(); void pollHistory();
  });
  $('reset-stats').addEventListener('click', async () => {
    if (!sessionId) return;
    if (Date.now() >= resetUntil) { resetUntil = Date.now() + 5000; drawStatistics(); return; }
    const expected = key(); resetUntil = 0;
    try {
      await request('POST', '/stats/reset', { origin, sessionId });
      if (expected !== key()) return;
      history = []; historyKey = ''; rate = null; liveValue.reset(); paintChart(); await poll();
    } catch (error) { transient = describe(error); draw(); }
  });
  host.onReady(context => {
    applyTheme(context); language(context);
    const nextOrigin = resolveOrigin();
    if (origin !== nextOrigin) {
      origin = nextOrigin; configuredKey = ''; rate = null; history = []; historyKey = ''; resetUntil = 0; paintChart();
      $('password').value = ''; $('allow-http').checked = false; $('auth-error').textContent = '';
    }
    sessionId = context.session?.id ?? null;
    sessionTitle = context.session?.title ?? '';
    draw();
    if (!started) { started = true; void loop(); }
  });
  host.onSession(session => {
    const next = session?.id ?? null;
    if (sessionId !== next) { sessionId = next; rate = null; liveValue.reset(); history = []; historyKey = ''; historyError = ''; resetUntil = 0; paintChart(); draw(); }
    sessionTitle = session?.title ?? '';
    if (started) void poll();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe($('root'));
  window.addEventListener('pagehide', () => {
    disposed = true; clearTimeout(timer); $('password').value = ''; chart.dispose(); host.dispose();
  }, { once: true });
})();
