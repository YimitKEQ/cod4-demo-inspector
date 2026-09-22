/*!
 * highlights.js - the highlight engine.
 *
 * Reads the enriched model and finds the moments worth watching: multikills,
 * clutches, openings, trades, long range, headshot streaks, collaterals and
 * the bomb. Every highlight carries a score, a clip window and the players
 * involved, which is what the kill browser sorts by and what the batch
 * renderer turns into MP4s.
 *
 * Rules of the house that this file follows:
 *  - Nothing is invented. A detector that cannot know something (a wallbang
 *    without collision geometry, a bomb timer that was never observed) does
 *    not guess, it stays quiet.
 *  - Anything derived from entity state rather than the recorder is marked
 *    approximate and carries that flag into the UI.
 *  - Ported field for field to tools/py/highlights.py and cross-checked there.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

/* ---- tuning, all in one place ---- */

const CFG = {
  /* Clip window around a moment, in seconds. */
  preRollS: 4.0,
  postRollS: 2.0,

  /* A burst of kills this close together counts as quick. */
  quickWindowS: 5.0,

  /* A killer who dies this soon after their kill was traded. */
  tradeWindowS: 3.0,

  /* Two victims inside this window from one shooter is a collateral. */
  collateralWindowS: 0.15,

  /* A headshot streak needs at least this many in a row. */
  headshotStreak: 3,

  /* A defuse counts as ninja when the enemy still had this many alive and the
     defusing team scored no kill in the run up. */
  ninjaQuietS: 10.0,

  /* A defuse this close to detonation is a last second defuse. Only used when
     the bomb timer could actually be measured from the demo. */
  lastSecondS: 2.0,

  /* Long range thresholds in metres per weapon class. Beyond the threshold a
     kill is long range; the score ramps up to twice the threshold. */
  longRangeM: {
    shotgun: 15, pistol: 25, smg: 30, rifle: 40, lmg: 40, sniper: 55,
    grenade: 25, melee: null, other: null
  },

  /* Base scores per kind, 0 to 100. */
  score: {
    multikill: { 2: 40, 3: 62, 4: 80, 5: 95 },
    ace: 98,
    clutchWon: { 1: 45, 2: 68, 3: 84, 4: 92, 5: 97 },
    clutchLostFactor: 0.45,
    opening: 25,
    trade: 22,
    headshotStreak: 55,
    collateral: 74,
    plant: 26,
    defuse: 45,
    ninjaDefuse: 88,
    lastSecondDefuse: 92,
    longRangeMin: 45,
    longRangeMax: 85
  },

  /* Additive bonuses, applied then clamped to 100. */
  bonus: {
    quickMultikill: 10,
    allHeadshots: 6,
    roundDecider: 5
  }
};

/* ---- weapon classification ---- */

const WEAPON_CLASS = {
  sniper: ["m40a3", "remington700", "m21", "dragunov", "barrett", "m82"],
  shotgun: ["m1014", "winchester1200"],
  pistol: ["usp", "colt45", "beretta", "deserteagle", "deserteaglegold"],
  smg: ["mp5", "ak74u", "uzi", "p90", "skorpion"],
  lmg: ["m249saw", "rpd", "m60e4", "saw"],
  rifle: ["ak47", "m16", "m4", "m14", "g3", "g36c", "mp44"],
  grenade: ["frag_grenade", "frag_grenade_short", "grenade", "grenade_splash",
            "rpg", "projectile", "projectile_splash", "explosive", "destructible_car"],
  melee: ["melee", "knife"]
};

/** Strip the _mp suffix and any attachment so the class lookup works. */
function weaponBase(weapon){
  let n = String(weapon || "").replace(/_mp$/, "");
  for (const tag of ["_silencer", "_reflex", "_acog", "_gold", "_scout", "_grip"]) {
    if (n.endsWith(tag)) { n = n.slice(0, -tag.length); break; }
  }
  return n;
}

function weaponClass(weapon){
  const base = weaponBase(weapon);
  for (const cls of Object.keys(WEAPON_CLASS)) {
    if (WEAPON_CLASS[cls].indexOf(base) >= 0) return cls;
  }
  return "other";
}

