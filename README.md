# Brackit

Review Fujifilm **film-simulation brackets** side by side, pick the look you
want, and copy just those off the SD card.

Shoot in film-simulation bracketing mode on an X100VI (or any recent X-series
body) and every press of the shutter writes three JPEGs, one per simulation.
Brackit finds those triples, shows them as a 3-up with the simulation name
under each, and lets you pick the keeper with `1` `2` `3`.

- Fast: reads only the JPEG headers to group and label shots, and displays the
  ~1920 px preview Fuji already embeds in every file (no decoding of 40 MP
  originals until you ask for one). Neighbouring sets are preloaded.
- Straighten & crop: non-destructive; applied to all three looks in a set and
  baked in only on export (camera EXIF and film-sim metadata are preserved).
- Videos: `.MOV`/`.MP4` clips show up in sequence, play full-window, and can
  be staged for export like photos.
- Export copies originals byte-for-byte (cropped photos are re-rendered at
  full resolution, JPEG quality 95).

## Get it

**Mac app** — download the latest `.dmg` from
[Releases](https://github.com/lawrenceleejr/brackit/releases) (tagged builds),
or from the artifacts of any run under
[Actions](https://github.com/lawrenceleejr/brackit/actions). Pick `arm64` for
Apple silicon, `x64` for Intel.

The app is not notarized, so the first launch needs one of:

```bash
xattr -cr /Applications/Brackit.app
```

or right-click the app → **Open** → **Open**.

**Terminal / browser** — needs Node 18+, no dependencies:

```bash
git clone https://github.com/lawrenceleejr/brackit && cd brackit
```

```bash
node bin/brackit.js /Volumes/Untitled
```

This opens Brackit in your browser at `http://127.0.0.1:4870`. Omit the path
to pick a card from the start screen. (`npm link` puts a `brackit` command on
your PATH.)

## Keys

| key | |
|---|---|
| `←` `→` | previous / next set (`⇧` jumps ten) |
| `1` `2` `3` | pick that look for export (replaces the set's pick) |
| `⌘` + `1` `2` `3` | add / remove a look, to export several from one set (`⇧` also works in the browser, where ⌘-digits switch tabs) |
| `0` | unstage the whole set |
| `space` | inspect the pick full screen at full resolution; there `1` `2` `3` switch (and pick) looks, `space`/`Esc` returns |
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

Flags and crops are remembered in `~/.brackit/state.json`, keyed by file name,
size and capture time, so you can eject the card and pick up later.

## Develop

```bash
npm install
```

```bash
npm run app
```

`npm start` runs the browser version, `npm test` runs the tests, and
`npm run dist` builds an app for the current platform into `dist/`.

CI (`.github/workflows/build.yml`) builds macOS (arm64 + x64 `.dmg`/`.zip`),
Linux (`AppImage`) and Windows installers on every push. Push a tag like
`v0.1.0` to publish them as a GitHub release.
