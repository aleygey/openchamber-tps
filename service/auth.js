/** Opt-in UI-session login for OpenChamber 2.1.1. No password/credential files. */
export class AuthError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new AuthError(400, 'BAD_ORIGIN', 'A server origin is required.');
  let u;
  try { u = new URL(value); } catch { throw new AuthError(400, 'BAD_ORIGIN', 'Invalid server origin.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password ||
      u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new AuthError(400, 'BAD_ORIGIN', 'Use an http(s) origin without a path, credentials or query.');
  }
  return u.origin;
}

async function readLimitedJson(response, limit = 16384) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AuthError(502, 'BAD_AUTH_RESPONSE', 'Login response is too large.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return null; }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Keep only the host-issued UI session, never arbitrary upstream cookies. */
export function readSessionCookie(headers, origin, now = Date.now()) {
  const entries = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ?? '').split(/,(?=\s*oc_ui_session(?:_\d+)?=)/);
  const host = new URL(origin);
  const allowedNames = new Set(['oc_ui_session', ...(host.port ? [`oc_ui_session_${Number(host.port)}`] : [])]);
  for (const raw of entries) {
    const parts = raw.split(';').map(s => s.trim());
    const match = /^([A-Za-z0-9_]+)=([^\s;,\r\n]+)$/.exec(parts[0]);
    if (!match || !allowedNames.has(match[1])) continue;
    if (parts.some(p => /^secure$/i.test(p)) && host.protocol !== 'https:') {
      throw new AuthError(502, 'SECURE_COOKIE_HTTP', 'The server issued a Secure cookie. Connect using HTTPS.');
    }
    let expiresAt = now + 12 * 60 * 60 * 1000;
    const age = parts.find(p => /^max-age=/i.test(p));
    const expires = parts.find(p => /^expires=/i.test(p));
    if (age) {
      const seconds = Number(age.slice(age.indexOf('=') + 1));
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      expiresAt = now + Math.min(seconds, 7 * 24 * 60 * 60) * 1000;
    } else if (expires) {
      const parsed = Date.parse(expires.slice(expires.indexOf('=') + 1));
      if (Number.isFinite(parsed)) expiresAt = parsed;
      if (expiresAt <= now) continue;
    }
    return { value: `${match[1]}=${match[2]}`, expiresAt };
  }
  throw new AuthError(502, 'NO_SESSION_COOKIE', 'Login did not return an OpenChamber UI session cookie.');
}

export class UiSessionAuth {
  #origin = null;
  #cookie = null;
  #revision = 0;
  #pending = null;
  #retryAt = 0;

  get origin() { return this.#origin; }
  get authenticated() { return Boolean(this.#cookie && this.#cookie.expiresAt > Date.now()); }
  get expiresAt() { return this.authenticated ? this.#cookie.expiresAt : null; }
  get retryAfter() { return Math.max(0, Math.ceil((this.#retryAt - Date.now()) / 1000)); }

  setOrigin(origin) {
    const next = normalizeOrigin(origin);
    if (next === this.#origin) return;
    this.clear();
    this.#origin = next;
    this.#retryAt = 0;
  }

  clear() {
    this.#revision += 1;
    this.#cookie = null;
    this.#pending?.abort();
    this.#pending = null;
  }

  headersFor(origin) {
    // A session must NEVER follow the watched origin to a different server.
    if (origin !== this.#origin || !this.authenticated) return {};
    return { Cookie: this.#cookie.value };
  }

  async login(origin, password) {
    if (normalizeOrigin(origin) !== this.#origin) throw new AuthError(409, 'ORIGIN_CHANGED', 'The active server changed. Reopen the login form.');
    if (typeof password !== 'string' || password.length === 0 || password.length > 4096) {
      throw new AuthError(400, 'BAD_PASSWORD', 'Enter the OpenChamber UI password (maximum 4096 characters).');
    }
    if (this.#pending) throw new AuthError(409, 'LOGIN_BUSY', 'A login is already in progress.');
    if (this.retryAfter > 0) throw new AuthError(429, 'LOGIN_RATE_LIMITED', 'Wait before trying again.', this.retryAfter);
    const local = new AbortController();
    this.#pending = local;
    const revision = this.#revision;
    let body = JSON.stringify({ password, trustDevice: false });
    // Do not retain the password for automatic retries. JS memory is GC-managed.
    password = '';
    try {
      const response = await fetch(new URL('/auth/session', origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: origin },
        body,
        redirect: 'manual',
        signal: AbortSignal.any([local.signal, AbortSignal.timeout(8000)]),
      });
      body = '';
      if (local.signal.aborted || revision !== this.#revision || this.#origin !== origin) {
        await response.body?.cancel();
        throw new AuthError(409, 'ORIGIN_CHANGED', 'The active server changed during login.');
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new AuthError(502, 'AUTH_REDIRECT', 'Login redirected. Credentials were not forwarded. Use the final server address.');
      }
      const data = await readLimitedJson(response);
      if (local.signal.aborted || revision !== this.#revision || this.#origin !== origin) {
        throw new AuthError(409, 'ORIGIN_CHANGED', 'The active server changed during login.');
      }
      if (response.status === 429) {
        const seconds = Math.max(1, Math.min(86400, Number(response.headers.get('retry-after')) || Number(data?.retryAfter) || 60));
        this.#retryAt = Date.now() + seconds * 1000;
        throw new AuthError(429, 'LOGIN_RATE_LIMITED', 'OpenChamber is limiting login attempts.', seconds);
      }
      if (response.status === 401) throw new AuthError(401, 'INVALID_PASSWORD', 'OpenChamber rejected this password.');
      if (response.status === 403) throw new AuthError(403, 'PASSWORD_LOGIN_FORBIDDEN', 'Password login is not allowed for this server access scope. Use a trusted direct connection.');
      if (!response.ok || data?.authenticated !== true) {
        throw new AuthError(502, 'AUTH_FAILED', `OpenChamber login failed (HTTP ${response.status}).`);
      }
      const cookie = readSessionCookie(response.headers, origin);
      this.#cookie = cookie;
      this.#retryAt = 0;
      return { authenticated: true, expiresAt: cookie.expiresAt };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (revision !== this.#revision || local.signal.aborted) {
        throw new AuthError(409, 'ORIGIN_CHANGED', 'Login was cancelled.');
      }
      // Do not echo arbitrary upstream response bodies or request details.
      throw new AuthError(502, 'AUTH_UNREACHABLE', 'The login request failed or timed out. Check the active server address.');
    } finally {
      body = '';
      if (this.#pending === local) this.#pending = null;
    }
  }
}
