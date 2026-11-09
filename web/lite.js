/* Brackit Lite: the web version.

   The desktop app's Rust program reads the card and answers the page's /api
   requests. Here there is no program: the photos are files picked in the
   browser, and this script answers the same requests itself, so app.js and
   the rest of the page work unchanged. Reading the JPEGs is done by the
   desktop app's own parser (src-tauri/src/jpeg.rs) compiled to WebAssembly
   (lite/wasm), so both versions read Fujifilm files exactly alike.

   What Lite can't do (no access to the card beyond the picked files): delete
   from the card, eject, or browse the export folder (the Library). Exports go
   to a chosen folder (Chrome, Edge), the share sheet (iPhone, iPad: Save to
   Photos / Files) or Downloads. Nothing is uploaded anywhere. */

(function () {
  'use strict';
  const LITE = (window.BrackitLite = {});
  const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
  LITE.touch = touch;

  /* ---------------------------------------------------------- storage */

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('brackit-lite:' + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('brackit-lite:' + k, JSON.stringify(v));
      } catch {}
    },
  };

  /* ---------------------------------------------------------- the parser (WebAssembly) */

  let wasm = null;
  const wasmReady = (async () => {
    const r = await fetch(document.querySelector('meta[name="brackit-wasm"]')?.content || 'brackit.wasm');
    const bytes = await r.arrayBuffer();
    wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  })();

  function put(bytes) {
    const p = wasm.alloc(bytes.length);
    new Uint8Array(wasm.memory.buffer, p, bytes.length).set(bytes);
    return p;
  }
  function take(r) {
    const p = Number(BigInt.asUintN(64, r) >> 32n);
    const n = Number(BigInt.asUintN(64, r) & 0xffffffffn);
    const out = new Uint8Array(wasm.memory.buffer, p, n).slice();
    wasm.dealloc(p, n);
    return out;
  }
  function call(fn, bytes, ...rest) {
    const p = put(bytes);
    try {
      return take(wasm[fn](p, bytes.length, ...rest));
    } finally {
      wasm.dealloc(p, bytes.length);
    }
  }
  const asJson = (u8) => JSON.parse(new TextDecoder().decode(u8));
  const orientSeg = new Map();
  function orientation(o) {
    if (!orientSeg.has(o)) orientSeg.set(o, take(wasm.orientation(o)));
    return orientSeg.get(o);
  }

  const readBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const HEAD = 256 * 1024; // what the desktop reads for settings and metadata

  // Header metadata, reading as little of the file as possible.
  async function readMeta(file) {
    let n = 96 * 1024;
    for (let i = 0; i < 4; i++) {
      const buf = await readBytes(file.slice(0, n));
      const m = asJson(call('meta', buf));
      if (!m.need || m.need <= buf.length || buf.length >= file.size) return m;
      n = m.need + 32 * 1024;
    }
    return null;
  }

  /* ---------------------------------------------------------- the picked files */

  const L = {
    files: [], // { file, rel, name, folder, mtime, size, kind }
    root: null, // a name for what was picked
    lib: null, // { photos: Map(id -> photo), sets, scope }
    progress: { scanning: false, done: 0, total: 0 },
    gen: 0,
  };
  LITE.state = L;

  const ext = (n) => (n.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
  const isJpeg = (n) => ext(n) === 'jpg' || ext(n) === 'jpeg';
  const isVideo = (n) => ['mov', 'mp4', 'm4v'].includes(ext(n));
  const isRaw = (n) => ext(n) === 'raf';
  const z = (v) => String(v).padStart(2, '0');
  const localDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  };
  const exifDate = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}:${z(d.getMonth() + 1)}:${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
  };
  const fileNumber = (name) => Number((name.replace(/\.[^.]*$/, '').match(/(\d+)$/) || [, '0'])[1]);

  // The same stable id as the desktop: FNV-1a over path, size and time.
  function stableId(path, size, mtime) {
    let h = 0xcbf29ce484222325n;
    const eat = (bytes) => {
      for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
    };
    eat(new TextEncoder().encode(path));
    const le = (v) => {
      const out = [];
      let x = BigInt.asUintN(64, BigInt(Math.trunc(v)));
      for (let i = 0; i < 8; i++, x >>= 8n) out.push(Number(x & 0xffn));
      return out;
    };
    eat(le(size));
    eat(le(mtime));
    return (h & 0xffffffffffffn).toString(16).padStart(12, '0');
  }

  // Files from an <input type=file> (a folder gives webkitRelativePath).
  LITE.setFiles = function (list) {
    const files = [];
    for (const f of list) {
      // a picked folder gives "card/DCIM/100_FUJI/DSCF0001.JPG": paths are
      // kept relative to the picked folder, as the desktop app does
      const full = f.webkitRelativePath || f.name;
      const name = f.name;
      if (name.startsWith('._') || full.split('/').some((p) => p.startsWith('.') && p.length > 1)) continue;
      if (!isJpeg(name) && !isVideo(name) && !isRaw(name)) continue;
      const parts = full.split('/');
      const rel = parts.slice(parts.length > 1 ? 1 : 0).join('/');
      files.push({ file: f, rel, name, folder: parts.slice(1, -1).join('/'), mtime: f.lastModified || 0, size: f.size, top: parts.length > 1 ? parts[0] : '' });
    }
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    L.files = files;
    const top = files.find((f) => f.top)?.top;
    const shown = files.filter((f) => !isRaw(f.name)).length;
    L.root = top || `${shown.toLocaleString('en-US')} picked file${shown === 1 ? '' : 's'}`;
    L.lib = null;
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    return files.length;
  };

  function survey() {
    const imported = new Set(store.get('imported', []));
    const groups = new Map();
    const times = [];
    let lastImported = null;
    for (const f of L.files) {
      if (isRaw(f.name)) continue;
      times.push(f.mtime);
      if (imported.has(`${f.name}:${f.size}`)) lastImported = Math.max(lastImported ?? f.mtime, f.mtime);
      const k = `${f.folder}\u0000${localDay(f.mtime)}`;
      const g = groups.get(k) || { folder: f.folder, day: localDay(f.mtime), photos: 0, videos: 0 };
      isVideo(f.name) ? g.videos++ : g.photos++;
      groups.set(k, g);
    }
    const sorted = [...groups.values()].sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    let sinceLast = null;
    if (lastImported != null) {
      const newer = times.filter((t) => t > lastImported);
      sinceLast = { after: lastImported, count: newer.length, firstDay: newer.length ? localDay(Math.min(...newer)) : null };
    }
    return { root: L.root, total: times.length, groups: sorted, sinceLast, volume: null };
  }

  // Brackets: consecutive frames sharing a capture time, each a different
  // film simulation, at most three (library.rs `group`, line for line).
  function group(photos) {
    const key = (p) => p.dateTime || '';
    photos.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.num - b.num));
    const groups = [];
    for (const p of photos) {
      const stamp = p.dateTime != null ? `${p.dateTime}.${p.subSec || ''}` : null;
      const g = groups.at(-1);
      let fits = false;
      if (g) {
        const first = g.members[0];
        const last = g.members.at(-1);
        fits =
          stamp != null &&
          g.stamp === stamp &&
          !p.video &&
          !first.video &&
          g.members.length < 3 &&
          p.dir === first.dir &&
          p.num === last.num + 1 &&
          !g.members.some((m) => m.filmSim != null && m.filmSim === p.filmSim);
      }
      if (fits) g.members.push(p);
      else groups.push({ stamp, members: [p] });
    }
    return groups.map((g, index) => ({
      index,
      dateTime: g.members[0].dateTime ?? null,
      kind: g.members[0].video ? 'video' : 'photo',
      photos: g.members.map((m) => m.id),
    }));
  }

  // A set's RAW: a .RAF in the same folder named like one of its JPEGs.
  function attachRaws(photos, sets, raws) {
    if (!raws.length) return;
    const k = (f) => `${f.rel.split('/').slice(0, -1).join('/')}\u0000${f.name.replace(/\.[^.]*$/, '').toLowerCase()}`;
    const byStem = new Map(raws.map((r) => [k(r), r]));
    const byId = new Map(photos.map((p) => [p.id, p]));
    for (const set of sets) {
      const raw = set.photos.map((id) => byStem.get(k(byId.get(id).src))).find(Boolean);
      if (!raw) continue;
      for (const id of set.photos) {
        const p = byId.get(id);
        p.raw = raw.file;
        p.rawName = raw.name;
        p.rawSize = raw.size;
      }
    }
  }

  async function open(scope) {
    const gen = ++L.gen;
    await wasmReady;
    const dayOk = (d) => (!scope.from || d >= scope.from) && (!scope.to || d <= scope.to);
    const inScope = (f) =>
      (!scope.folder || f.folder === scope.folder || f.folder.startsWith(scope.folder + '/')) &&
      dayOk(localDay(f.mtime)) &&
      (scope.after == null || f.mtime > scope.after);
    const all = L.files.filter((f) => !scope.folder || f.folder === scope.folder || f.folder.startsWith(scope.folder + '/'));
    const raws = all.filter((f) => isRaw(f.name));
    const files = all.filter((f) => !isRaw(f.name) && inScope(f));
    Object.assign(L.progress, { scanning: true, done: 0, total: files.length });
    const out = new Array(files.length);
    let next = 0;
    const worker = async () => {
      while (next < files.length && gen === L.gen) {
        const i = next++;
        out[i] = await readOne(files[i]).catch(() => null);
        if (gen === L.gen) L.progress.done++;
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (gen !== L.gen) throw Object.assign(new Error('superseded by a newer scan'), { status: 409 });
    const photos = out.filter(Boolean);
    const sets = group(photos);
    attachRaws(photos, sets, raws);
    L.progress.scanning = false;
    L.lib = { photos: new Map(photos.map((p) => [p.id, p])), sets, scope };
    return summary();
  }

  async function readOne(f) {
    const video = isVideo(f.name);
    const m = video ? { orientation: 1, dateTime: exifDate(f.mtime) } : await readMeta(f.file);
    if (!m) return null;
    return {
      id: stableId(f.rel, f.size, f.mtime),
      name: f.name,
      rel: f.rel,
      num: fileNumber(f.name),
      size: f.size,
      mtime: f.mtime,
      key: `${f.name}:${f.size}:${m.dateTime ?? Math.round(f.mtime)}`,
      dateTime: m.dateTime ?? null,
      subSec: m.subSec ?? null,
      filmSim: m.filmSim ?? null,
      model: m.model ?? null,
      orientation: m.orientation || 1,
      width: m.width ?? null,
      height: m.height ?? null,
      kind: video ? 'video' : 'photo',
      hasPreview: !!m.preview,
      hasThumb: !!m.thumb,
      rawName: null,
      rawSize: null,
      camRating: m.rating ?? null,
      // private
      video,
      dir: f.rel.split('/').slice(0, -1).join('/'),
      file: f.file,
      src: f,
      preview: m.preview,
      thumb: m.thumb,
      raw: null,
    };
  }

  const PUBLIC = ['id', 'name', 'rel', 'num', 'size', 'mtime', 'key', 'dateTime', 'subSec', 'filmSim', 'model', 'orientation', 'width', 'height', 'kind', 'hasPreview', 'hasThumb', 'rawName', 'rawSize', 'camRating'];
  function summary() {
    const photos = {};
    for (const [id, p] of L.lib.photos) photos[id] = Object.fromEntries(PUBLIC.map((k) => [k, p[k]]));
    const sc = L.lib.scope;
    return { root: L.root, scope: { folder: sc.folder ?? null, from: sc.from ?? null, to: sc.to ?? null, after: sc.after ?? null }, volume: null, sets: L.lib.sets, photos };
  }

  /* ---------------------------------------------------------- images */

  const photoOf = (id) => L.lib && L.lib.photos.get(id);

  // An embedded JPEG (thumbnail or preview) as a Blob, with the photo's
  // orientation grafted on: no bytes are read, the Blob points into the file.
  function embedded(p, range) {
    const [s, n] = range;
    if (n < 4 || s + n > p.size) return null;
    const parts = [p.file.slice(s, s + 2)];
    if (p.orientation !== 1) parts.push(orientation(p.orientation));
    parts.push(p.file.slice(s + 2, s + n));
    return new Blob(parts, { type: 'image/jpeg' });
  }

  function imageBlob(p, size) {
    if (p.video) return p.file;
    const range = size === 'full' ? null : size === 'thumb' ? p.thumb || p.preview : p.preview;
    return (range && embedded(p, range)) || p.file;
  }

  // Object URLs for media the page loads by setting src directly.
  const urls = new Map();
  LITE.url = function (u) {
    const m = /^\/api\/img\/([0-9a-f]+)(?:\?([^#]*))?(#.*)?$/.exec(u);
    const p = m && photoOf(m[1]);
    if (!p) return u;
    const q = new URLSearchParams(m[2] || '');
    const size = q.get('full') === '1' ? 'full' : q.get('thumb') === '1' ? 'thumb' : 'preview';
    const k = `${p.id}:${p.video ? 'v' : size}`;
    if (!urls.has(k)) urls.set(k, URL.createObjectURL(imageBlob(p, size)));
    return urls.get(k) + (m[3] || '');
  };

  async function thumbs(ids) {
    const parts = [];
    const index = [];
    const got = await Promise.all(
      ids.map(async (id) => {
        const p = photoOf(id);
        if (!p || p.video) return null;
        const range = p.thumb || p.preview;
        const blob = range && embedded(p, range);
        if (!blob) return null;
        const bytes = await readBytes(blob);
        return bytes[0] === 0xff && bytes[1] === 0xd8 ? [id, bytes] : null;
      })
    );
    for (const g of got) {
      if (!g) continue;
      index.push([g[0], g[1].length]);
      parts.push(g[1]);
    }
    return new Blob([JSON.stringify(index) + '\n', ...parts], { type: 'application/octet-stream' });
  }

  LITE.head = async (id) => {
    const p = photoOf(id);
    return p && !p.video ? readBytes(p.file.slice(0, HEAD)) : null;
  };

  /* ---------------------------------------------------------- answering /api */

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (status, error) => json({ error }, status);
  const NO = "Brackit Lite can't change the card. The desktop app can.";

  function exportedFiles() {
    return store.get('dest', []);
  }

  async function handle(url, init) {
    const u = new URL(url, location.href);
    const path = u.pathname.slice(u.pathname.indexOf('/api/'));
    const method = (init.method || 'GET').toUpperCase();
    const body = () => {
      try {
        return JSON.parse(init.body || '{}');
      } catch {
        return {};
      }
    };
    if (method === 'GET') {
      let m;
      if ((m = /^\/api\/img\/([0-9a-f]+)$/.exec(path))) {
        const p = photoOf(m[1]);
        if (!p) return fail(404, 'not found');
        const size = u.searchParams.get('full') === '1' ? 'full' : u.searchParams.get('thumb') === '1' ? 'thumb' : 'preview';
        return new Response(imageBlob(p, size), { headers: { 'Content-Type': p.video ? 'video/mp4' : 'image/jpeg' } });
      }
      if ((m = /^\/api\/(info|meta)\/([0-9a-f]+)$/.exec(path))) {
        if (u.searchParams.get('src') === 'out') return fail(404, 'not found');
        await wasmReady;
        const head = await LITE.head(m[2]);
        if (!head) return fail(404, 'not found');
        return json(asJson(call(m[1] === 'info' ? 'info' : 'metadata', head)));
      }
      if (path === '/api/thumbs') {
        if (u.searchParams.get('src') === 'out') return new Response('[]\n');
        return new Response(await thumbs((u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200)));
      }
      switch (path) {
        case '/api/state':
          return json({
            root: L.lib ? L.root : null,
            lastRoot: null,
            lastDest: null,
            flags: store.get('flags', []),
            edits: store.get('edits', {}),
            exported: store.get('exported', []),
            ratings: {},
            flagged: [],
            canPick: false,
            shell: 'lite',
            home: '',
            defaultDest: destLabel(),
            platform: 'lite',
          });
        case '/api/volumes':
          return json({ volumes: [] });
        case '/api/progress':
          return json(L.progress);
        case '/api/library':
          return L.lib ? json(summary()) : fail(404, 'nothing open');
        case '/api/dest':
          return json({ path: destLabel(), files: exportedFiles() });
        case '/api/out':
          return json({ root: '', photos: {}, folders: [] });
      }
      return fail(404, 'not in Brackit Lite');
    }
    switch (path) {
      case '/api/survey':
        return L.files.length ? json(survey()) : fail(400, 'Choose some photos first');
      case '/api/open': {
        const b = body();
        const s = (k) => (typeof b[k] === 'string' && b[k] ? b[k] : null);
        try {
          return json(await open({ folder: s('folder'), from: s('from'), to: s('to'), after: typeof b.after === 'number' ? b.after : null }));
        } catch (e) {
          return fail(e.status || 500, e.message);
        }
      }
      case '/api/flags':
        store.set('flags', body().flags || []);
        return json({ ok: true });
      case '/api/edits':
        store.set('edits', body().edits || {});
        return json({ ok: true });
      case '/api/pick':
        return json({ path: null });
      case '/api/reveal':
      case '/api/window':
        return json({ ok: true });
      case '/api/delete':
      case '/api/undo-delete':
      case '/api/eject':
      case '/api/export':
      case '/api/export-edited':
        return fail(400, NO);
    }
    return fail(404, 'not in Brackit Lite');
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && /^\/api\//.test(url)) {
      if (init && init.signal && init.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return handle(url, init || {});
    }
    return realFetch(input, init);
  };

  /* ---------------------------------------------------------- choosing photos */

  // A hidden file input per kind; clicking it must happen inside the key or
  // tap that asked for it, so this is called straight from those handlers.
  LITE.pick = function (kind) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (kind === 'folder') input.webkitdirectory = true;
    input.hidden = true;
    input.onchange = () => {
      const n = LITE.setFiles(input.files);
      input.remove();
      if (!n) return toast('No Fujifilm JPEGs or videos among those files', { ms: 3000 });
      openFolder(L.root);
    };
    document.body.append(input);
    input.click();
  };
  LITE.canPickFolder = !touch && 'webkitdirectory' in document.createElement('input');

  /* ---------------------------------------------------------- export */

  // Where exports go: a folder (Chrome, Edge), the share sheet (iPhone, iPad)
  // or Downloads.
  const canShareFiles = () => {
    try {
      return touch && !!navigator.canShare && navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] });
    } catch {
      return false;
    }
  };
  LITE.mode = canShareFiles() ? 'share' : 'showDirectoryPicker' in window ? 'folder' : 'download';
  let folder = null; // a FileSystemDirectoryHandle

  function destLabel() {
    if (LITE.mode === 'share') return 'Photos or Files';
    if (LITE.mode === 'folder') return folder ? folder.name : 'a folder (D to choose)';
    return 'Downloads';
  }

  LITE.chooseDest = async function () {
    if (LITE.mode !== 'folder') {
      toast(LITE.mode === 'share' ? 'Exports open the share sheet: Save to Photos, or Save to Files' : 'Exports go to your Downloads folder', { ms: 3500 });
      return false;
    }
    try {
      folder = await window.showDirectoryPicker({ id: 'brackit-export', mode: 'readwrite' });
    } catch {
      return false;
    }
    S.dest = destLabel();
    if (!$('#staged').hidden) renderStaged();
    return true;
  };

  const MAX_AREA = touch ? 16_000_000 : 120_000_000; // iOS refuses canvases over ~16.7 MP

  async function croppedFile(p, edit) {
    const img = new Image();
    img.src = LITE.url(`/api/img/${p.id}?full=1`);
    await img.decode();
    const cw = edit.crop.w * srcW(img);
    const ch = edit.crop.h * srcH(img);
    const fit = Math.min(1, Math.sqrt(MAX_AREA / (cw * ch)));
    const canvas = renderEdited(img, edit, Math.floor(cw * fit));
    const w = canvas.width;
    const h = canvas.height;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error('could not encode the crop');
    await wasmReady;
    const head = await LITE.head(p.id);
    const jpg = await readBytes(blob);
    // the camera's metadata (film simulation, recipe…) grafted back on
    const hp = put(head);
    const jp = put(jpg);
    let bytes;
    try {
      bytes = take(wasm.graft(hp, head.length, jp, jpg.length, w, h));
    } finally {
      wasm.dealloc(hp, head.length);
      wasm.dealloc(jp, jpg.length);
    }
    return new File([bytes], p.name, { type: 'image/jpeg', lastModified: p.mtime });
  }

  function remember(delivered) {
    const dest = exportedFiles();
    const imported = new Set(store.get('imported', []));
    for (const d of delivered) {
      if (d.key) S.exported.add(d.key);
      dest.push({ name: d.file.name, size: d.file.size, mtime: d.mtime ?? d.file.lastModified, kind: isRaw(d.file.name) ? 'raw' : isVideo(d.file.name) ? 'video' : 'photo' });
      if (d.source) imported.add(`${d.source.name}:${d.source.size}`);
    }
    store.set('dest', dest.slice(-5000));
    store.set('exported', [...S.exported].slice(-20000));
    store.set('imported', [...imported].slice(-20000));
    try {
      localStorage.setItem('brackit:keysLearned', '1');
    } catch {}
  }

  async function writeTo(dir, file) {
    try {
      const existing = await (await dir.getFileHandle(file.name)).getFile();
      if (existing.size === file.size) return false; // already there
    } catch {}
    const h = await dir.getFileHandle(file.name, { create: true });
    const w = await h.createWritable();
    await w.write(file);
    await w.close();
    return true;
  }

  function download(file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }

  // Called by app.js doExport in place of the desktop's copy to a folder.
  LITE.exportPicks = async function (items, { withRaw, bar, result, tick }) {
    if (LITE.mode === 'folder' && !folder && !(await LITE.chooseDest())) {
      result.textContent = 'Choose a folder to export to (D).';
      return;
    }
    const out = [];
    const failed = [];
    const seenRaw = new Set();
    let done = 0;
    const total = items.length + (withRaw ? items.filter((p) => p.rawName).length : 0);
    for (const pub of items) {
      const p = photoOf(pub.id);
      tick(done, total, pub.name + (editOf(pub) ? ' (cropping)' : ''));
      try {
        const file = editOf(pub) && !p.video ? await croppedFile(p, editOf(pub)) : p.file;
        out.push({ file, key: pub.key, mtime: p.mtime, source: p.src });
      } catch (e) {
        failed.push({ name: pub.name, error: e.message });
      }
      done++;
      if (withRaw && p.raw && !seenRaw.has(p.raw)) {
        seenRaw.add(p.raw);
        out.push({ file: p.raw, mtime: p.raw.lastModified, source: { name: p.rawName, size: p.rawSize } });
      }
    }
    tick(total, total);
    if (LITE.mode === 'folder') {
      let copied = 0;
      let skipped = 0;
      for (const d of out) {
        try {
          (await writeTo(folder, d.file)) ? copied++ : skipped++;
        } catch (e) {
          failed.push({ name: d.file.name, error: e.message });
        }
      }
      remember(out.filter((d) => !failed.some((f) => f.name === d.file.name)));
      return { copied, skipped, failed, where: folder.name };
    }
    if (LITE.mode === 'download') {
      for (const d of out) {
        download(d.file);
        await new Promise((r) => setTimeout(r, 250)); // browsers drop downloads fired all at once
      }
      remember(out);
      return { copied: out.length, skipped: 0, failed, where: 'Downloads' };
    }
    // share sheet: needs a fresh tap, so offer a button (Enter works too)
    return new Promise((resolve) => {
      result.replaceChildren();
      const files = out.map((d) => d.file);
      const n = files.length;
      const photosOnly = files.every((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
      const b = el('button', 'btn primary share-now', `Save ${n} file${n === 1 ? '' : 's'}… `);
      b.append(el('kbd', '', '↵'));
      b.onclick = async () => {
        try {
          await navigator.share({ files });
          remember(out);
          resolve({ copied: n, skipped: 0, failed, where: photosOnly ? 'Photos or Files' : 'Files' });
        } catch (e) {
          if (e && e.name === 'AbortError') return; // closed the share sheet: try again
          failed.push({ name: 'share', error: e.message });
          resolve({ copied: 0, skipped: 0, failed, where: 'nowhere' });
        }
      };
      result.append(b, el('span', 'muted', photosOnly ? '  then Save to Photos, or Save to Files' : '  then Save to Files (RAW files only go to Files)'));
      LITE.pendingShare = b;
      b.focus();
    });
  };

  /* ---------------------------------------------------------- the page */

  document.body.classList.add('lite');
  if (touch) document.body.classList.add('touch');
  const q = (sel) => document.querySelector(sel);
  if (!LITE.canPickFolder) {
    // phones and tablets pick files (from Files or Photos), not folders
    q('#choose').innerHTML = 'Choose photos… <kbd>O</kbd>';
    q('#lite-files').hidden = true;
  }
  q('#survey-back').textContent = 'Choose again';
  if (touch) {
    q('#key-hint').textContent = 'Swipe to flip · tap a look to pick it · double-tap to see it large';
    q('.keyline').textContent = 'Swipe to flip, tap a look to pick it, double-tap to see it large.';
  }
})();
