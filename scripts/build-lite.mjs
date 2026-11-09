#!/usr/bin/env node
// Builds Brackit Lite, the web version, into a folder of static files:
//   node scripts/build-lite.mjs [out]      (default: build/lite)
// The page is the desktop app's own web/ folder plus web/lite.js (which
// answers the page's /api requests in the browser) and the JPEG reader
// compiled to WebAssembly from src-tauri/src/jpeg.rs (lite/wasm).
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'build/lite'));
const r = (...p) => path.join(root, ...p);

execSync('cargo build --release --target wasm32-unknown-unknown', { cwd: r('lite/wasm'), stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const files = {
  'app.js': r('web/app.js'),
  'tools.js': r('web/tools.js'),
  'library.js': r('web/library.js'),
  'lite.js': r('web/lite.js'),
  'style.css': r('web/style.css'),
  'icon.svg': r('web/icon.svg'),
  'brackit.wasm': r('lite/wasm/target/wasm32-unknown-unknown/release/brackit_lite.wasm'),
  'apple-touch-icon.png': r('lite/icons/apple-touch-icon.png'),
  'icon-192.png': r('lite/icons/icon-192.png'),
  'icon-512.png': r('lite/icons/icon-512.png'),
};
const hash = crypto.createHash('sha256');
for (const [name, src] of Object.entries(files)) {
  const buf = fs.readFileSync(src);
  hash.update(name).update(buf);
  fs.writeFileSync(path.join(out, name), buf);
}
let html = fs.readFileSync(r('web/index.html'), 'utf8');
hash.update(html);
const v = hash.digest('hex').slice(0, 10);

const swap = (a, b) => {
  if (!html.includes(a)) throw new Error(`build-lite: index.html no longer contains ${a}`);
  html = html.replace(a, b);
};
swap('<title>Brackit</title>', '<title>Brackit Lite</title>');
swap('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1">');
swap(
  '<link rel="stylesheet" href="style.css">',
  [
    `<link rel="stylesheet" href="style.css?v=${v}">`,
    '<meta name="description" content="Review Fujifilm film simulation brackets side by side and keep the look you want. In the browser, on iPhone and iPad too.">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Brackit">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black">',
    '<meta name="theme-color" content="#0d0d0c">',
    `<meta name="brackit-wasm" content="brackit.wasm?v=${v}">`,
  ].join('\n  ')
);
swap('<body>', '<body class="lite">');
swap(
  '<script src="app.js"></script>\n  <script src="tools.js"></script>\n  <script src="library.js"></script>',
  [
    `<script src="lite.js?v=${v}"></script>`,
    `<script src="app.js?v=${v}"></script>`,
    `<script src="tools.js?v=${v}"></script>`,
    `<script src="library.js?v=${v}"></script>`,
    `<script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});</script>`,
  ].join('\n  ')
);
fs.writeFileSync(path.join(out, 'index.html'), html);

fs.writeFileSync(
  path.join(out, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: 'Brackit Lite',
      short_name: 'Brackit',
      description: 'Review Fujifilm film simulation brackets side by side.',
      start_url: './',
      scope: './',
      display: 'standalone',
      background_color: '#0d0d0c',
      theme_color: '#0d0d0c',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    null,
    2
  )
);

// Offline: the page and its files are kept on the device, refreshed when a
// new version is published (the version is a hash of everything above).
const cached = ['./', ...Object.keys(files).map((f) => (f.endsWith('.png') || f.endsWith('.svg') ? f : `${f}?v=${v}`)), 'manifest.webmanifest'];
fs.writeFileSync(
  path.join(out, 'sw.js'),
  `// Brackit Lite ${v}: works offline once opened.
const CACHE = 'brackit-lite-${v}';
const FILES = ${JSON.stringify(cached)};
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) =>
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
);
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  // the page: network first (so a new version shows), the cache when offline
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
`
);
console.log(`Brackit Lite ${v} → ${path.relative(process.cwd(), out) || out}`);
