/*!
 * mapmesh.js - build a 3D map out of nothing but where players walked.
 *
 * The geometry is not in the demo. What is in the demo is every position every
 * player ever occupied, and over a full match ten players cover the walkable
 * area almost completely. That is enough to reconstruct the floors.
 *
 * The method is a multi level heightfield:
 *   1. grid the world in XY
 *   2. per cell, collect the z of every sample that fell in it
 *   3. cluster those z into levels, because a cell under a walkway has two
 *      floors and flattening them loses the map
 *   4. emit a floor tile per cell per level, and a wall wherever a level ends
 *
 * The tiles carry UVs from the world rectangle, so the map's own compass image
 * can be draped over them. That is what makes this read as the actual map
 * rather than as a pile of boxes: real heights, real outline, real texture.
 *
 * This is the no-assets fallback from the handoff. It works on any map,
 * including custom ones, with nothing installed. When the asset pipeline lands
 * it gets replaced by the real mesh, and everything downstream is unchanged
 * because the output is just buffers.
 *
 * Pure maths, no three.js, no DOM. Testable headless.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const CFG = {
  /* Cell size in world units. 40 units is about a metre: fine enough to show
     a doorway and a staircase, coarse enough that a competitive map stays
     around 20k triangles, which is nothing. */
  cell: 40,

  /* Two z values in the same cell belong to the same floor while they are
     closer than this. A standing player is 72 units, so 56 keeps a walkway
     and the ground under it apart without splitting a staircase into steps. */
  levelGap: 56,

  /* A cell needs this many samples before it counts as floor. One stray
     sample is usually a player falling past, not ground. */
  minSamples: 2,

  /* Grow the floor by this many cells so corridors close up. Players walk
     lines, not areas, and without this the map reads as spaghetti. */
  dilate: 1,

  /* A cell with fewer occupied neighbours than this is a speck, not floor:
     one player falling past, or a single stray sample. Removing them is what
     turns a cloud of confetti into a building. */
  minNeighbours: 3,

  /* Fill a hole when at least this many of its four orthogonal neighbours are
     floor at a similar height. Closes the pinholes left by dilation. */
  closeNeighbours: 3,

  /* How tall a wall is where the floor ends, and how far the floor is
     extruded downwards. The skirt is what stops tiles reading as sheets of
     paper floating in space. */
  wallHeight: 110,
  skirtDepth: 46,

  /* A neighbouring level this close counts as connected, so no wall is drawn
     between a floor and the ramp leading off it. */
  stepTolerance: 40
};

/** Cluster a sorted list of z values into floor levels. */
function clusterHeights(sorted, gap){
  const levels = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] - sorted[i - 1] > gap) {
      const slice = sorted.slice(start, i);
      /* The floor is the low end of the cluster, not the mean: a player
         jumping in a room would otherwise lift the whole floor. */
      levels.push({ z: slice[Math.floor(slice.length * 0.15)], n: slice.length });
      start = i;
    }
  }
  return levels;
}

/**
 * Occupancy: which cells hold floor, at which heights.
 * Returns a Map keyed "cx,cy" of { levels: [{z, n}] } plus the grid metrics.
 */
