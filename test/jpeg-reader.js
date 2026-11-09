'use strict';
// Minimal, dependency-free JPEG metadata reader tuned for Fujifilm files.
// Reads only the header segments (APP1 EXIF + APP2 MPF), never the image data.
//
// Extracts:
//   - DateTimeOriginal / SubSecTimeOriginal / Orientation / Model / dimensions
//   - Fujifilm MakerNote film simulation (FilmMode 0x1401, Saturation 0x1003)
//   - MPF secondary image (Fuji embeds a ~1920px preview) byte range

const fs = require('fs');

const FILM_MODES = {
  0x000: 'Provia',
  0x100: 'Studio Portrait',
  0x110: 'Studio Portrait Ex',
  0x120: 'Astia',
  0x130: 'Studio Portrait Sharp',
  0x200: 'Velvia',
  0x300: 'Studio Portrait Ex',
  0x400: 'Velvia',
  0x500: 'Pro Neg. Std',
  0x501: 'Pro Neg. Hi',
  0x600: 'Classic Chrome',
  0x700: 'Eterna',
  0x800: 'Classic Neg.',
  0x900: 'Eterna Bleach Bypass',
  0xa00: 'Nostalgic Neg.',
  0xb00: 'Reala Ace',
};

// Monochrome sims are encoded in the Saturation tag rather than FilmMode.
const MONO_MODES = {
  0x300: 'Monochrome',
  0x301: 'Monochrome + R',
  0x302: 'Monochrome + Ye',
  0x303: 'Monochrome + G',
  0x310: 'Sepia',
  0x500: 'Acros',
  0x501: 'Acros + R',
  0x502: 'Acros + Ye',
  0x503: 'Acros + G',
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function reader(buf, base, little) {
  return {
    u16: (o) => (little ? buf.readUInt16LE(base + o) : buf.readUInt16BE(base + o)),
    u32: (o) => (little ? buf.readUInt32LE(base + o) : buf.readUInt32BE(base + o)),
    ok: (o, n) => base + o >= 0 && base + o + n <= buf.length,
  };
}

// Parse one IFD. Returns Map(tag -> {type,count,valueOffset(abs within tiff),raw})
function readIfd(buf, tiffStart, little, ifdOff) {
  const r = reader(buf, tiffStart, little);
  const out = new Map();
  if (!r.ok(ifdOff, 2)) return { tags: out, next: 0 };
  const n = r.u16(ifdOff);
  if (n > 1000 || !r.ok(ifdOff + 2, n * 12)) return { tags: out, next: 0 };
  for (let i = 0; i < n; i++) {
    const e = ifdOff + 2 + i * 12;
    const tag = r.u16(e);
    const type = r.u16(e + 2);
    const count = r.u32(e + 4);
    const size = (TYPE_SIZE[type] || 1) * count;
    const valOff = size <= 4 ? e + 8 : r.u32(e + 8);
    out.set(tag, { type, count, off: valOff, size });
  }
  const next = r.ok(ifdOff + 2 + n * 12, 4) ? r.u32(ifdOff + 2 + n * 12) : 0;
  return { tags: out, next };
}

function tagValue(buf, base, little, t) {
  if (!t) return undefined;
  const r = reader(buf, base, little);
  if (!r.ok(t.off, t.size)) return undefined;
  if (t.type === 2) {
    return buf.toString('latin1', base + t.off, base + t.off + t.count).replace(/\0+$/, '').trim();
  }
  if (t.type === 3) return r.u16(t.off);
  if (t.type === 4 || t.type === 9) return r.u32(t.off);
  if (t.type === 7 || t.type === 1) return buf.subarray(base + t.off, base + t.off + t.count);
  return undefined;
}

function parseFujiMakerNote(buf, start, len) {
  // "FUJIFILM" + uint32le IFD offset, offsets relative to makernote start, little endian.
  if (len < 12 || buf.toString('latin1', start, start + 8) !== 'FUJIFILM') return {};
  const ifdOff = buf.readUInt32LE(start + 8);
  const { tags } = readIfd(buf, start, true, ifdOff);
  const filmMode = tagValue(buf, start, true, tags.get(0x1401));
  const saturation = tagValue(buf, start, true, tags.get(0x1003));
  let filmSim = null;
  if (typeof saturation === 'number' && MONO_MODES[saturation]) filmSim = MONO_MODES[saturation];
  else if (typeof filmMode === 'number') filmSim = FILM_MODES[filmMode] || `Film ${filmMode.toString(16)}`;
  const seq = tagValue(buf, start, true, tags.get(0x1101));
  return { filmSim, filmModeRaw: filmMode, saturationRaw: saturation, sequence: seq };
}

function parseExif(buf, tiffStart, out) {
  const order = buf.toString('latin1', tiffStart, tiffStart + 2);
  const little = order === 'II';
  if (!little && order !== 'MM') return;
  const r = reader(buf, tiffStart, little);
  const ifd0 = readIfd(buf, tiffStart, little, r.u32(4));
  out.make = tagValue(buf, tiffStart, little, ifd0.tags.get(0x010f));
  out.model = tagValue(buf, tiffStart, little, ifd0.tags.get(0x0110));
  out.orientation = tagValue(buf, tiffStart, little, ifd0.tags.get(0x0112)) || 1;
  const exifPtr = tagValue(buf, tiffStart, little, ifd0.tags.get(0x8769));
  if (typeof exifPtr === 'number') {
    const exif = readIfd(buf, tiffStart, little, exifPtr);
    out.dateTime = tagValue(buf, tiffStart, little, exif.tags.get(0x9003));
    out.subSec = tagValue(buf, tiffStart, little, exif.tags.get(0x9291));
    out.width = tagValue(buf, tiffStart, little, exif.tags.get(0xa002));
    out.height = tagValue(buf, tiffStart, little, exif.tags.get(0xa003));
    const mn = exif.tags.get(0x927c);
    if (mn && r.ok(mn.off, mn.size)) Object.assign(out, parseFujiMakerNote(buf, tiffStart + mn.off, mn.size));
  }
}

function parseMpf(buf, tiffStart, segStartInFile, out) {
  const order = buf.toString('latin1', tiffStart, tiffStart + 2);
  const little = order === 'II';
  if (!little && order !== 'MM') return;
  const r = reader(buf, tiffStart, little);
  const { tags } = readIfd(buf, tiffStart, little, r.u32(4));
  const entry = tags.get(0xb002);
  if (!entry || !r.ok(entry.off, entry.size)) return;
  const n = Math.floor(entry.size / 16);
  let best = null;
  for (let i = 1; i < n; i++) {
    const e = entry.off + i * 16;
    const size = r.u32(e + 4);
    const offset = r.u32(e + 8);
    if (!size || !offset) continue;
    if (!best || size > best.length) best = { start: segStartInFile + offset, length: size };
  }
  if (best) out.preview = best;
}

// Parses header segments from a buffer that begins at file offset 0.
// Returns {needMore: bytes} if buffer is too short to reach SOS.
function parseHeader(buf) {
  const out = {};
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { error: 'not a jpeg' };
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return out;
    const marker = buf[p + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return out; // start of scan: done
    const len = buf.readUInt16BE(p + 2);
    const segEnd = p + 2 + len;
    if (segEnd > buf.length) return Object.assign(out, { needMore: segEnd + 4 });
    const data = p + 4;
    if (marker === 0xe1 && buf.toString('latin1', data, data + 6) === 'Exif\0\0') {
      parseExif(buf.subarray(0, segEnd), data + 6, out);
    } else if (marker === 0xe2 && buf.toString('latin1', data, data + 4) === 'MPF\0') {
      parseMpf(buf.subarray(0, segEnd), data + 4, data + 4, out);
    } else if (marker === 0xc0 || marker === 0xc2 || marker === 0xc1) {
      out.frameHeight = buf.readUInt16BE(data + 1);
      out.frameWidth = buf.readUInt16BE(data + 3);
    }
    p = segEnd;
  }
  return out;
}

async function readMeta(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    let size = 128 * 1024;
    for (let attempt = 0; attempt < 4; attempt++) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      const meta = parseHeader(buf.subarray(0, bytesRead));
      if (meta.needMore && bytesRead === size) {
        size = Math.max(meta.needMore, size * 2);
        continue;
      }
      delete meta.needMore;
      return meta;
    }
    return {};
  } finally {
    await fh.close();
  }
}