/* ---- helpers ---- */

const clamp100 = v => Math.max(0, Math.min(100, Math.round(v)));

const MULTIKILL_NAME = { 2: "Double kill", 3: "Triple kill", 4: "Quad kill" };

/** Window around a set of kill times. */
function windowFor(times){
  const first = Math.min.apply(null, times);
  const last = Math.max.apply(null, times);
  return {
    startS: +Math.max(0, first - CFG.preRollS).toFixed(2),
    endS: +(last + CFG.postRollS).toFixed(2),
    focusS: +last.toFixed(2)
  };
}

function makeHighlight(kind, parts){
  const h = {
    id: "",
    kind,
    score: 0,
    startS: 0, endS: 0, focusS: 0,
    round: null, roundIdx: -1,
    primary: null,
    players: [],
    killIds: [],
    tags: [],
    title: "",
    detail: "",
    approx: false
  };
  for (const key of Object.keys(parts)) h[key] = parts[key];
  return h;
}

/**
 * The bomb timer, measured rather than assumed.
 *
 * In any round where the bomb actually exploded, the time from the plant to
 * the end of the round is the timer. Taking the median across those rounds
 * survives one odd round. Without such a round the timer is unknown and the
 * last second defuse detector stays switched off rather than guessing.
 */
function measureBombTimer(model){
  const spans = [];
  for (const state of model.roundStates) {
    const r = model.rounds[state.idx];
    if (!state.plant || !/exploded/i.test(r.reason || "")) continue;
    const span = state.endS - state.plant.tS;
    if (span > 5 && span < 120) spans.push(span);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a - b);
  const mid = spans.length >> 1;
  const median = spans.length % 2 ? spans[mid] : (spans[mid - 1] + spans[mid]) / 2;
  return +median.toFixed(1);
}

/* ---- detectors ---- */

/** Kills that count towards a player's performance: not suicides, not teamkills. */
const scoringKills = list => list.filter(k => !k.suicide && !k.teamkill && k.killer !== null);

/**
 * Multikills and aces, per player per round.
 * An ace is killing every enemy that was alive when the round started, which
 * is more honest than hardcoding five.
 */
function detectMultikills(model, out){
  for (const state of model.roundStates) {
    const byKiller = new Map();
    for (const k of scoringKills(state.kills)) {
      if (!byKiller.has(k.killer)) byKiller.set(k.killer, []);
      byKiller.get(k.killer).push(k);
    }
    for (const [client, list] of byKiller) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.tS - b.tS);
      const team = model.teamOf(client);
      const enemyTeam = model.teamNames.find(t => t !== team);
      const enemyCount = (state.rosters.get(enemyTeam) || []).length;
      const isAce = enemyCount > 0 && list.length >= enemyCount;
      const n = list.length;

      const times = list.map(k => k.tS);
      const win = windowFor(times);
      const spanS = times[times.length - 1] - times[0];
      const quick = spanS <= CFG.quickWindowS;
      const allHeadshots = list.every(k => k.headshot);

      let score = isAce ? CFG.score.ace
                : (CFG.score.multikill[Math.min(n, 5)] || CFG.score.multikill[5]);
      const tags = [];
      if (isAce) tags.push("Ace");
      else tags.push(MULTIKILL_NAME[n] || (n + "k"));
      if (quick) { score += CFG.bonus.quickMultikill; tags.push("Rapid"); }
      if (allHeadshots) { score += CFG.bonus.allHeadshots; tags.push("All headshots"); }
      if (model.rounds[state.idx].winner === team) { score += CFG.bonus.roundDecider; }

      const weapons = [...new Set(list.map(k => k.weaponLabel))];
      const name = model.nameOf(client);
      const label = isAce ? "Ace" : (MULTIKILL_NAME[n] || (n + " kills"));

      out.push(makeHighlight("multikill", {
        score: clamp100(score),
        startS: win.startS, endS: win.endS, focusS: win.focusS,
        round: state.n, roundIdx: state.idx,
        primary: client,
        players: [client, ...list.map(k => k.victim)],
        killIds: list.map(k => k.id),
        tags,
        title: label + " by " + name,
        detail: n + " kills in round " + state.n +
                (quick ? " inside " + spanS.toFixed(1) + " s" : "") +
                " with " + weapons.join(", "),
        approx: list.some(k => k.distanceApprox)
      }));
    }
  }
}

