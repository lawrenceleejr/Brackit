'use strict';
// Brackit local server. Serves the UI and a tiny JSON API. Used both by the
// Electron shell and by the terminal (`brackit` CLI -> browser) mode.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Library } = require('./library');
const { exifForEdited, graftSegment } = require('./jpeg');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const STATE_DIR = path.join(os.homedir(), '.brackit');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let saveTimer = null;
function saveState(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      console.error('brackit: could not save state', e.message);
    }
  }, 150);
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(s);
}

function readRaw(req, limit = 512e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) return req.destroy(new Error('too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// A tiny EXIF APP1 segment carrying only the Orientation tag. Fuji's embedded
// MPF preview has no orientation of its own, so we graft the parent's onto it
// and let the browser rotate it natively.
function orientationSegment(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// Byte-range streaming so the <video> element can seek.
function serveVideo(req, res, photo) {
  const size = photo.size;
  // Chromium plays QuickTime (H.264/HEVC) files when labelled as mp4.
  const type = 'video/mp4';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(photo.file).pipe(res);
  }
  let start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10);
  let end = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
  if (!(start >= 0) || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  end = Math.min(end, size - 1);
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(photo.file, { start, end }).pipe(res);
}

function serveImage(req, res, photo, full) {
  const headers = {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'private, max-age=3600',
  };
  if (!full && photo.preview) {
    const { start, length } = photo.preview;
    const fd = fs.openSync(photo.file, 'r');
    const buf = Buffer.alloc(length);
    fs.read(fd, buf, 0, length, start, (err) => {
      fs.close(fd, () => {});
      if (err) return json(res, 500, { error: err.message });
      let out = buf;
      if (photo.orientation && photo.orientation !== 1) {
        out = Buffer.concat([buf.subarray(0, 2), orientationSegment(photo.orientation), buf.subarray(2)]);
      }
      headers['Content-Length'] = out.length;
      res.writeHead(200, headers);
      res.end(out);
    });
    return;
  }
  headers['Content-Length'] = photo.size;
  res.writeHead(200, headers);
  fs.createReadStream(photo.file).pipe(res);
}

function listVolumes() {
  const roots = [];
  const candidates = [];
  if (process.platform === 'darwin') roots.push('/Volumes');
  else if (process.platform === 'linux') {
    roots.push('/media/' + os.userInfo().username, '/run/media/' + os.userInfo().username, '/mnt', '/media');
  }
  for (const r of roots) {
    let names = [];
    try {
      names = fs.readdirSync(r);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(r, n);
      try {
        if (fs.statSync(path.join(p, 'DCIM')).isDirectory()) candidates.push({ name: n, path: p });
      } catch {}
    }
  }
  return candidates;
}

function macChooseFolder(prompt) {
  return new Promise((resolve) => {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
    execFile('osascript', ['-e', 'tell application "System Events" to activate', '-e', script], (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim().replace(/\/$/, '') || null);
    });
  });
}

async function uniqueDest(dir, name, size) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i ? `${base}-${i}${ext}` : name);
    try {
      const st = await fs.promises.stat(candidate);
      if (st.size === size) return { path: candidate, exists: true };
    } catch {
      return { path: candidate, exists: false };
    }
  }
  throw new Error('too many name collisions');
}

