'use strict';
// Black-box tests of the Rust server (`brackit --serve`), using synthetic
// Fujifilm-shaped JPEGs from fixture.js and the reference parser in
// jpeg-reader.js to check outputs. Build first: cargo build --release
// --no-default-features --manifest-path src-tauri/Cargo.toml

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseHeader } = require('./jpeg-reader');
const { buildJpeg, rational, slongs } = require('./fixture');

const BIN = process.env.BRACKIT_BIN || path.join(__dirname, '..', 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'brackit.exe' : 'brackit');

let proc;
let base;
let card;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brackit-'));

async function api(method, url, body, raw) {
  const r = await fetch(base + url, {
    method,
    headers: { 'X-Brackit': '1', ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: r.headers.get('content-type')?.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

test.before(async () => {
  card = path.join(tmp, 'card');
  const dcim = path.join(card, 'DCIM', '100_FUJI');
  fs.mkdirSync(dcim, { recursive: true });
  const shots = [
    ['DSCF0001.JPG', '2026:11:01 10:00:00', 0x600, 1],
    ['DSCF0002.JPG', '2026:11:01 10:00:00', 0x800, 1],
    ['DSCF0003.JPG', '2026:11:01 10:00:00', 0xb00, 1],
    ['DSCF0004.JPG', '2026:11:01 10:00:05', 0x000, 6],
    ['DSCF0006.JPG', '2026:11:01 10:01:00', 0x600, 1],
    ['DSCF0007.JPG', '2026:11:01 10:01:00', null, 1, 0x501],
    ['DSCF0008.JPG', '2026:11:01 10:01:00', 0xa00, 1],
  ];
  for (const [n, dt, fm, orientation, saturation] of shots) {
    fs.writeFileSync(path.join(dcim, n), buildJpeg({ dateTime: dt, filmMode: fm ?? undefined, saturation, orientation }));
  }
  // one shot with full camera settings and a film recipe in the maker note
  fs.writeFileSync(
    path.join(dcim, 'DSCF0003.JPG'),
    buildJpeg({
      dateTime: '2026:11:01 10:00:00',
      filmMode: 0xb00,
      exifExtra: [
        { tag: 0x829a, ...rational(1, 250) }, // 1/250 s
        { tag: 0x829d, ...rational(56, 10) }, // f/5.6
        { tag: 0x8827, type: 3, count: 1, value: 400 },
        { tag: 0x9204, ...rational(-1, 3, true) }, // −1/3 EV
        { tag: 0x920a, ...rational(23, 1) },
        { tag: 0xa405, type: 3, count: 1, value: 35 },
      ],
      makerExtra: [
        { tag: 0x1002, type: 3, count: 1, value: 0x100 }, // daylight
        { tag: 0x100a, ...slongs(40, -60) }, // R+2 B−3
        { tag: 0x1040, ...slongs(-16) }, // shadow +1
        { tag: 0x1041, ...slongs(8) }, // highlight −0.5
        { tag: 0x1047, ...slongs(0x20) }, // grain weak
        { tag: 0x104c, ...slongs(0x10) }, // small
        { tag: 0x1048, ...slongs(0x40) }, // color chrome strong
        { tag: 0x104e, ...slongs(0x20) }, // fx blue weak
        { tag: 0x1402, type: 3, count: 1, value: 0x200 }, // DR200
        { tag: 0x100f, ...slongs(-2000) }, // clarity −2
      ],
    })
  );
  const mov = path.join(dcim, 'DSCF0005.MOV');
  fs.writeFileSync(mov, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  fs.utimesSync(mov, new Date(2026, 10, 1, 10, 0, 30), new Date(2026, 10, 1, 10, 0, 30));
  fs.writeFileSync(path.join(dcim, '._DSCF0001.JPG'), Buffer.alloc(10));
  fs.writeFileSync(path.join(dcim, 'DSCF0001.RAF'), Buffer.from('FUJIFILMCCD-RAW fake raw'));

  proc = spawn(BIN, ['--serve', '--no-open', '--port', '0'], { env: { ...process.env, HOME: tmp, USERPROFILE: tmp } });
  base = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error('server did not start: ' + out)), 5000);
  });
});

test.after(() => proc && proc.kill());

let lib;
const byName = (n) => Object.values(lib.photos).find((p) => p.name === n);

test('groups brackets, labels film sims, keeps singles and videos apart', async () => {
  const r = await api('POST', '/api/open', { path: card });
  assert.equal(r.status, 200);
  lib = r.data;
  assert.deepEqual(
    lib.sets.map((s) => s.photos.map((id) => lib.photos[id].name)),
    [['DSCF0001.JPG', 'DSCF0002.JPG', 'DSCF0003.JPG'], ['DSCF0004.JPG'], ['DSCF0005.MOV'], ['DSCF0006.JPG', 'DSCF0007.JPG', 'DSCF0008.JPG']]
  );
  assert.equal(lib.sets[2].kind, 'video');
  assert.deepEqual(lib.sets[0].photos.map((id) => lib.photos[id].filmSim), ['Classic Chrome', 'Classic Neg.', 'Reala Ace']);
  assert.deepEqual(lib.sets[3].photos.map((id) => lib.photos[id].filmSim), ['Classic Chrome', 'Acros + R', 'Nostalgic Neg.']);
  const p = byName('DSCF0001.JPG');
  assert.equal(p.key, `DSCF0001.JPG:${p.size}:2026:11:01 10:00:00`);
  assert.equal(p.hasPreview, true);
  assert.equal(byName('DSCF0004.JPG').orientation, 6);
  // the bracket's RAF is attached to all three looks; RAWs aren't sets
  for (const id of lib.sets[0].photos) assert.equal(lib.photos[id].rawName, 'DSCF0001.RAF');
  assert.equal(byName('DSCF0004.JPG').rawName, null);
  assert.ok(!Object.values(lib.photos).some((p) => p.name.endsWith('.RAF')));
});

test('serves the embedded preview, with orientation grafted on', async () => {
  const r = await api('GET', `/api/img/${byName('DSCF0004.JPG').id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data[0], 0xff);
  assert.equal(r.data[1], 0xd8);
  assert.equal(parseHeader(r.data).orientation, 6);
  const full = await api('GET', `/api/img/${byName('DSCF0004.JPG').id}?full=1`);
  assert.deepEqual(full.data, fs.readFileSync(path.join(card, 'DCIM/100_FUJI/DSCF0004.JPG')));
});

test('serves the small EXIF thumbnail', async () => {
  const p = byName('DSCF0004.JPG');
  assert.equal(p.hasThumb, true);
  const r = await api('GET', `/api/img/${p.id}?thumb=1`);
  assert.equal(r.status, 200);
  assert.equal(r.data[0], 0xff);
  assert.equal(r.data[1], 0xd8);
  assert.equal(parseHeader(r.data).orientation, 6, 'orientation grafted on');
  assert.deepEqual([...r.data.subarray(-2)], [0xff, 0xd9]);
});

test('serves many thumbnails in one batch', async () => {
  const ids = ['DSCF0001.JPG', 'DSCF0004.JPG', 'DSCF0005.MOV'].map((n) => byName(n).id);
  const r = await api('GET', `/api/thumbs?ids=${ids.join(',')}`);
  const buf = r.data;
  const nl = buf.indexOf(10);
  const index = JSON.parse(buf.subarray(0, nl).toString());
  assert.deepEqual(index.map(([id]) => id), ids.slice(0, 2), 'videos are skipped');
  let off = nl + 1;
  for (const [, len] of index) {
    const jpg = buf.subarray(off, off + len);
    assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...jpg.subarray(-2)], [0xff, 0xd9]);
    off += len;
  }
  assert.equal(off, buf.length);
  const portrait = buf.subarray(nl + 1 + index[0][1], nl + 1 + index[0][1] + index[1][1]);
  assert.equal(parseHeader(portrait).orientation, 6, 'orientation grafted on');
});

test('reads camera settings and the film recipe', async () => {
  const r = await api('GET', `/api/info/${byName('DSCF0003.JPG').id}`);
  const rows = Object.fromEntries(r.data.rows);
  assert.equal(rows['Camera'], 'X100VI');
  assert.equal(rows['Exposure'], '1/250  ·  f/5.6  ·  ISO 400  ·  −⅓ EV');
  assert.equal(rows['Focal length'], '23mm (35mm equiv.)');
  assert.equal(rows['Film simulation'], 'Reala Ace');
  assert.equal(rows['Grain'], 'Weak, Small');
  assert.equal(rows['Color Chrome'], 'Strong');
  assert.equal(rows['Color Chrome FX Blue'], 'Weak');
  assert.equal(rows['White balance'], 'Daylight  ·  R+2 B−3');
  assert.equal(rows['Dynamic range'], 'DR200');
  assert.equal(rows['Highlight'], '−0.5');
  assert.equal(rows['Shadow'], '+1');
  assert.equal(rows['Clarity'], '−2');
  const plain = Object.fromEntries((await api('GET', `/api/info/${byName('DSCF0002.JPG').id}`)).data.rows);
  assert.deepEqual(Object.keys(plain), ['Camera', 'Film simulation'], 'only fields present are shown');
});

test('streams video with byte ranges', async () => {
  const id = byName('DSCF0005.MOV').id;
  const r = await fetch(`${base}/api/img/${id}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual([...Buffer.from(await r.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
});

test('exports originals byte-for-byte and skips ones already there', async () => {
  const dest = path.join(tmp, 'out');
  const ids = [byName('DSCF0002.JPG').id, byName('DSCF0005.MOV').id];
  const r = await api('POST', '/api/export', { dest, ids });
  const lines = r.data.toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.at(-1), { finished: true, copied: 2, skipped: 0, failed: [], dest });
  assert.deepEqual(fs.readFileSync(path.join(dest, 'DSCF0002.JPG')), fs.readFileSync(path.join(card, 'DCIM/100_FUJI/DSCF0002.JPG')));
  const again = await api('POST', '/api/export', { dest, ids });
  assert.equal(JSON.parse(again.data.toString().trim().split('\n').at(-1)).skipped, 2);
  const st = (await api('GET', '/api/state')).data;
  assert.ok(st.exported.includes(byName('DSCF0002.JPG').key));
});

test('exports the RAW once per set when asked', async () => {
  const dest = path.join(tmp, 'out-raw');
  const ids = lib.sets[0].photos.slice(0, 2); // two looks share one RAF
  const r = await api('POST', '/api/export', { dest, ids, rawFor: ids });
  const end = JSON.parse(r.data.toString().trim().split('\n').at(-1));
  assert.equal(end.copied, 3);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['DSCF0001.JPG', 'DSCF0001.RAF', 'DSCF0002.JPG']);
  const listed = (await api('GET', `/api/dest?path=${encodeURIComponent(dest)}`)).data.files;
  assert.equal(listed.find((f) => f.name === 'DSCF0001.RAF').kind, 'raw');
});

test('lists what is already in the export folder, with thumbnails', async () => {
  const dest = path.join(tmp, 'out');
  fs.writeFileSync(path.join(dest, 'notes.txt'), 'x');
  const r = (await api('GET', `/api/dest?path=${encodeURIComponent(dest)}`)).data;
  assert.equal(r.exists, true);
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['DSCF0002.JPG', 'DSCF0005.MOV']);
  assert.equal(r.files.find((f) => f.name === 'DSCF0005.MOV').kind, 'video');
  const t = await api('GET', `/api/dest-img?path=${encodeURIComponent(dest)}&name=DSCF0002.JPG`);
  assert.equal(t.status, 200);
  assert.deepEqual([...t.data.subarray(0, 2)], [0xff, 0xd8]);
  assert.ok(t.data.length < 100, 'serves the tiny embedded thumbnail, not the file');
  assert.equal((await api('GET', `/api/dest-img?path=${encodeURIComponent(dest)}&name=..%2Fcard%2Fx.JPG`)).status, 400);
  const missing = (await api('GET', `/api/dest?path=${encodeURIComponent(path.join(tmp, 'nope'))}`)).data;
  assert.deepEqual(missing, { dir: path.join(tmp, 'nope'), exists: false, files: [] });
});

test('edited export keeps EXIF + film sim, resets orientation and size', async () => {
  const dest = path.join(tmp, 'out2');
  const encoded = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
  const id = byName('DSCF0004.JPG').id;
  const r = await api('POST', `/api/export-edited?id=${id}&dest=${encodeURIComponent(dest)}&w=4000&h=3000`, encoded, true);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const out = fs.readFileSync(path.join(dest, 'DSCF0004.JPG'));
  const m = parseHeader(out);
  assert.equal(m.filmSim, 'Provia');
  assert.equal(m.orientation, 1);
  assert.equal(m.width, 4000);
  assert.equal(m.height, 3000);
  assert.equal(m.dateTime, '2026:11:01 10:00:05');
  assert.equal(out[3], 0xe1); // JFIF APP0 replaced by EXIF APP1
});

test('flags and edits persist', async () => {
  await api('PUT', '/api/flags', { flags: ['a', 'b'] });
  await api('PUT', '/api/edits', { edits: { a: { angle: 1.5, crop: { x: 0, y: 0, w: 1, h: 1 } } } });
  const st = (await api('GET', '/api/state')).data;
  assert.deepEqual(st.flags, ['a', 'b']);
  assert.equal(st.edits.a.angle, 1.5);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.brackit', 'state.json'), 'utf8'));
  assert.deepEqual(saved.flags, ['a', 'b']);
});

test('delete moves a set off the card and undo restores it', async () => {
  const dir = path.join(card, 'DCIM', '100_FUJI');
  const ids = lib.sets[0].photos;
  const before = fs.readdirSync(dir).sort();
  const r = await api('POST', '/api/delete', { ids });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'DSCF0001.JPG')));
  assert.ok(!fs.existsSync(path.join(dir, '._DSCF0001.JPG')), 'AppleDouble sidecar goes too');
  assert.ok(!fs.existsSync(path.join(dir, 'DSCF0001.RAF')), 'the RAW goes too');
  assert.ok(fs.existsSync(path.join(card, '.brackit-trash')));
  const u = await api('POST', '/api/undo-delete', { token: r.data.token });
  assert.equal(u.status, 200);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.ok(!fs.existsSync(path.join(card, '.brackit-trash')));
  const again = await api('POST', '/api/undo-delete', { token: r.data.token });
  assert.equal(again.status, 410);
});

