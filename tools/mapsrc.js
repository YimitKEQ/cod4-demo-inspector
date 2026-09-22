#!/usr/bin/env node
/*!
 * mapsrc.js - turn a Radiant .map source into geometry the 3D view can load.
 *
 * CoD4's stock maps exist as Radiant .map sources: plain text, real geometry,
 * real material names, real texture coordinates. mp_backlot was released by
 * Infinity Ward in the mod tools; the rest circulate in the mapping community.
 * That makes this the one route to real map geometry that needs no game
 * running, no memory reading and no fastfile parsing.
 *
 *   node tools/mapsrc.js mp_crash.map maps3d/mp_crash
 *
 * Writes geometry.bin (interleaved vertex data and indices) plus a small
 * geometry.json manifest naming the material groups. The viewer loads those
 * when they exist and falls back to the reconstruction when they do not.
 *
 * Two kinds of surface live in a .map:
 *
 *   mesh patches   a control grid of vertices carrying position and texture
 *                  coordinates directly. Triangulated as written.
 *   plane brushes  a convex solid given as a list of half spaces, three points
 *                  each. The faces have to be recovered by intersecting every
 *                  plane with every other, which is the classic id Tech brush
 *                  to polygon problem.
 *
 * Extracted geometry stays out of the repository: it is Activision's, and the
 * tool is what ships. See docs/DECISIONS.md.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* Surfaces with these materials are not part of the visible world. caulk is
   the standard "never drawn" material; the others are editor and volume
   markers that would otherwise fill the map with invisible boxes. */
const SKIP_MATERIALS = new Set([
  "caulk", "sky", "clip", "player_clip", "playerclip", "clip_player",
  "nodraw", "hint", "skip", "trigger", "origin", "portal", "areaportal",
  "clip_vehicle", "clipnosight", "clip_missile", "volume", "water_clip",
  "lightgrid_volume", "clusterportal", "donotenter", "mantle_on", "mantle_over"
]);

const EPS = 0.01;

/* ---- vector helpers, plain arrays ---- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                         a[2] * b[0] - a[0] * b[2],
                         a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.sqrt(dot(a, a));
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/* ---- tokenizer ---- */

/**
 * The format is line oriented enough that a line scanner beats a real parser.
 * Brace depth tells us where we are; the shapes inside are recognised by their
 * first token.
 */
function parseMap(text){
  const lines = text.split(/\r?\n/);
  const patches = [];
  const brushes = [];

  let i = 0;
  let depth = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    i++;
    if (!line || line.startsWith("//")) continue;

    if (line === "{") { depth++; continue; }
    if (line === "}") { depth--; continue; }

    if (line === "mesh") {
      /* mesh { contents ...; material lightmap rows cols ? ? ( (rows of v) ) } */
      const patch = readMesh(lines, i);
      i = patch.next;
      if (patch.verts) patches.push(patch);
      continue;
    }

    /* A plane face: three bracketed points then the material. */
    if (line.startsWith("(")) {
      const faces = [];
      let j = i - 1;
      while (j < lines.length) {
        const l = lines[j].trim();
        if (!l.startsWith("(")) break;
        const f = readPlane(l);
        if (f) faces.push(f);
        j++;
      }
      i = j;
      if (faces.length >= 4) brushes.push(faces);
      continue;
    }
  }

  return { patches, brushes };
}

/** Read one `mesh { ... }` block starting at the line after the `mesh` token. */
function readMesh(lines, start){
  let i = start;
  /* Skip to the opening brace of the mesh body. */
  while (i < lines.length && lines[i].trim() !== "{") i++;
  i++;

  let material = null, rows = 0, cols = 0;
  const verts = [];

  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    if (line === "}") break;
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("contents")) continue;
    if (line === "(" || line === ")") continue;

    if (line.startsWith("v ")) {
      /* v X Y Z [c R G B A] t U V lmU lmV */
      const t = line.split(/\s+/);
      const x = +t[1], y = +t[2], z = +t[3];
      let u = 0, v = 0;
      const ti = t.indexOf("t");
      if (ti > 0 && t.length > ti + 2) { u = +t[ti + 1]; v = +t[ti + 2]; }
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        verts.push([x, y, z, u, v]);
      }
      continue;
    }

    if (material === null) { material = line.split(/\s+/)[0]; continue; }
    if (rows === 0) {
      const nums = line.split(/\s+/).map(Number).filter(Number.isFinite);
      if (nums.length >= 2) { rows = nums[0]; cols = nums[1]; }
      continue;
    }
  }

  return { material, rows, cols, verts, next: i };
}

