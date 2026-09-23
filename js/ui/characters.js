/*!
 * characters.js - dress every soldier the way promod dressed him.
 *
 * The rule, from the game's own scripts (tools/characters.js has the details):
 * the map picks the faction set per side (desert, urban, woodland), and
 * promod picks the body from the player's primary weapon class: SMG gets the
 * specops body, sniper rifle the sniper, shotgun the recon, anything else
 * the assault. Sides swap at half time, so the side is read at the moment.
 *
 * The primary weapon is the one a player carried most in the round, leaving
 * out pistols and grenades, which every class carries.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const SIDEARM = /^(usp|colt45|beretta|deserteagle|deserteaglegold)/;
const THROWN = /grenade|c4|claymore|rpg|at4/;
const SHOTGUN = /^(m1014|winchester1200)/;

/** The side a client played at tMs: "allies", "axis", or null. */
function sideAt(sides, client, tMs){
  const rows = sides && sides[String(client)];
  if (!rows || !rows.length) return null;
  let side = rows[0][1];
  for (const [t, s] of rows) { if (t <= tMs) side = s; else break; }
  return side;
}

/**
 * Promod's class for a weapon file name ("ak74u_silencer_mp"), from the
 * weapon definition where it can: its player anim type says smg or sniper.
 */
function classOfWeapon(file, defs){
  const name = String(file || "").toLowerCase();
  if (SHOTGUN.test(name)) return "RECON";
  const def = defs && defs[name];
  const type = def && def.playerAnimType;
  if (type === "smg") return "SPECOPS";
  if (type === "sniper") return "SNIPER";
  return "ASSAULT";
}

/** The primary weapon a client carried most between two times (hundredths). */
function primaryWeapon(track, fromH, toH, weaponFiles){
  if (!track) return null;
  const count = new Map();
  for (const s of track) {
    if (s[0] < fromH) continue;
    if (s[0] > toH) break;
    const f = weaponFiles[s[5]];
    if (!f || SIDEARM.test(f) || THROWN.test(f)) continue;
    count.set(f, (count.get(f) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [f, c] of count) if (c > n) { best = f; n = c; }
  return best;
}

/**
 * The character name for a client in a round:
 *   spec   characters.json
 *   map    the map name (aliases already resolved)
 */
function characterFor(spec, model, map, client, round, defs){
  if (!spec || !round) return null;
  const side = sideAt(model.sides, client, round.startS * 1000 + 1000) || "allies";
  const type = (spec.maps[map] && spec.maps[map][side]) || "desert";
  const set = spec.sets[type] && spec.sets[type][side];
  if (!set) return null;
  const endS = round.endS !== undefined ? round.endS : round.startS + round.durS;
  const weapon = primaryWeapon(model.tracks[String(client)], round.startS * 100,
                               endS * 100, model.weaponFiles);
  const cls = weapon ? classOfWeapon(weapon, defs) : "ASSAULT";
  return set[cls] || set.ASSAULT || null;
}

/** Loads and caches one template per character (body plus head). */
function createWardrobe(THREE){
  const templates = new Map();
  let spec = null;
  function setSpec(s){ spec = s; }
  function template(name){
    if (templates.has(name)) return templates.get(name);
    const c = spec && spec.chars[name];
    const SK = root.DM1_SKINNED;
    if (!c || !c.body || !SK) return Promise.resolve(null);
    const urls = [c.body, c.head].filter(Boolean).map(f => "maps3d/_players/chars/" + f);
    const job = SK.loadTemplate(THREE, urls).catch(err => {
      console.warn("character " + name + ": " + (err && err.message ? err.message : err));
      return null;
    });
    templates.set(name, job);
    return job;
  }
  return { setSpec, template, get spec(){ return spec; } };
}

const API = { sideAt, classOfWeapon, primaryWeapon, characterFor, createWardrobe };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_CHARACTERS = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
