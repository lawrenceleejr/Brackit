'use strict';
/* Brackit UI. No framework: a handful of views toggled by `hidden`, a keyboard
   map, and a small decoded-image cache so flipping between sets is instant. */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const api = async (method, url, body) => {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};
const dpr = () => window.devicePixelRatio || 1;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const S = {
  server: null,
  lib: null, // {root, sets, photos}
  view: [], // visible sets (filtered)
  idx: 0,
  bracketsOnly: false,
  flags: new Set(),
  exported: new Set(),
  edits: {},
  dest: null,
  solo: null, // {pos, zoom}
  editor: null,
  hoverPos: null,
};

/* ------------------------------------------------------------ boot */

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('shell') === 'electron') document.body.classList.add('electron');
  S.server = await api('GET', '/api/state');
  document.body.classList.add(S.server.platform);
  S.flags = new Set(S.server.flags || []);
  S.exported = new Set(S.server.exported || []);
  S.edits = S.server.edits || {};
  S.dest = S.server.lastDest || S.server.defaultDest;
  bindUi();
  const open = params.get('open') || (S.server.root ? S.server.root : null);
  if (open) {
    history.replaceState(null, '', location.pathname + (S.server.shell === 'electron' ? '?shell=electron' : ''));
    showWelcome();
    return openFolder(open);
  }
  showWelcome();
}

/* ------------------------------------------------------------ welcome */

async function showWelcome() {
  $('#viewer').hidden = true;
  $('#welcome').hidden = false;
  $('#bar .center').hidden = true;
  $('#staged-btn').hidden = $('#fs-btn').hidden = true;
  $('#folder').textContent = '';
  const box = $('#volumes');
  box.innerHTML = '';
  const { volumes } = await api('GET', '/api/volumes').catch(() => ({ volumes: [] }));
  const entries = volumes.map((v) => ({ name: v.name, path: v.path, where: 'card' }));
  if (S.server.lastRoot && !entries.some((e) => e.path === S.server.lastRoot)) {
    entries.push({ name: S.server.lastRoot.split('/').filter(Boolean).pop() || '/', path: S.server.lastRoot, where: 'last opened' });
  }
  for (const v of entries) {
    const b = el('button', 'volume');
    b.append(el('span', 'name', v.name), el('span', 'where', v.where === 'card' ? v.path : v.where));
    b.onclick = () => openFolder(v.path);
    box.append(b);
  }
  $('#path-input').value = '';
}

async function chooseFolder(prompt, defaultPath) {
  if (!S.server.canPick) {
    const p = window.prompt(prompt, defaultPath || '');
    return p && p.trim();
  }
  const { path } = await api('POST', '/api/pick', { prompt, defaultPath });
  return path;
}

async function openFolder(path) {
  const status = $('#scan-status');
  status.textContent = 'Reading card…';
  let polling = true;
  (async function poll() {
    while (polling) {
      await new Promise((r) => setTimeout(r, 200));
      const p = await api('GET', '/api/progress').catch(() => null);
      if (polling && p && p.total) status.textContent = `Reading ${p.done} of ${p.total} files`;
    }
  })();
  try {
    const lib = await api('POST', '/api/open', { path });
    polling = false;
    status.textContent = '';
    S.server.lastRoot = lib.root;
    loadLibrary(lib);
  } catch (e) {
    polling = false;
    status.textContent = e.message;
  }
}

function loadLibrary(lib) {
  S.lib = lib;
  imageCache.clear();
  applyFilter(false);
  let saved = 0;
  try {
    saved = Number(localStorage.getItem('brackit:idx:' + lib.root)) || 0;
  } catch {}
  S.idx = clamp(saved, 0, Math.max(0, S.view.length - 1));
  $('#welcome').hidden = true;
  $('#viewer').hidden = false;
  $('#bar .center').hidden = false;
  $('#staged-btn').hidden = $('#fs-btn').hidden = false;
  $('#folder').textContent = lib.root;
  $('#folder').title = lib.root + ' — open another (O)';
  render();
}

function applyFilter(keep = true) {
  const current = keep ? S.view[S.idx] : null;
  const all = S.lib ? S.lib.sets : [];
  S.view = S.bracketsOnly ? all.filter((s) => s.photos.length > 1) : all;
  if (current) {
    let i = S.view.indexOf(current);
    if (i < 0) i = S.view.findIndex((s) => s.index > current.index);
    S.idx = i < 0 ? S.view.length - 1 : i;
  }
  S.idx = clamp(S.idx, 0, Math.max(0, S.view.length - 1));
}

/* ------------------------------------------------------------ image cache */