/**
 * Clutches: the moment a team drops to one player alive against at least one
 * enemy. Scored by how many enemies were standing, and whether the round was
 * actually won. A lost clutch still makes the list, quieter.
 */
function detectClutches(model, out){
  for (const state of model.roundStates) {
    for (const team of model.teamNames) {
      const enemyTeam = model.teamNames.find(t => t !== team);
      const roster = state.rosters.get(team) || [];
      if (roster.length < 2) continue;

      /* Walk the deaths on this team in order and find the moment exactly one
         player is left. */
      const ourDeaths = state.deaths.filter(d => d.team === team).sort((a, b) => a.tS - b.tS);
      if (ourDeaths.length < roster.length - 1) continue;

      const clutchStart = ourDeaths[roster.length - 2].tS;
      const survivors = model.aliveAt(state, team, clutchStart);
      if (survivors.length !== 1) continue;
      const client = survivors[0];

      const enemiesAlive = model.aliveAt(state, enemyTeam, clutchStart);
      const n = enemiesAlive.length;
      if (n < 1) continue;

      const won = model.rounds[state.idx].winner === team;
      /* Kills the clutcher made after the situation began. */
      const theirKills = scoringKills(state.kills)
        .filter(k => k.killer === client && k.tS >= clutchStart);

      const base = CFG.score.clutchWon[Math.min(n, 5)] || CFG.score.clutchWon[5];
      const score = won ? base : base * CFG.score.clutchLostFactor;

      const times = theirKills.length ? theirKills.map(k => k.tS) : [clutchStart];
      const win = windowFor(times);
      /* A clutch is about the whole situation, so the window opens at the
         moment it became a clutch, not at the first kill. */
      win.startS = +Math.max(0, clutchStart - CFG.preRollS).toFixed(2);
      if (won) win.endS = +Math.max(win.endS, state.endS).toFixed(2);

      const name = model.nameOf(client);
      const tags = ["Clutch", "1v" + n, won ? "Won" : "Lost"];

      out.push(makeHighlight("clutch", {
        score: clamp100(score),
        startS: win.startS, endS: win.endS, focusS: win.focusS,
        round: state.n, roundIdx: state.idx,
        primary: client,
        players: [client, ...enemiesAlive],
        killIds: theirKills.map(k => k.id),
        tags,
        title: name + " 1v" + n + (won ? "" : " (lost)"),
        detail: (won ? "Won" : "Lost") + " the 1v" + n + " in round " + state.n +
                " with " + theirKills.length + " kill" + (theirKills.length === 1 ? "" : "s"),
        approx: theirKills.some(k => k.distanceApprox)
      }));
    }
  }
}

/** The first kill of a round, and the kills that answered one. */
function detectOpeningsAndTrades(model, out){
  for (const state of model.roundStates) {
    const list = scoringKills(state.kills).sort((a, b) => a.tS - b.tS);
    if (!list.length) continue;

    const first = list[0];
    const win = windowFor([first.tS]);
    out.push(makeHighlight("opening", {
      score: CFG.score.opening,
      startS: win.startS, endS: win.endS, focusS: win.focusS,
      round: state.n, roundIdx: state.idx,
      primary: first.killer,
      players: [first.killer, first.victim],
      killIds: [first.id],
      tags: ["Opening"],
      title: "Opening kill: " + first.killerName,
      detail: first.killerName + " opened round " + state.n + " on " +
              first.victimName + " with " + first.weaponLabel,
      approx: first.distanceApprox
    }));

    /* A trade: someone kills the player who just killed their teammate. */
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.tS - a.tS > CFG.tradeWindowS) break;
        if (b.victim !== a.killer) continue;
        if (b.killerTeam !== a.victimTeam) continue;
        const win2 = windowFor([a.tS, b.tS]);
        out.push(makeHighlight("trade", {
          score: CFG.score.trade,
          startS: win2.startS, endS: win2.endS, focusS: win2.focusS,
          round: state.n, roundIdx: state.idx,
          primary: b.killer,
          players: [b.killer, b.victim, a.victim],
          killIds: [a.id, b.id],
          tags: ["Trade"],
          title: "Trade: " + b.killerName + " answers for " + a.victimName,
          detail: b.killerName + " traded " + a.killerName + " back " +
                  (b.tS - a.tS).toFixed(1) + " s after " + a.victimName + " went down",
          approx: a.distanceApprox || b.distanceApprox
        }));
        break;
      }
    }
  }
}

