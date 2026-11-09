'use strict';
// Builds Fujifilm-shaped JPEGs for tests: EXIF (IFD0 + ExifIFD + FUJIFILM
// MakerNote) and an MPF APP2 pointing at an embedded preview JPEG.

// Minimal stand-in for JPEG entropy-coded data when no real image is given.
const FAKE_IMAGE = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 1, 2, 3, 4, 0xff, 0xd9]);

function ifd(entries, base, extraStart) {
  // entries: [{tag, type, count, value(Buffer|number)}], little endian.
  // Returns {buf, extra}: the IFD and its out-of-line data, placed at
  // absolute tiff offsets base / extraStart.
  entries.sort((a, b) => a.tag - b.tag);
  const head = Buffer.alloc(2 + entries.length * 12 + 4);
  head.writeUInt16LE(entries.length, 0);
  const extras = [];
  let ex = extraStart;
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    head.writeUInt16LE(e.tag, o);
    head.writeUInt16LE(e.type, o + 2);
    head.writeUInt32LE(e.count, o + 4);
    if (Buffer.isBuffer(e.value)) {
      if (e.value.length <= 4) e.value.copy(head, o + 8);
      else {
        head.writeUInt32LE(ex, o + 8);
        extras.push(e.value);
        ex += e.value.length + (e.value.length % 2);
        if (e.value.length % 2) extras.push(Buffer.alloc(1));
      }
    } else if (e.type === 3) head.writeUInt16LE(e.value, o + 8);
    else head.writeUInt32LE(e.value, o + 8);
  });
  return { buf: head, extra: Buffer.concat(extras), end: ex };
}

const ascii = (s) => Buffer.from(s + '\0', 'latin1');

function makerNote({ filmMode, saturation, makerExtra = [] }) {
  const entries = [{ tag: 0x0000, type: 7, count: 4, value: Buffer.from('0130') }, ...makerExtra];
  if (saturation != null) entries.push({ tag: 0x1003, type: 3, count: 1, value: saturation });
  if (filmMode != null) entries.push({ tag: 0x1401, type: 3, count: 1, value: filmMode });
  const hdr = Buffer.alloc(12);
  hdr.write('FUJIFILM', 0, 'latin1');
  hdr.writeUInt32LE(12, 8);
  const d = ifd(entries, 12, 12 + 2 + entries.length * 12 + 4);
  return Buffer.concat([hdr, d.buf, d.extra]);
}

