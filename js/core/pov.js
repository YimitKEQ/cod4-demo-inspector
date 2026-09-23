/*!
 * pov.js - the recording player's view, as his client drew it.
 *
 * The demo stores a frame for every client frame, about 125 a second: origin,
 * velocity, view angles, bob. The player state beside it, at snapshot rate,
 * adds the real eye height (which animates through crouch and prone), stance,
 * how far into aim down the sights, and the weapon. Together that is the
 * whole first person camera, so nothing here is estimated: it is sampled and
 * interpolated between samples 8 ms apart.
 *
 * Works on the `pov` block built by dm1.js (see buildPov there).
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

/* Offsets into one frame of pov.v. */
const X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, PITCH = 6, YAW = 7, ROLL = 8, BOB = 9;

/* Promod players almost universally play at the cap, cg_fov 80; the demo does
   not record the setting, so this is the one assumed number, and the UI says so. */
const DEFAULT_FOV = 80;
/* Eye height when the player state has none yet: the game's standing value. */
const STAND_EYE = 60;
/* A gap between frames longer than this is a cut (death, spectator switch),
   not motion, so the camera jumps rather than gliding across the map. */
const MAX_GAP_MS = 250;

/** Index of the last element of a sorted typed array at or before t, or -1. */
function lastAtOrBefore(arr, t){
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Shortest way from angle a to b, in degrees, as a fraction f of the turn. */
function lerpAngle(a, b, f){
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * f;
}

/**
 * The view at time tS (seconds since match start), or null outside the
 * recording. Returns { x, y, z, vx, vy, vz, pitch, yaw, roll, bob, speed }.
 */
function viewAt(pov, tS){
  if (!pov || !pov.t || !pov.t.length) return null;
  const tMs = tS * 1000;
  const i = lastAtOrBefore(pov.t, tMs);
  if (i < 0) return null;
  const s = pov.stride, v = pov.v;
  const a = i * s;
  let j = i + 1, f = 0;
  if (j < pov.t.length && pov.t[j] - pov.t[i] <= MAX_GAP_MS) {
    f = (tMs - pov.t[i]) / (pov.t[j] - pov.t[i]);
  } else {
    j = i;
    if (tMs - pov.t[i] > MAX_GAP_MS) return null;
  }
  const b = j * s;
  const lin = k => v[a + k] + (v[b + k] - v[a + k]) * f;
  return {
    x: lin(X), y: lin(Y), z: lin(Z), vx: lin(VX), vy: lin(VY), vz: lin(VZ),
    pitch: lerpAngle(v[a + PITCH], v[b + PITCH], f),
    yaw: lerpAngle(v[a + YAW], v[b + YAW], f),
    roll: lerpAngle(v[a + ROLL], v[b + ROLL], f),
    bob: v[a + BOB],
    speed: Math.hypot(lin(VX), lin(VY))
  };
}

/**
 * Player state around tS: eye height and ADS fraction interpolated, the
 * rest from the latest sample. State rows are
 * [t, client, eFlags, pmFlags, eyeHeight, adsFraction, weaponState, lean,
 *  weapon, legsAnim, torsoAnim].
 */
function stateAt(pov, tS){
  const st = pov && pov.state;
  if (!st || !st.length) return null;
  const tMs = tS * 1000;
  let lo = 0, hi = st.length - 1, i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (st[mid][0] <= tMs) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (i < 0) return null;
  const a = st[i], b = st[i + 1];
  const f = b && b[0] > a[0] && b[0] - a[0] < 500 ? Math.min(1, (tMs - a[0]) / (b[0] - a[0])) : 0;
  const num = (k, dflt) => {
    const va = Number.isFinite(a[k]) ? a[k] : dflt;
    const vb = b && Number.isFinite(b[k]) ? b[k] : va;
    return va + (vb - va) * f;
  };
  return {
    client: a[1], eFlags: a[2], pmFlags: a[3],
    eyeHeight: num(4, STAND_EYE), ads: Math.max(0, Math.min(1, num(5, 0))),
    weaponState: a[6], lean: num(7, 0), weapon: a[8], legsAnim: a[9], torsoAnim: a[10],
    weapAnim: a[11] | 0
  };
}

/**
 * Vertical field of view in degrees, the way CoD4 derives it.
 * cg_fov is the horizontal angle on a 4:3 screen; wider screens see more to
 * the sides with the same vertical angle. Aiming down the sights blends to
 * the weapon's own zoom by the ADS fraction.
 */
function verticalFov(cgFov, adsZoomFov, ads){
  const h = adsZoomFov && ads > 0 ? cgFov + (adsZoomFov - cgFov) * ads : cgFov;
  const rad = (h * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(rad / 2) * 0.75) * 180) / Math.PI;
}

const API = { viewAt, stateAt, verticalFov, lerpAngle, lastAtOrBefore, DEFAULT_FOV, STAND_EYE };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_POV = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
