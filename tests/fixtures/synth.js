/*!
 * synth.js - synthetic matches in the exact shape analyze() returns.
 *
 * Real demos are the fixtures that matter, and they arrive later. Until then
 * the highlight engine is tested against matches built by hand, where the
 * right answer is known before the engine runs: this round holds a quad kill,
 * that one a 1v3 won, this defuse is a ninja.
 *
 * The builder also lays down position tracks so distances and long range
 * detection are exercised rather than skipped.
 *
 * It doubles as the sample match the app offers when no demo is loaded yet,
 * so the interface can be opened and judged before any real demo exists.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const UNITS_PER_METRE = 39.3701;

/** Weapon list as config string 2258 would give it, 1 based ids. */
const WEAPONS = [
  "defaultweapon_mp", "ak47_mp", "m16_mp", "m4_mp", "mp5_mp", "ak74u_mp",
  "m1014_mp", "m40a3_mp", "usp_mp", "deserteagle_mp", "frag_grenade_mp",
  "smoke_grenade_mp", "flash_grenade_mp"
];
const WEAPON_LABEL = {
  ak47: "AK-47", m16: "M16", m4: "M4", mp5: "MP5", ak74u: "AK-74u",
  m1014: "M1014", m40a3: "M40A3", usp: "USP", deserteagle: "Desert Eagle",
  frag_grenade: "Frag Grenade", headshot: "Headshot", melee: "Knife"
};
const MOD_OFFSET = 128;
const MEANS_OF_DEATH = [
  "unknown", "pistol_bullet", "rifle_bullet", "grenade", "grenade_splash",
  "projectile", "projectile_splash", "melee", "headshot", "crush",
  "telefrag", "falling", "suicide", "trigger_hurt", "explosive"
];

