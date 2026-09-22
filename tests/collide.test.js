/*!
 * collide.test.js - the camera ray test against a wall whose place is known.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const C = require("../js/ui/collide.js");

/** A wall across x = 500, spanning z -1000..1000 and y 0..300, plus far floor. */
function scene(){
  const positions = new Float32Array([
    500, 0, -1000, 500, 300, -1000, 500, 0, 1000,
    500, 300, 1000,
    3000, 0, 3000, 3100, 0, 3000, 3000, 0, 3100
  ]);
  const index = new Uint32Array([0, 1, 2, 1, 3, 2, 4, 5, 6]);
  return C.buildGrid(positions, index, null);
}

describe("collide", () => {
  it("stops a ray at the wall in its way", () => {
    const g = scene();
    const d = C.raycast(g, 0, 100, 0, 1, 0, 0, 2000);
    assert.ok(Math.abs(d - 500) < 0.01, "expected 500, got " + d);
  });

  it("reports nothing when the wall is beyond reach", () => {
    assert.equal(C.raycast(scene(), 0, 100, 0, 1, 0, 0, 400), Infinity);
  });

  it("misses when the ray points away", () => {
    assert.equal(C.raycast(scene(), 0, 100, 0, -1, 0, 0, 2000), Infinity);
  });

  it("passes over the top of the wall", () => {
    assert.equal(C.raycast(scene(), 0, 400, 0, 1, 0, 0, 2000), Infinity);
  });

  it("finds the wall along a diagonal that crosses several cells", () => {
    const s = Math.SQRT1_2;
    const d = C.raycast(scene(), 0, 100, 0, s, 0, s, 3000);
    assert.ok(Math.abs(d - 500 / s) < 0.1, "expected " + 500 / s + ", got " + d);
  });

  it("gives the same answer twice (per ray bookkeeping resets)", () => {
    const g = scene();
    const a = C.raycast(g, 0, 100, 0, 1, 0, 0, 2000);
    const b = C.raycast(g, 0, 100, 0, 1, 0, 0, 2000);
    assert.equal(a, b);
  });
});
