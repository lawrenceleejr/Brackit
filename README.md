# Brackit

**Pick your favourite film simulation, fast.**

If you shoot **Film Simulation Bracketing** (BKT → FILM SIMULATION BKT) on your
X100VI, X-T5, X-S20 or another recent Fujifilm body, every press of the shutter
leaves three JPEGs on the card, one per simulation. Brackit shows the three
side by side with their names (Classic Chrome, Reala Ace, Acros…). You press
`1`, `2` or `3` for the one you like and copy just those off the card.

It works with ordinary (non-bracketed) photos and with videos too.

---

## Install (Mac)

1. Go to **[Releases](https://github.com/lawrenceleejr/brackit/releases)** and
   download the `.dmg`:
   - **AppleSilicon** for M1/M2/M3/M4 Macs
   - **Intel** for older Macs
2. Open it and drag **Brackit** into Applications.
3. The first time only: Brackit isn't from the App Store, so macOS will
   block it. Right-click Brackit in Applications → **Open** → **Open**.
   If macOS says the app is "damaged", run this once in Terminal:

   ```bash
   xattr -cr /Applications/Brackit.app
   ```

The download is under 2 MB.

## Using it

1. **Put your SD card in.** Open Brackit and click your card.
2. **Choose what to look at.** You'll see your card's folders and a chart of
   how many shots you took each day. Drag across the days you want, or pick
   **Last day** or **Last 7 days**, then press **Open**. On a full card this is
   much quicker than loading everything.
3. **Flip through with ← →.** Each bracket appears as three photos with the
   film simulation under each.
4. **Pick with 1, 2 or 3.** The pick gets an orange outline. Want two looks
   of the same shot? Hold `⌘` and press another number. `0` clears the set.
5. **Look closer with space.** It shows your pick full screen, at full
   resolution. Press `1` `2` `3` there to compare looks, `Z` to see actual
   pixels, and space again to go back.
6. **Export with S.** You'll see everything you picked. Ones that will be
   copied have an orange outline. Below is what's already in your export
   folder. Choose the folder, tick **Include RAW** if you want the `.RAF`
   files too, and press **Export**.

Your picks are remembered, so you can eject the card and carry on later.

## Handy extras

- **Straighten and crop:** press `C`. Use the slider (or `[` `]`) to level the
  horizon, drag the corners to crop, and pick a shape (3:2, 1:1, 4:5, 16:9…).
  The card is never changed. The crop is applied to the copy when you export,
  and your camera details and film simulation are kept.
- **Overview:** press `G` to see every shot as a small thumbnail, grouped by
  day. It's the quickest way to find your place.
- **Delete from the card:** `⌘⌫` deletes all versions of a photo (all three
  looks and the RAW). You have 10 seconds to undo with `⌘Z`. After that it's
  gone for good.
- **Videos** show up in order and play right in the app. Press `1` to export
  one.
- **Full screen:** press `F`.

## All the keys

| Key | What it does |
|---|---|
| `←` `→` | previous / next shot (`⇧` jumps 10) |
| `1` `2` `3` | pick that look |
| `⌘` + `1` `2` `3` | pick an extra look (or remove it) |
| `0` | un-pick this shot |
| `space` | inspect your pick full screen (play/pause for videos) |
| `↑` `↓` | switch looks while inspecting |
| `Z` | actual pixels while inspecting |
| `C` | straighten & crop |
| `G` | overview of all shots |
| `S` | your picks & export |
| `⌘⌫` / `⌘Z` | delete from card / undo |
| `B` | only show brackets |
| `U` | jump to the next shot you haven't picked from |
| `F` | full screen |
| `O` | choose another folder, dates or card |
| `?` | show these keys |

## Good to know

- **It's fast because it doesn't open your photos to browse them.** Every
  Fujifilm JPEG contains a tiny thumbnail and a screen-sized preview. Brackit
  shows those, and only opens the full 40 MP file when you inspect one.
- **RAW files:** if you shoot RAW+JPEG, Brackit matches each `.RAF` to its
  photo, and copies it on export when **Include RAW** is ticked.
- **Nothing leaves your Mac.** Brackit runs locally and doesn't upload
  anything.
- **Windows and Linux** versions are on the Releases page too.

## Use it in a browser instead

The app also runs from Terminal and opens in your web browser:

```bash
/Applications/Brackit.app/Contents/MacOS/brackit --serve /Volumes/Untitled
```

(Replace `Untitled` with your card's name.)

---

## For developers

Brackit is a small Rust program (`src-tauri/`) that reads cards and serves a
plain HTML/JS interface (`web/`), wrapped in a [Tauri](https://tauri.app)
window. Needs Rust and Node.

```bash
npm install
```

```bash
npm run app
```

`npm start` runs the browser version, and `npm run build:cli && npm test`
runs the tests. Every push builds Mac, Windows and Linux apps on GitHub
Actions. Push a tag like `v0.3.0` to publish a release.
