#!/usr/bin/env node
/*!
 * ffbatch.js - extract every multiplayer map the game ships, in one go.
 *
 *   node tools/ffbatch.js [mp_crash mp_bog ...]
 *
 * With no names it takes every zone/english/mp_*.ff that is a map (the
 * *_load zones are loading screens). For each one it runs the patched
 * OpenAssetTools Unlinker (see tools/oat/README.md), then ffworld.js, and at
 * the end modeltex.js once over every props folder so shared images are
 * decoded a single time.
 *
 * Environment:
 *   OAT_UNLINKER  the patched Unlinker.exe (required)
 *   COD4_ROOT     the game folder, if it is not in the default place
 *   FF_DUMP       where the raw dumps go (default: a folder in the OS temp dir)
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_ROOT = "C:/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare";
const REPO = path.join(__dirname, "..");

function fail(msg){
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function main(){
  const root = process.env.COD4_ROOT || DEFAULT_ROOT;
  const unlinker = process.env.OAT_UNLINKER;
  if (!unlinker || !fs.existsSync(unlinker)) {
    fail("Set OAT_UNLINKER to the patched Unlinker.exe (see tools/oat/README.md).");
  }
  const zoneDir = path.join(root, "zone", "english");
  if (!fs.existsSync(zoneDir)) fail("No zone folder at " + zoneDir + ". Set COD4_ROOT.");

  let maps = process.argv.slice(2);
  if (!maps.length) {
    maps = fs.readdirSync(zoneDir)
      .filter(f => /^mp_.*\.ff$/i.test(f) && !/_load\.ff$/i.test(f))
      .map(f => f.replace(/\.ff$/i, ""))
      .sort();
  }
  const dumpRoot = process.env.FF_DUMP || path.join(os.tmpdir(), "cod4-ff-dump");
  fs.mkdirSync(dumpRoot, { recursive: true });

  const done = [], failed = [];
  for (const map of maps) {
    const zone = path.join(zoneDir, map + ".ff");
    if (!fs.existsSync(zone)) { failed.push(map + " (no zone)"); continue; }
    const dump = path.join(dumpRoot, map);
    process.stdout.write("  " + map + ": dumping... ");
    const u = spawnSync(unlinker, [
      "--model-format", "GLB", "--image-format", "DDS",
      "--include-assets", "gfxworld,mapents,xmodel,material,image",
      "--search-path", path.join(root, "main"),
      "-o", dump, zone
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (u.status !== 0) { failed.push(map + " (unlinker exit " + u.status + ")"); process.stdout.write("failed\n"); continue; }

    process.stdout.write("converting\n");
    const c = spawnSync(process.execPath, [
      path.join(__dirname, "ffworld.js"), dump, map, path.join(REPO, "maps3d", map)
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(c.stdout || "");
    if (c.status !== 0) { failed.push(map + ": " + (c.stderr || "").trim()); continue; }
    done.push(map);
  }

  if (done.length) {
    process.stdout.write("  model textures...\n");
    const dirs = done.map(m => path.join(REPO, "maps3d", m, "props"))
      .filter(d => fs.existsSync(d));
    const t = spawnSync(process.execPath, [
      path.join(__dirname, "modeltex.js"), path.join(REPO, "maps3d", "images"), ...dirs
    ], { encoding: "utf8" });
    process.stdout.write(t.stdout || "");
    if (t.status !== 0) failed.push("modeltex: " + (t.stderr || "").trim());
  }

  process.stdout.write("\n  " + done.length + " maps built" +
    (failed.length ? ", " + failed.length + " failed:\n    " + failed.join("\n    ") : "") + "\n");
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) main();
