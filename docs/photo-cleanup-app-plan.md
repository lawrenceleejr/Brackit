# Plan: a Mac app to clean up the Photos library (working name "Brackit Sweep")

A handoff for a new Claude Code session. You'll also have the **Brackit**
repository: this app is standalone, but it inherits Brackit's design,
architecture, keyboard model, speed rules and testing discipline. Read
Brackit's `CLAUDE.md` and `README.md` first, then this plan.

The name is a placeholder; ask the user before using it anywhere public.

---

## 1. What it is

A small **macOS-only** app that opens the user's **Apple Photos library**:

1. It finds **clusters**: photos taken within a short time of each other. The
   window is adjustable, 60 seconds by default.
2. You flip through the clusters with the keyboard, as in Brackit, and mark
   the ones you want to **keep**.
3. It **deletes the rest from Photos**, which frees iCloud storage.

It runs entirely on the Mac. It has no account and uploads nothing.

**Three ways to look at the library:**

- **All clusters.** Every cluster in a date range, in time order.
- **Clusters only** (a filter, on by default). Single photos are hidden, which
  makes triage fast. Turn it off to see everything.
- **Daily cleanup mode** (a checkbox). Shows only photos taken **on this day
  in past years**, clustered the same way. It's meant as a two-minute daily
  ritual: today's date across 2018, 2019, 2021 and so on.

### Not in scope (v1)

- Windows, Linux, iPhone, or a web version. The web can't reach the Photos
  library.
- Editing, export, albums, keywords, faces.
- Reading or writing the Photos library files directly. **PhotoKit only.**
  Touching `Photos Library.photoslibrary` needs Full Disk Access and can
  corrupt the library.
- Emptying Recently Deleted. No app can; see §6.

---

## 2. What to carry over from Brackit

Copy what fits; don't depend on Brackit as a library. Same principles:

- **The photos are the content.** Minimal chrome. One accent colour: amber
  means *keep*, the way it means *picked* in Brackit. Dark neutral palette
  (copy the CSS tokens in `web/style.css`). Tufte-style data displays only:
  no chart junk, labels on the data, hairlines.
- **Keyboard first.**
  - Every action has a key. Buttons show their key in a quiet `<kbd>`, and
    `?` opens a grouped sheet of every key.
  - Every tool is also in an in-page Menu (`M`) and in the Mac menu bar.
    Copy the `MENU` registry plus `runCommand` from `web/app.js` and the
    menu bar in `src-tauri/src/gui.rs`.
  - Flip with `←` `→`, `↑` `↓` and `j` `k`, exactly like Brackit.
- **Flipping is instant: 50 ms from key to paint, always.**
  - Port `test/ui/flip-speed.test.js` (it uses the Event Timing API) and run
    it in CI.
  - The current cluster never waits for a download. Small placeholders come
    first.
  - Sharper images are made in idle time.
  - Nothing heavy runs in the keydown path.
  - Reuse Brackit's machinery: the load queue, the batched thumbnail store
    (`/api/thumbs`), the display-size copies, and render coalescing.
- **Pictures go on screen already decoded.** In WebKit, images loaded with
  `decoding="async"` paint late, and Tauri on macOS *is* WebKit. Copy
  `onScreen()` and its test, `test/ui/webkit.test.js`.
- **The local server rules.**
  - The Rust side serves a plain HTML/CSS/JS UI from a tiny HTTP server on
    127.0.0.1, shown in a Tauri window.
  - Every non-GET request needs the `X-Brackit: 1` header (rename it), and a
    foreign `Origin` is refused.
  - IDs are stable, never index-based.
- **Never destroy without a clear, reviewable step.** Brackit deletes from a
  card only with confirmation and undo. Here, deletion happens only from the
  Review screen, in one batch, behind macOS's own confirmation (§6).
- **Small binary.** Tauri 2 with the system WebView: a few MB, no Electron.
- **The user's working preferences:**
  - Commit and push before testing.
  - Tufte principles for every visual.
  - Plain, non-marketing copy.
  - README written in the first person ("made for me…").

---

## 3. Architecture

```
Tauri 2 window (WebKit) ──► http://127.0.0.1:<port>/  (web/: index.html, app.js, style.css)
                                   │  /api/...
                         Rust (tiny_http server, like Brackit's server.rs)
                                   │
                         trait PhotoSource   ◄── FakeSource (folder of JPEGs: tests, Linux CI)
                                   │
                         PhotoKitSource (macOS only, objc2-photos)
```

### The `PhotoSource` trait

This is the key design choice. It keeps the UI, the clustering and the API
testable without a Photos library: on Linux CI and in headless browser tests.

