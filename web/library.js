'use strict';
/* Library (L): everything already in the export folder — browse by folder
   and day, rate 0–5 stars, flag, read the recipe and full metadata, open
   large, reveal or move to the Trash. Shares helpers with app.js. */

const LIB = {
  open: false,
  data: null, // server summary of the export folder
  items: [], // filtered, sorted photos
  cursor: 0,
  filter: { flag: false, stars: 0, sim: null, folder: null },
  view: null, // large view: { i, token, timer }
  thumbs: new Map(), // id -> object URL
  waiting: new Set(),
  thumbTimer: 0,
  io: null,
};

const libRatings = () => (S.ratings = S.ratings || { ...(S.server.ratings || {}) });
const libFlagged = () => (S.flaggedOut = S.flaggedOut || new Set(S.server.flagged || []));
const starsOf = (p) => libRatings()[p.key] ?? p.camRating ?? 0;
const isFlagged = (p) => libFlagged().has(p.key);
const libUrl = (id, q = '') => `/api/img/${id}?src=out${q}`;

/* ------------------------------------------------------------ open / close */

async function openLibrary() {
  if (S.solo) closeSolo();
  LIB.open = true;
  $('#library').hidden = false;
  $('#lib-path').textContent = S.dest.replace(S.server.home, '~');
  $('#lib-path').title = S.dest;
  $('#lib-summary').textContent = 'Reading the folder…';
  $('#lib-grid').replaceChildren();
  $('#lib-folders').replaceChildren();
  $('#lib-detail').replaceChildren();
  try {
    LIB.data = await api('POST', '/api/out/open', { path: S.dest });
  } catch (e) {
    LIB.data = null;
    $('#lib-summary').textContent = '';
    const empty = el('div', 'lib-empty');
    empty.append(el('p', '', e.message), el('p', 'muted', 'Choose another folder with the path above.'));
    $('#lib-grid').replaceChildren(empty);
    return;
  }
  for (const u of LIB.thumbs.values()) URL.revokeObjectURL(u);
  LIB.thumbs.clear();
  S.out = LIB.data; // the loupe and overlays look photos up here
  LIB.cursor = 0;
  renderLibrary();
}

function closeLibrary() {
  if (LIB.view) closeLibView();
  LIB.open = false;
  $('#library').hidden = true;
  if (LIB.io) LIB.io.disconnect();
  $('#lib-grid').replaceChildren();
}

async function chooseLibraryFolder() {
  const p = await chooseFolder('Show the library of…', S.dest);
  if (!p) return;
  S.dest = p;
  openLibrary();
}

/* ------------------------------------------------------------ filtering & layout */

function libAll() {
  return LIB.data ? Object.values(LIB.data.photos).filter((p) => p.kind !== 'video' || true) : [];
}

function applyLibFilter() {
  const f = LIB.filter;
  LIB.items = libAll()
    .filter((p) => !f.flag || isFlagged(p))
    .filter((p) => !f.stars || starsOf(p) >= f.stars)
    .filter((p) => !f.sim || p.filmSim === f.sim)
    .filter((p) => !f.folder || dirOf(p) === f.folder || dirOf(p).startsWith(f.folder + '/'))
    .sort((a, b) => ((a.dateTime || '') < (b.dateTime || '') ? -1 : (a.dateTime || '') > (b.dateTime || '') ? 1 : a.name < b.name ? -1 : 1));
  LIB.cursor = clamp(LIB.cursor, 0, Math.max(0, LIB.items.length - 1));
}

const dirOf = (p) => p.rel.split('/').slice(0, -1).join('/');

function renderLibrary() {
  applyLibFilter();
  const all = libAll();
  const flagged = all.filter(isFlagged).length;
  const rated = all.filter((p) => starsOf(p) > 0).length;
  const bytes = all.reduce((a, p) => a + p.size, 0);
  $('#lib-summary').textContent = `${fmtN(all.length)} files · ${fmtBytes(bytes)} · ${fmtN(flagged)} flagged · ${fmtN(rated)} rated`;
  renderLibFilters(all);
  renderLibFolders(all);
  renderLibGrid();
  renderLibDetail();
}