/** Kills at a distance that is unusual for the weapon in hand. */
function detectLongRange(model, out){
  for (const k of scoringKills(model.kills)) {
    if (k.distanceM === null) continue;
    const cls = weaponClass(k.weapon);
    const threshold = CFG.longRangeM[cls];
    if (threshold === null || threshold === undefined) continue;
    if (k.distanceM < threshold) continue;

    /* Ramp from the threshold to twice the threshold. */
    const t = Math.min(1, (k.distanceM - threshold) / threshold);
    const score = CFG.score.longRangeMin + t * (CFG.score.longRangeMax - CFG.score.longRangeMin);
    const win = windowFor([k.tS]);
    const tags = ["Long range"];
    if (k.headshot) tags.push("Headshot");

    out.push(makeHighlight("longrange", {
      score: clamp100(score),
      startS: win.startS, endS: win.endS, focusS: win.focusS,
      round: k.round, roundIdx: k.roundIdx,
      primary: k.killer,
      players: [k.killer, k.victim],
      killIds: [k.id],
      tags,
      title: k.distanceM.toFixed(0) + " m " + (k.headshot ? "headshot" : "kill") +
             " by " + k.killerName,
      detail: k.killerName + " killed " + k.victimName + " at " + k.distanceM.toFixed(0) +
              " m with the " + k.weaponLabel + " (approximate, from entity positions)",
      approx: true
    }));
  }
}

/** Consecutive headshots by the same player across the match. */
function detectHeadshotStreaks(model, out){
  const byPlayer = new Map();
  for (const k of scoringKills(model.kills)) {
    if (!byPlayer.has(k.killer)) byPlayer.set(k.killer, []);
    byPlayer.get(k.killer).push(k);
  }
  for (const [client, list] of byPlayer) {
    list.sort((a, b) => a.tS - b.tS);
    let run = [];
    const flush = () => {
      if (run.length >= CFG.headshotStreak) {
        const win = windowFor(run.map(k => k.tS));
        const name = model.nameOf(client);
        out.push(makeHighlight("headshotstreak", {
          score: clamp100(CFG.score.headshotStreak + (run.length - CFG.headshotStreak) * 8),
          startS: win.startS, endS: win.endS, focusS: win.focusS,
          round: run[0].round, roundIdx: run[0].roundIdx,
          primary: client,
          players: [client, ...run.map(k => k.victim)],
          killIds: run.map(k => k.id),
          tags: ["Headshot streak", run.length + " in a row"],
          title: run.length + " headshots in a row by " + name,
          detail: name + " landed " + run.length + " headshot kills back to back, rounds " +
                  run[0].round + " to " + run[run.length - 1].round,
          approx: run.some(k => k.distanceApprox)
        }));
      }
      run = [];
    };
    for (const k of list) {
      if (k.headshot) run.push(k); else flush();
    }
    flush();
  }
}

/**
 * Collaterals: one shooter, two or more victims in the same instant.
 * This is the only through-wall style feat the obituary feed can prove on its
 * own. A single wallbang needs collision geometry and is left to Phase 3.
 */
