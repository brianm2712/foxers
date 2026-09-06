/* The one place that talks to the server. The iOS client mirrors this file. */

const TOKEN_KEY = 'fx.token';
const CUSTOMER_TOKEN_KEY = 'fx.customer';

const stored = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const store = (key, v) => {
  try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key); }
  catch { /* private browsing — the cookie still carries the session */ }
};

/*
 * Two sessions, side by side. A tradesperson books a plumber like anyone
 * else, so being signed in to the console must not sign you out of your own
 * customer account. They are kept in separate keys and separate cookies.
 */
export const session = {
  get token() { return stored(TOKEN_KEY); },
  set token(v) { store(TOKEN_KEY, v); },
  get customerToken() { return stored(CUSTOMER_TOKEN_KEY); },
  set customerToken(v) { store(CUSTOMER_TOKEN_KEY, v); },
  pro: null,
  private: null,
  customer: null,
};

/*
 * Which of the two a call travels on. The pro console and the pro's own auth
 * routes carry the pro token; everything a customer does carries theirs.
 * Deciding here rather than at each call site means no route can accidentally
 * be made with the wrong identity.
 */
const CUSTOMER_PATHS = ['/api/v1/auth/customer', '/api/v1/me', '/api/v1/bookings', '/api/v1/requests'];
const tokenFor = (url) =>
  CUSTOMER_PATHS.some((prefix) => url.startsWith(prefix)) ? session.customerToken : session.token;

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = tokenFor(url);
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('No connection to Foxxers. Check your signal and try again.', 0, 'offline');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* fall through */ }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.code || 'error');
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  put: (u, b) => request('PUT', u, b ?? {}),
  patch: (u, b) => request('PATCH', u, b ?? {}),
  del: (u) => request('DELETE', u),
};

/* The taxonomy changes once a quarter at most; fetch it once per load. */
let metaPromise = null;
export function meta() {
  if (!metaPromise) metaPromise = api.get('/api/v1/meta');
  return metaPromise;
}

export async function whoami() {
  try {
    const r = await api.get('/api/v1/auth/me');
    session.pro = r.pro;
    session.private = r.private;
    return r;
  } catch (err) {
    if (err.status === 401) { session.pro = null; session.token = null; return null; }
    throw err;
  }
}

export async function login(email, password) {
  const r = await api.post('/api/v1/auth/login', { email, password });
  session.token = r.token;
  session.pro = r.pro;
  session.private = r.private;
  return r;
}

export async function signup(payload) {
  const r = await api.post('/api/v1/auth/signup', payload);
  session.token = r.token;
  session.pro = r.pro;
  session.private = r.private;
  return r;
}

export async function logout() {
  try { await api.post('/api/v1/auth/logout'); } catch { /* clearing locally is what matters */ }
  session.token = null;
  session.pro = null;
  session.private = null;
}

/* ---- customer accounts ----------------------------------------------- */

export async function whoamiCustomer() {
  try {
    const r = await api.get('/api/v1/me');
    session.customer = r.customer;
    return r.customer;
  } catch (err) {
    if (err.status === 401) { session.customer = null; session.customerToken = null; return null; }
    throw err;
  }
}

export async function customerLogin(email, password) {
  const r = await api.post('/api/v1/auth/customer/login', { email, password });
  session.customerToken = r.token;
  session.customer = r.customer;
  return r;
}

export async function customerSignup(payload) {
  const r = await api.post('/api/v1/auth/customer/signup', payload);
  session.customerToken = r.token;
  session.customer = r.customer;
  return r;
}

export async function customerLogout() {
  try { await api.post('/api/v1/auth/customer/logout'); } catch { /* clearing locally is what matters */ }
  session.customerToken = null;
  session.customer = null;
}

export const myJobs = () => api.get('/api/v1/me/jobs');
export const saveMe = (patch) => api.put('/api/v1/me', patch);

/* Job access by link. The token is the credential, so it travels with every
 * call and is kept out of anything that could be shared by accident. A
 * customer reaches the same page from their own job list, which carries the
 * same token — one page, one access check. */
export const jobs = {
  get: (ref, t) => api.get(`/api/v1/jobs/${encodeURIComponent(ref)}?t=${encodeURIComponent(t)}`),
  accept: (ref, t, quoteId, start) => api.post(`/api/v1/jobs/${encodeURIComponent(ref)}/accept?t=${encodeURIComponent(t)}`, { quoteId, start }),
  decline: (ref, t, quoteId, reason) => api.post(`/api/v1/jobs/${encodeURIComponent(ref)}/decline?t=${encodeURIComponent(t)}`, { quoteId, reason }),
  review: (ref, t, payload) => api.post(`/api/v1/jobs/${encodeURIComponent(ref)}/review?t=${encodeURIComponent(t)}`, payload),
};
