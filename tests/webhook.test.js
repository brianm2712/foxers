'use strict';
/* The webhook path, on a server started with a signing secret. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'wh_test_secret';
let child, base, dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxxers-wh-'));
  const port = 8600 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, FOXXERS_DATA: dataDir, FOXXERS_PORT: String(port),
      FOXXERS_HOST: '127.0.0.1', FOXXERS_REVOLUT_WEBHOOK_SECRET: SECRET,
      FOXXERS_LIMIT_WRITE: '10000', FOXXERS_LIMIT_SIGNUP: '10000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${base}/api/v1/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server never came up');
});
/*
 * Ask the server to stop, then wait until it is actually gone. It flushes the
 * store on the way out, so removing the data directory while it is still
 * shutting down is a race: rmSync walks past foxxers.json, the server writes
 * it back, and the rmdir behind it finds a directory that is not empty.
 */
function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(hard); resolve(); });
    child.kill('SIGTERM');
  });
}

test.after(async () => {
  if (child) await stopServer(child);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const send = (body, { secret = SECRET, ts = String(Date.now()), mangle } = {}) => {
  const raw = JSON.stringify(body);
  const sig = 'v1=' + crypto.createHmac('sha256', secret).update(`v1.${ts}.${raw}`).digest('hex');
  return fetch(`${base}/api/v1/webhooks/revolut`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'revolut-signature': sig, 'revolut-request-timestamp': ts },
    body: mangle ? raw.replace('"completed"', '"completed" ') : raw,
  });
};

test('an unsigned webhook is refused', async () => {
  const r = await fetch(`${base}/api/v1/webhooks/revolut`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: 'x', state: 'completed' }),
  });
  assert.strictEqual(r.status, 401);
});

test('a webhook signed with the wrong secret is refused', async () => {
  const r = await send({ order_id: 'x', state: 'completed' }, { secret: 'not-it' });
  assert.strictEqual(r.status, 401);
});

test('a body altered after signing is refused', async () => {
  const r = await send({ order_id: 'x', state: 'completed' }, { mangle: true });
  assert.strictEqual(r.status, 401, 'the signature covers the raw bytes, not a reparsed object');
});

test('a replayed webhook is refused however good the signature', async () => {
  const old = String(Date.now() - 3 * 60 * 60 * 1000);
  const r = await send({ order_id: 'x', state: 'completed' }, { ts: old });
  assert.strictEqual(r.status, 401);
});

test('a properly signed webhook for an order we do not know is accepted and ignored', async () => {
  const r = await send({ order_id: 'ord_unknown', state: 'completed' });
  assert.strictEqual(r.status, 200, 'a 4xx would make the provider redeliver it forever');
  assert.strictEqual((await r.json()).matched, false);
});
