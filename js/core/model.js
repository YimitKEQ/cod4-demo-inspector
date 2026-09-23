/*!
 * model.js - the enriched match model.
 *
 * analyze() in dm1.js gives the raw match: kills, rounds, players, tracks.
 * This layer joins them into the shape every view needs: a kill that knows its
 * round, both positions, the distance, who was alive around it, and whether
 * the numbers came from the recorder or from entity state.
 *
 * No DOM, no browser APIs. Runs in the browser, in Node (CLI) and feeds the
 * JSON the Python cross-check reads.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

/* CoD4 world units are inches. 72 units is a standing player, which is the
   1.83 m that the player models actually are. */
const UNITS_PER_METRE = 39.3701;

/* A track sample older than this is not the player's position any more, it is
   the last place the server bothered to tell us about. Section 3 fact 1: never
   invent a position. Two seconds is the widest gap that still tracks a player
   walking a straight line; beyond it the position is dropped. */
const STALE_S = 2.0;

/* Distance gets a tighter rule than drawing does. Measured across real promod
   demos, 98 to 99 per cent of the samples at a kill instant are 0.04 s old:
   the server is sending both players because they are shooting each other.
   The rare stale one is exactly the sample that would invent a wrong figure,
   so a distance is only computed when both ends are this fresh. The cost is
   about five kills in 150 losing their distance; the gain is that no printed
   distance is fiction. */
const FRESH_FOR_DISTANCE_S = 0.5;

/* The recorder's own position comes from playerState every frame. Everyone
   else comes from entity state, which the server only sends when they are
   relevant to the recorder. Anything derived from the latter is approximate
   and is labelled as such all the way into the UI. */
const SRC_RECORDER = "recorder";
const SRC_ENTITY = "entity";
const SRC_NONE = "none";

/* Which client wrote this demo. It decides how world coordinates are decoded
   (snapshot.js switches to raw floats above protocol 17) and, later, which
   memory offsets the render worker needs, so the mapping lives in one place.
   Anything unrecognised is reported as the bare number rather than guessed. */
const PROTOCOLS = { 6: "stock 1.7", 20: "CoD4X", 21: "CoD4X" };

function protocolLabel(protocol){
  const name = PROTOCOLS[protocol];
  return name ? protocol + " (" + name + ")" : String(protocol);
}

/** Binary search: index of the last sample at or before t (seconds). */
function sampleIndexAt(track, t){
  /* Track timestamps are whole hundredths of a second, and t is seconds, so
     t * 100 lands just under an exact sample: 130.2 * 100 is
     13019.999999999998 in binary floating point, which makes a query at a
     sample's own time miss that sample and return the one before it. An
     epsilon far smaller than a hundredth of a second closes the gap without
     reaching any neighbouring sample. */
  const ts = t * 100 + 1e-6;
  let lo = 0, hi = track.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid][0] <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * Position of a client at a time, or null when the server was not sending them.
 * Returns { x, y, z, yaw, weapon, ageS, sample } so callers can see how fresh
 * the reading is instead of trusting a bare vector.
 */
function positionAt(tracks, client, t, staleS){
  const track = tracks[String(client)];
  if (!track || !track.length) return null;
  const i = sampleIndexAt(track, t);
  if (i < 0) return null;
  const p = track[i];
  const ageS = t - p[0] / 100;
  const limit = staleS === undefined ? STALE_S : staleS;
  if (limit !== null && ageS > limit) return null;
  return { x: p[1], y: p[2], z: p[3], yaw: p[4], weapon: p[5], ageS, sample: i };
}

