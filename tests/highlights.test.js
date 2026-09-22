/*!
 * highlights.test.js - the highlight engine against a match whose answers are
 * known before the engine runs.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const MODEL = require("../js/core/model.js");
const HL = require("../js/core/highlights.js");
const { referenceMatch, buildMatch } = require("./fixtures/synth.js");

const build = () => MODEL.buildModel(referenceMatch());
const run = m => HL.detect(m || build());

/** Every highlight of a kind, in score order. */
const of = (res, kind) => res.highlights.filter(h => h.kind === kind);
const nameIn = (m, h) => m.nameOf(h.primary);

describe("model", () => {
  it("assigns every kill to the round it happened in", () => {
    const m = build();
    for (const k of m.kills) {
      assert.ok(k.round !== null, "kill at " + k.tS + " s landed outside every round");
      const r = m.rounds[k.roundIdx];
      assert.ok(k.tS >= r.startS && k.tS <= r.startS + r.durS + 0.3,
                "kill at " + k.tS + " s is outside round " + r.n);
    }
  });

  it("computes the distance that was written into the fixture", () => {
    const m = build();
    const k = m.kills.find(x => x.round === 3 && x.weapon === "m40a3_mp");
    assert.ok(k, "the round 3 sniper kill is missing");
    assert.close(k.distanceM, 64, 0.6, "sniper kill distance");
  });

  it("marks distances from entity state as approximate", () => {
    const m = build();
    const k = m.kills.find(x => x.distanceM !== null);
    assert.equal(k.distanceApprox, true, "distances between two non recorded players");
  });

  it("never invents a position for a player the server did not send", () => {
    const match = referenceMatch();
    delete match.map.tracks["3"];
    const m = MODEL.buildModel(match);
    const missing = m.kills.filter(k => k.killer === 3 || k.victim === 3);
    assert.ok(missing.length > 0, "fixture should still involve client 3");
    for (const k of missing) {
      const side = k.killer === 3 ? k.killerPos : k.victimPos;
      assert.equal(side, null, "an untracked player must have no position");
      assert.equal(k.distanceM, null, "no distance without both positions");
    }
  });

  it("reports what the demo can and cannot do", () => {
    const m = build();
    assert.equal(m.caps.killFeed, true);
    assert.equal(m.caps.statsSource, "killfeed");
    assert.equal(m.caps.positions, true);
  });
});

describe("highlights: multikills", () => {
  it("finds the quad kill in round 1 and calls it rapid", () => {
    const m = build();
    const res = run(m);
    const quad = of(res, "multikill").find(h => h.round === 1);
    assert.ok(quad, "no multikill in round 1");
    assert.equal(nameIn(m, quad), "Levitate");
    assert.equal(quad.killIds.length, 4, "the quad should hold four kills");
    assert.includes(quad.tags, "Quad kill");
    assert.includes(quad.tags, "Rapid", "four kills inside five seconds is rapid");
  });

  it("does not call four kills against five players an ace", () => {
    const res = run();
    const quad = of(res, "multikill").find(h => h.round === 1);
    assert.equal(quad.tags.indexOf("Ace"), -1, "an ace needs the whole enemy team");
  });

  it("scores a quad above a triple above a double", () => {
    const res = run();
    const byRound = n => of(res, "multikill").find(h => h.round === n);
    assert.ok(byRound(1).score > byRound(3).score, "quad should outscore triple");
    assert.ok(byRound(3).score > byRound(4).score, "triple should outscore double");
  });

  it("opens the clip four seconds before the first kill", () => {
    const m = build();
    const res = run(m);
    const quad = of(res, "multikill").find(h => h.round === 1);
    const first = m.kills.find(k => k.id === quad.killIds[0]);
    assert.close(quad.startS, first.tS - HL.CFG.preRollS, 0.01);
  });
});

describe("highlights: clutches", () => {
  it("finds the 1v3 Kees won in round 2", () => {
    const m = build();
    const res = run(m);
    const won = of(res, "clutch").find(h => h.round === 2 && h.tags.indexOf("Won") >= 0);
    assert.ok(won, "the won clutch in round 2 is missing");
    assert.equal(nameIn(m, won), "Kees");
    assert.includes(won.tags, "1v3");
    assert.equal(won.killIds.length, 3, "Kees took all three");
  });

  it("scores a lost clutch well below the same clutch won", () => {
    const res = run();
    const won = of(res, "clutch").find(h => h.round === 2 && h.tags.indexOf("Won") >= 0);
    const lost = of(res, "clutch").find(h => h.tags.indexOf("Lost") >= 0);
    assert.ok(lost, "a lost clutch should still be listed");
    assert.ok(lost.score < won.score, "a lost clutch cannot outscore a won one");
  });

  it("opens the window when the situation became a clutch, not at the first kill", () => {
    const m = build();
    const res = run(m);
    const won = of(res, "clutch").find(h => h.round === 2 && h.tags.indexOf("Won") >= 0);
    const first = m.kills.find(k => k.id === won.killIds[0]);
    assert.ok(won.startS < first.tS - HL.CFG.preRollS,
              "the clutch should start before its first kill");
  });
});

