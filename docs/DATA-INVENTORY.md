# What a CoD4 demo actually carries

Phase 0. Measured across all 35 demos in `fps_promod_285/demos` and
`fps_promod_288/demos`, not assumed. Everything later depends on this list, so
where a number is an estimate it says so.

Regenerate for any demo with:

```
node tools/cli.js <demo.dm_1> --inventory
node tools/verify.js <folder>
```

## The collection

| | |
|---|---|
| Demos | 35, all parsed without throwing |
| Protocol | 21 on every one, which is **CoD4X, not stock 1.7** |
| Mod | `mods/fps_promod_285` (26) and `mods/fps_promod_288` (9) |
| Maps | mp_backlot_x 13, mp_strike 8, mp_crash 6, mp_crossfire 5, mp_citystreets 2, mp_backlot 1 |
| Rounds | 533 |
| Kills | 4180, after 139 duplicate obituaries were removed |
| Parse time | 410 to 490 ms per demo in Node, 15 MB files |

Protocol 21 matters twice. `snapshot.js` switches to raw float world
coordinates above protocol 17, which is why positions decode at all. And the
render worker in Phase 5 needs CoD4X offsets, not stock 1.7 ones.

## Per frame, per player

A position sample is `[t, x, y, z, yaw, weaponId]`, where `t` is hundredths of
a second since the demo started.

| Field | Recorder | Everyone else |
|---|---|---|
| Position x, y, z | playerState, every frame | entity state, when the server sends them |
| Yaw | playerState viewangles | entity state angles |
| Pitch | decoded, not carried into tracks | decoded, not carried into tracks |
| Velocity | decoded, not carried into tracks | decoded, not carried into tracks |
| Weapon | yes | yes |
| Stance, lean, ADS | not carried into tracks | not carried into tracks |
| Animation indices | not carried into tracks | not carried into tracks |

`snapshot.js` decodes far more than `buildMap()` keeps. Pitch, velocity and the
legs and torso animation indices are all in the netfield tables and are simply
not copied into the tracks yet. Phase 6 needs the animation indices and Phase 2
wants pitch for the first person cameras, so `buildMap` grows then.

## How often other players drop out

This is the question Phase 2 lives or dies on. Counting every gap is
misleading, because a dead player is correctly not transmitted and the break
between rounds is not a dropout. What follows counts only the seconds a player
was alive inside a round, and asks whether they could be placed at all
(a sample no older than 2 s).

| | |
|---|---|
| Coverage while alive, median | 99% |
| Coverage while alive, 5th percentile | 93% |
| Longest unplaceable stretch while alive, median | 3.0 s |
| Longest unplaceable stretch while alive, 95th percentile | 25.0 s |

Measured over 308 player-and-demo pairs. The recorder is always 100% with no
gap, as expected: playerState is in every frame.

The conclusion for the 3D view is that other players are placeable almost all
of the time, and the remaining few per cent must be drawn as unknown rather
than guessed. The existing hollow marker idea is the right one and the viewport
already does it: a player whose last sample is older than 0.35 s is drawn
hollow, and one with no sample in the current life is not drawn at all.

The outliers are real. One player-demo pair sits at 0% and one gap runs to
98.5 s; both come from the four demos where round detection fails (below), so
the "alive" window itself is wrong there rather than the position data.

## Kills

| | |
|---|---|
| Kills with a computable distance | 96.1% |
| Dropped because a position was too stale | 162 of 4180 |
| Headshot kills | 8.9% |

At the instant of a kill the positions are far fresher than the average
suggests: p50, p75 and p90 of sample age are all 0.04 s, and 98 to 99% are
within 0.5 s. The server is sending both players because they are shooting each
other. So distance is computed only from samples fresh within 0.5 s, and the
other 4% report no distance rather than a wrong one.

**A headshot kill does not say which weapon was used.** From `MOD_OFFSET` on,
`eventParm` carries the means of death instead of the weapon id, so for a
headshot the weapon is genuinely unknown. Nothing in the UI may claim one.

**A wallbang cannot be detected from the obituary feed.** A collateral can,
because it is two victims from one shooter in the same instant. A single shot
through a wall needs collision geometry and waits for Phase 3.

## Grenades

7773 flight paths across the collection. **63% of impacts are predicted, not
transmitted**: the demo carries the flight only up to ignition, and for smokes
transmission usually stops at the throw. The prediction is ballistic and
ignores walls, so it is accurate to roughly 172 units median and 386 units at
the 90th percentile (upstream's measurement over 393 throws).

The viewport draws a predicted impact as a ring and a transmitted one as a
cross, so the two are never confused.

## What does not hold

Four of the 35 demos fail round detection, meaning more than a quarter of their
kills land outside every round:

| Demo | Kills outside a round |
|---|---|
| FPS_309126_mp_crossfire_q5En | 58 of 164 |
| Match_mp_backlot_x_AkyDzj4S | 62 of 160 |
| FPS_319499_mp_backlot_x_kmae | 8 of 17 |
| Match_mp_backlot_RZXBXSlv | 5 of 5 |

Round based moments (multikills, clutches, openings) cannot be found in those
four. Kill based ones (long range, headshot streaks, collaterals) still work.
Two further demos carry no round timer at all. Several end mid stream, which is
normal: the recording stops when the player leaves.

Three demos are named for one map and report another in the gamestate, for
example `Match_mp_strike_4qgiHeum.dm_1` reporting `mp_crash`. The gamestate is
the authority and the filename is not, so nothing reads the filename. Worth a
closer look before Phase 5 picks a map to load.

## Corrections to the upstream README

- The public repo is the deployed build only. There is no `tools/py/`, no
  `web/`, no `dist/`, no `DATEN.md`, no `FORMAT.md`, and no `verify_all.py` or
  `inventory.py`. Only `js/`, `css/`, `maps/`, `index.html` and the workflow.
- So the "two independent implementations, cross-checked field for field" is
  true of the parser only in the private source we do not have. On our side the
  JS parser is the single implementation, and the cross-check discipline has
  been re-established at the highlight engine instead (`tools/py/crosscheck.py`).
- `maps/` holds 6 images, not one per map: backlot, citystreets, crash,
  crossfire, district, strike. They cover every map in this collection once
  promod's `_x` suffix is stripped.
