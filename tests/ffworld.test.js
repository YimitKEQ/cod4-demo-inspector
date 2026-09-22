/*!
 * ffworld.test.js - the fastfile world converter against hand built input
 * whose answers are known: vertex decoding, index handling, draw styles.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const FF = require("../tools/ffworld.js");

const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-4);

/** A world of vertices at the given game space points, all normals +Z. */
function makeWorld(points, surfaces, materials, opts){
  const stride = 44;
  const indices = opts.indices;
  const bin = Buffer.alloc(points.length * stride + indices.length * 2);
  points.forEach((p, i) => {
    const o = i * stride;
    bin.writeFloatLE(p[0], o); bin.writeFloatLE(p[1], o + 4); bin.writeFloatLE(p[2], o + 8);
    bin.writeFloatLE(p[3] || 0, o + 20); bin.writeFloatLE(p[4] || 0, o + 24);
    /* +Z: (254 - 127) * (63 + 192) / 32385 = 1. */
    bin[o + 36] = 127; bin[o + 37] = 127; bin[o + 38] = 254; bin[o + 39] = 63;
    /* Colour B, G, R, A. */
    bin[o + 16] = 10; bin[o + 17] = 20; bin[o + 18] = 30; bin[o + 19] = 40;
  });
  indices.forEach((v, i) => bin.writeUInt16LE(v, points.length * stride + i * 2));
  const spec = {
    vertexStride: stride, vertexCount: points.length,
    indexOffset: points.length * stride, indexCount: indices.length,
    surfaceFields: ["material", "firstVertex", "vertexCount", "triCount", "baseIndex", "lightmap", "flags"],
    surfaces, materials, skySurfaces: opts.sky || [], staticModels: []
  };
  return { spec, bin };
}

const plain = name => ({ name, techset: "wc_l_sm_r0c0", stateBits: [[0x00000000, 0x1]],
  textures: [{ semantic: 2, image: name + "_col" }] });

