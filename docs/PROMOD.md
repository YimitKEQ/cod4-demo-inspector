# What the tool assumes about CoD4 Promod

Researched, not guessed, and flagged where it is uncertain. These facts shape
what the analysis measures and what it refuses to measure.

## Format

| | |
|---|---|
| Rounds | MR12: 12 per half, 24 regulation, first to 13, sides swap at 12 |
| Round timer | 1:45 (105 s) |
| Bomb fuse | 45 s |
| Plant / defuse | 5 s / 7 s, and there is no defuse kit, so everyone defuses at the same speed |
| Bomb sites | 2 per map |

The demos in this collection report `Match MR12` as their ruleset and score to
13, which matches. The engine default is MR10; MR12 is a league convention set
by the `mr#` server parameter.

**The bomb fuse is 45 s.** The longest a bomb was observed down across these
demos is 41.4 s, which is consistent. The tool still does not claim how close a
defuse came to detonation, because it cannot yet read the timer out of the
demo (see DECISIONS, entry 3); the 45 s figure is documented here so that work
has a number to check itself against.

## No economy

**Promod has no money, no buy rounds, no eco, nothing carried between rounds.**
Loadouts come from Create-a-Class and are identical every round. So this tool
must never grow buy-round or force-buy analysis: there is nothing there.

What replaces economic balance is a hard per team weapon class limit:

| Class | Per 5 man team |
|---|---|
| Rifles (AK-47, M16, M4, MP44, LMGs) | unlimited |
| SMGs | 2 |
| Sniper (R700, M40A3 only) | 1 |
| Shotgun | 1 |

Because the sniper slot is capped at one, that role is assignable from the
weapon pick rather than inferred from behaviour, which is not true in CS.

Sources disagree on whether perks are restricted to a short list or disabled
outright in competitive mode. Unresolved, so nothing here depends on it.
Killstreaks are off.

## Utility is scarce

**One frag plus one special grenade per life, and the special is flash or
smoke, not both.** This is why the utility analysis counts flashes and smokes
separately rather than as one pool: a player showing zero flashes chose smoke,
they did not forget.

The match analysed during development bears this out. One player threw 21
frags and 21 smokes across 20 rounds, which is exactly one of each per round.
That the grenade attribution reproduces the loadout rule it was never told
about is the strongest evidence it is attributing correctly.

Known technique that matters for later work: frags bounce predictably and are
banked around corners; cooking is standard; airburst flashes detonate in the
air to beat cover; and CoD4 shows an on-screen warning when an enemy grenade
lands nearby, so a flash is not an automatic blind and flash effectiveness has
to account for the target's reaction window.

## Map pool

mp_backlot, mp_crash, mp_crossfire, mp_strike, mp_citystreets (called District
by many players). mp_vacant and mp_overgrown appear in some seasons and on
public servers.

Variants use a `_fix` suffix, not `_x` as first assumed: `mp_backlot_fix`
exists because Backlot's lightbug needed the map recompiled rather than
patched in script. This collection contains `mp_backlot_x`, so the suffix
convention is broader than the one documented case; `mapImageName` strips any
of them.

## Movement

Strafe jumping and wall running are **legitimate, trainable technique in
promod**, not exploits. Both show up as speed above a sprint while airborne,
which is what the movement analysis looks for. Jump height is framerate
dependent because CoD4's movement code is not frame independent, which is why
promod caps FPS; sources disagree on whether the cap is 250 or 333.

Jumping does not penalise accuracy in CoD4, unlike later titles, so a jump
shot is purely about being harder to hit.

**CoD4 has no lean key.** All peeking is body movement, so position and yaw
together are a complete record of how a player peeks, with no hidden lean
state. That makes peek analysis more tractable here than in CS.

Quickscoping is not a competitive technique in promod; the single sniper slot
is used for positional picks.

## What this means for the analysis

Built, because the data supports it: opening duel win rate by player, trade
rate on death, utility before entry, grenade lineup clustering, first contact
timing and spread, opening route clustering, movement and jump technique.

Not built, deliberately:

- anything about the economy, because there is not one
- flash effectiveness, which needs the victim's view angles at detonation and
  a model of the on-screen warning; the yaw is in the tracks but the pitch is
  not carried through yet
- line of sight, map control and reaction time, which all need collision
  geometry and belong to Phase 3
- wallbang detection, which needs the same geometry

## Accuracy note on the minimap rectangle

The compass image is placed on the world rectangle from config string 823.
Promod's own `_compass.gsc` defines that rectangle from two `minimap_corner`
entities plus the worldspawn `northyaw`, meaning the minimap is aligned to
north rather than to the world axes. On the maps in this collection the
placement lines up with player positions, so any rotation is zero or already
folded into the rectangle, but a map where it does not line up would be
explained by this.