function buildOccupancy(tracks, opts){
  const cfg = Object.assign({}, CFG, opts || {});
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const ids = Object.keys(tracks);
  for (const id of ids) {
    for (const p of tracks[id]) {
      if (p[1] < minX) minX = p[1];
      if (p[1] > maxX) maxX = p[1];
      if (p[2] < minY) minY = p[2];
      if (p[2] > maxY) maxY = p[2];
      if (p[3] < minZ) minZ = p[3];
      if (p[3] > maxZ) maxZ = p[3];
    }
  }
  if (!isFinite(minX)) return null;

  /* Pad so edge cells are whole. */
  minX = Math.floor(minX / cfg.cell) * cfg.cell - cfg.cell;
  minY = Math.floor(minY / cfg.cell) * cfg.cell - cfg.cell;
  maxX = Math.ceil(maxX / cfg.cell) * cfg.cell + cfg.cell;
  maxY = Math.ceil(maxY / cfg.cell) * cfg.cell + cfg.cell;

  const cols = Math.max(1, Math.round((maxX - minX) / cfg.cell));
  const rows = Math.max(1, Math.round((maxY - minY) / cfg.cell));

  /* Gather z per cell. */
  const raw = new Map();
  for (const id of ids) {
    for (const p of tracks[id]) {
      const cx = Math.floor((p[1] - minX) / cfg.cell);
      const cy = Math.floor((p[2] - minY) / cfg.cell);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      const key = cx + "," + cy;
      let list = raw.get(key);
      if (!list) { list = []; raw.set(key, list); }
      list.push(p[3]);
    }
  }

  const cells = new Map();
  for (const [key, zs] of raw) {
    if (zs.length < cfg.minSamples) continue;
    zs.sort((a, b) => a - b);
    cells.set(key, { levels: clusterHeights(zs, cfg.levelGap) });
  }

  /* Dilation: a cell with no samples takes the levels of its neighbours, so
     a walked line becomes a walked corridor. Marked as grown, because it is
     inference rather than observation. */
  for (let pass = 0; pass < cfg.dilate; pass++) {
    const added = new Map();
    for (const [key, cell] of cells) {
      const [cx, cy] = key.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nkey = nx + "," + ny;
        if (cells.has(nkey)) continue;
        let slot = added.get(nkey);
        if (!slot) { slot = { levels: [], grown: true }; added.set(nkey, slot); }
        for (const lv of cell.levels) {
          if (!slot.levels.some(x => Math.abs(x.z - lv.z) < cfg.levelGap))
            slot.levels.push({ z: lv.z, n: 0 });
        }
      }
    }
    for (const [k, v] of added) cells.set(k, v);
  }

  /* Clean up. Dilation closes corridors but also smears isolated samples into
     little islands, and the raw data has specks of its own where somebody
     fell past a gap. Two passes fix both: drop cells with almost no
     neighbours, then fill holes that are almost surrounded. */
  const neighbourCount = (cx, cy, set) => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (set.has((cx + dx) + "," + (cy + dy))) n++;
    }
    return n;
  };

  for (const key of [...cells.keys()]) {
    const [cx, cy] = key.split(",").map(Number);
    if (neighbourCount(cx, cy, cells) < cfg.minNeighbours) cells.delete(key);
  }

  const fill = new Map();
  for (const key of cells.keys()) {
    const [cx, cy] = key.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nkey = nx + "," + ny;
      if (cells.has(nkey) || fill.has(nkey)) continue;
      let around = 0;
      const levels = [];
      for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = cells.get((nx + ex) + "," + (ny + ey));
        if (!c) continue;
        around++;
        for (const lv of c.levels)
          if (!levels.some(x => Math.abs(x.z - lv.z) < cfg.levelGap)) levels.push({ z: lv.z, n: 0 });
      }
      if (around >= cfg.closeNeighbours && levels.length)
        fill.set(nkey, { levels, grown: true });
    }
  }
  for (const [k, v] of fill) cells.set(k, v);

  return { cells, cols, rows, minX, minY, maxX, maxY, minZ, maxZ, cell: cfg.cell, cfg };
}

/**
 * Turn occupancy into triangles.
 *
 * Returns plain arrays (positions, normals, uvs, indices) in a Y up coordinate
 * system, because that is what three.js and glTF both want. CoD4 is Z up, so
 * the mapping is world (x, y, z) -> scene (x, z, -y).
 */
