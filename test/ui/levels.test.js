'use strict';
/* Levels (V): black, grey and white points over a live histogram.

   - the panel works by mouse and by keys, and changes the photo live;
   - what you see is what you export: the on-screen GPU filter and the
     pixels written on export come from the same table;
   - the export is re-encoded (darker where the black point moved) with the
     camera's metadata kept; the card is untouched;
   - crop and levels never wipe each other; Cancel puts the photo back.

   Run: npm run build:cli && npm run test:ui */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { buildJpeg } = require('../fixture');

const BIN = process.env.BRACKIT_BIN || path.join(__dirname, '..', '..', 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'brackit.exe' : 'brackit');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brackit-levels-'));
const card = path.join(tmp, 'card');
const out = path.join(tmp, 'out');
let browser;
let server;
let base;

test.before(async () => {
  browser = await chromium.launch(process.env.BRACKIT_CHROMIUM ? { executablePath: process.env.BRACKIT_CHROMIUM } : {});
  const page = await browser.newPage();
  // a smooth ramp with some colour: every level is present
  const scenes = await page.evaluate(() => {
    const render = (w, h, hue) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#000');
      g.addColorStop(0.5, `hsl(${hue},40%,50%)`);
      g.addColorStop(1, '#fff');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.92).split(',')[1];
    };
    return [20, 140, 260].map((h) => ({ big: render(1500, 1000, h), prev: render(1200, 800, h), thumb: render(160, 107, h) }));
  });
  await page.close();
  const dir = path.join(card, 'DCIM', '100_FUJI');
  fs.mkdirSync(dir, { recursive: true });
  const sims = [0x600, 0x800, 0xb00];
  let n = 1;
  for (let s = 0; s < 3; s++) {
    const d = new Date(2026, 9, 1, 9, s, 0);
    for (let look = 0; look < 3; look++) {
      const f = path.join(dir, `DSCF${String(n++).padStart(4, '0')}.JPG`);
      const b = (x) => Buffer.from(x, 'base64');
      fs.writeFileSync(f, buildJpeg({ dateTime: `2026:10:01 09:0${s}:00`, filmMode: sims[look] }, { image: b(scenes[look].big), preview: b(scenes[look].prev), thumb: b(scenes[look].thumb) }));
      fs.utimesSync(f, d, d);
    }
  }
  server = spawn(BIN, ['--serve', '--no-open', '--port', '0'], { env: { ...process.env, HOME: tmp, USERPROFILE: tmp } });
  base = await new Promise((resolve, reject) => {
    let o = '';
    server.stdout.on('data', (d) => {
      o += d;
      const m = o.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    setTimeout(() => reject(new Error('server did not start: ' + o)), 5000);
  });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

async function openCard() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?open=${encodeURIComponent(card)}`);
  await page.waitForSelector('#survey:not([hidden])');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.evaluate(() => {
    S.flags.clear();
    S.edits = {};
    saveFlags();
    saveEdits();
    S.idx = 0;
    render();
  });
  await page.waitForTimeout(600);
  return { page, errors };
}

const lvOf = (page, i) => page.evaluate((i) => (S.edits[photo(S.view[S.idx].photos[i]).key] || {}).levels || null, i);

test('the panel: drag and keys change the photo live; Done keeps, Cancel restores', async () => {
  const { page, errors } = await openCard();
  await page.keyboard.press('2'); // pick look 2
  await page.keyboard.press('v');
  await page.waitForSelector('#levels:not([hidden])');
  assert.equal(await page.evaluate(() => S.solo && S.solo.pos), 1, 'opens on the picked look, in the large view');
  await page.waitForFunction(() => LV && LV.sample && LV.gl);
  assert.ok(await page.evaluate(() => $('#solo-frame').firstElementChild === LV.gl.canvas), 'the GPU preview is on screen');

  // keys: Tab to white, then black; move them
  assert.equal(await page.evaluate(() => LV.sel), 'g');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Tab');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
  assert.deepEqual(await page.evaluate(() => [LV.b, LV.w, LV.g]), [40, 235, 1]);
  // the flip keys don't flip while Levels is open
  assert.equal(await page.evaluate(() => S.idx), 0);
  // drag the grey point left of middle: brighter (grey above 1)
  const track = await page.locator('#levels-track').boundingBox();
  const greyX = await page.evaluate(() => greyAt(LV) / 255);
  await page.mouse.move(track.x + greyX * track.width, track.y + 10);
  await page.mouse.down();
  await page.mouse.move(track.x + (greyX - 0.08) * track.width, track.y + 10, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const g = await page.evaluate(() => LV.g);
  assert.ok(g > 1.2 && g < 2.5, `grey ${g}`);
  // pressing on the histogram itself, near a point, grabs that point
  const hist = await page.locator('#levels-hist').boundingBox();
  const bx = await page.evaluate(() => LV.b / 255);
  await page.mouse.move(hist.x + bx * hist.width + 4, hist.y + hist.height / 2);
  await page.mouse.down();
  await page.mouse.move(hist.x + bx * hist.width - 6, hist.y + hist.height / 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => LV.sel), 'b', 'the black point, from a press on the histogram');
  const b2 = await page.evaluate(() => LV.b);
  assert.ok(b2 < 40 && b2 > 25, `black ${b2}`);
  await page.evaluate(() => {
    LV.b = 40;
    updateLevels();
  });
  // what the GPU shows is the export table, pixel for pixel (±1)
  const worst = await page.evaluate(() => {
    const src = renderEdited(imageCache.get(previewUrl(LV.id)).img, IDENTITY, 2048);
    const want = bakeLevels(src, LV).getContext('2d').getImageData(0, 0, src.width, src.height).data;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').drawImage(LV.gl.canvas, 0, 0);
    const got = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let w = 0;
    for (let i = 0; i < got.length; i += 4 * 97) for (let k = 0; k < 3; k++) w = Math.max(w, Math.abs(got[i + k] - want[i + k]));
    return w;
  });
  assert.ok(worst <= 1, `GPU preview differs from the export by up to ${worst} levels`);
  assert.match(await page.textContent('#lv-clip'), /clipped: .*black.*white/);

  // Cancel: nothing kept, the photo back as it was
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#levels'), true);
  assert.equal(await lvOf(page, 1), null);
  assert.equal(await page.evaluate(() => $('#solo-frame').firstElementChild.style.filter), '');

  // again, and keep it
  await page.keyboard.press('v');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction(() => LV && LV.gl);
  await page.keyboard.press('Enter');
  assert.deepEqual(await lvOf(page, 1), { b: 40, g: 1, w: 255 });
  assert.equal(await lvOf(page, 0), null, 'levels are per look');
  // the GPU copy stands in (already right) until the sharp levelled copy is made
  await page.waitForFunction(() => {
    const n = $('#solo-frame').firstElementChild;
    return n && n.dataset.baked === '1' && !n.classList.contains('levels-gl');
  });
  assert.match(await page.textContent('#solo-caption'), /levels/);
  await page.keyboard.press(' '); // back to the 3-up: the look shows its levels there too
  await page.waitForTimeout(300);
  // (there as levelled pixels: a copy made ahead, not a filter)
  await page.waitForFunction(() => $('#stage .look:nth-child(2) .frame').firstElementChild.dataset.baked === '1');
  assert.equal(await page.evaluate(() => $('#stage .look:nth-child(2) .frame').firstElementChild.style.filter), '');

  // a crop afterwards keeps the levels, and levels keep the crop
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  await page.keyboard.press('3');
  await page.keyboard.press('Enter');
  const e = await page.evaluate(() => S.edits[photo(S.view[S.idx].photos[1]).key]);
  assert.deepEqual(e.levels, { b: 40, g: 1, w: 255 });
  assert.equal(e.aspect, '1');
  assert.ok(await page.evaluate(() => !!cropOf(photo(S.view[S.idx].photos[0])) && !levelsOf(photo(S.view[S.idx].photos[0]))), 'crop shared, levels not');
  assert.deepEqual(errors, []);
  await page.close();
});

test('what you see is what you export: the screen filter and the export table agree', async () => {
  const { page, errors } = await openCard();
  const lv = { b: 30, g: 1.6, w: 220 };
  // a 256-step grey ramp, shown with the levels filter, then photographed
  await page.evaluate((lv) => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 8;
    c.id = 'ramp';
    const x = c.getContext('2d');
    for (let i = 0; i < 256; i++) {
      x.fillStyle = `rgb(${i},${i},${i})`;
      x.fillRect(i, 0, 1, 8);
    }
    c.style.cssText = `position:fixed;left:0;top:0;z-index:999;filter:${levelsFilter(lv)}`;
    document.body.append(c);
  }, lv);
  const png = (await page.locator('#ramp').screenshot()).toString('base64');
  const [screen, baked, table] = await page.evaluate(
    async ([png, lv]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + png;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const row = c.getContext('2d').getImageData(0, 4, 256, 1).data;
      const shot = [];
      for (let i = 0; i < 256; i++) shot.push(row[i * 4]);
      const ramp = document.querySelector('#ramp');
      const copy = document.createElement('canvas');
      copy.width = 256;
      copy.height = 8;
      copy.getContext('2d').drawImage(ramp, 0, 0); // (drawing ignores the CSS filter)
      bakeLevels(copy, lv);
      const b = copy.getContext('2d').getImageData(0, 4, 256, 1).data;
      return [shot, Array.from({ length: 256 }, (_, i) => b[i * 4]), Array.from(levelsLut(lv))];
    },
    [png, lv]
  );
  assert.deepEqual(baked, table, 'export = the table exactly');
  const worst = Math.max(...screen.map((v, i) => Math.abs(v - table[i])));
  assert.ok(worst <= 2, `screen differs from export by up to ${worst} levels`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('export: levels are written into the copy, with the camera data kept; the card is untouched', async () => {
  const { page, errors } = await openCard();
  const before = fs.readdirSync(path.join(card, 'DCIM', '100_FUJI')).map((f) => [f, fs.statSync(path.join(card, 'DCIM', '100_FUJI', f)).size]);
  await page.keyboard.press('j'); // set 2: DSCF0004–6
  await page.keyboard.press('1');
  await page.evaluate(() => {
    setEdit(photo(S.view[S.idx].photos[0]).key, { levels: { b: 60, g: 1, w: 255 } });
    saveEdits();
  });
  await page.evaluate((out) => (S.dest = out), out);
  await page.keyboard.press('s');
  await page.waitForSelector('#staged:not([hidden])');
  await page.waitForFunction(() => /1 edited/.test($('#staged-summary').textContent));
  await page.keyboard.press('e');
  await page.waitForFunction(() => /Copied/.test($('#export-result').textContent), null, { timeout: 15000 });
  const orig = fs.readFileSync(path.join(card, 'DCIM', '100_FUJI', 'DSCF0004.JPG'));
  const made = fs.readFileSync(path.join(out, 'DSCF0004.JPG'));
  assert.notEqual(made.length, orig.length, 're-encoded');
  assert.ok(made.includes(Buffer.from('FUJIFILM')), 'camera metadata kept');
  // the left third of the ramp (dark) is darker still; the light end isn't
  const [a, b] = await page.evaluate(
    async ([x, y]) => {
      const stats = async (b64) => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }));
        const c = document.createElement('canvas');
        c.width = 300;
        c.height = 200;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0, 300, 200);
        const at = (fx) => ctx.getImageData(Math.round(fx * 299), 100, 1, 1).data[1];
        return [at(0.15), at(0.95)];
      };
      return [await stats(x), await stats(y)];
    },
    [orig.toString('base64'), made.toString('base64')]
  );
  assert.ok(b[0] < a[0] - 10, `shadows darker: ${a[0]} → ${b[0]}`);
  assert.ok(Math.abs(b[1] - a[1]) <= 6, `highlights kept: ${a[1]} → ${b[1]}`);
  const after = fs.readdirSync(path.join(card, 'DCIM', '100_FUJI')).map((f) => [f, fs.statSync(path.join(card, 'DCIM', '100_FUJI', f)).size]);
  assert.deepEqual(after, before, 'card untouched');
  assert.deepEqual(errors, []);
  await page.close();
});