const imageCache = new Map(); // url -> {img, promise, done}
function getImage(url) {
  let entry = imageCache.get(url);
  if (entry) {
    imageCache.delete(url); // refresh LRU position
    imageCache.set(url, entry);
    return entry;
  }
  const img = new Image();
  img.decoding = 'async';
  img.draggable = false;
  img.src = url;
  entry = { img, done: false };
  entry.promise = img.decode().then(
    () => ((entry.done = true), img),
    () => ((entry.done = true), img)
  );
  imageCache.set(url, entry);
  while (imageCache.size > 48) imageCache.delete(imageCache.keys().next().value);
  return entry;
}
const previewUrl = (id) => `/api/img/${id}`;
const fullUrl = (id) => `/api/img/${id}?full=1`;
const photo = (id) => S.lib.photos[id];

function preloadAround() {
  for (const d of [1, 2, -1, 3, -2]) {
    const set = S.view[S.idx + d];
    if (!set || set.kind === 'video') continue;
    for (const id of set.photos) getImage(previewUrl(id));
  }
}

/* ------------------------------------------------------------ edits (straighten & crop) */

const IDENTITY = { angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'free' };
const editOf = (p) => (p && S.edits[p.key]) || null;

function coverScale(W, H, deg) {
  const t = (Math.abs(deg) * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return Math.max((W * c + H * s) / W, (W * s + H * c) / H);
}

// Draws the straightened (rotate + scale-to-cover) image, optionally cropped.
function drawEdited(ctx, src, W, H, edit, scale, cropped) {
  const k = coverScale(W, H, edit.angle);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(scale, scale);
  if (cropped) ctx.translate(-edit.crop.x * W, -edit.crop.y * H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate((edit.angle * Math.PI) / 180);
  ctx.scale(k, k);
  ctx.drawImage(src, -W / 2, -H / 2, W, H);
  ctx.restore();
}

function renderEdited(img, edit, maxWidth) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const cw = edit.crop.w * W;
  const scale = maxWidth ? Math.min(1, maxWidth / cw) : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * scale));
  c.height = Math.max(1, Math.round(edit.crop.h * H * scale));
  drawEdited(c.getContext('2d'), img, W, H, edit, scale, true);
  return c;
}

let editsTimer = null;
function saveEdits() {
  clearTimeout(editsTimer);
  editsTimer = setTimeout(() => api('PUT', '/api/edits', { edits: S.edits }).catch(() => toast('Could not save edits')), 200);
}

/* ------------------------------------------------------------ flags */

let flagTimer = null;
function saveFlags() {
  clearTimeout(flagTimer);
  flagTimer = setTimeout(() => api('PUT', '/api/flags', { flags: [...S.flags] }).catch(() => toast('Could not save flags')), 150);
}

function toggleFlag(pos) {
  const set = S.view[S.idx];
  if (!set || pos >= set.photos.length) return;
  const p = photo(set.photos[pos]);
  if (S.flags.has(p.key)) S.flags.delete(p.key);
  else S.flags.add(p.key);
  saveFlags();
  updateFlagsUi();
}

function stagedPhotos() {
  if (!S.lib) return [];
  const out = [];
  for (const set of S.lib.sets) for (const id of set.photos) if (S.flags.has(photo(id).key)) out.push(photo(id));
  return out;
}

function updateFlagsUi() {
  const set = S.view[S.idx];
  if (set) {
    document.querySelectorAll('#stage .look').forEach((look, i) => {
      look.classList.toggle('flagged', S.flags.has(photo(set.photos[i]).key));
    });
    if (S.solo) $('#solo-caption').classList.toggle('flagged', S.flags.has(photo(set.photos[S.solo.pos]).key));
  }
  const n = stagedPhotos().length;
  $('#staged-count').textContent = n;
  $('#staged-btn').classList.toggle('has', n > 0);
  drawTicks();
}

/* ------------------------------------------------------------ viewer */

