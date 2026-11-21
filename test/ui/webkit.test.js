'use strict';
/* WebKit (Safari, iPhone and iPad, the Mac app): after every flip, every
   frame holds a picture that is drawn, in colour, right away.

   Pictures are loaded with decoding="async". In WebKit an element marked so
   isn't painted with the page: it's painted later, on its own, blank or
   half-done at first (on iPhone a grey picture until the colour arrived), and
   copies of an element inherit the setting. Pictures put on screen are marked
   "sync" (onScreen() in app.js); this test catches a path that forgets.

   Run: npm run build:cli && npm run test:ui (needs Playwright's WebKit:
   npx playwright install --with-deps webkit) */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { webkit, chromium } = require('playwright');
const { buildJpeg } = require('../fixture');

const BIN = process.env.BRACKIT_BIN || path.join(__dirname, '..', '..', 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'brackit.exe' : 'brackit');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brackit-webkit-'));
const card = path.join(tmp, 'card');
let browser;
let server;
let base;

test.before(async () => {
  // colourful scenes, made in a browser (any engine will do)
  const maker = await chromium.launch();
  const page = await maker.newPage();
  const scenes = await page.evaluate(() => {
    const render = (w, h, seed) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      for (let i = 0; i < 30; i++) {
        x.fillStyle = `hsl(${(seed * 50 + i * 37) % 360},70%,${35 + (i % 4) * 10}%)`;
        x.fillRect(((i * 97) % 100) * w / 100, ((i * 61) % 100) * h / 100, w / 4, h / 3);
      }
      return c.toDataURL('image/jpeg', 0.85).split(',')[1];
    };
    return [0, 1, 2, 3].map((s) => ({ big: render(2400, 1600, s), prev: render(1920, 1280, s), thumb: render(160, 107, s) }));
  });
  await maker.close();
  const dir = path.join(card, 'DCIM', '100_FUJI');
  fs.mkdirSync(dir, { recursive: true });
  const b = (x) => Buffer.from(x, 'base64');
  let n = 1;
  for (let s = 0; s < 16; s++) {
    const d = new Date(2026, 9, 1, 9, s, 0);
    for (let look = 0; look < 3; look++) {
      const f = path.join(dir, `DSCF${String(n++).padStart(4, '0')}.JPG`);
      const sc = (s + look) % 4;
      fs.writeFileSync(f, buildJpeg({ dateTime: `2026:10:01 09:${String(s).padStart(2, '0')}:00`, filmMode: [0x600, 0x800, 0xb00][look] }, { image: b(scenes[sc].big), preview: b(scenes[sc].prev), thumb: b(scenes[sc].thumb) }));
      fs.utimesSync(f, d, d);
    }
  }
  browser = await webkit.launch();
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

// What each frame shows, read back: 'blank' if nothing is drawn yet, else its
// colourfulness (0 = grey).
const shown = (page) =>
  page.evaluate(() => {
    const read = (node) => {
      if (!node) return 'none';
      const src = node.classList && node.classList.contains('crop-view') ? node.querySelector('img') : node;
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 30;
      try {
        c.getContext('2d').drawImage(src, 0, 0, 40, 30);
      } catch {
        return 'blank';
      }
      const d = c.getContext('2d').getImageData(0, 0, 40, 30).data;
      let chroma = 0;
      let alpha = 0;
      for (let i = 0; i < d.length; i += 4) {
        chroma += Math.abs(d[i] - d[i + 1]) + Math.abs(d[i + 1] - d[i + 2]);
        alpha += d[i + 3];
      }
      return alpha / (d.length / 4) < 10 ? 'blank' : Math.round(chroma / (d.length / 4));
    };
    const nodes = S.solo ? [$('#solo-frame').firstElementChild] : [...document.querySelectorAll('#stage .frame')].map((f) => f.firstElementChild);
    return nodes.map(read);
  });

test('WebKit: every flip shows drawn, colour pictures at once (3-up and large view)', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?open=${encodeURIComponent(card)}`);
  await page.waitForSelector('#survey:not([hidden])');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  await page.waitForTimeout(800);
  const bad = [];
  for (const view of ['3-up', 'large view']) {
    if (view === 'large view') {
      await page.keyboard.press(' ');
      await page.waitForTimeout(500);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('ArrowRight');
      const now = await shown(page);
      if (now.some((v) => v === 'blank' || v === 'none' || v < 8)) bad.push(`${view}, flip ${i + 1}: ${now.join(' ')}`);
    }
  }
  assert.deepEqual(bad, [], 'frames without a drawn colour picture right after the key');
  assert.deepEqual(errors, []);
  await page.close();
});
