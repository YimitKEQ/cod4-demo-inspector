#!/usr/bin/env node
/*!
 * ffworld.js - build a map for the 3D view straight out of the game's own
 * fastfile, for any stock map, with no Radiant source needed.
 *
 * Every CoD4 map ships its compiled render world inside
 * zone/english/<map>.ff: the exact triangles the game draws, the material on
 * each surface, and every static prop already placed. OpenAssetTools loads
 * that world but never had a writer for it, so ours adds one (the GfxWorld
 * dumper, see docs/DECISIONS.md) and this script turns its output into the
 * same files tools/mapsrc.js produces:
 *
 *   geometry.json + geometry.bin    the world, one range per material
 *   textures/                       each material's real colour map
 *   props.json + props/             static models and where they stand
 *
 *   node tools/ffworld.js <oat dump dir> <map> <output dir>
 *
 * The dump is made with:
 *
 *   Unlinker.exe --model-format GLB --image-format DDS \
 *     --include-assets gfxworld,mapents,xmodel,material,image \
 *     --search-path "<CoD4>/main" -o <dump> "<CoD4>/zone/english/<map>.ff"
 *
 * Unlike the Radiant path nothing here is guessed. The material names the
 * image it samples, the prop carries its own rotation matrix, and the
 * triangles are the ones the game renders. Anything that cannot be resolved
 * is reported and left out rather than approximated.
 *
 * Everything written is Activision's and lands in maps3d/.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildIndex, readEntry, parseIwi, decodeIwi, writePNG, decodeDXT } = require("./iwd");
const { shrinkToFit, safeName, readGlbJson } = require("./modeltex");
const { findModel } = require("./props");

const DEFAULT_MAIN = "C:/Program Files (x86)/Activision/Call of Duty 4 - Modern Warfare/main";

/* GfxWorldVertex, 44 bytes. */
const VERTEX = { xyz: 0, color: 16, uv: 20, lmap: 28, normal: 36, tangent: 40 };
/* TextureSemantic values from the game's Material. */
const TS_COLOR_MAP = 2;
/* GfxBlend and GfxCullFace values from the state bits. */
const BLEND_ZERO = 1, BLEND_ONE = 2;
const CULL_NONE = 1;

/* Techsets that are not drawn as world surfaces. */
const SKIP_TECHSET = /(^|[_/])(sky|shadowcaster|tools|distortion|portal)/i;
/* Helper surfaces the game draws for effects, not as scenery. */
const SKIP_MATERIAL = /(^|\/)(hdrportal|portal_|clip|caulk)/i;

/**
 * Unpack the game's 4 byte unit vector.
 * The fourth byte is a shared scale, which is how three bytes keep enough
 * precision for lighting: out = (byte - 127) * (w + 192) / 32385.
 */
function unpackUnitVec(buf, o, out, k){
  const scale = (buf[o + 3] + 192) / 32385;
  out[k] = (buf[o] - 127) * scale;
  out[k + 1] = (buf[o + 1] - 127) * scale;
  out[k + 2] = (buf[o + 2] - 127) * scale;
}

/* Technique slots in stateBitsEntry, in the order this renderer prefers. */
const TECHNIQUE_LIT_SUN = 8, TECHNIQUE_LIT = 7, TECHNIQUE_UNLIT = 4;
const NO_TECHNIQUE = 0xFF;

/**
 * The state bits of the pass that actually draws the surface.
 *
 * A material carries state bits for every technique it has, and several of
 * them are additive by design: each extra light in CoD4 is its own pass
 * blended ONE ONE on top. Reading all of them together marked every wall in
 * the map as translucent, which switched off its depth writes and let the
 * decals on it float in mid air with the wall gone. Only the lit pass says
 * how the surface itself is drawn.
 */
function litStateBits(material){
  const bits = material.stateBits || [];
  const entry = material.stateBitsEntry;
  if (Array.isArray(entry)) {
    for (const t of [TECHNIQUE_LIT_SUN, TECHNIQUE_LIT, TECHNIQUE_UNLIT]) {
      const i = entry[t];
      if (i !== undefined && i !== NO_TECHNIQUE && bits[i]) return [bits[i]];
    }
  }
  return bits.length ? [bits[0]] : [];
}

