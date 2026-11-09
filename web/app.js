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
  if (params.get('shell') === 'tauri') document.body.classList.add('app');
  S.server = await api('GET', '/api/state');
  document.body.classList.add(S.server.platform);
  S.flags = new Set(S.server.flags || []);
  S.exported = new Set(S.server.exported || []);
  S.edits = S.server.edits || {};
  S.dest = S.server.lastDest || S.server.defaultDest;
  bindUi();
  const open = params.get('open');
  history.replaceState(null, '', location.pathname + (S.server.shell === 'tauri' ? '?shell=tauri' : ''));
  if (open) {
    showWelcome();
    return openFolder(open);
  }
  if (S.server.root) {
    // the server already has a card loaded (e.g. the window was reloaded)
    const lib = await api('GET', '/api/library').catch(() => null);
    if (lib && lib.sets) return loadLibrary(lib);
  }
  showWelcome();
}

/* ------------------------------------------------------------ welcome */

async function showWelcome() {
  $('#viewer').hidden = true;
  $('#survey').hidden = true;
  $('#welcome').hidden = false;
  $('#bar .center').hidden = true;
  $('#staged-btn').hidden = $('#fs-btn').hidden = $('#ov-btn').hidden = $('#eject-btn').hidden = true;
  $('#folder').textContent = '';
  const box = $('#volumes');
  box.innerHTML = '';
  const { volumes } = await api('GET', '/api/volumes').catch(() => ({ volumes: [] }));
  const entries = volumes.map((v) => ({ name: v.name, path: v.path, where: 'card', ejectable: v.ejectable }));
  if (S.server.lastRoot && !entries.some((e) => e.path === S.server.lastRoot)) {
    entries.push({ name: S.server.lastRoot.split('/').filter(Boolean).pop() || '/', path: S.server.lastRoot, where: 'last opened' });
  }
  for (const v of entries) {
    const b = el('button', 'volume');
    const where = el('span', 'where', v.where === 'card' ? v.path : v.where);
    b.append(el('span', 'name', v.name), where);
    b.onclick = () => openFolder(v.path);
    if (v.ejectable) {
      const ej = el('span', 'eject', '⏏');
      ej.title = `Eject ${v.name}`;
      ej.onclick = (e) => {
        e.stopPropagation();
        ejectCard(v.path, v.name);
      };
      where.append(ej);
    }
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

/* ------------------------------------------------------------ eject */

// Let go of everything that might hold the card (playing video, image
// downloads), then ask the server to eject it. Picks are kept for later.
async function ejectCard(path, name) {
  if (exporting) return toast('Wait for the export to finish', { ms: 2500 });
  const label = name || 'Card';
  toast(`Ejecting ${label}…`, { ms: 10000 });
  document.querySelectorAll('video').forEach((v) => {
    v.pause();
    v.removeAttribute('src');
    v.load();
  });
  for (const e of imageCache.values()) drop(e);
  imageCache.clear();
  let res;
  try {
    res = await api('POST', '/api/eject', { path });
  } catch (e) {
    toast(e.message, { ms: 5000 });
    if (S.lib && !$('#viewer').hidden) render(); // still mounted: carry on
    return;
  }
  surveyToken++;
  if (S.solo) closeSolo();
  if (!$('#overview').hidden) closeOverview();
  if (!$('#staged').hidden) closeStaged();
  const mount = res.path || path;
  if (S.lib && (S.lib.root === mount || S.lib.root.startsWith(mount + '/'))) {
    S.lib = null; // the loaded card is gone
    $('#stage').innerHTML = '';
  }
  await showWelcome();
  toast(`${label} ejected — safe to remove`, { ms: 3500 });
}

/* ------------------------------------------------------------ survey: choose what to load */

// Picking a card first shows a cheap overview (folders, shots per day) so a
// big card can be narrowed to a folder and/or date range before loading.
let surveyToken = 0;
async function openFolder(path) {
  const token = ++surveyToken;
  const status = $('#scan-status');
  status.textContent = 'Looking at the card…';
  try {
    const sv = await api('POST', '/api/survey', { path });
    if (token !== surveyToken) return;
    status.textContent = '';
    showSurvey(sv);
  } catch (e) {
    if (token === surveyToken) status.textContent = e.message;
  }
}

const SV = { data: null, folder: '', from: null, to: null, days: [], drag: null };
const dayMs = 86400000;
const parseDay = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fmtDayUTC = (t) => new Date(t).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDay(d, withYear = true) {
  const [y, m, dd] = d.split('-');
  return `${+dd} ${MONTHS[+m - 1]}${withYear ? ' ' + y : ''}`;
}
const fmtN = (n) => n.toLocaleString('en-US');

function showSurvey(sv) {
  SV.data = sv;
  SV.folder = '';
  SV.from = SV.to = null;
  SV.after = null;
  const since = sv.sinceLast;
  const newBtn = $('#survey-quick [data-q="new"]');
  newBtn.hidden = !since;
  if (since) {
    newBtn.textContent = since.count ? `New since last import (${fmtN(since.count)})` : 'Nothing new since last import';
    newBtn.disabled = !since.count;
    // straight to what's new: Enter opens just the shots you haven't imported
    if (since.count) {
      SV.after = since.after;
      SV.from = since.firstDay;
    }
  }
  $('#welcome').hidden = true;
  $('#viewer').hidden = true;
  $('#survey').hidden = false;
  // the photo viewer's top-bar items don't apply here
  $('#bar .center').hidden = true;
  $('#staged-btn').hidden = $('#fs-btn').hidden = $('#ov-btn').hidden = $('#eject-btn').hidden = true;
  $('#folder').textContent = '';
  $('#survey-name').textContent = sv.root.split(/[\\/]/).filter(Boolean).pop() || sv.root;
  $('#survey-name').title = sv.root;
  $('#survey-status').textContent = '';
  $('#survey-eject').hidden = !(sv.volume && sv.volume.ejectable);
  $('#survey-eject').onclick = () => ejectCard(sv.root, sv.volume.name);
  // folders: those that directly hold photos or videos
  const folders = new Map();
  for (const g of sv.groups) folders.set(g.folder, (folders.get(g.folder) || 0) + g.photos + g.videos);
  const box = $('#survey-folders');
  box.innerHTML = '';
  const chip = (label, value, n, title) => {
    const b = el('button', 'chip');
    b.append(el('span', '', label), el('span', 'n', fmtN(n)));
    b.dataset.folder = value;
    b.title = title || label;
    b.onclick = () => {
      SV.folder = value;
      // keep the date range only if it still holds something in this folder
      renderSurvey();
    };
    box.append(b);
  };
  chip('All folders', '', sv.total);
  [...folders.keys()].sort().forEach((f) => chip(f.split('/').pop() || '(card root)', f, folders.get(f), f));
  $('#survey-folders-row').hidden = folders.size < 2;
  renderSurvey();
}

// per-day totals for the chosen folder, on a continuous day axis
function surveyDays() {
  const by = new Map();
  for (const g of SV.data.groups) {
    if (SV.folder && g.folder !== SV.folder) continue;
    const d = by.get(g.day) || { photos: 0, videos: 0 };
    d.photos += g.photos;
    d.videos += g.videos;
    by.set(g.day, d);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, v]) => ({ day, ...v, n: v.photos + v.videos }));
}

function selectedDays() {
  // (with 'since last import' the first day is partly old; counts come from the server)
  return SV.days.filter((d) => (!SV.from || d.day >= SV.from) && (!SV.to || d.day <= SV.to));
}

