#!/usr/bin/env python3
"""highlights.py - the highlight engine, Python side.

A field for field port of js/core/highlights.js. The point of having two is
the same as the parser's: two independent implementations that must agree, so
a mistake in one shows up as a disagreement instead of as a wrong clip.

It reads the model bundle that `node tools/cli.js <demo> --model bundle.json`
writes, which carries the match and the JS engine's own answer. Run
crosscheck.py to diff the two.

  python tools/py/highlights.py bundle.json            top moments
  python tools/py/highlights.py bundle.json --json     the full list

Standard library only, like the rest of the Python side.

Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
see LICENSE. No warranty of any kind.
"""

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

# ---- tuning, mirroring CFG in highlights.js ----

CFG: Dict[str, Any] = {
    "preRollS": 4.0,
    "postRollS": 2.0,
    "maxClipS": 40.0,
    "quickWindowS": 5.0,
    "tradeWindowS": 3.0,
    "collateralWindowS": 0.15,
    "headshotStreak": 3,
    "ninjaQuietS": 10.0,
    "longRangeM": {
        "shotgun": 15, "pistol": 25, "smg": 30, "rifle": 40, "lmg": 40,
        "sniper": 55, "grenade": 25, "melee": None, "other": None,
    },
    "score": {
        "multikill": {2: 40, 3: 62, 4: 80, 5: 95},
        "ace": 98,
        "clutchWon": {1: 45, 2: 68, 3: 84, 4: 92, 5: 97},
        "clutchLostFactor": 0.45,
        "opening": 25,
        "trade": 22,
        "headshotStreak": 55,
        "collateral": 74,
        "plant": 26,
        "defuse": 45,
        "ninjaDefuse": 88,
        "longRangeMin": 38,
        "longRangeMax": 68,
    },
    "bonus": {"quickMultikill": 10, "allHeadshots": 6, "roundDecider": 5},
}

WEAPON_CLASS = {
    "sniper": ["m40a3", "remington700", "m21", "dragunov", "barrett", "m82"],
    "shotgun": ["m1014", "winchester1200"],
    "pistol": ["usp", "colt45", "beretta", "deserteagle", "deserteaglegold"],
    "smg": ["mp5", "ak74u", "uzi", "p90", "skorpion"],
    "lmg": ["m249saw", "rpd", "m60e4", "saw"],
    "rifle": ["ak47", "m16", "m4", "m14", "g3", "g36c", "mp44"],
    "grenade": ["frag_grenade", "frag_grenade_short", "grenade", "grenade_splash",
                "rpg", "projectile", "projectile_splash", "explosive", "destructible_car"],
    "melee": ["melee", "knife"],
}

MULTIKILL_NAME = {2: "Double kill", 3: "Triple kill", 4: "Quad kill"}

ATTACHMENTS = ("_silencer", "_reflex", "_acog", "_gold", "_scout", "_grip")


def weapon_base(weapon: Optional[str]) -> str:
    n = str(weapon or "")
    if n.endswith("_mp"):
        n = n[:-3]
    for tag in ATTACHMENTS:
        if n.endswith(tag):
            n = n[: -len(tag)]
            break
    return n


def weapon_class(weapon: Optional[str]) -> str:
    base = weapon_base(weapon)
    for cls, names in WEAPON_CLASS.items():
        if base in names:
            return cls
    return "other"


def clamp100(v: float) -> int:
    """Round half away from zero, the way JavaScript's Math.round does for the
    positive values this engine produces. Python's round() goes to even, which
    would silently disagree on a .5 exactly at a scoring boundary."""
    import math
    return max(0, min(100, int(math.floor(v + 0.5))))


def fixed2(v: float) -> float:
    """Match JS `+x.toFixed(2)`."""
    import math
    scaled = v * 100
    r = math.floor(abs(scaled) + 0.5) / 100
    return r if v >= 0 else -r


def fixed0(v: float) -> int:
    """Match JS `x.toFixed(0)` for display.

    Python's "%.0f" rounds half to even, so 30.5 prints as 30 while JavaScript
    prints 31. That is a one metre disagreement in a title, which the cross
    check rightly refuses to let through.
    """
    import math
    return int(math.floor(abs(v) + 0.5)) * (1 if v >= 0 else -1)


