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
/* Where one gait hands over to the next, in units per second. 125 splits the
   combat walks (about 110) from the strafing combat runs (about 130) as the
   server itself classified them in a real match. */
const IDLE_BELOW = 18;
const WALK_BELOW = 125;
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

/* Bit 9 of legsAnim flips when the same animation restarts. */
const ANIM_TOGGLE = 0x200;
/* An index needs this many samples before its behaviour is trusted. */
const MIN_SAMPLES = 12;
/* Faster than a strafe jump; anything above is a teleport, not movement. */
const MAX_FOOT_SPEED = 600;

/**
 * Which clip stands for each legs animation the server sent, learned from
 * this demo.
 *
 * The demo records, per player and per snapshot, the index of the legs
 * animation the server was playing. Those indices are the server's own
 * decisions, switching at the exact moment the player's movement changed,
 * but the table that names them is compiled into the game. So each index is
 * characterised by what players demonstrably did while it played (stance,
 * ground speed, direction relative to facing, summed over the whole match)
 * and given the clip that matches that behaviour. Every player then follows
 * the server's own switches instead of thresholds on a noisy speed.
 *
 * Tracks are [hundredths, x, y, z, yaw, weapon, flags, pitch, legs, torso, moveDir].
 * Returns Map(index -> { role, speed }).
 */
function calibrate(tracks){
  const acc = new Map();
  for (const tr of Object.values(tracks || {})) {
    for (let i = 1; i < tr.length; i++) {
      const s = tr[i], legs = s[8];
      if (legs === null || legs === undefined) continue;
      const q = tr[i - 1];
      const dt = (s[0] - q[0]) / 100;
      if (dt <= 0 || dt > 0.2) continue;
      const vx = (s[1] - q[1]) / dt, vy = (s[2] - q[2]) / dt;
      const k = legs & ~ANIM_TOGGLE;
      let a = acc.get(k);
      if (!a) { a = { n: 0, crouch: 0, prone: 0, speeds: [], dir: { f: 0, b: 0, l: 0, r: 0 } }; acc.set(k, a); }
      const sp = Math.hypot(vx, vy);
      /* Nobody moves this fast on foot; it is a respawn or a cut. */
      if (sp > MAX_FOOT_SPEED) continue;
      a.n++;
      const st = stanceOf(s[6]);
      if (st === "crouch") a.crouch++;
      if (st === "prone") a.prone++;
      a.speeds.push(sp);
      if (sp > 30) a.dir[directionOf(vx, vy, s[4])]++;
    }
  }
  const out = new Map();
  for (const [k, a] of acc) {
    if (a.n < MIN_SAMPLES) continue;
    const stance = a.prone / a.n > 0.5 ? "prone" : a.crouch / a.n > 0.5 ? "crouch" : "stand";
    /* The median, so a handful of odd samples cannot move an index into
       another gait. */
    const sorted = a.speeds.sort((x, y) => x - y);
    const speed = sorted[sorted.length >> 1];
    const moving = a.dir.f + a.dir.b + a.dir.l + a.dir.r;
    const dir = moving ? Object.entries(a.dir).sort((x, y) => y[1] - x[1])[0][0] : "f";
    out.set(k, { role: chooseRole(stance, speed, dir).role, speed });
  }
  return out;
}

/**
 * The role for one sample: the calibrated one when the server's index is
 * known, the speed rule otherwise. The rate always follows real ground speed.
 */
function roleForSample(calib, sample, speed, dir){
  const legs = sample[8];
  const hit = calib && legs !== null && legs !== undefined ? calib.get(legs & ~ANIM_TOGGLE) : null;
  const fallback = chooseRole(stanceOf(sample[6]), speed, dir);
  if (!hit) return fallback;
  const native = /^prone/.test(hit.role) ? NATIVE_SPEED.prone : /^crouch/.test(hit.role) ? NATIVE_SPEED.crouch
    : /^walk/.test(hit.role) ? NATIVE_SPEED.walk : hit.role === "sprint" ? NATIVE_SPEED.sprint : NATIVE_SPEED.run;
  const idle = hit.role === "stand" || hit.role === "crouch" || hit.role === "prone";
  return { role: hit.role, rate: idle ? 1 : (speed > 5 ? speed : hit.speed) / native };
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
        /* Body clips move bones by small offsets on the rest pose; first
           person weapon clips give the positions themselves (tag_torso
           animates to exactly its rest position). The packer says which. */
        const base = c.absoluteTrans ? { x: 0, y: 0, z: 0 } : r.p;
        const vals = new Array(b.p.length);
        for (let k = 0; k < b.p.length; k += 3) {
          vals[k] = base.x + b.p[k]; vals[k + 1] = base.y + b.p[k + 1]; vals[k + 2] = base.z + b.p[k + 2];
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

const API = { stanceOf, velocityAt, directionOf, chooseRole, calibrate, roleForSample, buildClips, Animator,
              EF_CROUCHING, EF_PRONE };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_PLAYERANIM = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
