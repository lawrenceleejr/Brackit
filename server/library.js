'use strict';
// Scans a folder (typically an SD card's DCIM tree) for JPEGs, reads their
// metadata in parallel, and groups film-simulation brackets into sets.

const fs = require('fs');
const path = require('path');
const { readMeta, validPreview } = require('./jpeg');

const JPEG_RE = /\.jpe?g$/i;
const VIDEO_RE = /\.(mov|mp4|m4v)$/i;
const SKIP_DIRS = new Set(['.Trashes', '.Spotlight-V100', '.fseventsd', 'node_modules', '.git']);

async function walk(dir, out, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith('._')) return; // macOS resource forks on FAT cards
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(p, out, depth + 1);
      } else if (e.isFile() && (JPEG_RE.test(e.name) || VIDEO_RE.test(e.name))) {
        out.push(p);
      }
    })
  );
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          results[k] = await fn(items[k], k);
        } catch {
          results[k] = null;
        }
      }
    })
  );
  return results;
}

// Video files carry no EXIF; the card's file time is the capture time.
function exifDate(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${z(d.getMonth() + 1)}:${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

function fileNumber(name) {
  const m = name.match(/(\d+)\.[^.]+$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Brackets: consecutive frames sharing a capture timestamp, each with a
// different film simulation. Anything else stands alone as a set of one.
function group(photos) {
  photos.sort((a, b) => {
    const ka = a.dateTime || '';
    const kb = b.dateTime || '';
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
    return a.num - b.num;
  });
  const sets = [];
  let cur = null;
  for (const p of photos) {
    const stamp = p.dateTime ? `${p.dateTime}.${p.subSec || ''}` : null;
    const fits =
      cur &&
      stamp &&
      p.kind !== 'video' &&
      cur.photos[0].kind !== 'video' &&
      cur.stamp === stamp &&
      cur.photos.length < 3 &&
      p.dir === cur.photos[0].dir &&
      p.num - cur.photos[cur.photos.length - 1].num === 1 &&
      !cur.photos.some((q) => q.filmSim && q.filmSim === p.filmSim);
    if (fits) cur.photos.push(p);
    else {
      cur = { stamp, photos: [p] };
      sets.push(cur);
    }
  }
  return sets.map((s, i) => ({
    index: i,
    dateTime: s.photos[0].dateTime || null,
    kind: s.photos[0].kind,
    photos: s.photos.map((p) => p.id),
  }));
}

class Library {
  constructor() {
    this.root = null;
    this.photos = new Map(); // id -> photo
    this.sets = [];
    this.scanning = false;
    this.progress = { done: 0, total: 0 };
  }

  async scan(root) {
    root = path.resolve(root);
    this.scanning = true;
    this.root = root;
    this.progress = { done: 0, total: 0 };
    const files = [];
    await walk(root, files);
    this.progress.total = files.length;
    const metas = await pool(files, 16, async (file) => {
      if (VIDEO_RE.test(file)) {
        const st = await fs.promises.stat(file);
        this.progress.done++;
        return { file, meta: { video: true, dateTime: exifDate(st.mtime) }, st };
      }
      const [meta, st] = await Promise.all([readMeta(file), fs.promises.stat(file)]);
      if (meta.preview && !(await validPreview(file, meta.preview))) meta.preview = null;
      this.progress.done++;
      return { file, meta, st };
    });
    const photos = [];
    this.photos = new Map();
    metas.forEach((m, i) => {
      if (!m) return;
      const name = path.basename(m.file);
      const id = String(i);
      const photo = {
        id,
        file: m.file,
        name,
        dir: path.dirname(m.file),
        rel: path.relative(root, m.file),
        num: fileNumber(name),
        size: m.st.size,
        mtime: m.st.mtimeMs,
        key: `${name}:${m.st.size}:${m.meta.dateTime || Math.round(m.st.mtimeMs)}`,
        dateTime: m.meta.dateTime || null,
        subSec: m.meta.subSec || null,
        filmSim: m.meta.filmSim || null,
        model: m.meta.model || null,
        orientation: m.meta.orientation || 1,
        width: m.meta.width || m.meta.frameWidth || null,
        height: m.meta.height || m.meta.frameHeight || null,
        preview: m.meta.preview || null,
        kind: m.meta.video ? 'video' : 'photo',
      };
      photos.push(photo);
      this.photos.set(id, photo);
    });
    this.sets = group(photos);
    this.scanning = false;
    return this.summary();
  }

  publicPhoto(p) {
    const { file, dir, preview, ...rest } = p;
    return { ...rest, hasPreview: !!preview };
  }

  summary() {
    return {
      root: this.root,
      sets: this.sets,
      photos: Object.fromEntries([...this.photos.values()].map((p) => [p.id, this.publicPhoto(p)])),
    };
  }
}

module.exports = { Library, group };
