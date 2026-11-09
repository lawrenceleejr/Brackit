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

## Conventions

- The photos are the content: minimal chrome, one accent colour (amber =
  picked), Tufte-style data displays (no chart junk).
- Never modify files on the card except through the delete-with-undo path.
- Every tool needs a key and an entry in the Menu (`MENU` in `web/app.js`)
  and in the Mac menu bar (`src-tauri/src/gui.rs`).