/**
 * What a material's state bits say about how it is drawn.
 * Any pass that blends makes the surface translucent, any alpha test makes
 * it a cutout, polygon offset marks a decal, and cull none makes it two sided.
 */
function drawStyle(material){
  let blend = false, alphaTest = false, decal = false, twoSided = false;
  for (const [a, b] of litStateBits(material)) {
    const src = a & 0xF, dst = (a >>> 4) & 0xF;
    const atestOff = (a >>> 11) & 1, atest = (a >>> 12) & 3;
    const cull = (a >>> 14) & 3;
    const polygonOffset = (b >>> 4) & 3;
    if (dst !== 0 && !(src === BLEND_ONE && dst === BLEND_ZERO)) blend = true;
    if (!atestOff && atest) alphaTest = true;
    if (polygonOffset) decal = true;
    if (cull === CULL_NONE) twoSided = true;
  }
  return { blend, alphaTest, decal, twoSided };
}

function colourImageOf(material){
  const t = (material.textures || []).find(x => x.semantic === TS_COLOR_MAP && x.image);
  return t ? t.image : null;
}

/**
 * The world as flat typed arrays plus index ranges grouped by material.
 *
 * Surface indices are stored relative to the surface's first vertex. That
 * is checked rather than assumed: if every index already falls inside the
 * surface's own span they are treated as absolute instead, so a dump from a
 * build that resolves them differently still comes out right.
 */
