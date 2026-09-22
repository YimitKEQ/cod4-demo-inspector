/*!
 * analysis.js - the part that teaches you something.
 *
 * The highlight engine finds what was exciting. This finds what was true:
 * where the team throws its utility and whether the same lineup comes out
 * every round, who wins first contact and where, whether a death gets traded,
 * how predictable a player's opening route is, and what the movement track
 * says about how somebody actually plays.
 *
 * Shaped by what coaches in tactical shooters actually measure, ordered by
 * what changes behaviour: opening duels first, then trades, then utility
 * discipline, then predictability. Each metric says what it is computed from
 * so none of it has to be taken on trust.
 *
 * Two CoD4 facts that shape this file:
 *  - Promod has no economy. There are no buy rounds to analyse; what replaces
 *    them is a fixed per team weapon class allocation.
 *  - A player carries one frag plus one special grenade (flash or smoke, not
 *    both) per life, so utility is scarce and every throw is a decision.
 *
 * Pure. No DOM, no three.js. Runs in the browser, in Node and under test.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const MODEL = root.DM1_MODEL;

const CFG = {
  /* A grenade is attributed to the nearest player to its first transmitted
     point. Beyond this the throw is left unattributed rather than guessed. */
  throwerRadius: 220,

  /* Two throws of the same kind are the same lineup when both the throwing
     spot and the landing spot are within these distances. The landing
     tolerance is tighter: a lineup is defined by where it lands. */
  lineupOriginTol: 260,
  lineupImpactTol: 300,

  /* A lineup needs this many uses before it is a pattern rather than a throw. */
  lineupMinUses: 3,

  /* Utility counts as supporting an entry when it lands within this window
     before first contact. */
  utilityBeforeEntryS: 8,

  /* A death is traded when a teammate kills the killer within this window. */
  tradeWindowS: 3.0,

  /* Opening routes: the first stretch of a round, resampled to this many
     points, and the deviation beyond which two routes are different. */
  routeS: 12,
  routeN: 14,
  routeTol: 700,

  /* Movement. CoD4 sprint tops out around 220 units per second. Anything
     sustained beyond this while airborne is strafe jump technique. */
  sprintSpeed: 220,
  jumpMinRise: 24,

  /* Anything above this is not movement, it is a respawn or a round restart
     putting the player somewhere else between two samples. Leaving these in
     reported peak speeds of fifty thousand units per second. A strafe jump
     tops out well under 500. */
  teleportSpeed: 1000,

  /* Map control is sampled at this point in the round. */
  controlAtS: 30
};