describe("highlights: openings and trades", () => {
  it("marks one opening kill per round that had kills", () => {
    const m = build();
    const res = run(m);
    const openings = of(res, "opening");
    assert.equal(openings.length, m.rounds.length, "one opening per round");
    for (const h of openings) {
      const kills = m.kills.filter(k => k.roundIdx === h.roundIdx && !k.suicide && !k.teamkill);
      const earliest = kills.reduce((a, b) => (a.tS <= b.tS ? a : b));
      assert.equal(h.killIds[0], earliest.id, "round " + h.round + " opening");
    }
  });

  it("finds the trade in round 3 and points it at the avenger", () => {
    const m = build();
    const res = run(m);
    const trade = of(res, "trade").find(h => h.round === 3);
    assert.ok(trade, "no trade in round 3");
    assert.equal(nameIn(m, trade), "Lodie");
    assert.equal(trade.killIds.length, 2, "a trade is the pair of kills");
  });

  it("ignores a revenge kill that came too late to be a trade", () => {
    const m = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["Foe", "Other"] },
      rounds: [{ winner: "A", kills: [
        { t: 5, killer: "Foe", victim: "Mate" },
        { t: 5 + HL.CFG.tradeWindowS + 1, killer: "Solo", victim: "Foe" }
      ] }]
    }));
    assert.equal(of(run(m), "trade").length, 0, "outside the trade window");
  });
});

describe("highlights: long range", () => {
  it("flags the 64 m sniper kill", () => {
    const res = run();
    const lr = of(res, "longrange");
    assert.equal(lr.length, 1, "exactly one long range kill in the fixture");
    assert.ok(lr[0].detail.indexOf("64 m") >= 0, "distance should be in the detail line");
  });

  it("judges distance against the weapon, not a flat number", () => {
    const shotgun = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["Foe", "Other"] },
      rounds: [{ winner: "A", kills: [
        { t: 5, killer: "Solo", victim: "Foe", weapon: "m1014", dist: 20 }
      ] }]
    }));
    const rifle = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["Foe", "Other"] },
      rounds: [{ winner: "A", kills: [
        { t: 5, killer: "Solo", victim: "Foe", weapon: "ak47", dist: 20 }
      ] }]
    }));
    assert.equal(of(run(shotgun), "longrange").length, 1, "20 m is a long way with a shotgun");
    assert.equal(of(run(rifle), "longrange").length, 0, "20 m is nothing with a rifle");
  });

  it("always marks a long range kill approximate", () => {
    const res = run();
    assert.equal(of(res, "longrange")[0].approx, true);
  });
});

describe("highlights: headshot streaks and collaterals", () => {
  it("finds the three headshots in a row in round 3", () => {
    const m = build();
    const res = run(m);
    const streaks = of(res, "headshotstreak");
    assert.equal(streaks.length, 1, "one streak in the fixture");
    assert.equal(nameIn(m, streaks[0]), "Rikko");
    assert.equal(streaks[0].killIds.length, 3);
  });

  it("breaks a streak on a body shot", () => {
    const m = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["F1", "F2", "F3", "F4"] },
      rounds: [{ winner: "A", kills: [
        { t: 5, killer: "Solo", victim: "F1", headshot: true },
        { t: 9, killer: "Solo", victim: "F2", headshot: false },
        { t: 13, killer: "Solo", victim: "F3", headshot: true }
      ] }]
    }));
    assert.equal(of(run(m), "headshotstreak").length, 0, "one body shot breaks the run");
  });

  it("finds the collateral in round 4", () => {
    const m = build();
    const res = run(m);
    const col = of(res, "collateral");
    assert.equal(col.length, 1, "one collateral in the fixture");
    assert.equal(nameIn(m, col[0]), "Levitate");
    assert.equal(col[0].killIds.length, 2);
  });

  it("does not call two separate kills a collateral", () => {
    const m = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["F1", "F2", "F3"] },
      rounds: [{ winner: "A", kills: [
        { t: 5.0, killer: "Solo", victim: "F1", weapon: "ak47" },
        { t: 5.5, killer: "Solo", victim: "F2", weapon: "ak47" }
      ] }]
    }));
    assert.equal(of(run(m), "collateral").length, 0, "half a second apart is two kills");
  });
});