function renderLibFilters(all) {
  const box = $('#lib-filters');
  box.replaceChildren();
  const chip = (label, on, fn, title) => {
    const b = el('button', 'chip' + (on ? ' on' : ''), label);
    if (title) b.title = title;
    b.onclick = () => {
      fn();
      LIB.cursor = 0;
      renderLibrary();
    };
    box.append(b);
  };
  const f = LIB.filter;
  chip('All', !f.flag && !f.stars && !f.sim && !f.folder, () => Object.assign(f, { flag: false, stars: 0, sim: null, folder: null }));
  chip('⚑ Flagged', f.flag, () => (f.flag = !f.flag), 'Only flagged (P)');
  for (let n = 1; n <= 5; n++) chip('★'.repeat(n) + '+', f.stars === n, () => (f.stars = f.stars === n ? 0 : n), `${n} stars or more`);
  const sims = [...new Set(all.map((p) => p.filmSim).filter(Boolean))].sort();
  for (const s of sims) chip(s, f.sim === s, () => (f.sim = f.sim === s ? null : s));
  // the same filters from the keyboard
  const keys = el('span', 'lib-keys');
  const k = (key, what) => keys.append(el('kbd', '', key), ` ${what}  `);
  k('⇧P', 'flagged');
  k('⇧1–5', 'stars');
  k('T', 'simulation');
  k('[ ]', 'folder');
  box.append(keys);
}

function renderLibFolders(all) {
  const box = $('#lib-folders');
  box.replaceChildren();
  const counts = new Map();
  for (const p of all) {
    const parts = dirOf(p).split('/').filter(Boolean);
    for (let i = 0; i <= parts.length; i++) {
      const k = parts.slice(0, i).join('/');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  for (const k of [...counts.keys()].sort()) {
    const depth = k ? k.split('/').length : 0;
    const b = el('button', 'lib-folder' + ((LIB.filter.folder || '') === k ? ' on' : ''));
    b.style.paddingLeft = `${8 + depth * 12}px`;
    b.append(el('span', '', k ? k.split('/').pop() : S.dest.split(/[\\/]/).filter(Boolean).pop() || '/'), el('span', 'n', fmtN(counts.get(k))));
    b.onclick = () => {
      LIB.filter.folder = k || null;
      LIB.cursor = 0;
      renderLibrary();
    };
    box.append(b);
  }
}

function renderLibGrid() {
  const grid = $('#lib-grid');
  grid.replaceChildren();
  if (LIB.io) LIB.io.disconnect();
  if (!LIB.items.length) {
    grid.append(el('div', 'lib-empty muted', libAll().length ? 'Nothing matches these filters.' : 'This folder has no photos yet. Export some with E.'));
    return;
  }
  LIB.io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        LIB.io.unobserve(en.target);
        wantLibThumb(en.target);
      }
    },
    { root: grid, rootMargin: '600px 0px' }
  );
  let day = null;
  let row = null;
  LIB.items.forEach((p, i) => {
    const d = (p.dateTime || '').slice(0, 10);
    if (d !== day) {
      day = d;
      grid.append(el('div', 'ov-day', d ? niceDay(d.replace(/:/g, '-')) : 'Undated'));
      row = el('div', 'lib-row');
      grid.append(row);
    }
    const t = el('button', 'lib-tile');
    t.dataset.i = i;
    t.dataset.photo = p.id;
    t.dataset.src = 'out';
    t.title = `${p.rel}${p.filmSim ? ' · ' + p.filmSim : ''}`;
    if (p.kind === 'video') t.append(el('span', 'ov-video', '▶'));
    const meta = el('div', 'lib-tile-meta');
    t.append(meta);
    paintTileMeta(t, p);
    t.onclick = () => setLibCursor(i);
    t.ondblclick = () => openLibView(i);
    row.append(t);
    if (p.kind !== 'video') LIB.io.observe(t);
  });
  setLibCursor(LIB.cursor, 'center');
}

function paintTileMeta(t, p) {
  const meta = t.querySelector('.lib-tile-meta');
  meta.replaceChildren();
  const s = starsOf(p);
  if (s) meta.append(el('span', 'stars', '★'.repeat(s)));
  if (isFlagged(p)) meta.append(el('span', 'flag', '⚑'));
  t.classList.toggle('flagged', isFlagged(p));
}

// thumbnails: batched like the viewer's (60 per request)
function wantLibThumb(tile) {
  const id = tile.dataset.photo;
  if (LIB.thumbs.has(id)) return putLibThumb(tile, LIB.thumbs.get(id));
  LIB.waiting.add(id);
  clearTimeout(LIB.thumbTimer);
  LIB.thumbTimer = setTimeout(flushLibThumbs, 30);
}