const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dist3d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function median(list){
  if (!list.length) return 0;
  const a = list.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Which round a time falls in. */
function roundAt(model, t){
  return model.roundStates.find(r => t >= r.startS && t <= r.endS) || null;
}

/* ---- utility ---- */

/**
 * Who threw each grenade.
 *
 * The demo does not say. What it does say is where the grenade first appeared,
 * and a grenade first appears in its thrower's hand, so the nearest player at
 * that instant is the thrower. Anything further than a throwing arm away is
 * left unattributed instead of guessed, and every attribution carries the
 * distance it was made from so the UI can show how sure it is.
 */
function attributeGrenades(model){
  const out = [];
  for (const nade of model.grenades) {
    const p0 = nade.path[0];
    const tS = p0[0] / 100;
    const at = [p0[1], p0[2], p0[3]];

    let best = null, bestD = CFG.throwerRadius;
    for (const id of Object.keys(model.tracks)) {
      const client = Number(id);
      const pos = MODEL.positionAt(model.tracks, client, tS, 0.6);
      if (!pos) continue;
      /* Compare at chest height: the grenade leaves the hand, not the feet. */
      const d = dist3d(at, [pos.x, pos.y, pos.z + 50]);
      if (d < bestD) { bestD = d; best = client; }
    }

    const round = roundAt(model, tS);
    out.push({
      kind: nade.kind,
      weapon: nade.weapon,
      tS,
      origin: at,
      impact: nade.impact,
      impactS: (nade.impactS !== null && nade.impactS !== undefined
                ? nade.impactS : nade.path[nade.path.length - 1][0]) / 100,
      predicted: !!nade.predicted,
      path: nade.path,
      thrower: best,
      throwerName: best === null ? null : model.nameOf(best),
      throwerTeam: best === null ? null : model.teamOf(best),
      /* How far the nearest player was. Small is confident. */
      attributionDist: best === null ? null : Math.round(bestD),
      round: round ? round.n : null,
      roundIdx: round ? round.idx : -1,
      roundTS: round ? +(tS - round.startS).toFixed(1) : null,
      travelUnits: Math.round(dist3d(at, nade.impact))
    });
  }
  return out;
}

/**
 * Lineups: the same throw, made again.
 *
 * Greedy clustering on the pair of points that define a throw, where it left
 * the hand and where it landed. A cluster used often enough across rounds is a
 * lineup the team practised, and that is the thing worth knowing: it is what
 * an opponent can read, and what a coach can drill.
 */
function findLineups(throws){
  const clusters = [];
  for (const th of throws) {
    if (th.thrower === null) continue;
    const host = clusters.find(c =>
      c.kind === th.kind &&
      c.team === th.throwerTeam &&
      dist3d(c.origin, th.origin) <= CFG.lineupOriginTol &&
      dist3d(c.impact, th.impact) <= CFG.lineupImpactTol);
    if (host) {
      host.uses.push(th);
      /* Running mean keeps the cluster centred on all its members. */
      for (let i = 0; i < 3; i++) {
        host.origin[i] += (th.origin[i] - host.origin[i]) / host.uses.length;
        host.impact[i] += (th.impact[i] - host.impact[i]) / host.uses.length;
      }
    } else {
      clusters.push({
        kind: th.kind, team: th.throwerTeam,
        origin: th.origin.slice(), impact: th.impact.slice(),
        uses: [th]
      });
    }
  }

  return clusters
    .filter(c => c.uses.length >= CFG.lineupMinUses)
    .map(c => {
      const byThrower = new Map();
      for (const u of c.uses) byThrower.set(u.thrower, (byThrower.get(u.thrower) || 0) + 1);
      const rounds = [...new Set(c.uses.map(u => u.round).filter(r => r !== null))];
      const times = c.uses.map(u => u.roundTS).filter(v => v !== null);
      return {
        kind: c.kind,
        team: c.team,
        origin: c.origin.map(Math.round),
        impact: c.impact.map(Math.round),
        uses: c.uses.length,
        rounds,
        throwers: [...byThrower.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([client, n]) => ({ client, n })),
        /* When in the round it tends to be thrown, and how tightly. A tight
           spread is a scripted execute; a wide one is improvisation. */
        medianRoundTS: +median(times).toFixed(1),
        spreadS: +(times.length > 1
          ? median(times.map(v => Math.abs(v - median(times)))) : 0).toFixed(1),
        /* Every use is predicted unless the demo transmitted the landing. */
        predictedShare: +(c.uses.filter(u => u.predicted).length / c.uses.length).toFixed(2)
      };
    })
    .sort((a, b) => b.uses - a.uses);
}

/** Per player and per team utility discipline. */
function utilityStats(model, throws){
  const perPlayer = new Map();
  const rounds = model.roundStates.length || 1;
  for (const p of model.players) {
    perPlayer.set(p.client, {
      client: p.client, name: p.name, team: p.team,
      frag: 0, smoke: 0, flash: 0, other: 0, total: 0,
      perRound: 0, unattributed: 0
    });
  }
  let unattributed = 0;
  for (const th of throws) {
    if (th.thrower === null || !perPlayer.has(th.thrower)) { unattributed++; continue; }
    const s = perPlayer.get(th.thrower);
    if (th.kind === "frag") s.frag++;
    else if (th.kind === "smoke") s.smoke++;
    else if (th.kind === "flash") s.flash++;
    else s.other++;
    s.total++;
  }
  for (const s of perPlayer.values()) s.perRound = +(s.total / rounds).toFixed(2);

  /* Utility before entry: did anything land before the round's first kill?
     This is the process metric that separates a drilled execute from a dry
     push, and it is computable from landing times alone. */
  let supported = 0, contested = 0;
  const perRound = [];
  for (const st of model.roundStates) {
    const firstKill = st.kills.filter(k => !k.suicide && !k.teamkill)
      .sort((a, b) => a.tS - b.tS)[0];
    if (!firstKill) continue;
    contested++;
    const landedBefore = throws.filter(th =>
      th.roundIdx === st.idx &&
      th.impactS <= firstKill.tS &&
      th.impactS >= firstKill.tS - CFG.utilityBeforeEntryS);
    if (landedBefore.length) supported++;
    perRound.push({
      round: st.n,
      firstContactS: +(firstKill.tS - st.startS).toFixed(1),
      utilityBefore: landedBefore.length,
      winner: model.rounds[st.idx].winner
    });
  }

  return {
    perPlayer: [...perPlayer.values()].sort((a, b) => b.total - a.total),
    unattributed,
    attributedShare: throws.length
      ? +((throws.length - unattributed) / throws.length).toFixed(2) : 0,
    utilityBeforeEntryRate: contested ? +(supported / contested).toFixed(2) : null,
    perRound
  };
}

/* ---- duels ---- */

/**
 * Opening duels and trades.
 *
 * The opening duel is the highest leverage event in a round, so it is measured
 * per player and located on the map: knowing which duel keeps being lost is
 * actionable, knowing that duels are lost is not.
 */
function duelStats(model){
  const perPlayer = new Map();
  const ensure = c => {
    if (!perPlayer.has(c)) {
      const p = model.playerBy.get(c);
      perPlayer.set(c, {
        client: c, name: p ? p.name : "client " + c, team: p ? p.team : null,
        openingWins: 0, openingLosses: 0,
        deaths: 0, deathsTraded: 0,
        kills: 0, killsTradedAgainst: 0
      });
    }
    return perPlayer.get(c);
  };

  const openings = [];
  for (const st of model.roundStates) {
    const list = st.kills.filter(k => !k.suicide && !k.teamkill)
      .sort((a, b) => a.tS - b.tS);
    if (!list.length) continue;
    const first = list[0];
    ensure(first.killer).openingWins++;
    ensure(first.victim).openingLosses++;
    openings.push({
      round: st.n,
      roundTS: +(first.tS - st.startS).toFixed(1),
      killer: first.killer, victim: first.victim,
      killerName: first.killerName, victimName: first.victimName,
      killerTeam: first.killerTeam,
      weapon: first.weaponKnown ? first.weaponLabel : null,
      at: first.victimPos ? [first.victimPos.x, first.victimPos.y, first.victimPos.z] : null,
      killerAt: first.killerPos ? [first.killerPos.x, first.killerPos.y, first.killerPos.z] : null,
      distanceM: first.distanceM,
      /* Did the team that lost the opening go on to win anyway? */
      roundWonByOpener: model.rounds[st.idx].winner === first.killerTeam
    });
  }

  /* Trades. A death is traded when a teammate of the victim kills the killer
     soon after. Low trade rates are a spacing problem, not an aim problem,
     which is why this is worth separating from raw kills. */
  for (const st of model.roundStates) {
    const list = st.kills.filter(k => !k.suicide && !k.teamkill)
      .sort((a, b) => a.tS - b.tS);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      ensure(a.victim).deaths++;
      ensure(a.killer).kills++;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.tS - a.tS > CFG.tradeWindowS) break;
        if (b.victim !== a.killer) continue;
        if (b.killerTeam !== a.victimTeam) continue;
        ensure(a.victim).deathsTraded++;
        ensure(a.killer).killsTradedAgainst++;
        break;
      }
    }
  }

  const players = [...perPlayer.values()].map(s => ({
    ...s,
    openingRate: (s.openingWins + s.openingLosses)
      ? +(s.openingWins / (s.openingWins + s.openingLosses)).toFixed(2) : null,
    tradedRate: s.deaths ? +(s.deathsTraded / s.deaths).toFixed(2) : null
  })).sort((a, b) => (b.openingWins + b.openingLosses) - (a.openingWins + a.openingLosses));

  const openerWon = openings.filter(o => o.roundWonByOpener).length;
  return {
    players,
    openings,
    openingConversion: openings.length ? +(openerWon / openings.length).toFixed(2) : null,
    /* Spread of first contact times. A narrow spread across many rounds is a
       readable script. */
    firstContactMedianS: +median(openings.map(o => o.roundTS)).toFixed(1),
    firstContactSpreadS: +median(
      openings.map(o => Math.abs(o.roundTS - median(openings.map(x => x.roundTS))))
    ).toFixed(1)
  };
}

