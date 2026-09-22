# Decisions

Every call made without asking, and why. Newest last.

## 1. Fork rather than branch, parser vendored unchanged

The public repo is the deployed build only (see DATA-INVENTORY). The parser in
`js/` is therefore the single source of truth and is vendored into `js/core/`
untouched, so upstream's fixes still merge. `upstream` is configured as a git
remote. The generic parts (highlight engine, kill browser) can be offered back
as PRs later.

**Open question for Lodie:** ask your friend for the full private source. It
has the Python parser, `verify_all.py`, `inventory.py` and the format docs, and
having it back would restore the real parser cross-check rather than the
substitute below.

## 2. The Python engine consumes a model bundle, not a demo

The handoff asks for the highlight engine in both JS and Python, joining the
existing parser cross-check. There is no Python parser to build on, and
rewriting one to get a cross-check would be a large detour.

Instead `node tools/cli.js <demo> --model bundle.json` writes the match **and**
the JS engine's own answer into one file. `tools/py/highlights.py` recomputes
from the same match and `tools/py/crosscheck.py` diffs the two field by field,
exiting non zero on any disagreement. Two independent implementations of the
engine, checked against each other, which is the point of the discipline.

It paid for itself immediately, catching three real bugs: a mutation that
leaked tags between highlights, a rounding difference that titled the same kill
30 m and 31 m, and the bomb timer below.

## 3. No bomb timer, and no last second defuse

The first version measured the bomb timer as the median plant-to-end span of
rounds the parser labels "Bomb exploded", and returned 28.4 s for a promod
match whose timer is 45 s. The label is the problem: a round the attackers win
by killing the last defender after planting reports the same reason. Across
real demos those spans run from 0.9 s to 41.3 s, so no average of them means
anything.

Rather than ship a confident wrong number, the engine now reports only a floor
(the longest a bomb stayed down without going off) and says in the notes that
the timer is not read. Last second defuses are not detected at all.

**The proper fix**, for whoever picks this up: config string 11 carries the
round timer and, once the bomb is down, the bomb timer. `analyze()` ignores the
second value while a round is running (`RE.timer`, the `+m[1] > 0` branch).
Capturing it per round gives the exact expiry. That is a change to the vendored
parser and wants its own pass.

## 4. Distance only from fresh samples

A distance is computed only when both players have a position sample no older
than 0.5 s. Measured on real demos 98 to 99% already do, because the server is
sending both players when they are shooting each other. The 4% that do not
report no distance rather than a plausible wrong one.

## 5. Long range is worth less than winning a round

First tuning put six long range kills in the top ten of a real 20 round match
and pushed the aces and clutches out. The long range score band was moved to
38 to 68, below the multikill band. A long shot is worth seeing; it is not
worth more than a 1v3.

## 6. Ace means the whole enemy team, not five kills

Hardcoding five breaks on 4v4, on a 5v5 where someone disconnected, and on
warmup. The engine compares a player's round kills against the enemies actually
on the roster for that round.

## 7. Grease yellow only ever means selected or now

Following section 7 of the handoff strictly. The five layer toggles over the
map are "on" most of the time, and five solid accent buttons shouted over the
thing they annotate, so an active toggle takes a hairline of grease underneath
instead, matching the tab treatment. The accent stays rare and therefore stays
meaningful.

## 8. The sample match is a real feature, not a fixture leak

`tests/fixtures/synth.js` builds a match with a known quad kill, 1v3, collateral,
headshot run and ninja defuse. It is what the tests assert on, and the app
offers it from the empty state ("Open a sample match instead"). That let the
interface be judged against real pixels before any demo existed, and it stays
useful as a way to see what the tool does with nothing loaded.

## 9. Screenshots go through the DevTools protocol

Chrome's `--screenshot` needs `--virtual-time-budget` to wait for async work,
and virtual time advances on every parser yield: it exhausted the budget and
cancelled the map image request, which looked exactly like a broken asset.
`tools/shot.js` drives Chrome over CDP on real time instead and fails loudly if
the page logged a console error. Node's built in WebSocket means no
dependencies were added.

## 10. The UI states where every number came from

The demo panel names the stats source, the position source, how teams were
decided, whether the stream ended cleanly and which backdrop is drawn. Anything
derived from entity state rather than the recorder carries an "approx" chip
into the list. Fact 1 of section 3 says the UI must be honest about what the
recorder could not see; this is that, made visible rather than assumed.

## 11. CoD4X, not stock 1.7

Every one of the 35 demos is protocol 21. Stock 1.7 is protocol 6 and will not
play them back, so Phase 5's render folder needs CoD4X. Lodie has installed it.
The protocol mapping lives in one place, `MODEL.protocolLabel`, because the
render worker will need it for memory offsets too.

## 12. The highlight engine stays one file, for now

`js/core/highlights.js` is 671 lines, past the ~400 line guideline. Splitting
the detectors into their own modules would mean splitting
`tools/py/highlights.py` the same way, and the value of that pair is that they
are mirror images: a reviewer can read them side by side and the cross-check
diffs them as wholes. The file has one responsibility (find moments), the
tuning lives in a single `CFG` block, and a large share of the length is the
comments explaining why detectors refuse to guess.

