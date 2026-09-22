/*!
 * pov.test.js - the first person view: interpolation, cuts, field of view.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const POV = require("../js/core/pov.js");

/** Frames every 8 ms moving +X at 200 u/s, yaw sweeping 170 -> -170 across the seam. */
function pov(){
  const n = 10, stride = 11;
  const t = new Int32Array(n), v = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    t[i] = 1000 + i * 8;
    v[i * stride] = 1.6 * i;
    v[i * stride + 3] = 200;
    v[i * stride + 7] = i < 5 ? 170 + i * 2 : -180 + (i - 5) * 2;
  }
  return { t, v, stride, state: [[1000, 3, 0, 0, 60, 0, 0, 0, 5, 0, 0], [1050, 3, 4, 0, 40, 1, 0, 0, 5, 0, 0]] };
}

const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-3);

describe("pov", () => {
  it("interpolates position between client frames", () => {
    const v = POV.viewAt(pov(), 1.004);
    assert.ok(near(v.x, 0.8, 0.01), "halfway between frame 0 and 1, got " + v.x);
    assert.ok(near(v.speed, 200, 0.01));
  });

  it("turns the short way across the 180 degree seam", () => {
    const v = POV.viewAt(pov(), 1.036);
    assert.ok(Math.abs(Math.abs(v.yaw) - 179) < 1.5, "should sit near 180, got " + v.yaw);
  });

  it("refuses to glide across a cut", () => {
    const p = pov();
    assert.equal(POV.viewAt(p, 5), null);
    assert.equal(POV.viewAt(p, 0.5), null);
  });

  it("blends eye height and ADS from the player state", () => {
    const s = POV.stateAt(pov(), 1.025);
    assert.ok(near(s.eyeHeight, 50, 0.01), "midway 60 to 40, got " + s.eyeHeight);
    assert.ok(near(s.ads, 0.5, 0.01));
    assert.equal(s.client, 3);
  });

  it("derives CoD4's vertical field of view and zooms with ADS", () => {
    /* cg_fov 80 at 4:3 is about 64.4 degrees vertical. */
    assert.ok(near(POV.verticalFov(80, 50, 0), 64.37, 0.05));
    const zoomed = POV.verticalFov(80, 15, 1);
    assert.ok(zoomed < 12 && zoomed > 10, "sniper zoom, got " + zoomed);
    assert.ok(POV.verticalFov(80, 50, 0.5) < POV.verticalFov(80, 50, 0));
  });
});
