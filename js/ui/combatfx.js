/*!
 * combatfx.js - bullets, explosions, flashbangs and smoke in the 3D view.
 *
 * Every shot is in the demo: each fire event from each player's event queue,
 * with the shooter and the time (js/core/dm1.js, buildShots). A tracer runs
 * from his eye along his aim at that instant to the first wall, or to the
 * player the shot killed. Grenades come from their own flights: a frag or a
 * flashbang goes off where its missile stopped being sent, a smoke grenade
 * pops where it lands and hangs for as long as the game keeps it.
 *
 * Everything is pooled and allocated once; the frame loop only moves and
 * fades what is already there.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const TRACER_POOL = 48;
const BLAST_POOL = 12;
const SMOKE_POOL = 10;
const PUFFS_PER_SMOKE = 14;

/* Bullets are hitscan; the streak is drawn travelling so the eye can follow
   it, fast enough to read as instant. */
const TRACER_SPEED = 16000;
const TRACER_LEN = 260;
const TRACER_MAX = 8000;
const SPARK_S = 0.18;
/* After it lands, the shot's whole path stays as a fading line this long, so
   a burst can be read on a paused frame. */
const TRAIL_S = 0.4;
const MUZZLE_S = 0.05;
/* A kill this soon after a shot by the same player was that shot. */
const KILL_MATCH_S = 0.12;

const FRAG_S = 0.9;
const FLASH_S = 0.45;
/* How long a smoke grenade's cloud stands in CoD4, and how long it takes to
   build and to thin out. */
const SMOKE_HOLD_S = 16;
const SMOKE_GROW_S = 2.5;
const SMOKE_FADE_S = 4;