/* ---- routes ---- */

function resampleRoute(track, t0, t1, n){
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    const idx = MODEL.sampleIndexAt(track, t);
    if (idx < 0) return null;
    out.push([track[idx][1], track[idx][2]]);
  }
  return out;
}

const routeDist = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += dist2d(a[i], b[i]);
  return sum / a.length;
};

/**
 * How predictable is a player's opening?
 *
 * Every round's first seconds are resampled to a fixed number of points and
 * clustered. A player who takes the same line out of spawn most rounds is
 * readable, and the score says how readable with the evidence attached.
 */
function routeStats(model){
  const out = [];
  for (const p of model.players) {
    const track = model.tracks[String(p.client)];
    if (!track) continue;
    const routes = [];
    for (const st of model.roundStates) {
      const death = st.deaths.find(d => d.client === p.client);
      const until = Math.min(st.startS + CFG.routeS, death ? death.tS : st.endS);
      if (until - st.startS < 4) continue;
      const pts = resampleRoute(track, st.startS, until, CFG.routeN);
      if (pts) routes.push({ round: st.n, pts });
    }
    if (routes.length < 3) {
      out.push({ client: p.client, name: p.name, team: p.team, runs: routes.length,
                 score: null, clusters: [],
                 why: "only " + routes.length + " opening runs recorded, too few to judge" });
      continue;
    }

    const clusters = [];
    for (const r of routes) {
      const host = clusters.find(c => routeDist(c.rep, r.pts) <= CFG.routeTol);
      if (host) host.members.push(r);
      else clusters.push({ rep: r.pts, members: [r] });
    }
    clusters.sort((a, b) => b.members.length - a.members.length);
    const top = clusters[0];
    const share = top.members.length / routes.length;
    const spread = median(top.members.map(m => routeDist(top.rep, m.pts)));
    const tight = Math.max(0, Math.min(1, 1 - spread / CFG.routeTol));
    out.push({
      client: p.client, name: p.name, team: p.team,
      runs: routes.length,
      score: Math.round(100 * (0.7 * share + 0.3 * tight)),
      clusters: clusters.slice(0, 3).map(c => ({
        n: c.members.length,
        share: +(c.members.length / routes.length).toFixed(2),
        rounds: c.members.map(m => m.round),
        path: c.rep.map(pt => [Math.round(pt[0]), Math.round(pt[1])])
      })),
      why: top.members.length + " of " + routes.length +
           " opening runs took the same line, " + clusters.length +
           " distinct route" + (clusters.length === 1 ? "" : "s")
    });
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0));
}

