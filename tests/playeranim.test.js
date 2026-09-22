/*!
 * playeranim.test.js - the rules that pick a soldier's animation from what
 * the demo says he is doing.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const PA = require("../js/ui/playeranim.js");

/** A track moving at a constant velocity, sampled every 50 ms. */
function track(vx, vy, flags){
  const out = [];
  for (let i = 0; i < 20; i++) out.push([i * 5, vx * i * 0.05, vy * i * 0.05, 0, 0, 1, flags, 0]);
  return out;
}

describe("playeranim", () => {
  it("reads stance from the entity flags, prone winning over crouch", () => {
    assert.equal(PA.stanceOf(0), "stand");
    assert.equal(PA.stanceOf(PA.EF_CROUCHING), "crouch");
    assert.equal(PA.stanceOf(PA.EF_PRONE | PA.EF_CROUCHING), "prone");
    assert.equal(PA.stanceOf(null), "stand");
  });

  it("measures ground speed from the track", () => {
    const v = PA.velocityAt(track(190, 0, 0), 19);
    assert.ok(Math.abs(v.speed - 190) < 1, "expected 190, got " + v.speed);
  });

  it("tells forward, back, left and right apart relative to facing", () => {
    assert.equal(PA.directionOf(1, 0, 0), "f");
    assert.equal(PA.directionOf(-1, 0, 0), "b");
    assert.equal(PA.directionOf(0, 1, 0), "l");
    assert.equal(PA.directionOf(0, -1, 0), "r");
    /* Facing +Y (yaw 90) and moving +Y is forward. */
    assert.equal(PA.directionOf(0, 1, 90), "f");
    /* Wraps across the -180/180 seam. */
    assert.equal(PA.directionOf(-1, 0.01, 179), "f");
  });

  it("picks the gait from speed and stance", () => {
    assert.equal(PA.chooseRole("stand", 5, "f").role, "stand");
    assert.equal(PA.chooseRole("stand", 90, "l").role, "walk_l");
    assert.equal(PA.chooseRole("stand", 190, "f").role, "run_f");
    assert.equal(PA.chooseRole("stand", 280, "f").role, "sprint");
    assert.equal(PA.chooseRole("stand", 280, "b").role, "run_b", "nobody sprints backwards");
    assert.equal(PA.chooseRole("crouch", 110, "r").role, "crouch_r");
    assert.equal(PA.chooseRole("prone", 2, "f").role, "prone");
    assert.equal(PA.chooseRole("prone", 40, "f").role, "prone_f");
  });

  it("plays a clip faster when the player covers ground faster", () => {
    const slow = PA.chooseRole("stand", 150, "f").rate;
    const fast = PA.chooseRole("stand", 220, "f").rate;
    assert.ok(fast > slow, "rate should grow with speed");
  });
});