async function flushLibThumbs() {
  const ids = [...LIB.waiting].slice(0, 60);
  ids.forEach((id) => LIB.waiting.delete(id));
  if (!ids.length) return;
  try {
    const r = await fetch(`/api/thumbs?src=out&ids=${ids.join(',')}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const nl = bytes.indexOf(10);
    const index = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
    let off = nl + 1;
    const got = new Set();
    for (const [id, len] of index) {
      const url = URL.createObjectURL(new Blob([bytes.subarray(off, off + len)], { type: 'image/jpeg' }));
      LIB.thumbs.set(String(id), url);
      got.add(String(id));
      off += len;
      const tile = document.querySelector(`.lib-tile[data-photo="${id}"]`);
      if (tile) putLibThumb(tile, url);
    }
    // Cropped exports are re-encoded without an embedded thumbnail: show the
    // file itself (only these tiles, and only once they scroll into view).
    for (const id of ids) {
      if (got.has(String(id))) continue;
      const item = LIB.items.find((x) => String(x.id) === String(id));
      if (!item || item.kind === 'video') continue;
      const url = libUrl(id);
      LIB.thumbs.set(String(id), url);
      const tile = document.querySelector(`.lib-tile[data-photo="${id}"]`);
      if (tile) putLibThumb(tile, url);
    }
  } catch {}
  if (LIB.waiting.size) flushLibThumbs();
}

function putLibThumb(tile, url) {
  if (tile.querySelector('img')) return;
  const img = new Image();
  img.decoding = 'async';
  img.alt = '';
  img.src = url;
  tile.prepend(img);
}

function setLibCursor(i, block = 'nearest') {
  if (!LIB.items.length) return;
  LIB.cursor = clamp(i, 0, LIB.items.length - 1);
  document.querySelectorAll('.lib-tile.cursor').forEach((t) => t.classList.remove('cursor'));
  const t = document.querySelector(`.lib-tile[data-i="${LIB.cursor}"]`);
  if (t) {
    t.classList.add('cursor');
    t.scrollIntoView({ block });
  }
  renderLibDetail();
}

function libVertical(dir) {
  const tiles = [...document.querySelectorAll('.lib-tile')];
  const cur = tiles[LIB.cursor];
  if (!cur) return;
  const r0 = cur.getBoundingClientRect();
  let best = null;
  let rowTop = null;
  for (let k = 1; k < 300; k++) {
    const t = tiles[LIB.cursor + dir * k];
    if (!t) break;
    const r = t.getBoundingClientRect();
    if (dir > 0 ? r.top <= r0.top + 1 : r.top >= r0.top - 1) continue;
    if (rowTop == null) rowTop = r.top;
    if (Math.abs(r.top - rowTop) > 1) break;
    const dist = Math.abs(r.left - r0.left);
    if (!best || dist < best.dist) best = { i: LIB.cursor + dir * k, dist };
  }
  if (best) setLibCursor(best.i);
}

/* ------------------------------------------------------------ details panel */

let detailToken = 0;
async function renderLibDetail() {
  const box = $('#lib-detail');
  const p = LIB.items[LIB.cursor];
  box.replaceChildren();
  if (!p) return;
  const token = ++detailToken;
  box.append(el('div', 'lib-d-name', p.name), el('div', 'muted', dirOf(p) || '(top level)'));
  // stars + flag, clickable
  const rate = el('div', 'lib-rate');
  for (let n = 1; n <= 5; n++) {
    const b = el('button', 'star' + (starsOf(p) >= n ? ' on' : ''), '★');
    b.title = `${n} star${n > 1 ? 's' : ''} (${n})`;
    b.onclick = () => setStars(p, starsOf(p) === n ? 0 : n);
    rate.append(b);
  }
  const fl = el('button', 'flagbtn' + (isFlagged(p) ? ' on' : ''), '⚑');
  fl.title = 'Flag (P)';
  fl.onclick = () => toggleFlagOut(p);
  rate.append(fl);
  box.append(rate);
  const facts = el('dl', 'lib-facts');
  const fact = (k, v) => v && facts.append(el('dt', '', k), el('dd', '', v));
  fact('Film simulation', p.filmSim);
  fact('Taken', fmtDate(p.dateTime));
  fact('Size', fmtBytes(p.size));
  if (p.camRating && !libRatings()[p.key]) fact('In-camera rating', '★'.repeat(p.camRating));
  box.append(facts);
  const actions = el('div', 'lib-actions');
  const reveal = el('button', 'link', 'Show in folder');
  reveal.onclick = () => api('POST', '/api/reveal', { path: `${LIB.data.root}/${p.rel}`, select: true });
  const trashBtn = el('button', 'link', 'Move to Trash');
  trashBtn.onclick = () => trashOut([p]);
  actions.append(reveal, trashBtn);
  box.append(actions);
  if (p.kind === 'video') return;
  // recipe, then every tag on request
  const info = await api('GET', `/api/info/${p.id}?src=out`).catch(() => ({ rows: [] }));
  if (token !== detailToken) return;
  const recipe = el('dl', 'lib-facts');
  for (const [k, v] of info.rows) if (k !== 'Film simulation') recipe.append(el('dt', '', k), el('dd', '', v));
  box.append(recipe);
  const more = el('button', 'link lib-more', S.showAllMeta ? 'Hide all metadata' : 'All metadata');
  more.onclick = () => {
    S.showAllMeta = !S.showAllMeta;
    renderLibDetail();
  };
  box.append(more);
  if (S.showAllMeta) {
    const m = await photoMeta(p.id, 'out');
    if (token !== detailToken || !m) return;
    box.append(metaTable(m.tags));
  }
}

// every tag, grouped, as a compact two-column list
function metaTable(tags) {
  const wrap = el('div', 'meta-all');
  let group = null;
  let dl = null;
  for (const t of tags) {
    if (t.group !== group) {
      group = t.group;
      wrap.append(el('div', 'meta-group', group));
      dl = el('dl', 'lib-facts');
      wrap.append(dl);
    }
    const dt = el('dt', '', t.name);
    dt.title = t.tag;
    dl.append(dt, el('dd', '', t.value));
  }
  return wrap;
}

/* ------------------------------------------------------------ rating, flags, trash */

function setStars(p, n) {
  const r = libRatings();
  if (n) r[p.key] = n;
  else delete r[p.key];
  api('POST', '/api/rate', { key: p.key, stars: n }).catch(() => toast('Could not save the rating'));
  libChanged(p);
}

function toggleFlagOut(p) {
  const f = libFlagged();
  const on = !f.has(p.key);
  on ? f.add(p.key) : f.delete(p.key);
  api('POST', '/api/rate', { key: p.key, flag: on }).catch(() => toast('Could not save the flag'));
  libChanged(p);
}

function libChanged(p) {
  const t = document.querySelector(`.lib-tile[data-photo="${p.id}"]`);
  if (t) paintTileMeta(t, p);
  renderLibDetail();
  if (LIB.view) renderLibViewCaption();
  const all = libAll();
  $('#lib-summary').textContent = `${fmtN(all.length)} files · ${fmtBytes(all.reduce((a, x) => a + x.size, 0))} · ${fmtN(all.filter(isFlagged).length)} flagged · ${fmtN(all.filter((x) => starsOf(x) > 0).length)} rated`;
}

async function trashOut(photos) {
  const names = photos.map((p) => p.name);
  const r = await api('POST', '/api/out/trash', { ids: photos.map((p) => p.id) }).catch((e) => ({ moved: [], failed: [{ error: e.message }] }));
  for (const id of r.moved) delete LIB.data.photos[id];
  if (r.failed.length) toast(`Couldn't move ${r.failed.length} to the Trash: ${r.failed[0].error}`, { ms: 4000 });
  else toast(`Moved ${names.length > 1 ? fmtN(names.length) + ' files' : names[0]} to the Trash`, { ms: 2500 });
  if (LIB.view) {
    const i = LIB.view.i;
    applyLibFilter();
    if (!LIB.items.length) return closeLibView();
    LIB.view.i = clamp(i, 0, LIB.items.length - 1);
    LIB.cursor = LIB.view.i;
    renderLibrary();
    renderLibView();
  } else renderLibrary();
}

/* ------------------------------------------------------------ large view */

function openLibView(i) {
  const p = LIB.items[i];
  if (!p || p.kind === 'video') return;
  LIB.view = { i, token: 0, timer: 0 };
  $('#lib-view').hidden = false;
  renderLibView();
}

function closeLibView() {
  if (!LIB.view) return;
  clearTimeout(LIB.view.timer);
  LIB.view = null;
  $('#lib-view').hidden = true;
  $('#lib-view-frame').replaceChildren();
  clearOverlays($('#lib-view'));
  setLibCursor(LIB.cursor);
}

function renderLibViewCaption() {
  const p = LIB.items[LIB.view.i];
  const c = $('#lib-view-caption');
  c.replaceChildren();
  const s = starsOf(p);
  c.append(el('span', 'sim', p.filmSim || 'Photo'), el('span', 'file', p.rel));
  if (s) c.append(el('span', 'stars', '★'.repeat(s)));
  if (isFlagged(p)) c.append(el('span', 'flag', '⚑'));
  c.append(el('span', 'file', `${LIB.view.i + 1} / ${LIB.items.length}`));
}

// Same rule as the card's large view: something now, the original after a pause.
function renderLibView() {
  const v = LIB.view;
  const p = LIB.items[v.i];
  const token = ++v.token;
  const frame = $('#lib-view-frame');
  frame.dataset.photo = p.id;
  frame.dataset.src = 'out';
  renderLibViewCaption();
  clearTimeout(v.timer);
  const show = (node) => {
    if (!LIB.view || token !== LIB.view.token) return;
    frame.replaceChildren(node);
    applyOverlays($('#lib-view'), node, p.id, 'out');
  };
  const thumbUrlOut = LIB.thumbs.get(p.id);
  if (thumbUrlOut && !frame.firstChild) {
    const t = new Image();
    t.src = thumbUrlOut;
    show(t);
  }
  const pre = new Image();
  pre.decoding = 'async';
  pre.src = libUrl(p.id);
  pre.decode().then(() => show(pre), () => {});
  v.timer = setTimeout(() => {
    const full = new Image();
    full.decoding = 'async';
    full.src = libUrl(p.id, '&full=1');
    full.decode().then(() => show(full), () => {});
  }, FULL_DWELL_MS);
  setLibCursor(v.i);
}

function libRefreshOverlays() {
  if (!LIB.view) return;
  const node = $('#lib-view-frame').firstElementChild;
  if (node) applyOverlays($('#lib-view'), node, LIB.items[LIB.view.i].id, 'out');
}

/* ------------------------------------------------------------ keys */

// Returns true if the key was handled.
function libraryKey(e, k) {
  if (!LIB.open) return false;
  const p = LIB.items[LIB.view ? LIB.view.i : LIB.cursor];
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && (k === 'DeleteSet' || e.key === 'Backspace' || e.key === 'Delete')) {
    if (p) trashOut([p]);
    return true;
  }
  if (cmd) return false;
  // ⇧ + number / P / T / [ ]: the filters
  const f = LIB.filter;
  const refilter = (fn) => {
    fn();
    LIB.cursor = 0;
    renderLibrary();
    return true;
  };
  if (/^[0-5]$/.test(k) && e.shiftKey && !LIB.view) return refilter(() => (f.stars = Number(k) === f.stars ? 0 : Number(k)));
  if ((k === 'P' || k === 'p') && e.shiftKey && !LIB.view) return refilter(() => (f.flag = !f.flag));
  if ((k === 't' || k === 'T') && !LIB.view) {
    const sims = [...new Set(libAll().map((x) => x.filmSim).filter(Boolean))].sort();
    if (!sims.length) return true;
    // cycle through the simulations, then back to all of them
    const i = sims.indexOf(f.sim);
    return refilter(() => (f.sim = i + 1 < sims.length ? sims[i + 1] : null));
  }
  if ((k === '[' || k === ']') && !LIB.view) {
    const folders = [...document.querySelectorAll('#lib-folders .lib-folder')];
    if (folders.length < 2) return true;
    const i = Math.max(0, folders.findIndex((b) => b.classList.contains('on')));
    folders[(i + (k === ']' ? 1 : -1) + folders.length) % folders.length].click();
    return true;
  }
  if (/^[0-5]$/.test(k) && p) {
    setStars(p, Number(k));
    return true;
  }
  switch (k) {
    case 'p':
    case 'P':
      if (p) toggleFlagOut(p);
      return true;
    case 'ArrowRight':
    case 'ArrowLeft': {
      const d = k === 'ArrowRight' ? 1 : -1;
      if (LIB.view) {
        const n = clamp(LIB.view.i + d, 0, LIB.items.length - 1);
        if (n !== LIB.view.i && LIB.items[n].kind !== 'video') {
          LIB.view.i = n;
          renderLibView();
        }
      } else setLibCursor(LIB.cursor + d);
      return true;
    }
    case 'ArrowDown':
    case 'ArrowUp':
      if (!LIB.view) libVertical(k === 'ArrowDown' ? 1 : -1);
      return true;
    case ' ':
    case 'Enter':
      LIB.view ? closeLibView() : openLibView(LIB.cursor);
      return true;
    case 'Escape':
      LIB.view ? closeLibView() : closeLibrary();
      return true;
    case 'l':
    case 'L':
      closeLibrary();
      return true;
    case 'r':
    case 'R':
      if (p) api('POST', '/api/reveal', { path: `${LIB.data.root}/${p.rel}`, select: true });
      return true;
  }
  return false;
}

function bindLibrary() {
  $('#lib-close').onclick = closeLibrary;
  $('#lib-path').onclick = chooseLibraryFolder;
  $('#lib-view').onclick = (e) => {
    if (e.target.closest('#lib-view-caption')) return;
    closeLibView();
  };
}