function renderSurvey() {
  SV.days = surveyDays();
  document.querySelectorAll('#survey-folders .chip').forEach((c) => c.classList.toggle('on', c.dataset.folder === SV.folder));
  drawSurveyChart();
  const sel = selectedDays();
  let photos = sel.reduce((a, d) => a + d.photos, 0);
  let videos = sel.reduce((a, d) => a + d.videos, 0);
  if (SV.after && !SV.folder) {
    // exact count of files newer than the last import
    photos = SV.data.sinceLast.count;
    videos = 0;
  }
  let range = 'All days';
  if (SV.from || SV.to) {
    const a = SV.from || SV.days[0]?.day;
    const b = SV.to || SV.days.at(-1)?.day;
    range = a === b ? niceDay(a) : `${niceDay(a, a.slice(0, 4) !== b.slice(0, 4))} – ${niceDay(b)}`;
  }
  if (SV.after) range = 'New since last import';
  const parts = [range, `${fmtN(photos)} ${SV.after && !SV.folder ? 'new' : 'photo' + (photos === 1 ? '' : 's')}`];
  if (videos) parts.push(`${fmtN(videos)} video${videos === 1 ? '' : 's'}`);
  $('#survey-sel').textContent = parts.join(' · ');
  $('#survey-open').textContent = `Open ${fmtN(photos + videos)}`;
  $('#survey-open').disabled = photos + videos === 0;
  document
    .querySelectorAll('#survey-quick button')
    .forEach((b) => b.classList.toggle('on', (b.dataset.q === 'all' && !SV.from && !SV.to && !SV.after) || (b.dataset.q === 'new' && !!SV.after)));
}

/* Shots per day as a strip of bars on a true time axis (empty days are
   gaps, not squeezed out). Selected days in ink, the rest recede. */