function detectCollaterals(model, out){
  const list = scoringKills(model.kills).slice().sort((a, b) => a.tS - b.tS);
  let i = 0;
  while (i < list.length) {
    const group = [list[i]];
    let j = i + 1;
    while (j < list.length &&
           list[j].killer === list[i].killer &&
           list[j].weaponId === list[i].weaponId &&
           list[j].tS - list[i].tS <= CFG.collateralWindowS) {
      group.push(list[j]); j++;
    }
    if (group.length >= 2) {
      const win = windowFor(group.map(k => k.tS));
      const name = group[0].killerName;
      out.push(makeHighlight("collateral", {
        score: clamp100(CFG.score.collateral + (group.length - 2) * 10),
        startS: win.startS, endS: win.endS, focusS: win.focusS,
        round: group[0].round, roundIdx: group[0].roundIdx,
        primary: group[0].killer,
        players: [group[0].killer, ...group.map(k => k.victim)],
        killIds: group.map(k => k.id),
        tags: ["Collateral", group.length + " in one"],
        title: "Collateral by " + name,
        detail: name + " killed " + group.length + " players in the same instant with the " +
                group[0].weaponLabel,
        approx: group.some(k => k.distanceApprox)
      }));
    }
    i = j > i + 1 ? j : i + 1;
  }
}

/** Bomb plants and defuses, including the ninja and the last second variety. */
function detectBomb(model, out, bombTimerS){
  for (const state of model.roundStates) {
    if (state.plant) {
      const win = windowFor([state.plant.tS]);
      out.push(makeHighlight("plant", {
        score: CFG.score.plant,
        startS: win.startS, endS: win.endS, focusS: win.focusS,
        round: state.n, roundIdx: state.idx,
        primary: null,
        players: [],
        killIds: [],
        tags: ["Bomb", "Plant"],
        title: "Bomb planted by " + (state.plant.player || "unknown"),
        detail: "Round " + state.n + ": bomb down at " + state.plant.tS.toFixed(1) + " s",
        approx: false
      }));
    }
    if (state.defuse) {
      const d = state.defuse;
      const win = windowFor([d.tS]);
      const defuserTeam = model.rounds[state.idx].winner;
      const enemyTeam = model.teamNames.find(t => t !== defuserTeam);
      const enemiesAlive = enemyTeam ? model.aliveAt(state, enemyTeam, d.tS).length : 0;
      const quietKills = scoringKills(state.kills).filter(
        k => k.tS >= d.tS - CFG.ninjaQuietS && k.tS <= d.tS && k.killerTeam === defuserTeam);
      const ninja = enemiesAlive >= 1 && quietKills.length === 0;

      let lastSecond = false, remainingS = null;
      if (bombTimerS !== null && state.plant) {
        remainingS = +(bombTimerS - (d.tS - state.plant.tS)).toFixed(1);
        lastSecond = remainingS >= 0 && remainingS <= CFG.lastSecondS;
      }

      let score = CFG.score.defuse;
      const tags = ["Bomb", "Defuse"];
      if (ninja) { score = CFG.score.ninjaDefuse; tags.push("Ninja"); }
      if (lastSecond) { score = Math.max(score, CFG.score.lastSecondDefuse); tags.push("Last second"); }

      let detail = "Round " + state.n + ": defused with " + enemiesAlive +
                   " enemy player" + (enemiesAlive === 1 ? "" : "s") + " still alive";
      if (remainingS !== null) detail += ", " + remainingS.toFixed(1) + " s left on the bomb";
      else detail += "; bomb timer never observed in this demo, so the remaining time is unknown";

      out.push(makeHighlight("defuse", {
        score: clamp100(score),
        startS: win.startS, endS: win.endS, focusS: win.focusS,
        round: state.n, roundIdx: state.idx,
        primary: null,
        players: [],
        killIds: [],
        tags,
        title: (ninja ? "Ninja defuse" : "Defuse") + " by " + (d.player || "unknown"),
        detail,
        approx: false
      }));
    }
  }
}

/* ---- assembly ---- */

/**
 * Overlapping highlights for the same player collapse into the strongest one,
 * keeping the union of the tags and the widest window. Without this a 4k that
 * was also a clutch shows up three times in the top ten.
 */
