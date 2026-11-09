# Brackit — notes for working on this repo

Brackit reviews Fujifilm film-simulation brackets: a Rust server
(`src-tauri/`) reads SD cards and serves a plain HTML/CSS/JS UI (`web/`,
embedded into the binary), wrapped in a Tauri window. See README.md.

## Build and test

```bash
npm run build:cli      # terminal-only binary used by the tests
npm test               # server tests (black-box, synthetic Fuji JPEGs)
npm run test:ui        # flip-speed test in headless Chromium (see below)
```

`npm start` serves the UI in a browser. `npm run app` runs the Tauri app.

```bash
npm run lite           # build Brackit Lite into build/lite and serve it
npm run test:lite      # Lite vs the desktop server on one card (part of test:ui)
```

## Flipping must stay instant: 50 ms budget

Pressing an arrow key must visibly change the screen within **50 ms**, every
time: on a warm card, on a cold slow card, and with the key held down.
Anything slower feels sluggish.

- `test/ui/flip-speed.test.js` enforces this with the browser's Event
  Timing API (key event → next paint). It runs in CI (`ui` job).
- **Run `npm run test:ui` before pushing any change to `web/app.js`
  rendering, image loading, layout, keyboard handling or CSS that affects
  the viewer.** If it fails, fix the regression rather than raising the
  budget.
- How the budget is met: renders are coalesced to one per frame; the
  current set never waits for downloads (header-thumbnail placeholders,
  fetched in batches and kept decoded ahead); previews are prefetched,
  decoded and redrawn at display size in idle time; nothing heavy runs in
  the keydown path.

## Layout

- `src-tauri/src/`: `server.rs` (HTTP API), `library.rs` (scan, grouping,
  RAW matching), `jpeg.rs` (EXIF / MakerNote / MPF parsing, metadata dump),
  `gui.rs` (Tauri window + Mac menu bar), `main.rs` (CLI / `--serve`).
- `web/`: `app.js` (viewer, picks, export, survey, menu), `tools.js` (loupe,
  clipping, annotations), `library.js` (export-folder Library), plus
  `index.html` / `style.css`. Embedded into the binary at build time.
- `site/`: the Hugo website (deployed by `.github/workflows/pages.yml`).
- **Brackit Lite** (the web version, at `/lite/` on the website): the same
  `web/` page plus `web/lite.js`, which answers every `/api` request in the
  browser from picked files, and `src-tauri/src/jpeg.rs` compiled to
  WebAssembly (`lite/wasm`, via its `*_buf` functions). Built by
  `scripts/build-lite.mjs`. Code in `web/` must keep working there: images
  loaded with `fetch` work as is; anything that sets an `/api` URL as a
  `src` directly goes through `mediaUrl()`. Desktop-only features check
  `LITE` and hide with `.full-only`; Lite-only bits use `.lite-only`.
- `test/`: server tests and the UI flip-speed test.

## Rules the code relies on

- **The API only accepts changes from Brackit's own page.** Every non-GET
  request must send `X-Brackit: 1` (the `api()` helper does); a foreign
  `Origin` is refused. Keep it that way for any new endpoint.
- **Photo ids are stable hashes** of path + size + time; never index-based.
- **Exports write `.name.partial` and rename**; "already there" means name,
  size and time all match.

## Conventions

- The photos are the content: minimal chrome, one accent colour (amber =
  picked), Tufte-style data displays (no chart junk).
- Never modify files on the card except through the delete-with-undo path.
- Every tool needs a key and an entry in the Menu (`MENU` in `web/app.js`)
  and in the Mac menu bar (`src-tauri/src/gui.rs`).