def window_for(times: List[float]) -> Dict[str, float]:
    first, last = min(times), max(times)
    return {
        "startS": fixed2(max(0.0, first - CFG["preRollS"])),
        "endS": fixed2(last + CFG["postRollS"]),
        "focusS": fixed2(last),
    }


def make_highlight(kind: str, **parts) -> Dict[str, Any]:
    h = {
        "id": "", "kind": kind, "score": 0,
        "startS": 0.0, "endS": 0.0, "focusS": 0.0,
        "round": None, "roundIdx": -1,
        "primary": None, "players": [], "killIds": [], "tags": [],
        "title": "", "detail": "", "approx": False,
    }
    h.update(parts)
    return h


class Match:
    """The bundle, wrapped so the detectors read like the JS ones."""

    def __init__(self, bundle: Dict[str, Any]):
        self.info = bundle["info"]
        self.teams = bundle["teams"]
        self.players = bundle["players"]
        self.rounds = bundle["rounds"]
        self.kills = bundle["kills"]
        self.caps = bundle["caps"]
        self.team_names = [t["name"] for t in self.teams]
        self._by_client = {p["client"]: p for p in self.players}
        self.round_states = []
        for s in bundle["roundStates"]:
            st = dict(s)
            st["kills"] = [k for k in self.kills if k["roundIdx"] == s["idx"]]
            self.round_states.append(st)

    def name_of(self, client: Optional[int]) -> str:
        p = self._by_client.get(client)
        return p["name"] if p else "client %s" % client

    def team_of(self, client: Optional[int]) -> Optional[str]:
        p = self._by_client.get(client)
        return p["team"] if p else None

    def alive_at(self, state: Dict[str, Any], team: str, t: float) -> List[int]:
        dead = {d["client"] for d in state["deaths"]
                if d["tS"] <= t and d["team"] == team}
        return [c for c in state["rosters"].get(team, []) if c not in dead]


