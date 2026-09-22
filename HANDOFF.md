# CoD4 Demo Inspector: full upgrade handoff

For Claude Code. Read all of it before writing code. Then do Phase 0 and report back before moving on.

The owner is Lodie. He wants to do as little as possible himself. His only manual job is installing CoD4 on the coding PC. Everything else (mods, map assets, tooling, config) you figure out and automate. When you truly need him, ask one short, specific question and give him the exact thing to click or paste.

---

## 1. What we are building

Drop a CoD4 demo in and actually watch the match.

- **Instant**: a kill browser where every kill in the demo is previewable in one click, no rendering, no waiting.
- **3D**: a real 3D mode of the map. Fly around freely, follow any player, sit in the recorder's first person view, see positions, sightlines and utility in space.
- **Real footage**: tick the kills you like, press one button, get real MP4 clips rendered by CoD4 itself in a single automated pass. No OBS, no screen recording, no per-kill steps.
- **Its own look**: a distinct design, grounded in CoD4's world, not a generic dashboard.

## 2. What already exists

Base repo, a friend's project (GPL-3.0): https://github.com/TiPSYSPiT/cod4-demo
Live build: https://tipsyspit.github.io/cod4-demo/

Per its README:

- Full `.dm_1` parser in two independent implementations (browser JS, and Python standard library only) that are cross-checked field for field.
- Snapshot decoding (delta entities, player state, client state) following Iswenzz/CoD4-DM1.
- Web UI with header score and match info box, players tables, round by round, kills per round matrix, chat, events, raw command stream plus JSON.
- 2D map replay: timeline, round picker, 0.5x to 4x, dots with facing, name and weapon, hollow marker for players not currently sent, trails, heatmaps, kill lines, grenade flight paths with computed impact, user callouts saved per map, per player analysis (opening routes, hotspots, death spots, distances, predictability).
- CLI `tools/py/dm1.py` with `--json`, `--tracks`, `--report`, `--raw`, `--selftest`.
- `verify_all.py`: Huffman stream integrity, section completeness, kill feed vs scoreboard agreement.
- Map images in `web/maps/` placed on the world rectangle, generated floor plan fallback.
- No third party libraries in the web UI.

**Repo caveat.** The public repo root only shows `.github/workflows`, `css`, `js`, `maps`, `LICENSE`, `README.md`, `index.html`. The README describes `tools/py/`, `tools/*.pl`, `web/`, `dist/`, `DATEN.md`, `FORMAT.md`. The public repo may just be the deployed build. Verify first. If the Python tools and docs are missing, tell Lodie in one line to ask the friend for the full source. Do not rewrite the parser if it can be obtained. If it truly cannot, the JS parser in `js/` is the fallback source of truth.

Plan to fork it into our own repo. Offer the generic improvements (highlight engine, kill browser) back to the friend as PRs later.

## 3. Hard facts about the data (design around these)

1. A client demo is the recorder's network view. Players the server did not send to that client simply do not exist in those frames. The UI must show this honestly (the existing hollow marker idea), never invent positions silently.
2. Only the recorder has exact first person data every frame (playerState origin and view angles). Other players come from entity state: position, angles, weapon, animation indices, less precise.
3. Positions include height (z). Use it. Stairs, rooftops, windows, jump spots all become visible in 3D.
4. Entity state carries legs and torso animation indices. That is enough to drive real player animations later (see Phase 6).
5. Real in-game footage requires the game to render it. Everything else in this document runs without the game at view time.
6. Stock 1.7 and CoD4X differ in protocol. The inspector already reads the protocol version; use it everywhere that matters (renderer, memory offsets).

## 4. Architecture

```
 browser app (single page, runs locally or from GitHub Pages)
   parser (existing JS)  ->  match model  ->  highlight engine
                                         ->  2D map view
                                         ->  3D map view  <- map assets (glTF + collision), loaded from a local folder
                                         ->  kill browser  -> "render selected" -> render worker (localhost)

 render worker (Python, coding PC)
   job queue -> prepares game folder, mods, demo -> launches iw3mp.exe once per demo
             -> d3d9 proxy DLL inside the game does clock control + frame capture -> ffmpeg (GPU encode) -> MP4s

 asset pipeline (Python, coding PC, run once per map)
   installed CoD4 -> extract map render mesh + collision + textures -> glTF + collision file + minimap image
```

