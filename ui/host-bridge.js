/*
 * Small, dependency-free subset of the OpenChamber SDK v1 wire contract:
 * hello / ready / session / result / service-request / resize.
 * Based on @openchamber/sdk in OpenChamber v2.1.1 (MIT; see licenses/).
 * Does not reach into the parent DOM, cookies, storage, or transport internals.
 */
(() => {
  'use strict';
  function connectHost(target = window, timeoutMs = 20000) {
    const parent = target.parent;
    const pending = new Map();
    const ready = new Set();
    const sessions = new Set();
    let context = null;
    let counter = 0;
    let disposed = false;
    const envelope = { channel: 'openchamber.sdk', v: 1 };
    const emit = (listeners, value) => {
      for (const listener of listeners) {
        try { listener(value); } catch { /* never log request/credential data */ }
      }
    };
    const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const isSession = s => s === null || (isObject(s) && typeof s.id === 'string');
    function receive(event) {
      if (disposed || event.source !== parent) return;
      const m = event.data;
      if (!isObject(m) || m.channel !== envelope.channel || m.v !== 1) return;
      if (m.type === 'ready' && isObject(m.payload) && isSession(m.payload.session)) {
        context = m.payload;
        emit(ready, context); emit(sessions, context.session);
      } else if (m.type === 'session' && isObject(m.payload) && isSession(m.payload.session)) {
        if (context) context = { ...context, session: m.payload.session };
        emit(sessions, m.payload.session);
      } else if (m.type === 'result' && typeof m.id === 'string' && typeof m.ok === 'boolean') {
        const call = pending.get(m.id);
        if (!call) return;
        pending.delete(m.id); clearTimeout(call.timer);
        if (m.ok) call.resolve(m.payload);
        else call.reject(Object.assign(new Error(typeof m.error === 'string' ? m.error : 'Host request failed.'), { code: m.code }));
      }
    }
    function send(type, payload) {
      if (disposed || parent === target) return Promise.reject(Object.assign(new Error('Open this extension inside OpenChamber.'), { code: 'HOST_UNAVAILABLE' }));
      const id = `oc-tps-${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('OpenChamber did not answer in time.'), { code: 'HOST_TIMEOUT' }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { parent.postMessage({ ...envelope, type, id, payload }, '*'); }
        catch {
          pending.delete(id); clearTimeout(timer);
          reject(Object.assign(new Error('Cannot reach the OpenChamber host.'), { code: 'HOST_UNAVAILABLE' }));
        }
      });
    }
    target.addEventListener('message', receive);
    if (parent !== target) parent.postMessage({ ...envelope, type: 'hello' }, '*');
    return {
      onReady(listener) { ready.add(listener); if (context) listener(context); return () => ready.delete(listener); },
      onSession(listener) { sessions.add(listener); if (context) listener(context.session); return () => sessions.delete(listener); },
      async serviceRequest(payload) {
        if (!['/watch', '/rate', '/auth/login', '/auth/clear', '/retry'].includes(payload.path)) throw new Error('Unexpected TPS service path.');
        const result = await send('service-request', payload);
        if (!isObject(result) || !Number.isInteger(result.status) || typeof result.body !== 'string') throw new Error('Invalid TPS service response.');
        return result;
      },
      setHeight(height) { return send('resize', { height: Math.min(320, Math.max(24, Math.ceil(height))) }); },
      dispose() {
        disposed = true; target.removeEventListener('message', receive);
        for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('TPS view closed.')); }
        pending.clear(); ready.clear(); sessions.clear();
      },
    };
  }
  window.TPSHost = { connectHost };
})();