describe("ffworld", () => {
  it("unpacks the game's unit vectors", () => {
    const out = [0, 0, 0];
    FF.unpackUnitVec(Buffer.from([127, 127, 254, 63]), 0, out, 0);
    assert.ok(near(out[0], 0) && near(out[1], 0), "x and y should be zero, got " + out);
    assert.ok(near(out[2], 1, 0.01), "z should be about 1, got " + out[2]);
  });

  it("maps game space into the Z up to Y up scene, positions and normals alike", () => {
    const { spec, bin } = makeWorld(
      [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
      [[0, 0, 3, 1, 0, 0, 0]], [plain("a")], { indices: [0, 1, 2] });
    const w = FF.readWorld(spec, bin);
    assert.equal([...w.position.slice(0, 3)].join(), "1,3,-2");
    assert.ok(near(w.normal[1], 1, 0.01), "game +Z should become scene +Y");
    assert.equal(w.bounds.minY, 2);
    assert.equal(w.bounds.maxZ, 9);
    assert.equal([...w.color.slice(0, 4)].join(), "30,20,10,40");
  });

  it("offsets indices that are relative to the surface's first vertex", () => {
    const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 5, 0], [6, 5, 0], [5, 6, 0]];
    const { spec, bin } = makeWorld(pts,
      [[0, 0, 3, 1, 0, 0, 0], [0, 3, 3, 1, 3, 0, 0]], [plain("a")],
      { indices: [0, 1, 2, 0, 1, 2] });
    const w = FF.readWorld(spec, bin);
    assert.equal([...w.index].join(), "0,2,1,3,5,4");
    assert.equal(w.indexing.relative, 1);
  });

  it("winds triangles counter clockwise around their normal, as WebGL expects", () => {
    /* Game triangle wound clockwise seen from +Z, normal +Z. */
    const { spec, bin } = makeWorld([[0, 0, 0], [0, 1, 0], [1, 0, 0]],
      [[0, 0, 3, 1, 0, 0, 0]], [plain("a")], { indices: [0, 1, 2] });
    const w = FF.readWorld(spec, bin);
    const P = w.position, I = w.index;
    const v = k => [P[I[k] * 3], P[I[k] * 3 + 1], P[I[k] * 3 + 2]];
    const [a, b, c] = [v(0), v(1), v(2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], q = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const faceY = u[2] * q[0] - u[0] * q[2];
    assert.ok(faceY > 0, "face normal should point along the vertex normal (scene +Y)");
  });

  it("drops a triangle with a bad index whole, never one vertex of it", () => {
    const { spec, bin } = makeWorld([[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[0, 0, 3, 2, 0, 0, 0]], [plain("a")], { indices: [0, 1, 2, 0, 1, 900] });
    const w = FF.readWorld(spec, bin);
    assert.equal(w.index.length, 3);
  });

  it("leaves out sky surfaces and sky techsets", () => {
    const sky = { name: "sky", techset: "sky_x", stateBits: [], textures: [] };
    const { spec, bin } = makeWorld([[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[0, 0, 3, 1, 0, 0, 0], [1, 0, 3, 1, 0, 0, 0], [0, 0, 3, 1, 0, 0, 0]],
      [plain("a"), sky], { indices: [0, 1, 2], sky: [2] });
    const w = FF.readWorld(spec, bin);
    assert.equal(w.ranges.length, 1);
    assert.equal(w.index.length, 3);
  });

  it("reads cutouts, decals, blending and two sided from the state bits", () => {
    /* src ONE (2), dst ZERO (1): opaque. alpha test GE_128 at bits 12-13. */
    const cut = FF.drawStyle({ stateBits: [[0x2 | (0x1 << 4) | (3 << 12), 0]] });
    assert.ok(cut.alphaTest && !cut.blend, "alpha tested and opaque");
    /* src SRCALPHA (5), dst INVSRCALPHA (6), polygon offset in word two. */
    const decal = FF.drawStyle({ stateBits: [[0x5 | (0x6 << 4), 1 << 4]] });
    assert.ok(decal.blend && decal.decal, "blended decal");
    const two = FF.drawStyle({ stateBits: [[0x2 | (0x1 << 4) | (1 << 14), 0]] });
    assert.ok(two.twoSided && !two.blend, "cull none");
  });

  it("judges a material by its lit pass, not its additive extra light passes", () => {
    /* Slot 8 (lit sun) uses opaque bits; an extra light pass is ONE ONE. */
    const entry = new Array(34).fill(0xFF);
    entry[8] = 0; entry[12] = 1;
    const wall = FF.drawStyle({ stateBitsEntry: entry,
      stateBits: [[0x2 | (0x1 << 4) | (1 << 11), 0], [0x2 | (0x2 << 4), 1 << 4]] });
    assert.ok(!wall.blend && !wall.decal && !wall.alphaTest, "a plain wall must stay opaque");
  });

  it("sorts opaque before cutouts before decals before blended", () => {
    const mk = (name, bits) => ({ name, techset: "wc", stateBits: [bits], textures: [] });
    const { spec, bin } = makeWorld([[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[0, 0, 3, 1, 0, 0, 0], [1, 0, 3, 1, 0, 0, 0], [2, 0, 3, 1, 0, 0, 0]],
      [mk("glass", [0x5 | (0x6 << 4), 0]), mk("wall", [0x2 | (0x1 << 4), 0]),
       mk("fence", [0x2 | (0x1 << 4) | (3 << 12), 0])],
      { indices: [0, 1, 2] });
    const w = FF.readWorld(spec, bin);
    assert.equal(w.ranges.map(r => r.material).join(), "wall,fence,glass");
  });

  it("turns entity angles into CoD's forward, left and up axes", () => {
    const a = FF.anglesToAxis(0, 90, 0).map(v => Math.round(v * 1000) / 1000);
    assert.equal(a.join(), "0,1,0,-1,0,0,0,0,1");
    const pitched = FF.anglesToAxis(90, 0, 0);
    assert.ok(Math.abs(pitched[2] + 1) < 1e-6, "pitch 90 looks straight down");
  });

  it("keeps destructibles and S&D bomb sites, drops other gametypes' objects", () => {
    const ents = FF.readEntities([
      '{ "classname" "script_model" "model" "vehicle_car_destructible_mp" "targetname" "destructible" "origin" "1 2 3" "angles" "0 90 0" }',
      '{ "classname" "script_model" "model" "com_bomb_objective" "script_gameobjectname" "bombzone" "origin" "4 5 6" }',
      '{ "classname" "script_model" "model" "com_laptop_2_open" "script_gameobjectname" "hq" "origin" "7 8 9" }',
      '{ "classname" "script_brushmodel" "model" "*3" "targetname" "destructible" }'
    ].join("\n"));
    const kept = FF.sceneryEntities(ents).map(e => e.model);
    assert.equal(kept.join(), "vehicle_car_destructible_mp,com_bomb_objective");
  });
});
