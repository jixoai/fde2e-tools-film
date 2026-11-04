# One Prompt — FDE2E edition

A 90-second lyric music video where every frame is code: typography, 3D, light,
particles and beat-synchronous cuts drawn in the browser with WebGL and Canvas 2D.
The only source media is the song.

Use **Examples → One Prompt → Start project** in FDE2E Film. Loading copies this whole
folder into a normal OPFS project. Edit it, version it and export it like any other project;
no provider, API key or network CDN is required.

## FDE2E adaptations

1. three.js 0.184.0 is pinned and self-hosted under `vendor/three/`.
2. The upstream trademark end plate is replaced by an FDE2E Film end plate.
3. `LICENSE`, verbatim `UPSTREAM_CREDITS.md`, `CREDITS.md`, `THIRD_PARTY_NOTICES.md`,
   OFL and pdoom-video's MIT text
   remain in the project and therefore in every interchange export.
4. `assets/one-prompt.mp3` is explicitly labeled as AI-generated music in
   `EXAMPLE-METADATA.json` and `THIRD_PARTY_NOTICES.md`.

## Structure

`film.html` cuts eight pages together. `src/plates/` contains deterministic shot functions;
`src/px/` is the rendering engine; `assets/data/audio.json` carries beat/onset envelopes;
`assets/data/film-sheet.jpg` is the contact sheet used by the final chorus.

See `CREDITS.md` and `THIRD_PARTY_NOTICES.md` before redistributing a derivative.