const FAKE_THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function exifApp1({ dateTime, subSec, orientation = 1, filmMode, saturation, model = 'X100VI', width = 7728, height = 5152, thumb = FAKE_THUMB, exifExtra = [], makerExtra = [] }) {
  // Layout (tiff offsets): 8 IFD0 | IFD0 extra | ExifIFD | Exif extra
  const ifd0Entries = [
    { tag: 0x010f, type: 2, count: 9, value: ascii('FUJIFILM') },
    { tag: 0x0110, type: 2, count: model.length + 1, value: ascii(model) },
    { tag: 0x0112, type: 3, count: 1, value: orientation },
    { tag: 0x8769, type: 4, count: 1, value: 0 }, // patched below
  ];
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  let d0 = ifd(ifd0Entries.map((e) => ({ ...e })), 8, 8 + ifd0Size);
  const exifStart = d0.end + (d0.end % 2);
  ifd0Entries[3].value = exifStart;
  d0 = ifd(ifd0Entries, 8, 8 + ifd0Size);
  const mn = makerNote({ filmMode, saturation, makerExtra });
  const exifEntries = [
    { tag: 0x9003, type: 2, count: 20, value: ascii(dateTime) },
    { tag: 0x927c, type: 7, count: mn.length, value: mn },
    { tag: 0xa002, type: 4, count: 1, value: width },
    { tag: 0xa003, type: 4, count: 1, value: height },
  ];
  if (subSec) exifEntries.push({ tag: 0x9291, type: 2, count: subSec.length + 1, value: ascii(subSec) });
  exifEntries.push(...exifExtra);
  const exifSize = 2 + exifEntries.length * 12 + 4;
  const de = ifd(exifEntries, exifStart, exifStart + exifSize);
  const tiffHead = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  const pad0 = Buffer.alloc(exifStart - (8 + d0.buf.length + d0.extra.length));
  // IFD1: the small thumbnail, linked from IFD0's next-IFD pointer
  let ifd1Start = exifStart + de.buf.length + de.extra.length;
  ifd1Start += ifd1Start % 2;
  const ifd1Size = 2 + 2 * 12 + 4;
  const d1 = ifd(
    [
      { tag: 0x0201, type: 4, count: 1, value: ifd1Start + ifd1Size },
      { tag: 0x0202, type: 4, count: 1, value: thumb.length },
    ],
    ifd1Start,
    ifd1Start + ifd1Size
  );
  d0.buf.writeUInt32LE(ifd1Start, d0.buf.length - 4);
  const pad1 = Buffer.alloc(ifd1Start - (exifStart + de.buf.length + de.extra.length));
  const tiff = Buffer.concat([tiffHead, d0.buf, d0.extra, pad0, de.buf, de.extra, pad1, d1.buf, thumb]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.from([0xff, 0xe1, 0, 0]);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

function mpfApp2(previewOffset, previewSize, mainSize) {
  // MP Index IFD with MPEntry (2 entries x 16 bytes), little endian.
  const entries = Buffer.alloc(32);
  entries.writeUInt32LE(0x030000, 0);
  entries.writeUInt32LE(mainSize, 4);
  entries.writeUInt32LE(0, 8);
  entries.writeUInt32LE(0x010001, 16);
  entries.writeUInt32LE(previewSize, 20);
  entries.writeUInt32LE(previewOffset, 24);
  const d = ifd(
    [
      { tag: 0xb000, type: 7, count: 4, value: Buffer.from('0100') },
      { tag: 0xb001, type: 4, count: 1, value: 2 },
      { tag: 0xb002, type: 7, count: 32, value: entries },
    ],
    8,
    8 + 2 + 3 * 12 + 4
  );
  const tiff = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]), d.buf, d.extra]);
  const payload = Buffer.concat([Buffer.from('MPF\0', 'latin1'), tiff]);
  const seg = Buffer.from([0xff, 0xe2, 0, 0]);
  seg.writeUInt16BE(payload.length + 2, 2);
  return seg.length === 4 ? Buffer.concat([seg, payload]) : null;
}

// image: optional real JPEG (Buffer) for the main picture; preview: optional
// real JPEG for the MPF preview.
function buildJpeg(meta, { image, preview, thumb } = {}) {
  const app1 = exifApp1({ ...meta, ...(thumb ? { thumb } : {}) });
  const body = image ? image.subarray(2) : FAKE_IMAGE; // drop SOI of the real image
  const prev = preview || Buffer.concat([Buffer.from([0xff, 0xd8]), FAKE_IMAGE]);
  // MPF segment size is constant, compute with placeholder then patch.
  const probe = mpfApp2(0, 0, 0);
  const mpfTiffStart = 2 + app1.length + 4 + 4; // SOI + APP1 + (FFE2 len) + 'MPF\0'
  const mainSize = 2 + app1.length + probe.length + body.length;
  const app2 = mpfApp2(mainSize - mpfTiffStart, prev.length, mainSize);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app2, body, prev]);
}

module.exports = { buildJpeg, exifApp1 };

// helpers for EXIF values in tests
const rational = (num, den, signed = false) => {
  const b = Buffer.alloc(8);
  signed ? b.writeInt32LE(num, 0) : b.writeUInt32LE(num, 0);
  signed ? b.writeInt32LE(den, 4) : b.writeUInt32LE(den, 4);
  return { type: signed ? 10 : 5, count: 1, value: b };
};
const slongs = (...vals) => {
  const b = Buffer.alloc(4 * vals.length);
  vals.forEach((v, i) => b.writeInt32LE(v, i * 4));
  return { type: 9, count: vals.length, value: b };
};
module.exports.rational = rational;
module.exports.slongs = slongs;