function prettyWeapon(name){
  const n = name.replace(/_mp$/, "");
  return WEAPON_LABEL[n] || n.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Build a match.
 *
 * spec = {
 *   map, mod, povClient,
 *   teams: { A: ["name", ...], B: [...] },
 *   rounds: [{ winner: "A"|"B", reason, kills: [...], bomb: [...] }]
 * }
 * A kill is { t, killer, victim, weapon, headshot, dist } where t is seconds
 * into the round, killer/victim are player names and dist is in metres.
 */
function buildMatch(spec){
  const teamNames = Object.keys(spec.teams);
  const players = [];
  const clientOf = new Map();
  let client = 0;
  for (const t of teamNames) {
    for (const nm of spec.teams[t]) {
      clientOf.set(nm, client);
      players.push({
        client, name: nm, team: t,
        kills: 0, deaths: 0, assists: 0, score: 0, ping: 40,
        hasStats: true, joinedS: null, leftS: null
      });
      client++;
    }
  }

  const ROUND_GAP = 12;      // seconds of buy/warmup between rounds
  const ROUND_LEN = 105;     // a full S&D round

  const kills = [];
  const grenades = [];
  const rounds = [];
  const tracks = {};
  const wins = {}; for (const t of teamNames) wins[t] = 0;

  /* Every player gets a slow baseline walk so a position always exists, then
     kill specific samples are laid on top at the exact kill instant. */
  const pushSample = (cl, tS, x, y, z, yaw, weaponId) => {
    const key = String(cl);
    if (!tracks[key]) tracks[key] = [];
    tracks[key].push([Math.round(tS * 100), Math.round(x), Math.round(y),
                      Math.round(z), Math.round(yaw), weaponId || 1]);
  };

  let cursor = 10;
  spec.rounds.forEach((rspec, ri) => {
    const startS = cursor;
    const roundKills = (rspec.kills || []).slice().sort((a, b) => a.t - b.t);
    const timeline = [];

    /* Baseline walk.
     *
     * Sampled at 20 Hz like a real demo, and shaped so the ten players between
     * them cover an area rather than a diagonal line. Each player loops around
     * their own part of the map at a plausible running speed, with a height
     * step for half of them so the reconstruction has two floors to find. The
     * sample match is what a first time visitor sees, so it has to look like a
     * match rather than a test artefact. */
    const STEP = 0.05;
    for (const p of players) {
      const lane = p.client;
      /* Each player owns a lap of a different size and phase. */
      const radius = 520 + (lane % 5) * 260;
      const cx = (lane < 5 ? -420 : 520);
      const cy = -160 + ((lane % 5) - 2) * 190;
      const phase = (lane * 2.1) % (Math.PI * 2);
      const upper = lane % 2 === 1;
      for (let t = 0; t <= ROUND_LEN; t += STEP) {
        /* About 190 units a second along the lap, which is a CoD4 run. */
        const a = phase + (t * 190) / radius;
        const wobble = Math.sin(a * 3.1) * 70;
        const x = cx + Math.cos(a) * (radius + wobble);
        const y = cy + Math.sin(a) * (radius * 0.72 + wobble);
        const z = 100 + (upper ? 128 : 0) + Math.sin(a * 2) * 8;
        pushSample(p.client, startS + t, x, y, z,
                   ((-a * 180) / Math.PI + 90) % 360, 1);
      }
    }

    for (const k of roundKills) {
      const tS = +(startS + k.t).toFixed(2);
      const killerCl = k.killer === null ? 1022 : clientOf.get(k.killer);
      const victimCl = clientOf.get(k.victim);
      if (victimCl === undefined) throw new Error("unknown victim " + k.victim);
      if (k.killer !== null && killerCl === undefined) throw new Error("unknown killer " + k.killer);

      const base = k.weapon || "ak47";
      const headshot = !!k.headshot;
      const wIdx = WEAPONS.indexOf(base + "_mp");
      let weaponId, weaponName;
      if (headshot) {
        weaponId = MOD_OFFSET + MEANS_OF_DEATH.indexOf("headshot");
        weaponName = "headshot";
      } else if (wIdx >= 0) {
        weaponId = wIdx + 1;
        weaponName = WEAPONS[wIdx];
      } else {
        weaponId = MOD_OFFSET + Math.max(0, MEANS_OF_DEATH.indexOf(base));
        weaponName = base;
      }

      /* Place the pair at the requested distance along the x axis so the
         computed metres come back out the far end. */
      const dist = (k.dist === undefined ? 12 : k.dist) * UNITS_PER_METRE;
      const kx = 1000, ky = 1000 + victimCl * 5;
      pushSample(killerCl, tS, kx, ky, 100, 0, weaponId > MOD_OFFSET ? 1 : weaponId);
      pushSample(victimCl, tS, kx + dist, ky, 100, 180, 1);

      const rec = {
        tS, killer: killerCl, victim: victimCl,
        weaponId, weapon: weaponName, weaponLabel: prettyWeapon(weaponName),
        headshot,
        suicide: k.killer === null || killerCl === victimCl
      };
      kills.push(rec);
      timeline.push(Object.assign({ tS, kind: "kill" }, rec));
    }

    /* Grenades. A throw is { t, by, kind, from, to } where from and to are
       [x, y, z] in world units. The thrower is placed at the origin at the
       throw instant so the attribution in analysis.js has something to find,
       which is exactly how a real demo behaves. */
    for (const nade of (rspec.nades || [])) {
      const tS = +(startS + nade.t).toFixed(2);
      const cl = clientOf.get(nade.by);
      if (cl === undefined) throw new Error("unknown thrower " + nade.by);
      const from = nade.from, to = nade.to;
      pushSample(cl, tS, from[0], from[1], from[2], 0, 1);
      const path = [];
      const STEPS = 8;
      for (let i = 0; i <= STEPS; i++) {
        const f = i / STEPS;
        path.push([Math.round((tS + f * 1.2) * 100),
                   Math.round(from[0] + (to[0] - from[0]) * f),
                   Math.round(from[1] + (to[1] - from[1]) * f),
                   Math.round(from[2] + (to[2] - from[2]) * f + Math.sin(f * Math.PI) * 120)]);
      }
      grenades.push({
        kind: nade.kind || "frag",
        weapon: (nade.kind || "frag") === "smoke" ? "Smoke Grenade"
              : (nade.kind || "frag") === "flash" ? "Flashbang" : "Frag Grenade",
        path,
        impact: [Math.round(to[0]), Math.round(to[1]), Math.round(to[2])],
        impactS: Math.round((tS + 1.2) * 100),
        predicted: !!nade.predicted
      });
    }

    for (const b of (rspec.bomb || [])) {
      timeline.push({ tS: +(startS + b.t).toFixed(2), kind: "bomb",
                      action: b.action, player: b.player });
    }
    timeline.sort((a, b) => a.tS - b.tS);

    const durS = rspec.durS !== undefined ? rspec.durS : ROUND_LEN;
    wins[rspec.winner]++;
    rounds.push({
      n: ri + 1, half: ri < spec.rounds.length / 2 ? 1 : 2,
      startS, durS,
      winner: rspec.winner, reason: rspec.reason || "Time expired",
      score: teamNames.map(t => wins[t]).join(":"),
      exact: true,
      bomb: (rspec.bomb || []).map(b => "MP_EXPLOSIVES_" +
              (/planted/i.test(b.action) ? "PLANTED" : "DEFUSED") + "_BY" + b.player).join("; "),
      timeline, kills: {}, deaths: {}
    });
    cursor = startS + durS + ROUND_GAP;
  });

  /* Tracks must be sorted by time and free of duplicate timestamps, the same
     invariant buildMap() guarantees for real demos. Kill time samples are
     pushed after the baseline walk, so when both land on the same hundredth
     of a second the kill sample is the one that survives: it is the position
     the test is actually asserting on. */
  for (const key of Object.keys(tracks)) {
    const byTime = new Map();
    for (const s of tracks[key]) byTime.set(s[0], s);
    tracks[key] = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  }

  /* Kill and death totals, counted the way the parser counts them. */
  const teamOf = new Map(players.map(p => [p.client, p.team]));
  for (const k of kills) {
    const v = players.find(p => p.client === k.victim);
    if (v) v.deaths++;
    if (!k.suicide && teamOf.get(k.killer) !== teamOf.get(k.victim)) {
      const a = players.find(p => p.client === k.killer);
      if (a) a.kills++;
    }
  }

  return {
    info: {
      server: "Synthetic test server", map: spec.map || "mp_crash",
      gametype: "sd", mod: spec.mod || "", ruleset: "Promod LIVE",
      hud: "", mapStart: "", version: "1.7",
      factions: ["SAS", "Spetsnaz"], protocol: 6, scorelimit: 13,
      povClient: spec.povClient === undefined ? 0 : spec.povClient,
      povName: players[spec.povClient === undefined ? 0 : spec.povClient].name,
      durationS: Math.round(cursor),
      snapshots: 5000, frames: 5000, commands: 2000, configstrings: 900,
      cleanEof: true, sizeBytes: 4000000, taggedTeams: true,
      killFeed: kills.length > 0,
      statsSource: kills.length ? "killfeed" : "scoreboard",
      scoreboardStale: false, obituaries: kills.length, duplicateObituaries: 0
    },
    teams: teamNames.map(t => ({ name: t, wins: wins[t], halves: [wins[t], 0] })),
    players,
    rounds,
    chat: [],
    kills,
    events: [],
    knifeS: null,
    map: {
      compass: "compass_map_" + (spec.map || "mp_crash"),
      bounds: [-2000, -2000, 4000, 4000],
      center: "", tracks, weapons: WEAPONS.map(prettyWeapon), grenades
    }
  };
}

/**
 * The reference match. Every highlight kind the engine claims to find is in
 * here exactly once, at a known place, so a test can name it.
 */
function referenceMatch(){
  return buildMatch({
    map: "mp_crash",
    mod: "mods/pml220",
    povClient: 0,
    teams: {
      Yimmy: ["Levitate", "Kees", "Lodie", "Vex", "Nord"],
      Rivals: ["Tamas", "Bruno", "Rikko", "Sander", "Joop"]
    },
    rounds: [
      // Round 1: a quad kill by Levitate, quick enough to count as rapid.
      { winner: "Yimmy", reason: "Rivals eliminated", kills: [
        { t: 8.0, killer: "Levitate", victim: "Tamas", weapon: "ak47", dist: 14 },
        { t: 10.5, killer: "Levitate", victim: "Bruno", weapon: "ak47", dist: 11 },
        { t: 12.0, killer: "Levitate", victim: "Rikko", weapon: "ak47", dist: 9 },
        { t: 12.9, killer: "Levitate", victim: "Sander", weapon: "ak47", dist: 16 },
        { t: 40.0, killer: "Kees", victim: "Joop", weapon: "m4", dist: 20 }
      ], nades: [
        { t: 3.0, by: "Lodie", kind: "smoke", from: [200, 200, 100], to: [1400, 900, 100] },
        { t: 20.0, by: "Vex", kind: "frag", from: [600, 100, 100], to: [900, 500, 100] }
      ] },
      // Round 2: Yimmy trades two early, then loses four, and Kees takes the
      // 1v3 and wins it. Lodie throws the team's standard smoke.
      { winner: "Yimmy", reason: "Rivals eliminated", kills: [
        { t: 3.0, killer: "Levitate", victim: "Sander", weapon: "ak47", dist: 17 },
        { t: 4.0, killer: "Vex", victim: "Joop", weapon: "m4", dist: 21 },
        { t: 5.0, killer: "Tamas", victim: "Levitate", weapon: "ak47", dist: 18 },
        { t: 6.5, killer: "Bruno", victim: "Lodie", weapon: "m4", dist: 12 },
        { t: 9.0, killer: "Rikko", victim: "Vex", weapon: "mp5", dist: 8 },
        { t: 11.0, killer: "Tamas", victim: "Nord", weapon: "ak47", dist: 22 },
        { t: 30.0, killer: "Kees", victim: "Tamas", weapon: "m4", dist: 15 },
        { t: 34.0, killer: "Kees", victim: "Bruno", weapon: "m4", dist: 19 },
        { t: 41.0, killer: "Kees", victim: "Rikko", weapon: "m4", dist: 24 }
      ], nades: [
        { t: 3.2, by: "Lodie", kind: "smoke", from: [210, 190, 100], to: [1410, 880, 100] },
        { t: 25.0, by: "Vex", kind: "frag", from: [-800, -900, 100], to: [-400, -500, 100] }
      ] },
      // Round 3: a trade, a long range M40A3 kill and a headshot run start.
      { winner: "Rivals", reason: "Yimmy eliminated", kills: [
        { t: 6.0, killer: "Tamas", victim: "Kees", weapon: "ak47", dist: 13 },
        { t: 7.2, killer: "Lodie", victim: "Tamas", weapon: "m4", dist: 10 },
        { t: 20.0, killer: "Bruno", victim: "Lodie", weapon: "m40a3", dist: 64 },
        { t: 30.0, killer: "Rikko", victim: "Levitate", headshot: true, dist: 17 },
        { t: 35.0, killer: "Rikko", victim: "Vex", headshot: true, dist: 21 },
        { t: 44.0, killer: "Rikko", victim: "Nord", headshot: true, dist: 12 }
      ], nades: [
        { t: 2.8, by: "Lodie", kind: "smoke", from: [195, 205, 100], to: [1395, 915, 100] }
      ] },
      // Round 4: a collateral, then a ninja defuse with enemies still alive.
      { winner: "Yimmy", reason: "Bomb defused", kills: [
        { t: 9.0, killer: "Levitate", victim: "Tamas", weapon: "m40a3", dist: 30 },
        { t: 9.05, killer: "Levitate", victim: "Bruno", weapon: "m40a3", dist: 33 },
        { t: 25.0, killer: "Rikko", victim: "Levitate", weapon: "ak47", dist: 14 },
        { t: 26.0, killer: "Sander", victim: "Kees", weapon: "ak47", dist: 16 }
      ], bomb: [
        { t: 35.0, action: "Bomb planted", player: "Rikko" },
        { t: 70.0, action: "Bomb defused", player: "Lodie" }
      ], nades: [
        { t: 3.1, by: "Lodie", kind: "smoke", from: [205, 195, 100], to: [1405, 890, 100] }
      ] },
      // Round 5: the bomb actually goes off, which is the only thing that
      // makes its timer measurable. Two defenders stay alive so the round
      // ends on the timer rather than on a wipe: plant at 30, end at 75,
      // so the engine must read the timer back as 45 s.
      { winner: "Rivals", reason: "Bomb exploded", durS: 75, kills: [
        { t: 12.0, killer: "Tamas", victim: "Levitate", weapon: "ak47", dist: 11 },
        { t: 14.0, killer: "Tamas", victim: "Kees", weapon: "ak47", dist: 13 },
        { t: 16.0, killer: "Tamas", victim: "Lodie", weapon: "ak47", dist: 15 }
      ], bomb: [
        { t: 30.0, action: "Bomb planted", player: "Tamas" }
      ] }
    ]
  });
}

const API = { buildMatch, referenceMatch, WEAPONS, UNITS_PER_METRE };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_SYNTH = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
