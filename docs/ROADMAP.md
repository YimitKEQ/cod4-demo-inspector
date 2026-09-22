# Roadmap

Where this is and where it is going. Phases 0, 1 and most of 4 are done; the
rest need the game installed.

## Done

**Phase 0, recon.** Every demo in the collection parsed and measured, with the
findings in `DATA-INVENTORY.md` and the format facts in `PROMOD.md`. The
upstream repo turned out to be the deployed build only, so the parser is
vendored and the two-implementation discipline was re-established at the
highlight engine instead.

**Phase 1, highlight engine and kill browser.** Aces, multikills, clutches,
openings, trades, long range, headshot streaks, collaterals and the bomb, each
scored with a clip window. Every kill filterable, sortable and one key away
from playing.

**Phase 2b, the 3D viewer**, ahead of the asset pipeline: the map is rebuilt
from position data and textured with its own minimap, so 3D works today on any
map with nothing installed. Six cameras plus the kill replay.

**Phase 4, the design pass**, pulled forward so the new views were built in the
design system rather than restyled afterwards.

**Beyond the original plan:** the coach panel. Grenade lineup detection,
opening duel and trade rates, utility discipline, route predictability and
movement technique.

## Next

**Phase 2a, real map geometry.** The reconstruction is honest but coarse. Husky
(github.com/Scobalula/Husky) reads the GfxMap out of a running CoD4 and writes
an OBJ, it supports iw3mp and iw3sp explicitly, and it ships as a library
rather than only a GUI, so a small console wrapper drives it headless. It needs
the retail executable rather than a CoD4X-patched one. OpenAssetTools handles
textures, materials, models and map entities but cannot export GfxWorld or the
clip map for any game, so it complements Husky rather than replacing it.
IW3xO's `mapexport` gives collision brushes, which is what Phase 3 needs.

Taking that route also fixes the minimap problem: no better top-down images
exist publicly than the ones already here, but an orthographic render of the
extracted mesh gives any resolution wanted.

**Phase 3, the analytics that need geometry.** Line of sight between every pair
of enemies over time, reaction time from first visible to first shot, crosshair
placement, who saw whom first, and kills through smoke. All of these need
collision geometry and none of them are guessed at in the meantime.

**Phase 5, the batch renderer.** Ticked kills to real MP4s in one pass, driven
by a d3d9 proxy that controls the clock and captures frames. Every demo here is
protocol 21, so the render folder needs CoD4X and the proxy needs CoD4X
offsets.

**Phase 6, player models and animations**, so the 3D view approaches what the
game looks like. Research first, then a feasibility report.

## Things worth doing that are not phases

- Read the bomb timer out of config string 11 so a defuse can say how close it
  came. See `DECISIONS.md` entry 3.
- Carry pitch, velocity and the animation indices into the position tracks.
  `snapshot.js` already decodes them; `buildMap` simply does not keep them.
  Pitch alone would make the first person cameras correct.
- Flash effectiveness, once pitch is available: was the victim actually looking
  into the flash, and how much warning did they have.
