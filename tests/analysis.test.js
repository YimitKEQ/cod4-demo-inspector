/*!
 * analysis.test.js - the coaching engine against a match whose patterns were
 * placed on purpose.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const MODEL = require("../js/core/model.js");
const AN = require("../js/core/analysis.js");
const { referenceMatch, buildMatch } = require("./fixtures/synth.js");

const build = () => MODEL.buildModel(referenceMatch());

describe("analysis: grenade attribution", () => {
  it("credits each throw to the player it left", () => {
    const m = build();
    const throws = AN.attributeGrenades(m);
    assert.ok(throws.length >= 6, "the fixture should carry grenades");
    const smokes = throws.filter(t => t.kind === "smoke");
    assert.equal(smokes.length, 4, "four smokes were placed");
    for (const s of smokes)
      assert.equal(s.throwerName, "Lodie", "every smoke in the fixture is Lodie's");
  });

  it("refuses to guess when nobody was near the throw", () => {
    const match = referenceMatch();
    /* Move the first grenade far from every player. */
    const nade = match.map.grenades[0];
    const shift = 9000;
    nade.path = nade.path.map(p => [p[0], p[1] + shift, p[2] + shift, p[3]]);
    const m = MODEL.buildModel(match);
    const th = AN.attributeGrenades(m)[0];
    assert.equal(th.thrower, null, "no thrower rather than the nearest far-away player");
  });

  it("records how far the attribution reached", () => {
    const m = build();
    for (const t of AN.attributeGrenades(m)) {
      if (t.thrower === null) continue;
      assert.ok(t.attributionDist <= AN.CFG.throwerRadius,
                "an attribution beyond the radius should not have been made");
    }
  });
});

describe("analysis: lineups", () => {
  it("finds the smoke thrown the same way four times", () => {
    const m = build();
    const a = AN.analyseMatch(m);
    const smoke = a.lineups.find(l => l.kind === "smoke");
    assert.ok(smoke, "the repeated smoke should be a lineup");
    assert.equal(smoke.uses, 4);
    assert.equal(smoke.throwers[0].client, m.players.find(p => p.name === "Lodie").client);
    assert.equal(smoke.rounds.length, 4, "used in four different rounds");
  });

  it("reports how tightly timed a lineup is", () => {
    const a = AN.analyseMatch(build());
    const smoke = a.lineups.find(l => l.kind === "smoke");
    /* Thrown at 2.8 to 3.2 s into each round, so the spread is a fraction of a second. */
    assert.close(smoke.medianRoundTS, 3.0, 0.3);
    assert.ok(smoke.spreadS <= 0.3, "a scripted throw has a small spread, got " + smoke.spreadS);
  });

  it("does not cluster frags thrown in different places", () => {
    const a = AN.analyseMatch(build());
    assert.equal(a.lineups.filter(l => l.kind === "frag").length, 0,
                 "two frags far apart are not a lineup");
  });

  it("needs repetition before calling something a pattern", () => {
    const m = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["F1", "F2"] },
      rounds: [{ winner: "A", kills: [{ t: 5, killer: "Solo", victim: "F1" }],
                 nades: [{ t: 2, by: "Solo", kind: "smoke",
                           from: [100, 100, 50], to: [800, 800, 50] }] }]
    }));
    assert.equal(AN.findLineups(AN.attributeGrenades(m)).length, 0,
                 "one throw is not a lineup");
  });
});

describe("analysis: duels", () => {
  it("counts opening wins and losses per player", () => {
    const m = build();
    const d = AN.duelStats(m);
    assert.equal(d.openings.length, m.roundStates.length, "one opening per round");
    const levitate = d.players.find(p => p.name === "Levitate");
    /* Levitate takes the opening in rounds 1, 2 and 4, and loses it in 5. */
    assert.equal(levitate.openingWins, 3);
    assert.equal(levitate.openingLosses, 1);
    assert.close(levitate.openingRate, 0.75, 0.01);
  });

  it("measures whether a death was traded", () => {
    const m = build();
    const d = AN.duelStats(m);
    /* Round 3: Tamas kills Kees, Lodie trades Tamas 1.2 s later. */
    const kees = d.players.find(p => p.name === "Kees");
    assert.ok(kees.deathsTraded >= 1, "Kees's round 3 death was traded");
  });

  it("reports how often the opening kill won the round", () => {
    const d = AN.duelStats(build());
    assert.ok(d.openingConversion >= 0 && d.openingConversion <= 1);
  });
});