Keep the parser and match model free of UI code so the CLI, the browser and the worker share one understanding of a match. The highlight engine lives in both JS and Python and joins the existing cross-check.

## 5. Phases

Each phase ends with a short report to Lodie: what works, a screenshot or clip, what is next. Keep reports plain and short.

### Phase 0: recon (no new features)

- Clone, find or obtain the full source, run `verify_all.py` on Lodie's demos.
- Build the single file bundle, run the UI locally.
- Run the existing `inventory.py` on several demos and write `docs/DATA-INVENTORY.md`: which fields exist per frame for the recorder and for other players (origin, angles, velocity, weapon, animation indices, fire events, damage events, sounds, stance, lean, ADS), and how often other players drop out of snapshots. Everything later depends on this list.
- Read `fs_game` and map name from the gamestate of each demo. Record which demos are promod (see section 8).
- Write down anything in the README that turned out untrue.

### Phase 1: highlight engine and kill browser (no game needed)

Highlight engine, from kill feed plus round state:
- multikills in a round (2k to ace) and quick multikills (N kills within X seconds)
- clutches (last alive vs N, win or lose)
- opening kills and trade kills (killer dies within ~3 s)
- long range kills per weapon, headshot streaks, wallbangs or collaterals where detectable
- bomb plant, defuse, ninja defuse, last second defuse
- each highlight gets a score, a start and end window, involved players, tags

Kill browser, a new main view:
- every kill as a row or tile: round, time, killer, victim, weapon, headshot, distance, tags
- filters by player, weapon, round, tag; sort by highlight score
- one click plays it in the map view (2D now, 3D after Phase 2) starting ~4 s before, following the killer, slowing to 0.5x across the kill, stopping ~2 s after
- checkbox per kill plus "select all highlights" feeding the render queue (Phase 5)
- keyboard: up/down to move, enter to play, x to tick

2D upgrades:
- short aim ray per player along facing
- shot markers if fire events exist (check the inventory), killfeed overlay during playback
- export the current clip from the 2D view as WebM via `MediaRecorder` on the canvas

Acceptance: from a fresh demo, the ten best moments are listed and each plays in under a second after clicking.

### Phase 2: 3D mode

#### 2a. Map assets (run once per map, automated)

Lodie installs CoD4 on the coding PC. You build `tools/assets/extract_map.py` that turns an installed map into:
- `maps3d/<map>/render.glb`: the visual mesh with textures (downscale textures, target a few MB per map)
- `maps3d/<map>/collision.bin`: collision geometry for line of sight tests (the clip map is simpler and better for raycasts than the render mesh)
- `maps3d/<map>/meta.json`: bounds, spawn points, bomb sites, a generated top down image for the 2D view

Research the extraction route and pick the most scriptable one. Candidates to evaluate:
- OpenAssetTools (supports IW3 fastfiles; check how far it goes with gfx world and clip map)
- Husky by Scobalula (exports map geometry from game memory while the map is loaded)
- other community IW3 map exporters
- as a last resort, dump world geometry from draw calls using the d3d9 proxy DLL from Phase 5

If a tool is GUI only, automate it or pick another; Lodie will not click through exports. Load maps for memory based tools by launching a local offline server (`+devmap <map>`) from the script.

Priority maps, in order: mp_crash, mp_crossfire, mp_backlot, mp_strike, mp_citystreets (the competitive pool), then mp_vacant, mp_showdown, mp_bog, mp_overgrown, mp_pipeline, then the rest of stock. Custom maps later, from `usermaps`.

Game assets never go in a public repo. The app loads them from a local folder, with a clear empty state if a map's assets are missing ("No 3D data for mp_crash yet. Run the asset tool on the PC with CoD4 installed.").

