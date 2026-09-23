#!/usr/bin/env node
/*!
 * characters.js - every soldier wears what the game put on him.
 *
 *   node tools/characters.js <teams.gsc> <raw dir> <map raw root> <dump root>
 *
 * How CoD4 with promod dresses a player, and where each piece comes from:
 *   1. the map script sets the factions: game["allies_soldiertype"] = "desert"
 *      (maps/mp/<map>.gsc in the map's own fastfile);
 *   2. promod's _teams.gsc maps soldier type and class to an mptype script,
 *      game["allies_model"]["SPECOPS"] = mptype\mptype_ally_cqb::main;
 *   3. the mptype script names a character, the character script the body
 *      (setModel) and the head (attach);
 *   4. promod picks the class from the player's primary weapon
 *      (playerModelForWeapon): SMG specops, assault rifle assault, sniper,
 *      shotgun recon.
 * This writes maps3d/_players/characters.json with steps 1 to 3 resolved and
 * the models copied into maps3d/_players/chars/. Step 4 happens in the viewer,
 * from the weapons each player carried.
 *
 * Models are Activision's, like the rest of maps3d.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { findModel } = require("./props");
const { safeName } = require("./modeltex");

const OUT = path.join(__dirname, "..", "maps3d", "_players");

/** game["allies_model"]["CLASS"] = mptype\name::main, inside each soldier type block. */
function readTeams(text){
  const sets = {};
  let side = null, type = null;
  for (const line of text.split(/\r?\n/)) {
    const cond = line.match(/game\["(allies|axis)_soldiertype"\]\s*==\s*"(\w+)"/);
    if (cond) { side = cond[1]; type = cond[2]; continue; }
    /* The last branch of the soldier type chain is a bare else: woodland, in
       the stock and promod scripts alike. */
    if (/^\s*else\s*$/.test(line) && side) { type = "woodland"; continue; }
    const as = line.match(/game\["(allies|axis)_model"\]\["(\w+)"\]\s*=\s*mptype\\(\w+)::main/);
    if (!as) continue;
    const s = as[1], cls = as[2], mptype = as[3];
    const t = side === s ? type : "desert";
    if (/^CLASS_CUSTOM/.test(cls)) continue;
    ((sets[t] = sets[t] || {})[s] = sets[t][s] || {})[cls] = mptype;
  }
  return sets;
}

function characterOfMptype(rawDir, mptype){
  const f = path.join(rawDir, "mptype", mptype + ".gsc");
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, "latin1").match(/character\\(\w+)::main/);
  return m ? m[1] : null;
}

function modelsOfCharacter(rawDir, character){
  const f = path.join(rawDir, "character", character + ".gsc");
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, "latin1");
  const body = (text.match(/setModel\("([^"]+)"\)/) || [])[1];
  /* Some characters pick a random head from a list; the first is used. */
  const head = (text.match(/attach\("([^"]+)"/) || [])[1] ||
               (text.match(/codescripts\\character::randomElement\(\s*xmodelalias\\(\w+)/) || [])[1];
  /* The first person arms this character wears, e.g. viewhands_black_kit. */
  const hands = (text.match(/setViewmodel\("([^"]+)"\)/) || [])[1];
  return body ? { body, head: head || null, hands: hands || null } : null;
}

function mapFactions(mapRawRoot){
  const out = {};
  if (!fs.existsSync(mapRawRoot)) return out;
  for (const map of fs.readdirSync(mapRawRoot)) {
    const f = path.join(mapRawRoot, map, "maps", "mp", map + ".gsc");
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "latin1");
    const pick = key => (text.match(new RegExp('game\\["' + key + '"\\]\\s*=\\s*"(\\w+)"')) || [])[1];
    out[map] = { allies: pick("allies_soldiertype") || "desert", axis: pick("axis_soldiertype") || "desert" };
  }
  return out;
}

function findInDumps(dumpRoot, name){
  for (const d of fs.readdirSync(dumpRoot)) {
    const dir = path.join(dumpRoot, d, "model_export");
    if (!fs.existsSync(dir)) continue;
    const hit = findModel(dir, name);
    if (hit) return hit;
  }
  return null;
}

function main(){
  const [teamsFile, rawDir, mapRawRoot, dumpRoot] = process.argv.slice(2);
  if (!teamsFile || !rawDir || !mapRawRoot || !dumpRoot) {
    process.stdout.write("  node tools/characters.js <teams.gsc> <raw dir> <map raw root> <dump root>\n");
    process.exit(1);
  }
  const sets = readTeams(fs.readFileSync(teamsFile, "latin1"));
  const chars = {}, missing = [];
  const charDir = path.join(OUT, "chars");
  fs.mkdirSync(charDir, { recursive: true });

  for (const type of Object.keys(sets)) {
    for (const side of Object.keys(sets[type])) {
      for (const [cls, mptype] of Object.entries(sets[type][side])) {
        const character = characterOfMptype(rawDir, mptype);
        sets[type][side][cls] = character;
        if (!character || chars[character]) continue;
        const models = modelsOfCharacter(rawDir, character);
        if (!models) { missing.push(character); continue; }
        const entry = {};
        for (const part of ["body", "head", "hands"]) {
          const name = models[part];
          const src = name && findInDumps(dumpRoot, name);
          if (!src) { if (name) missing.push(name); continue; }
          const file = safeName(name) + ".glb";
          /* Arms live beside the first person guns, the rest with the bodies. */
          const dest = part === "hands" ? path.join(OUT, "..", "weapons", "view") : charDir;
          fs.mkdirSync(dest, { recursive: true });
          fs.copyFileSync(src, path.join(dest, file));
          entry[part] = file;
        }
        chars[character] = entry;
      }
    }
  }

  const maps = mapFactions(mapRawRoot);
  fs.writeFileSync(path.join(OUT, "characters.json"), JSON.stringify({
    format: "dm1-characters-1",
    note: "Promod's soldier sets, the characters they dress, and each map's factions. Activision's.",
    classByWeapon: { smg: "SPECOPS", assault: "ASSAULT", sniper: "SNIPER", shotgun: "RECON" },
    sets, chars, maps
  }, null, 1));
  process.stdout.write("  " + Object.keys(chars).length + " characters, " + Object.keys(maps).length +
    " maps" + (missing.length ? "; missing: " + missing.join(", ") : "") + "\n");
}

if (require.main === module) main();
module.exports = { readTeams, modelsOfCharacter };
