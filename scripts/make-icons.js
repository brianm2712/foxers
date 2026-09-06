#!/usr/bin/env node
'use strict';
/*
 * App icons, drawn with the standard library.
 *
 * There is no image toolchain on this machine and no npm to add one, so the
 * icon is rasterised here and PNG-encoded by hand. zlib does the compression;
 * the rest is a filter byte per row and three CRCs.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CHARCOAL = [0x1C, 0x1E, 0x21];
const AMBER = [0xFF, 0xB0, 0x20];
const OFFWHITE = [0xF4, 0xF4, 0xF2];

function canvas(size) {
  const px = Buffer.alloc(size * size * 4);   // RGBA, transparent
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    if (a === 255) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; return; }
    // Source-over, so the antialiased edges blend with what is already there.
    const sa = a / 255, da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i]     = Math.round((r * sa + px[i]     * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };
  return { px, size, set };
}

/* Coverage-sampled rounded rectangle: 3x3 samples per pixel is enough to
 * kill the jaggies at these sizes without a real rasteriser. */
function roundRect(c, x0, y0, w, h, r, colour) {
  const inside = (x, y) => {
    if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
    const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r || (x >= x0 + r && x <= x0 + w - r) || (y >= y0 + r && y <= y0 + h - r);
  };
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++;
        }
      }
      if (hits) c.set(x, y, colour, Math.round((hits / 9) * 255));
    }
  }
}

function icon(size) {
  const c = canvas(size);
  const u = size / 512;
  roundRect(c, 0, 0, size, size, 112 * u, CHARCOAL);

  // An amber square-bracket frame, then the F inside it. Reads as a mark at
  // 40px on a home screen, which is the only size that matters.
  const t = Math.max(2, Math.round(26 * u));         // stroke thickness
  const fx = 150 * u, fy = 128 * u, fw = 212 * u, fh = 256 * u;

  roundRect(c, fx, fy, t, fh, t / 2, AMBER);                       // stem
  roundRect(c, fx, fy, fw, t, t / 2, AMBER);                       // top arm
  roundRect(c, fx, fy + fh / 2 - t / 2, fw * 0.72, t, t / 2, OFFWHITE); // middle arm

  // Corner ticks: the "frame" that stops it reading as a plain letter.
  const m = 62 * u, len = 74 * u, s = Math.max(2, Math.round(16 * u));
  roundRect(c, m, m, len, s, s / 2, AMBER);
  roundRect(c, m, m, s, len, s / 2, AMBER);
  roundRect(c, size - m - len, size - m - s, len, s, s / 2, AMBER);
  roundRect(c, size - m - s, size - m - len, s, len, s / 2, AMBER);

  return c;
}

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(c) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.size, 0);
  ihdr.writeUInt32BE(c.size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  const raw = Buffer.alloc(c.size * (c.size * 4 + 1));
  for (let y = 0; y < c.size; y++) {
    raw[y * (c.size * 4 + 1)] = 0;   // filter: none
    c.px.copy(raw, y * (c.size * 4 + 1) + 1, y * c.size * 4, (y + 1) * c.size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2] || path.join(__dirname, '..', 'web', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512, 1024]) {
  const file = path.join(outDir, size === 1024 ? 'icon-1024.png' : `icon-${size}.png`);
  fs.writeFileSync(file, png(icon(size)));
  console.log(`${file}  ${size}x${size}`);
}
