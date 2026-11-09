'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseHeader, readMeta, validPreview, exifForEdited, graftSegment } = require('../server/jpeg');
const { orientationSegment } = require('../server');
const { Library } = require('../server/library');
const { buildJpeg } = require('./fixture');

test('reads film simulation, date, orientation and MPF preview', async () => {
  const buf = buildJpeg({ dateTime: '2026:11:01 10:00:00', filmMode: 0x600, orientation: 6 });
  const m = parseHeader(buf);
  assert.equal(m.filmSim, 'Classic Chrome');
  assert.equal(m.dateTime, '2026:11:01 10:00:00');
  assert.equal(m.orientation, 6);
  assert.equal(m.model, 'X100VI');
  assert.ok(m.preview);
  assert.equal(buf[m.preview.start], 0xff);
  assert.equal(buf[m.preview.start + 1], 0xd8);
  assert.equal(m.preview.start + m.preview.length, buf.length);
});

test('monochrome sims come from the saturation tag', () => {
  const acros = parseHeader(buildJpeg({ dateTime: '2026:11:01 10:00:00', saturation: 0x501 }));
  assert.equal(acros.filmSim, 'Acros + R');
  const neg = parseHeader(buildJpeg({ dateTime: '2026:11:01 10:00:00', filmMode: 0x800, saturation: 0x8000 }));
  assert.equal(neg.filmSim, 'Classic Neg.');
});

test('groups film-simulation brackets and leaves singles and videos alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brackit-'));
  const dcim = path.join(dir, 'DCIM', '100_FUJI');
  fs.mkdirSync(dcim, { recursive: true });
  const shots = [
    ['DSCF0001.JPG', '2026:11:01 10:00:00', 0x600],
    ['DSCF0002.JPG', '2026:11:01 10:00:00', 0x800],
    ['DSCF0003.JPG', '2026:11:01 10:00:00', 0xb00],
    ['DSCF0004.JPG', '2026:11:01 10:00:05', 0x000],
    ['DSCF0006.JPG', '2026:11:01 10:01:00', 0x600],
    ['DSCF0007.JPG', '2026:11:01 10:01:00', 0x800],
    ['DSCF0008.JPG', '2026:11:01 10:01:00', 0xb00],
  ];
  for (const [n, dt, fm] of shots) fs.writeFileSync(path.join(dcim, n), buildJpeg({ dateTime: dt, filmMode: fm }));
  fs.writeFileSync(path.join(dcim, 'DSCF0005.MOV'), Buffer.alloc(100));
  fs.utimesSync(path.join(dcim, 'DSCF0005.MOV'), new Date(2026, 10, 1, 10, 0, 30), new Date(2026, 10, 1, 10, 0, 30));
  fs.writeFileSync(path.join(dcim, '._DSCF0001.JPG'), Buffer.alloc(10));
  const lib = new Library();
  const s = await lib.scan(dir);
  assert.deepEqual(
    s.sets.map((set) => set.photos.map((id) => s.photos[id].name)),
    [
      ['DSCF0001.JPG', 'DSCF0002.JPG', 'DSCF0003.JPG'],
      ['DSCF0004.JPG'],
      ['DSCF0005.MOV'],
      ['DSCF0006.JPG', 'DSCF0007.JPG', 'DSCF0008.JPG'],
    ]
  );
  assert.equal(s.sets[2].kind, 'video');
  assert.deepEqual(s.sets[0].photos.map((id) => s.photos[id].filmSim), ['Classic Chrome', 'Classic Neg.', 'Reala Ace']);
  const file = path.join(dcim, 'DSCF0001.JPG');
  assert.ok(await validPreview(file, (await readMeta(file)).preview));
});

test('orientation segment parses back', () => {
  const seg = orientationSegment(8);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg, Buffer.from([0xff, 0xd9])]);
  assert.equal(parseHeader(jpeg).orientation, 8);
});

test('edited export keeps EXIF + film sim, resets orientation and size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brackit-'));
  const file = path.join(dir, 'a.jpg');
  fs.writeFileSync(file, buildJpeg({ dateTime: '2026:11:01 10:00:00', filmMode: 0xa00, orientation: 6 }));
  const seg = await exifForEdited(file, 4000, 3000);
  const encoded = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
  const out = graftSegment(encoded, seg);
  const m = parseHeader(out);
  assert.equal(m.filmSim, 'Nostalgic Neg.');
  assert.equal(m.orientation, 1);
  assert.equal(m.width, 4000);
  assert.equal(m.height, 3000);
  assert.equal(m.dateTime, '2026:11:01 10:00:00');
  assert.equal(out[2], 0xff);
  assert.equal(out[3], 0xe1); // JFIF APP0 replaced by EXIF APP1
});
