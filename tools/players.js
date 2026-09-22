#!/usr/bin/env node
/*!
 * players.js - pull the multiplayer character models out of a dump.
 *
 * CoD4's multiplayer bodies live in the fastfiles like everything else, and
 * OpenAssetTools dumps them as glTF. They are skinned, with no animation
 * baked in, which means the vertex data as written is the rest pose: joint
 * matrices times inverse bind matrices come out as identity when nothing has
 * moved the skeleton. So the positions can be read straight, ignoring the
 * joints entirely, and the result is a soldier standing correctly.
 *
 *   node tools/players.js <oat model_export dir> maps3d/_players
 *
 * Two bodies are enough: the Marines and the OpFor regulars, which is exactly
 * the two sides of a promod match. Written once and shared by every map.
 *
 * Models are Activision's, like everything else under maps3d.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* One body per side, in preference order: the first that exists wins. The
   assault class is the plainest silhouette, which is what reads best at the
   distances this view uses. */
const SIDES = {
  allies: ["body_mp_usmc_assault", "body_mp_usmc_support",
           "body_mp_usmc_specops", "body_mp_usmc_recon"],
  opfor: ["body_mp_arab_regular_assault", "body_mp_arab_regular_support",
          "body_mp_arab_regular_cqb", "body_mp_arab_regular_engineer"]
};

/* Heads are separate models in CoD4; one per side keeps the silhouette right
   without dragging in the whole wardrobe. */
const HEADS = {
  allies: ["head_mp_usmc_nomex", "head_mp_usmc_tactical_baseball_cap",
           "head_mp_usmc_shaved_head"],
  opfor: ["head_mp_arab_regular_headwrap", "head_mp_arab_regular_ski_mask",
          "head_mp_arab_regular_asad"]
};

function findModel(dir, names){
  for (const name of names) {
    for (const suffix of ["_lod0.glb", ".glb", "_lod1.glb"]) {
      const f = path.join(dir, name + suffix);
      if (fs.existsSync(f)) return { name, file: f };
    }
  }
  return null;
}

function main(){
  const [modelDir, outDir] = process.argv.slice(2);
  if (!modelDir || !outDir) {
    process.stdout.write("  node tools/players.js <oat model_export dir> <out dir>\n");
    process.exit(1);
  }
  if (!fs.existsSync(modelDir)) {
    process.stderr.write("No such folder: " + modelDir + "\n");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const out = { format: "dm1-players-1", sides: {} };
  let found = 0;

  for (const side of ["allies", "opfor"]) {
    const body = findModel(modelDir, SIDES[side]);
    if (!body) {
      process.stdout.write("  no body model for " + side + "\n");
      continue;
    }
    const bodyFile = side + "_body.glb";
    fs.copyFileSync(body.file, path.join(outDir, bodyFile));
    const entry = { body: bodyFile, bodyName: body.name };

    const head = findModel(modelDir, HEADS[side]);
    if (head) {
      const headFile = side + "_head.glb";
      fs.copyFileSync(head.file, path.join(outDir, headFile));
      entry.head = headFile;
      entry.headName = head.name;
    }
    out.sides[side] = entry;
    found++;
    process.stdout.write("  " + side.padEnd(7) + " " + body.name +
      (head ? " + " + head.name : " (no head model found)") + "\n");
  }

  if (!found) {
    process.stderr.write("No character models in " + modelDir +
      ". Dump a fastfile that contains them, for example a multiplayer map.\n");
    process.exit(1);
  }

  fs.writeFileSync(path.join(outDir, "players.json"), JSON.stringify(out, null, 2));
  process.stdout.write("  written to " + outDir + "\n");
}

if (require.main === module) main();
module.exports = { SIDES, HEADS, findModel };