/** Straight line distance in world units, or null if either side is unknown. */
function distanceUnits(a, b){
  if (!a || !b) return null;
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const toMetres = u => (u === null ? null : u / UNITS_PER_METRE);

/** Signed yaw difference in degrees, wrapped to -180..180. */
function yawDelta(from, to){
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Bearing in degrees from a to b, in CoD4's yaw convention. */
function bearing(a, b){
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
}

/**
 * Round each kill belongs to, plus the seconds since that round started.
 * Rounds come from the round timer, kills from the obituary feed, so a kill
 * landing in the gap between two rounds belongs to neither and gets round null
 * rather than being forced into the nearest one.
 */
function roundOf(rounds, tS){
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    // The same grace the parser uses when it slices kills into rounds.
    if (tS >= r.startS && tS <= r.startS + r.durS + 0.3) return i;
  }
  return -1;
}

/**
 * Build the enriched model.
 *
 * Everything downstream (highlight engine, kill browser, 3D view, renderer)
 * reads this and nothing else, so there is one understanding of a match.
 */
function buildModel(res){
  const tracks = (res.map && res.map.tracks) || {};
  const povClient = res.info.povClient;

  const playerBy = new Map();
  for (const p of res.players) playerBy.set(p.client, p);

  const teamNames = res.teams.map(t => t.name);
  const teamOf = c => (playerBy.get(c) ? playerBy.get(c).team : null);
  const nameOf = c => (playerBy.get(c) ? playerBy.get(c).name : ("client " + c));

  /* Roster per team, as the set of clients that ever appear on it. Players who
     join or leave mid match are handled per round below. */
  const rosters = new Map();
  for (const t of teamNames) rosters.set(t, res.players.filter(p => p.team === t).map(p => p.client));

  const kills = [];
  for (let i = 0; i < res.kills.length; i++) {
    const k = res.kills[i];
    const ri = roundOf(res.rounds, k.tS);
    const round = ri >= 0 ? res.rounds[ri] : null;

    const killerPos = k.suicide ? null : positionAt(tracks, k.killer, k.tS);
    const victimPos = positionAt(tracks, k.victim, k.tS);
    const bothFresh = !!killerPos && !!victimPos &&
      killerPos.ageS <= FRESH_FOR_DISTANCE_S && victimPos.ageS <= FRESH_FOR_DISTANCE_S;
    const units = bothFresh ? distanceUnits(killerPos, victimPos) : null;

    const kTeam = k.suicide ? null : teamOf(k.killer);
    const vTeam = teamOf(k.victim);

    /* Where the numbers come from decides how they are labelled. The recorder
       is exact; everyone else is entity state and therefore approximate. */
    const srcFor = (client, pos) => {
      if (!pos) return SRC_NONE;
      return client === povClient ? SRC_RECORDER : SRC_ENTITY;
    };
    const killerSrc = k.suicide ? SRC_NONE : srcFor(k.killer, killerPos);
    const victimSrc = srcFor(k.victim, victimPos);

    kills.push({
      id: "k" + i,
      index: i,
      tS: k.tS,
      round: round ? round.n : null,
      roundIdx: ri,
      roundTS: round ? +(k.tS - round.startS).toFixed(2) : null,
      killer: k.suicide ? null : k.killer,
      victim: k.victim,
      killerName: k.suicide ? null : nameOf(k.killer),
      victimName: nameOf(k.victim),
      killerTeam: kTeam,
      victimTeam: vTeam,
      weapon: k.weapon,
      weaponLabel: k.weaponLabel,
      weaponId: k.weaponId,
      headshot: k.headshot,
      /* A headshot obituary carries the means of death in eventParm in place
         of the weapon id, so the weapon behind it is genuinely unknown. Every
         other means of death (melee, falling, explosive) does describe the
         real cause, so only this one case is unknown. */
      weaponKnown: !(k.headshot && k.weapon === "headshot"),
      suicide: k.suicide,
      teamkill: !k.suicide && kTeam !== null && kTeam === vTeam,
      killerPos, victimPos,
      killerPosSource: killerSrc,
      victimPosSource: victimSrc,
      distanceUnits: units === null ? null : Math.round(units),
      distanceM: units === null ? null : +toMetres(units).toFixed(1),
      heightDelta: bothFresh ? Math.round(killerPos.z - victimPos.z) : null,
      /* Approximate unless both ends are the recorder, which can only be the
         victim side, so in practice every distance is approximate. Said out
         loud rather than hidden. */
      distanceApprox: killerSrc === SRC_ENTITY || victimSrc === SRC_ENTITY,
      /* Crosshair offset at the moment of the kill: the angle between where
         the killer was facing and where the victim actually was. Only
         meaningful with both positions and the killer's yaw. */
      aimOffsetDeg: bothFresh
        ? Math.round(Math.abs(yawDelta(killerPos.yaw, bearing(killerPos, victimPos))))
        : null,
      tags: []
    });
  }

  /* Per round: who was alive when. Derived from the kill feed, which is the
     only honest source: the alive counters in the server commands lag and do
     not say who. */
  const roundStates = res.rounds.map((r, ri) => {
    const roundKills = kills.filter(k => k.roundIdx === ri);
    const endS = r.startS + r.durS;
    /* Who was on each side for this round.
     *
     * The connect and disconnect messages look authoritative and are not. In a
     * real demo one player's only MP_CONNECTED arrives at 1508 s of a 1537 s
     * match, because it is a late reconnect rather than their first
     * appearance; trusting it dropped them from every round, shrank their team
     * to four, and turned a four kill round into an ace.
     *
     * So evidence outranks the heuristic. A player who killed, died, or was
     * being transmitted during the round was demonstrably there, whatever the
     * messages say. The join and leave window is only consulted for players
     * who left no trace at all.
     */
    const played = new Set();
    for (const k of roundKills) {
      if (k.killer !== null) played.add(k.killer);
      played.add(k.victim);
    }
    const seenInRound = c => {
      const t = tracks[String(c)];
      if (!t || !t.length) return false;
      const i = sampleIndexAt(t, endS);
      return i >= 0 && t[i][0] / 100 >= r.startS;
    };

    const alive = new Map();
    for (const t of teamNames) {
      const inRound = (rosters.get(t) || []).filter(c => {
        const p = playerBy.get(c);
        if (!p) return false;
        if (played.has(c) || seenInRound(c)) return true;
        if (p.joinedS !== null && p.joinedS > endS) return false;
        if (p.leftS !== null && p.leftS < r.startS) return false;
        return true;
      });
      alive.set(t, inRound);
    }
    const deaths = roundKills.map(k => ({ tS: k.tS, client: k.victim, team: k.victimTeam }));
    return {
      n: r.n, idx: ri, startS: r.startS, endS, half: r.half,
      winner: r.winner, reason: r.reason,
      rosters: alive, kills: roundKills, deaths
    };
  });

  /** Clients still alive on a team at time t within a round. */
  function aliveAt(state, team, t){
    const dead = new Set(state.deaths.filter(d => d.tS <= t && d.team === team).map(d => d.client));
    return (state.rosters.get(team) || []).filter(c => !dead.has(c));
  }

  /* Bomb actions per round, lifted out of the round timeline so the highlight
     engine does not have to re-parse strings. */
  for (const state of roundStates) {
    const r = res.rounds[state.idx];
    state.bomb = (r.timeline || []).filter(e => e.kind === "bomb")
      .map(e => ({ tS: e.tS, action: e.action, player: e.player }));
    state.plant = state.bomb.find(b => /planted/i.test(b.action)) || null;
    state.defuse = state.bomb.find(b => /defused/i.test(b.action)) || null;
  }

  return {
    info: res.info,
    teams: res.teams,
    teamNames,
    players: res.players,
    playerBy,
    rosters,
    kills,
    rounds: res.rounds,
    roundStates,
    aliveAt,
    grenades: (res.map && res.map.grenades) || [],
    tracks,
    /* The world rectangle the compass image covers, from configstring 823.
       Empty when the demo did not carry one, in which case the views fall
       back to the extent of the tracks. */
    bounds: (res.map && res.map.bounds) || [],
    compass: (res.map && res.map.compass) || "",
    weaponNames: (res.map && res.map.weapons) || [],
    weaponFiles: (res.map && res.map.weaponFiles) || [],
    /* The recorder's view at full client rate; see js/core/pov.js. */
    pov: (res.map && res.map.pov) || null,
    /* Every shot fired, [ms since start, client]; from the event queues. */
    shots: (res.map && res.map.shots) || [],
    /* Each client's real side over time; the sides swap at half time. */
    sides: (res.map && res.map.sides) || {},
    chat: res.chat,
    events: res.events,
    nameOf, teamOf,
    /* Honest capability flags. The views read these to decide what to hide
       rather than showing an empty panel with no explanation. */
    caps: {
      killFeed: res.info.killFeed,
      statsSource: res.info.statsSource,
      positions: Object.keys(tracks).length > 0,
      trackedClients: Object.keys(tracks).length
    }
  };
}

const API = {
  buildModel, positionAt, distanceUnits, toMetres, yawDelta, bearing,
  sampleIndexAt, roundOf, protocolLabel, PROTOCOLS,
  UNITS_PER_METRE, STALE_S, FRESH_FOR_DISTANCE_S, SRC_RECORDER, SRC_ENTITY, SRC_NONE
};
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_MODEL = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
