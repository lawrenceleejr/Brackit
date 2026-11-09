'use strict';
/* Inspection tools, layered over whatever photo is on screen:
     `  loupe (Aperture-style magnifier following the cursor)
     W  clipping overlay: red hatching = blown highlights, blue = crushed shadows
     A  annotations: the camera's focus point and detected faces
   Photos opt in by carrying data-photo (an id) and data-src ('card' | 'out')
   on their frame element. Shares helpers and state (S, api, el, …) with app.js. */

const TOOLS = {
  loupe: false,
  clip: (() => {
    try {
      return localStorage.getItem('brackit:clip') === '1';
    } catch {
      return false;
    }
  })(),
  notes: (() => {
    try {
      return localStorage.getItem('brackit:notes') === '1';
    } catch {
      return false;
    }
  })(),
  zoom: 1, // loupe magnification: 1 = 100% (one image pixel per screen pixel)
};

const srcQuery = (src) => (src === 'out' ? '&src=out' : '');
const toolImgUrl = (id, src, full) => `/api/img/${id}?${full ? 'full=1' : 'p=1'}${srcQuery(src)}`;

/* ------------------------------------------------------------ loupe */

const LOUPE_D = 240; // css px
const loupeCache = new Map(); // url -> {img, done}
function loupeImage(url) {
  let e = loupeCache.get(url);
  if (e) return e;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  e = { img, done: false };
  img.decode().then(
    () => {
      e.done = true;
      if (TOOLS.loupe && loupeLast) drawLoupe(loupeLast);
    },
    () => {}
  );
  loupeCache.set(url, e);
  // full-size originals are big: keep only the last two
  while (loupeCache.size > 2) loupeCache.delete(loupeCache.keys().next().value);
  return e;
}

let loupeLast = null;
function loupeTarget(x, y) {
  const under = document.elementsFromPoint(x, y);
  for (const n of under) {
    if (n.id === 'loupe') continue;
    if (n.tagName !== 'IMG' && n.tagName !== 'CANVAS') continue;
    const host = n.closest('[data-photo]');
    if (!host || n.closest('#ov-grid') || n.classList.contains('hist') || n.classList.contains('tool-layer')) continue;
    return { node: n, id: host.dataset.photo, src: host.dataset.src || 'card' };
  }
  return null;
}

function drawLoupe(ev) {
  const lp = $('#loupe');
  const t = loupeTarget(ev.x, ev.y);
  if (!t) {
    lp.hidden = true;
    return;
  }
  const r = t.node.getBoundingClientRect();
  const fx = (ev.x - r.left) / r.width;
  const fy = (ev.y - r.top) / r.height;
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) {
    lp.hidden = true;
    return;
  }
  lp.hidden = false;
  lp.style.left = `${ev.x - LOUPE_D / 2}px`;
  lp.style.top = `${ev.y - LOUPE_D / 2}px`;
  const p = t.src === 'out' ? S.out && S.out.photos[t.id] : S.lib && S.lib.photos[t.id];
  // (inside a CSS crop view the image under the cursor is the whole picture)
  const edit = t.src === 'card' && p && !t.node.closest('.crop-view') ? editOf(p) : null;
  // map to the original: through the crop rectangle (rotation ignored)
  let ux = fx;
  let uy = fy;
  if (edit) {
    ux = edit.crop.x + fx * edit.crop.w;
    uy = edit.crop.y + fy * edit.crop.h;
  }
  const full = loupeImage(toolImgUrl(t.id, t.src, true));
  const src = full.done ? full.img : t.node; // the screen image until the original arrives
  const W = srcW(src);
  const H = srcH(src);
  const c = lp.querySelector('canvas');
  const d = dpr();
  if (c.width !== LOUPE_D * d) {
    c.width = c.height = LOUPE_D * d;
  }
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0d0d0c';
  ctx.fillRect(0, 0, c.width, c.height);
  // at 100% one original pixel fills one device pixel
  // (before the original arrives the screen image stands in: scale it up so
  // the magnification still means "original pixels per screen pixel")
  const origW = p && p.width ? (p.orientation >= 5 ? p.height : p.width) * (edit ? edit.crop.w : 1) : W;
  const scale = full.done ? TOOLS.zoom : TOOLS.zoom * (origW / W);
  const sw = c.width / scale;
  const sh = c.height / scale;
  const sx = (src === t.node ? fx : ux) * W - sw / 2;
  const sy = (src === t.node ? fy : uy) * H - sh / 2;
  ctx.imageSmoothingEnabled = TOOLS.zoom < 2;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  lp.querySelector('.loupe-zoom').textContent = `${Math.round(TOOLS.zoom * 100)}%${full.done ? '' : ' …'}`;
}

