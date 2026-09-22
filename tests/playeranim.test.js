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

  it("learns what each server animation index means from the demo", () => {
    /* Index 7: crouched, moving left. Index 9: standing, sprinting forward. */
    const tr = [];
    for (let i = 0; i < 40; i++) tr.push([i * 5, 0, i * 6, 0, 0, 1, PA.EF_CROUCHING, 0, 7, 0, 0]);
    const tr2 = [];
    for (let i = 0; i < 40; i++) tr2.push([i * 5, i * 14, 0, 0, 0, 1, 0, 0, 9 | 0x200, 0, 0]);
    const cal = PA.calibrate({ 1: tr, 2: tr2 });
    assert.equal(cal.get(7).role, "crouch_l");
    assert.equal(cal.get(9).role, "sprint");
  });

  it("follows the server's index over the speed rule when it knows it", () => {
    const cal = new Map([[7, { role: "crouch_l", speed: 120 }]]);
    const r = PA.roleForSample(cal, [0, 0, 0, 0, 0, 1, 0, 0, 7 | 0x200, 0, 0], 3, "f");
    assert.equal(r.role, "crouch_l");
    assert.equal(PA.roleForSample(cal, [0, 0, 0, 0, 0, 1, 0, 0, 99, 0, 0], 3, "f").role, "stand");
  });
});