// Verify that the MPF preview range actually holds a JPEG (SOI marker).
async function validPreview(file, preview) {
  if (!preview) return false;
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(2);
    await fh.read(b, 0, 2, preview.start);
    return b[0] === 0xff && b[1] === 0xd8;
  } finally {
    await fh.close();
  }
}

// Returns a copy of the file's EXIF APP1 segment, patched for a re-encoded,
// already-upright image of the given size: Orientation -> 1, pixel dimensions
// updated, and the (now stale) IFD1 thumbnail unlinked. MakerNote is kept, so
// the film simulation and all camera data survive an edited export.
async function exifForEdited(file, width, height) {
  const fh = await fs.promises.open(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xff) {
    const marker = buf[p + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const len = buf.readUInt16BE(p + 2);
    if (p + 2 + len > buf.length) return null;
    if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const seg = Buffer.from(buf.subarray(p, p + 2 + len));
      const t = 10; // tiff header offset within seg
      const little = seg.toString('latin1', t, t + 2) === 'II';
      const r = reader(seg, t, little);
      const w16 = (o, v) => (little ? seg.writeUInt16LE(v, t + o) : seg.writeUInt16BE(v, t + o));
      const w32 = (o, v) => (little ? seg.writeUInt32LE(v, t + o) : seg.writeUInt32BE(v, t + o));
      const setTag = (ifdOff, tag, value) => {
        if (!r.ok(ifdOff, 2)) return;
        const n = r.u16(ifdOff);
        for (let i = 0; i < n; i++) {
          const e = ifdOff + 2 + i * 12;
          if (!r.ok(e, 12) || r.u16(e) !== tag) continue;
          const type = r.u16(e + 2);
          if (type === 3) w16(e + 8, value);
          else if (type === 4) w32(e + 8, value);
        }
      };
      const ifd0 = r.u32(4);
      setTag(ifd0, 0x0112, 1);
      const n0 = r.u16(ifd0);
      if (r.ok(ifd0 + 2 + n0 * 12, 4)) w32(ifd0 + 2 + n0 * 12, 0);
      const { tags } = readIfd(seg, t, little, ifd0);
      const exifPtr = tagValue(seg, t, little, tags.get(0x8769));
      if (typeof exifPtr === 'number') {
        setTag(exifPtr, 0xa002, width);
        setTag(exifPtr, 0xa003, height);
      }
      return seg;
    }
    p += 2 + len;
  }
  return null;
}

// Insert an APP1 segment directly after SOI, dropping any existing APP0/APP1
// the encoder wrote (browsers emit a JFIF APP0).
function graftSegment(jpeg, seg) {
  if (!seg || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  let p = 2;
  while (p + 4 <= jpeg.length && jpeg[p] === 0xff && (jpeg[p + 1] === 0xe0 || jpeg[p + 1] === 0xe1)) {
    p += 2 + jpeg.readUInt16BE(p + 2);
  }
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(p)]);
}

module.exports = { readMeta, parseHeader, validPreview, exifForEdited, graftSegment, FILM_MODES, MONO_MODES };