function mergeOverlapping(list){
  const sorted = list.slice().sort((a, b) => b.score - a.score || a.startS - b.startS);
  const kept = [];
  for (const h of sorted) {
    const host = kept.find(x =>
      x.primary !== null && x.primary === h.primary &&
      x.roundIdx === h.roundIdx &&
      h.startS < x.endS && h.endS > x.startS);
    if (!host) { kept.push(h); continue; }
    host.startS = +Math.min(host.startS, h.startS).toFixed(2);
    host.endS = +Math.max(host.endS, h.endS).toFixed(2);
    for (const t of h.tags) if (host.tags.indexOf(t) < 0) host.tags.push(t);
    for (const id of h.killIds) if (host.killIds.indexOf(id) < 0) host.killIds.push(id);
    for (const p of h.players) if (host.players.indexOf(p) < 0) host.players.push(p);
    host.approx = host.approx || h.approx;
    if (!host.merged) host.merged = [];
    host.merged.push(h.kind);
  }
  return kept;
}

/**
 * Run every detector and return the highlights plus the per kill tags.
 *
 * Returns { highlights, merged, kills, bombTimerS, notes }. `kills` is the
 * model's kill list with tags and a score written onto each one, so the kill
 * browser can sort without re-deriving anything.
 */
function detect(model, options){
  const opts = options || {};
  const notes = [];

  if (!model.caps.killFeed) {
    notes.push("No obituary feed in this demo, so there is nothing to build highlights from. " +
               "Stats fall back to the scoreboard.");
    return { highlights: [], merged: [], kills: model.kills, bombTimerS: null, notes };
  }
  if (!model.caps.positions) {
    notes.push("No position tracks in this demo: distances, long range kills and the map " +
               "view are unavailable.");
  }

  const bombTimerS = measureBombTimer(model);
  if (bombTimerS === null) {
    notes.push("The bomb never exploded in this demo, so its timer could not be measured. " +
               "Last second defuses are not detected.");
  }

  const raw = [];
  detectMultikills(model, raw);
  detectClutches(model, raw);
  detectOpeningsAndTrades(model, raw);
  detectLongRange(model, raw);
  detectHeadshotStreaks(model, raw);
  detectCollaterals(model, raw);
  detectBomb(model, raw, bombTimerS);

  raw.sort((a, b) => b.score - a.score || a.startS - b.startS || a.kind.localeCompare(b.kind));
  raw.forEach((h, i) => { h.id = "h" + i; });

  const merged = mergeOverlapping(raw);
  merged.sort((a, b) => b.score - a.score || a.startS - b.startS);

  /* Write tags and a score back onto the kills. A kill's score is the best
     highlight it takes part in, with its own merits as a floor so an ordinary
     headshot still outranks an ordinary body shot. */
  const byKill = new Map();
  for (const h of raw) {
    for (const id of h.killIds) {
      if (!byKill.has(id)) byKill.set(id, []);
      byKill.get(id).push(h);
    }
  }
  for (const k of model.kills) {
    const hs = byKill.get(k.id) || [];
    const tags = [];
    for (const h of hs) for (const t of h.tags) if (tags.indexOf(t) < 0) tags.push(t);
    if (k.headshot && tags.indexOf("Headshot") < 0) tags.push("Headshot");
    if (k.teamkill) tags.push("Team kill");
    if (k.suicide) tags.push("Suicide");
    k.tags = tags;
    let floor = 0;
    if (k.headshot) floor = 18;
    if (k.teamkill || k.suicide) floor = 0;
    k.score = clamp100(Math.max(floor, hs.length ? Math.max.apply(null, hs.map(h => h.score)) : 0));
    k.highlightIds = hs.map(h => h.id);
  }

  const limit = opts.top || 0;
  return {
    highlights: raw,
    merged: limit ? merged.slice(0, limit) : merged,
    kills: model.kills,
    bombTimerS,
    notes
  };
}

const API = { detect, CFG, weaponClass, weaponBase, measureBombTimer, mergeOverlapping };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_HIGHLIGHTS = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