function buildMesh(occ){
  if (!occ) return null;
  const cfg = occ.cfg;
  const positions = [], normals = [], uvs = [], indices = [], colors = [];
  const worldW = occ.maxX - occ.minX, worldH = occ.maxY - occ.minY;

  const uvOf = (x, y) => [(x - occ.minX) / worldW, 1 - (y - occ.minY) / worldH];

  /** Push a quad from four world space corners with a shared normal. */
  function quad(a, b, c, d, n, shade){
    const base = positions.length / 3;
    const v = shade === undefined ? 1 : shade;
    for (const p of [a, b, c, d]) {
      /* World Z up to scene Y up. */
      positions.push(p[0], p[2], -p[1]);
      normals.push(n[0], n[2], -n[1]);
      const uv = uvOf(p[0], p[1]);
      uvs.push(uv[0], uv[1]);
      colors.push(v, v, v);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const levelsAt = (cx, cy) => {
    const c = occ.cells.get(cx + "," + cy);
    return c ? c.levels : null;
  };

  /**
   * How enclosed a cell is at a given height, 0 to 1.
   *
   * Used to bake ambient occlusion into the vertex colours: floor in the open
   * stays bright, floor tucked against walls and in corners goes darker. It is
   * the single cheapest thing that stops a heightfield reading as flat plates,
   * because it is what gives edges and interiors any sense of depth.
   *
   * Kept gentle. Vertex colour multiplies the map texture, so a strong term
   * here does not read as shadow, it reads as a dark map.
   */
  function enclosure(cx, cy, z){
    let open = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nb = levelsAt(cx + dx, cy + dy);
      if (nb && nb.some(x => Math.abs(x.z - z) <= cfg.stepTolerance)) open++;
    }
    return 1 - open / 8;
  }

  const S = cfg.cell;
  for (const [key, cell] of occ.cells) {
    const [cx, cy] = key.split(",").map(Number);
    const x0 = occ.minX + cx * S, x1 = x0 + S;
    const y0 = occ.minY + cy * S, y1 = y0 + S;

    for (const lv of cell.levels) {
      const z = lv.z;
      /* Floor tile, facing up, shaded by how boxed in it is. */
      const ao = 1 - enclosure(cx, cy, z) * 0.28;
      quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1], ao);

      /* Walls where this level has no neighbour at a similar height. The wall
         runs from below the floor to above it, so the floor reads as solid
         ground with thickness rather than as a sheet of paper. */
      const sides = [
        { d: [1, 0], a: [x1, y0, z], b: [x1, y1, z], n: [1, 0, 0] },
        { d: [-1, 0], a: [x0, y1, z], b: [x0, y0, z], n: [-1, 0, 0] },
        { d: [0, 1], a: [x1, y1, z], b: [x0, y1, z], n: [0, 1, 0] },
        { d: [0, -1], a: [x0, y0, z], b: [x1, y0, z], n: [0, -1, 0] }
      ];
      for (const s of sides) {
        const nb = levelsAt(cx + s.d[0], cy + s.d[1]);
        const connected = nb && nb.some(x => Math.abs(x.z - z) <= cfg.stepTolerance);
        if (connected) continue;
        /* A wall stops short when there is floor above it, so an upper storey
           is not buried behind the wall of the one below. */
        const above = nb ? nb.filter(x => x.z > z + cfg.stepTolerance)
                             .reduce((m, x) => Math.min(m, x.z), Infinity) : Infinity;
        const top = Math.min(z + cfg.wallHeight, above === Infinity ? Infinity : above - 8);
        const bottom = z - cfg.skirtDepth;
        quad([s.a[0], s.a[1], bottom], [s.b[0], s.b[1], bottom],
             [s.b[0], s.b[1], top], [s.a[0], s.a[1], top], s.n, 0.78);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: new Float32Array(colors),
    indices: positions.length / 3 > 65535
      ? new Uint32Array(indices) : new Uint16Array(indices),
    bounds: { minX: occ.minX, minY: occ.minY, maxX: occ.maxX, maxY: occ.maxY,
              minZ: occ.minZ, maxZ: occ.maxZ },
    stats: {
      cells: occ.cells.size,
      levels: [...occ.cells.values()].reduce((a, c) => a + c.levels.length, 0),
      triangles: indices.length / 3,
      grownCells: [...occ.cells.values()].filter(c => c.grown).length
    }
  };
}

/**
 * The height of the floor under a world point, or null when nobody ever stood
 * there. Used to drop cameras and markers onto the map instead of floating
 * them, and by the alignment check.
 */
function floorAt(occ, x, y, z){
  if (!occ) return null;
  const cx = Math.floor((x - occ.minX) / occ.cell);
  const cy = Math.floor((y - occ.minY) / occ.cell);
  const cell = occ.cells.get(cx + "," + cy);
  if (!cell || !cell.levels.length) return null;
  if (z === undefined || z === null) return cell.levels[0].z;
  let best = null, bestD = Infinity;
  for (const lv of cell.levels) {
    const d = Math.abs(lv.z - z);
    if (d < bestD) { bestD = d; best = lv.z; }
  }
  return best;
}

/**
 * Alignment check, as the handoff asks for: drop every recorded position onto
 * the mesh and measure how far it floats or sinks. A reconstruction built from
 * those same positions should sit within a step of all of them; a large error
 * means the level clustering merged floors it should have kept apart.
 */
function checkAlignment(occ, tracks, sampleEvery){
  const step = sampleEvery || 40;
  let n = 0, bad = 0, worst = 0, total = 0;
  for (const id of Object.keys(tracks)) {
    const t = tracks[id];
    for (let i = 0; i < t.length; i += step) {
      const p = t[i];
      const f = floorAt(occ, p[1], p[2], p[3]);
      if (f === null) { bad++; n++; continue; }
      const err = Math.abs(f - p[3]);
      total += err;
      if (err > worst) worst = err;
      if (err > CFG.levelGap) bad++;
      n++;
    }
  }
  return { checked: n, unplaced: bad, worst: Math.round(worst),
           meanError: n ? Math.round(total / n) : 0 };
}

/* CoD4 is Z up, three.js and glTF are Y up. Every conversion in the app goes
   through here so there is exactly one place that can be wrong. */
function toScene(x, y, z){ return [x, z, -y]; }
function fromScene(x, y, z){ return [x, -z, y]; }

const API = { buildOccupancy, buildMesh, floorAt, checkAlignment, clusterHeights,
              toScene, fromScene, CFG };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_MAPMESH = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