function readWorld(spec, bin){
  const n = spec.vertexCount;
  const stride = spec.vertexStride;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const color = new Uint8Array(n * 4);
  const uv1 = new Float32Array(n * 2);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const minB = [Infinity, Infinity, Infinity], maxB = [-Infinity, -Infinity, -Infinity];
  const nrm = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const o = i * stride;
    /* Game space is Z up; the scene is Y up. Same mapping as mapsrc.js:
       (x, y, z) -> (x, z, -y), for positions and normals alike. */
    const x = dv.getFloat32(o + VERTEX.xyz, true);
    const y = dv.getFloat32(o + VERTEX.xyz + 4, true);
    const z = dv.getFloat32(o + VERTEX.xyz + 8, true);
    position[i * 3] = x; position[i * 3 + 1] = z; position[i * 3 + 2] = -y;
    uv[i * 2] = dv.getFloat32(o + VERTEX.uv, true);
    uv[i * 2 + 1] = dv.getFloat32(o + VERTEX.uv + 4, true);
    uv1[i * 2] = dv.getFloat32(o + VERTEX.lmap, true);
    uv1[i * 2 + 1] = dv.getFloat32(o + VERTEX.lmap + 4, true);
    unpackUnitVec(bin, o + VERTEX.normal, nrm, 0);
    normal[i * 3] = nrm[0]; normal[i * 3 + 1] = nrm[2]; normal[i * 3 + 2] = -nrm[1];
    /* GfxColor is a D3DCOLOR: bytes in memory are B, G, R, A. */
    color[i * 4] = bin[o + VERTEX.color + 2];
    color[i * 4 + 1] = bin[o + VERTEX.color + 1];
    color[i * 4 + 2] = bin[o + VERTEX.color];
    color[i * 4 + 3] = bin[o + VERTEX.color + 3];
  }

  const idx = new Uint16Array(bin.buffer, bin.byteOffset + spec.indexOffset, spec.indexCount);
  const F = spec.surfaceFields;
  const at = name => F.indexOf(name);
  const fMat = at("material"), fFirst = at("firstVertex"), fCount = at("vertexCount");
  const fTri = at("triCount"), fBase = at("baseIndex"), fLmap = at("lightmap");
  const banks = (spec.lightmaps || []).length;

  const sky = new Set(spec.skySurfaces || []);
  const styles = spec.materials.map(drawStyle);
  const perMaterial = new Map();
  let relative = 0, absolute = 0;

  for (let s = 0; s < spec.surfaces.length; s++) {
    const surf = spec.surfaces[s];
    const mi = surf[fMat];
    if (mi < 0 || sky.has(s)) continue;
    const mat = spec.materials[mi];
    if (SKIP_TECHSET.test(mat.techset || "") || SKIP_MATERIAL.test(mat.name || "")) continue;

    const first = surf[fFirst], count = surf[fCount];
    const base = surf[fBase], triCount = surf[fTri];
    let inside = true;
    for (let k = 0; k < triCount * 3; k++) {
      const v = idx[base + k];
      if (v < first || v >= first + count) { inside = false; break; }
    }
    const offset = inside ? 0 : first;
    if (inside) absolute++; else relative++;

    /* One range per material and lightmap bank: a material that spans two
       banks needs two draws, one per lightmap texture. Index 31 is the
       game's marker for a surface with no lightmap at all. */
    const lm = fLmap >= 0 && surf[fLmap] >= 0 && surf[fLmap] < banks ? surf[fLmap] : -1;
    const key = mi + ":" + lm;
    if (!perMaterial.has(key)) perMaterial.set(key, []);
    const list = perMaterial.get(key);
    /* A bad index drops its whole triangle; dropping one vertex would shift
       every triangle after it. */
    for (let t = 0; t < triCount; t++) {
      const a = idx[base + t * 3] + offset;
      const b = idx[base + t * 3 + 1] + offset;
      const c = idx[base + t * 3 + 2] + offset;
      if (a >= n || b >= n || c >= n) continue;
      /* D3D winds front faces clockwise, WebGL counter clockwise. Keeping the
         game's order makes every face show its back, and a double sided
         material then lights it with the normal flipped: the whole world
         comes out black while the props beside it look fine. */
      list.push(a, c, b);
    }
  }

  /* Opaque first, then cutouts, decals, and blended last, which is also the
     order a renderer wants them in. */
  const matOf = key => Number(key.split(":")[0]);
  const lmOf = key => Number(key.split(":")[1]);
  const order = [...perMaterial.keys()].sort((a, b) => {
    const rank = st => (st.blend ? 3 : st.decal ? 2 : st.alphaTest ? 1 : 0);
    return rank(styles[matOf(a)]) - rank(styles[matOf(b)]) ||
      perMaterial.get(b).length - perMaterial.get(a).length;
  });

  let total = 0;
  for (const mi of order) total += perMaterial.get(mi).length;
  const index = new Uint32Array(total);
  const ranges = [];
  let p = 0;
  const used = new Uint8Array(n);
  for (const key of order) {
    const list = perMaterial.get(key);
    const mi = matOf(key);
    const mat = spec.materials[mi];
    ranges.push({
      material: mat.name,
      image: colourImageOf(mat),
      techset: mat.techset,
      lightmap: lmOf(key),
      /* Water is drawn by its own shader in the game; its colour map is a
         placeholder and must not be shown. */
      water: /water/i.test(mat.techset || ""),
      ...styles[mi],
      start: p,
      count: list.length
    });
    for (const v of list) { index[p++] = v; used[v] = 1; }
  }
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    /* Bounds are reported in game space, as the rest of the app expects. */
    const g = [position[i * 3], -position[i * 3 + 2], position[i * 3 + 1]];
    for (let k = 0; k < 3; k++) {
      if (g[k] < minB[k]) minB[k] = g[k];
      if (g[k] > maxB[k]) maxB[k] = g[k];
    }
  }

  return {
    position, normal, uv, uv1, color, index, ranges,
    bounds: { minX: minB[0], minY: minB[1], minZ: minB[2], maxX: maxB[0], maxY: maxB[1], maxZ: maxB[2] },
    indexing: { relative, absolute }
  };
}

/* ---- images ---- */