def scoring_kills(kills: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [k for k in kills
            if not k["suicide"] and not k["teamkill"] and k["killer"] is not None]


def observe_bomb_floor(m: Match) -> Optional[float]:
    """The longest plant to resolution span, which is a floor on the bomb timer.

    Deliberately not called the timer: a round won by killing the last defender
    after a plant also reports "Bomb exploded", so the spans mean nothing on
    average. See the matching comment in js/core/highlights.js.
    """
    longest: Optional[float] = None
    for state in m.round_states:
        if not state.get("plant"):
            continue
        defuse = state.get("defuse")
        resolved = defuse["tS"] if defuse else state["endS"]
        span = resolved - state["plant"]["tS"]
        if span <= 0 or span > 120:
            continue
        if longest is None or span > longest:
            longest = span
    return None if longest is None else round(longest, 1)


# ---- detectors ----

def detect_multikills(m: Match, out: List[Dict[str, Any]]) -> None:
    for state in m.round_states:
        by_killer: Dict[int, List[Dict[str, Any]]] = {}
        for k in scoring_kills(state["kills"]):
            by_killer.setdefault(k["killer"], []).append(k)
        for client, lst in by_killer.items():
            if len(lst) < 2:
                continue
            lst.sort(key=lambda k: k["tS"])
            team = m.team_of(client)
            enemy_team = next((t for t in m.team_names if t != team), None)
            enemy_roster = state["rosters"].get(enemy_team, [])
            # An ace is killing the whole enemy team yourself. Testing that the
            # victims cover the roster is stricter than comparing counts and
            # cannot be fooled by a roster that is one short.
            victims = {k["victim"] for k in lst}
            is_ace = len(enemy_roster) > 0 and all(c in victims for c in enemy_roster)
            n = len(lst)

            times = [k["tS"] for k in lst]
            win = window_for(times)
            span = times[-1] - times[0]
            quick = span <= CFG["quickWindowS"]
            all_hs = all(k["headshot"] for k in lst)

            score = CFG["score"]["ace"] if is_ace else \
                CFG["score"]["multikill"].get(min(n, 5), CFG["score"]["multikill"][5])
            tags = ["Ace"] if is_ace else [MULTIKILL_NAME.get(n, "%dk" % n)]
            if quick:
                score += CFG["bonus"]["quickMultikill"]
                tags.append("Rapid")
            if all_hs:
                score += CFG["bonus"]["allHeadshots"]
                tags.append("All headshots")
            if m.rounds[state["idx"]]["winner"] == team:
                score += CFG["bonus"]["roundDecider"]

            # A headshot kill carries the means of death instead of the weapon
            # id, so for those the weapon is genuinely unknown.
            weapons = list(dict.fromkeys(
                k["weaponLabel"] for k in lst if not k["headshot"]))
            name = m.name_of(client)
            label = "Ace" if is_ace else MULTIKILL_NAME.get(n, "%d kills" % n)

            out.append(make_highlight(
                "multikill",
                score=clamp100(score),
                startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
                round=state["n"], roundIdx=state["idx"],
                primary=client,
                players=[client] + [k["victim"] for k in lst],
                killIds=[k["id"] for k in lst],
                tags=tags,
                title="%s by %s" % (label, name),
                detail="%d kills in round %d%s%s" % (
                    n, state["n"],
                    (" inside %.1f s" % span) if quick else "",
                    (" with %s" % ", ".join(weapons)) if weapons else ""),
                approx=any(k["distanceApprox"] for k in lst),
            ))


def detect_clutches(m: Match, out: List[Dict[str, Any]]) -> None:
    for state in m.round_states:
        for team in m.team_names:
            enemy_team = next((t for t in m.team_names if t != team), None)
            roster = state["rosters"].get(team, [])
            if len(roster) < 2:
                continue
            our_deaths = sorted([d for d in state["deaths"] if d["team"] == team],
                                key=lambda d: d["tS"])
            if len(our_deaths) < len(roster) - 1:
                continue

            clutch_start = our_deaths[len(roster) - 2]["tS"]
            survivors = m.alive_at(state, team, clutch_start)
            if len(survivors) != 1:
                continue
            client = survivors[0]

            enemies = m.alive_at(state, enemy_team, clutch_start)
            n = len(enemies)
            if n < 1:
                continue

            won = m.rounds[state["idx"]]["winner"] == team
            their_kills = [k for k in scoring_kills(state["kills"])
                           if k["killer"] == client and k["tS"] >= clutch_start]

            base = CFG["score"]["clutchWon"].get(min(n, 5), CFG["score"]["clutchWon"][5])
            score = base if won else base * CFG["score"]["clutchLostFactor"]

            times = [k["tS"] for k in their_kills] if their_kills else [clutch_start]
            win = window_for(times)
            win["startS"] = fixed2(max(0.0, clutch_start - CFG["preRollS"]))
            if won and not their_kills:
                win["endS"] = fixed2(max(win["endS"], state["endS"]))

            name = m.name_of(client)
            out.append(make_highlight(
                "clutch",
                score=clamp100(score),
                startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
                round=state["n"], roundIdx=state["idx"],
                primary=client,
                players=[client] + enemies,
                killIds=[k["id"] for k in their_kills],
                tags=["Clutch", "1v%d" % n, "Won" if won else "Lost"],
                title="%s 1v%d%s" % (name, n, "" if won else " (lost)"),
                detail="%s the 1v%d in round %d with %d kill%s" % (
                    "Won" if won else "Lost", n, state["n"], len(their_kills),
                    "" if len(their_kills) == 1 else "s"),
                approx=any(k["distanceApprox"] for k in their_kills),
            ))


def detect_openings_and_trades(m: Match, out: List[Dict[str, Any]]) -> None:
    for state in m.round_states:
        lst = sorted(scoring_kills(state["kills"]), key=lambda k: k["tS"])
        if not lst:
            continue
        first = lst[0]
        win = window_for([first["tS"]])
        out.append(make_highlight(
            "opening",
            score=CFG["score"]["opening"],
            startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
            round=state["n"], roundIdx=state["idx"],
            primary=first["killer"],
            players=[first["killer"], first["victim"]],
            killIds=[first["id"]],
            tags=["Opening"],
            title="Opening kill: %s" % first["killerName"],
            detail="%s opened round %d on %s with %s" % (
                first["killerName"], state["n"], first["victimName"], first["weaponLabel"]),
            approx=first["distanceApprox"],
        ))

        for i, a in enumerate(lst):
            for b in lst[i + 1:]:
                if b["tS"] - a["tS"] > CFG["tradeWindowS"]:
                    break
                if b["victim"] != a["killer"]:
                    continue
                if b["killerTeam"] != a["victimTeam"]:
                    continue
                win2 = window_for([a["tS"], b["tS"]])
                out.append(make_highlight(
                    "trade",
                    score=CFG["score"]["trade"],
                    startS=win2["startS"], endS=win2["endS"], focusS=win2["focusS"],
                    round=state["n"], roundIdx=state["idx"],
                    primary=b["killer"],
                    players=[b["killer"], b["victim"], a["victim"]],
                    killIds=[a["id"], b["id"]],
                    tags=["Trade"],
                    title="Trade: %s answers for %s" % (b["killerName"], a["victimName"]),
                    detail="%s traded %s back %.1f s after %s went down" % (
                        b["killerName"], a["killerName"], b["tS"] - a["tS"], a["victimName"]),
                    approx=a["distanceApprox"] or b["distanceApprox"],
                ))
                break


def detect_long_range(m: Match, out: List[Dict[str, Any]]) -> None:
    for k in scoring_kills(m.kills):
        if k["distanceM"] is None:
            continue
        threshold = CFG["longRangeM"].get(weapon_class(k["weapon"]))
        if threshold is None:
            continue
        if k["distanceM"] < threshold:
            continue
        t = min(1.0, (k["distanceM"] - threshold) / threshold)
        score = CFG["score"]["longRangeMin"] + t * (
            CFG["score"]["longRangeMax"] - CFG["score"]["longRangeMin"])
        win = window_for([k["tS"]])
        tags = ["Long range"]
        if k["headshot"]:
            tags.append("Headshot")
        out.append(make_highlight(
            "longrange",
            score=clamp100(score),
            startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
            round=k["round"], roundIdx=k["roundIdx"],
            primary=k["killer"],
            players=[k["killer"], k["victim"]],
            killIds=[k["id"]],
            tags=tags,
            title="%d m %s by %s" % (
                fixed0(k["distanceM"]), "headshot" if k["headshot"] else "kill",
                k["killerName"]),
            detail="%s killed %s at %d m with the %s (approximate, from entity positions)" % (
                k["killerName"], k["victimName"], fixed0(k["distanceM"]), k["weaponLabel"]),
            approx=True,
        ))


def detect_headshot_streaks(m: Match, out: List[Dict[str, Any]]) -> None:
    by_player: Dict[int, List[Dict[str, Any]]] = {}
    for k in scoring_kills(m.kills):
        by_player.setdefault(k["killer"], []).append(k)
    for client, lst in by_player.items():
        lst.sort(key=lambda k: k["tS"])
        run: List[Dict[str, Any]] = []

        def flush(run=run, client=client):
            if len(run) >= CFG["headshotStreak"]:
                win = window_for([k["tS"] for k in run])
                name = m.name_of(client)
                out.append(make_highlight(
                    "headshotstreak",
                    score=clamp100(CFG["score"]["headshotStreak"]
                                   + (len(run) - CFG["headshotStreak"]) * 8),
                    startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
                    round=run[0]["round"], roundIdx=run[0]["roundIdx"],
                    primary=client,
                    players=[client] + [k["victim"] for k in run],
                    killIds=[k["id"] for k in run],
                    tags=["Headshot streak", "%d in a row" % len(run)],
                    title="%d headshots in a row by %s" % (len(run), name),
                    detail="%s landed %d headshot kills back to back, rounds %s to %s" % (
                        name, len(run), run[0]["round"], run[-1]["round"]),
                    approx=any(k["distanceApprox"] for k in run),
                ))
            run.clear()

        for k in lst:
            if k["headshot"]:
                run.append(k)
            else:
                flush()
        flush()


def detect_collaterals(m: Match, out: List[Dict[str, Any]]) -> None:
    lst = sorted(scoring_kills(m.kills), key=lambda k: k["tS"])
    i = 0
    while i < len(lst):
        group = [lst[i]]
        j = i + 1
        while (j < len(lst)
               and lst[j]["killer"] == lst[i]["killer"]
               and lst[j]["weaponId"] == lst[i]["weaponId"]
               and lst[j]["tS"] - lst[i]["tS"] <= CFG["collateralWindowS"]):
            group.append(lst[j])
            j += 1
        if len(group) >= 2:
            win = window_for([k["tS"] for k in group])
            name = group[0]["killerName"]
            out.append(make_highlight(
                "collateral",
                score=clamp100(CFG["score"]["collateral"] + (len(group) - 2) * 10),
                startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
                round=group[0]["round"], roundIdx=group[0]["roundIdx"],
                primary=group[0]["killer"],
                players=[group[0]["killer"]] + [k["victim"] for k in group],
                killIds=[k["id"] for k in group],
                tags=["Collateral", "%d in one" % len(group)],
                title="Collateral by %s" % name,
                detail="%s killed %d players in the same instant with the %s" % (
                    name, len(group), group[0]["weaponLabel"]),
                approx=any(k["distanceApprox"] for k in group),
            ))
        i = j if j > i + 1 else i + 1


def detect_bomb(m: Match, out: List[Dict[str, Any]]) -> None:
    for state in m.round_states:
        plant = state.get("plant")
        if plant:
            win = window_for([plant["tS"]])
            out.append(make_highlight(
                "plant",
                score=CFG["score"]["plant"],
                startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
                round=state["n"], roundIdx=state["idx"],
                primary=None, players=[], killIds=[],
                tags=["Bomb", "Plant"],
                title="Bomb planted by %s" % (plant.get("player") or "unknown"),
                detail="Round %d: bomb down at %.1f s" % (state["n"], plant["tS"]),
                approx=False,
            ))
        d = state.get("defuse")
        if d:
            win = window_for([d["tS"]])
            defuser_team = m.rounds[state["idx"]]["winner"]
            enemy_team = next((t for t in m.team_names if t != defuser_team), None)
            enemies_alive = len(m.alive_at(state, enemy_team, d["tS"])) if enemy_team else 0
            quiet = [k for k in scoring_kills(state["kills"])
                     if d["tS"] - CFG["ninjaQuietS"] <= k["tS"] <= d["tS"]
                     and k["killerTeam"] == defuser_team]
            ninja = enemies_alive >= 1 and not quiet

            score = CFG["score"]["defuse"]
            tags = ["Bomb", "Defuse"]
            if ninja:
                score = CFG["score"]["ninjaDefuse"]
                tags.append("Ninja")

            held = round(d["tS"] - plant["tS"], 1) if plant else None
            detail = "Round %d: defused with %d enemy player%s still alive" % (
                state["n"], enemies_alive, "" if enemies_alive == 1 else "s")
            if held is not None:
                detail += ", %.1f s after the plant" % held

            out.append(make_highlight(
                "defuse",
                score=clamp100(score),
                startS=win["startS"], endS=win["endS"], focusS=win["focusS"],
                round=state["n"], roundIdx=state["idx"],
                primary=None, players=[], killIds=[],
                tags=tags,
                title="%s by %s" % ("Ninja defuse" if ninja else "Defuse",
                                    d.get("player") or "unknown"),
                detail=detail,
                approx=False,
            ))


# ---- assembly ----

def trim_window(h: Dict[str, Any]) -> Dict[str, Any]:
    if h["endS"] - h["startS"] > CFG["maxClipS"]:
        h["startS"] = fixed2(h["endS"] - CFG["maxClipS"])
    if h["startS"] < 0:
        h["startS"] = 0
    if h["focusS"] < h["startS"]:
        h["focusS"] = h["startS"]
    if h["focusS"] > h["endS"]:
        h["focusS"] = h["endS"]
    return h


def merge_overlapping(lst: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    import copy
    order = sorted(range(len(lst)),
                   key=lambda i: (-lst[i]["score"], lst[i]["startS"], i))
    kept: List[Dict[str, Any]] = []
    for i in order:
        h = lst[i]
        host = next((x for x in kept
                     if x["primary"] is not None and x["primary"] == h["primary"]
                     and x["roundIdx"] == h["roundIdx"]
                     and h["startS"] < x["endS"] and h["endS"] > x["startS"]), None)
        if host is None:
            kept.append(copy.deepcopy(h))
            continue
        host["startS"] = fixed2(min(host["startS"], h["startS"]))
        host["endS"] = fixed2(max(host["endS"], h["endS"]))
        for t in h["tags"]:
            if t not in host["tags"]:
                host["tags"].append(t)
        for kid in h["killIds"]:
            if kid not in host["killIds"]:
                host["killIds"].append(kid)
        for p in h["players"]:
            if p not in host["players"]:
                host["players"].append(p)
        host["approx"] = host["approx"] or h["approx"]
        host.setdefault("merged", []).append(h["kind"])
    return kept


def detect(bundle: Dict[str, Any], top: int = 0) -> Dict[str, Any]:
    m = Match(bundle)
    notes: List[str] = []

    if not m.caps["killFeed"]:
        notes.append("No obituary feed in this demo, so there is nothing to build highlights "
                     "from. Stats fall back to the scoreboard.")
        return {"highlights": [], "merged": [], "kills": m.kills,
                "bombFloorS": None, "notes": notes}
    if not m.caps["positions"]:
        notes.append("No position tracks in this demo: distances, long range kills and the "
                     "map view are unavailable.")

    bomb_floor = observe_bomb_floor(m)
    if bomb_floor is not None:
        notes.append("The bomb timer is not read from this demo yet, so how close a defuse "
                     "came to detonation is not shown. The longest a bomb stayed down here "
                     "was %.1f s." % bomb_floor)

    raw: List[Dict[str, Any]] = []
    detect_multikills(m, raw)
    detect_clutches(m, raw)
    detect_openings_and_trades(m, raw)
    detect_long_range(m, raw)
    detect_headshot_streaks(m, raw)
    detect_collaterals(m, raw)
    detect_bomb(m, raw)

    for h in raw:
        trim_window(h)
    raw.sort(key=lambda h: (-h["score"], h["startS"], h["kind"]))
    for i, h in enumerate(raw):
        h["id"] = "h%d" % i

    merged = [trim_window(h) for h in merge_overlapping(raw)]
    merged.sort(key=lambda h: (-h["score"], h["startS"]))

    by_kill: Dict[str, List[Dict[str, Any]]] = {}
    for h in raw:
        for kid in h["killIds"]:
            by_kill.setdefault(kid, []).append(h)
    for k in m.kills:
        hs = by_kill.get(k["id"], [])
        tags: List[str] = []
        for h in hs:
            for t in h["tags"]:
                if t not in tags:
                    tags.append(t)
        if k["headshot"] and "Headshot" not in tags:
            tags.append("Headshot")
        if k["teamkill"]:
            tags.append("Team kill")
        if k["suicide"]:
            tags.append("Suicide")
        k["tags"] = tags
        floor = 18 if k["headshot"] else 0
        if k["teamkill"] or k["suicide"]:
            floor = 0
        k["score"] = clamp100(max(floor, max((h["score"] for h in hs), default=0)))
        k["highlightIds"] = [h["id"] for h in hs]

    return {
        "highlights": raw,
        "merged": merged[:top] if top else merged,
        "kills": m.kills,
        "bombFloorS": bomb_floor,
        "notes": notes,
    }


def mmss(s: float) -> str:
    s = max(0, int(s))
    return "%d:%02d" % (s // 60, s % 60)


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="Highlight engine, Python side.")
    ap.add_argument("bundle", help="model bundle written by tools/cli.js --model")
    ap.add_argument("--json", action="store_true", help="print the full list as JSON")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args(argv)

    with open(args.bundle, "r", encoding="utf-8") as fh:
        bundle = json.load(fh)
    found = detect(bundle, top=args.top)

    if args.json:
        print(json.dumps({"merged": found["merged"], "notes": found["notes"],
                          "bombFloorS": found["bombFloorS"]}, indent=2))
        return 0

    print()
    print("  Top %d moments" % len(found["merged"]))
    print()
    for i, h in enumerate(found["merged"]):
        print("  %2d  %3d  r%-2s %6s  %5.1f s  %s%s" % (
            i + 1, h["score"], h["round"] if h["round"] is not None else "-",
            mmss(h["focusS"]), h["endS"] - h["startS"], h["title"],
            "  (approx)" if h["approx"] else ""))
    for n in found["notes"]:
        print("\n  Note: %s" % n)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
