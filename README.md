# CoD4 Demo Inspector

Drop a CoD4 `.dm_1` demo in and actually watch the match. Every kill is one
click away, nothing renders, nothing uploads: the file is read in your browser
and never leaves the machine.

Forked from [TiPSYSPiT/cod4-demo](https://github.com/TiPSYSPiT/cod4-demo),
GPL-3.0, whose `.dm_1` parser does the hard part.

## What works now

- **Moments.** A highlight engine finds aces, multikills, clutches, openings,
  trades, long range kills, headshot streaks, collaterals and the bomb, scores
  them and gives each one a clip window. 89 moments out of a 20 round match.
- **Kill browser.** Every kill as a row: round, time, killer, victim, weapon,
  headshot, distance, tags. Filter, sort, press enter and it plays instantly.
  Tick the ones worth real footage for the Phase 5 renderer.
- **Map viewport.** 2D replay with trails, aim rays, kill lines, grenade arcs
  with their real impacts, smoke volumes and a kill feed. Record what you are
  watching straight to a WebM.
- **An editor timeline.** Round blocks, kill ticks by team, highlight markers,
  J K L shuttle, arrow keys to step, shift to jump between kills.
- **A command line.** `node tools/cli.js demo.dm_1` for the summary and the top
  moments, with no browser involved.

3D, the analytics that need collision geometry, and the one pass batch renderer
are Phases 2, 3 and 5. See `HANDOFF.md`.

## Running it

No build step, no dependencies.

```
python -m http.server 8899
```

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
node tests/run.js                              38 tests
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

## Layout

```
js/core/     parser (vendored), match model, highlight engine. No DOM.
js/ui/       state store, viewport, kill browser, timeline, panels
tools/       cli, verify, screenshot, and the Python engine with its cross-check
tests/       runner, the synthetic match, and the engine tests
docs/        what the data holds, what was decided, mods, setup
maps/        minimap images placed on the world rectangle
```

Game assets and demos are never committed.

## Licence

GPL-3.0, inherited from upstream. See `LICENSE`.
