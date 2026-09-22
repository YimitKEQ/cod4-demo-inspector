/*!
 * cameras3d.js - the camera rigs for the 3D view.
 *
 * Number keys switch between them:
 *   1 free fly    WASD, mouse look, Q and E for down and up, shift to hurry
 *   2 orbit       drag to spin around the followed player, wheel to pull back
 *   3 follow      behind the shoulder, smoothed
 *   4 eyes        the recorder's own first person, exact, from playerState
 *   5 eyes approx anyone else's, from entity angles, and it says approximate
 *   6 tactical    top down with a slight tilt
 *
 * Plus the one that matters most: replay(). Point it at a kill and it frames
 * both players, swings around the shot and slows through the moment. That is
 * the "just let me see the kill" button, and it is the same window the batch
 * renderer will later hand to the game.
 *
 * Motion only ever happens in response to something Lodie did, and camera
 * moves ease rather than snap.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const MAPMESH = root.DM1_MAPMESH;
const MODEL = root.DM1_MODEL;

const EYE_H = 60;
const PLAYER_H = 72;

const MODES = ["fly", "orbit", "follow", "eyes", "eyesApprox", "tactical"];
const MODE_LABEL = {
  fly: "Free fly", orbit: "Orbit", follow: "Follow",
  eyes: "Recorder eyes", eyesApprox: "Player eyes (approximate)",
  tactical: "Tactical"
};

/* Movement in world units per second. A CoD4 player runs about 190. */
const FLY_SPEED = 900;
const FLY_FAST = 2600;

const DEFAULT_FOV = 75;
/* Narrow enough to read as a plan view rather than a wide angle photograph. */
const TACTICAL_FOV = 34;
/* Fraction of the fitted distance to actually use. Below 1 the map overflows
   the bounding sphere slightly and fills the frame, which is what you want:
   the sphere's corners are empty space. */
const TACTICAL_FILL = 0.78;
/* Fixed heading, so the tactical view is the same way up every time and two
   rounds can be compared without re-orienting. */
const TACTICAL_YAW = Math.PI / 2;

const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