/** A DDS written by OpenAssetTools: header, then the largest mip first. */
function parseDds(buf){
  if (buf.length < 128 || buf.toString("latin1", 0, 4) !== "DDS ") return null;
  const height = buf.readUInt32LE(12), width = buf.readUInt32LE(16);
  const pfFlags = buf.readUInt32LE(80);
  const fourCC = buf.toString("latin1", 84, 88);
  let offset = 128;
  if (fourCC === "DX10") offset += 20;
  const data = buf.slice(offset);
  if (pfFlags & 0x4) {
    if (fourCC === "DXT1" || fourCC === "DXT3" || fourCC === "DXT5") {
      return { width, height, rgba: () => decodeDXT(data, width, height, fourCC) };
    }
    return null;
  }
  /* Uncompressed: only 32 bit BGRA is expected from the dumper. */
  const bits = buf.readUInt32LE(88);
  if (bits !== 32) return null;
  return {
    width, height,
    rgba: () => {
      const out = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1];
        out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = data[i * 4 + 3];
      }
      return out;
    }
  };
}

/**
 * One image by its exact name: the game archives first, where most colour
 * maps live, then the images the zone itself carried.
 */
function loadImage(index, dumpDir, rawName){
  /* A leading comma marks an image the game streams from the archives
     rather than carrying in the zone; the file itself has no comma. */
  const name = String(rawName).replace(/^[,*]+/, "");
  if (name.startsWith("$")) return null;
  const entry = index.get("images/" + name.toLowerCase() + ".iwi");
  if (entry) {
    const raw = readEntry(entry);
    const iwi = raw && parseIwi(raw);
    const rgba = iwi && decodeIwi(iwi);
    if (rgba) return { rgba, width: iwi.width, height: iwi.height, from: "iwd" };
  }
  const dds = path.join(dumpDir, "images", name + ".dds");
  if (fs.existsSync(dds)) {
    const img = parseDds(fs.readFileSync(dds));
    const rgba = img && img.rgba();
    if (rgba) return { rgba, width: img.width, height: img.height, from: "zone" };
  }
  return null;
}

/* ---- props ---- */

/**
 * Static models, grouped per model, with their full rotation matrix.
 * The matrix is the game's own, so there is no Euler order to get wrong.
 */
/** CoD's AnglesToAxis: pitch, yaw, roll in degrees to forward, left, up. */
function anglesToAxis(pitch, yaw, roll){
  const D = Math.PI / 180;
  const sp = Math.sin(pitch * D), cp = Math.cos(pitch * D);
  const sy = Math.sin(yaw * D), cy = Math.cos(yaw * D);
  const sr = Math.sin(roll * D), cr = Math.cos(roll * D);
  const forward = [cp * cy, cp * sy, -sp];
  const right = [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp];
  const up = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  return [...forward, -right[0], -right[1], -right[2], ...up];
}

/** The map's entities, as plain objects of their key/value pairs. */
function readEntities(text){
  const out = [];
  for (const block of String(text).match(/\{[^{}]*\}/g) || []) {
    const e = {};
    for (const m of block.matchAll(/"([^"]+)"\s+"([^"]*)"/g)) e[m[1]] = m[2];
    out.push(e);
  }
  return out;
}

/**
 * Script models that are part of the scenery in a Search and Destroy match:
 * destructibles (cars, barrels), which are cover and kill people, and the
 * S&D bomb sites. Other gametypes' objectives and pickups are left out, as
 * the game hides them too.
 */
function sceneryEntities(ents){
  const out = [];
  for (const e of ents) {
    if (e.classname !== "script_model" || !e.model || e.model.startsWith("*")) continue;
    const scenery = e.targetname === "destructible" ||
      (e.script_gameobjectname || "").split(/\s+/).includes("bombzone");
    if (!scenery) continue;
    const o = (e.origin || "0 0 0").split(/\s+/).map(Number);
    const a = (e.angles || "0 0 0").split(/\s+/).map(Number);
    if (o.length < 3 || !o.every(Number.isFinite)) continue;
    out.push({ model: e.model, origin: o.slice(0, 3),
               axis: anglesToAxis(a[0] || 0, a[1] || 0, a[2] || 0),
               scale: Number(e.modelscale) || 1 });
  }
  return out;
}

/**
 * How a model material is drawn, from the game's own Material as
 * OpenAssetTools dumps it (materials/<name>.json). Same rule as the world:
 * only the lit pass counts. The GLB export says "opaque, double sided" for
 * every material, which is why this has to come from the source.
 */