**No-assets fallback (works for any map, zero extraction):** build a 3D point cloud from every position any player ever stood on across all loaded demos for that map, voxelize, and extrude a rough walkable surface. Ugly but spatially honest, and it means 3D mode always opens.

**Alignment check:** an automated test drops recorded spawn positions and known standing spots onto the mesh and fails if players float or sink.

#### 2b. 3D viewer

three.js is allowed here, pinned version, vendored locally so the app still works offline. Keep it isolated in the 3D module so the rest keeps the no dependency rule.

Cameras, switchable with number keys:
1. free fly: WASD, mouse look, Q/E down/up, shift faster, like spectator noclip
2. orbit around a point or player
3. follow cam behind any player, smoothed
4. first person of the recorder from playerState (the closest thing to real footage without the game)
5. approximate first person of any other player from entity angles, clearly marked as approximate
6. tactical top down with slight tilt, orthographic, which doubles as the upgraded 2D view

Rendering of the match:
- players as simple, readable models or capsules in team color, name and weapon tags that stay legible, hollow or ghosted when not currently sent
- interpolation between snapshots, never teleporting
- view cones in 3D, aim rays
- kill moment: line from killer eye height to victim, marker at the hit spot, headshot distinction
- grenades with full arcs, smoke rendered as a volume for its real duration, flash radius shown
- time scrubbing identical to the 2D timeline, shared state between 2D and 3D so switching keeps time and selected player

Out of the box features (build in this order, each is small once the viewer exists):
- **Ghost trails**: every position of a player over a round as a fading 3D ribbon, so a whole round reads in one glance
- **Round overlay**: pick two rounds, play them at the same time as ghosts, compare how the same player approached a site
- **Killer and victim split view**: at any kill, split screen of both points of view side by side
- **X-ray toggle**: walls translucent to see positions through geometry
- **Height heatmap**: heatmap draped on the actual floors, stacked per level, not flattened
- **Camera bookmarks and shareable links**: URL encodes demo hash, time, camera mode and position, so Lodie can send "look at this" moments to friends who have the same demo
- **Director mode**: auto camera that cuts between the most relevant players during a round, based on the highlight engine, like a broadcast observer

Acceptance: open a demo on mp_crash, press 3, fly anywhere smoothly at 60 fps on the coding PC, scrub to any kill and see it from four angles.

### Phase 3: analytics that only exist with 3D

Uses the collision geometry for raycasts.

- **Line of sight timeline**: for every pair of enemies, when could they see each other. Draw it as a band under the timeline.
- **Reaction time estimate**: time from enemy first visible (in FOV and in line of sight) to the kill or first shot. Label it an estimate.
- **Crosshair placement**: angle between the killer's aim and the victim's head at the moment the victim became visible. Per player average, best and worst.
- **Who saw whom first**: for each duel, who had first sight and whether that won the duel.
- **Through smoke**: flag kills where the line of sight passed through an active smoke volume.

Show these per kill in the kill browser and per player in the analysis panel. Mark everything computed from entity state (not the recorder) as approximate.

### Phase 4: design overhaul

See section 7. Do this as its own pass after Phase 2 has a working 3D view, so the design is made for the real product, not a mock. Refactor the existing UI to the new system; do not bolt new styles next to old ones.

### Phase 5: one pass batch renderer (real footage, no OBS)

Goal: select 20 kills, press render, walk away, come back to 20 MP4s and optionally one highlight reel.

Workflow:
1. Kill browser sends selected windows to the local worker (`localhost`, simple HTTP). The worker can also be driven from the CLI: `py tools/render.py DEMO --top 10`.
2. Worker prepares a dedicated render folder of CoD4 (see safety), places the demo, ensures the right mod is present (section 8), writes a job file.
3. Worker launches `iw3mp.exe` once with `+demo <name>` and the HUD, fov and quality cvars for the job.
4. A `d3d9.dll` proxy (same mechanism ReShade uses) inside the game:
   - reads the demo's current server time from client memory each frame (find `cl.snap.serverTime` or equivalent per client version; document offsets for stock 1.7 and CoD4X separately)
   - fast forwards between windows with a high `timescale` and drops to normal speed before each window, issuing commands through the game's command buffer
   - inside a window forces a fixed frame time so output is exactly 60 fps no matter how fast the GPU is; CoD4 renders far faster than 60 fps on modern hardware, so capture runs faster than real time
   - optional slow motion around the kill moment, keeping fixed 60 fps output
   - hooks `Present`, copies the backbuffer, pipes raw frames into an ffmpeg child process with GPU encoding (NVENC, AMF or QSV, fallback x264)
   - writes a done file with results and exits the game when the job is complete
