/*!
 * playeranim.js - drive each soldier with the game's own animations.
 *
 * The demo gives a position, a facing and the entity flags a few dozen times a
 * second. From those this works out what the player is doing (standing,
 * walking, running, sprinting, crouched, prone) and which way he is moving
 * relative to where he looks, then plays the matching clip from common_mp.ff
 * at a speed that matches how fast he actually covers ground. Changes blend
 * over a fifth of a second, as the game's own animation tree does.
 *
 * The motion rules are pure functions so they can be tested without a GPU.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

/* Entity flags, from the game's bg_public.h. */
const EF_CROUCHING = 0x4;
const EF_PRONE = 0x8;

/* Ground speeds in units per second the clips were authored for, so a clip
   plays faster when a player covers ground faster and feet do not skate. */
const NATIVE_SPEED = { walk: 95, run: 190, sprint: 280, crouch: 115, prone: 38 };
/* Where one gait hands over to the next, in units per second. */
const IDLE_BELOW = 18;
const WALK_BELOW = 135;
const RUN_BELOW = 235;

const FADE_S = 0.2;
/* How far back to look when measuring speed: long enough to smooth over the
   snapshot rate, short enough to catch a stop. */
const VELOCITY_WINDOW_S = 0.2;

/** Stance from the entity flags; unknown flags read as standing. */
function stanceOf(flags){
  if (flags === null || flags === undefined) return "stand";
  if (flags & EF_PRONE) return "prone";
  if (flags & EF_CROUCHING) return "crouch";
  return "stand";
}

/**
 * Horizontal velocity at sample i of a track, from the samples just before it.
 * Tracks are [hundredths, x, y, z, yaw, weapon, flags, pitch].
 */
function velocityAt(track, i){
  if (!track || i <= 0) return { vx: 0, vy: 0, speed: 0 };
  const now = track[i];
  let j = i - 1;
  while (j > 0 && (now[0] - track[j][0]) / 100 < VELOCITY_WINDOW_S) j--;
  const dt = (now[0] - track[j][0]) / 100;
  if (dt <= 0 || dt > 1) return { vx: 0, vy: 0, speed: 0 };
  const vx = (now[1] - track[j][1]) / dt, vy = (now[2] - track[j][2]) / dt;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}

/**
 * Which way a player moves relative to where he faces: f, b, l or r.
 * CoD yaw turns counter clockwise from +X, so +90 degrees is to his left.
 */
function directionOf(vx, vy, yawDeg){
  let a = Math.atan2(vy, vx) * 180 / Math.PI - yawDeg;
  a = ((a % 360) + 540) % 360 - 180;
  if (Math.abs(a) <= 50) return "f";
  if (Math.abs(a) >= 130) return "b";
  return a > 0 ? "l" : "r";
}

/**
 * The clip role for a moment, and how fast to play it.
 * Returns { role, rate } where role names a clip in anims.json.
 */
function chooseRole(stance, speed, dir){
  if (stance === "prone") {
    if (speed < IDLE_BELOW * 0.6) return { role: "prone", rate: 1 };
    return { role: "prone_" + dir, rate: speed / NATIVE_SPEED.prone };
  }
  if (stance === "crouch") {
    if (speed < IDLE_BELOW) return { role: "crouch", rate: 1 };
    return { role: "crouch_" + dir, rate: speed / NATIVE_SPEED.crouch };
  }
  if (speed < IDLE_BELOW) return { role: "stand", rate: 1 };
  if (speed < WALK_BELOW) return { role: "walk_" + dir, rate: speed / NATIVE_SPEED.walk };
  if (speed >= RUN_BELOW && dir === "f") return { role: "sprint", rate: speed / NATIVE_SPEED.sprint };
  return { role: "run_" + dir, rate: speed / NATIVE_SPEED.run };
}

/**
 * AnimationClips for one skeleton. Rotations are absolute bone local;
 * translations are offsets on the bone's rest position, which is why the
 * rest pose is needed here. Bones the model does not have are skipped rather
 * than left for three.js to warn about every frame.
 */
function buildClips(THREE, anims, rest){
  const clips = new Map();
  for (const [role, c] of Object.entries(anims.clips || {})) {
    const tracks = [];
    const fps = c.fps || 30;
    for (const [bone, b] of Object.entries(c.bones)) {
      const r = rest.get(bone);
      if (!r) continue;
      if (b.q && b.qt) {
        tracks.push(new THREE.QuaternionKeyframeTrack(bone + ".quaternion",
          b.qt.map(f => f / fps), b.q));
      }
      if (b.p && b.pt) {
        const vals = new Array(b.p.length);
        for (let k = 0; k < b.p.length; k += 3) {
          vals[k] = r.p.x + b.p[k]; vals[k + 1] = r.p.y + b.p[k + 1]; vals[k + 2] = r.p.z + b.p[k + 2];
        }
        tracks.push(new THREE.VectorKeyframeTrack(bone + ".position", b.pt.map(f => f / fps), vals));
      }
    }
    const duration = Math.max(1 / fps, (c.frames || 1) / fps);
    const clip = new THREE.AnimationClip(role, duration, tracks);
    clip.loopMode = c.loop;
    clips.set(role, clip);
  }
  return clips;
}

/** One player's mixer and current action. */
function Animator(THREE, instance, clips){
  this.mixer = new THREE.AnimationMixer(instance.group);
  this.clips = clips;
  this.actions = new Map();
  this.current = null;
  this.THREE = THREE;
}

Animator.prototype.action = function(role){
  if (this.actions.has(role)) return this.actions.get(role);
  const clip = this.clips.get(role) || this.clips.get("stand");
  if (!clip) return null;
  const a = this.mixer.clipAction(clip);
  a.setLoop(clip.loopMode === false ? this.THREE.LoopOnce : this.THREE.LoopRepeat, Infinity);
  a.clampWhenFinished = true;
  this.actions.set(role, a);
  return a;
};

/** Switch to a role (blending) and advance by dt seconds of match time. */
Animator.prototype.update = function(role, rate, dt){
  const next = this.action(role);
  if (next && next !== this.current) {
    next.reset();
    next.play();
    if (this.current) this.current.crossFadeTo(next, FADE_S, false);
    this.current = next;
  }
  if (this.current) this.current.timeScale = Math.max(0.5, Math.min(1.8, rate || 1));
  this.mixer.update(Math.max(0, Math.min(0.25, dt)));
};

const API = { stanceOf, velocityAt, directionOf, chooseRole, buildClips, Animator,
              EF_CROUCHING, EF_PRONE };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_PLAYERANIM = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