function propMaterialStyle(json){
  const entry = json && json.stateBitsEntry;
  const bits = json && json.stateBits;
  if (!Array.isArray(entry) || !Array.isArray(bits)) return null;
  /* No lit or unlit pass at all means the game never draws it: a proxy mesh
     that only casts shadows (trees carry one). Drawn, it is a solid blob. */
  if (/shadowcaster/i.test(json.techniqueSet || "")) return { shadowOnly: true };
  let sb = null;
  for (const t of [TECHNIQUE_LIT_SUN, TECHNIQUE_LIT, TECHNIQUE_UNLIT]) {
    const i = entry[t];
    if (Number.isInteger(i) && i >= 0 && bits[i]) { sb = bits[i]; break; }
  }
  if (!sb) return { shadowOnly: true };
  const style = {};
  if (sb.alphaTest && sb.alphaTest !== "disabled") style.alphaTest = true;
  if (sb.cullFace === "none") style.twoSided = true;
  if (sb.dstBlendRgb && sb.dstBlendRgb !== "zero" && sb.dstBlendRgb !== "disabled") style.blend = true;
  return style;
}

/** Style per material index of one GLB, from the dump's material files. */
function stylesForGlb(glbFile, dumpDir){
  const json = readGlbJson(glbFile);
  if (!json || !json.materials) return null;
  const out = {};
  json.materials.forEach((m, i) => {
    const file = path.join(dumpDir, "materials", String(m.name || "") + ".json");
    if (!m.name || !fs.existsSync(file)) return;
    try {
      const st = propMaterialStyle(JSON.parse(fs.readFileSync(file, "utf8")));
      if (st) out[i] = st;
    } catch (e) { /* an unreadable material keeps the loader's default */ }
  });
  return out;
}

function buildProps(spec, modelDir, outDir){
  const used = new Map();
  for (const s of spec.staticModels) {
    if (!s.model) continue;
    used.set(s.model, (used.get(s.model) || 0) + 1);
  }
  const propsDir = path.join(outDir, "props");
  fs.mkdirSync(propsDir, { recursive: true });

  const models = [], indexOf = new Map(), missing = [];
  let bytes = 0;
  for (const [name] of [...used.entries()].sort((a, b) => b[1] - a[1])) {
    const src = modelDir && findModel(modelDir, name);
    if (!src) { missing.push(name); continue; }
    const file = safeName(name) + ".glb";
    fs.copyFileSync(src, path.join(propsDir, file));
    bytes += fs.statSync(src).size;
    indexOf.set(name, models.length);
    const styles = stylesForGlb(src, path.dirname(modelDir));
    models.push(Object.assign({ name, file, uses: used.get(name) }, styles ? { styles } : {}));
  }

  const inst = { model: [], x: [], y: [], z: [], pitch: [], yaw: [], roll: [], scale: [], axis: [] };
  for (const s of spec.staticModels) {
    const mi = indexOf.get(s.model);
    if (mi === undefined) continue;
    inst.model.push(mi);
    inst.x.push(s.origin[0]); inst.y.push(s.origin[1]); inst.z.push(s.origin[2]);
    /* Angles stay for older readers; the axis is what the viewer uses. */
    inst.pitch.push(0); inst.yaw.push(0); inst.roll.push(0);
    inst.scale.push(s.scale || 1);
    for (const a of s.axis) inst.axis.push(Math.round(a * 1e5) / 1e5);
  }

  fs.writeFileSync(path.join(outDir, "props.json"), JSON.stringify({
    format: "dm1-props-1",
    source: "fastfile",
    note: "Static model placements from the compiled map. The .glb files beside this are Activision's.",
    models, instances: inst, missing
  }));
  return { models: models.length, placed: inst.model.length, missing, bytes };
}

/* ---- output ---- */

function toInt8(values){
  const out = new Int8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(values[i] * 127)));
  return out;
}

