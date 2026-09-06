'use strict';
/* Small helpers over node:http. No framework, because there is no npm here. */

const fs = require('fs');
const path = require('path');

const MAX_BODY = 256 * 1024;

function json(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/*
 * Always drain the body before replying on an error path. An unread request
 * body desyncs a keep-alive connection: the next request on that socket is
 * parsed starting from the leftover bytes.
 */
function fail(req, res, status, message, code = 'error') {
  const finish = () => json(res, status, { error: message, code });
  if (req.readable && !req.readableEnded) {
    req.resume();
    req.once('end', finish);
    req.once('error', finish);
  } else finish();
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

async function readForm(req, limit) {
  const buf = await readBody(req, limit);
  const out = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v;
  return out;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.secure) bits.push('Secure');
  const prev = res.getHeader('set-cookie');
  const all = prev ? [].concat(prev, bits.join('; ')) : [bits.join('; ')];
  res.setHeader('set-cookie', all);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

/** Best-effort client identity for rate limiting. */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** True when the request arrived over the internet rather than the LAN/tailnet. */
function viaTunnel(req) {
  return !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/*
 * Static files. The realpath check is the important line: without it a
 * crafted path can escape the web root through a symlink even after the
 * lexical ".." normalisation that path.join already does.
 */
function serveStatic(root, urlPath, res, { immutable = false, status = 200 } = {}) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const target = path.join(root, rel);
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    return false;
  }
  if (real !== root && !real.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return serveStatic(root, path.join(rel, 'index.html'), res, { immutable, status });

  const type = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
  res.writeHead(status, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(real).pipe(res);
  return true;
}

module.exports = {
  json, fail, readBody, readJson, readForm, parseCookies, setCookie, clearCookie,
  clientIp, viaTunnel, serveStatic, MIME, MAX_BODY,
};