describe("highlights: the bomb", () => {
  it("measures the bomb timer from the round that actually exploded", () => {
    const res = run();
    assert.close(res.bombTimerS, 45, 0.2, "plant at 30 s, round ended at 75 s");
  });

  it("stays quiet about last second defuses when no bomb ever exploded", () => {
    const match = referenceMatch();
    for (const r of match.rounds) if (r.reason === "Bomb exploded") r.reason = "Time expired";
    const res = run(MODEL.buildModel(match));
    assert.equal(res.bombTimerS, null, "with no detonation the timer is unknown");
    assert.ok(res.notes.some(n => n.indexOf("timer") >= 0), "and it says so");
    assert.ok(!res.highlights.some(h => h.tags.indexOf("Last second") >= 0),
              "no last second claim without a measured timer");
  });

  it("calls the round 4 defuse a ninja", () => {
    const res = run();
    const d = of(res, "defuse").find(h => h.round === 4);
    assert.ok(d, "no defuse in round 4");
    assert.includes(d.tags, "Ninja");
    assert.ok(d.detail.indexOf("3 enemy players still alive") >= 0, d.detail);
  });

  it("does not call it a ninja when the defusers shot their way in", () => {
    const m = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["F1", "F2"] },
      rounds: [{ winner: "A", reason: "Bomb defused", kills: [
        { t: 30, killer: "Solo", victim: "F1", weapon: "ak47" }
      ], bomb: [
        { t: 20, action: "Bomb planted", player: "F1" },
        { t: 35, action: "Bomb defused", player: "Solo" }
      ] }]
    }));
    const d = of(run(m), "defuse")[0];
    assert.ok(d, "the defuse should still be listed");
    assert.equal(d.tags.indexOf("Ninja"), -1, "killing the site first is not a ninja");
  });
});

describe("highlights: assembly", () => {
  it("gives every highlight a usable clip window", () => {
    const res = run();
    for (const h of res.highlights) {
      assert.ok(h.endS > h.startS, h.kind + " has an empty window");
      assert.ok(h.startS >= 0, h.kind + " starts before the demo does");
      assert.ok(h.focusS >= h.startS && h.focusS <= h.endS, h.kind + " focus outside its window");
      assert.ok(h.score >= 0 && h.score <= 100, h.kind + " score out of range: " + h.score);
      assert.ok(h.title.length > 0, h.kind + " has no title");
    }
  });

  it("collapses the round 4 double kill and collateral into one entry", () => {
    const m = build();
    const res = run(m);
    const r4 = res.merged.filter(h => h.roundIdx === 3 && m.nameOf(h.primary) === "Levitate");
    assert.equal(r4.length, 1, "one merged entry for Levitate in round 4");
    assert.includes(r4[0].tags, "Collateral");
    assert.includes(r4[0].tags, "Double kill");
  });

  it("sorts the merged list by score, best first", () => {
    const res = run();
    for (let i = 1; i < res.merged.length; i++)
      assert.ok(res.merged[i - 1].score >= res.merged[i].score, "merged list out of order");
  });

  it("puts the quad kill and the won clutch in the top five", () => {
    const m = build();
    const res = run(m);
    const top = res.merged.slice(0, 5);
    assert.ok(top.some(h => h.kind === "multikill" && h.round === 1), "quad missing from the top 5");
    assert.ok(top.some(h => h.kind === "clutch" && h.round === 2), "won clutch missing from the top 5");
  });

  it("tags and scores every kill for the kill browser", () => {
    const m = build();
    const res = run(m);
    for (const k of res.kills) {
      assert.ok(Array.isArray(k.tags), "kill " + k.id + " has no tags array");
      assert.ok(k.score >= 0 && k.score <= 100, "kill " + k.id + " score out of range");
    }
    const quadKill = res.kills.find(k => k.round === 1 && k.killerName === "Levitate");
    assert.includes(quadKill.tags, "Quad kill");
    assert.ok(quadKill.score > 50, "a kill inside a quad should score high");
  });

  it("says so honestly when a demo has no kill feed at all", () => {
    const match = referenceMatch();
    match.kills = [];
    match.info.killFeed = false;
    match.info.statsSource = "scoreboard";
    for (const r of match.rounds) r.timeline = r.timeline.filter(e => e.kind !== "kill");
    const res = run(MODEL.buildModel(match));
    assert.equal(res.highlights.length, 0, "no feed means no highlights");
    assert.ok(res.notes.length > 0, "and the reason is stated");
  });
});

describe("highlights: weapon classes", () => {
  it("classifies weapons through their attachments", () => {
    assert.equal(HL.weaponClass("ak47_mp"), "rifle");
    assert.equal(HL.weaponClass("m40a3_mp"), "sniper");
    assert.equal(HL.weaponClass("mp5_silencer_mp"), "smg");
    assert.equal(HL.weaponClass("m1014_mp"), "shotgun");
    assert.equal(HL.weaponClass("deserteagle_mp"), "pistol");
    assert.equal(HL.weaponClass("frag_grenade_mp"), "grenade");
    assert.equal(HL.weaponClass("something_new"), "other");
  });
});