function drawSurveyChart() {
  const svg = $('#survey-chart');
  const W = svg.clientWidth || 600;
  const H = 72;
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`);
  svg.innerHTML = '';
  const days = SV.days;
  if (!days.length) return;
  const t0 = parseDay(days[0].day);
  const t1 = parseDay(days.at(-1).day);
  const n = Math.round((t1 - t0) / dayMs) + 1;
  const step = W / n;
  const bw = Math.max(1, Math.min(14, step * 0.7));
  const max = Math.max(...days.map((d) => d.n));
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  SV.geom = { t0, n, step, W };
  const inSel = (d) => (!SV.from || d >= SV.from) && (!SV.to || d <= SV.to);
  if (SV.from || SV.to) {
    // faint band marking the chosen span, including its empty days
    const i0 = SV.from ? Math.round((parseDay(SV.from) - t0) / dayMs) : 0;
    const i1 = SV.to ? Math.round((parseDay(SV.to) - t0) / dayMs) : n - 1;
    mk('rect', { x: (Math.max(0, i0) * step).toFixed(2), y: 0, width: ((Math.min(n - 1, i1) - Math.max(0, i0) + 1) * step).toFixed(2), height: H, class: 'band' });
  }
  for (const d of days) {
    const i = Math.round((parseDay(d.day) - t0) / dayMs);
    const h = Math.max(1.5, (d.n / max) * H);
    const x = i * step + (step - bw) / 2;
    const r = mk('rect', { x: x.toFixed(2), y: (H - h).toFixed(2), width: bw.toFixed(2), height: h.toFixed(2), class: inSel(d.day) ? 'bar on' : 'bar' });
    r.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: `${niceDay(d.day)}: ${fmtN(d.n)}` }));
  }
  // baseline, the tallest day labelled directly, and sparse date labels
  mk('line', { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: 'base' });
  const top = days.reduce((a, d) => (d.n > a.n ? d : a));
  const ti = Math.round((parseDay(top.day) - t0) / dayMs);
  const tx = clamp(ti * step + step / 2, 14, W - 14);
  mk('text', { x: tx, y: Math.max(9, H - (top.n / max) * H - 4), class: 'peak', 'text-anchor': 'middle' }, fmtN(top.n));
  const labels = [];
  labels.push({ i: 0, text: niceDay(days[0].day), anchor: 'start' });
  if (n > 1) labels.push({ i: n - 1, text: niceDay(days.at(-1).day), anchor: 'end' });
  if (n > 45) {
    // month starts in between
    for (let i = 1; i < n - 1; i++) {
      const d = fmtDayUTC(t0 + i * dayMs);
      if (d.endsWith('-01')) labels.push({ i, text: MONTHS[+d.slice(5, 7) - 1] + (d.slice(5, 7) === '01' ? ' ' + d.slice(0, 4) : ''), anchor: 'middle', tick: true });
    }
  }
  let lastRight = -Infinity;
  for (const l of labels.sort((a, b) => a.i - b.i)) {
    const x = l.anchor === 'start' ? 0 : l.anchor === 'end' ? W : l.i * step;
    const est = l.text.length * 6;
    const left = l.anchor === 'start' ? x : l.anchor === 'end' ? x - est : x - est / 2;
    if (left < lastRight + 8 && l.anchor !== 'end') continue;
    if (l.tick) mk('line', { x1: x, x2: x, y1: H + 1, y2: H + 5, class: 'tick' });
    mk('text', { x, y: H + 17, 'text-anchor': l.anchor, class: 'axis' }, l.text);
    lastRight = left + est;
  }
}

function chartDayAt(clientX) {
  const svg = $('#survey-chart');
  const g = SV.geom;
  if (!g) return null;
  const r = svg.getBoundingClientRect();
  const x = ((clientX - r.left) / r.width) * g.W;
  const i = clamp(Math.floor(x / g.step), 0, g.n - 1);
  return fmtDayUTC(g.t0 + i * dayMs);
}

function setRange(a, b) {
  SV.after = null; // a hand-picked range replaces 'since last import'
  if (a && b && a > b) [a, b] = [b, a];
  const whole = !a || !b || (a <= SV.days[0]?.day && b >= SV.days.at(-1)?.day);
  SV.from = whole ? null : a;
  SV.to = whole ? null : b;
  renderSurvey();
}

function quickRange(q) {
  const days = SV.days;
  if (!days.length) return;
  const last = days.at(-1).day;
  if (q === 'new') {
    const since = SV.data.sinceLast;
    if (!since || !since.count) return;
    SV.from = since.firstDay;
    SV.to = null;
    SV.after = since.after;
    return renderSurvey();
  }
  if (q === 'all') setRange(null, null);
  else if (q === 'last') setRange(last, last);
  else if (q === 'week') setRange(fmtDayUTC(parseDay(last) - 6 * dayMs), last);
}

function bindSurvey() {
  const svg = $('#survey-chart');
  svg.addEventListener('pointerdown', (e) => {
    const d = chartDayAt(e.clientX);
    if (!d) return;
    svg.setPointerCapture(e.pointerId);
    SV.drag = e.shiftKey && (SV.from || SV.to) ? SV.from || SV.to : d;
    setRange(SV.drag, d);
  });
  svg.addEventListener('pointermove', (e) => {
    if (SV.drag == null) return;
    const d = chartDayAt(e.clientX);
    if (d) setRange(SV.drag, d);
  });
  const end = () => (SV.drag = null);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('dblclick', () => setRange(null, null));
  $('#survey-quick').onclick = (e) => e.target.dataset.q && quickRange(e.target.dataset.q);
  $('#survey-open').onclick = () => openScoped();
  $('#survey-back').onclick = () => {
    surveyToken++;
    $('#survey').hidden = true;
    showWelcome();
  };
}

let openToken = 0;
async function openScoped() {
  if (!SV.data) return;
  const token = ++openToken;
  const status = $('#survey-status');
  const scope = { folder: SV.folder || null, from: SV.from, to: SV.to, after: SV.after || null };
  $('#survey-open').disabled = true;
  status.textContent = 'Reading…';
  let polling = true;
  (async function poll() {
    while (polling && token === openToken) {
      await new Promise((r) => setTimeout(r, 200));
      const p = await api('GET', '/api/progress').catch(() => null);
      if (polling && token === openToken && p && p.total) {
        status.textContent = `Reading ${fmtN(Math.min(p.done, p.total))} of ${fmtN(p.total)} files`;
      }
    }
  })();
  try {
    const lib = await api('POST', '/api/open', { path: SV.data.root, ...scope });
    if (token !== openToken) return; // a newer open replaced this one
    polling = false;
    status.textContent = '';
    S.server.lastRoot = lib.root;
    $('#survey').hidden = true;
    loadLibrary(lib);
  } catch (e) {
    polling = false;
    if (token === openToken) status.textContent = e.message;
  } finally {
    if (token === openToken) $('#survey-open').disabled = false;
  }
}

function scopeLabel(lib) {
  const sc = lib.scope || {};
  const name = lib.root.split(/[\\/]/).filter(Boolean).pop() || lib.root;
  const parts = [name];
  if (sc.folder) parts.push(sc.folder.split('/').pop());
  if (sc.after) parts.push('new since last import');
  else if (sc.from || sc.to) {
    const a = sc.from || '…';
    const b = sc.to || '…';
    parts.push(a === b ? niceDay(a) : `${a === '…' ? a : niceDay(a, false)} – ${b === '…' ? b : niceDay(b)}`);
  }
  return parts.join(' · ');
}

function loadLibrary(lib) {
  S.lib = lib;
  imageCache.clear();
  applyFilter(false);
  let saved = 0;
  try {
    saved = Number(localStorage.getItem(idxKey())) || 0;
  } catch {}
  S.idx = clamp(saved, 0, Math.max(0, S.view.length - 1));
  $('#welcome').hidden = true;
  $('#survey').hidden = true;
  $('#viewer').hidden = false;
  $('#bar .center').hidden = false;
  $('#staged-btn').hidden = $('#fs-btn').hidden = $('#ov-btn').hidden = false;
  $('#eject-btn').hidden = !(lib.volume && lib.volume.ejectable);
  $('#folder').textContent = scopeLabel(lib);
  $('#folder').title = lib.root + ' — choose another card, folder or dates (O)';
  render();
  updateFlagsUi();
}

const idxKey = () => 'brackit:idx:' + S.lib.root + '|' + JSON.stringify(S.lib.scope || {});

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

/* Image loading. Every preview goes through one prioritised queue: the set on
   screen first, then the sets ahead in order, then one behind. Moving on
   re-ranks the queue and cancels downloads that are no longer wanted, so the
   photo you're looking at never waits behind prefetches. Decoded images are
   kept in a small LRU cache. */
const MAX_INFLIGHT = 6; // browsers allow ~6 connections per host
const AHEAD = 8; // sets to prefetch forward (previews)
const THUMBS_AHEAD = 40; // sets to prefetch forward (tiny header thumbnails)
const CACHE_MAX = 90; // decoded previews kept (~3 per set)
const THUMB_CACHE_MAX = 900; // ~10 KB each
// Lanes: background work may only use part of the connections, so whatever
// is on screen (priority < 1) always finds a free slot immediately.
const LANE = { thumb: 2, preview: 2 };
const kindOf = (url) => (url.includes('full=1') ? 'full' : url.includes('thumb=1') ? 'thumb' : 'preview');
const imageCache = new Map(); // url -> entry
const queue = []; // entries waiting to start
let inflight = 0;

function makeEntry(url, priority) {
  const entry = { url, kind: kindOf(url), priority, img: new Image(), done: false, started: false, ctrl: null, objectUrl: null };
  entry.img.decoding = 'async';
  entry.img.draggable = false;
  entry.promise = new Promise((resolve) => (entry.resolve = resolve));
  return entry;
}

function getImage(url, priority = 0) {
  let entry = imageCache.get(url);
  if (entry) {
    imageCache.delete(url); // refresh LRU position
    imageCache.set(url, entry);
    if (!entry.started && priority < entry.priority) entry.priority = priority;
  } else {
    entry = makeEntry(url, priority);
    imageCache.set(url, entry);
    queue.push(entry);
    evict();
  }
  pump();
  return entry;
}

function evict() {
  // decoded 40 MP originals are ~160 MB each: keep only the two most recent
  const fulls = [...imageCache.keys()].filter((u) => u.includes('full=1'));
  for (const u of fulls.slice(0, Math.max(0, fulls.length - 2))) {
    drop(imageCache.get(u));
    imageCache.delete(u);
  }
  let previews = 0;
  let thumbs = 0;
  for (const e of imageCache.values()) e.kind === 'thumb' ? thumbs++ : previews++;
  for (const [url, e] of imageCache) {
    if (previews <= CACHE_MAX && thumbs <= THUMB_CACHE_MAX) break;
    if (e.priority < 1 && !e.done) continue; // never drop what's on screen
    if (e.kind === 'thumb' ? thumbs <= THUMB_CACHE_MAX : previews <= CACHE_MAX) continue;
    drop(e);
    imageCache.delete(url);
    e.kind === 'thumb' ? thumbs-- : previews--;
  }
}

function drop(e) {
  if (e.ctrl && !e.done) e.ctrl.abort();
  const qi = queue.indexOf(e);
  if (qi >= 0) queue.splice(qi, 1);
  if (e.objectUrl) setTimeout(() => URL.revokeObjectURL(e.objectUrl), 1000);
}

const lanes = { thumb: 0, preview: 0 }; // background requests in flight

function startable(e) {
  if (inflight >= MAX_INFLIGHT) return false;
  if (e.priority < 1 || e.kind === 'full') return true; // on screen: always
  return lanes[e.kind] < LANE[e.kind];
}

function pump() {
  queue.sort((a, b) => a.priority - b.priority);
  for (let i = 0; i < queue.length && inflight < MAX_INFLIGHT; ) {
    const e = queue[i];
    if (!startable(e)) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    const lane = e.priority >= 1 && e.kind !== 'full' ? e.kind : null;
    if (lane) lanes[lane]++;
    e.started = true;
    e.ctrl = new AbortController();
    inflight++;
    fetch(e.url, { signal: e.ctrl.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then((blob) => {
        e.objectUrl = URL.createObjectURL(blob);
        e.img.src = e.objectUrl;
        return e.img.decode().catch(() => {});
      })
      .then(
        () => {
          e.done = true;
          e.resolve(e.img);
        },
        (err) => {
          if (err && err.name === 'AbortError') return; // re-requested later if needed
          e.done = true;
          e.resolve(e.img);
        }
      )
      .finally(() => {
        inflight--;
        if (lane) lanes[lane]--;
        pump();
      });
  }
}

const previewUrl = (id) => `/api/img/${id}`;
const fullUrl = (id) => `/api/img/${id}?full=1`;
const thumbUrl = (id) => `/api/img/${id}?thumb=1`;
const photo = (id) => S.lib.photos[id];

// Re-rank the queue around the current set; cancel what's no longer wanted.
function preloadAround() {
  const want = new Map(); // url -> priority
  const add = (set, pr, url = previewUrl) => {
    if (!set || set.kind === 'video') return;
    set.photos.forEach((id, i) => {
      if (url === thumbUrl && !photo(id).hasThumb) return;
      want.set(url(id), pr + i * 0.01);
    });
  };
  // on screen: thumbnails first (instant placeholder), then the previews
  add(S.view[S.idx], 0, thumbUrl);
  add(S.view[S.idx], 0.1);
  // while a key is held down, only fetch what's on screen plus thumbnails
  const ahead = S.flipping ? 0 : AHEAD;
  for (let d = 1; d <= ahead; d++) add(S.view[S.idx + d], d);
  if (!S.flipping) add(S.view[S.idx - 1], 1.5);
  for (let d = 1; d <= THUMBS_AHEAD; d++) add(S.view[S.idx + d], 1 + d * 0.5, thumbUrl);
  for (let d = 1; d <= 5; d++) add(S.view[S.idx - d], 2 + d, thumbUrl);
  for (const [url, e] of [...imageCache]) {
    if (e.done) continue;
    if (want.has(url)) {
      e.priority = want.get(url);
    } else if (e.kind === 'thumb' && e.started) {
      // tiny: let it finish
    } else if (e.kind !== 'full') {
      drop(e); // stale prefetch: free the connection for what matters now
      imageCache.delete(url);
    }
  }
  for (const [url, pr] of want) getImage(url, pr);
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

/* A preview-sized canvas holding the upscaled header thumbnail, cropped to
   the photo's true shape (Fuji thumbnails can be letterboxed) and with any
   straighten/crop applied, so it occupies exactly the space the sharp
   preview will. Drawn once per flip; cheap. */
function placeholder(timg, p, edit) {
  const a = photoAspect(p);
  const c = document.createElement('canvas');
  c.width = a >= 1 ? 1920 : Math.round(1920 * a);
  c.height = Math.round(c.width / a);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'medium';
  const tw = timg.naturalWidth;
  const th = timg.naturalHeight;
  let sx = 0, sy = 0, sw = tw, sh = th;
  if (tw / th > a) {
    sw = th * a;
    sx = (tw - sw) / 2;
  } else {
    sh = tw / a;
    sy = (th - sh) / 2;
  }
  ctx.drawImage(timg, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const out = edit ? renderEdited(c, edit) : c;
  out.classList.add('ready', 'lowres');
  return out;
}

const srcW = (img) => img.naturalWidth || img.width;
const srcH = (img) => img.naturalHeight || img.height;

function renderEdited(img, edit, maxWidth) {
  const W = srcW(img);
  const H = srcH(img);
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

/* Selection model: 1/2/3 picks one version of the set (replacing any other
   pick), ⌘+number adds/removes a version to pick several, 0 unstages the set. */
function selectOnly(pos) {
  const set = S.view[S.idx];
  if (!set || pos >= set.photos.length) return false;
  set.photos.forEach((id, i) => {
    const key = photo(id).key;
    if (i === pos) S.flags.add(key);
    else S.flags.delete(key);
  });
  saveFlags();
  updateFlagsUi();
  return true;
}

function toggleFlag(pos) {
  const set = S.view[S.idx];
  if (!set || pos >= set.photos.length) return false;
  const p = photo(set.photos[pos]);
  if (S.flags.has(p.key)) S.flags.delete(p.key);
  else S.flags.add(p.key);
  saveFlags();
  updateFlagsUi();
  return true;
}

function clearSet() {
  const set = S.view[S.idx];
  if (!set) return;
  let had = false;
  for (const id of set.photos) had = S.flags.delete(photo(id).key) || had;
  if (had) {
    saveFlags();
    updateFlagsUi();
    toast('Unstaged');
  }
}

function selectedPos(set) {
  const i = set ? set.photos.findIndex((id) => S.flags.has(photo(id).key)) : -1;
  return i < 0 ? null : i;
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
    if (S.solo) renderSoloCaption();
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
    localStorage.setItem(idxKey(), S.idx);
  } catch {}
  preloadAround(); // rank this set first before anything else is requested
  $('#counter').innerHTML = `<b>${S.idx + 1}</b> / ${S.view.length}`;
  $('#set-date').textContent = fmtDate(set.dateTime);
  const names = set.photos.map((id) => photo(id).name);
  $('#set-files').textContent = names.length > 1 ? `${names[0]} – ${names[names.length - 1]}` : names[0];

  layoutStage(stage, set);
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
    const edit = editOf(p);
    const entry = getImage(previewUrl(id), 0.1);
    let sharp = false;
    const showPreview = (img) => {
      if (token !== renderToken || !img.naturalWidth) return;
      sharp = true;
      const node = edit ? renderEdited(img, edit, frame.clientWidth * dpr() * 1.25) : img;
      node.classList.add('ready');
      frame.replaceChildren(node);
    };
    if (entry.done) showPreview(entry.img); // cached: sharp immediately
    else {
      // instant low-res stand-in from the JPEG header's thumbnail
      if (p.hasThumb) {
        const t = getImage(thumbUrl(id), 0);
        const showThumb = (timg) => {
          if (token !== renderToken || sharp || !timg.naturalWidth) return;
          frame.replaceChildren(placeholder(timg, p, edit));
        };
        if (t.done) showThumb(t.img);
        else t.promise.then(showThumb);
      }
      entry.promise.then(showPreview);
    }
  });
  S.hoverPos = null;
  drawTicks();
  if (S.solo) renderSolo();
}

/* Three looks either sit in a row or as 2 + 1 (two on top, one centred
   below); whichever shows the photos bigger wins. On most screens that makes
   landscape brackets 2 + 1. */
const CAPTION_H = 30;
function photoAspect(p) {
  let w = p.width || 3;
  let h = p.height || 2;
  if (p.orientation >= 5 && p.orientation <= 8) [w, h] = [h, w];
  return w / h;
}
function layoutStage(stage, set) {
  stage.classList.remove('g21');
  stage.style.removeProperty('--img-max');
  if (set.photos.length !== 3 || set.kind === 'video') return;
  const gap = parseFloat(getComputedStyle(stage).columnGap) || 10;
  const SW = stage.clientWidth;
  const SH = stage.clientHeight;
  const a = photoAspect(photo(set.photos[0]));
  const inRow = Math.min((SW - 2 * gap) / 3, (SH - CAPTION_H) * a);
  const rowH = (SH - gap - 2 * CAPTION_H) / 2;
  const twoOne = Math.min((SW - gap) / 2, rowH * a);
  if (twoOne > inRow * 1.04) {
    stage.classList.add('g21');
    stage.style.setProperty('--img-max', `${Math.floor(rowH)}px`);
  }
}

function go(delta) {
  if (!S.view.length) return;
  const next = clamp(S.idx + delta, 0, S.view.length - 1);
  if (next === S.idx) return;
  S.idx = next;
  if (S.solo) {
    S.solo.zoom = false;
    const set = S.view[S.idx];
    // follow the pick in the new set, otherwise keep looking at the same slot
    S.solo.pos = selectedPos(set) ?? Math.min(S.solo.pos, set.photos.length - 1);
  }
  scheduleRender();
}

// Key repeat can outpace the screen: draw at most once per frame, always
// the latest position, so input never queues up behind rendering.
let renderPending = false;
function scheduleRender() {
  $('#counter').innerHTML = `<b>${S.idx + 1}</b> / ${S.view.length}`;
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
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
/* The canvas is taller than the strip (BULGE px of headroom above the
   22 px baseline area) so hovered ticks can swell upward over the page. */
const TICK_H = 22;
const BULGE = 26;
// hover state: `strength` eases 0↔1, `fx` follows the mouse (canvas px)
const TL = { strength: 0, target: 0, fx: 0, mx: 0, raf: 0 };

// Fisheye (Sarkar–Brown): spreads ticks near the focus, compresses the rest.
function fisheye(x, fx, w, d) {
  if (d <= 0) return x;
  const left = x < fx;
  const span = left ? fx : w - fx;
  if (span <= 0) return x;
  const t = Math.abs(x - fx) / span;
  const g = ((d + 1) * t) / (d * t + 1);
  return left ? fx - g * span : fx + g * span;
}

function drawTicks() {
  const c = $('#ticks');
  const w = c.clientWidth;
  const H = TICK_H + BULGE;
  if (!w) return;
  if (c.width !== Math.round(w * dpr()) || c.height !== Math.round(H * dpr())) {
    c.width = Math.round(w * dpr());
    c.height = Math.round(H * dpr());
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.clearRect(0, 0, w, H);
  const n = S.view.length;
  if (!n) return;
  const step = w / n;
  const css = getComputedStyle(document.documentElement);
  const faint = css.getPropertyValue('--tick').trim();
  const accent = css.getPropertyValue('--accent').trim();
  const ink = css.getPropertyValue('--ink').trim();
  const s = TL.strength;
  const d = 3 * s; // fisheye distortion
  const sigma = 48; // px: how wide the bulge is
  const geom = (i) => {
    const x0 = fisheye(i * step, TL.fx, w, d);
    const x1 = fisheye((i + 1) * step, TL.fx, w, d);
    const mid = (x0 + x1) / 2;
    const dx = mid - TL.fx;
    const lift = s * Math.exp(-(dx * dx) / (2 * sigma * sigma)); // 0..1
    const tw = Math.max(1, Math.min(2 + 4 * lift, x1 - x0 - 1));
    return { x: mid - tw / 2, tw, lift };
  };
  for (let i = 0; i < n; i++) {
    const set = S.view[i];
    const flagged = set.photos.some((id) => S.flags.has(photo(id).key));
    const base = flagged ? 13 : set.kind === 'video' ? 9 : 6;
    const { x, tw, lift } = geom(i);
    const th = Math.min(H, base * (1 + 2.6 * lift));
    ctx.fillStyle = flagged ? accent : faint;
    ctx.globalAlpha = flagged ? 1 : 0.85 + 0.15 * lift;
    ctx.fillRect(x, H - th, tw, th);
  }
  ctx.globalAlpha = 1;
  // the current set: a full-height ink line (taller when bulged)
  const cur = geom(S.idx);
  ctx.fillStyle = ink;
  ctx.fillRect(cur.x, H - TICK_H * (1 + 0.9 * cur.lift), Math.max(cur.tw, 1.5), TICK_H * (1 + 0.9 * cur.lift));
}

function animateTimeline() {
  if (TL.raf) return;
  const tick = () => {
    TL.strength += (TL.target - TL.strength) * 0.22;
    TL.fx += (TL.mx - TL.fx) * 0.35;
    if (Math.abs(TL.target - TL.strength) < 0.01) TL.strength = TL.target;
    if (Math.abs(TL.mx - TL.fx) < 0.5) TL.fx = TL.mx;
    drawTicks();
    const moving = TL.strength !== TL.target || TL.fx !== TL.mx;
    TL.raf = moving ? requestAnimationFrame(tick) : 0;
  };
  TL.raf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------ timeline hover preview */

// Hovering the tick strip shows that set's embedded header thumbnail (the
// pick if there is one), its position and capture time.
let peekIdx = -1;
function peekAt(e) {
  const c = $('#ticks');
  const r = c.getBoundingClientRect();
  const n = S.view.length;
  if (!n) return;
  const i = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1);
  const peek = $('#peek');
  const host = $('#index').getBoundingClientRect();
  const W = 168;
  peek.style.left = `${clamp(e.clientX - host.left - W / 2, 0, host.width - W)}px`;
  peek.hidden = false;
  if (i === peekIdx) return;
  peekIdx = i;
  const set = S.view[i];
  const shown = photo(set.photos[selectedPos(set) ?? 0]);
  const box = peek.querySelector('.peek-img');
  box.replaceChildren();
  const dt = (set.dateTime || '').match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2})/);
  const when = dt ? `${+dt[3]} ${MONTHS[+dt[2] - 1]} ${dt[4]}` : '';
  peek.querySelector('.peek-cap').textContent = `${fmtN(i + 1)}${when ? ' · ' + when : ''}`;
  peek.classList.toggle('picked', selectedPos(set) != null);
  if (set.kind === 'video') {
    box.append(el('span', 'peek-video', '▶'));
    return;
  }
  const entry = getImage(thumbUrl(shown.id), 0.5);
  const put = (img) => {
    if (peekIdx !== i || !img.naturalWidth) return;
    box.replaceChildren(img.cloneNode());
  };
  if (entry.done) put(entry.img);
  else entry.promise.then(put);
}

/* ------------------------------------------------------------ overview (thumbnail grid) */

/* Every set as a small tile, grouped by day, for scrolling around a card
   quickly. Uses the ~160 px thumbnail embedded in each JPEG header, so even
   thousands of tiles cost almost nothing to load. */
const OV = { tiles: [], cursor: 0, io: null };

function openOverview() {
  if (!S.lib || !S.view.length) return;
  if (S.solo) closeSolo();
  const grid = $('#ov-grid');
  grid.innerHTML = '';
  if (OV.io) OV.io.disconnect();
  // Background preview prefetch would compete with the tiles: pause it.
  for (const [url, e] of [...imageCache]) {
    if (!e.done && e.kind === 'preview') {
      drop(e);
      imageCache.delete(url);
    }
  }
  // Tiles show each file's embedded header thumbnail (~10 KB, a partial
  // read), through the same queue at on-screen priority, reusing any the
  // viewer already prefetched.
  OV.io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        OV.io.unobserve(en.target);
        const tile = en.target;
        getImage(tile.dataset.src, 0.5).promise.then((img) => {
          if (!img.naturalWidth || !tile.isConnected) return;
          const c = img.cloneNode();
          c.alt = '';
          tile.prepend(c);
        });
      }
    },
    { root: $('#overview'), rootMargin: '600px 0px' }
  );
  OV.tiles = [];
  let day = null;
  let row = null;
  const perDay = new Map();
  for (const set of S.view) {
    const d = (set.dateTime || '').slice(0, 10);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  S.view.forEach((set, i) => {
    const d = (set.dateTime || '').slice(0, 10);
    if (d !== day) {
      day = d;
      const count = perDay.get(d);
      const h = el('div', 'ov-day');
      h.append(el('span', '', d ? niceDay(d.replace(/:/g, '-')) : 'Undated'), el('span', 'muted', ` ${fmtN(count)}`));
      grid.append(h);
      row = el('div', 'ov-row');
      grid.append(row);
    }
    const pick = selectedPos(set);
    const shown = photo(set.photos[pick ?? 0]);
    const tile = el('button', 'ov-tile');
    if (pick != null) tile.classList.add('picked');
    if (set.kind === 'video') tile.classList.add('video');
    if (i === S.idx) tile.classList.add('current');
    tile.title = `${set.photos.map((id) => photo(id).name).join(', ')}${shown.filmSim ? ' · ' + shown.filmSim : ''}`;
    if (set.kind === 'video') tile.append(el('span', 'ov-video', '▶'));
    else {
      tile.dataset.src = thumbUrl(shown.id); // the server falls back to the preview if a file has none
      OV.io.observe(tile);
    }
    if (set.photos.length > 1) tile.append(el('span', 'ov-n', String(set.photos.length)));
    tile.onclick = () => closeOverview(i);
    row.append(tile);
    OV.tiles.push(tile);
  });
  OV.cursor = S.idx;
  $('#overview').hidden = false;
  moveOverviewCursor(S.idx, 'center');
}

function closeOverview(jumpTo) {
  $('#overview').hidden = true;
  if (OV.io) OV.io.disconnect();
  $('#ov-grid').innerHTML = '';
  OV.tiles = [];
  if (jumpTo != null && jumpTo !== S.idx) {
    S.idx = jumpTo;
    render();
  } else preloadAround(); // resume prefetching where we were
}

function moveOverviewCursor(i, block = 'nearest') {
  i = clamp(i, 0, OV.tiles.length - 1);
  OV.tiles[OV.cursor]?.classList.remove('cursor');
  OV.cursor = i;
  const t = OV.tiles[i];
  t.classList.add('cursor');
  t.scrollIntoView({ block });
}

// up/down: the tile in the next/previous visual row closest in x
function overviewVertical(dir) {
  const cur = OV.tiles[OV.cursor].getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  let best = null;
  let bestRowTop = null;
  for (let k = 1; k < 400; k++) {
    const j = OV.cursor + dir * k;
    if (j < 0 || j >= OV.tiles.length) break;
    const r = OV.tiles[j].getBoundingClientRect();
    if (dir > 0 ? r.top <= cur.top + 1 : r.top >= cur.top - 1) continue;
    if (bestRowTop == null) bestRowTop = r.top;
    if (Math.abs(r.top - bestRowTop) > 1) break;
    const dist = Math.abs(r.left + r.width / 2 - cx);
    if (!best || dist < best.dist) best = { j, dist };
  }
  if (best) moveOverviewCursor(best.j);
}

/* ------------------------------------------------------------ solo (one look, large) */

// opts.fullscreen: also take the whole screen; leaving the view restores it.
function openSolo(pos, opts = {}) {
  const set = S.view[S.idx];
  if (!set || set.kind === 'video') return;
  S.solo = { pos, zoom: false, ownsFs: false };
  $('#solo').hidden = false;
  renderSolo();
  if (opts.fullscreen && !isFullscreen()) {
    S.solo.ownsFs = true;
    setFullscreen(true).then((ok) => !ok && S.solo && (S.solo.ownsFs = false));
  }
}

function closeSolo() {
  $('#solo-info').hidden = true;
  const ownsFs = S.solo && S.solo.ownsFs;
  S.solo = null;
  if (ownsFs && isFullscreen()) setFullscreen(false);
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
  renderSoloCaption();
  renderInfo();
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
  // full resolution jumps the queue ahead of every prefetch
  getImage(fullUrl(id), -1).promise.then((full) => {
    if (token !== soloToken || !full.naturalWidth) return;
    frame.dataset.id = id;
    show(edit ? renderEdited(full, edit) : full);
  });
}

/* I: camera settings and the film recipe of the look on screen, as a small
   table over the bottom-left of the inspect view. */
const infoCache = new Map();
S.showInfo = (() => {
  try {
    return localStorage.getItem('brackit:info') === '1';
  } catch {
    return false;
  }
})();
async function renderInfo() {
  const box = $('#solo-info');
  const set = S.view[S.idx];
  if (!S.solo || !S.showInfo || !set) return (box.hidden = true);
  const id = set.photos[S.solo.pos];
  let rows = infoCache.get(id);
  if (!rows) {
    rows = (await api('GET', `/api/info/${id}`).catch(() => ({ rows: [] }))).rows;
    infoCache.set(id, rows);
  }
  if (!S.solo || set.photos[S.solo.pos] !== id) return;
  box.replaceChildren();
  for (const [k, v] of rows) box.append(el('span', 'k', k), el('span', 'v', v));
  box.hidden = !rows.length;
}
function toggleInfo() {
  S.showInfo = !S.showInfo;
  try {
    localStorage.setItem('brackit:info', S.showInfo ? '1' : '0');
  } catch {}
  renderInfo();
}

// Caption for the inspect view: a key per look — the one on screen is
// outlined, picked ones are filled — then the name of the look on screen.
function renderSoloCaption() {
  const set = S.view[S.idx];
  if (!S.solo || !set) return;
  const p = photo(set.photos[S.solo.pos]);
  const c = el('div', 'caption');
  c.id = 'solo-caption';
  if (set.photos.length > 1) {
    const keys = el('span', 'keys');
    set.photos.forEach((id, i) => {
      const k = el('span', 'key', String(i + 1));
      if (S.flags.has(photo(id).key)) k.classList.add('on');
      if (i === S.solo.pos) k.classList.add('here');
      k.title = photo(id).filmSim || '';
      k.onclick = (e) => {
        e.stopPropagation();
        selectOnly(i);
        S.solo.pos = i;
        renderSolo();
      };
      keys.append(k);
    });
    c.append(keys);
  }
  c.classList.toggle('flagged', S.flags.has(p.key));
  c.append(el('span', 'sim', p.filmSim || 'Photo'), el('span', 'file', p.name));
  if (editOf(p)) c.append(el('span', 'edited', 'cropped'));
  $('#solo-caption').replaceWith(c);
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

// "Include RAW" is a per-viewer preference
const withRaw = () => $('#with-raw').checked;
function rawsOf(items) {
  const m = new Map(); // one RAW per set, even if several looks are picked
  for (const p of items) if (p.rawName) m.set(`${p.rawName}:${p.rawSize}`, p);
  return m;
}

let destToken = 0;
async function renderStaged() {
  const token = ++destToken;
  // what's already in the export folder (also tells us which picks are there)
  const dest = await api('GET', `/api/dest?path=${encodeURIComponent(S.dest)}`).catch(() => ({ files: [] }));
  if (token !== destToken) return;
  const there = new Set(dest.files.map((f) => `${f.name}:${f.size}`));
  const names = new Set(dest.files.map((f) => f.name));
  // already written: an identical file is in the folder (cropped exports
  // differ in size, so for those: exported before and the name is there)
  const jpegWritten = (p) => (editOf(p) ? S.exported.has(p.key) && names.has(p.name) : there.has(`${p.name}:${p.size}`));
  const rawWritten = (p) => !withRaw() || !p.rawName || there.has(`${p.rawName}:${p.rawSize}`);
  const written = (p) => jpegWritten(p) && rawWritten(p);
  const items = stagedPhotos();
  const grid = $('#staged-grid');
  grid.innerHTML = '';
  renderDest(dest);
  const vids = items.filter((p) => p.kind === 'video').length;
  const bytes = items.reduce((a, p) => a + p.size, 0);
  const parts = [];
  if (items.length - vids) parts.push(`${items.length - vids} photo${items.length - vids === 1 ? '' : 's'}`);
  if (vids) parts.push(`${vids} video${vids === 1 ? '' : 's'}`);
  const edited = items.filter((p) => editOf(p)).length;
  if (edited) parts.push(`${edited} cropped`);
  const raws = rawsOf(items);
  const rawBytes = [...raws.values()].reduce((a, p) => a + p.rawSize, 0);
  $('#raw-opt').hidden = !raws.size;
  $('#raw-count').textContent = raws.size ? `(${fmtN(raws.size)})` : '';
  if (raws.size && withRaw()) parts.push(`${fmtN(raws.size)} RAW`);
  const total = bytes + (withRaw() ? rawBytes : 0);
  $('#staged-summary').textContent = items.length ? `${parts.join(' · ')} · ${fmtBytes(total)}` : 'Nothing staged yet';
  $('#dest').textContent = S.dest.replace(S.server.home, '~');
  $('#dest').title = S.dest;
  const pending = items.filter((p) => !written(p)).length;
  $('#export').disabled = !pending;
  $('#export').textContent = pending && pending < items.length ? `Export ${fmtN(pending)} new` : 'Export';
  $('#clear-flags').hidden = !items.length;
  if (!items.length) {
    grid.append(el('div', 'staged-empty', 'Press 1, 2 or 3 on a set to stage a look.'));
    return;
  }
  const io = stagedObserver();

  for (const p of items) {
    const tile = el('div', 'tile');
    const thumb = el('div', 'thumb');
    tile.append(thumb);
    const meta = el('div', 'meta');
    meta.append(el('span', 'sim', p.kind === 'video' ? 'Video' : p.filmSim || 'Photo'), el('span', 'muted', p.name));
    tile.append(meta);
    if (withRaw() && p.rawName) meta.append(el('span', 'rawtag', '+RAW'));
    if (written(p)) meta.append(el('span', 'there', 'in folder'));
    else tile.classList.add('pending'); // will be written on export: outlined
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

// E: export everything staged, showing the staged view so progress is visible
function exportAll() {
  if (!S.lib) return;
  if (!stagedPhotos().length) return toast('Nothing staged yet — press 1, 2 or 3 to pick');
  if (S.solo) closeSolo();
  openStaged();
  doExport();
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
  $('#export-progress').classList.remove('done');
  result.textContent = 'Exporting…';
  const rawFor = withRaw() ? items.filter((p) => p.rawName).map((p) => p.id) : [];
  const total = items.length + (withRaw() ? rawsOf(items).size : 0);
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
    if (plain.length || rawFor.length) {
      const r = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest: S.dest, ids: plain.map((p) => p.id), rawFor }),
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
    $('#export-progress').classList.add('done');
    result.innerHTML = '';
    const bits = [`Copied ${copied}`];
    if (skipped) bits.push(`${skipped} already there`);
    if (failed.length) bits.push(`${failed.length} failed (${failed.map((f) => f.name).join(', ')})`);
    result.append(el('span', '', bits.join(' · ') + ' → '));
    const reveal = el('button', '', S.dest.replace(S.server.home, '~'));
    reveal.title = 'Show in Finder';
    reveal.onclick = () => api('POST', '/api/reveal', { path: S.dest });
    result.append(reveal);
    const unpicked = unpickedIn(items.filter((p) => !failed.some((f) => f.name === p.name)));
    if (unpicked.length) {
      const clean = el('button', 'cleanup', `Delete ${fmtN(unpicked.length)} unpicked look${unpicked.length === 1 ? '' : 's'} from the card`);
      clean.title = 'The looks you didn\'t pick in these sets. Your picks and RAW files stay. Undo for 10 s.';
      clean.onclick = () => {
        clean.remove();
        cleanUpCard(items);
      };
      result.append(el('span', 'muted', '   ·   '), clean);
    }
    render();
    renderStaged(); // written photos lose their outline; the folder list updates
  } catch (e) {
    result.textContent = 'Export failed: ' + e.message;
  } finally {
    exporting = false;
    $('#export').disabled = false;
  }
}

// Renders the crop from the full-resolution file and hands the JPEG to the
// server, which restores the camera's EXIF before writing it.
function stagedObserver() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        en.target._load();
      }
    },
    { root: $('#staged-scroll'), rootMargin: '400px' }
  );
  return io;
}

// Files already in the export folder, newest first, as small thumbnails.
function renderDest(dest) {
  const head = $('#dest-head');
  const grid = $('#dest-grid');
  head.innerHTML = '';
  grid.innerHTML = '';
  if (!dest.files || !dest.files.length) {
    head.hidden = grid.hidden = true;
    return;
  }
  head.hidden = grid.hidden = false;
  const bytes = dest.files.reduce((a, f) => a + f.size, 0);
  head.append(
    el('span', '', `Already in ${S.dest.replace(S.server.home, '~')}`),
    el('span', 'muted', `${fmtN(dest.files.length)} file${dest.files.length === 1 ? '' : 's'} · ${fmtBytes(bytes)}`)
  );
  const io = stagedObserver();
  for (const f of dest.files) {
    const tile = el('div', 'dtile');
    const thumb = el('div', 'thumb');
    tile.title = f.name;
    tile.append(thumb, el('div', 'name', f.name));
    if (f.kind === 'video') thumb.append(el('span', 'play', '▶'));
    else if (f.kind === 'raw') thumb.append(el('span', 'rawlabel', 'RAW'));
    else {
      thumb._load = () => {
        const img = new Image();
        img.decoding = 'async';
        img.alt = '';
        img.src = `/api/dest-img?path=${encodeURIComponent(S.dest)}&name=${encodeURIComponent(f.name)}`;
        thumb.append(img);
      };
      io.observe(thumb);
    }
    grid.append(tile);
  }
}

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
function toast(msg, opts = {}) {
  const t = $('#toast');
  t.textContent = msg;
  if (opts.action) {
    const b = el('button', 'toast-action', opts.label || 'Undo');
    b.onclick = () => {
      t.hidden = true;
      opts.action();
    };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), opts.ms || 1800);
}

/* ------------------------------------------------------------ delete from card */

let lastDelete = null; // {token, until, restore}: the latest delete, undoable for a few seconds

async function deleteSet() {
  const set = S.view[S.idx];
  if (!set) return;
  const names = set.photos.map((id) => photo(id).name);
  let res;
  try {
    res = await api('POST', '/api/delete', { ids: set.photos });
  } catch (e) {
    return toast(e.message, { ms: 3500 });
  }
  const flagged = set.photos.map((id) => photo(id).key).filter((k) => S.flags.has(k));
  for (const k of flagged) S.flags.delete(k);
  if (flagged.length) saveFlags();
  const li = S.lib.sets.indexOf(set);
  S.lib.sets.splice(li, 1);
  const idx = S.idx;
  applyFilter(false);
  S.idx = clamp(idx, 0, Math.max(0, S.view.length - 1));
  if (S.solo) {
    const next = S.view[S.idx];
    if (!next || next.kind === 'video') closeSolo();
    else S.solo.pos = selectedPos(next) ?? Math.min(S.solo.pos, next.photos.length - 1);
  }
  lastDelete = {
    token: res.token,
    until: Date.now() + res.undoMs,
    restore() {
      S.lib.sets.splice(Math.min(li, S.lib.sets.length), 0, set);
      for (const k of flagged) S.flags.add(k);
      if (flagged.length) saveFlags();
      applyFilter(false);
      const i = S.view.indexOf(set);
      if (i >= 0) S.idx = i;
    },
  };
  render();
  updateFlagsUi();
  const label = names.length > 1 ? `${names[0]} – ${names[names.length - 1]}` : names[0];
  toast(`Deleted ${label} from the card`, { action: undoDelete, label: 'Undo ⌘Z', ms: res.undoMs - 300 });
}

async function undoDelete() {
  const d = lastDelete;
  if (!d || Date.now() > d.until) return toast('Nothing to undo');
  lastDelete = null;
  try {
    await api('POST', '/api/undo-delete', { token: d.token });
  } catch (e) {
    return toast(e.message, { ms: 3500 });
  }
  d.restore();
  render();
  updateFlagsUi();
  if (!$('#staged').hidden) renderStaged();
  toast('Restored');
}

/* After an export: offer to delete, from the card, the looks you didn't pick
   in the sets you just exported. Picks and RAW files stay; 10 s undo. */
function unpickedIn(items) {
  const sets = new Set();
  for (const p of items) {
    const set = S.lib.sets.find((s) => s.photos.includes(p.id));
    if (set && set.photos.length > 1) sets.add(set);
  }
  const out = [];
  for (const set of sets) for (const id of set.photos) if (!S.flags.has(photo(id).key)) out.push({ set, id });
  return out;
}

async function cleanUpCard(items) {
  const doomed = unpickedIn(items);
  if (!doomed.length) return;
  let res;
  try {
    res = await api('POST', '/api/delete', { ids: doomed.map((d) => d.id), keepRaw: true });
  } catch (e) {
    return toast(e.message, { ms: 3500 });
  }
  const before = new Map(); // set -> its photo list, for undo
  for (const { set, id } of doomed) {
    if (!before.has(set)) before.set(set, set.photos.slice());
    set.photos = set.photos.filter((x) => x !== id);
  }
  lastDelete = {
    token: res.token,
    until: Date.now() + res.undoMs,
    restore() {
      for (const [set, photos] of before) set.photos = photos;
    },
  };
  render();
  drawTicks();
  toast(`Deleted ${fmtN(doomed.length)} unpicked look${doomed.length === 1 ? '' : 's'} from the card`, {
    action: undoDelete,
    label: 'Undo ⌘Z',
    ms: res.undoMs - 300,
  });
}

/* Full screen: in the app the native window goes full screen (the system
   WebView's element full screen is unreliable); in a browser, the page does. */
const inApp = () => S.server && S.server.shell === 'tauri';
let appFs = false;
const isFullscreen = () => (inApp() ? appFs : !!document.fullscreenElement);

function onFullscreenChange(on) {
  document.body.classList.toggle('fs', on);
  // leaving full screen (Esc, green button) also leaves an inspect view that entered it
  if (!on && S.solo && S.solo.ownsFs) closeSolo();
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}

async function setFullscreen(on) {
  if (on === isFullscreen()) return true;
  if (inApp()) {
    await api('POST', '/api/window', { cmd: 'fullscreen', on }).catch(() => null);
    appFs = on;
    onFullscreenChange(on);
    return true;
  }
  try {
    if (on) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
    return true;
  } catch {
    if (on) toast('Full screen unavailable');
    return false;
  }
}

function toggleFullscreen() {
  setFullscreen(!isFullscreen());
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
  $('#folder').onclick = () => (S.lib ? openFolder(S.lib.root) : showWelcome());
  bindSurvey();
  $('#staged-btn').onclick = () => openStaged();
  $('#ov-btn').onclick = () => openOverview();
  $('#eject-btn').onclick = () => S.lib && ejectCard(S.lib.root, S.lib.volume && S.lib.volume.name);
  $('#fs-btn').onclick = toggleFullscreen;
  $('#help-btn').onclick = () => ($('#help').hidden = !$('#help').hidden);
  $('#help').onclick = () => ($('#help').hidden = true);
  $('#staged-close').onclick = closeStaged;
  $('#export').onclick = doExport;
  try {
    $('#with-raw').checked = localStorage.getItem('brackit:withRaw') === '1';
  } catch {}
  $('#with-raw').onchange = () => {
    try {
      localStorage.setItem('brackit:withRaw', withRaw() ? '1' : '0');
    } catch {}
    renderStaged();
  };
  $('#clear-flags').onclick = () => {
    const items = stagedPhotos();
    const btn = $('#clear-flags');
    if (!items.length) return;
    if (!btn.dataset.armed) {
      // ask by relabelling the button rather than a modal dialog
      btn.dataset.armed = '1';
      btn.textContent = `Unstage all ${items.length}?`;
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = 'Clear';
      }, 3000);
      return;
    }
    delete btn.dataset.armed;
    btn.textContent = 'Clear';
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
    $('#peek').hidden = true;
    render();
  };
  $('#ticks').onmousemove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    TL.mx = e.clientX - r.left;
    if (TL.target === 0) {
      if (TL.strength === 0) TL.fx = TL.mx; // bulge appears under the cursor
      TL.target = 1;
    }
    animateTimeline();
    peekAt(e);
  };
  $('#ticks').onmouseleave = () => {
    $('#peek').hidden = true;
    peekIdx = -1;
    TL.target = 0;
    animateTimeline();
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

  // browser: Esc in full screen is swallowed by the browser itself
  document.addEventListener('fullscreenchange', () => onFullscreenChange(!!document.fullscreenElement));
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
    rt = setTimeout(async () => {
      if (inApp()) {
        // catch the green-button / menu full screen too
        const w = await api('POST', '/api/window', { cmd: 'state' }).catch(() => null);
        if (w && typeof w.fullscreen === 'boolean' && w.fullscreen !== appFs) {
          appFs = w.fullscreen;
          return onFullscreenChange(appFs);
        }
      }
      drawTicks();
      if (!$('#survey').hidden) drawSurveyChart();
      if (S.editor) layoutEditor();
      else if (!$('#viewer').hidden) render();
    }, 80);
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', (e) => {
    if (e.repeat && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) S.flipping = true;
    onKey(e);
  });
  document.addEventListener('keyup', (e) => {
    if (S.flipping && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      S.flipping = false;
      if (S.lib && !$('#viewer').hidden) preloadAround(); // resume full prefetch
    }
  });
}

function onKey(e) {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  // ⌘/Ctrl/Shift + digit = add to a multi-pick (browsers reserve ⌘1-9 for
  // tabs, so Shift works there too). Other modified keys belong to the system.
  const digit = /^Digit([0-9])$/.exec(e.code);
  const addMod = e.metaKey || e.ctrlKey || e.shiftKey;
  const cmd = e.metaKey || e.ctrlKey;
  const delKey = cmd && (e.key === 'Backspace' || e.key === 'Delete');
  const undoKey = cmd && !e.shiftKey && (e.key === 'z' || e.key === 'Z');
  const ejectKey = cmd && (e.key === 'e' || e.key === 'E');
  if ((e.metaKey || e.ctrlKey || e.altKey) && !digit && !delKey && !undoKey && !ejectKey) return;
  if (ejectKey) {
    e.preventDefault();
    if (S.lib && S.lib.volume && S.lib.volume.ejectable) ejectCard(S.lib.root, S.lib.volume.name);
    else if (!$('#survey').hidden && SV.data && SV.data.volume && SV.data.volume.ejectable) ejectCard(SV.data.root, SV.data.volume.name);
    return;
  }
  const k = digit ? digit[1] : delKey ? 'DeleteSet' : undoKey ? 'Undo' : e.key;

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

  if (!$('#overview').hidden) {
    if (k === 'ArrowRight') moveOverviewCursor(OV.cursor + 1);
    else if (k === 'ArrowLeft') moveOverviewCursor(OV.cursor - 1);
    else if (k === 'ArrowDown') overviewVertical(1);
    else if (k === 'ArrowUp') overviewVertical(-1);
    else if (k === 'Home') moveOverviewCursor(0);
    else if (k === 'End') moveOverviewCursor(OV.tiles.length - 1);
    else if (k === 'Enter' || k === ' ') closeOverview(OV.cursor);
    else if (k === 'Escape' || k === 'g' || k === 'G') closeOverview();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else return;
    return e.preventDefault();
  }

  if (!$('#staged').hidden) {
    if (k === 'Escape' || k === 's' || k === 'S') closeStaged();
    else if (k === 'Enter' || k === 'e' || k === 'E') doExport();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else return;
    return e.preventDefault();
  }

  if (!$('#survey').hidden) {
    if (k === 'Enter') openScoped();
    else if (k === 'Escape') $('#survey-back').click();
    else if (k === 'a' || k === 'A') quickRange('all');
    else if (k === 'l' || k === 'L') quickRange('last');
    else if (k === 'w' || k === 'W') quickRange('week');
    else if (k === 'n' || k === 'N') quickRange('new');
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else return;
    return e.preventDefault();
  }

  if ($('#viewer').hidden) {
    if (k === 'f' || k === 'F') toggleFullscreen();
    return;
  }
  if (k === 'DeleteSet') {
    e.preventDefault();
    return deleteSet();
  }
  if (k === 'Undo') {
    e.preventDefault();
    return undoDelete();
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
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9': {
      if (!set) break;
      const pos = Number(k) - 1;
      if (pos >= set.photos.length) break;
      if (digit && addMod) toggleFlag(pos);
      else selectOnly(pos);
      if (S.solo && S.solo.pos !== pos) {
        S.solo.pos = pos;
        renderSolo();
      }
      break;
    }
    case '0':
      clearSet();
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
      else if (set) openSolo(selectedPos(set) ?? S.hoverPos ?? 0, { fullscreen: true });
      break;
    }
    case 'Enter':
      if (!S.solo && set && set.kind !== 'video') openSolo(S.hoverPos ?? 0);
      break;
    case 'z':
    case 'Z':
      if (S.solo) toggleZoom();
      break;
    case 'i':
    case 'I':
      if (S.solo) toggleInfo();
      else if (set && set.kind !== 'video') {
        S.showInfo = false;
        openSolo(selectedPos(set) ?? S.hoverPos ?? 0);
        toggleInfo();
      }
      break;
    case 'c':
    case 'C':
      openEditor();
      break;
    case 'Escape':
      if (S.solo) closeSolo();
      else if (isFullscreen()) setFullscreen(false);
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 's':
    case 'S':
      openStaged();
      break;
    case 'e':
    case 'E':
      exportAll();
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
    case 'g':
    case 'G':
      openOverview();
      break;
    case 'o':
    case 'O':
      if (S.solo) closeSolo();
      openFolder(S.lib.root);
      break;
    default:
      return;
  }
  e.preventDefault();
}

boot().catch((e) => {
  document.body.textContent = 'Brackit could not start: ' + e.message;
});
