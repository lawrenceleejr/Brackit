# Changelog

## 1.0.0

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