/** Read one plane face line: three points, then the material. */
function readPlane(line){
  const pts = [];
  const re = /\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)/g;
  let m, end = 0;
  while (pts.length < 3 && (m = re.exec(line)) !== null) {
    pts.push([+m[1], +m[2], +m[3]]);
    /* Remember where the third point ended. Reading lastIndex after the loop
       is wrong: a line with exactly three points makes the next exec fail,
       and a failed exec resets lastIndex to zero, which made every material
       parse as "(" and left every caulk and clip brush in the world. */
    end = re.lastIndex;
  }
  if (pts.length < 3) return null;
  const rest = line.slice(end).trim();
  const material = (rest.split(/\s+/)[0] || "").replace(/^\*/, "");

  /* id Tech convention: the three points run clockwise seen from the front,
     so this winding puts the normal on the outside. */
  const n = norm(cross(sub(pts[2], pts[0]), sub(pts[1], pts[0])));
  if (!Number.isFinite(n[0])) return null;
  return { n, d: dot(n, pts[0]), material };
}

/* ---- brush to polygons ---- */

/**
 * Recover a brush's faces.
 *
 * Each face starts as a huge quad lying on its own plane and is then clipped
 * by every other plane of the brush. What survives is the actual face. This is
 * the standard approach and it is quadratic in the face count, which is fine
 * because a brush has a handful of faces.
 */
function brushFaces(faces, worldSize){
  const out = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    let poly = seedQuad(f.n, f.d, worldSize);
    for (let j = 0; j < faces.length && poly; j++) {
      if (i === j) continue;
      poly = clip(poly, faces[j].n, faces[j].d);
    }
    if (poly && poly.length >= 3) out.push({ poly, n: f.n, material: f.material });
  }
  return out;
}

/** A square on the plane, large enough to contain any brush in the map. */
function seedQuad(n, d, size){
  /* Any axis not parallel to the normal gives a usable tangent. */
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t1 = norm(cross(up, n));
  const t2 = norm(cross(n, t1));
  const c = [n[0] * d, n[1] * d, n[2] * d];
  const s = size;
  return [
    [c[0] - t1[0] * s - t2[0] * s, c[1] - t1[1] * s - t2[1] * s, c[2] - t1[2] * s - t2[2] * s],
    [c[0] + t1[0] * s - t2[0] * s, c[1] + t1[1] * s - t2[1] * s, c[2] + t1[2] * s - t2[2] * s],
    [c[0] + t1[0] * s + t2[0] * s, c[1] + t1[1] * s + t2[1] * s, c[2] + t1[2] * s + t2[2] * s],
    [c[0] - t1[0] * s + t2[0] * s, c[1] - t1[1] * s + t2[1] * s, c[2] - t1[2] * s + t2[2] * s]
  ];
}

/** Keep the part of the polygon behind the plane. */
function clip(poly, n, d){
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot(n, a) - d, db = dot(n, b) - d;
    if (da <= EPS) out.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t,
                a[1] + (b[1] - a[1]) * t,
                a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out.length >= 3 ? out : null;
}

/* ---- build ---- */

function build(src){
  const { patches, brushes } = src;

  /* One world size for every seed quad, from the extent of the brush planes. */
  let worldSize = 8192;
  const positions = [], normals = [], uvs = [];
  const groups = new Map();

  const keep = mat => {
    const m = (mat || "").toLowerCase();
    if (!m) return false;
    if (SKIP_MATERIALS.has(m)) return false;
    /* Anything whose name begins with one of these is a tool surface. */
    /* Anything beginning with one of these is an editor or compiler surface
       rather than something the player ever sees. toolFlags in particular was
       putting a few hundred solid black boxes into the middle of the map. */
    return !/^(caulk|clip|nodraw|hint|skip|trigger|portal|sky_|tool|editor|utility)/.test(m);
  };

  /* Two buckets. An up facing surface is floor or roof and gets the map's own
     overhead image projected onto it, which is what makes the real geometry
     read as the real place without extracting a single texture. Everything
     else is a wall and is shaded flat.

     Floor UVs are raw world x and y: the viewer scales them onto the compass
     rectangle with the texture's own repeat and offset, so the projection
     lines up with the 2D map exactly. */
  const floorIdx = [], wallIdx = [];

  const pushTri = (a, b, c, n, material) => {
    const base = positions.length / 3;
    /* Horizontal, either way up. Patch winding is inconsistent in the source
       so the sign of the normal says nothing; what matters is that the surface
       is flat enough for an overhead projection to land on it sensibly. */
    const up = Math.abs(n[2]) > 0.5;
    for (const p of [a, b, c]) {
      /* CoD is Z up in inches; the scene is Y up. */
      positions.push(p[0], p[2], -p[1]);
      normals.push(n[0], n[2], -n[1]);
      uvs.push(p[0], p[1]);
    }
    (up ? floorIdx : wallIdx).push(base, base + 1, base + 2);
    const g = groups.get(material) || { material, count: 0 };
    g.count += 3;
    groups.set(material, g);
  };

  /* Patches: the control grid is the surface. */
  let patchTris = 0;
  for (const p of patches) {
    if (!keep(p.material)) continue;
    const { rows, cols, verts } = p;
    if (rows < 2 || cols < 2 || verts.length < rows * cols) continue;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const v00 = verts[r * cols + c], v10 = verts[r * cols + c + 1];
        const v01 = verts[(r + 1) * cols + c], v11 = verts[(r + 1) * cols + c + 1];
        if (!v00 || !v10 || !v01 || !v11) continue;
        const n = norm(cross(sub(v10, v00), sub(v01, v00)));
        if (!Number.isFinite(n[0])) continue;
        pushTri(v00, v10, v11, n, p.material);
        pushTri(v00, v11, v01, n, p.material);
        patchTris += 2;
      }
    }
  }

  /* Brushes: recover each face, then fan triangulate it. */
  let brushTris = 0;
  for (const faces of brushes) {
    if (!faces.some(f => keep(f.material))) continue;
    const recovered = brushFaces(faces, worldSize);
    for (const f of recovered) {
      if (!keep(f.material)) continue;
      for (let k = 1; k + 1 < f.poly.length; k++) {
        pushTri(f.poly[0], f.poly[k], f.poly[k + 1], f.n, f.material);
        brushTris++;
      }
    }
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    /* Back to world axes for the bounds the rest of the app speaks. */
    const wx = positions[i], wy = -positions[i + 2], wz = positions[i + 1];
    if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
  }

  /* Floors first, then walls, so the two are contiguous index ranges. */
  const indices = floorIdx.concat(wallIdx);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    ranges: { floor: { start: 0, count: floorIdx.length },
              wall: { start: floorIdx.length, count: wallIdx.length } },
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    stats: {
      patches: patches.length, brushes: brushes.length,
      patchTriangles: patchTris, brushTriangles: brushTris,
      triangles: indices.length / 3,
      vertices: positions.length / 3,
      materials: groups.size
    },
    materials: [...groups.values()].sort((a, b) => b.count - a.count)
  };
}

