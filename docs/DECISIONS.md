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