Revisit when it passes roughly 800 lines or gains more than about ten
detectors, and split both languages together so the mirror holds.

`js/ui/app.js` at 416 lines is at the same edge. It owns three things: the
file, the clock and the key bindings. The kill feed overlay is the first thing
that should move out when it grows.

## 13. Real map geometry from Radiant sources, kept out of the repository

The reconstruction from player positions works on any map with nothing
installed, and it still does, but it is an inference and it looks like one.

CoD4's stock maps exist as Radiant `.map` sources: plain text, real geometry,
real material names, real texture coordinates. Infinity Ward released
mp_backlot's in the mod tools; the rest circulate in the mapping community.
`tools/mapsrc.js` turns one into `maps3d/<map>/geometry.bin`, and the 3D view
loads that in place of the reconstruction when it exists.

This beats every other route. Husky and C2M read the map out of a running
game's memory, which means launching the game and clicking a GUI, and
OpenAssetTools cannot export GfxWorld or the clip map for any title. A `.map`
source needs none of it.

Two things the parser has to get right, both of which took a wrong turn first:

- A face line holds three points and then the material. Reading the regex's
  `lastIndex` after the loop is wrong, because a line with exactly three
  points makes the next `exec` fail and a failed `exec` resets `lastIndex` to
  zero. Every material parsed as `"("`, so no caulk or clip brush was ever
  skipped, and the world bounds came out at fifty thousand units instead of
  three thousand.
- Patch winding in the source is inconsistent, so the sign of a surface
  normal says nothing about which way is up. Floors are detected by being
  horizontal, not by pointing upwards.

**The extracted geometry is gitignored and stays local.** It is Activision's
work: the map sources are derivative works under the mod tools EULA, which
permits non-commercial modding and forbids commercial distribution. The tool
ships, the output does not. That also means the published site falls back to
the reconstruction, which is the honest trade and is stated in the UI.

Still missing from the extracted maps: the `misc_model` props, about 2,700 of
them on mp_crash, which carry much of what a player would recognise. Those are
XModels inside the fastfiles and need OpenAssetTools to pull out. The world
shell and terrain are there now; the clutter is not.

## 14. The recorder's own track comes from the frame records

Merged from upstream, and it corrects something this tool had wrong.

The recording player's position in the player state is not a per frame
reading, it is an occasional server correction: across a whole match it
changes about a hundred times, because the client predicts its own movement.
Building the recorder's track from it gives a series of jumps. The MSG_FRAME
records carry the same position at client frame rate, cleanly.

After the merge the recorder's track on a real demo runs at a 0.04 s median
gap across 23,449 samples. `docs/DATA-INVENTORY.md` said the recorder was
exact and smooth before this; it was exact and jumpy.

## 15. The game's own textures and models, read directly

Two more routes opened up, both of which need nothing but the installed game.

**Textures.** `main/*.iwd` are ordinary zip archives and the `.iwi` files inside
them are a short header over DXT data. Node's zlib handles the zip, a DXT1/3/5
decoder and a small PNG writer handle the rest, so `tools/iwd.js` needs no
external tooling at all. 6,561 images indexed across the install.

Two traps. IWI stores mipmaps **smallest first**, and the four offsets after
the dimensions are the ends of each level with level zero the largest, so the
full resolution image runs from `mipOffsets[1]` to `mipOffsets[0]`, not from
the start of the data. Decoding from the start produces convincing noise.
And material names are not image names: `ch_rubble01` is stored as
`ch_rubble01_col`, `me_trash01` as `trash01_col`. The resolver tries the known
transformations in order of confidence, then a token match needing more than
half the words, and anything still unresolved is tinted from its own name
rather than given someone else's picture. 34 of mp_crash's 36 materials and 38
of mp_backlot's 42 resolve.

**Props.** The `.map` source lists every prop as a `misc_model` with an origin,
Euler angles and a scale. mp_crash has 2,433 placements of only 25 models, so
they draw as instances: one call per model whatever the count.

The models themselves are the one thing that needs OpenAssetTools, because
they live in the fastfiles. `Unlinker.exe --model-format GLB` dumps them, and
`js/ui/glb.js` reads the small part of glTF they use rather than restructuring
the app around modules to get three.js's own loader. Node transforms have to be
baked while walking the hierarchy: the palm tree carries its Z up to Y up
conversion as a rotation on its root node, so ignoring them lays it on its side.

Placement maths worth writing down. The dump is already converted from CoD's Z
up to glTF's Y up, which is a quarter turn about X; call it M. A prop's
rotation is given in CoD's frame, so the scene rotation is `M R M⁻¹` and the
position is `M` applied to the origin.

`tools/extract.js` runs geometry, textures and props in one command.

**All of it stays local.** `maps3d/` is gitignored. The tools ship, the output
does not, so the published site falls back to the reconstruction and says so.
