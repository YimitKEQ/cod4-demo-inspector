# CoD4 Demo Inspector

Drop a CoD4 `.dm_1` demo in and actually watch the match. Every kill is one
click away, nothing renders, nothing uploads: the file is read in your browser
and never leaves the machine.

Forked from [TiPSYSPiT/cod4-demo](https://github.com/TiPSYSPiT/cod4-demo),
GPL-3.0, whose `.dm_1` parser does the hard part.

## What works now

- **3D, with the real map, on every stock map.** All 21 multiplayer maps are
  built straight from the game's own fastfiles: the exact triangles the game
  renders (mp_crash is 115,000 of them), each material's real texture, the
  baked lightmaps, every static prop in its place (3,800 on Crash), the map's
  own skybox and its own sun. Players are the game's soldier models, skinned
  and driven by the game's own animations: they stand, walk, run, sprint,
  strafe, backpedal, crouch and crawl according to what the demo says they
  were doing. Six cameras: free fly, orbit, follow (which stops at walls), the
  recorder's own eyes, another player's eyes with his real pitch (marked
  approximate) and a tactical plan view. Maps with nothing extracted fall back
  to a reconstruction built from where players walked, and say so.
- **Watch the kill.** Pick any kill and the camera frames it from the side and
  swings around the shot at half speed. One key, `R`.
- **Coach.** What the team does that an opponent can read: repeated grenade
  lineups, opening duel win rate, trade rate, utility before entry, route
  predictability and movement technique. On one real match it found 29
  repeated lineups, including a smoke thrown eleven times at 1.9 seconds into
  the round with a 0.2 second spread.
- **Moments.** A highlight engine finds aces, multikills, clutches, openings,
  trades, long range kills, headshot streaks, collaterals and the bomb, scores
  them and gives each one a clip window. 93 moments out of a 20 round match.
- **Kill browser.** Every kill as a row: round, time, killer, victim, weapon,
  headshot, distance, tags. Filter, sort, press enter and it plays instantly.
  Tick the ones worth real footage for the Phase 5 renderer.
- **Map viewport.** 2D and 3D replay with trails, aim rays, kill lines, grenade
  arcs with their real impacts, smoke volumes, heatmaps and a kill feed. Record
  what you are watching straight to a WebM.
- **An editor timeline.** Round blocks, kill ticks by team, highlight markers,
  J K L shuttle, arrow keys to step, shift to jump between kills.
- **A command line.** `node tools/cli.js demo.dm_1` for the summary and the top
  moments, with no browser involved.

Still to come: the analytics that need line of sight (the collision grid the
cameras use is the start of it), and the one pass batch renderer that turns
ticked kills into real MP4s. See `docs/ROADMAP.md`.

## Running it

No build step, no dependencies.

```
python -m http.server 8899
```

### Getting the real map into 3D

The published site already carries every stock map. To rebuild them from your
own install you need CoD4 and a patched OpenAssetTools Unlinker, which adds the
missing writer for a map's compiled world (see `tools/oat/README.md` for the
patch and the three build commands). Then:

```
set OAT_UNLINKER=<oat-src>/build/bin/Release_x86/Unlinker.exe
node tools/ffbatch.js                   every mp_*.ff, or name the maps you want
```

Player animations come from `common_mp.ff` the same way:

```
Unlinker.exe --include-assets xanim -o anims "<CoD4>/zone/english/common_mp.ff"
node tools/xanim.js anims/xanim_json maps3d/_players/anims.json
```

The older Radiant path (`tools/extract.js <map.map>`) still works for custom
maps that ship a `.map` source. Promod's `mp_backlot_x` is stock Backlot with
exploit fixes and the same coordinates, so it draws the stock build.

Open `http://127.0.0.1:8899/index.html` and drop a demo on it. Press `?` for
the keys. With no demo to hand, the empty state offers a sample match.

## Command line

```
node tools/cli.js <demo.dm_1>                  summary and top moments
node tools/cli.js <demo.dm_1> --kills          every kill as a table
node tools/cli.js <demo.dm_1> --inventory      what this demo actually carries
node tools/verify.js <folder>                  every demo through the parser
```

## The checks

Nothing is claimed to work from reading the code.

```
node tests/run.js                              62 tests
node tools/cli.js <demo> --model bundle.json
python tools/py/crosscheck.py bundle.json      JS engine against Python engine
node tools/shot.js <url> out.png               screenshot, fails on a console error
```

The highlight engine exists twice, once in JS and once in Python, and
`crosscheck.py` diffs them field by field on the same match. That is how three
real bugs were caught, including a bomb timer that was confidently wrong by
17 seconds. See `docs/DECISIONS.md`.

## Honesty

A client demo is the recorder's network view. Players the server did not send
simply do not exist in those frames, and only the recorder has exact data every
frame. The tool says so rather than papering over it:

- a player the server was not sending is drawn hollow, never as a solid dot in
  a stale place, and one with no position at all in the current life is not
  drawn
- anything derived from entity state carries an "approx" mark into the list
- a grenade impact that was extrapolated is a ring, a transmitted one is a cross
- a headshot kill does not report its weapon, so none is claimed
- the demo panel names the source of every number on screen

Measured coverage, distances, and what does not hold: `docs/DATA-INVENTORY.md`.
What the tool assumes about promod, and what it deliberately does not measure
because the format has no economy: `docs/PROMOD.md`.

## Layout

```
js/core/     parser (vendored), match model, highlight engine, map mesh,
             analysis. No DOM, no three.js, all testable headless.
js/ui/       state store, 2D and 3D viewports, cameras, kill browser,
             timeline, coach panel
js/vendor/   three.js r160, pinned, so the app works offline
tools/       cli, verify, screenshot, and the Python engine with its cross-check
tests/       runner, the synthetic match, and the engine tests
docs/        what the data holds, what promod is, what was decided, setup
maps/        minimap images placed on the world rectangle
```

Game assets and demos are never committed.

## Licence

GPL-3.0, inherited from upstream. See `LICENSE`.
