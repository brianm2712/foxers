'use strict';
/*
 * Authentication.
 *
 * Both sides sign in with an email and a password, and both get the same
 * kind of session token — one code path to get right, and scrypt is already
 * here. Sessions carry a `kind` so a customer token can never be presented as
 * a pro one: the kind is inside the signed payload, so flipping it invalidates
 * the signature.
 *
 * Job tokens survive alongside all this. A foxxer quoting a walk-in has nobody
 * to attach an account to, and the link they hand over still has to open, so
 * a signed per-job token remains a credential in its own right.
 */

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(keyB64, 'base64url');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, SCRYPT);
  } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ---- signed tokens -------------------------------------------------- */

function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  // Compare as buffers of equal length, or timingSafeEqual throws on a
  // length mismatch and turns a forged token into a 500.
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

const SESSION_MS = 12 * 60 * 60 * 1000;

/*
 * A customer's session lasts a good deal longer than a pro's. The pro console
 * holds the money and is used on a phone that lives on a van dashboard; a
 * customer signs in to check whether anyone is coming on Thursday, and being
 * logged out between the quote and the visit is how an account stops being
 * used at all.
 */
const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function issueSession(secret, subjectId, kind = 'pro') {
  const life = kind === 'customer' ? CUSTOMER_SESSION_MS : SESSION_MS;
  return sign(secret, { sub: subjectId, kind, exp: Date.now() + life });
}

function readSession(secret, token, kind = 'pro') {
  const p = verify(secret, token);
  return p && p.kind === kind ? p : null;
}

/** A token that unlocks exactly one job for the customer who booked it. */
function issueJobToken(secret, ref) {
  return sign(secret, { ref, kind: 'job' });
}

function readJobToken(secret, token, ref) {
  const p = verify(secret, token);
  if (!p || p.kind !== 'job') return null;
  // Constant-time on the ref too — this is the whole access check.
  const a = Buffer.from(String(p.ref));
  const b = Buffer.from(String(ref));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return p;
}

/* ---- rate limiting --------------------------------------------------- */

/*
 * Fixed window per key. Guards login and the two unauthenticated write paths
 * (booking and quote request), which are otherwise a way to fill the disk
 * from the internet.
 */
class RateLimit {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || now > rec.reset) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return { ok: true, remaining: this.limit - 1 };
    }
    rec.n += 1;
    if (rec.n > this.limit) {
      return { ok: false, retryAfter: Math.ceil((rec.reset - now) / 1000) };
    }
    return { ok: true, remaining: this.limit - rec.n };
  }

  /** Called on a timer; the map is otherwise unbounded in a long uptime. */
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) if (now > v.reset) this.hits.delete(k);
  }
}

module.exports = {
  hashPassword, verifyPassword, sign, verify,
  issueSession, readSession, issueJobToken, readJobToken,
  RateLimit, SESSION_MS, CUSTOMER_SESSION_MS,
};