describe("analysis: routes and movement", () => {
  it("declines to score a player with too few opening runs", () => {
    const m = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["F1", "F2"] },
      rounds: [{ winner: "A", kills: [{ t: 5, killer: "Solo", victim: "F1" }] }]
    }));
    const r = AN.routeStats(m).find(x => x.name === "Solo");
    assert.equal(r.score, null, "one round is not enough to judge predictability");
    assert.ok(r.why.indexOf("too few") >= 0, r.why);
  });

  it("scores predictability when there are enough runs", () => {
    const r = AN.routeStats(build()).find(x => x.runs >= 3);
    assert.ok(r, "the reference match should give somebody enough runs");
    assert.ok(r.score >= 0 && r.score <= 100, "score out of range: " + r.score);
  });

  /* The fixture walks players every two seconds, but the movement analyser
     refuses to infer speed across a gap that long, and rightly so. Real demos
     sample at 20 Hz, so these build a dense track to exercise the logic. */
  const denseTrack = (speedPerSec, opts) => {
    const o = opts || {};
    const out = [];
    const step = 0.05;
    let x = 0;
    for (let i = 0; i < 400; i++) {
      const t = i * step;
      x += speedPerSec * step;
      const z = o.jumpEvery && i % o.jumpEvery < 6
        ? 100 + Math.sin(((i % o.jumpEvery) / 6) * Math.PI) * 40
        : 100;
      out.push([Math.round(t * 100), Math.round(x), 0, Math.round(z), 0, 1]);
    }
    if (o.teleportAt) {
      for (let i = o.teleportAt; i < out.length; i++) out[i][1] += 40000;
    }
    return out;
  };

  const modelWithTrack = track => {
    const match = referenceMatch();
    match.map.tracks["0"] = track;
    return MODEL.buildModel(match);
  };

  it("never lets a teleport into the reported speeds", () => {
    const m = modelWithTrack(denseTrack(180, { teleportAt: 200 }));
    const mv = AN.movementStats(m).find(x => x.client === 0);
    assert.ok(mv.peakSpeed < AN.CFG.teleportSpeed,
              "peak of " + mv.peakSpeed + " is a respawn, not a move");
    assert.close(mv.medianSpeed, 180, 12);
  });

  it("labels a track that is too fast to be a player", () => {
    const m = modelWithTrack(denseTrack(520));
    const mv = AN.movementStats(m).find(x => x.client === 0);
    assert.equal(mv.playing, false, "520 units a second sustained is a free camera");
    assert.ok(mv.note && mv.note.indexOf("spectator") >= 0, mv.note);
  });

  it("treats an ordinary running speed as a player", () => {
    const m = modelWithTrack(denseTrack(170));
    const mv = AN.movementStats(m).find(x => x.client === 0);
    assert.equal(mv.playing, true);
    assert.equal(mv.note, null);
  });

  it("counts jumps from the rise and fall of height", () => {
    const m = modelWithTrack(denseTrack(170, { jumpEvery: 40 }));
    const mv = AN.movementStats(m).find(x => x.client === 0);
    assert.ok(mv.jumps >= 8, "ten scripted hops should register, got " + mv.jumps);
  });
});

describe("analysis: assembly", () => {
  it("produces every section and says what it could not do", () => {
    const a = AN.analyseMatch(build());
    for (const key of ["throws", "lineups", "utility", "duels", "routes", "movement", "notes"])
      assert.ok(a[key] !== undefined, "missing section: " + key);
    assert.ok(a.utility.utilityBeforeEntryRate !== undefined);
  });

  it("stays quiet rather than dividing by zero on an empty match", () => {
    const m = MODEL.buildModel(buildMatch({
      teams: { A: ["Solo", "Mate"], B: ["F1", "F2"] },
      rounds: [{ winner: "A", kills: [] }]
    }));
    const a = AN.analyseMatch(m);
    assert.equal(a.lineups.length, 0);
    assert.equal(a.duels.openings.length, 0);
    assert.equal(a.duels.openingConversion, null, "no rounds with a kill means no rate");
  });
});