function createServer(opts = {}) {
  const library = new Library();
  const state = Object.assign({ flags: [], exported: [], edits: {}, lastDest: null, lastRoot: null }, loadState());
  const pickFolder =
    opts.pickFolder || (process.platform === 'darwin' ? (purpose) => macChooseFolder(purpose) : null);

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/state':
        return json(res, 200, {
          root: library.root,
          lastRoot: state.lastRoot,
          lastDest: state.lastDest,
          flags: state.flags,
          edits: state.edits,
          exported: state.exported,
          canPick: !!pickFolder,
          shell: opts.shell || 'browser',
          home: os.homedir(),
          defaultDest: path.join(os.homedir(), 'Pictures', 'Brackit'),
          platform: process.platform,
        });
      case 'GET /api/volumes':
        return json(res, 200, { volumes: listVolumes() });
      case 'GET /api/progress':
        return json(res, 200, { scanning: library.scanning, ...library.progress });
      case 'POST /api/open': {
        const body = await readBody(req);
        const p = body.path && path.resolve(body.path.replace(/^~(?=$|\/)/, os.homedir()));
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return json(res, 400, { error: 'Folder not found' });
        const summary = await library.scan(p);
        state.lastRoot = p;
        saveState(state);
        return json(res, 200, summary);
      }
      case 'GET /api/library':
        return json(res, 200, library.summary());
      case 'POST /api/pick': {
        const body = await readBody(req);
        if (!pickFolder) return json(res, 200, { path: null, unsupported: true });
        const p = await pickFolder(body.prompt || 'Choose a folder', body.defaultPath);
        return json(res, 200, { path: p });
      }
      case 'PUT /api/flags': {
        const body = await readBody(req);
        if (!Array.isArray(body.flags)) return json(res, 400, { error: 'flags must be an array' });
        state.flags = body.flags.filter((k) => typeof k === 'string');
        saveState(state);
        return json(res, 200, { ok: true });
      }
      case 'PUT /api/edits': {
        const body = await readBody(req);
        if (!body.edits || typeof body.edits !== 'object') return json(res, 400, { error: 'edits must be an object' });
        state.edits = body.edits;
        saveState(state);
        return json(res, 200, { ok: true });
      }
      case 'POST /api/export-edited': {
        // Body: the edited JPEG as rendered by the UI. We restore the camera's
        // EXIF (incl. film simulation) and write it next to the plain copies.
        const photo = library.photos.get(String(url.searchParams.get('id')));
        const destRaw = url.searchParams.get('dest');
        const w = Number(url.searchParams.get('w')) || 0;
        const h = Number(url.searchParams.get('h')) || 0;
        if (!photo || !destRaw) return json(res, 400, { error: 'bad request' });
        const dest = path.resolve(destRaw.replace(/^~(?=$|\/)/, os.homedir()));
        const body = await readRaw(req);
        if (body[0] !== 0xff || body[1] !== 0xd8) return json(res, 400, { error: 'not a jpeg' });
        const seg = await exifForEdited(photo.file, w, h).catch(() => null);
        const out = graftSegment(body, seg);
        await fs.promises.mkdir(dest, { recursive: true });
        const target = await uniqueDest(dest, photo.name, out.length);
        if (!target.exists) {
          await fs.promises.writeFile(target.path, out, { flag: 'wx' });
          const t = new Date(photo.mtime);
          await fs.promises.utimes(target.path, t, t).catch(() => {});
        }
        state.lastDest = dest;
        state.exported = [...new Set([...state.exported, photo.key])];
        saveState(state);
        return json(res, 200, { ok: true, skipped: target.exists, path: target.path });
      }
      case 'POST /api/reveal': {
        const body = await readBody(req);
        if (body.path && process.platform === 'darwin') execFile('open', [body.path]);
        else if (body.path && process.platform === 'linux') execFile('xdg-open', [body.path]);
        return json(res, 200, { ok: true });
      }
      case 'POST /api/export': {
        const body = await readBody(req);
        const dest = body.dest && path.resolve(body.dest.replace(/^~(?=$|\/)/, os.homedir()));
        const ids = Array.isArray(body.ids) ? body.ids : [];
        if (!dest) return json(res, 400, { error: 'No destination' });
        const photos = ids.map((id) => library.photos.get(String(id))).filter(Boolean);
        await fs.promises.mkdir(dest, { recursive: true });
        state.lastDest = dest;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        const exported = new Set(state.exported);
        let copied = 0;
        let skipped = 0;
        const failed = [];
        for (let i = 0; i < photos.length; i++) {
          const p = photos[i];
          try {
            const target = await uniqueDest(dest, p.name, p.size);
            if (target.exists) skipped++;
            else {
              await fs.promises.copyFile(p.file, target.path, fs.constants.COPYFILE_EXCL);
              const t = new Date(p.mtime);
              await fs.promises.utimes(target.path, t, t).catch(() => {});
              copied++;
            }
            exported.add(p.key);
          } catch (e) {
            failed.push({ name: p.name, error: e.message });
          }
          res.write(JSON.stringify({ done: i + 1, total: photos.length, name: p.name }) + '\n');
        }
        state.exported = [...exported];
        saveState(state);
        res.end(JSON.stringify({ finished: true, copied, skipped, failed, dest }) + '\n');
        return;
      }
    }
    const m = url.pathname.match(/^\/api\/img\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const photo = library.photos.get(m[1]);
      if (!photo) return json(res, 404, { error: 'not found' });
      if (photo.kind === 'video') return serveVideo(req, res, photo);
      return serveImage(req, res, photo, url.searchParams.get('full') === '1');
    }
    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(WEB_ROOT, path.normalize(rel));
    if (!file.startsWith(WEB_ROOT)) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Only accept requests addressed to this machine (blocks DNS-rebinding).
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  });

  server.library = library;
  return server;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

module.exports = { createServer, listen, orientationSegment };
