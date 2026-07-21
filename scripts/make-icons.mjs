#!/usr/bin/env node
// Generate the VIMES app icons from ONE set of geometry constants.
//
// Emits (into packages/ui/public/icons/):
//   icon.svg               — the design source (also served as the browser favicon)
//   icon-192.png           — PWA "any" icon, rounded corners, transparent outside
//   icon-512.png           — PWA "any" icon
//   icon-512-maskable.png  — PWA "maskable": FULL-BLEED opaque square. Android
//                            crops maskable icons to the device shape, so the
//                            background must reach the edges and the artwork must
//                            stay inside the central 80% safe zone.
//
// The mark: a bold terminal caret `>` plus a cursor block. The caret doubles as a
// chevron — the rank insignia of the Watch (the app is named for Commander Vimes
// and watches every Claude Code process). The cursor block is the same amber the
// gate cards use: the "waiting for you" color (pillar 5 — attention is the
// scarce resource).
//
// No image dependencies: shapes are rasterized here with 4x4 supersampling and
// encoded as PNG via node's zlib. Run: node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const iconDirectory = join(scriptDirectory, '..', 'packages', 'ui', 'public', 'icons');

// ── Geometry + palette (the single source of truth; the SVG and the PNGs are
// both generated from these, so they can never drift apart). Design space is
// 512x512; the raster scales it to whatever size is requested.
const CANVAS = 512;
const CORNER_RADIUS = 96; // rounded-square for the "any" icons

// Background gradient — the app's dark palette (slate-900 → slate-950).
const BACKGROUND_TOP = { red: 0x16, green: 0x22, blue: 0x3c };
const BACKGROUND_BOTTOM = { red: 0x02, green: 0x06, blue: 0x17 };

// The caret `>` — three points, drawn as two round-capped strokes.
const CARET_POINTS = [
  { x: 148, y: 152 },
  { x: 258, y: 256 },
  { x: 148, y: 360 },
];
const CARET_HALF_WIDTH = 26; // stroke-width 52
const CARET_COLOR = { red: 0x38, green: 0xbd, blue: 0xf8 }; // sky-400

// The cursor block, sitting after the caret on the same baseline.
const CURSOR_RECT = { x: 310, y: 292, width: 82, height: 68, radius: 10 };
const CURSOR_COLOR = { red: 0xfb, green: 0xbf, blue: 0x24 }; // amber-400

// ── Geometry helpers (pure) ──────────────────────────────────────────────────

// Distance from a point to a line segment.
function distanceToSegment(pointX, pointY, segmentStart, segmentEnd) {
  const deltaX = segmentEnd.x - segmentStart.x;
  const deltaY = segmentEnd.y - segmentStart.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) {
    return Math.hypot(pointX - segmentStart.x, pointY - segmentStart.y);
  }
  let projection = ((pointX - segmentStart.x) * deltaX + (pointY - segmentStart.y) * deltaY) / lengthSquared;
  projection = Math.max(0, Math.min(1, projection));
  const closestX = segmentStart.x + projection * deltaX;
  const closestY = segmentStart.y + projection * deltaY;
  return Math.hypot(pointX - closestX, pointY - closestY);
}

// Inside a rounded rectangle? (the standard shrink-and-corner-circle test)
function insideRoundedRect(pointX, pointY, rect) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const spreadX = Math.max(Math.abs(pointX - centerX) - (rect.width / 2 - rect.radius), 0);
  const spreadY = Math.max(Math.abs(pointY - centerY) - (rect.height / 2 - rect.radius), 0);
  return spreadX * spreadX + spreadY * spreadY <= rect.radius * rect.radius;
}

// The caret is the union of two round-capped strokes — a union of capsules gives
// the round join at the tip for free.
function insideCaret(pointX, pointY) {
  for (let index = 0; index < CARET_POINTS.length - 1; index += 1) {
    if (distanceToSegment(pointX, pointY, CARET_POINTS[index], CARET_POINTS[index + 1]) <= CARET_HALF_WIDTH) {
      return true;
    }
  }
  return false;
}

// Vertical background gradient, sampled at a y in design space.
function backgroundColorAt(pointY) {
  const ratio = Math.max(0, Math.min(1, pointY / CANVAS));
  return {
    red: Math.round(BACKGROUND_TOP.red + (BACKGROUND_BOTTOM.red - BACKGROUND_TOP.red) * ratio),
    green: Math.round(BACKGROUND_TOP.green + (BACKGROUND_BOTTOM.green - BACKGROUND_TOP.green) * ratio),
    blue: Math.round(BACKGROUND_TOP.blue + (BACKGROUND_BOTTOM.blue - BACKGROUND_TOP.blue) * ratio),
  };
}