function toggleLoupe() {
  TOOLS.loupe = !TOOLS.loupe;
  document.body.classList.toggle('loupe-on', TOOLS.loupe);
  if (!TOOLS.loupe) $('#loupe').hidden = true;
  else if (loupeLast) drawLoupe(loupeLast);
  toast(TOOLS.loupe ? 'Loupe on — scroll to change magnification' : 'Loupe off');
}

let loupeRaf = 0;
document.addEventListener('mousemove', (e) => {
  if (!TOOLS.loupe) return;
  loupeLast = { x: e.clientX, y: e.clientY };
  if (loupeRaf) return;
  loupeRaf = requestAnimationFrame(() => {
    loupeRaf = 0;
    drawLoupe(loupeLast);
  });
});
document.addEventListener(
  'wheel',
  (e) => {
    if (!TOOLS.loupe || $('#loupe').hidden) return;
    e.preventDefault();
    const steps = [0.5, 1, 2, 4];
    const i = steps.indexOf(TOOLS.zoom);
    TOOLS.zoom = steps[clamp(i + (e.deltaY < 0 ? 1 : -1), 0, steps.length - 1)];
    if (loupeLast) drawLoupe(loupeLast);
  },
  { passive: false }
);

/* ------------------------------------------------------------ overlays (clipping, annotations) */

// Overlays sit in a layer exactly over the displayed photo `node` inside `host`.
function overlayLayer(host) {
  let layer = host.querySelector(':scope > .tool-layer');
  if (!layer) {
    layer = el('div', 'tool-layer');
    host.append(layer);
  }
  return layer;
}

function clearOverlays(host) {
  const layer = host && host.querySelector(':scope > .tool-layer');
  if (layer) layer.remove();
}

const metaCache = new Map(); // `${src}:${id}` -> metadata
function photoMeta(id, src) {
  const k = `${src}:${id}`;
  if (!metaCache.has(k)) metaCache.set(k, api('GET', `/api/meta/${id}${src === 'out' ? '?src=out' : ''}`).catch(() => null));
  return metaCache.get(k);
}

/* Paint the active overlays for photo {id, src} over `node` (an img/canvas
   inside `host`). Called whenever the large view shows a new picture. */
async function applyOverlays(host, node, id, src, opts = {}) {
  clearOverlays(host);
  if ((!TOOLS.clip && !TOOLS.notes) || !node || opts.zoomed) return;
  const layer = overlayLayer(host);
  const place = () => {
    const hr = host.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    Object.assign(layer.style, { left: `${nr.left - hr.left}px`, top: `${nr.top - hr.top}px`, width: `${nr.width}px`, height: `${nr.height}px` });
    return nr;
  };
  const nr = place();
  if (!nr.width) return;
  if (TOOLS.clip) layer.append(clippingCanvas(node, nr.width, nr.height));
  if (TOOLS.notes) {
    const m = await photoMeta(id, src);
    if (!m || !layer.isConnected) return;
    const p = src === 'out' ? S.out && S.out.photos[id] : S.lib && S.lib.photos[id];
    const svg = annotationSvg(m, src === 'card' && p ? editOf(p) : null);
    if (svg) layer.append(svg);
  }
}

/* Clipping: hatch pixels that are blown (any channel ≥ 250) in red and
   crushed (all channels ≤ 5) in blue. Diagonal stripes keep the photo
   visible underneath. */
