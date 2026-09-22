/*!
 * collide.js - a cheap ray test against the map, so cameras stop at walls.
 *
 * The real map is well over a hundred thousand triangles, and testing a ray
 * against all of them every frame costs more than the frame has. So the
 * triangles are sorted once into a flat grid of columns over the ground
 * plane, and a ray only tests the columns it actually crosses: a follow
 * camera's ray of a few hundred units touches a handful of columns and a few
 * hundred triangles.
 *
 * Works in scene space (Y up), on the same arrays the map is drawn from.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const CELL = 192;
const EPS = 1e-7;

/**
 * Build the grid.
 *   positions  Float32Array, x y z per vertex (scene space)
 *   index      Uint32Array, three per triangle
 *   ranges     optional [{ start, count }] of index ranges to include; the
 *              caller leaves out cutouts and glass, which a camera should see
 *              through rather than stop at
 */
function buildGrid(positions, index, ranges){
  const spans = ranges && ranges.length ? ranges : [{ start: 0, count: index.length }];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return null;
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);

  /* Two passes: count per cell, then fill one flat array. Far less garbage
     than an array per cell, and it matters at this size. */
  const counts = new Uint32Array(nx * nz + 1);
  const eachCell = (t, fn) => {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const x0 = Math.min(positions[a], positions[b], positions[c]);
    const x1 = Math.max(positions[a], positions[b], positions[c]);
    const z0 = Math.min(positions[a + 2], positions[b + 2], positions[c + 2]);
    const z1 = Math.max(positions[a + 2], positions[b + 2], positions[c + 2]);
    const cx0 = Math.floor((x0 - minX) / CELL), cx1 = Math.floor((x1 - minX) / CELL);
    const cz0 = Math.floor((z0 - minZ) / CELL), cz1 = Math.floor((z1 - minZ) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * nx + cx);
  };
  for (const r of spans) {
    for (let t = r.start; t < r.start + r.count; t += 3) eachCell(t, cell => { counts[cell + 1]++; });
  }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const tris = new Uint32Array(counts[counts.length - 1]);
  const fill = counts.slice(0, nx * nz);
  for (const r of spans) {
    for (let t = r.start; t < r.start + r.count; t += 3) eachCell(t, cell => { tris[fill[cell]++] = t; });
  }
  return { positions, index, minX, minZ, nx, nz, start: counts, tris,
           stamp: new Uint32Array(index.length / 3 + 1), pass: 0 };
}

/** Moller and Trumbore: distance along the ray to triangle t, or Infinity. */
function hitTriangle(g, t, ox, oy, oz, dx, dy, dz){
  const P = g.positions, I = g.index;
  const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPS && det < EPS) return Infinity;
  const inv = 1 / det;
  const tx = ox - P[a], ty = oy - P[a + 1], tz = oz - P[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return d > 0 ? d : Infinity;
}

/**
 * Distance from origin along a unit direction to the first surface, up to
 * maxDist, or Infinity when nothing is in the way.
 */
function raycast(g, ox, oy, oz, dx, dy, dz, maxDist){
  if (!g) return Infinity;
  g.pass = (g.pass + 1) >>> 0;
  if (g.pass === 0) { g.stamp.fill(0); g.pass = 1; }
  let best = Infinity;
  /* Walk the columns the ray's ground track crosses, in small steps. A step
     of half a cell cannot skip a column. */
  const flat = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil((maxDist * Math.max(flat, 0.01)) / (CELL * 0.5)));
  let lastCell = -1;
  for (let s = 0; s <= steps; s++) {
    const along = (maxDist * s) / steps;
    const cx = Math.floor((ox + dx * along - g.minX) / CELL);
    const cz = Math.floor((oz + dz * along - g.minZ) / CELL);
    if (cx < 0 || cz < 0 || cx >= g.nx || cz >= g.nz) continue;
    const cell = cz * g.nx + cx;
    if (cell === lastCell) continue;
    lastCell = cell;
    for (let k = g.start[cell]; k < g.start[cell + 1]; k++) {
      const t = g.tris[k];
      const id = t / 3;
      if (g.stamp[id] === g.pass) continue;
      g.stamp[id] = g.pass;
      const d = hitTriangle(g, t, ox, oy, oz, dx, dy, dz);
      if (d < best) best = d;
    }
  }
  return best <= maxDist ? best : Infinity;
}

const API = { buildGrid, raycast, CELL };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_COLLIDE = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