5. Worker names clips like `r07_levitate_3k_ak47.mp4`, writes a JSON sidecar per clip, optionally stitches a reel with short crossfades and a small name and weapon lower third.

Camera in real footage is the recorder's view by default. If you find a reliable way to render other players' views or a free cam during playback (research IW3MVM and similar movie mods, and whether the proxy DLL can drive the camera), add it as an option, keeping fact 1 of section 3 in mind.

Safety: the DLL only ever runs in a separate CoD4 folder used for rendering. The worker refuses to launch if the game is pointed at an online server. Never touch the install Lodie plays on. State this clearly in the README.

Acceptance: 20 selected kills from one demo become 20 frame perfect MP4s with zero interaction, total time dominated by one fast forward pass.

Fallback if the DLL route fails: `cl_avidemo` frame dumps plus ffmpeg, driven by a demo cutter built on the existing parser (write gamestate plus a full non delta snapshot at the cut point, then following messages) so each clip starts near its window. OBS is the last resort only.

### Phase 6: moonshot (only after everything above works)

With player models, xanims and textures extracted like the maps, drive real player animations in the 3D view from the entity state animation indices. The goal is 3D mode looking close to the actual game, no game needed to watch. Treat as research; report feasibility before building.

## 6. Machine setup

- **Coding PC**: CoD4 gets installed by Lodie. That is his only job. You handle finding the install path (ask him once if it is not in the usual places), creating the separate render folder, mods, asset extraction, the worker, ffmpeg, and any build tools. Provide one setup script that does all of it and prints what it did.
- **Gaming PC**: not needed. Keep the worker portable (paths and GPU encoder in a config file) so it could run there later with only a config change.
- Everything the browser app needs runs locally; GitHub Pages hosting stays possible for the non 3D parts.

## 7. Design system

The current UI is functional. The new one should feel like it belongs to CoD4, not like a template. Rules below are firm.

### Direction: the briefing table

Ground it in CoD4's own world: a 2007 SAS and Marines operation briefing. Laminated field maps, grease pencil marks on acetate, olive drab kit, stenciled crate markings, radio traffic logs. The tool is where the team gathers around the table after the match.

Spend the boldness in one place: **the map viewport** (2D and 3D). It is always the largest thing on screen. Annotations on it (kill lines, trails, callouts, selections) look like grease pencil on acetate: slightly thick strokes with rounded caps, a faint texture, crisp at any zoom. Everything around the map is quiet, disciplined and dense.

### Palette

| Name          | Hex       | Use |
|---------------|-----------|-----|
| Field slate   | `#2F352C` | app background, olive tinted dark, never pure or tinted black |
| Canvas drab   | `#3D4436` | panels, raised surfaces |
| Webbing       | `#56604D` | borders, dividers, inactive controls |
| Bone          | `#E4DFCF` | primary text |
| Grease yellow | `#E3B538` | selection, focus, current time, the one accent |
| Allies blue   | `#7FA3BF` | Marines/SAS team color |
| OpFor red     | `#C4473A` | OpFor/Spetsnaz team color |

Team colors are only for teams. Grease yellow is only for "this is selected or happening now". Nothing else gets color. No gradients, no glow, no glass, no drop shadows as decoration. Elevation comes from the drab vs slate step.

Provide a light variant later for printing and screenshots (map on pale acetate grey, not cream).

### Type