/* ---- output ---- */

function write(outDir, mesh, sourceName){
  fs.mkdirSync(outDir, { recursive: true });
  const parts = [
    Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
    Buffer.from(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength),
    Buffer.from(mesh.uvs.buffer, mesh.uvs.byteOffset, mesh.uvs.byteLength),
    Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)
  ];
  fs.writeFileSync(path.join(outDir, "geometry.bin"), Buffer.concat(parts));

  const manifest = {
    format: "dm1-geometry-1",
    source: sourceName,
    note: "Extracted from a Radiant .map source. Activision's geometry: keep it local.",
    counts: {
      vertices: mesh.positions.length / 3,
      indices: mesh.indices.length
    },
    layout: [
      { name: "position", type: "Float32", components: 3, byteOffset: 0,
        byteLength: mesh.positions.byteLength },
      { name: "normal", type: "Float32", components: 3,
        byteOffset: mesh.positions.byteLength, byteLength: mesh.normals.byteLength },
      { name: "uv", type: "Float32", components: 2,
        byteOffset: mesh.positions.byteLength + mesh.normals.byteLength,
        byteLength: mesh.uvs.byteLength },
      { name: "index", type: "Uint32", components: 1,
        byteOffset: mesh.positions.byteLength + mesh.normals.byteLength + mesh.uvs.byteLength,
        byteLength: mesh.indices.byteLength }
    ],
    bounds: mesh.bounds,
    ranges: mesh.ranges,
    stats: mesh.stats,
    materials: mesh.materials.slice(0, 60)
  };
  fs.writeFileSync(path.join(outDir, "geometry.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function main(){
  const [input, outDir] = process.argv.slice(2);
  if (!input || !outDir) {
    process.stdout.write("  node tools/mapsrc.js <map.map> <output dir>\n");
    process.exit(1);
  }
  const t0 = Date.now();
  const text = fs.readFileSync(input, "latin1");
  const src = parseMap(text);
  const mesh = build(src);
  if (!mesh.stats.triangles) {
    process.stderr.write("No drawable geometry found in " + input + "\n");
    process.exit(1);
  }
  const manifest = write(outDir, mesh, path.basename(input));

  const s = mesh.stats;
  process.stdout.write("\n  " + path.basename(input) + "\n");
  process.stdout.write("    " + s.brushes.toLocaleString() + " brushes, " +
    s.patches.toLocaleString() + " patches\n");
  process.stdout.write("    " + s.triangles.toLocaleString() + " triangles (" +
    s.brushTriangles.toLocaleString() + " from brushes, " +
    s.patchTriangles.toLocaleString() + " from patches)\n");
  process.stdout.write("    " + s.materials + " materials, top: " +
    mesh.materials.slice(0, 5).map(m => m.material).join(", ") + "\n");
  process.stdout.write("    " + (mesh.ranges.floor.count / 3).toLocaleString() +
    " floor triangles, " + (mesh.ranges.wall.count / 3).toLocaleString() + " wall\n");
  const b = mesh.bounds;
  process.stdout.write("    world bounds x " + Math.round(b.minX) + " to " + Math.round(b.maxX) +
    ", y " + Math.round(b.minY) + " to " + Math.round(b.maxY) +
    ", z " + Math.round(b.minZ) + " to " + Math.round(b.maxZ) + "\n");
  process.stdout.write("    written to " + outDir + " in " + (Date.now() - t0) + " ms\n\n");
}

if (require.main === module) main();
module.exports = { parseMap, build, brushFaces, clip, readPlane };