function writeGeometry(outDir, world, spec, mapName){
  const parts = [
    { name: "position", type: "Float32", components: 3, data: world.position },
    /* Unit normals need nowhere near 32 bit floats: 8 bits each, read back
       normalised, is a quarter of the bytes and invisible in the shading. */
    { name: "normal", type: "Int8", components: 3, normalized: true, data: toInt8(world.normal) },
    { name: "uv", type: "Float32", components: 2, data: world.uv },
    { name: "uv1", type: "Float32", components: 2, data: world.uv1 },
    { name: "index", type: "Uint32", components: 1, data: world.index }
  ];
  let offset = 0;
  const layout = parts.map(p => {
    /* Typed array views need their offset aligned to their element size. */
    const align = p.data.BYTES_PER_ELEMENT;
    offset = Math.ceil(offset / align) * align;
    const entry = { name: p.name, type: p.type, components: p.components,
                    byteOffset: offset, byteLength: p.data.byteLength };
    if (p.normalized) entry.normalized = true;
    offset += p.data.byteLength;
    return entry;
  });
  const bin = Buffer.alloc(offset);
  parts.forEach((p, i) => Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength)
    .copy(bin, layout[i].byteOffset));

  fs.writeFileSync(path.join(outDir, "geometry.bin"), bin);
  fs.writeFileSync(path.join(outDir, "geometry.json"), JSON.stringify({
    format: "dm1-geometry-1",
    source: mapName + ".ff",
    note: "The compiled render world from the game's fastfile. Activision's geometry.",
    uvSpace: "normalized",
    counts: { vertices: world.position.length / 3, indices: world.index.length },
    layout,
    bounds: world.bounds,
    ranges: world.ranges.map(r => ({
      material: r.material, start: r.start, count: r.count,
      blend: r.blend || undefined, alphaTest: r.alphaTest || undefined,
      decal: r.decal || undefined, twoSided: r.twoSided || undefined,
      lightmap: r.lightmap >= 0 ? r.lightmap : undefined,
      water: r.water || undefined
    })),
    sky: world.sky || undefined,
    lightmaps: world.lightmapFiles || [],
    sun: spec.sun,
    stats: { surfaces: spec.surfaces.length, materials: world.ranges.length,
             triangles: world.index.length / 3, staticModels: spec.staticModels.length }
  }, null, 1));
  return bin.length;
}

function writeTextures(outDir, world, index, dumpDir, max){
  const texDir = path.join(outDir, "textures");
  fs.mkdirSync(texDir, { recursive: true });
  const textures = {};
  const missing = [];
  const done = new Map();
  let bytes = 0;
  for (const r of world.ranges) {
    if (!r.image) { missing.push(r.material + " (no colour map)"); continue; }
    if (!done.has(r.image)) {
      const img = loadImage(index, dumpDir, r.image);
      if (!img) { done.set(r.image, null); }
      else {
        const small = shrinkToFit(img.rgba, img.width, img.height, max);
        const file = safeName(r.image) + ".png";
        const png = writePNG(small.rgba, small.width, small.height);
        fs.writeFileSync(path.join(texDir, file), png);
        bytes += png.length;
        done.set(r.image, { file, width: small.width, height: small.height, format: img.from });
      }
    }
    const hit = done.get(r.image);
    if (hit) textures[r.material] = hit;
    else missing.push(r.material + " -> " + r.image);
  }
  fs.writeFileSync(path.join(texDir, "textures.json"), JSON.stringify({ textures, missing }, null, 1));
  return { count: done.size, bytes, missing };
}

/**
 * The baked lighting, one PNG per bank.
 *
 * The secondary image holds the bank's colour lighting twice, as two
 * 512 x 1024 layers stacked in one 512 x 2048 image; the vertex lightmap
 * coordinates address one layer in 0..1. The layers differ only slightly
 * (they are the two halves of the game's directional encoding), so their
 * average is written: the light a surface receives, without the per pixel
 * direction this renderer has no use for.
 */