function createCameraRig(THREE, dom, state){
  const group = new THREE.Group();
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 8, 30000);
  group.add(cam);

  let mode = "orbit";
  let bounds = null;
  let last = performance.now();

  /* Free fly state. */
  const fly = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.35, keys: new Set() };

  /* Orbit state. */
  const orbit = { yaw: 0.8, pitch: 0.75, dist: 2200, target: new THREE.Vector3() };

  /* Replay state: a scripted move that owns the camera until it finishes. */
  let replay = null;

  const V = (x, y, z) => {
    const s = MAPMESH.toScene(x, y, z);
    return new THREE.Vector3(s[0], s[1], s[2]);
  };

  function setFov(f){
    if (Math.abs(cam.fov - f) < 0.01) return;
    cam.fov = f;
    cam.updateProjectionMatrix();
  }

  /** Centre of the map in scene space. */
  function mapCentre(){
    const b = bounds;
    if (!b) return orbit.target;
    return new THREE.Vector3((b.minX + b.maxX) / 2, b.minZ, -(b.minY + b.maxY) / 2);
  }

  /* ---- input ---- */

  let dragging = false, lastX = 0, lastY = 0, pointerLocked = false;

  dom.addEventListener("pointerdown", e => {
    if (mode === "fly") {
      dom.requestPointerLock && dom.requestPointerLock();
      return;
    }
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener("pointerup", e => {
    dragging = false;
    if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  });
  dom.addEventListener("pointermove", e => {
    if (pointerLocked && mode === "fly") {
      fly.yaw -= e.movementX * 0.0022;
      fly.pitch = Math.max(-1.5, Math.min(1.5, fly.pitch - e.movementY * 0.0022));
      cancelReplay();
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (mode === "orbit" || mode === "follow" || mode === "tactical") {
      orbit.yaw -= dx * 0.005;
      orbit.pitch = Math.max(0.06, Math.min(1.5, orbit.pitch + dy * 0.005));
      cancelReplay();
    }
  });
  dom.addEventListener("wheel", e => {
    if (mode === "eyes" || mode === "eyesApprox") return;
    e.preventDefault();
    orbit.dist = Math.max(180, Math.min(9000, orbit.dist * (1 + Math.sign(e.deltaY) * 0.12)));
    cancelReplay();
  }, { passive: false });

  document.addEventListener("pointerlockchange", () => {
    pointerLocked = document.pointerLockElement === dom;
  });

  window.addEventListener("keydown", e => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    fly.keys.add(e.code);
  });
  window.addEventListener("keyup", e => fly.keys.delete(e.code));
  window.addEventListener("blur", () => fly.keys.clear());

  /* ---- modes ---- */

  function setMode(next){
    if (MODES.indexOf(next) < 0) return;
    /* Entering free fly starts from wherever you were looking, so the switch
       never teleports you somewhere unrecognisable. */
    if (next === "fly" && mode !== "fly") {
      fly.pos.copy(cam.position);
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      fly.yaw = Math.atan2(-dir.x, -dir.z);
      fly.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    }
    if (next !== "fly" && pointerLocked) document.exitPointerLock();
    mode = next;
    cancelReplay();
    state.emit("camera");
  }

  function reset(model){
    const b = bounds;
    if (b) {
      orbit.target.set((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, -(b.minY + b.maxY) / 2);
      orbit.dist = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.9;
      fly.pos.copy(orbit.target).add(new THREE.Vector3(0, orbit.dist * 0.6, orbit.dist * 0.6));
    }
    orbit.yaw = 0.8; orbit.pitch = 0.75;
    /* Rebuilding the map must not steal the camera the user already chose.
       Loading the texture is asynchronous, so a camera picked from the URL or
       by a keypress was arriving before this ran and being silently reset to
       orbit: the Tactical button lit up while the view stayed oblique. */
    if (mode === "replay") mode = "orbit";
    replay = null;
  }

  function setBounds(b){ bounds = b; }
  function setAspect(a){ cam.aspect = a; cam.updateProjectionMatrix(); }

  /* ---- the replay move ---- */

  /**
   * Frame a kill and swing around it.
   *
   * The camera sits off to the side of the shot line so both players and the
   * line between them are visible, then arcs slowly while the clip plays. It
   * ends by handing control back to the follow camera rather than snapping.
   */
  function startReplay(kill, model){
    if (!kill || !kill.killerPos || !kill.victimPos) return false;
    const a = V(kill.killerPos.x, kill.killerPos.y, kill.killerPos.z + EYE_H);
    const b = V(kill.victimPos.x, kill.victimPos.y, kill.victimPos.z + PLAYER_H * 0.5);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const along = new THREE.Vector3().subVectors(b, a);
    const len = Math.max(140, along.length());
    along.normalize();

    /* Perpendicular in the horizontal plane, so the shot is seen across
       rather than down the barrel. */
    const side = new THREE.Vector3(-along.z, 0, along.x).normalize();
    if (side.lengthSq() < 0.1) side.set(1, 0, 0);

    const dist = Math.min(1400, Math.max(320, len * 0.85));
    replay = {
      kill,
      mid,
      side,
      dist,
      height: Math.max(120, len * 0.28),
      startedAt: performance.now(),
      swing: 0,
      /* Hold the framing until the clip window ends, then release. */
      until: kill.tS + 2.2
    };
    mode = "replay";
    state.emit("camera");
    return true;
  }

  function cancelReplay(){
    if (mode === "replay") {
      mode = "follow";
      state.emit("camera");
    }
    replay = null;
  }

  /* ---- per frame ---- */

  function positionOf(players, client){
    const node = players.get(client);
    if (!node || !node.holder.visible) return null;
    return node.holder.position;
  }

  function update(players, t){
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    /* Replay owns the camera while it lasts. */
    if (mode === "replay" && replay) {
      if (t > replay.until) { cancelReplay(); }
      else {
        replay.swing += dt * 0.22;
        const s = replay.side.clone()
          .multiplyScalar(Math.cos(replay.swing) * replay.dist);
        const f = new THREE.Vector3(-replay.side.z, 0, replay.side.x)
          .multiplyScalar(Math.sin(replay.swing) * replay.dist * 0.35);
        const want = replay.mid.clone().add(s).add(f)
          .add(new THREE.Vector3(0, replay.height, 0));
        cam.position.lerp(want, 1 - Math.exp(-6 * dt));
        cam.lookAt(replay.mid);
        return;
      }
    }

    const followed = state.followClient;
    const fp = positionOf(players, followed);
    if (fp) orbit.target.lerp(new THREE.Vector3(fp.x, fp.y + EYE_H, fp.z),
                              1 - Math.exp(-8 * dt));

    if (mode === "fly") {
      const speed = (fly.keys.has("ShiftLeft") || fly.keys.has("ShiftRight"))
        ? FLY_FAST : FLY_SPEED;
      const fwd = new THREE.Vector3(
        -Math.sin(fly.yaw) * Math.cos(fly.pitch),
        Math.sin(fly.pitch),
        -Math.cos(fly.yaw) * Math.cos(fly.pitch)
      );
      const right = new THREE.Vector3(Math.cos(fly.yaw), 0, -Math.sin(fly.yaw));
      const step = speed * dt;
      if (fly.keys.has("KeyW")) fly.pos.addScaledVector(fwd, step);
      if (fly.keys.has("KeyS")) fly.pos.addScaledVector(fwd, -step);
      if (fly.keys.has("KeyD")) fly.pos.addScaledVector(right, step);
      if (fly.keys.has("KeyA")) fly.pos.addScaledVector(right, -step);
      if (fly.keys.has("KeyE")) fly.pos.y += step;
      if (fly.keys.has("KeyQ")) fly.pos.y -= step;
      cam.position.copy(fly.pos);
      cam.lookAt(fly.pos.clone().add(fwd));
      return;
    }

    if (mode === "eyes" || mode === "eyesApprox") {
      const m = state.model;
      const client = mode === "eyes" ? m.info.povClient : state.followClient;
      const pos = MODEL.positionAt(m.tracks, client, t, null);
      if (pos) {
        const eye = V(pos.x, pos.y, pos.z + EYE_H);
        cam.position.lerp(eye, 1 - Math.exp(-22 * dt));
        const yaw = (pos.yaw * Math.PI) / 180;
        /* Only yaw is carried into the tracks, so the pitch is level. That is
           a limitation of what buildMap keeps, not of the demo. */
        const look = eye.clone().add(new THREE.Vector3(
          Math.cos(yaw) * 1000, 0, -Math.sin(yaw) * 1000));
        cam.lookAt(look);
        return;
      }
    }

    /* Orbit, follow and tactical are the same rig with different framing. */
    let pitch = orbit.pitch, dist = orbit.dist, yaw = orbit.yaw;
    let target = orbit.target;

    if (mode === "follow") { dist = Math.min(dist, 620); pitch = Math.max(pitch, 0.35); }

    if (mode === "tactical") {
      /* Tactical frames the whole map, not the followed player: looking down
         on one corner is not a tactical view. A narrow field of view keeps it
         close to orthographic, so distances across the map stay comparable
         instead of fanning out towards the edges. */
      pitch = 1.30;
      yaw = TACTICAL_YAW;
      if (bounds) {
        target = mapCentre();
        /* Fit the map's bounding sphere rather than its width or height. The
           camera is tilted and the map is not axis aligned on screen, so any
           single axis measurement under-fills the frame; the sphere is
           orientation independent and always fits. */
        const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
        const radius = 0.5 * Math.hypot(w, h);
        const halfFov = (TACTICAL_FOV * Math.PI) / 360;
        const vertical = radius / Math.sin(halfFov);
        const horizontal = radius / Math.sin(Math.atan(Math.tan(halfFov) * Math.max(0.2, cam.aspect)));
        dist = Math.max(vertical, horizontal) * TACTICAL_FILL;
      }
      setFov(TACTICAL_FOV);
    } else {
      setFov(DEFAULT_FOV);
    }

    const want = new THREE.Vector3(
      target.x + Math.cos(yaw) * Math.cos(pitch) * dist,
      target.y + Math.sin(pitch) * dist,
      target.z + Math.sin(yaw) * Math.cos(pitch) * dist
    );
    cam.position.lerp(want, 1 - Math.exp(-9 * dt));
    cam.lookAt(target);
  }

  return {
    group,
    active: () => cam,
    update, reset, setBounds, setAspect, setMode,
    startReplay, cancelReplay,
    get mode(){ return mode; },
    label: () => (mode === "replay" ? "Replay" : MODE_LABEL[mode] || mode),
    MODES, MODE_LABEL
  };
}

const API = { createCameraRig, MODES, MODE_LABEL };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_CAMERAS = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