/** A soft round sprite texture, drawn once. */
function softDot(THREE, inner, outer){
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A lumpy smoke puff texture, so a cloud does not read as a stack of discs. */
function puffTexture(THREE){
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = 64 + (rnd() - 0.5) * 60, y = 64 + (rnd() - 0.5) * 60, r = 18 + rnd() * 26;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.28)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function createCombatFx(THREE, scene){
  const group = new THREE.Group();
  group.name = "combatfx";
  scene.add(group);

  /* ---- tracers ---- */
  const tracerRod = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
  tracerRod.translate(0, 0.5, 0);
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xFFD27A, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i++) {
    /* A thin glowing rod rather than a line: WebGL lines are one pixel wide
       at any distance, which is invisible from a camera above the map. */
    const line = new THREE.Mesh(tracerRod, tracerMat.clone());
    line.frustumCulled = false;
    line.visible = false;
    group.add(line);
    const spark = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softDot(THREE, "rgba(255,230,170,1)", "rgba(255,160,60,0)"),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    spark.visible = false;
    group.add(spark);
    const muzzle = new THREE.Sprite(spark.material.clone());
    muzzle.visible = false;
    group.add(muzzle);
    tracers.push({ line, spark, muzzle });
  }

  /* ---- frag and flash ---- */
  const fireTex = softDot(THREE, "rgba(255,220,150,1)", "rgba(255,90,20,0)");
  const flashTex = softDot(THREE, "rgba(255,255,255,1)", "rgba(220,235,255,0)");
  const blasts = [];
  for (let i = 0; i < BLAST_POOL; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: fireTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    s.visible = false;
    const light = new THREE.PointLight(0xFFB070, 0, 900, 2);
    light.visible = false;
    group.add(s, light);
    blasts.push({ sprite: s, light });
  }

  /* ---- smoke ---- */
  const puffMap = puffTexture(THREE);
  const smokes = [];
  for (let i = 0; i < SMOKE_POOL; i++) {
    const puffs = [];
    for (let k = 0; k < PUFFS_PER_SMOKE; k++) {
      const p = new THREE.Sprite(new THREE.SpriteMaterial({
        map: puffMap, color: 0xC9CCC4, transparent: true, depthWrite: false, opacity: 0
      }));
      p.visible = false;
      /* A fixed scatter per puff, so a cloud keeps its shape frame to frame. */
      const a = (k / PUFFS_PER_SMOKE) * Math.PI * 2 * 2.618;
      const r = 40 + ((k * 37) % 90);
      p.userData.off = new THREE.Vector3(Math.cos(a) * r, 30 + ((k * 53) % 140), Math.sin(a) * r);
      p.userData.size = 260 + ((k * 71) % 160);
      p.userData.spin = ((k * 29) % 100) / 100 * Math.PI * 2;
      group.add(p);
      puffs.push(p);
    }
    smokes.push(puffs);
  }

  const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  function hideAll(list, fn){ for (const x of list) fn(x); }

  /**
   * ctx: { model, t, aimAt(client, tS) -> { eye, dir } | null (scene space),
   *        raycast(origin, dir, max) -> distance, toScene(x, y, z, into),
   *        showTracers, showNadeFx }
   */
  function update(ctx){
    const t = ctx.t, m = ctx.model;

    /* Tracers: every shot whose streak is still in the air. */
    let slot = 0;
    if (ctx.showTracers && m.shots && m.shots.length) {
      const shots = m.shots;
      const window = TRACER_MAX / TRACER_SPEED + Math.max(SPARK_S, TRAIL_S);
      let lo = 0, hi = shots.length - 1, first = shots.length;
      const fromMs = (t - window) * 1000;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (shots[mid][0] >= fromMs) { first = mid; hi = mid - 1; } else lo = mid + 1; }
      for (let i = first; i < shots.length && slot < TRACER_POOL; i++) {
        const tShot = shots[i][0] / 1000;
        if (tShot > t) break;
        const shooter = shots[i][1];
        const aim = ctx.aimAt(shooter, tShot);
        if (!aim) continue;
        _o.copy(aim.eye);
        _d.copy(aim.dir).normalize();
        /* The victim, when this shot killed someone; otherwise the first wall. */
        let dist = TRACER_MAX;
        const kill = killFor(m, shooter, tShot);
        if (kill) {
          const at = ctx.victimChest(kill, tShot);
          if (at) { _d.copy(at).sub(_o); dist = _d.length(); _d.normalize(); }
        } else {
          const hit = ctx.raycast(_o, _d, TRACER_MAX);
          if (hit < dist) dist = hit;
        }
        const age = t - tShot;
        const head = Math.min(dist, age * TRACER_SPEED);
        const flying = head < dist;
        const landedAt = age - dist / TRACER_SPEED;
        if (!flying && landedAt > TRAIL_S && landedAt > SPARK_S) continue;
        const tail = flying ? Math.max(0, head - TRACER_LEN) : 0;
        const tr = tracers[slot++];
        /* The rod's unit Y axis points along the shot, from tail to head. */
        tr.line.position.copy(_o).addScaledVector(_d, tail);
        tr.line.quaternion.setFromUnitVectors(UP, _d);
        tr.line.scale.set(flying ? 1.6 : 0.9, Math.max(1, head - tail), flying ? 1.6 : 0.9);
        tr.line.visible = flying || landedAt < TRAIL_S;
        tr.line.material.opacity = flying ? 0.95 : 0.4 * (1 - landedAt / TRAIL_S);
        /* The spark where it lands, briefly. */
        const landedFor = age - dist / TRACER_SPEED;
        tr.spark.visible = landedFor >= 0 && landedFor < SPARK_S;
        if (tr.spark.visible) {
          tr.spark.position.copy(_o).addScaledVector(_d, dist - 2);
          const k = 1 - landedFor / SPARK_S;
          tr.spark.material.opacity = k;
          tr.spark.scale.setScalar(kill ? 10 : 18 * k + 4);
        }
        tr.muzzle.visible = age < MUZZLE_S;
        if (tr.muzzle.visible) {
          tr.muzzle.position.copy(_o).addScaledVector(_d, 30);
          tr.muzzle.scale.setScalar(22);
          tr.muzzle.material.opacity = 1 - age / MUZZLE_S;
        }
      }
    }
    for (; slot < TRACER_POOL; slot++) {
      const tr = tracers[slot];
      tr.line.visible = tr.spark.visible = tr.muzzle.visible = false;
    }

    /* Grenades. */
    let b = 0, s = 0;
    if (ctx.showNadeFx && m.grenades) {
      for (const nade of m.grenades) {
        const last = nade.path[nade.path.length - 1];
        const lastS = last[0] / 100;
        const impactS = nade.impactS !== null && nade.impactS !== undefined ? nade.impactS / 100 : lastS;
        if (nade.kind === "smoke") {
          const age = t - impactS;
          if (age < 0 || age > SMOKE_HOLD_S + SMOKE_FADE_S || s >= SMOKE_POOL) continue;
          const puffs = smokes[s++];
          ctx.toScene(nade.impact[0], nade.impact[1], nade.impact[2], _e);
          const grow = Math.min(1, age / SMOKE_GROW_S);
          const fade = age > SMOKE_HOLD_S ? 1 - (age - SMOKE_HOLD_S) / SMOKE_FADE_S : 1;
          for (const p of puffs) {
            p.visible = true;
            p.position.copy(_e).addScaledVector(p.userData.off, 0.4 + 0.6 * grow);
            p.position.y += age * 2;
            p.scale.setScalar(p.userData.size * (0.35 + 0.65 * grow));
            p.material.rotation = p.userData.spin + age * 0.05;
            p.material.opacity = 0.62 * fade * Math.min(1, age * 3);
          }
          continue;
        }
        if (nade.kind !== "frag" && nade.kind !== "flash") continue;
        const boomS = nade.predicted ? impactS : lastS;
        const age = t - boomS;
        const life = nade.kind === "frag" ? FRAG_S : FLASH_S;
        if (age < 0 || age > life || b >= BLAST_POOL) continue;
        const bl = blasts[b++];
        const at = nade.predicted ? nade.impact : [last[1], last[2], last[3]];
        ctx.toScene(at[0], at[1], at[2], bl.sprite.position);
        bl.sprite.position.y += 16;
        const k = age / life;
        const frag = nade.kind === "frag";
        bl.sprite.material.map = frag ? fireTex : flashTex;
        bl.sprite.visible = true;
        bl.sprite.scale.setScalar((frag ? 340 : 520) * (0.3 + 0.7 * Math.sqrt(k)));
        bl.sprite.material.opacity = 1 - k;
        bl.light.visible = true;
        bl.light.position.copy(bl.sprite.position);
        bl.light.color.setHex(frag ? 0xFFB070 : 0xEEF4FF);
        bl.light.intensity = (frag ? 60000 : 120000) * (1 - k) * (1 - k);
      }
    }
    for (; b < BLAST_POOL; b++) { blasts[b].sprite.visible = false; blasts[b].light.visible = false; blasts[b].light.intensity = 0; }
    for (; s < SMOKE_POOL; s++) hideAll(smokes[s], p => { p.visible = false; });
  }

  /** The kill this shot made, if the shooter killed someone just after it. */
  function killFor(m, client, tShot){
    const kills = m.kills;
    for (let i = 0; i < kills.length; i++) {
      const k = kills[i];
      if (k.killer === client && k.tS >= tShot - 0.02 && k.tS - tShot <= KILL_MATCH_S) return k;
      if (k.tS > tShot + KILL_MATCH_S) break;
    }
    return null;
  }

  return { update, group };
}

const API = { createCombatFx, TRACER_SPEED, SMOKE_HOLD_S };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_COMBATFX = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