test('rejects requests for other hosts', async () => {
  const http = require('http');
  const status = await new Promise((resolve) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: '/api/state', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test('survey summarises folders and days; open can be limited to either', async () => {
  const other = path.join(card, 'DCIM', '101_FUJI');
  fs.mkdirSync(other, { recursive: true });
  const day = new Date(2026, 9, 1, 12, 0, 0); // 1 Oct 2026, local time
  for (const [n, fm] of [['DSCF0101.JPG', 0x600], ['DSCF0102.JPG', 0x800]]) {
    const f = path.join(other, n);
    fs.writeFileSync(f, buildJpeg({ dateTime: '2026:10:01 12:00:00', filmMode: fm }));
    fs.utimesSync(f, day, day);
  }
  const sv = (await api('POST', '/api/survey', { path: card })).data;
  assert.equal(sv.total, 10, 'RAWs are not counted');
  const oct1 = sv.groups.filter((g) => g.day === '2026-10-01');
  assert.deepEqual(oct1, [{ folder: 'DCIM/101_FUJI', day: '2026-10-01', photos: 2, videos: 0 }]);
  const vids = sv.groups.filter((g) => g.videos).map((g) => [g.folder, g.day, g.videos]);
  assert.deepEqual(vids, [['DCIM/100_FUJI', '2026-11-01', 1]]);

  const byFolder = (await api('POST', '/api/open', { path: card, folder: 'DCIM/101_FUJI' })).data;
  assert.deepEqual(byFolder.sets.map((s) => s.photos.length), [2]);
  assert.equal(byFolder.scope.folder, 'DCIM/101_FUJI');
  assert.equal(byFolder.root, fs.realpathSync(card), 'root stays the card');

  const byDay = (await api('POST', '/api/open', { path: card, from: '2026-11-01', to: '2026-11-01' })).data;
  assert.deepEqual(Object.values(byDay.photos).map((p) => p.name).sort(), ['DSCF0005.MOV']);

  const all = (await api('POST', '/api/open', { path: card })).data;
  assert.equal(Object.keys(all.photos).length, 10);
  const lib2 = (await api('GET', '/api/library')).data;
  assert.equal(lib2.sets.length, all.sets.length, 'reloading the window gets the loaded library without rescanning');
});

test('ordinary folders are not ejectable and refuse to eject', async () => {
  const l = (await api('GET', '/api/library')).data;
  assert.ok(!(l.volume && l.volume.ejectable), 'a temp folder is not removable media');
  const r = await api('POST', '/api/eject', { path: card });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /isn't on a removable card/);
  assert.ok(fs.existsSync(card), 'nothing happened to the folder');
  assert.ok((await api('GET', '/api/library')).data.sets.length > 0, 'library still loaded');
});

test('since last import: survey finds what is new; open can load just that', async () => {
  const c2 = path.join(tmp, 'card2');
  const d = path.join(c2, 'DCIM', '100_FUJI');
  fs.mkdirSync(d, { recursive: true });
  const t = (h) => new Date(2026, 9, 20, h, 0, 0); // 20 Oct 2026, local
  const files = [['DSCF0201.JPG', 9], ['DSCF0202.JPG', 10], ['DSCF0203.JPG', 11], ['DSCF0204.JPG', 12]];
  for (const [n, h] of files) {
    const f = path.join(d, n);
    fs.writeFileSync(f, buildJpeg({ dateTime: `2026:10:20 ${h}:00:00`, filmMode: 0x600 }));
    fs.utimesSync(f, t(h), t(h));
  }
  let sv = (await api('POST', '/api/survey', { path: c2 })).data;
  assert.equal(sv.sinceLast, null, 'nothing exported from this card yet');
  const lib2 = (await api('POST', '/api/open', { path: c2 })).data;
  const id = Object.values(lib2.photos).find((p) => p.name === 'DSCF0202.JPG').id;
  await api('POST', '/api/export', { dest: path.join(tmp, 'out3'), ids: [id] });
  sv = (await api('POST', '/api/survey', { path: c2 })).data;
  assert.equal(sv.sinceLast.after, t(10).getTime());
  assert.equal(sv.sinceLast.count, 2);
  assert.equal(sv.sinceLast.firstDay, '2026-10-20');
  const fresh = (await api('POST', '/api/open', { path: c2, after: sv.sinceLast.after })).data;
  assert.deepEqual(Object.values(fresh.photos).map((p) => p.name).sort(), ['DSCF0203.JPG', 'DSCF0204.JPG']);
  assert.equal(fresh.scope.after, t(10).getTime());
});

test('cleanup delete can keep the RAW', async () => {
  const c3 = path.join(tmp, 'card3');
  const d = path.join(c3, 'DCIM', '100_FUJI');
  fs.mkdirSync(d, { recursive: true });
  for (const [n, fm] of [['DSCF0301.JPG', 0x600], ['DSCF0302.JPG', 0x800], ['DSCF0303.JPG', 0xb00]]) {
    fs.writeFileSync(path.join(d, n), buildJpeg({ dateTime: '2026:10:21 09:00:00', filmMode: fm }));
  }
  fs.writeFileSync(path.join(d, 'DSCF0301.RAF'), 'raw');
  const l = (await api('POST', '/api/open', { path: c3 })).data;
  const unpicked = l.sets[0].photos.slice(1); // keep look 1, remove looks 2 and 3
  const r = await api('POST', '/api/delete', { ids: unpicked, keepRaw: true });
  assert.equal(r.status, 200);
  assert.deepEqual(fs.readdirSync(d).sort(), ['DSCF0301.JPG', 'DSCF0301.RAF']);
  await api('POST', '/api/undo-delete', { token: r.data.token });
  assert.equal(fs.readdirSync(d).length, 4);
});

test('all metadata: every tag, focus point and faces for annotations', async () => {
  const c4 = path.join(tmp, 'card4');
  const d = path.join(c4, 'DCIM', '100_FUJI');
  fs.mkdirSync(d, { recursive: true });
  const shorts = (...v) => {
    const b = Buffer.alloc(2 * v.length);
    v.forEach((x, i) => b.writeUInt16LE(x, i * 2));
    return { type: 3, count: v.length, value: b };
  };
  fs.writeFileSync(
    path.join(d, 'DSCF0401.JPG'),
    buildJpeg({
      dateTime: '2026:10:22 09:00:00',
      filmMode: 0x800,
      exifExtra: [{ tag: 0x8827, type: 3, count: 1, value: 800 }],
      makerExtra: [
        { tag: 0x1023, ...shorts(3864, 2576) }, // focus pixel
        { tag: 0x4100, type: 3, count: 1, value: 1 },
        { tag: 0x4103, ...shorts(1000, 800, 1600, 1500) }, // one face
        { tag: 0x1431, type: 4, count: 1, value: 4 }, // in-camera rating
      ],
    })
  );
  const l = (await api('POST', '/api/open', { path: c4 })).data;
  const p = Object.values(l.photos)[0];
  assert.equal(p.camRating, 4, 'in-camera rating is read at scan time');
  const m = (await api('GET', `/api/meta/${p.id}`)).data;
  const byName = Object.fromEntries(m.tags.map((t) => [`${t.group}:${t.name}`, t.value]));
  assert.equal(byName['Image:Make'], 'FUJIFILM');
  assert.equal(byName['Image:Model'], 'X100VI');
  assert.equal(byName['Exif:ISO'], '800');
  assert.equal(byName['Exif:Date/time original'], '2026:10:22 09:00:00');
  assert.equal(byName['Fujifilm:Film mode'], '2048');
  assert.equal(byName['Fujifilm:Focus pixel'], '3864 2576');
  assert.deepEqual(m.focus, [3864, 2576]);
  assert.deepEqual(m.faces, [[1000, 800, 1600, 1500]]);
  assert.equal(m.width, 7728);
  assert.equal(m.rating, 4);
});

test('export-folder library: browse, rate, flag, move to trash', async () => {
  const outDir = path.join(tmp, 'out'); // has files from the export tests
  const r = await api('POST', '/api/out/open', { path: outDir });
  assert.equal(r.status, 200);
  const names = Object.values(r.data.photos).map((p) => p.name).sort();
  assert.ok(names.includes('DSCF0002.JPG'), names.join(','));
  const p = Object.values(r.data.photos).find((x) => x.name === 'DSCF0002.JPG');
  const img = await api('GET', `/api/img/${p.id}?src=out&thumb=1`);
  assert.deepEqual([...img.data.subarray(0, 2)], [0xff, 0xd8], 'images are served from the export folder');
  await api('POST', '/api/rate', { key: p.key, stars: 4 });
  await api('POST', '/api/rate', { key: p.key, flag: true });
  let st = (await api('GET', '/api/state')).data;
  assert.equal(st.ratings[p.key], 4);
  assert.deepEqual(st.flagged, [p.key]);
  await api('POST', '/api/rate', { key: p.key, stars: 0, flag: false });
  st = (await api('GET', '/api/state')).data;
  assert.equal(st.ratings[p.key], undefined);
  assert.deepEqual(st.flagged, []);
  const t = (await api('POST', '/api/out/trash', { ids: [p.id] })).data;
  assert.deepEqual(t.failed, []);
  assert.deepEqual(t.moved, [p.id]);
  assert.ok(!fs.existsSync(path.join(outDir, 'DSCF0002.JPG')), 'file left the export folder');
  assert.equal((await api('POST', '/api/out/open', { path: path.join(tmp, 'nope') })).status, 404);
});

test("only Brackit's own page can change anything", async () => {
  // a request from another website (foreign Origin) is refused
  let r = await fetch(`${base}/api/flags`, { method: 'PUT', headers: { 'X-Brackit': '1', Origin: 'https://evil.example' }, body: '{"flags":[]}' });
  assert.equal(r.status, 403);
  // a "simple" cross-site POST can't add the header: refused too
  r = await fetch(`${base}/api/delete`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"ids":["x"]}' });
  assert.equal(r.status, 403);
  // our own origin is fine
  r = await fetch(`${base}/api/flags`, { method: 'PUT', headers: { 'X-Brackit': '1', Origin: base, 'Content-Type': 'application/json' }, body: '{"flags":[]}' });
  assert.equal(r.status, 200);
});

test('ids are stable across scans and differ between files', async () => {
  const a = (await api('POST', '/api/open', { path: card })).data;
  const b = (await api('POST', '/api/open', { path: card, folder: 'DCIM/100_FUJI' })).data;
  const ida = Object.fromEntries(Object.values(a.photos).map((p) => [p.rel, p.id]));
  for (const p of Object.values(b.photos)) assert.equal(p.id, ida[p.rel], p.rel);
  assert.equal(new Set(Object.values(ida)).size, Object.keys(ida).length);
});

test('undo still works after reopening the card mid-window', async () => {
  const l = (await api('POST', '/api/open', { path: card })).data;
  const set = l.sets.find((s) => s.photos.length === 1 && l.photos[s.photos[0]].kind === 'photo');
  const file = path.join(card, l.photos[set.photos[0]].rel);
  const d = (await api('POST', '/api/delete', { ids: set.photos })).data;
  assert.ok(!fs.existsSync(file));
  await api('POST', '/api/open', { path: card }); // e.g. pressing O to choose other dates
  const u = await api('POST', '/api/undo-delete', { token: d.token });
  assert.equal(u.status, 200);
  assert.ok(fs.existsSync(file), 'the file came back');
});

test('export: same name and size but a different file is not "already there"', async () => {
  const dest = path.join(tmp, 'out-collide');
  fs.mkdirSync(dest, { recursive: true });
  const l = (await api('GET', '/api/library')).data;
  const p = Object.values(l.photos).find((x) => x.kind === 'photo');
  const src = fs.readFileSync(path.join(card, p.rel));
  // a different photo with the same name and size, from another card
  const other = Buffer.from(src);
  other[other.length - 3] ^= 0xff;
  fs.writeFileSync(path.join(dest, p.name), other);
  fs.utimesSync(path.join(dest, p.name), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const r = await api('POST', '/api/export', { dest, ids: [p.id] });
  const end = JSON.parse(r.data.toString().trim().split('\n').at(-1));
  assert.equal(end.copied, 1, 'copied under a new name instead of being skipped');
  const names = fs.readdirSync(dest).sort();
  assert.ok(names.some((n) => /-1\./.test(n)), names.join(','));
  assert.ok(!names.some((n) => n.endsWith('.partial')), 'no temporary files left');
});