function writeLightmaps(outDir, spec, worldJsonDir){
  const files = [];
  (spec.lightmaps || []).forEach((lm, i) => {
    const sec = lm.secondary;
    if (!sec || typeof sec !== "object" || sec.format !== 21) { files.push(null); return; }
    const raw = fs.readFileSync(path.join(worldJsonDir, path.basename(sec.file)));
    const w = sec.width, h = sec.height / 2;
    if (raw.length < w * h * 2 * 4) { files.push(null); return; }
    const rgba = new Uint8Array(w * h * 4);
    const half = w * h * 4;
    for (let p = 0; p < w * h; p++) {
      const a = p * 4, b = half + p * 4;
      /* A8R8G8B8 in memory is B, G, R, A. */
      rgba[a] = (raw[a + 2] + raw[b + 2] + 1) >> 1;
      rgba[a + 1] = (raw[a + 1] + raw[b + 1] + 1) >> 1;
      rgba[a + 2] = (raw[a] + raw[b] + 1) >> 1;
      rgba[a + 3] = 255;
    }
    const file = "lightmap" + i + ".png";
    fs.mkdirSync(path.join(outDir, "textures"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "textures", file), writePNG(rgba, w, h));
    files.push("textures/" + file);
  });
  return files;
}

/**
 * The map's own skybox: a DDS cube map, six faces in D3D order (+X, -X, +Y,
 * -Y, +Z, -Z in game space, Z up), each followed by its mip chain. Only the
 * top level of each face is kept. Also returns the average colour of the band
 * just above the horizon, which the viewer uses for its distance fog so far
 * geometry fades into this sky rather than into some other one.
 */
function writeSky(outDir, dumpDir, skyImage){
  if (!skyImage) return null;
  const file = path.join(dumpDir, "images", String(skyImage).replace(/^[,*]+/, "") + ".dds");
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  if (buf.length < 128 || buf.toString("latin1", 0, 4) !== "DDS ") return null;
  const height = buf.readUInt32LE(12), width = buf.readUInt32LE(16);
  const mips = Math.max(1, buf.readUInt32LE(28));
  const caps2 = buf.readUInt32LE(112);
  const fourCC = buf.toString("latin1", 84, 88);
  if ((caps2 & 0xFE00) !== 0xFE00 || !/^DXT[135]$/.test(fourCC)) return null;
  const block = fourCC === "DXT1" ? 8 : 16;
  const levelBytes = l => Math.max(1, (width >> l) + 3 >> 2) * Math.max(1, (height >> l) + 3 >> 2) * block;
  let faceBytes = 0;
  for (let l = 0; l < mips; l++) faceBytes += levelBytes(l);
  if (buf.length < 128 + faceBytes * 6) return null;

  fs.mkdirSync(path.join(outDir, "textures"), { recursive: true });
  const faces = [];
  let sum = [0, 0, 0], n = 0;
  for (let f = 0; f < 6; f++) {
    const data = buf.slice(128 + f * faceBytes, 128 + f * faceBytes + levelBytes(0));
    const rgba = decodeDXT(data, width, height, fourCC);
    const name = "sky_" + f + ".png";
    fs.writeFileSync(path.join(outDir, "textures", name), writePNG(rgba, width, height));
    faces.push("textures/" + name);
    /* Side faces (the first four in game space are the horizontal ones):
       sample the rows just above the middle, where the horizon sits. */
    if (f < 4) {
      for (let y = Math.floor(height * 0.40); y < Math.floor(height * 0.50); y += 4) {
        for (let x = 0; x < width; x += 8) {
          const o = (y * width + x) * 4;
          sum[0] += rgba[o]; sum[1] += rgba[o + 1]; sum[2] += rgba[o + 2]; n++;
        }
      }
    }
  }
  const hex = n ? "#" + sum.map(v => Math.round(v / n).toString(16).padStart(2, "0")).join("") : null;
  return { source: skyImage, faces, horizon: hex, size: width };
}

function findWorldJson(dumpDir, map){
  const direct = path.join(dumpDir, "maps", "mp", map + ".world.json");
  if (fs.existsSync(direct)) return direct;
  const sp = path.join(dumpDir, "maps", map + ".world.json");
  return fs.existsSync(sp) ? sp : null;
}

