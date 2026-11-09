# Changelog

## Unreleased

**Brackit Lite**
- A web version at lawrenceleejr.github.io/Brackit/lite/: nothing to
  install, on iPhone and iPad (with a card reader) or any computer. It reads
  the photos with the desktop app's own code, compiled to WebAssembly, and
  uploads nothing. Exports go to the share sheet (Save to Photos / Files), a
  folder (Chrome, Edge) or Downloads. Works offline from the home screen.
- Touch: swipe to flip, tap a look to pick it, double-tap to see it large. On
  an upright phone the three looks stack in a column.
- Deleting from the card, ejecting and the Library stay in the desktop app.

**Made for the keyboard**
- Every step now has a key: the start screen (`1`–`9` open a card, `O` a
  folder, `/` type a path), the date chooser (`←` `→` a day, `⇧` widens,
  `[` `]` folders), the crop tool (arrows move, `−` `+` resize, `1`–`6`
  aspect), picks (`R` RAW, `D` folder, `X` clear unpicked looks), the library
  filters (`⇧1`–`5`, `⇧P`, `T`, `[` `]`) and the menu (`M`, `↑` `↓` `Enter`).
- Flip forward with `→`, `↓` or `j` and back with `←`, `↑` or `k`, wherever
  you move through photos. Clipping warnings moved from `J` to `W`; in the
  large view `1` `2` `3` switch looks.
- The crop tool starts at the photo's original aspect ratio.
- Buttons show their keys, a reminder of the main keys sits under the photos
  until your first pick, and `?` is now a grouped sheet of every key.

## 0.1.0

The first public release.

**Picking**
- Film simulation brackets side by side (row or two-over-one), labelled with
  the simulation from the camera's metadata. Single shots and videos too.
- `1` `2` `3` pick a look, `⌘`/`Ctrl` + number keeps more than one, `0`
  unpicks. `E` exports, optionally with RAW files.
- Flipping stays under 50 ms per key press (checked in CI): embedded
  thumbnails and previews, batched and prefetched; originals only on a pause.

**Looking closely**
- Large view (`Space`) at full resolution, actual pixels (`Z`), loupe (`` ` ``),
  histogram (`H`), clipping overlay (`J`), focus point and faces (`A`),
  camera settings and film recipe plus every metadata tag (`I`).
- Straighten and crop (`C`), applied to the exported copy only.

**Cards and folders**
- Open a folder, a range of days or "new since last import".
- After export, delete the looks you didn't pick; delete any set from the card
  (`⌘⌫`), with 10 seconds to undo; eject the card (`⌘E`).
- Library (`L`) of the export folder: folders, days, 0–5 stars (in-camera
  ratings included), flags, filters, recipe, move to Trash.

**Everywhere**
- macOS (Apple silicon and Intel), Windows and Linux apps of a few MB, plus a
  terminal/browser mode. Nothing leaves your computer.
