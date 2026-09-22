# Mods seen in the demos

Per section 8 of the handoff. The browser side (parser, highlight engine, 2D
and 3D views) needs none of these: it only reads the demo. This table is for
the Phase 5 render worker, which may need the mod's files present to play a
demo back.

| fs_game | Demos | Playback needs it | How it was obtained |
|---|---|---|---|
| `mods/fps_promod_285` | 26 | Not tested yet | Present in `fps_promod_285/` alongside the demos |
| `mods/fps_promod_288` | 9 | Not tested yet | Present in `fps_promod_288/` alongside the demos |

Both folders arrived with the demos, so nothing had to be downloaded.

## What is still unknown

Whether `iw3mp.exe` will play these demos back without the mod present. That is
the first thing the Phase 5 worker should test, because if playback works
without it, the render folder stays simpler. The demos carry `fs_game` in the
gamestate, so the worker can read which mod a demo wants:

```
node tools/cli.js <demo.dm_1> --inventory | head -1
```

## Client

Every demo is protocol 21, which is CoD4X rather than stock 1.7 (protocol 6).
The render folder therefore needs CoD4X, and the d3d9 proxy in Phase 5 needs
CoD4X memory offsets. Stock offsets are a separate case and are documented
separately if a stock demo ever turns up.

## Rules

Lodie's own game install is never touched. The render folder is a separate copy
and the worker refuses to launch pointed at an online server. No mod files are
committed to this repo.
