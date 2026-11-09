#!/usr/bin/env node
// Serves a built Brackit Lite folder over http://127.0.0.1 (a static server,
// as GitHub Pages is):  node scripts/serve-lite.mjs [dir] [port]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'build/lite');
const port = Number(process.argv[3] ?? 4871);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(dir, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Brackit Lite: http://127.0.0.1:${server.address().port}/`));
