#!/usr/bin/env node
/*!
 * weapons.js - the numbers the first person camera needs from each weapon.
 *
 * OpenAssetTools dumps every WeaponDef as an info string,
 * "WEAPONFILE\key\value\key\value...". Most of it is irrelevant here; what the
 * camera needs is how far the weapon zooms when aiming down the sights and how
 * fast it gets there, plus the models, for a later viewmodel.
 *
 *   node tools/weapons.js <out weapons.json> <weapons dir> [<weapons dir>...]
 *
 * Later folders override earlier ones, so pass the stock dump first and a
 * mod's after it: promod tunes its weapons in its own mod.ff.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* The fields kept, and whether they are numbers. */
const KEEP = {
  displayName: false, playerAnimType: false, weaponClass: false, weaponType: false,
  adsZoomFov: true, adsZoomInFrac: true, adsZoomOutFrac: true,
  adsTransInTime: true, adsTransOutTime: true,
  gunModel: false, worldModel: false, handModel: false
};

/** An info string as a plain object. */
function parseInfoString(text){
  const parts = String(text).replace(/\r?\n$/, "").split("\\");
  if (parts[0] !== "WEAPONFILE") return null;
  const out = {};
  for (let i = 1; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}

function pick(raw){
  const out = {};
  for (const [k, isNum] of Object.entries(KEEP)) {
    if (raw[k] === undefined || raw[k] === "") continue;
    out[k] = isNum ? Number(raw[k]) : raw[k];
  }
  return out;
}

function main(){
  const [outFile, ...dirs] = process.argv.slice(2);
  if (!outFile || !dirs.length) {
    process.stdout.write("  node tools/weapons.js <out weapons.json> <weapons dir> [<weapons dir>...]\n");
    process.exit(1);
  }
  const weapons = {};
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) { process.stderr.write("No folder " + dir + "\n"); process.exit(1); }
    for (const name of fs.readdirSync(dir)) {
      const raw = parseInfoString(fs.readFileSync(path.join(dir, name), "latin1"));
      if (raw) weapons[name.toLowerCase()] = pick(raw);
    }
  }
  fs.writeFileSync(outFile, JSON.stringify({ format: "dm1-weapons-1",
    note: "From the game's WeaponDefs. Activision's data.", weapons }));
  process.stdout.write("  " + Object.keys(weapons).length + " weapons written to " + outFile + "\n");
}

if (require.main === module) main();
module.exports = { parseInfoString, pick };