```rust
trait PhotoSource: Send + Sync {
    fn authorization(&self) -> Auth;                       // NotDetermined | Denied | Restricted | Authorized
    fn request_authorization(&self) -> Auth;               // shows the macOS prompt
    fn assets(&self) -> Vec<Asset>;                        // metadata only, all of it, fast
    fn thumbnail(&self, id: &AssetId, px: u32) -> Option<Vec<u8>>;   // JPEG bytes, local only
    fn image(&self, id: &AssetId, px: Option<u32>, progress: &dyn Fn(f64)) -> Option<Vec<u8>>; // may download from iCloud
    fn delete(&self, ids: &[AssetId]) -> Result<DeleteOutcome>;      // system confirmation; user may cancel
    fn on_change(&self, f: Box<dyn Fn() + Send>);          // the library changed (sync, edits)
}
```

- **`Asset`:**
  - `id` (a short hash of `PHAsset.localIdentifier`)
  - `local_id`
  - `created` (UTC plus the original time zone if available)
  - `kind`: photo, video or Live Photo
  - `subtypes`: screenshot, HDR, burst, portrait…
  - `width`, `height`, `duration`
  - `favorite`, `hidden`
  - `burst_id`
  - `source`: the user's library, or the shared library
  - `bytes`: estimated size, optional (see below)
- **`FakeSource`** reads a folder of JPEGs and takes the time from EXIF
  `DateTimeOriginal`, as Brackit does. Deleting moves the files to a trash
  folder, so tests can check what was deleted.

### The PhotoKit bridge

- Use **`objc2-photos`** with `objc2`, `objc2-foundation`, `block2` and
  `objc2-image-io`.
- **Milestone 0 is a spike** proving the crate covers everything needed.
  If it doesn't, a small Swift helper compiled into the app is the fallback.
- **Fetching:**
  - `PHAsset.fetchAssets(with: options)`, sorted by `creationDate`.
  - Images and videos only.
  - `includeHiddenAssets = false`.
  - Source types: the user library, plus the iCloud Shared Library flagged as
    such (§6).
- **Thumbnails:**
  - `PHCachingImageManager.requestImage(for:targetSize:contentMode:options:)`
  - Options: `deliveryMode .highQualityFormat`, `resizeMode .fast` and
    `isNetworkAccessAllowed = false`. Photos keeps small renditions locally
    even with "Optimize Mac Storage".
  - Encode to JPEG with ImageIO (`CGImageDestination`).
  - Preheat ahead with `startCachingImages`.
- **Originals (zoom only):**
  - `requestImageDataAndOrientation`, with `isNetworkAccessAllowed = true`.
  - Pass the `progressHandler` through to the UI.
- **Deleting:** inside `PHPhotoLibrary.shared().performChanges`, call
  `PHAssetChangeRequest.deleteAssets(fetchResultOfThoseIds)`. macOS then shows
  its own confirmation. The completion reports success, or failure if the user
  cancelled.
- **Changes:** register a `PHPhotoLibraryChangeObserver`, refresh the asset
  list and re-cluster.
- **Threading:** PhotoKit calls back on its own queues. Hand results to Rust
  over channels, and never block the HTTP server thread on a download.
- **Sizes:** `PHAssetResource` gives each file's size only through the
  undocumented `fileSize` key. Use it for the space estimate if it works,
  otherwise estimate from pixel count. Label the number "about".

### Permissions and signing

- **`Info.plist`:** add `NSPhotoLibraryUsageDescription`, e.g. "Brackit Sweep
  shows your photos in groups so you can keep the best and delete the rest.
  Nothing leaves your Mac."
- **Requesting access:** call `PHPhotoLibrary.requestAuthorization(for: .readWrite)`
  from the start screen's button, not at launch.
- **Denied or Restricted:** show a screen explaining how to allow it, with a
  button that opens
  `x-apple.systempreferences:com.apple.preference.security?Privacy_Photos`.
- **Sandbox and hardened runtime:**
  - The app is not sandboxed.
  - If the hardened runtime is enabled, add the entitlement
    `com.apple.security.personal-information.photos-library`.
- **Signing:**
  - The user can't use Apple Developer signing, so the app is ad-hoc signed
    like Brackit (`signingIdentity "-"`).
  - Expect macOS to **ask for Photos access again after each update**, because
    the grant is tied to the signature. Say so in the README and on the
    permission screen.
  - Verify this in Milestone 0.

### The HTTP API (all GET except where marked)

| Endpoint | Purpose |
|---|---|
| `/api/state` | Authorization state, library summary, saved marks, settings |
| `POST /api/authorize` | Asks macOS for Photos access |
| `/api/library?window=60&from=…&to=…&clustersOnly=1&onThisDay=1` | Clusters for the view; the server clusters (§4) |
| `/api/thumbs?ids=…` | Batched thumbnails, same format as Brackit's |
| `/api/img/<id>?px=…` | One image at a size; `full=1` for the original, which may download |
| `/api/progress/<id>` | iCloud download progress |
| `PUT /api/marks` | Keep/delete marks, saved on disk |
| `POST /api/delete` | Deletes the marked photos (Review screen only); returns what happened |

