/*!
 * mapmesh.test.js - the map reconstruction, and the axis mapping the hot
 * render path inlines.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const MM = require("../js/core/mapmesh.js");
const MODEL = require("../js/core/model.js");
const { referenceMatch } = require("./fixtures/synth.js");

describe("mapmesh: the axis mapping", () => {
  it("agrees with the inline form the 3D view uses", () => {
    /* viewport3d.js inlines this as (x, z, -y) because toScene allocates an
       array and the trails call it thousands of times a frame. If the two
       ever drift, everything in 3D silently lands in the wrong place. */
    const inline = (x, y, z) => [x, z, -y];
    for (const [x, y, z] of [[0, 0, 0], [1, 2, 3], [-500, 900, -120],
                             [2735, -2166, 47], [0.5, -0.25, 1e6]]) {
      assert.deep(MM.toScene(x, y, z), inline(x, y, z),
                       "toScene and the inline form disagree at " + [x, y, z]);
    }
  });

  it("round trips back to world coordinates", () => {
    for (const [x, y, z] of [[10, 20, 30], [-4000, 2500, -60]]) {
      const s = MM.toScene(x, y, z);
      assert.deep(MM.fromScene(s[0], s[1], s[2]), [x, y, z]);
    }
  });
});

describe("mapmesh: reconstruction", () => {
  /* Built once for the whole suite: reconstructing a match sized map is real
     work and six tests do not need six of them. */
  let cached = null;
  const build = () => {
    if (cached) return cached;
    const m = MODEL.buildModel(referenceMatch());
    const occ = MM.buildOccupancy(m.tracks);
    cached = { m, occ, mesh: MM.buildMesh(occ) };
    return cached;
  };

  it("builds a mesh from position data alone", () => {
    const { mesh } = build();
    assert.ok(mesh.stats.cells > 100, "expected real coverage, got " + mesh.stats.cells);
    assert.ok(mesh.stats.triangles > 500);
    assert.equal(mesh.positions.length % 3, 0);
    assert.equal(mesh.uvs.length / 2, mesh.positions.length / 3);
    assert.equal(mesh.colors.length, mesh.positions.length, "one colour per vertex");
  });

  it("finds more floor levels than cells, because storeys stack", () => {
    const { mesh } = build();
    assert.ok(mesh.stats.levels >= mesh.stats.cells,
              "the fixture walks half the players a storey up");
  });

  it("sits under the positions it was built from", () => {
    const { m, occ } = build();
    const a = MM.checkAlignment(occ, m.tracks, 20);
    assert.ok(a.meanError < 40, "mean error " + a.meanError + " units is too far off");
    assert.ok(a.unplaced / a.checked < 0.1,
              a.unplaced + " of " + a.checked + " positions had no floor under them");
  });

  it("returns nothing rather than guessing when there are no tracks", () => {
    assert.equal(MM.buildOccupancy({}), null);
    assert.equal(MM.buildMesh(null), null);
  });

  it("gives no floor height where nobody ever stood", () => {
    const { occ } = build();
    assert.equal(MM.floorAt(occ, 1e7, 1e7, 0), null);
  });

  it("keeps a walkway and the ground under it apart", () => {
    const sorted = [100, 104, 108, 260, 264];
    const levels = MM.clusterHeights(sorted, MM.CFG.levelGap);
    assert.equal(levels.length, 2, "two storeys, not one average");
    assert.ok(levels[0].z < 150 && levels[1].z > 200);
  });
});