function clippingCanvas(node, w, h) {
  const d = Math.min(dpr(), 1600 / w);
  const cw = Math.max(1, Math.round(w * d));
  const ch = Math.max(1, Math.round(h * d));
  const src = document.createElement('canvas');
  src.width = cw;
  src.height = ch;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(node, 0, 0, cw, ch);
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.className = 'tool-clip';
  let data;
  try {
    data = sctx.getImageData(0, 0, cw, ch);
  } catch {
    return out;
  }
  const px = data.data;
  const ov = out.getContext('2d').createImageData(cw, ch);
  const o = ov.data;
  const stripe = Math.max(3, Math.round(3 * d));
  for (let y = 0, i = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++, i += 4) {
      if (((x + y) / stripe) & 1) continue; // gaps between stripes
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      if (r >= 250 || g >= 250 || b >= 250) {
        o[i] = 255;
        o[i + 1] = 40;
        o[i + 2] = 40;
        o[i + 3] = 220;
      } else if (r <= 5 && g <= 5 && b <= 5) {
        o[i] = 40;
        o[i + 1] = 110;
        o[i + 2] = 255;
        o[i + 3] = 220;
      }
    }
  }
  out.getContext('2d').putImageData(ov, 0, 0);
  return out;
}

/* Annotations: the focus point (corner brackets) and face boxes, from the
   camera's own metadata, mapped through orientation and any crop. */
function annotationSvg(m, edit) {
  if (!m || !m.width || !m.height) return null;
  const o = m.orientation || 1;
  const map = (x, y) => {
    let nx = x / m.width;
    let ny = y / m.height;
    if (o === 3) [nx, ny] = [1 - nx, 1 - ny];
    else if (o === 6) [nx, ny] = [1 - ny, nx];
    else if (o === 8) [nx, ny] = [ny, 1 - nx];
    if (edit) {
      nx = (nx - edit.crop.x) / edit.crop.w;
      ny = (ny - edit.crop.y) / edit.crop.h;
    }
    return [nx * 100, ny * 100];
  };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('tool-notes');
  const add = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.append(e);
    return e;
  };
  let any = false;
  for (const f of m.faces || []) {
    const [x1, y1] = map(f[0], f[1]);
    const [x2, y2] = map(f[2], f[3]);
    add('rect', { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), class: 'face', 'vector-effect': 'non-scaling-stroke' });
    any = true;
  }
  if (m.focus) {
    const [cx, cy] = map(m.focus[0], m.focus[1]);
    if (cx >= 0 && cx <= 100 && cy >= 0 && cy <= 100) {
      // corner brackets around the focus point, like the camera's AF frame
      const s = 3;
      const k = 1.1;
      const corners = [
        [cx - s, cy - s, 1, 1],
        [cx + s, cy - s, -1, 1],
        [cx - s, cy + s, 1, -1],
        [cx + s, cy + s, -1, -1],
      ];
      for (const [x, y, dx, dy] of corners) {
        add('path', { d: `M${x + dx * k},${y} L${x},${y} L${x},${y + dy * k}`, class: 'af', 'vector-effect': 'non-scaling-stroke' });
      }
      any = true;
    }
  }
  return any ? svg : null;
}

function toggleClipping() {
  TOOLS.clip = !TOOLS.clip;
  try {
    localStorage.setItem('brackit:clip', TOOLS.clip ? '1' : '0');
  } catch {}
  toast(TOOLS.clip ? 'Clipping: red = blown highlights, blue = crushed shadows' : 'Clipping off', { ms: 2600 });
  refreshOverlays();
}

function toggleNotes() {
  TOOLS.notes = !TOOLS.notes;
  try {
    localStorage.setItem('brackit:notes', TOOLS.notes ? '1' : '0');
  } catch {}
  toast(TOOLS.notes ? 'Annotations: focus point and faces, as the camera recorded them' : 'Annotations off', { ms: 2600 });
  refreshOverlays();
}

// Re-apply overlays to whichever large view is open.
function refreshOverlays() {
  if (S.solo) {
    const frame = $('#solo-frame');
    const node = frame.firstElementChild;
    if (node && frame.dataset.level !== 'thumb') applyOverlays($('#solo'), node, frame.dataset.photo, 'card', { zoomed: S.solo.zoom });
    else clearOverlays($('#solo'));
  }
  if (typeof libRefreshOverlays === 'function') libRefreshOverlays();
}
window.addEventListener('resize', () => setTimeout(refreshOverlays, 120));