/* ---- movement ---- */

/**
 * What the movement track says.
 *
 * CoD4 has no lean key, so position and yaw are the whole story of how a
 * player moves. Strafe jumping and wall running are legitimate, trainable
 * technique in promod, and both show up as speed above the sprint cap. A
 * player who never exceeds it is leaving movement on the table.
 */
function movementStats(model){
  const out = [];
  for (const p of model.players) {
    const track = model.tracks[String(p.client)];
    if (!track || track.length < 20) continue;

    let jumps = 0, fastAir = 0, airSamples = 0;
    let peak = 0;
    const speeds = [];
    let rising = false, riseFrom = 0;

    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1], b = track[i];
      const dt = (b[0] - a[0]) / 100;
      if (dt <= 0 || dt > 0.3) { rising = false; continue; }
      const speed = Math.hypot(b[1] - a[1], b[2] - a[2]) / dt;
      /* A teleport is not a move: drop the sample entirely rather than let it
         into the speeds, the peak or the airborne count. */
      if (speed >= CFG.teleportSpeed) { rising = false; continue; }
      if (speed > 0) speeds.push(speed);
      if (speed > peak) peak = speed;

      const dz = b[3] - a[3];
      if (dz > 2) {
        if (!rising) { rising = true; riseFrom = a[3]; }
      } else if (rising && dz < 0) {
        if (b[3] - riseFrom > -8 && Math.max(0, a[3] - riseFrom) >= CFG.jumpMinRise) jumps++;
        rising = false;
      }
      /* Airborne is approximated by being above the height the rise started
         from. Without the ground flag in the tracks this is the honest
         approximation, and it is marked as one. */
      if (rising) {
        airSamples++;
        if (speed > CFG.sprintSpeed) fastAir++;
      }
    }

    speeds.sort((x, y) => x - y);
    const medianSpeed = median(speeds);
    /* A track whose typical speed is far above a sprint is not a player: it is
       a spectator or a free camera. Reporting jump technique for one would be
       nonsense, so it is labelled instead of silently averaged in. */
    const playing = medianSpeed <= CFG.sprintSpeed * 1.5;
    out.push({
      playing,
      client: p.client, name: p.name, team: p.team,
      medianSpeed: Math.round(medianSpeed),
      p90Speed: Math.round(speeds[Math.floor(speeds.length * 0.9)] || 0),
      peakSpeed: Math.round(peak),
      jumps,
      jumpsPerRound: +(jumps / (model.roundStates.length || 1)).toFixed(1),
      /* Share of airborne samples carrying more than sprint speed: the
         signature of strafe jumping and wall running. Approximate, because
         the ground flag is not carried into the tracks. */
      strafeJumpShare: airSamples ? +(fastAir / airSamples).toFixed(2) : 0,
      approximate: true,
      note: playing ? null
        : "Typical speed of " + Math.round(medianSpeed) + " units per second is far above a " +
          "sprint, so this track is a spectator or a free camera rather than a player."
    });
  }
  return out
    .sort((a, b) => (b.playing ? 1 : 0) - (a.playing ? 1 : 0) ||
                    b.strafeJumpShare - a.strafeJumpShare);
}