- **Barlow Condensed** for UI, headings, tables and numbers (condensed suits dense stat tables and military signage). Tabular figures everywhere numbers line up.
- **Barlow** (same family, normal width) for longer text like the analysis explanations.
- Self host the font files so the app works offline.
- Sentence case everywhere. No all caps eyebrow labels, no letter spaced labels, no monospace for small data labels, no single highlighted word in headings.
- Clear scale: 13 / 15 / 18 / 24 / 32 px. Headings earn their size by importance, not by habit.

### Layout

Map first, like a video editor built around a viewport.

```
+----------------------------------------------------------------+
| score A 10 : 8 B   mp_crash  S&D  promod  recorded by Levitate  |
+------------------------------------------------+---------------+
|                                                | kill browser  |
|                                                | or player     |
|            map viewport (2D or 3D)             | panel,        |
|                                                | switchable    |
|                                                |               |
+------------------------------------------------+---------------+
| timeline: round blocks, kill ticks, highlight markers, LOS band |
+----------------------------------------------------------------+
```

- The timeline is a real editor timeline: round blocks labeled by number, kill ticks colored by team, highlight markers, playhead in grease yellow, J K L shuttle, space play, arrow keys step one snapshot, shift arrows jump to next kill.
- Stats, rounds, chat, events and raw data move into the side panel or a secondary view. They stay, they just stop competing with the map.
- Left aligned text, dense but breathable, 8 px base spacing grid.
- Border radius small and only where it signals interactivity (buttons, chips). Panels are square edged, like kit.
- Icons, if any, are simple line icons drawn for this app (weapon silhouettes for the kill feed are a good exception worth doing well). No emoji.

### Motion and feel

- Motion only in response to Lodie's actions: switching camera, jumping to a kill, opening a panel. Camera moves ease like a smooth observer, never snap.
- No entrance animations, no hover effects on every element.
- Keyboard first. Every main action has a shortcut; `?` shows them.

### Copy

- Plain words from a player's point of view: "Play kill", "Render selected", "Follow player". The button name and the result name match ("Render selected" produces "Rendered 12 clips").
- Errors say what happened and what to do, no apologies. Empty states tell you the next action.
- No filler text, no marketing lines, no "Welcome to".

### Anti-slop checklist (review every screen against this)

- no purple or blue gradients, no glassmorphism, no glow
- no identical rounded cards with soft grey shadows
- no ALL CAPS labels, no `A · B · C` meta strings, no `→` on buttons
- no em dashes in UI copy
- no big number plus tiny label hero blocks unless the number is truly the point (the score is)
- nothing that would look the same on any other product; if a screen could belong to a SaaS dashboard, redo it

Take screenshots of each screen during Phase 4 and critique them against this section before calling it done.

## 8. Promod and other mods

Lodie does not want to install promod himself. Handle it:

- The browser parser, highlight engine, 2D and 3D views do not need promod at all. They only read the demo.
- The real footage renderer might. Read `fs_game` from each demo's gamestate. If it points at a mod (for example `mods/pml220` or a promod live folder), check whether the render folder has it. If playback works without it, prefer that. If it needs the mod's files, have the setup script fetch the official promod release into the render folder's `mods` directory automatically and report which version it used. Never modify Lodie's own game install.
- Keep a small table in `docs/MODS.md` of which mods were seen, whether playback needed them, and how they were obtained.

## 9. Working rules

- Keep JS and Python in agreement. Extend the existing cross-check to the highlight engine and any new analysis fields.
- Run `verify_all.py` after any parser change. Add tests for the highlight engine with Lodie's demos as fixtures.
- Performance: parse a full match demo in a few seconds in the browser, 3D view at 60 fps on the coding PC, 2D view fine on a laptop.
- GPL-3.0 stays. Game assets never committed.
- Small commits, each phase on its own branch, short report at the end of each phase.
- No em dashes in docs or UI copy (Lodie's preference).

## 10. The only questions for Lodie

Ask these once, at the start, all together:
1. Can you get the full source (Python tools and docs) from your friend if it is not in the repo?
2. Where did you install CoD4 on the coding PC, and which version or client (stock 1.7 or CoD4X)?
3. Drop 3 to 5 demos into `demos/`, ideally one with a clear multikill.

Everything else, decide yourself and note the decision in `docs/DECISIONS.md`.
