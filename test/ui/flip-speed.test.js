'use strict';
/* Flip-speed budget: pressing an arrow key must change the screen within
   50 ms, always — on a warm card, on a cold slow card, and with the key held.

   Measured with the browser's own Event Timing API: for each keydown,
   `duration` runs from the key event to the next frame painted after it was
   handled (the basis of Google's INP metric). Real JPEGs are generated in the
   browser so image decoding costs are realistic.

   Run: npm run build:cli && npm run test:ui */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { buildJpeg } = require('../fixture');

const BUDGET_MS = 50;
const BIN = process.env.BRACKIT_BIN || path.join(__dirname, '..', '..', 'src-tauri', 'target', 'release', process.platform === 'win32' ? 'brackit.exe' : 'brackit');
const SETS = 60; // 180 photos

let browser;
let server;
let base;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brackit-ui-'));
const card = path.join(tmp, 'card');

async function makeCard() {
  const page = await browser.newPage();
  // a few distinct scenes, three graded looks each, as real JPEGs
  const scenes = await page.evaluate(() => {
    const render = (w, h, seed, grade) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${seed * 47},55%,65%)`);
      g.addColorStop(1, `hsl(${seed * 47 + 120},45%,30%)`);
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < 60; i++) {
        x.fillStyle = `hsla(${(seed * 31 + i * 17) % 360},60%,${30 + (i % 5) * 10}%,.7)`;
        x.fillRect(((i * 97) % 100) * w / 100, ((i * 61) % 100) * h / 100, w / 9, h / 7);
      }
      const o = document.createElement('canvas');
      o.width = w;
      o.height = h;
      const y = o.getContext('2d');
      y.filter = grade;
      y.drawImage(c, 0, 0);
      return o.toDataURL('image/jpeg', 0.85).split(',')[1];
    };
    const grades = ['saturate(0.6) contrast(1.15)', 'saturate(0.8) hue-rotate(-10deg)', 'saturate(1.25)'];
    const out = [];
    for (let seed = 0; seed < 4; seed++) {
      out.push(grades.map((gr) => ({ big: render(2400, 1600, seed, gr), prev: render(1920, 1280, seed, gr), thumb: render(160, 107, seed, gr) })));
    }
    return out;
  });
  await page.close();
  const dcim = path.join(card, 'DCIM', '100_FUJI');
  fs.mkdirSync(dcim, { recursive: true });
  const sims = [0x600, 0x800, 0xb00];
  let n = 1;
  for (let s = 0; s < SETS; s++) {
    const t = new Date(2026, 9, 1, 8, 0, 0).getTime() + s * 60_000;
    const d = new Date(t);
    const z = (v) => String(v).padStart(2, '0');
    const stamp = `${d.getFullYear()}:${z(d.getMonth() + 1)}:${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:00`;
    for (let look = 0; look < 3; look++) {
      const sc = scenes[s % scenes.length][look];
      const f = path.join(dcim, `DSCF${String(n++).padStart(4, '0')}.JPG`);
      const b64 = (x) => Buffer.from(x, 'base64');
      fs.writeFileSync(f, buildJpeg({ dateTime: stamp, filmMode: sims[look] }, { image: b64(sc.big), preview: b64(sc.prev), thumb: b64(sc.thumb) }));
      fs.utimesSync(f, d, d);
    }
  }
}

test.before(async () => {
  browser = await chromium.launch(process.env.BRACKIT_CHROMIUM ? { executablePath: process.env.BRACKIT_CHROMIUM } : {});
  await makeCard();
  server = spawn(BIN, ['--serve', '--no-open', '--port', '0'], { env: { ...process.env, HOME: tmp, USERPROFILE: tmp } });
  base = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    server.on('error', reject);
    setTimeout(() => reject(new Error('server did not start: ' + out)), 5000);
  });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

// Open the card in a fresh page; optionally make the "card" slow.
async function openCard({ slow = false, settle = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (slow) {
    await page.route('**/api/**', async (route) => {
      const u = route.request().url();
      if (u.includes('/api/img/')) await new Promise((r) => setTimeout(r, 300));
      else if (u.includes('/api/thumbs')) await new Promise((r) => setTimeout(r, 120));
      route.continue();
    });
  }
  // record every keydown's event duration (key event -> next paint)
  await page.addInitScript(() => {
    window.__keyDurations = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'keydown') window.__keyDurations.push(e.duration);
    }).observe({ type: 'event', durationThreshold: 0, buffered: true });
  });
  await page.goto(`${base}/?open=${encodeURIComponent(card)}`);
  await page.waitForSelector('#survey:not([hidden])');
  await page.keyboard.press('a');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#viewer:not([hidden])');
  if (settle) await page.waitForTimeout(settle);
  await page.evaluate(() => (window.__keyDurations = []));
  return { page, errors };
}

// After each press: did the screen change, and is every frame filled? In the
// large view the change is the photo itself (the frame shows the new id).
async function flip(page, { presses, gapMs, large = false, keys = ['ArrowRight'] }) {
  const screens = [];
  for (let i = 0; i < presses; i++) {
    const before = await page.evaluate(() => [document.querySelector('#counter').textContent, document.querySelector('#solo-frame').dataset.id]);
    await page.keyboard.press(keys[i % keys.length]);
    screens.push(
      await page.evaluate(
        ([before, large]) =>
          new Promise((res) =>
            requestAnimationFrame(() => {
              const sf = document.querySelector('#solo-frame');
              res(
                large
                  ? { changed: sf.dataset.id !== before[1], filled: !!sf.firstElementChild }
                  : {
                      changed: document.querySelector('#counter').textContent !== before[0],
                      filled: [...document.querySelectorAll('#stage .frame')].every((f) => f.firstElementChild),
                    }
              );
            })
          ),
        [before, large]
      )
    );
    if (gapMs) await page.waitForTimeout(gapMs);
  }
  await page.waitForTimeout(300); // let the last event entries arrive
  const durations = await page.evaluate(() => window.__keyDurations.slice());
  return { screens, durations };
}

function report(name, durations) {
  const sorted = durations.slice().sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(`  ${name}: ${durations.length} presses took ≥16 ms · median of those ${pct(0.5) ?? '-'} ms · p95 ${pct(0.95) ?? '-'} ms · max ${sorted.at(-1) ?? '-'} ms (budget ${BUDGET_MS} ms)`);
}

function assertFast(name, { screens, durations }) {
  report(name, durations);
  // (browsers only report events of 16 ms or more; unreported presses were faster)
  const slow = durations.filter((d) => d > BUDGET_MS);
  assert.deepEqual(slow, [], `${name}: keypresses slower than ${BUDGET_MS} ms to next paint`);
  assert.ok(screens.every((s) => s.changed), `${name}: the counter didn't change on every press`);
}

test('warm card: every arrow press paints within 50 ms, frames already filled', async () => {
  const { page, errors } = await openCard({ settle: 2500 });
  const r = await flip(page, { presses: 25, gapMs: 120 });
  assertFast('warm', r);
  assert.ok(r.screens.every((s) => s.filled), 'some frame was empty after a press');
  assert.deepEqual(errors, []);
  await page.close();
});

test('cold, slow card: the page still changes within 50 ms of every press', async () => {
  const { page, errors } = await openCard({ slow: true });
  const r = await flip(page, { presses: 20, gapMs: 60 });
  assertFast('cold + slow card', r);
  assert.deepEqual(errors, []);
  await page.close();
});

test('holding the arrow key: every repeat paints within 50 ms', async () => {
  const { page, errors } = await openCard({ slow: true, settle: 1500 });
  const r = await flip(page, { presses: 40, gapMs: 0 });
  assertFast('held key', r);
  assert.deepEqual(errors, []);
  await page.close();
});

test('large view (space): arrow presses paint within 50 ms, warm card', async () => {
  const { page, errors } = await openCard({ settle: 2500 });
  await page.keyboard.press(' ');
  await page.waitForTimeout(800);
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 25, gapMs: 120, large: true });
  assertFast('large view, warm', r);
  assert.ok(r.screens.every((s) => s.filled), 'the large view was empty after a press');
  assert.deepEqual(errors, []);
  await page.close();
});

