/*!
 * viewmodel.js - the gun and arms in first person, as the recorder saw them.
 *
 * The game draws the first person weapon in its own pass with the depth buffer
 * cleared, so it never pokes into walls, and places the arms model's tag_view
 * at the eye, looking along its +X. This does the same: a small scene with its
 * own camera, drawn after the world.
 *
 * What plays is not guessed. The player state carries weapAnim, the number of
 * the first person animation the game was playing (idle, fire, reload,
 * sprint...), and fWeaponPosFrac, how far into aim down the sights. The
 * animation files are the weapon's own, packed by tools/weaponmodels.js.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

/* Bit 9 of weapAnim flips when the same animation restarts. */
const ANIM_TOGGLE = 0x200;
/* Blending between two first person animations, as the game roughly does. */
const FADE_S = 0.08;

function createViewmodel(THREE){
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 1, 400);
  /* The arms model looks along +X; the camera along -Z. A quarter turn
     about Y lines them up. */
  const mount = new THREE.Group();
  mount.rotation.y = Math.PI / 2;
  camera.add(mount);
  scene.add(camera);

  const hemi = new THREE.HemisphereLight(0xC8D2DC, 0x5A5046, 1.1);
  const sun = new THREE.DirectionalLight(0xFFF1D2, 1.6);
  sun.position.set(0.4, 1, 0.3);
  scene.add(hemi, sun);

  let weapons = null;           /* weapons.json */
  let current = null;           /* { name, soldier, mixer, clips, byNumber, action, lastAnim } */
  let loading = null;
  const cache = new Map();

  function setWeapons(spec){ weapons = spec; }

  /** Load a weapon's arms, gun and clips once; resolves to a ready rig. */
  function loadWeapon(name){
    if (cache.has(name)) return cache.get(name);
    /* Asked before the weapon list arrived: say no without remembering it,
       or the gun would never load once the list is there. */
    if (!weapons) return Promise.resolve(null);
    const w = weapons[name];
    const SK = root.DM1_SKINNED, PA = root.DM1_PLAYERANIM;
    if (!w || !w.viewFile || !SK || !PA) return Promise.resolve(null);
    const urls = [w.handFile, w.viewFile].filter(Boolean).map(f => "maps3d/weapons/view/" + f);
    const job = Promise.all([
      SK.loadTemplate(THREE, urls, { "*": "tag_weapon" }),
      w.animFile ? fetch("maps3d/weapons/anims/" + w.animFile).then(r => (r.ok ? r.json() : null)) : null
    ]).then(([template, anims]) => {
      const soldier = SK.instantiate(THREE, template);
      soldier.meshes.forEach(m => {
        m.castShadow = false;
        (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => { mt.transparent = false; });
      });
      const clips = anims ? PA.buildClips(THREE, anims, soldier.rest) : new Map();
      return { name, soldier, clips, byNumber: (anims && anims.byNumber) || {},
               mixer: new THREE.AnimationMixer(soldier.group), action: null, lastAnim: -1, ads: null };
    }).catch(err => {
      console.warn("first person weapon " + name + ": " + (err && err.message ? err.message : err));
      return null;
    });
    cache.set(name, job);
    return job;
  }

  function show(rig){
    if (current && current.soldier.group.parent) mount.remove(current.soldier.group);
    current = rig;
    if (rig) mount.add(rig.soldier.group);
  }

  /** Play the clip for weapAnim, restarting when the toggle bit flips. */
  function playAnim(rig, weapAnim){
    const clipName = rig.byNumber[weapAnim & ~ANIM_TOGGLE] || rig.byNumber[0];
    const clip = clipName && rig.clips.get(clipName);
    if (!clip) return;
    if (weapAnim === rig.lastAnim && rig.action) return;
    rig.lastAnim = weapAnim;
    const next = rig.mixer.clipAction(clip);
    next.reset();
    next.setLoop(clip.loopMode ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = true;
    next.play();
    if (rig.action && rig.action !== next) rig.action.crossFadeTo(next, FADE_S, false);
    rig.action = next;
  }

  /**
   * Aim down the sights: the weapon's ADS clip, held at its last frame, blended
   * in by how far into the sights the player state says he is.
   */
  function applyAds(rig, ads){
    const up = rig.byNumber.adsUp && rig.clips.get(rig.byNumber.adsUp);
    if (!up) return;
    if (!rig.ads) {
      rig.ads = rig.mixer.clipAction(up);
      rig.ads.setLoop(THREE.LoopOnce, 1);
      rig.ads.clampWhenFinished = true;
      rig.ads.play();
      rig.ads.time = up.duration;
      rig.ads.paused = true;
    }
    rig.ads.setEffectiveWeight(ads);
    if (rig.action) rig.action.setEffectiveWeight(1 - ads);
  }

  /**
   * Per frame, in first person only. weaponName is the raw weapon file name,
   * state the pov state (weapAnim, ads), dt the match time step.
   */
  function update(mainCamera, weaponName, state, dt){
    camera.position.copy(mainCamera.position);
    camera.quaternion.copy(mainCamera.quaternion);
    if (camera.aspect !== mainCamera.aspect) { camera.aspect = mainCamera.aspect; camera.updateProjectionMatrix(); }

    if (!weaponName) { show(null); return; }
    if (!current || current.name !== weaponName) {
      if (loading !== weaponName && weapons) {
        loading = weaponName;
        loadWeapon(weaponName).then(rig => { if (loading === weaponName) show(rig); });
      }
      if (!current || current.name !== weaponName) return;
    }
    if (state) {
      playAnim(current, state.weapAnim | 0);
      applyAds(current, Math.max(0, Math.min(1, state.ads || 0)));
    }
    current.mixer.update(Math.max(0, Math.min(0.25, dt)));
  }

  /** Draw after the world, over a cleared depth buffer. */
  function render(renderer){
    if (!current) return;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, camera);
    renderer.autoClear = auto;
  }

  function hide(){ show(null); loading = null; }

  return { update, render, hide, setWeapons, scene, camera, mount,
           get loaded(){ return current ? current.name : null; } };
}

const API = { createViewmodel };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_VIEWMODEL = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
