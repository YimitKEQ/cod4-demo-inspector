#!/usr/bin/env node
/*!
 * props.js - collect a map's prop placements and the models they point at.
 *
 * A Radiant .map lists every prop as a misc_model entity: a model name, an
 * origin, Euler angles and a scale. The models themselves live in the
 * fastfiles, which OpenAssetTools can dump as glTF:
 *
 *   Unlinker.exe --model-format GLB --image-format DDS \
 *     --include-assets xmodel,material,image --search-path <CoD4>/main \
 *     -o dump <CoD4>/zone/english/mp_crash.ff
 *
 * This reads the placements, copies only the models the map actually uses, and
 * writes props.json. mp_crash needs 25 models for 2,433 placements, so the
 * viewer draws them as instances: one draw call per model, whatever the count.
 *
 *   node tools/props.js <map.map> <oat model_export dir> <output dir>
 *
 * Models are Activision's and stay out of the repository, like the textures.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** Every misc_model entity, in order. */
function readPlacements(text){
  const out = [];
  const re = /\{[^{}]*"classname"\s+"misc_model"[^{}]*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[0];
    const pick = key => {
      const hit = block.match(new RegExp('"' + key + '"\\s+"([^"]*)"'));
      return hit ? hit[1] : null;
    };
    const model = pick("model");
    const origin = pick("origin");
    if (!model || !origin) continue;
    const o = origin.trim().split(/\s+/).map(Number);
    if (o.length < 3 || !o.every(Number.isFinite)) continue;
    const a = (pick("angles") || "0 0 0").trim().split(/\s+/).map(Number);
    const scale = Number(pick("modelscale") || "1") || 1;
    out.push({
      model,
      /* CoD angles are pitch, yaw, roll about Y, Z and X. */
      pos: [o[0], o[1], o[2]],
      ang: [a[0] || 0, a[1] || 0, a[2] || 0],
      scale
    });
  }
  return out;
}

/** The dumped file for a model, preferring the highest detail level. */
function findModel(dir, name){
  for (const suffix of ["_lod0.glb", ".glb", "_lod1.glb", "_lod2.glb"]) {
    const f = path.join(dir, name + suffix);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function main(){
  const [mapFile, modelDir, outDir] = process.argv.slice(2);
  if (!mapFile || !modelDir || !outDir) {
    process.stdout.write(
      "  node tools/props.js <map.map> <oat model_export dir> <output dir>\n");
    process.exit(1);
  }

  const text = fs.readFileSync(mapFile, "latin1");
  const placements = readPlacements(text);
  if (!placements.length) {
    process.stderr.write("No misc_model entities in " + mapFile + "\n");
    process.exit(1);
  }

  const used = new Map();
  for (const p of placements) used.set(p.model, (used.get(p.model) || 0) + 1);

  const propsDir = path.join(outDir, "props");
  fs.mkdirSync(propsDir, { recursive: true });

  const models = [];
  const indexOf = new Map();
  const missing = [];
  let bytes = 0;
  for (const [name] of [...used.entries()].sort((a, b) => b[1] - a[1])) {
    const src = findModel(modelDir, name);
    if (!src) { missing.push(name); continue; }
    const file = name.replace(/[^\w.-]/g, "_") + ".glb";
    fs.copyFileSync(src, path.join(propsDir, file));
    bytes += fs.statSync(src).size;
    indexOf.set(name, models.length);
    models.push({ name, file, uses: used.get(name) });
  }

  /* Flat arrays keep the file small: 2,433 instances as objects is a lot of
     repeated key names. */
  const inst = { model: [], x: [], y: [], z: [], pitch: [], yaw: [], roll: [], scale: [] };
  let placed = 0;
  for (const p of placements) {
    const mi = indexOf.get(p.model);
    if (mi === undefined) continue;
    inst.model.push(mi);
    inst.x.push(p.pos[0]); inst.y.push(p.pos[1]); inst.z.push(p.pos[2]);
    inst.pitch.push(p.ang[0]); inst.yaw.push(p.ang[1]); inst.roll.push(p.ang[2]);
    inst.scale.push(p.scale);
    placed++;
  }

  fs.writeFileSync(path.join(outDir, "props.json"), JSON.stringify({
    format: "dm1-props-1",
    note: "Model placements from the map source. The .glb files beside this " +
          "are Activision's: keep them local.",
    models, instances: inst, missing
  }));

  process.stdout.write("\n  " + path.basename(mapFile) + "\n");
  process.stdout.write("    " + placements.length.toLocaleString() + " placements of " +
    used.size + " models\n");
  process.stdout.write("    " + models.length + " models copied (" +
    (bytes / 1048576).toFixed(1) + " MB), " + placed.toLocaleString() + " placed\n");
  if (missing.length) {
    process.stdout.write("    no model dumped for: " + missing.slice(0, 6).join(", ") +
      (missing.length > 6 ? " and " + (missing.length - 6) + " more" : "") + "\n");
  }
  process.stdout.write("    written to " + outDir + "\n\n");
}

if (require.main === module) main();
module.exports = { readPlacements, findModel };