function main(){
  const argv = process.argv.slice(2);
  let max = 512;
  /* Rebuild only props.json and props/, in seconds, when the geometry and
     textures are already current. */
  const propsOnly = argv.includes("--props-only");
  if (propsOnly) argv.splice(argv.indexOf("--props-only"), 1);
  const maxAt = argv.indexOf("--max");
  if (maxAt >= 0) { max = parseInt(argv[maxAt + 1], 10) || max; argv.splice(maxAt, 2); }
  const [dumpDir, map, outDir] = argv;
  if (!dumpDir || !map || !outDir) {
    process.stdout.write("  node tools/ffworld.js <oat dump dir> <map> <output dir> [--max 512]\n");
    process.exit(1);
  }
  const worldJson = findWorldJson(dumpDir, map);
  if (!worldJson) {
    process.stderr.write("No " + map + ".world.json under " + dumpDir +
      ". Dump the zone with the GfxWorld writer first.\n");
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(worldJson, "utf8"));
  const bin = fs.readFileSync(path.join(path.dirname(worldJson), path.basename(spec.bin)));
  const expected = spec.indexOffset + spec.indexCount * 2;
  if (bin.length !== expected) {
    process.stderr.write("world.bin is " + bin.length + " bytes, the spec says " + expected + ". Refusing.\n");
    process.exit(1);
  }

  const mainDir = process.env.COD4_MAIN || DEFAULT_MAIN;
  const index = buildIndex(mainDir);
  fs.mkdirSync(outDir, { recursive: true });

  const modelDir = path.join(dumpDir, "model_export");
  const entsFile = path.join(path.dirname(worldJson), map + ".d3dbsp.ents");
  const extras = fs.existsSync(entsFile) ? sceneryEntities(readEntities(fs.readFileSync(entsFile, "latin1"))) : [];
  const buildAllProps = () => buildProps({ staticModels: spec.staticModels.concat(extras) },
                                         fs.existsSync(modelDir) ? modelDir : null, outDir);
  if (propsOnly) {
    fs.rmSync(path.join(outDir, "props"), { recursive: true, force: true });
    const p = buildAllProps();
    process.stdout.write("  " + map + ": " + p.placed + " props of " + p.models + " models\n");
    return;
  }

  const world = readWorld(spec, bin);
  world.lightmapFiles = writeLightmaps(outDir, spec, path.dirname(worldJson));
  world.sky = writeSky(outDir, dumpDir, spec.skyImage);
  const geoBytes = writeGeometry(outDir, world, spec, map);
  const tex = writeTextures(outDir, world, index, dumpDir, max);
  const props = buildAllProps();

  /* PNG is the portable fallback; WebP is what ships when Pillow is there. */
  let webp = "left as PNG (no Python with Pillow)";
  const py = spawnSync(process.env.PYTHON || "python",
    [path.join(__dirname, "py", "webp.py"), path.join(outDir, "textures")], { encoding: "utf8" });
  if (py.status === 0) webp = py.stdout.trim();
  else if (py.stderr) webp += ": " + py.stderr.trim().split("\n").pop();

  const mb = b => (b / 1048576).toFixed(1) + " MB";
  process.stdout.write("\n  " + map + "\n");
  process.stdout.write("    " + (world.index.length / 3).toLocaleString() + " triangles, " +
    world.ranges.length + " materials, " + mb(geoBytes) +
    " (indices: " + world.indexing.relative + " relative, " + world.indexing.absolute + " absolute surfaces)\n");
  process.stdout.write("    " + tex.count + " colour maps, " + mb(tex.bytes) +
    (tex.missing.length ? ", unresolved: " + tex.missing.length : "") + "\n");
  process.stdout.write("    " + props.placed.toLocaleString() + " props of " + props.models + " models, " +
    mb(props.bytes) + (props.missing.length ? ", no model dumped for " + props.missing.length : "") + "\n");
  process.stdout.write("    webp: " + webp + "\n");
  if (tex.missing.length) process.stdout.write("      " + tex.missing.slice(0, 8).join("\n      ") + "\n");
  process.stdout.write("    written to " + outDir + "\n\n");
}

if (require.main === module) main();
module.exports = { unpackUnitVec, drawStyle, colourImageOf, readWorld, parseDds,
                   anglesToAxis, readEntities, sceneryEntities, propMaterialStyle };
