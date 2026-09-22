#!/usr/bin/env node
/*!
 * modeltex.js - give the extracted models their textures back.
 *
 * OpenAssetTools writes a GLB that names its images as external .dds files
 * sitting next to the model, but it does not write those files, and a browser
 * could not decode DDS if it did. So every prop and every character came out
 * flat grey: the geometry was right and the surface was missing.
 *
 * The images are in the game's own archives under the same names, and iwd.js
 * already knows how to read them, so the fix is to resolve each name the
 * models ask for and write it out once (as WebP, via tools/py/webp.py), into one shared folder that
 * every model reads from.
 *
 *   node tools/modeltex.js maps3d/images maps3d/mp_crash/props maps3d/_players
 *
 * Only colour maps are written. Normal and specular maps are named in the
 * models too, but nothing in the viewer reads them, and writing them would
 * triple the download for no visible difference.
 *
 * Colour maps are capped at 512 pixels on the long edge. The game ships many
 * of them at 1024, which is four times the bytes for a surface that is a few
 * dozen pixels tall on screen, and the whole point of this folder is that it
 * has to travel over a network before anything can be drawn.
 *
 * Images are Activision's, like everything else under maps3d.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildIndex, findImage, readEntry, parseIwi, decodeIwi,
        writePNG } = require("./iwd.js");

/* CoD material names carry variant suffixes like "desertshrubs#0", and a hash
   in a URL is a fragment: the browser would ask for "desertshrubs" and drop
   the rest, including the extension. The same mapping is applied in glb.js so
   both sides agree on the filename. */
const safeName = n => String(n).replace(/[^\w.-]/g, "_");

const DEFAULT_MAIN =
  "C:/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare/main";

/** The JSON chunk of a binary glTF, without touching the payload. */
function readGlbJson(file){
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return null;
  const total = buf.readUInt32LE(8);
  let p = 12;
  while (p + 8 <= Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(p);
    const type = buf.readUInt32LE(p + 4);
    const start = p + 8;
    if (type === 0x4e4f534a) {
      try { return JSON.parse(buf.slice(start, start + len).toString("utf8")); }
      catch (e) { return null; }
    }
    p = start + len + ((4 - (len % 4)) % 4);
  }
  return null;
}

/** Every .glb under a folder, one level deep is enough for how these are laid out. */
function glbsIn(dir){
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith(".glb"))
    .map(f => path.join(dir, f));
}

/**
 * The image names a model asks for, as bare names with no folder or extension.
 *
 * Only the base colour texture of each material is collected: that is the only
 * one the viewer samples.
 */
function colourImagesOf(json){
  const out = new Set();
  if (!json || !json.materials) return out;
  for (const mat of json.materials) {
    const tex = mat.pbrMetallicRoughness &&
                mat.pbrMetallicRoughness.baseColorTexture;
    if (!tex) continue;
    const t = json.textures && json.textures[tex.index];
    const img = t && json.images && json.images[t.source];
    if (!img || !img.uri) continue;
    out.add(path.basename(img.uri).replace(/\.[^.]+$/, "").toLowerCase());
  }
  return out;
}

/**
 * Halve an RGBA image until it fits, averaging each block of four.
 *
 * Averaging rather than dropping pixels matters here: these are photographic
 * surfaces, and point sampling them turns fine detail into noise that then
 * crawls as the camera moves.
 */
function shrinkToFit(rgba, width, height, max){
  let w = width, h = height, src = rgba;
  while (w > max || h > max) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const dst = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = x * 2, y0 = y * 2;
        const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
        const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4;
        const c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
        const o = (y * nw + x) * 4;
        for (let k = 0; k < 4; k++) {
          dst[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
        }
      }
    }
    src = dst; w = nw; h = nh;
  }
  return { rgba: src, width: w, height: h };
}

/** One image out of the archives, shrunk, as PNG bytes. */
function imageAsPng(index, name, max){
  const entry = findImage(index, name);
  if (!entry) return null;
  const raw = readEntry(entry);
  if (!raw) return null;
  const iwi = parseIwi(raw);
  if (!iwi) return null;
  const rgba = decodeIwi(iwi);
  if (!rgba) return null;
  const small = shrinkToFit(rgba, iwi.width, iwi.height, max);
  return { png: writePNG(small.rgba, small.width, small.height),
           width: small.width, height: small.height,
           from: iwi.width + "x" + iwi.height };
}

function main(){
  const argv = process.argv.slice(2);
  let max = 512;
  const maxAt = argv.indexOf("--max");
  if (maxAt >= 0) { max = parseInt(argv[maxAt + 1], 10) || max; argv.splice(maxAt, 2); }
  const [outDir, ...dirs] = argv;
  if (!outDir || !dirs.length) {
    process.stdout.write(
      "  node tools/modeltex.js <out dir> <glb dir> [<glb dir>...]\n");
    process.exit(1);
  }

  const mainDir = process.env.COD4_MAIN || DEFAULT_MAIN;
  if (!fs.existsSync(mainDir)) {
    process.stderr.write("No CoD4 main folder at " + mainDir +
                         ". Set COD4_MAIN to point at it.\n");
    process.exit(1);
  }

  const wanted = new Set();
  let models = 0;
  for (const dir of dirs) {
    for (const file of glbsIn(dir)) {
      const json = readGlbJson(file);
      if (!json) continue;
      models++;
      for (const name of colourImagesOf(json)) wanted.add(name);
    }
  }
  if (!wanted.size) {
    process.stderr.write("No textured models found in " + dirs.join(", ") + "\n");
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const index = buildIndex(mainDir);

  const missing = [];
  let written = 0, bytes = 0;
  for (const name of [...wanted].sort()) {
    const dest = path.join(outDir, safeName(name) + ".png");
    if (fs.existsSync(dest) || fs.existsSync(dest.replace(/\.png$/, ".webp"))) { written++; continue; }
    const r = imageAsPng(index, name, max);
    if (!r) { missing.push(name); continue; }
    fs.writeFileSync(dest, r.png);
    written++;
    bytes += r.png.length;
  }

  process.stdout.write("  " + models + " models asked for " + wanted.size +
    " colour maps\n  " + written + " written to " + outDir + ", " +
    Math.round(bytes / 1024) + " KB\n");
  if (missing.length) {
    process.stdout.write("  not in the archives: " + missing.join(", ") + "\n");
  }

  /* The viewer loads WebP; see tools/py/webp.py for why. */
  const py = spawnSync(process.env.PYTHON || "python",
    [path.join(__dirname, "py", "webp.py"), outDir], { encoding: "utf8" });
  process.stdout.write(py.status === 0 ? "  webp: " + py.stdout.trim() + "\n"
    : "  WebP conversion failed, and the viewer needs it: " + (py.stderr || "").trim() + "\n");
}

if (require.main === module) main();
module.exports = { readGlbJson, colourImagesOf, glbsIn, shrinkToFit, safeName };