Store state in `~/Library/Application Support/<app>/state.json`, keyed by
`localIdentifier`: marks, settings, and the last day daily cleanup was done.

---

## 4. Clustering and filters

### Clusters

- Sort by capture time. A new cluster starts where the **gap since the
  previous photo is longer than the window**.
- **Window:** adjustable from 5 s to 30 min, on a log scale. Steps: 5 s, 10 s,
  30 s, 1 min, 2 min, 5 min, 10 min, 30 min. Default 60 s.
  - Keys `[` and `]`, plus a small control on the start screen and in the
    viewer's footer.
  - Re-clustering is instant (it's metadata only) and keeps your position:
    the cluster containing the photo you were on.
- **Bursts:** a burst (same `burst_id`) always stays in one cluster, whatever
  the window.
- **Live Photos and RAW+JPEG pairs** are one asset each in Photos, so there's
  nothing to pair up.
- **Videos** cluster with the photos around them. They show with a ▶ badge,
  and play in the large view.
- **Time:** use the capture time in the photo's own time zone where PhotoKit
  has it, so a trip abroad doesn't split oddly. Note what was decided.

### Filters (combinable)

- **Clusters only** (on by default; key `C`): hide clusters of one photo.
- **Daily cleanup** (checkbox; key `D`): only assets whose month and day equal
  today's, from previous years.
  - **29 February:** show it on 28 February in non-leap years. Never show it
    twice in a year.
  - The header reads: *"On this day: 2019 · 2021 · 2023 (14 clusters)"*.
  - Record when daily cleanup was last finished, so the start screen can say
    "done today".
- **Date range:** drag on the shots-per-day chart, as on Brackit's survey
  screen. Copy `drawSurveyChart`, `quickRange` and the arrow-key range keys.
- **Optional later:** media type (photos, videos, screenshots). Screenshots
  cluster very well for cleanup.

---

## 5. Screens and keys

### Start screen

- **Permission state.**
- **Library summary:** a Tufte strip of photos per month across all years,
  with counts on hover.
- **Cluster window control.**
- **Two checkboxes:** Clusters only, and Daily cleanup.
- **A big number:** how many clusters and photos the current filters give.
- `Enter` opens.

### Cluster viewer (the Brackit 3-up, generalised)

- **Layout:** a grid of the cluster's photos, sized to fill the window.
  - Reuse Brackit's layout logic: 1–3 photos in a row or 2+1; 4–9 in a near
    square grid; more than 9 in a scrolling grid with the focused photo
    visible.
  - A caption under each photo: its time to the second. Keys `1`–`9` for the
    first nine.
- **Flipping:** `←` `→` / `↑` `↓` / `j` `k` move to the previous or next
  cluster. `Shift` jumps ten. `Home` / `End`.
- **Marking:**
  - `1`–`9` toggle **keep** on that photo (amber outline).
  - `Tab` moves the focus through the cluster; `Enter` toggles keep on the
    focused photo.
  - `A` keeps all; `0` clears the cluster's marks.
- **The rule, same as Brackit's picks:**
  - A cluster with **no** keeper is untouched; nothing in it will be deleted.
  - Once a cluster has at least one keeper, **its other photos are marked for
    deletion**. They're shown dimmed with a thin diagonal hairline: quiet, not
    red.
  - This makes "keep the best one" a single key press.
- **Large view:** `Space` shows the focused photo large.
  - `1`–`9` and `Tab` switch photo; `Z` shows actual pixels (downloads the
    original if needed, with progress).
  - `Esc` or `Space` goes back.
  - Touch and trackpad work as in Brackit Lite: tap back, double-tap zoom.
- **Timeline:** the footer shows the cluster's date and time and Brackit's
  tick timeline of clusters, plus an "N to delete so far" counter.
- **Favorites:** shown with a small heart. They are never marked for deletion
  automatically; to delete one, mark it explicitly (`X` on the focused
  photo), with a one-line warning.

### Review screen (`R`, like Brackit's Picks)

- Everything marked for deletion, grouped by cluster: **"Delete 412 photos ·
  about 3.1 GB"**.
- Click or `X` toggles a photo back to keep.
- **"Delete from Photos…"** (`Enter`) triggers macOS's confirmation dialog.
- **Afterwards:**
  - A result line: *"Deleted 412. They're in Recently Deleted in Photos for 30
    days; empty it there to free the iCloud space now."*
  - An "Open Photos" button.
  - The marks for the deleted assets are cleared.

### Keys, Menu, `?` sheet

Every action above appears in the `?` sheet, the in-page Menu and the Mac menu
bar, grouped like Brackit's: Flip and keep, Look closely, Clusters and
filters, Review and delete.

---

## 6. Safety: things macOS enforces, and things we choose

### macOS enforces (tell the user plainly, in the README and the UI)

- **A system confirmation on every delete.** It can't be bypassed, but one
  batch is one dialog.
- **Deleted items go to Recently Deleted for 30 days.** No app can empty it,
  so iCloud space comes back after 30 days or when the user empties it in
  Photos.
- **Deletions sync** to every device on that iCloud account.
- **Live Photos and RAW+JPEG** go as a whole, with their edits.

### We choose

- Delete **only** from the Review screen, in one batch. Never from a key press
  in the viewer.
- **No undo after the system confirms** (no API restores from Recently
  Deleted). Marks are freely undoable before that.
- **Hidden photos** are excluded.
- **iCloud Shared Library** photos are excluded by default: deleting one
  removes it for every participant. Possibly a setting later, with a warning.
- **Favorites** are protected, as above.
- **The first ever delete** shows a short explanation, once.
- **Never re-delete:** if the library changed while you were marking, re-fetch
  the marked assets by `localIdentifier` before deleting. Skip what's gone and
  report it.

---

## 7. Performance targets

- **Library size:** must stay smooth with **100,000 assets**.
  - Fetch metadata in one pass. Target under 2 s on an M1 for 100k; measure
    it in Milestone 2.
  - Cache the asset list on disk and refresh it on library change.
- **Flipping:** 50 ms from key to paint between clusters, including a 9-photo
  cluster.
  - Thumbnails for the next few clusters are preheated: PhotoKit caching plus
    Brackit's decoded thumbnail store.
  - Display-size copies are made in idle time.
- **Re-clustering** after a window change takes under 100 ms for 100k assets.
  It's a single pass over sorted times.
- **Never** download an original except for zoom or full-resolution viewing.

---

## 8. Tests

- **Rust unit tests (run on Linux CI):**
  - clustering edges: equal-to-window gaps, bursts across a gap, time zones;
  - clusters-only;
  - on-this-day, including 29 February and the year boundary;
  - mark rules and favorite protection.
- **Server tests against `FakeSource`**, in the style of Brackit's
  `test/server.test.js`:
  - the API;
  - the `X-Brackit` and `Origin` rules;
  - delete removes exactly the marked photos, and a cancelled delete removes
    nothing.
- **Browser tests:**
  - flip-speed and the WebKit paint check, ported from Brackit, on
    `FakeSource`;
  - a keyboard walk-through of every key;
  - a review-and-delete flow.
- **On the user's Mac, manual, checklist in `TESTING.md`:**
  - the permission prompt;
  - denied, then the path to allow it;
  - a small test album of throwaway photos;
  - delete 3 of them, the confirmation, Recently Deleted;
  - the re-prompt after an update.
- **CI:** Linux runs the tests. A macOS runner builds the app (PhotoKit code
  compiles only there) and runs the Rust tests. Release through
  `workflow_dispatch`, as Brackit's `build.yml` does.

---

## 9. Milestones

1. **M0, spike (macOS):** a tiny Tauri app that:
   - asks for Photos permission;
   - lists the newest 20 assets with dates;
   - shows 3 thumbnails;
   - deletes one chosen test asset, with the system dialog.

   It also confirms the `objc2-photos` coverage, the TCC behaviour with ad-hoc
   signing, and the metadata fetch speed. **Stop and report to the user
   before going further.**
2. **M1, skeleton:**
   - copy Brackit's web shell (tokens, viewer, keys, Menu, `?`, timeline,
     load queue) and server patterns;
   - `PhotoSource` with `FakeSource`;
   - clustering and filters with unit tests;
   - flip-speed test passing.
3. **M2, PhotoKit, read-only:** the real library behind the trait; thumbnails
   with preheat; large view; zoom with iCloud download progress; library
   change observer.
4. **M3, keep and delete:** marks, saved; Review screen; batch delete through
   PhotoKit; favorites protection; Shared Library exclusion; re-validation
   before deleting.
5. **M4, daily cleanup mode:** on-this-day filter; header strip by year;
   "done today".
6. **M5, polish and release:**
   - README written for the user ("made for me…", plain);
   - `TESTING.md`;
   - Mac menu bar complete;
   - app icon in Brackit's style;
   - CI release;
   - optionally a page on Brackit's website.

---

## 10. Decisions to confirm with the user (ask early, at M0)

- The app's name.
- Default window (60 s?) and range (5 s – 30 min?).
- Whether clusters only is on by default (the plan says yes).
- Whether favorites stay protected (the plan says yes).
- Shared Library photos: excluded, or included with a warning?
- Screenshots: a separate filter?
- Whether videos are included (the plan says yes, shown with ▶).
- Daily cleanup: just today, or "this week in past years" as an option?
