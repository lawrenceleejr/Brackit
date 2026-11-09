---
title: Brackit
---

I shoot a Fujifilm X100VI with **film simulation bracketing** turned on. Every
time I press the shutter I get three JPEGs of the same frame, each with a
different film simulation. Then I'd sit in Finder flipping between three
almost identical files, trying to decide which one I liked. For hundreds of
photos.

Brackit does that one job. It finds the three looks of each shot on the SD
card, puts them next to each other with the simulation's name underneath, and
lets me keep the one I want with a single key. Then it copies my picks off the
card and leaves the rest.

I vibe coded it on the Shinkansen from Kanazawa to Tokyo, after one too many
evenings of flipping through stacks of triple JPEGs. I made it for myself, but
if you bracket film simulations too, you'll probably find it useful.

## How it works

1. Put the card in and open Brackit. Pick a folder or a few days, or just the
   shots that are new since last time.
2. Flip through with the arrow keys. Press **1**, **2** or **3** to pick a look.
3. Press **Space** to see the pick full screen, at full resolution.
4. Press **E** to copy your picks to a folder. Optionally the RAW files too.

Afterwards it can delete the looks you didn't pick from the card, and eject it.

It's quick because it never opens the full photos just to show them. Every
Fujifilm JPEG already contains a small thumbnail and a screen-sized preview,
and Brackit shows those. The 40 megapixel original only loads when you stop
on a photo to look closely.

<figure class="shot inline">
  <img src="img/inspect.jpg" width="1440" height="900" loading="lazy"
       alt="A single look full screen, with the camera settings and film recipe listed in the corner">
  <figcaption>Press I for the settings and film recipe the camera recorded.</figcaption>
</figure>

## For looking closely

- A loupe, actual-pixels zoom and a histogram.
- Clipping warnings: red where highlights are blown, blue where shadows are
  crushed.
- The focus point and any detected faces, as the camera recorded them.
- The film recipe: simulation, grain, Color Chrome, white balance shift,
  dynamic range, tone, and every other tag in the file.
- Straighten and crop before export. The card itself is never changed.

There's also a library for the export folder, with 0–5 stars, a flag, and
filters by simulation. It runs on macOS, Windows and Linux, works offline,
and doesn't upload anything anywhere.
