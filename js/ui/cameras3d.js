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
/* A camera pulled in by a wall stops this far short of it, and never closer
   to the player than the second value, or it ends up inside his head. */
const CAM_WALL_GAP = 16;
const CAM_MIN_DIST = 40;
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
      orbit.dist = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.62;
      fly.pos.copy(orbit.target).add(new THREE.Vector3(0, orbit.dist * 0.45, orbit.dist * 0.6));
    }
    /* Low and close enough that buildings have height and the streets read as
       streets. The old default sat high and far, which turns any map into a
       floor plan no matter how well it is lit. */
    orbit.yaw = 0.8; orbit.pitch = 0.34;
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

    /* The recorder's own eyes, exactly: his client's frames at 125 a second
       for position and angles, the player state for the real eye height and
       how far into the sights he is, the weapon's own zoom for the field of
       view. See js/core/pov.js. */
    if (mode === "eyes" && state.model.pov && root.DM1_POV) {
      const P = root.DM1_POV;
      const view = P.viewAt(state.model.pov, t);
      if (view) {
        const ps = P.stateAt(state.model.pov, t);
        const eye = ps ? ps.eyeHeight : P.STAND_EYE;
        cam.position.copy(V(view.x, view.y, view.z + eye));
        const wf = ps && state.model.weaponFiles[ps.weapon];
        const wd = wf && weapons && weapons[String(wf).toLowerCase()];
        setFov(P.verticalFov(P.DEFAULT_FOV, wd ? wd.adsZoomFov : null, ps ? ps.ads : 0));
        /* CoD angles: pitch positive looks down, yaw counter clockwise from
           +X, roll about the view axis. Built as yaw, then pitch, then roll,
           in the scene's Y up frame. */
        const D = Math.PI / 180;
        cam.rotation.set(0, 0, 0);
        cam.quaternion.setFromEuler(new THREE.Euler(
          -view.pitch * D, (view.yaw - 90) * D, -view.roll * D, "YXZ"));
        return;
      }
    }

    if (mode === "eyes" || mode === "eyesApprox") {
      const m = state.model;
      const client = mode === "eyes" ? m.info.povClient : state.followClient;
      const pos = MODEL.positionAt(m.tracks, client, t, null);
      if (pos) {
        const eye = V(pos.x, pos.y, pos.z + EYE_H);
        cam.position.lerp(eye, 1 - Math.exp(-22 * dt));
        const yaw = (pos.yaw * Math.PI) / 180;
        /* Pitch comes with entity samples (positive looks down, as in the
           game); the recorder's own frames have none and stay level. */
        const sample = m.tracks[String(client)][pos.sample];
        const pitchDeg = sample && sample[7] !== null && sample[7] !== undefined ? sample[7] : 0;
        const pitch = (Math.max(-85, Math.min(85, pitchDeg)) * Math.PI) / 180;
        const look = eye.clone().add(new THREE.Vector3(
          Math.cos(yaw) * Math.cos(pitch) * 1000, -Math.sin(pitch) * 1000,
          -Math.sin(yaw) * Math.cos(pitch) * 1000));
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
    /* With a real map there are real walls, and a follow camera that swings
       through one shows the inside of a brick. Pull it in to just short of
       whatever stands between it and the player, and do not ease into that
       spot: easing is exactly how it would pass through the wall. */
    if (collider && mode === "follow") {
      const view = clearView(target, yaw, pitch, dist);
      if (view) {
        /* Remember the swing so the camera stays on the open side instead of
           searching again, and flickering, every frame. */
        orbit.yaw = view.yaw;
        orbit.pitch = Math.max(orbit.pitch, view.pitch);
        want.copy(target).addScaledVector(view.dir, view.reach);
        cam.position.copy(want);
        cam.lookAt(target);
        return;
      }
    }
    cam.position.lerp(want, 1 - Math.exp(-9 * dt));
    cam.lookAt(target);
  }

  /**
   * Where a follow camera can see the player from, near the framing asked for.
   *
   * Tries the requested angle first, then swings left and right in growing
   * steps and lifts, as a game's third person camera does in an alley. The
   * first angle with most of the distance clear wins; failing that, the one
   * with the most room. Returns null when the requested angle is already
   * clear, so the normal eased framing carries on.
   */
  const SWINGS = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.0, -2.0, Math.PI];
  const LIFTS = [0, 0.35, 0.75];
  function clearView(target, yaw, pitch, dist){
    let best = null;
    for (const lift of LIFTS) {
      const p = Math.min(1.35, pitch + lift);
      for (const swing of SWINGS) {
        const y = yaw + swing;
        const dir = new THREE.Vector3(Math.cos(y) * Math.cos(p), Math.sin(p), Math.sin(y) * Math.cos(p));
        const hit = collider(target, dir, dist);
        const room = Math.min(dist, hit - CAM_WALL_GAP);
        if (swing === 0 && lift === 0 && hit >= dist) return null;
        if (room >= dist * 0.7) return { yaw: y, pitch: p, dir, reach: room };
        if (!best || room > best.reach) best = { yaw: y, pitch: p, dir, reach: Math.max(CAM_MIN_DIST, room) };
      }
    }
    return best;
  }

  /* Weapon definitions (maps3d/_players/weapons.json), for ADS zoom. */
  let weapons = null;
  function setWeapons(w){ weapons = w || null; }

  /** A function (origin, unit direction, max distance) -> distance to the
      first wall, or null to switch collision off. */
  let collider = null;
  function setCollider(fn){ collider = fn || null; }

  return {
    group,
    active: () => cam,
    update, reset, setBounds, setAspect, setMode, setCollider, setWeapons,
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
