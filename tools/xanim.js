#!/usr/bin/env node
/*!
 * xanim.js - the game's own player animations, for the 3D view.
 *
 * The patched OpenAssetTools writes every XAnim as JSON with its bone tracks
 * still quantised (see tools/oat/README.md). This decodes the handful the
 * viewer uses into plain keyframes and writes them as one file:
 *
 *   node tools/xanim.js <xanim_json dir> maps3d/_players/anims.json
 *
 * Decoding, per bone:
 *   rotation   full quats are four int16, half quats are two (z and w, the
 *              bone only turns about its own Z), both over 32767. The NO_SIZE
 *              variants hold a single pose for the whole clip.
 *   position   small and full translations are mins + size * value, with
 *              value a byte or a uint16; NO_SIZE is one constant position.
 *   keys       idx lists the frame each key belongs to, so a track only
 *              stores the frames where the bone actually changes.
 *
 * Tracks are bone local, the same space as the model's joints, so they drop
 * straight onto the skeleton. Animations are Activision's, like the models.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* QuatType and TransType from OpenAssetTools' XAnimCommon.h. */
const Q = { NONE: 0, HALF: 1, FULL: 2, HALF_NO_SIZE: 3, FULL_NO_SIZE: 4 };
const T = { SMALL: 5, FULL: 6, NO_SIZE: 7, NONE: 8 };

/** The clips the viewer plays, by the role it plays them in. */
const CLIPS = {
  stand: "pb_stand_alert",
  walk_f: "pb_stand_shoot_walk_forward",
  walk_b: "pb_stand_shoot_walk_back",
  walk_l: "pb_stand_shoot_walk_left",
  walk_r: "pb_stand_shoot_walk_right",
  run_f: "pb_combatrun_forward_loop",
  run_b: "pb_combatrun_back_loop",
  run_l: "pb_combatrun_left_loop",
  run_r: "pb_combatrun_right_loop",
  sprint: "pb_sprint",
  crouch: "pb_crouch_alert",
  crouch_f: "pb_crouch_run_forward",
  crouch_b: "pb_crouch_run_back",
  crouch_l: "pb_crouch_run_left",
  crouch_r: "pb_crouch_run_right",
  prone: "pb_prone_aim",
  prone_f: "pb_prone_crawl",
  prone_b: "pb_prone_crawl_back",
  prone_l: "pb_prone_crawl_left",
  prone_r: "pb_prone_crawl_right",
  death_stand: "pb_stand_death_headchest_topple",
  death_run: "pb_death_run_forward_crumple",
  death_crouch: "pb_crouch_death_fetal"
};

const round = (v, k) => Math.round(v * k) / k;

function decodeQuats(q){
  const single = q.type === Q.HALF_NO_SIZE || q.type === Q.FULL_NO_SIZE;
  const full = q.type === Q.FULL || q.type === Q.FULL_NO_SIZE;
  const src = full ? q.v4 : q.v2;
  const width = full ? 4 : 2;
  const count = src.length / width;
  const out = [];
  for (let i = 0; i < count; i++) {
    let x = 0, y = 0, z, w;
    if (full) { x = src[i * 4]; y = src[i * 4 + 1]; z = src[i * 4 + 2]; w = src[i * 4 + 3]; }
    else { z = src[i * 2]; w = src[i * 2 + 1]; }
    const len = Math.hypot(x, y, z, w) || 1;
    out.push(x / len, y / len, z / len, w / len);
  }
  return { frames: single ? [0] : (q.idx.length ? q.idx : out.map((_, i) => i).slice(0, count)), values: out };
}

function decodeTrans(t){
  if (t.type === T.NO_SIZE) return { frames: [0], values: t.c.slice() };
  const src = t.type === T.SMALL ? t.u8 : t.u16;
  const out = [];
  for (let i = 0; i < src.length; i += 3) {
    out.push(t.mins[0] + t.size[0] * src[i],
             t.mins[1] + t.size[1] * src[i + 1],
             t.mins[2] + t.size[2] * src[i + 2]);
  }
  return { frames: t.idx.length ? t.idx : out.map((_, i) => i).filter(i => i < out.length / 3), values: out };
}

/** One clip as { fps, frames, loop, bones: { name: { t?, q?, p?, pt? } } }. */
function decodeClip(json){
  const bones = {};
  for (const b of json.bones) {
    const entry = {};
    if (b.q.type !== Q.NONE) {
      const q = decodeQuats(b.q);
      if (q.values.length) { entry.qt = q.frames; entry.q = q.values.map(v => round(v, 1e4)); }
    }
    if (b.t.type !== T.NONE) {
      const p = decodeTrans(b.t);
      if (p.values.length) { entry.pt = p.frames; entry.p = p.values.map(v => round(v, 1e3)); }
    }
    if (entry.q || entry.p) bones[b.name] = entry;
  }
  return { fps: json.fps, frames: json.frames, loop: !!json.looped, bones };
}

function main(){
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    process.stdout.write("  node tools/xanim.js <xanim_json dir> <out anims.json>\n");
    process.exit(1);
  }
  const clips = {}, missing = [];
  for (const [role, name] of Object.entries(CLIPS)) {
    const file = path.join(dir, name + ".json");
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    clips[role] = Object.assign({ name }, decodeClip(JSON.parse(fs.readFileSync(file, "utf8"))));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ format: "dm1-anims-1",
    note: "Player animations from common_mp.ff. Activision's.", clips }));
  process.stdout.write("  " + Object.keys(clips).length + " clips, " +
    Math.round(fs.statSync(out).size / 1024) + " KB" +
    (missing.length ? ", missing: " + missing.join(", ") : "") + "\n");
}

if (require.main === module) main();
module.exports = { decodeQuats, decodeTrans, decodeClip, CLIPS };