// ── Rasterizer ───────────────────────────────────────────────────────────────
// 4x4 supersampling per pixel gives clean edges without any AA library.
const SAMPLES_PER_AXIS = 4;

function renderRgba(size, { fullBleed }) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = CANVAS / size;
  const backgroundRect = { x: 0, y: 0, width: CANVAS, height: CANVAS, radius: fullBleed ? 0 : CORNER_RADIUS };

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let totalRed = 0;
      let totalGreen = 0;
      let totalBlue = 0;
      let totalAlpha = 0;

      for (let sampleY = 0; sampleY < SAMPLES_PER_AXIS; sampleY += 1) {
        for (let sampleX = 0; sampleX < SAMPLES_PER_AXIS; sampleX += 1) {
          const designX = (pixelX + (sampleX + 0.5) / SAMPLES_PER_AXIS) * scale;
          const designY = (pixelY + (sampleY + 0.5) / SAMPLES_PER_AXIS) * scale;

          // A full-bleed (maskable) icon has no rounded corners: every sample is
          // opaque background. Otherwise the rounded square defines the alpha.
          const onBackground = fullBleed || insideRoundedRect(designX, designY, backgroundRect);
          if (!onBackground) {
            continue; // transparent outside the rounded square
          }

          let color = backgroundColorAt(designY);
          if (insideCaret(designX, designY)) {
            color = CARET_COLOR;
          } else if (insideRoundedRect(designX, designY, CURSOR_RECT)) {
            color = CURSOR_COLOR;
          }

          totalRed += color.red;
          totalGreen += color.green;
          totalBlue += color.blue;
          totalAlpha += 255;
        }
      }

      const sampleCount = SAMPLES_PER_AXIS * SAMPLES_PER_AXIS;
      const alpha = totalAlpha / sampleCount;
      const offset = (pixelY * size + pixelX) * 4;
      // Premultiplied averaging would darken edges against transparency, so the
      // colour is averaged over COVERED samples only.
      const coveredSamples = totalAlpha / 255;
      pixels[offset] = coveredSamples === 0 ? 0 : Math.round(totalRed / coveredSamples);
      pixels[offset + 1] = coveredSamples === 0 ? 0 : Math.round(totalGreen / coveredSamples);
      pixels[offset + 2] = coveredSamples === 0 ? 0 : Math.round(totalBlue / coveredSamples);
      pixels[offset + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

// ── Minimal PNG encoder (IHDR/IDAT/IEND, colour type 6 = RGBA) ───────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgbaPixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with filter byte 0 (None).
  const rowStride = size * 4;
  const raw = Buffer.alloc((rowStride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (rowStride + 1)] = 0;
    rgbaPixels.copy(raw, row * (rowStride + 1) + 1, row * rowStride, (row + 1) * rowStride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── SVG (generated from the SAME constants, so it can't drift) ───────────────
function buildSvg() {
  const toHex = (color) =>
    `#${color.red.toString(16).padStart(2, '0')}${color.green.toString(16).padStart(2, '0')}${color.blue.toString(16).padStart(2, '0')}`;
  const caretPath = CARET_POINTS.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}" role="img" aria-label="VIMES">
  <title>VIMES</title>
  <defs>
    <linearGradient id="vimesBackground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${toHex(BACKGROUND_TOP)}"/>
      <stop offset="1" stop-color="${toHex(BACKGROUND_BOTTOM)}"/>
    </linearGradient>
  </defs>
  <rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="url(#vimesBackground)"/>
  <path d="${caretPath}" fill="none" stroke="${toHex(CARET_COLOR)}" stroke-width="${CARET_HALF_WIDTH * 2}" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="${CURSOR_RECT.x}" y="${CURSOR_RECT.y}" width="${CURSOR_RECT.width}" height="${CURSOR_RECT.height}" rx="${CURSOR_RECT.radius}" ry="${CURSOR_RECT.radius}" fill="${toHex(CURSOR_COLOR)}"/>
</svg>
`;
}

// ── Emit ─────────────────────────────────────────────────────────────────────
mkdirSync(iconDirectory, { recursive: true });

const outputs = [
  { file: 'icon-192.png', size: 192, fullBleed: false },
  { file: 'icon-512.png', size: 512, fullBleed: false },
  { file: 'icon-512-maskable.png', size: 512, fullBleed: true },
];

writeFileSync(join(iconDirectory, 'icon.svg'), buildSvg(), 'utf8');
console.log('wrote icon.svg');

for (const output of outputs) {
  const pixels = renderRgba(output.size, { fullBleed: output.fullBleed });
  writeFileSync(join(iconDirectory, output.file), encodePng(output.size, pixels));
  console.log(`wrote ${output.file} (${output.size}x${output.size}${output.fullBleed ? ', full-bleed maskable' : ''})`);
}