/* ---- assembly ---- */

/**
 * Everything, computed once.
 * Returns plain data with no references into the model, so it serialises.
 */
function analyseMatch(model){
  const throws = attributeGrenades(model);
  const lineups = findLineups(throws);
  const utility = utilityStats(model, throws);
  const duels = duelStats(model);
  const routes = routeStats(model);
  const movement = movementStats(model);

  const notes = [];
  if (!model.caps.positions) {
    notes.push("No position tracks in this demo, so routes, movement and " +
               "utility placement cannot be computed.");
  }
  if (throws.length && utility.attributedShare < 0.6) {
    notes.push("Only " + Math.round(utility.attributedShare * 100) + " per cent of grenades " +
               "could be attributed to a thrower. The demo does not record who threw " +
               "what, so each one is matched to the nearest player at the moment it " +
               "appeared; when the server was not sending that player there is no match.");
  }
  if (lineups.length) {
    notes.push(lineups.length + " repeated grenade lineups found, meaning the same throw " +
               "from the same place to the same place at least " + CFG.lineupMinUses +
               " times. Those are the ones an opponent can learn.");
  }

  return { throws, lineups, utility, duels, routes, movement, notes, cfg: CFG };
}

const API = { analyseMatch, attributeGrenades, findLineups, utilityStats,
              duelStats, routeStats, movementStats, median, CFG };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_ANALYSIS = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