function fmtDate(dt) {
  if (!dt) return '';
  const m = dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (!m) return dt;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${+m[3]} ${months[+m[2] - 1]} ${m[1]}  ${m[4]}`;
}
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(b > 1e8 ? 0 : 1) + ' MB');
const fmtDur = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

function caption(p, pos, count) {
  const c = el('div', 'caption');
  const key = el('span', 'key', String(pos + 1));
  key.title = `Flag for export (${pos + 1})`;
  key.onclick = (e) => {
    e.stopPropagation();
    toggleFlag(pos);
  };
  c.append(key);
  c.append(el('span', 'sim', p.kind === 'video' ? 'Video' : p.filmSim || (count > 1 ? `Look ${pos + 1}` : 'Photo')));
  c.append(el('span', 'file', p.name));
  if (editOf(p)) c.append(el('span', 'edited', 'cropped'));
  if (S.exported.has(p.key)) c.append(el('span', 'exported', 'exported'));
  return c;
}

let renderToken = 0;
function render() {
  const token = ++renderToken;
  const stage = $('#stage');
  stage.innerHTML = '';
  const set = S.view[S.idx];
  if (!set) {
    stage.append(el('div', 'empty', S.lib && S.lib.sets.length ? 'No brackets here — press B to show all photos.' : 'No JPEGs or videos found in this folder.'));
    $('#counter').textContent = '';
    $('#set-date').textContent = $('#set-files').textContent = '';
    drawTicks();
    return;
  }
  try {
    localStorage.setItem('brackit:idx:' + S.lib.root, S.idx);
  } catch {}
  $('#counter').innerHTML = `<b>${S.idx + 1}</b> / ${S.view.length}`;
  $('#set-date').textContent = fmtDate(set.dateTime);
  const names = set.photos.map((id) => photo(id).name);
  $('#set-files').textContent = names.length > 1 ? `${names[0]} – ${names[names.length - 1]}` : names[0];

  set.photos.forEach((id, pos) => {
    const p = photo(id);
    const look = el('div', 'look');
    if (S.flags.has(p.key)) look.classList.add('flagged');
    const frame = el('div', 'frame');
    look.append(frame, caption(p, pos, set.photos.length));
    look.onmouseenter = () => (S.hoverPos = pos);
    stage.append(look);

    if (p.kind === 'video') {
      look.classList.add('video');
      const v = document.createElement('video');
      v.src = previewUrl(id);
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      v.onloadedmetadata = () => {
        const sim = look.querySelector('.sim');
        if (sim) sim.textContent = `Video  ${fmtDur(v.duration)}`;
      };
      v.onerror = () => {
        frame.innerHTML = '';
        frame.append(el('div', 'empty muted', 'This video’s codec can’t be previewed here. It will still export.'));
      };
      frame.append(v);
      return;
    }

    frame.onclick = () => openSolo(pos);
    const entry = getImage(previewUrl(id));
    entry.promise.then((img) => {
      if (token !== renderToken) return;
      const edit = editOf(p);
      let node = img;
      if (edit) node = renderEdited(img, edit, frame.clientWidth * dpr() * 1.25);
      if (entry.done && !node.classList.contains('ready')) {
        // first appearance fades in; cached ones appear instantly
        requestAnimationFrame(() => node.classList.add('ready'));
      }
      if (edit) node.classList.add('ready');
      frame.append(node);
    });
  });
  S.hoverPos = null;
  drawTicks();
  preloadAround();
  if (S.solo) renderSolo();
}

function go(delta) {
  if (!S.view.length) return;
  const next = clamp(S.idx + delta, 0, S.view.length - 1);
  if (next === S.idx) return;
  S.idx = next;
  if (S.solo) {
    S.solo.zoom = false;
    S.solo.pos = Math.min(S.solo.pos, S.view[S.idx].photos.length - 1);
  }
  render();
}

function nextUnflagged() {
  for (let i = S.idx + 1; i < S.view.length; i++) {
    if (!S.view[i].photos.some((id) => S.flags.has(photo(id).key))) {
      S.idx = i;
      return render();
    }
  }
  toast('Every later set has a pick');
}

/* index: one hairline tick per set. Flagged sets stand taller, in the accent. */
function drawTicks() {
  const c = $('#ticks');
  const w = c.clientWidth;
  const h = 22;
  if (!w) return;
  c.width = Math.round(w * dpr());
  c.height = Math.round(h * dpr());
  const ctx = c.getContext('2d');
  ctx.scale(dpr(), dpr());
  ctx.clearRect(0, 0, w, h);
  const n = S.view.length;
  if (!n) return;
  const step = w / n;
  const tw = Math.max(1, Math.min(2, step - 1));
  const css = getComputedStyle(document.documentElement);
  const faint = css.getPropertyValue('--faint').trim();
  const accent = css.getPropertyValue('--accent').trim();
  const ink = css.getPropertyValue('--ink').trim();
  for (let i = 0; i < n; i++) {
    const set = S.view[i];
    const flagged = set.photos.some((id) => S.flags.has(photo(id).key));
    const x = Math.floor(i * step + (step - tw) / 2);
    ctx.fillStyle = flagged ? accent : faint;
    const th = flagged ? 12 : set.kind === 'video' ? 9 : 5;
    ctx.fillRect(x, h - th, tw, th);
  }
  const x = Math.floor(S.idx * step + (step - tw) / 2);
  ctx.fillStyle = ink;
  ctx.fillRect(x - (tw < 2 ? 0 : 0), 0, Math.max(tw, 1.5), h);
}

/* ------------------------------------------------------------ solo (one look, large) */

function openSolo(pos) {
  const set = S.view[S.idx];
  if (!set || set.kind === 'video') return;
  S.solo = { pos, zoom: false };
  $('#solo').hidden = false;
  renderSolo();
}

function closeSolo() {
  S.solo = null;
  $('#solo').hidden = true;
  $('#solo').classList.remove('zoom');
  $('#solo-frame').innerHTML = '';
}

let soloToken = 0;
function renderSolo() {
  const token = ++soloToken;
  const set = S.view[S.idx];
  if (!set || set.kind === 'video') return closeSolo();
  const id = set.photos[S.solo.pos];
  const p = photo(id);
  const frame = $('#solo-frame');
  const solo = $('#solo');
  solo.classList.toggle('zoom', !!S.solo.zoom);
  const cap = $('#solo-caption');
  cap.replaceWith((() => {
    const c = caption(p, S.solo.pos, set.photos.length);
    c.id = 'solo-caption';
    c.classList.toggle('flagged', S.flags.has(p.key));
    if (set.photos.length > 1) c.append(el('span', 'file', `${S.solo.pos + 1} of ${set.photos.length}  ↑↓`));
    return c;
  })());
  const show = (node) => {
    if (token !== soloToken) return;
    node.style.width = '';
    node.style.transform = '';
    frame.innerHTML = '';
    frame.append(node);
    if (S.solo.zoom) zoomTo(S.solo.zx ?? 0.5, S.solo.zy ?? 0.5);
  };
  const edit = editOf(p);
  // preview first (instant), then swap in the full-resolution file
  const pre = getImage(previewUrl(id));
  pre.promise.then((img) => {
    if (token !== soloToken) return;
    if (!frame.firstChild || frame.dataset.id !== id) {
      frame.dataset.id = id;
      show(edit ? renderEdited(img, edit, frame.clientWidth * dpr()) : img.cloneNode());
    }
  });
  const full = new Image();
  full.decoding = 'async';
  full.src = fullUrl(id);
  full.decode().then(() => {
    if (token !== soloToken) return;
    frame.dataset.id = id;
    show(edit ? renderEdited(full, edit) : full);
  }, () => {});
}

function soloNode() {
  return $('#solo-frame').firstChild;
}
function naturalSize(node) {
  return node.tagName === 'CANVAS' ? [node.width, node.height] : [node.naturalWidth, node.naturalHeight];
}
function zoomTo(fx, fy) {
  const node = soloNode();
  if (!node) return;
  const frame = $('#solo-frame');
  const [nw, nh] = naturalSize(node);
  const w = nw / dpr();
  const h = nh / dpr();
  node.style.width = w + 'px';
  const fw = frame.clientWidth;
  const fh = frame.clientHeight;
  const tx = w > fw ? -(w - fw) * fx : (fw - w) / 2;
  const ty = h > fh ? -(h - fh) * fy : (fh - h) / 2;
  node.style.transform = `translate(${tx}px, ${ty}px)`;
  S.solo.zx = fx;
  S.solo.zy = fy;
}
function toggleZoom(e) {
  if (!S.solo) return;
  S.solo.zoom = !S.solo.zoom;
  $('#solo').classList.toggle('zoom', S.solo.zoom);
  const node = soloNode();
  if (!node) return;
  if (S.solo.zoom) {
    const r = $('#solo-frame').getBoundingClientRect();
    const fx = e ? clamp((e.clientX - r.left) / r.width, 0, 1) : 0.5;
    const fy = e ? clamp((e.clientY - r.top) / r.height, 0, 1) : 0.5;
    zoomTo(fx, fy);
  } else {
    node.style.width = '';
    node.style.transform = '';
  }
}

/* ------------------------------------------------------------ straighten & crop editor */

function openEditor(pos) {
  const set = S.view[S.idx];
  if (!set || set.kind === 'video') return;
  pos = pos ?? (S.solo ? S.solo.pos : S.hoverPos ?? 0);
  const p = photo(set.photos[pos]);
  const existing = editOf(p) || IDENTITY;
  S.editor = {
    set,
    pos,
    img: null,
    angle: existing.angle,
    crop: { ...existing.crop },
    aspect: existing.aspect || 'free',
  };
  $('#editor').hidden = false;
  $('#angle').value = existing.angle;
  setAspectUi(S.editor.aspect);
  getImage(previewUrl(p.id)).promise.then((img) => {
    if (!S.editor) return;
    S.editor.img = img;
    layoutEditor();
  });
}

function closeEditor(commit) {
  const ed = S.editor;
  if (!ed) return;
  if (commit) {
    const isIdentity =
      Math.abs(ed.angle) < 0.001 && ed.crop.x < 1e-4 && ed.crop.y < 1e-4 && ed.crop.w > 0.9999 && ed.crop.h > 0.9999;
    // composition is shared by every look in the bracket, so apply to all
    for (const id of ed.set.photos) {
      const key = photo(id).key;
      if (isIdentity) delete S.edits[key];
      else S.edits[key] = { angle: +ed.angle.toFixed(2), crop: { ...ed.crop }, aspect: ed.aspect };
    }
    saveEdits();
  }
  S.editor = null;
  $('#editor').hidden = true;
  if (commit) {
    render();
    if (!$('#staged').hidden) renderStaged();
  }
}

function aspectRatio(a) {
  const ed = S.editor;
  const W = ed.img.naturalWidth;
  const H = ed.img.naturalHeight;
  if (a === 'free') return null;
  if (a === 'orig') return W / H;
  const r = parseFloat(a);
  return W >= H ? r : 1 / r; // follow the photo's orientation
}

function setAspectUi(a) {
  document.querySelectorAll('#aspects button').forEach((b) => b.classList.toggle('on', b.dataset.a === a));
  $('#editor').classList.toggle('locked', a !== 'free');
}

function setAspect(a) {
  const ed = S.editor;
  if (!ed || !ed.img) return;
  ed.aspect = a;
  setAspectUi(a);
  const R = aspectRatio(a);
  if (R) {
    const W = ed.img.naturalWidth;
    const H = ed.img.naturalHeight;
    let w = Math.min(1, (R * H) / W);
    let h = (w * W) / (R * H);
    if (h > 1) {
      w /= h;
      h = 1;
    }
    const cx = ed.crop.x + ed.crop.w / 2;
    const cy = ed.crop.y + ed.crop.h / 2;
    ed.crop = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
  }
  drawEditor();
}

function layoutEditor() {
  const ed = S.editor;
  if (!ed || !ed.img) return;
  const area = $('#editor-area');
  const cs = getComputedStyle(area);
  const aw = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const W = ed.img.naturalWidth;
  const H = ed.img.naturalHeight;
  const s = Math.min(aw / W, ah / H);
  ed.dw = Math.floor(W * s);
  ed.dh = Math.floor(H * s);
  const c = $('#editor-canvas');
  c.style.width = ed.dw + 'px';
  c.style.height = ed.dh + 'px';
  c.width = Math.round(ed.dw * dpr());
  c.height = Math.round(ed.dh * dpr());
  drawEditor();
}

function drawEditor() {
  const ed = S.editor;
  if (!ed || !ed.img) return;
  const c = $('#editor-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  drawEdited(ctx, ed.img, ed.img.naturalWidth, ed.img.naturalHeight, ed, c.width / ed.img.naturalWidth, false);
  const box = $('#crop-box');
  box.style.left = ed.crop.x * ed.dw + 'px';
  box.style.top = ed.crop.y * ed.dh + 'px';
  box.style.width = ed.crop.w * ed.dw + 'px';
  box.style.height = ed.crop.h * ed.dh + 'px';
  $('#angle-val').textContent = (ed.angle > 0 ? '+' : ed.angle < 0 ? '−' : '') + Math.abs(ed.angle).toFixed(1) + '°';
}

function setAngle(a) {
  if (!S.editor) return;
  S.editor.angle = clamp(Math.round(a * 100) / 100, -15, 15);
  $('#angle').value = S.editor.angle;
  drawEditor();
}

function bindCropDrag() {
  const box = $('#crop-box');
  const MIN = 0.04;
  box.addEventListener('pointerdown', (e) => {
    const ed = S.editor;
    if (!ed || !ed.img) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const handle = e.target.dataset.h || 'move';
    const r0 = { ...ed.crop };
    const sx = e.clientX;
    const sy = e.clientY;
    const W = ed.img.naturalWidth;
    const H = ed.img.naturalHeight;
    const R = aspectRatio(ed.aspect);
    const move = (ev) => {
      const dx = (ev.clientX - sx) / ed.dw;
      const dy = (ev.clientY - sy) / ed.dh;
      let { x, y, w, h } = r0;
      if (handle === 'move') {
        x = clamp(r0.x + dx, 0, 1 - r0.w);
        y = clamp(r0.y + dy, 0, 1 - r0.h);
      } else if (R && handle.length === 2) {
        // aspect-locked corner: anchor the opposite corner
        const right = handle.includes('e');
        const down = handle.includes('s');
        const ax = right ? r0.x : r0.x + r0.w;
        const ay = down ? r0.y : r0.y + r0.h;
        const px = (right ? r0.x + r0.w : r0.x) + dx;
        const py = (down ? r0.y + r0.h : r0.y) + dy;
        const toH = W / (R * H); // normalized h per normalized w
        w = Math.max(Math.abs(px - ax), Math.abs(py - ay) / toH);
        const maxW = right ? 1 - ax : ax;
        const maxH = down ? 1 - ay : ay;
        w = clamp(w, MIN, Math.min(maxW, maxH / toH));
        h = w * toH;
        x = right ? ax : ax - w;
        y = down ? ay : ay - h;
      } else {
        if (handle.includes('w')) {
          x = clamp(r0.x + dx, 0, r0.x + r0.w - MIN);
          w = r0.x + r0.w - x;
        }
        if (handle.includes('e')) w = clamp(r0.w + dx, MIN, 1 - r0.x);
        if (handle.includes('n')) {
          y = clamp(r0.y + dy, 0, r0.y + r0.h - MIN);
          h = r0.y + r0.h - y;
        }
        if (handle.includes('s')) h = clamp(r0.h + dy, MIN, 1 - r0.y);
      }
      ed.crop = { x, y, w, h };
      drawEditor();
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  });
}

/* ------------------------------------------------------------ staged & export */

function openStaged() {
  if (!S.lib) return;
  $('#staged').hidden = false;
  $('#export-result').innerHTML = '';
  $('#export-progress div').style.width = '0';
  renderStaged();
}
function closeStaged() {
  $('#staged').hidden = true;
  $('#staged-grid').innerHTML = '';
}

function renderStaged() {
  const items = stagedPhotos();
  const grid = $('#staged-grid');
  grid.innerHTML = '';
  const vids = items.filter((p) => p.kind === 'video').length;
  const bytes = items.reduce((a, p) => a + p.size, 0);
  const parts = [];
  if (items.length - vids) parts.push(`${items.length - vids} photo${items.length - vids === 1 ? '' : 's'}`);
  if (vids) parts.push(`${vids} video${vids === 1 ? '' : 's'}`);
  const edited = items.filter((p) => editOf(p)).length;
  if (edited) parts.push(`${edited} cropped`);
  $('#staged-summary').textContent = items.length ? `${parts.join(' · ')} · ${fmtBytes(bytes)}` : 'Nothing staged yet';
  $('#dest').textContent = S.dest.replace(S.server.home, '~');
  $('#dest').title = S.dest;
  $('#export').disabled = !items.length;
  $('#clear-flags').hidden = !items.length;
  if (!items.length) {
    grid.append(el('div', 'staged-empty', 'Press 1, 2 or 3 on a set to stage a look.'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      en.target._load();
    }
  }, { root: grid, rootMargin: '400px' });

  for (const p of items) {
    const tile = el('div', 'tile');
    const thumb = el('div', 'thumb');
    tile.append(thumb);
    const meta = el('div', 'meta');
    meta.append(el('span', 'sim', p.kind === 'video' ? 'Video' : p.filmSim || 'Photo'), el('span', 'muted', p.name));
    tile.append(meta);
    if (p.kind === 'video') tile.append(el('span', 'badge', 'video'));
    else if (editOf(p)) tile.append(el('span', 'badge', 'cropped'));
    const rm = el('button', 'remove', '×');
    rm.title = 'Unstage';
    rm.onclick = (e) => {
      e.stopPropagation();
      S.flags.delete(p.key);
      saveFlags();
      updateFlagsUi();
      renderStaged();
    };
    tile.append(rm);
    tile.onclick = () => {
      const i = S.view.findIndex((s) => s.photos.includes(p.id));
      if (i < 0) {
        S.bracketsOnly = false;
        applyFilter(false);
      }
      S.idx = S.view.findIndex((s) => s.photos.includes(p.id));
      closeStaged();
      render();
    };
    thumb._load = () => {
      if (p.kind === 'video') {
        const v = document.createElement('video');
        v.src = previewUrl(p.id) + '#t=0.5';
        v.preload = 'metadata';
        v.muted = true;
        thumb.append(v);
        return;
      }
      const img = new Image();
      img.decoding = 'async';
      img.src = previewUrl(p.id);
      const edit = editOf(p);
      img.decode().then(() => thumb.append(edit ? renderEdited(img, edit, 700) : img), () => {});
    };
    io.observe(thumb);
    grid.append(tile);
  }
}

let exporting = false;
async function doExport() {
  if (exporting) return;
  const items = stagedPhotos();
  if (!items.length) return;
  exporting = true;
  const bar = $('#export-progress div');
  const result = $('#export-result');
  $('#export').disabled = true;
  result.textContent = 'Exporting…';
  const total = items.length;
  let done = 0;
  let copied = 0;
  let skipped = 0;
  const failed = [];
  const tick = (name) => {
    bar.style.width = (100 * done) / total + '%';
    result.textContent = `Exporting ${done} of ${total}${name ? ' · ' + name : ''}`;
  };
  try {
    const plain = items.filter((p) => !editOf(p));
    const edited = items.filter((p) => editOf(p));
    if (plain.length) {
      const r = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest: S.dest, ids: plain.map((p) => p.id) }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'export failed');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const base = done;
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (msg.finished) {
            copied += msg.copied;
            skipped += msg.skipped;
            failed.push(...msg.failed);
          } else {
            done = base + msg.done;
            tick(msg.name);
          }
        }
      }
    }
    for (const p of edited) {
      tick(p.name + ' (cropping)');
      try {
        const res = await exportEdited(p, editOf(p));
        if (res.skipped) skipped++;
        else copied++;
      } catch (err) {
        failed.push({ name: p.name, error: err.message });
      }
      done++;
      tick();
    }
    for (const p of items) if (!failed.some((f) => f.name === p.name)) S.exported.add(p.key);
    bar.style.width = '100%';
    result.innerHTML = '';
    const bits = [`Copied ${copied}`];
    if (skipped) bits.push(`${skipped} already there`);
    if (failed.length) bits.push(`${failed.length} failed (${failed.map((f) => f.name).join(', ')})`);
    result.append(el('span', '', bits.join(' · ') + ' → '));
    const reveal = el('button', '', S.dest.replace(S.server.home, '~'));
    reveal.title = 'Show in Finder';
    reveal.onclick = () => api('POST', '/api/reveal', { path: S.dest });
    result.append(reveal);
    render();
  } catch (e) {
    result.textContent = 'Export failed: ' + e.message;
  } finally {
    exporting = false;
    $('#export').disabled = false;
  }
}

// Renders the crop from the full-resolution file and hands the JPEG to the
// server, which restores the camera's EXIF before writing it.
async function exportEdited(p, edit) {
  const img = new Image();
  img.decoding = 'async';
  img.src = fullUrl(p.id);
  await img.decode();
  const canvas = renderEdited(img, edit);
  const w = canvas.width;
  const h = canvas.height;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('could not encode image');
  const q = new URLSearchParams({ id: p.id, dest: S.dest, w, h });
  const r = await fetch(`/api/export-edited?${q}`, { method: 'POST', body: blob });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'export failed');
  return data;
}

/* ------------------------------------------------------------ chrome */

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast('Full screen unavailable'));
}

function videoEl() {
  return document.querySelector('#stage video');
}

function bindUi() {
  $('#choose').onclick = async () => {
    const p = await chooseFolder('Choose your SD card or a folder of photos', '/Volumes');
    if (p) openFolder(p);
  };
  $('#path-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#path-input').value.trim();
    if (v) openFolder(v);
  };
  $('#folder').onclick = () => showWelcome();
  $('#staged-btn').onclick = () => openStaged();
  $('#fs-btn').onclick = toggleFullscreen;
  $('#help-btn').onclick = () => ($('#help').hidden = !$('#help').hidden);
  $('#help').onclick = () => ($('#help').hidden = true);
  $('#staged-close').onclick = closeStaged;
  $('#export').onclick = doExport;
  $('#clear-flags').onclick = () => {
    const items = stagedPhotos();
    if (!items.length || !confirm(`Unstage all ${items.length}?`)) return;
    for (const p of items) S.flags.delete(p.key);
    saveFlags();
    updateFlagsUi();
    renderStaged();
  };
  $('#dest').onclick = async () => {
    const p = await chooseFolder('Export to…', S.dest);
    if (p) {
      S.dest = p;
      renderStaged();
    }
  };
  $('#ticks').onclick = (e) => {
    const r = e.target.getBoundingClientRect();
    S.idx = clamp(Math.floor(((e.clientX - r.left) / r.width) * S.view.length), 0, S.view.length - 1);
    render();
  };
  $('#solo-frame').onclick = (e) => toggleZoom(e);
  $('#solo-frame').onmousemove = (e) => {
    if (!S.solo || !S.solo.zoom) return;
    const r = e.currentTarget.getBoundingClientRect();
    zoomTo(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
  };

  // editor
  bindCropDrag();
  $('#angle').oninput = (e) => setAngle(parseFloat(e.target.value));
  $('#angle').onpointerdown = () => $('#editor').classList.add('rotating');
  window.addEventListener('pointerup', () => $('#editor').classList.remove('rotating'));
  $('#aspects').onclick = (e) => e.target.dataset.a && setAspect(e.target.dataset.a);
  $('#edit-reset').onclick = () => {
    if (!S.editor) return;
    S.editor.angle = 0;
    S.editor.crop = { ...IDENTITY.crop };
    $('#angle').value = 0;
    setAspect('free');
  };
  $('#edit-cancel').onclick = () => closeEditor(false);
  $('#edit-done').onclick = () => closeEditor(true);

  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fs', !!document.fullscreenElement);
    setTimeout(onResize, 50);
  });
  let chromeTimer = null;
  document.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('fs')) return;
    const near = e.clientY < 70 || e.clientY > window.innerHeight - 80;
    document.body.classList.toggle('chrome', near);
    clearTimeout(chromeTimer);
    if (near) chromeTimer = setTimeout(() => document.body.classList.remove('chrome'), 2500);
  });

  let rt = null;
  const onResize = () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      drawTicks();
      if (S.editor) layoutEditor();
      else if (!$('#viewer').hidden) render();
    }, 80);
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;

  if (!$('#help').hidden) {
    $('#help').hidden = true;
    return e.preventDefault();
  }
  if (k === '?') {
    $('#help').hidden = false;
    return;
  }

  if (S.editor) {
    if (k === 'Escape') closeEditor(false);
    else if (k === 'Enter') closeEditor(true);
    else if (k === '[' || k === '{') setAngle(S.editor.angle - (e.shiftKey ? 1 : 0.1));
    else if (k === ']' || k === '}') setAngle(S.editor.angle + (e.shiftKey ? 1 : 0.1));
    else if (k === 'r' || k === 'R') $('#edit-reset').click();
    else return;
    return e.preventDefault();
  }

  if (!$('#staged').hidden) {
    if (k === 'Escape' || k === 's' || k === 'S') closeStaged();
    else if (k === 'Enter') doExport();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else return;
    return e.preventDefault();
  }

  if ($('#viewer').hidden) {
    if (k === 'f' || k === 'F') toggleFullscreen();
    return;
  }

  const set = S.view[S.idx];
  switch (k) {
    case 'ArrowRight':
    case '.':
      go(e.shiftKey ? 10 : 1);
      break;
    case 'ArrowLeft':
    case ',':
      go(e.shiftKey ? -10 : -1);
      break;
    case 'Home':
      S.idx = 0;
      render();
      break;
    case 'End':
      S.idx = S.view.length - 1;
      render();
      break;
    case '1':
    case '2':
    case '3':
      toggleFlag(Number(k) - 1);
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      if (S.solo && set) {
        const n = set.photos.length;
        S.solo.pos = (S.solo.pos + (k === 'ArrowDown' ? 1 : -1) + n) % n;
        S.solo.zoom = S.solo.zoom || false;
        renderSolo();
      } else return;
      break;
    case ' ': {
      const v = videoEl();
      if (v) v.paused ? v.play() : v.pause();
      else if (S.solo) closeSolo();
      else if (set) openSolo(S.hoverPos ?? 0);
      break;
    }
    case 'Enter':
      if (!S.solo && set && set.kind !== 'video') openSolo(S.hoverPos ?? 0);
      break;
    case 'z':
    case 'Z':
      if (S.solo) toggleZoom();
      break;
    case 'c':
    case 'C':
      openEditor();
      break;
    case 'Escape':
      if (S.solo) closeSolo();
      else if (document.fullscreenElement) document.exitFullscreen();
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 's':
    case 'S':
    case 'e':
    case 'E':
      openStaged();
      break;
    case 'b':
    case 'B':
      S.bracketsOnly = !S.bracketsOnly;
      applyFilter(true);
      toast(S.bracketsOnly ? 'Brackets only' : 'All photos & videos');
      render();
      break;
    case 'u':
    case 'U':
      nextUnflagged();
      break;
    case 'o':
    case 'O':
      if (S.solo) closeSolo();
      showWelcome();
      break;
    default:
      return;
  }
  e.preventDefault();
}

boot().catch((e) => {
  document.body.textContent = 'Brackit could not start: ' + e.message;
});
