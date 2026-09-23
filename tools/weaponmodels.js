#!/usr/bin/env node
/*!
 * weaponmodels.js - the guns, for first person and for the soldiers' hands.
 *
 *   node tools/weaponmodels.js <model_export dir> <xanim_json dir> <weapon names json>
 *
 * For every weapon named (the ones the demos actually use), copies:
 *   maps3d/weapons/world/<worldModel>.glb   what other players hold
 *   maps3d/weapons/view/<gunModel>.glb      the first person gun
 *   maps3d/weapons/view/<handModel>.glb     the first person arms
 *   maps3d/weapons/anims/<weapon>.json      its first person animations
 * and writes the file names back into maps3d/_players/weapons.json.
 *
 * The animations are keyed by the game's weapon animation numbers, the value
 * the player state carries as weapAnim: 0 idle, 2 fire, 13 reload, 23 to 25
 * sprint and so on (WEAP_ANIM below). That table was checked against a real
 * demo, where every number arrives together with the weapon state it belongs
 * to: reload with RELOADING, raise with RAISING, the sprint three with the
 * three sprint states.
 *
 * Everything written is Activision's, like the rest of maps3d.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { decodeClip } = require("./xanim");
const { findModel } = require("./props");
const { safeName } = require("./modeltex");

const REPO = path.join(__dirname, "..");
const OUT = path.join(REPO, "maps3d", "weapons");
const WEAPONS_JSON = path.join(REPO, "maps3d", "_players", "weapons.json");

/* weapAnimNumber_t, and the weapon definition field that holds each clip. */
const WEAP_ANIM = {
  0: "idleAnim", 1: "idleAnim", 2: "fireAnim", 3: "lastShotAnim", 4: "rechamberAnim",
  5: "adsFireAnim", 6: "adsLastShotAnim", 7: "adsRechamberAnim", 8: "meleeAnim",
  9: "meleeChargeAnim", 10: "dropAnim", 11: "raiseAnim", 12: "firstRaiseAnim",
  13: "reloadAnim", 14: "reloadEmptyAnim", 15: "reloadStartAnim", 16: "reloadEndAnim",
  17: "altDropAnim", 18: "altRaiseAnim", 19: "quickDropAnim", 20: "quickRaiseAnim",
  21: "emptyDropAnim", 22: "emptyRaiseAnim", 23: "sprintInAnim", 24: "sprintLoopAnim",
  25: "sprintOutAnim", 26: "detonateAnim"
};
/* Clips that loop; everything else plays once and holds its last frame. */
const LOOPING = new Set(["idleAnim", "sprintLoopAnim"]);

/* Promod staples, in case no demo on disk happened to use them. */
const ALWAYS = ["ak47_mp", "remington700_mp", "frag_grenade_mp", "flash_grenade_mp", "smoke_grenade_mp"];

function copyModel(modelDir, name, dest){
  if (!name) return null;
  const src = findModel(modelDir, name);
  if (!src) return null;
  const file = safeName(name) + ".glb";
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(src, path.join(dest, file));
  return file;
}

function main(){
  const [modelDir, animDir, usedFile] = process.argv.slice(2);
  if (!modelDir || !animDir || !usedFile) {
    process.stdout.write("  node tools/weaponmodels.js <model_export dir> <xanim_json dir> <weapon names json>\n");
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(WEAPONS_JSON, "utf8"));
  const used = new Set(JSON.parse(fs.readFileSync(usedFile, "utf8")).concat(ALWAYS));
  const missing = [];
  let packed = 0, animBytes = 0;

  for (const name of used) {
    const w = spec.weapons[name];
    if (!w) { missing.push(name + " (no definition)"); continue; }
    w.worldFile = copyModel(modelDir, w.worldModel, path.join(OUT, "world"));
    w.viewFile = copyModel(modelDir, w.gunModel, path.join(OUT, "view"));
    w.handFile = copyModel(modelDir, w.handModel, path.join(OUT, "view"));
    if (!w.worldFile) missing.push(name + " world model " + w.worldModel);
    if (!w.viewFile) missing.push(name + " view model " + w.gunModel);

    /* Decode each distinct clip once; the numbers point at clip names. */
    const clips = {}, byNumber = {};
    const wanted = Object.entries(WEAP_ANIM).concat([["adsUp", "adsUpAnim"], ["adsDown", "adsDownAnim"]]);
    for (const [num, field] of wanted) {
      const clipName = w[field];
      if (!clipName) continue;
      const file = path.join(animDir, clipName + ".json");
      if (!fs.existsSync(file)) { missing.push(name + " anim " + clipName); continue; }
      if (!clips[clipName]) {
        const decoded = decodeClip(JSON.parse(fs.readFileSync(file, "utf8")));
        /* The game decides looping from the weapon code, not the file. */
        decoded.loop = LOOPING.has(field);
        /* First person clips carry absolute bone positions, unlike the body
           clips, whose translations are offsets on the rest pose. */
        decoded.absoluteTrans = true;
        clips[clipName] = Object.assign({ name: clipName }, decoded);
      }
      byNumber[num] = clipName;
    }
    if (Object.keys(clips).length) {
      fs.mkdirSync(path.join(OUT, "anims"), { recursive: true });
      const animFile = safeName(name) + ".json";
      const text = JSON.stringify({ format: "dm1-weapon-anims-1", weapon: name, byNumber, clips });
      fs.writeFileSync(path.join(OUT, "anims", animFile), text);
      w.animFile = animFile;
      animBytes += text.length;
    }
    packed++;
  }

  fs.writeFileSync(WEAPONS_JSON, JSON.stringify(spec));
  process.stdout.write("  " + packed + " weapons packed, animations " +
    (animBytes / 1048576).toFixed(1) + " MB\n");
  if (missing.length) process.stdout.write("  missing:\n    " + missing.join("\n    ") + "\n");
}

if (require.main === module) main();
module.exports = { WEAP_ANIM };
