# Brackit

Review Fujifilm **film-simulation brackets** side by side, pick the look you
want, and copy just those off the SD card.

Shoot in film-simulation bracketing mode on an X100VI (or any recent X-series
body) and every press of the shutter writes three JPEGs, one per simulation.
Brackit finds those triples, shows them as a 3-up with the simulation name
under each, and lets you pick the keeper with `1` `2` `3`.

- **Fast:** reads only the JPEG headers to group and label shots, and shows
  the ~1920 px preview Fuji already embeds in every file. A 40 MP original is
  only decoded when you inspect it. The next few sets are preloaded.
- **Small:** a native Rust app that uses the WebView built into macOS. The
  download is a few MB.
- **Straighten & crop:** non-destructive. Applies to every look in a set and
  is baked in only on export (camera EXIF and film-sim metadata preserved).
- **Videos:** `.MOV`/`.MP4` clips show up in sequence, play full-window, and
  can be staged for export like photos.
- **Export:** originals are copied byte-for-byte. Cropped photos are
  re-rendered at full resolution (JPEG quality 95).
- **Delete from the card:** `⌘⌫` removes every version of a photo, with a
  10-second undo.

## Get it

**Mac app:** download the `.dmg` from
[Releases](https://github.com/lawrenceleejr/brackit/releases) (tagged builds),
or from any run under
[Actions](https://github.com/lawrenceleejr/brackit/actions):
`Brackit-macOS-AppleSilicon` (M-series) or `Brackit-macOS-Intel`.

The app is not notarized, so the first launch needs one of:

```bash
xattr -cr /Applications/Brackit.app
```

or right-click the app → **Open** → **Open**.

**Terminal / browser:** the app binary doubles as a command-line tool:

```bash
/Applications/Brackit.app/Contents/MacOS/brackit --serve /Volumes/Untitled
```

This opens Brackit in your browser at `http://127.0.0.1:4870`. Leave off the
path to pick a card from the start screen. A standalone ~1 MB `brackit`
binary (no window code at all) is also published per platform as
`brackit-cli-*`.

## Keys

| key | |
|---|---|
| `←` `→` | previous / next set (`⇧` jumps ten) |
| `1` `2` `3` | pick that look for export (replaces the set's pick) |
| `⌘` + `1` `2` `3` | add / remove a look, to export several from one set (`⇧` also works in a browser, where ⌘-digits switch tabs) |
| `0` | unstage the whole set |
| `space` | inspect the pick full screen at full resolution; there `1` `2` `3` switch (and pick) looks, `space`/`Esc` returns |
| `⌘` `⌫` | delete every version of this photo from the card. Undo with `⌘Z` within 10 s; after that the files are permanently removed |
| click | view one look large |
| `↑` `↓` | cycle looks in the large view |
| `Z`, click | actual pixels in the large view |
| `C` | straighten & crop (`[` `]` rotate 0.1°, `⇧` for 1°) |
| `space` | play / pause a video |
| `F` | full screen |
| `S` | staged photos and export |
| `B` | brackets only / everything |
| `U` | next set with nothing flagged |
| `O` | open another card or folder |
| `?` | help |

Picks and crops are remembered in `~/.brackit/state.json`, keyed by file name,
size and capture time, so you can eject the card and pick up later.

## How it's built

- `src-tauri/`: Rust. A tiny local HTTP server (`server.rs`) reads cards
  (`library.rs`, `jpeg.rs`), serves previews and video, exports, and deletes.
  `gui.rs` wraps it in a [Tauri](https://tauri.app) window. Without the `gui`
  feature it builds as the terminal-only binary.
- `web/`: the interface. Plain HTML/CSS/JS, no framework, embedded into the
  binary at build time.
- `test/`: black-box tests that run the server against synthetic
  Fujifilm-shaped JPEGs.

## Develop

Needs Rust and Node.

```bash
npm install
```

```bash
npm run app
```

`npm start` runs the browser version. `npm run build:cli && npm test` runs the
tests. `npm run dist` builds the app for this machine.

CI (`.github/workflows/build.yml`) builds the macOS (Apple silicon and Intel),
Linux and Windows apps, plus terminal-only binaries, on every push. Push a tag
like `v0.2.0` to publish them as a GitHub release.
