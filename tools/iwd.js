#!/usr/bin/env node
/*!
 * iwd.js - read CoD4's .iwd archives and turn .iwi images into PNGs.
 *
 * The game's textures live in main/*.iwd, which are ordinary zip archives, and
 * inside them as .iwi files, which are a short header over DXT compressed
 * pixel data. Both formats are simple enough to read directly, so getting the
 * real textures needs no extra tooling at all: Node has zlib for the zip side
 * and the DXT decoders below handle the rest.
 *
 *   node tools/iwd.js index                    list what is in the archives
 *   node tools/iwd.js get <name> <out.png>     one image
 *   node tools/iwd.js for <geometry.json> <dir>  every texture a map needs
 *
 * Textures are Activision's. They are written outside the repository and stay
 * there; the reader is what ships.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DEFAULT_MAIN = "C:/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare/main";

/* ---- zip ---- */

/**
 * Index every entry of a zip without reading the payloads.
 * The central directory at the end lists everything, so one seek does it.
 */
function indexArchive(file){
  const fd = fs.openSync(file, "r");
  const size = fs.statSync(file).size;
  try {
    const tailLen = Math.min(66000, size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eo = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
    }
    if (eo < 0) return [];

    const count = tail.readUInt16LE(eo + 10);
    const cdSize = tail.readUInt32LE(eo + 12);
    const cdOff = tail.readUInt32LE(eo + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);

    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cdSize; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const cmtLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString("latin1", p + 46, p + 46 + nameLen);
      out.push({ file, name, method, compSize, localOff });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Pull one entry's bytes out. */
function readEntry(entry){
  const fd = fs.openSync(entry.file, "r");
  try {
    /* The local header repeats the name and extra lengths, and only it knows
       the real extra length, so the payload offset has to be read here. */
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.localOff);
    if (head.readUInt32LE(0) !== 0x04034b50) return null;
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = entry.localOff + 30 + nameLen + extraLen;
    const buf = Buffer.alloc(entry.compSize);
    fs.readSync(fd, buf, 0, entry.compSize, start);
    if (entry.method === 0) return buf;
    if (entry.method === 8) return zlib.inflateRawSync(buf);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/* ---- iwi ---- */

/* CoD4 ships version 6. The format byte says how the pixels are packed. */
const IWI_FORMATS = { 0x01: "ARGB32", 0x02: "RGB24", 0x03: "GA16", 0x04: "A8",
                      0x0B: "DXT1", 0x0C: "DXT3", 0x0D: "DXT5" };

/* Bytes per pixel block for the compressed formats, on a 4x4 block. */
const BLOCK_BYTES = { DXT1: 8, DXT3: 16, DXT5: 16 };

/**
 * Read an IWI header and return the full resolution image data.
 *
 * The layout that matters, and the part that is easy to get wrong: mipmaps are
 * stored SMALLEST FIRST, and the four offsets after the dimensions are the
 * ends of mip levels 0 to 3, with level 0 being the largest. So the full
 * resolution image is not at the start of the data, it is at the end, running
 * from mipOffsets[1] to mipOffsets[0], and mipOffsets[0] is the file length.
 *
 * Decoding from the start of the data instead decodes the smallest mip as
 * though it were the largest, which produces convincing looking noise.
 */
function parseIwi(buf){
  if (buf.length < 28) return null;
  if (buf.toString("latin1", 0, 3) !== "IWi") return null;
  const version = buf.readUInt8(3);
  const format = buf.readUInt8(4);
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const formatName = IWI_FORMATS[format] || ("0x" + format.toString(16));

  const headerSize = 28;
  const mip = [0, 1, 2, 3].map(i => buf.readInt32LE(12 + i * 4));
  const end = mip[0] > 0 ? Math.min(mip[0], buf.length) : buf.length;
  let start = (mip[1] > 0 && mip[1] < end) ? mip[1] : headerSize;

  /* Cross check against the size the format says the top mip must be. If the
     offsets disagree, trust the arithmetic. */
  const bb = BLOCK_BYTES[formatName];
  if (bb) {
    const expect = Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * bb;
    if (end - start !== expect && end - expect >= headerSize) start = end - expect;
  }

  return { version, format, formatName, width, height,
           data: buf.slice(start, end) };
}

/* ---- DXT decoding ---- */

function colourFrom565(c, out, o){
  out[o] = ((c >> 11) & 0x1f) * 255 / 31 | 0;
  out[o + 1] = ((c >> 5) & 0x3f) * 255 / 63 | 0;
  out[o + 2] = (c & 0x1f) * 255 / 31 | 0;
}

/** DXT1, DXT3 and DXT5 into straight RGBA. */
function decodeDXT(data, width, height, format){
  const blockBytes = format === "DXT1" ? 8 : 16;
  const bw = Math.max(1, (width + 3) >> 2);
  const bh = Math.max(1, (height + 3) >> 2);
  const out = new Uint8Array(width * height * 4);
  const c = new Uint8Array(16);
  const alpha = new Uint8Array(16);

  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (p + blockBytes > data.length) break;
      let ap = p;
      if (format === "DXT3") {
        for (let i = 0; i < 8; i++) {
          const b = data[ap + i];
          alpha[i * 2] = (b & 0x0f) * 17;
          alpha[i * 2 + 1] = (b >> 4) * 17;
        }
        p += 8;
      } else if (format === "DXT5") {
        const a0 = data[ap], a1 = data[ap + 1];
        const lut = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) {
          for (let i = 1; i < 7; i++) lut[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
        } else {
          for (let i = 1; i < 5; i++) lut[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0;
          lut[6] = 0; lut[7] = 255;
        }
        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(data[ap + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = lut[Number((bits >> BigInt(3 * i)) & 7n)];
        p += 8;
      } else {
        alpha.fill(255);
      }

      const c0 = data.readUInt16LE ? data.readUInt16LE(p) : (data[p] | (data[p + 1] << 8));
      const c1 = data.readUInt16LE ? data.readUInt16LE(p + 2) : (data[p + 2] | (data[p + 3] << 8));
      colourFrom565(c0, c, 0);
      colourFrom565(c1, c, 4);
      if (c0 > c1 || format !== "DXT1") {
        for (let k = 0; k < 3; k++) {
          c[8 + k] = (2 * c[k] + c[4 + k]) / 3 | 0;
          c[12 + k] = (c[k] + 2 * c[4 + k]) / 3 | 0;
        }
      } else {
        for (let k = 0; k < 3; k++) {
          c[8 + k] = (c[k] + c[4 + k]) / 2 | 0;
          c[12 + k] = 0;
        }
      }
      const bits = data[p + 4] | (data[p + 5] << 8) | (data[p + 6] << 16) | (data[p + 7] << 24);
      for (let i = 0; i < 16; i++) {
        const idx = (bits >>> (2 * i)) & 3;
        const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
        if (px >= width || py >= height) continue;
        const o = (py * width + px) * 4;
        out[o] = c[idx * 4];
        out[o + 1] = c[idx * 4 + 1];
        out[o + 2] = c[idx * 4 + 2];
        out[o + 3] = (format === "DXT1" && c0 <= c1 && idx === 3) ? 0 : alpha[i];
      }
      p += 8;
    }
  }
  return out;
}

function decodeIwi(iwi){
  const f = iwi.formatName;
  const { width, height, data } = iwi;
  if (f === "DXT1" || f === "DXT3" || f === "DXT5") return decodeDXT(data, width, height, f);
  const out = new Uint8Array(width * height * 4);
  if (f === "ARGB32") {
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1];
      out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = data[i * 4 + 3];
    }
    return out;
  }
  if (f === "RGB24") {
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = data[i * 3 + 2]; out[i * 4 + 1] = data[i * 3 + 1];
      out[i * 4 + 2] = data[i * 3]; out[i * 4 + 3] = 255;
    }
    return out;
  }
  return null;
}

/* ---- PNG ---- */

function crc32(buf){
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data){
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal PNG writer: one filter byte per row, deflate, done. */
function writePNG(rgba, width, height){
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---- index over every archive ---- */

function buildIndex(mainDir){
  const files = fs.readdirSync(mainDir)
    .filter(f => /\.iwd$/i.test(f))
    .map(f => path.join(mainDir, f))
    .sort();
  const byName = new Map();
  for (const f of files) {
    for (const e of indexArchive(f)) {
      /* Later archives patch earlier ones, so the last one wins. */
      byName.set(e.name.toLowerCase(), e);
    }
  }
  return byName;
}

/* Suffixes that mark a map other than colour. A normal or specular map in the
   diffuse slot looks like a bug, so these are never chosen. */
const NON_COLOUR = /(_nml|_nrm|_n|_spc|_s|_gloss|_add|_detail|_mask)$/;
/* Prefixes CoD4 uses for the map a material belongs to. The image often drops
   them, so me_trash01 is stored as trash01_col. */
const PREFIXES = ["me_", "ch_", "ct_", "ac_", "bc_", "cs_", "fx_", "mp_", "sp_"];

let colourNames = null;

/** Every colour image in the archives, as bare names. */
function colourIndex(index){
  if (colourNames) return colourNames;
  colourNames = [];
  for (const key of index.keys()) {
    if (!key.endsWith(".iwi")) continue;
    const bare = key.replace(/^images\//, "").replace(/\.iwi$/, "");
    if (bare.startsWith("~") || bare.startsWith("$")) continue;
    if (NON_COLOUR.test(bare)) continue;
    colourNames.push(bare);
  }
  return colourNames;
}

/**
 * Resolve a material name to an image.
 *
 * The real mapping lives in the Material asset inside the fastfiles, which is
 * a much bigger job to read. In practice CoD4 names its images from the
 * material with a small set of transformations, so trying those in order of
 * confidence gets most of the way there, and a token match catches the rest.
 * Anything still unresolved is left untextured rather than given the wrong
 * picture.
 */
function findImage(index, name){
  const n = String(name).toLowerCase().replace(/^\*/, "");
  const bases = [n];

  for (const p of PREFIXES) if (n.startsWith(p)) bases.push(n.slice(p.length));
  /* Decal and detail variants share the base texture. */
  const undec = n.replace(/(_decal|_dec|_d)$/, "");
  if (undec !== n) {
    bases.push(undec);
    for (const p of PREFIXES) if (undec.startsWith(p)) bases.push(undec.slice(p.length));
  }

  const tries = [];
  for (const b of bases) {
    tries.push(b, b + "_col", b + "_c");
    /* me_cinderblock_wall2 is stored as me_cinderblock_wall. */
    const untrailed = b.replace(/\d+$/, "");
    if (untrailed !== b) tries.push(untrailed, untrailed + "_col");
  }

  for (const t of tries) {
    if (NON_COLOUR.test(t)) continue;
    const hit = index.get("images/" + t + ".iwi") || index.get(t + ".iwi");
    if (hit) return hit;
  }

  /* Last resort: the image sharing the most of the material's meaningful
     words. More than half of them has to match, so a single common word like
     "ground" cannot drag in something unrelated, and the shortest name wins
     because the least padded one is the base texture. */
  const tokens = n.split(/[_\s]+/).filter(w => w.length > 3);
  if (!tokens.length) return null;
  let best = null, bestScore = 0;
  for (const bare of colourIndex(index)) {
    let score = 0;
    for (const w of tokens) if (bare.includes(w)) score++;
    if (score * 2 < tokens.length || score === 0) continue;
    const s = score * 1000 - bare.length;
    if (s > bestScore) { bestScore = s; best = bare; }
  }
  return best ? index.get("images/" + best + ".iwi") : null;
}

function extract(index, name){
  const entry = findImage(index, name);
  if (!entry) return null;
  const raw = readEntry(entry);
  if (!raw) return null;
  const iwi = parseIwi(raw);
  if (!iwi) return null;
  const rgba = decodeIwi(iwi);
  if (!rgba) return { iwi, png: null };
  return { iwi, png: writePNG(rgba, iwi.width, iwi.height) };
}

/* ---- cli ---- */

function main(){
  const [cmd, a, b] = process.argv.slice(2);
  const mainDir = process.env.COD4_MAIN || DEFAULT_MAIN;
  if (!fs.existsSync(mainDir)) {
    process.stderr.write("No CoD4 main folder at " + mainDir +
                         ". Set COD4_MAIN to point at it.\n");
    process.exit(1);
  }

  if (cmd === "index") {
    const index = buildIndex(mainDir);
    const images = [...index.keys()].filter(k => k.endsWith(".iwi"));
    process.stdout.write("  " + index.size.toLocaleString() + " entries, " +
      images.length.toLocaleString() + " images\n");
    for (const k of images.slice(0, 12)) process.stdout.write("    " + k + "\n");
    return;
  }

  if (cmd === "get") {
    const index = buildIndex(mainDir);
    const r = extract(index, a);
    if (!r) { process.stderr.write("Not found: " + a + "\n"); process.exit(1); }
    if (!r.png) {
      process.stderr.write("Unsupported format " + r.iwi.formatName + " for " + a + "\n");
      process.exit(1);
    }
    fs.writeFileSync(b || (a + ".png"), r.png);
    process.stdout.write("  " + a + "  " + r.iwi.width + "x" + r.iwi.height + "  " +
      r.iwi.formatName + "  ->  " + (b || (a + ".png")) + "\n");
    return;
  }

  if (cmd === "for") {
    const manifest = JSON.parse(fs.readFileSync(a, "utf8"));
    const outDir = b;
    fs.mkdirSync(outDir, { recursive: true });
    const index = buildIndex(mainDir);
    const wanted = manifest.materials.map(m => m.material);
    const done = {}, missing = [];
    let bytes = 0;
    for (const name of wanted) {
      const r = extract(index, name);
      if (!r || !r.png) { missing.push(name); continue; }
      const file = name.replace(/[^\w.-]/g, "_") + ".png";
      fs.writeFileSync(path.join(outDir, file), r.png);
      done[name] = { file, width: r.iwi.width, height: r.iwi.height,
                     format: r.iwi.formatName };
      bytes += r.png.length;
    }
    fs.writeFileSync(path.join(outDir, "textures.json"),
      JSON.stringify({ textures: done, missing }, null, 2));
    process.stdout.write("\n  " + Object.keys(done).length + " of " + wanted.length +
      " materials textured, " + (bytes / 1048576).toFixed(1) + " MB\n");
    if (missing.length) {
      process.stdout.write("  no image found for: " + missing.slice(0, 10).join(", ") +
        (missing.length > 10 ? " and " + (missing.length - 10) + " more" : "") + "\n");
    }
    process.stdout.write("\n");
    return;
  }

  process.stdout.write([
    "  node tools/iwd.js index",
    "  node tools/iwd.js get <material> <out.png>",
    "  node tools/iwd.js for <geometry.json> <texture dir>",
    ""
  ].join("\n"));
}

if (require.main === module) main();
module.exports = { buildIndex, findImage, extract, parseIwi, decodeIwi, writePNG, indexArchive };