test('large view (space): arrow presses paint within 50 ms, cold slow card, quick presses', async () => {
  const { page, errors } = await openCard({ slow: true });
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 30, gapMs: 30, large: true });
  assertFast('large view, cold + slow card', r);
  assert.deepEqual(errors, []);
  await page.close();
});

test('cropped sets: arrow presses paint within 50 ms', async () => {
  const { page, errors } = await openCard({});
  // crop and straighten every photo, as if each set had been edited
  await page.evaluate(() => {
    for (const p of Object.values(S.lib.photos)) S.edits[p.key] = { angle: 1.5, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.75 }, aspect: 'free' };
    render();
  });
  await page.waitForTimeout(3000);
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 25, gapMs: 120 });
  assertFast('cropped', r);
  assert.ok(r.screens.every((s) => s.filled), 'some frame was empty after a press');
  assert.deepEqual(errors, []);
  await page.close();
});

// Forward is → ↓ j, back is ← ↑ k, in the 3-up and in the large view alike.
test('every flip key moves a set, within 50 ms', async () => {
  const { page, errors } = await openCard({ settle: 1500 });
  const pos = () => page.evaluate(() => S.idx);
  for (const large of [false, true]) {
    if (large) {
      await page.keyboard.press(' ');
      await page.waitForTimeout(500);
    }
    for (const [key, d] of [['ArrowRight', 1], ['ArrowDown', 1], ['j', 1], ['ArrowLeft', -1], ['ArrowUp', -1], ['k', -1]]) {
      const before = await pos();
      await page.keyboard.press(key);
      assert.equal(await pos(), before + d, `${key} ${large ? 'in the large view ' : ''}should move ${d}`);
    }
  }
  await page.evaluate(() => (window.__keyDurations = []));
  const r = await flip(page, { presses: 24, gapMs: 120, large: true, keys: ['j', 'ArrowDown', 'k', 'j', 'ArrowUp', 'j'] });
  assertFast('j / k / ↑ / ↓', r);
  assert.deepEqual(errors, []);
  await page.close();
});
