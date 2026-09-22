#!/usr/bin/env node
/*!
 * extract.js - one command to turn a map into something the 3D view can load.
 *
 *   node tools/extract.js <map.map> [mp_crash]
 *
 * Runs the three steps in order:
 *
 *   1. mapsrc.js   the Radiant source into geometry, grouped per material
 *   2. iwd.js      the game's own textures for those materials, out of the
 *                  .iwd archives, decoded to PNG
 *   3. props.js    the misc_model placements, plus the models themselves if
 *                  OpenAssetTools has dumped them
 *
 * Step three needs the models dumped first, which is the one part this cannot
 * do for itself because it needs OpenAssetTools:
 *
 *   Unlinker.exe --model-format GLB --image-format DDS \
 *     --include-assets xmodel,material,image \
 *     --search-path "<CoD4>/main" -o dump "<CoD4>/zone/english/mp_crash.ff"
 *
 * Point OAT_MODELS at that dump's model_export folder. Without it the map
 * still builds, just without its clutter.
 *
 * Everything written is Activision's and lands in maps3d/, which is ignored by
 * git on purpose. The tools ship; the output does not.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function run(script, args){
  try {
    const out = execFileSync(process.execPath,
      [path.join(__dirname, script), ...args], { encoding: "utf8" });
    process.stdout.write(out);
    return true;
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    return false;
  }
}

function main(){
  const [mapFile, nameArg] = process.argv.slice(2);
  if (!mapFile) {
    process.stdout.write("  node tools/extract.js <map.map> [map name]\n");
    process.exit(1);
  }
  if (!fs.existsSync(mapFile)) {
    process.stderr.write("No such file: " + mapFile + "\n");
    process.exit(1);
  }

  /* The map name has to match what the demo's gamestate reports, because that
     is what the viewer looks up. mp_backlot_x and mp_backlot share geometry,
     so a source named backlot serves both once it is placed under each name. */
  const name = nameArg || path.basename(mapFile).replace(/\.map$/i, "");
  const outDir = path.join("maps3d", name);

  process.stdout.write("\n  Building " + name + "\n");

  if (!run("mapsrc.js", [mapFile, outDir])) {
    process.stderr.write("  geometry failed, stopping\n");
    process.exit(1);
  }

  const manifest = path.join(outDir, "geometry.json");
  if (!run("iwd.js", ["for", manifest, path.join(outDir, "textures")])) {
    process.stdout.write("  textures failed; the map will use tinted materials\n");
  }

  const models = process.env.OAT_MODELS;
  if (models && fs.existsSync(models)) {
    run("props.js", [mapFile, models, outDir]);
    /* The character models are shared by every map, so they are written once
       into maps3d/_players rather than per map. */
    if (!fs.existsSync(path.join("maps3d", "_players", "players.json"))) {
      run("players.js", [models, path.join("maps3d", "_players")]);
    }
    /* The exporter names each model's textures as .dds files beside it and
       writes neither the files nor a format a browser can read, so without
       this step every prop and every character draws flat grey. The images
       come out of the game's archives under the same names. */
    run("modeltex.js", [path.join("maps3d", "images"),
                        path.join(outDir, "props"),
                        path.join("maps3d", "_players")]);
  } else {
    process.stdout.write("  no prop models: set OAT_MODELS to an " +
      "OpenAssetTools model_export folder to add the map's clutter\n\n");
  }

  process.stdout.write("  Done. Open the app and load a demo on " + name + ".\n\n");
}

if (require.main === module) main();
