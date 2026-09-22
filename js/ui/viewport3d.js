/*!
 * viewport3d.js - the 3D view.
 *
 * The map is reconstructed from where players walked (core/mapmesh.js) and
 * draped with the map's own compass image, so it reads as the real place at
 * real heights without a single game asset extracted.
 *
 * It owns no time. It reads the same store the 2D view reads, so switching
 * between them keeps the moment and the selected player, and the timeline
 * drives both.
 *
 * Honesty carries over from 2D: a player the server was not sending is
 * ghosted, one with no position in the current life is not drawn, and a
 * predicted grenade impact is a ring rather than a solid marker.
 *
 * three.js r160, pinned and vendored in js/vendor so this works offline. It is
 * the only third party code in the app and it stays inside this file.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const MODEL = root.DM1_MODEL;
const MAPMESH = root.DM1_MAPMESH;

/* Player proportions in world units. A CoD4 player is 72 units standing. */
const PLAYER_H = 72;
const EYE_H = 60;

const FRESH_S = 0.35;
const TRAIL_S = 8;
const KILL_LINE_S = 3.0;
const SMOKE_S = 18;

const COL = {
  allies: 0x7FA3BF,
  opfor: 0xC4473A,
  grease: 0xE3B538,
  bone: 0xE4DFCF,
  slate: 0x2F352C,
  floor: 0x6E7A63
};

function createViewport3D(container, state){
  const THREE = root.THREE;
  if (!THREE) return null;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = false;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.slate);
  /* Fog range is set from the map size once it is known: a fixed range
     swallowed half of a competitive map. */
  scene.fog = new THREE.Fog(COL.slate, 6000, 26000);

  /* Flat, even light. This is a briefing table, not a film set: the shapes
     should read, not perform. */
  scene.add(new THREE.HemisphereLight(0xEFF3E9, 0x424C3B, 2.6));
  const key = new THREE.DirectionalLight(0xFFF6E0, 1.5);
  key.position.set(1200, 2400, 900);
  scene.add(key);

  const cameras = root.DM1_CAMERAS.createCameraRig(THREE, renderer.domElement, state);
  scene.add(cameras.group);

  /* ---- groups ---- */
  const gMap = new THREE.Group();
  const gPlayers = new THREE.Group();
  const gTrails = new THREE.Group();
  const gKills = new THREE.Group();
  const gNades = new THREE.Group();
  const gHeat = new THREE.Group();
  scene.add(gMap, gPlayers, gTrails, gKills, gNades, gHeat);

  let occupancy = null;
  let mapMesh = null;
  let mapTexture = null;
  let players = new Map();
  let disposables = [];
  let ready = false;

  const track = obj => { disposables.push(obj); return obj; };

  function clearGroup(g){
    while (g.children.length) {
      const c = g.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
        else c.material.dispose();
      }
    }
  }

  const V = (x, y, z) => {
    const s = MAPMESH.toScene(x, y, z);
    return new THREE.Vector3(s[0], s[1], s[2]);
  };

  /* ---- the map ---- */

  function buildMap(){
    clearGroup(gMap);
    const m = state.model;
    occupancy = MAPMESH.buildOccupancy(m.tracks);
    if (!occupancy) return;
    const built = MAPMESH.buildMesh(occupancy);
    mapMesh = built;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(built.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(built.normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(built.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(built.indices, 1));
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      color: mapTexture ? 0xFFFFFF : COL.floor,
      map: mapTexture || null,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    gMap.add(mesh);

    /* Edges are what make height read at a glance, but a full wireframe at
       map scale is just noise. EdgesGeometry keeps only the creases, which is
       the silhouette of every step and rooftop. */
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 24),
      new THREE.LineBasicMaterial({ color: 0x1B1F18, transparent: true, opacity: 0.30 })
    );
    gMap.add(edges);

    cameras.setBounds(built.bounds);
    state.mapStats = built.stats;

    /* Fog pushed back far enough that the far side of the map is still
       legible from the tactical camera, which sits outside the bounds. */
    const span = Math.max(built.bounds.maxX - built.bounds.minX,
                          built.bounds.maxY - built.bounds.minY);
    scene.fog.near = span * 1.4;
    scene.fog.far = span * 4.2;
  }

  /** The compass image, draped over the reconstruction. */
  function loadTexture(then){
    const name = root.DM1_VIEWPORT.mapImageName(state.model.info.map);
    if (!name) { mapTexture = null; then(); return; }
    new THREE.TextureLoader().load(
      "maps/" + name + ".png",
      tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        mapTexture = tex;
        then();
      },
      undefined,
      () => { mapTexture = null; then(); }
    );
  }

  /* ---- players ---- */

  function nameSprite(text, colour){
    const cv = document.createElement("canvas");
    const pad = 8, font = "500 34px 'Barlow Condensed', sans-serif";
    const g = cv.getContext("2d");
    g.font = font;
    cv.width = Math.ceil(g.measureText(text).width) + pad * 2;
    cv.height = 48;
    const g2 = cv.getContext("2d");
    g2.font = font;
    g2.fillStyle = "rgba(47,53,44,0.78)";
    g2.fillRect(0, 0, cv.width, cv.height);
    g2.fillStyle = colour;
    g2.textBaseline = "middle";
    g2.fillText(text, pad, cv.height / 2 + 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    /* sizeAttenuation false renders the sprite at a constant size on screen
       whatever the camera distance, which is exactly what a name tag wants.
       Scaling by distance by hand made labels a thousand units wide from the
       tactical camera. */
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
      sizeAttenuation: false
    }));
    spr.scale.set(cv.width / 5200, cv.height / 5200, 1);
    spr.renderOrder = 10;
    return spr;
  }

  function buildPlayers(){
    clearGroup(gPlayers);
    players = new Map();
    const m = state.model;
    for (const id of Object.keys(m.tracks)) {
      const client = Number(id);
      const p = m.playerBy.get(client);
      const team = m.teamOf(client);
      const colour = team === m.teamNames[0] ? COL.allies : COL.opfor;

      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(15, PLAYER_H - 30, 4, 10),
        new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6,
                                         transparent: true, opacity: 1 })
      );
      body.position.y = PLAYER_H / 2;

      /* The view cone: where they are actually looking. */
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(34, 150, 3, 1, true),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true,
                                      opacity: 0.22, side: THREE.DoubleSide,
                                      depthWrite: false })
      );
      cone.rotation.z = Math.PI / 2;
      cone.position.set(0, EYE_H, -75);

      const holder = new THREE.Group();
      holder.add(body, cone);
      const label = nameSprite(p ? p.name.replace(/\^./g, "") : ("client " + client),
                               "#E4DFCF");
      label.position.y = PLAYER_H + 34;
      holder.add(label);

      /* A flat disc that always faces the camera, so a player stays findable
         from any distance even when the capsule is a single pixel. */
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({
        color: colour, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false, sizeAttenuation: false
      }));
      marker.scale.set(0.011, 0.011, 1);
      marker.position.y = PLAYER_H * 0.55;
      marker.renderOrder = 9;
      holder.add(marker);

      /* The ring that marks who the camera is following. */
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(26, 32, 24),
        new THREE.MeshBasicMaterial({ color: COL.grease, transparent: true,
                                      opacity: 0.9, side: THREE.DoubleSide,
                                      depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 2;
      ring.visible = false;
      holder.add(ring);

      holder.visible = false;
      gPlayers.add(holder);
      players.set(client, { holder, body, cone, label, ring, marker, colour,
                            labelW: label.scale.x, labelH: label.scale.y });
    }
  }

  function updatePlayers(t){
    const m = state.model;
    const round = m.roundStates.find(r => t >= r.startS && t <= r.endS) || null;
    for (const [client, node] of players) {
      const dead = round && round.deaths.some(d => d.client === client && d.tS <= t);
      const pos = dead ? null : MODEL.positionAt(m.tracks, client, t, null);
      const stale = pos && round && pos.ageS > t - round.startS;
      if (!pos || stale) { node.holder.visible = false; continue; }

      node.holder.visible = true;
      const v = V(pos.x, pos.y, pos.z);
      node.holder.position.copy(v);
      node.holder.rotation.y = (pos.yaw * Math.PI) / 180;

      /* Ghosted when the server was not sending them: the position is the
         last known one, not where they are. */
      const fresh = pos.ageS <= FRESH_S;
      node.body.material.opacity = fresh ? 1 : 0.28;
      node.cone.material.opacity = fresh ? 0.22 : 0.07;
      node.label.material.opacity = fresh ? 1 : 0.4;
      node.ring.visible = state.followClient === client;
      node.cone.visible = state.view.aimRays;
      node.label.visible = state.view.names;

      /* A player is 72 units against a map 4000 units across, so from the
         tactical camera the capsule vanishes. The label and the marker hold a
         constant size on screen instead, which is what makes the 3D view
         usable as a plan view as well as up close. The label lifts clear of
         the marker by a distance that grows with the camera, so the two never
         overlap. */
      const camDist = cameras.active().position.distanceTo(node.holder.position);
      node.label.position.y = PLAYER_H + 24 + camDist * 0.018;
    }
  }

  /* ---- trails ---- */

  function updateTrails(t){
    clearGroup(gTrails);
    if (!state.view.trails) return;
    const m = state.model;
    const round = m.roundStates.find(r => t >= r.startS && t <= r.endS) || null;
    const from = round ? Math.max(round.startS, t - TRAIL_S) : t - TRAIL_S;
    for (const [client, node] of players) {
      if (!node.holder.visible) continue;
      const tr = m.tracks[String(client)];
      const a = Math.max(0, MODEL.sampleIndexAt(tr, from));
      const b = MODEL.sampleIndexAt(tr, t);
      if (b <= a) continue;
      const pts = [];
      for (let i = a; i <= b; i++) pts.push(V(tr[i][1], tr[i][2], tr[i][3] + 6));
      if (pts.length < 2) continue;
      gTrails.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: node.colour, transparent: true,
                                      opacity: 0.55 })
      ));
    }
  }

  /* ---- kills ---- */

  function updateKills(t){
    clearGroup(gKills);
    if (!state.view.killLines) return;
    const m = state.model;
    for (const k of m.kills) {
      if (k.tS > t || t - k.tS > KILL_LINE_S) continue;
      if (!k.killerPos || !k.victimPos) continue;
      const age = (t - k.tS) / KILL_LINE_S;
      const from = V(k.killerPos.x, k.killerPos.y, k.killerPos.z + EYE_H);
      const to = V(k.victimPos.x, k.victimPos.y,
                   k.victimPos.z + (k.headshot ? EYE_H : PLAYER_H * 0.55));

      /* A tube rather than a line, so the shot has weight and reads at any
         camera distance. */
      const dir = new THREE.Vector3().subVectors(to, from);
      const len = dir.length();
      if (len < 1) continue;
      const geo = new THREE.CylinderGeometry(k.headshot ? 3.2 : 2.2,
                                             k.headshot ? 3.2 : 2.2, len, 6, 1);
      const mat = new THREE.MeshBasicMaterial({
        color: k.headshot ? COL.grease : COL.bone,
        transparent: true, opacity: 0.9 * (1 - age), depthWrite: false
      });
      const tube = new THREE.Mesh(geo, mat);
      tube.position.copy(from).addScaledVector(dir, 0.5);
      tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      gKills.add(tube);

      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(k.headshot ? 10 : 7, 10, 8),
        new THREE.MeshBasicMaterial({ color: k.headshot ? COL.grease : COL.opfor,
                                      transparent: true, opacity: 0.95 * (1 - age),
                                      depthWrite: false })
      );
      hit.position.copy(to);
      gKills.add(hit);
    }
  }

  /* ---- grenades ---- */

  function updateNades(t){
    clearGroup(gNades);
    if (!state.view.grenades) return;
    const m = state.model;
    for (const nade of m.grenades) {
      const t0 = nade.path[0][0] / 100;
      const tImpact = (nade.impactS !== null && nade.impactS !== undefined
                       ? nade.impactS : nade.path[nade.path.length - 1][0]) / 100;
      if (t < t0 - 0.2) continue;
      const smoke = nade.kind === "smoke";
      if (t > (smoke ? tImpact + SMOKE_S : tImpact + 3)) continue;

      const tint = smoke ? 0x9AA79A : nade.kind === "flash" ? COL.bone : COL.grease;
      const pts = [];
      for (const p of nade.path) {
        if (p[0] / 100 > t) break;
        pts.push(V(p[1], p[2], p[3]));
      }
      if (pts.length >= 2) {
        gNades.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: 0.75 })
        ));
      }
      if (t < tImpact) continue;

      const at = V(nade.impact[0], nade.impact[1], nade.impact[2]);
      if (smoke) {
        /* A smoke is a volume for its real duration, so you can see what it
           actually blocked rather than a dot on the floor. */
        const age = (t - tImpact) / SMOKE_S;
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(150, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xAEB8AC, transparent: true,
                                        opacity: 0.20 * (1 - age * 0.5),
                                        depthWrite: false })
        );
        ball.position.copy(at).add(new THREE.Vector3(0, 70, 0));
        gNades.add(ball);
      }
      /* Predicted impacts are rings, transmitted ones are solid. */
      const marker = new THREE.Mesh(
        nade.predicted ? new THREE.TorusGeometry(16, 2.5, 6, 18)
                       : new THREE.SphereGeometry(9, 10, 8),
        new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.9,
                                      depthWrite: false })
      );
      marker.position.copy(at);
      if (nade.predicted) marker.rotation.x = -Math.PI / 2;
      gNades.add(marker);
    }
  }

  /* ---- heatmap draped on the real floors ---- */

  let heatBuilt = false;
  function buildHeat(){
    clearGroup(gHeat);
    heatBuilt = true;
    if (!state.view.heatmap || !occupancy) return;
    const m = state.model;
    const counts = new Map();
    let peak = 1;
    const only = state.heatClient;
    for (const id of Object.keys(m.tracks)) {
      if (only !== null && only !== undefined && Number(id) !== only) continue;
      for (const p of m.tracks[id]) {
        const cx = Math.floor((p[1] - occupancy.minX) / occupancy.cell);
        const cy = Math.floor((p[2] - occupancy.minY) / occupancy.cell);
        const z = MAPMESH.floorAt(occupancy, p[1], p[2], p[3]);
        if (z === null) continue;
        const k = cx + "," + cy + "," + Math.round(z);
        const n = (counts.get(k) || 0) + 1;
        counts.set(k, n);
        if (n > peak) peak = n;
      }
    }
    /* One instanced quad per busy cell, sitting just above its floor. */
    const geo = new THREE.PlaneGeometry(occupancy.cell, occupancy.cell);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55,
                                              depthWrite: false });
    const inst = new THREE.InstancedMesh(geo, mat, counts.size);
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();
    let i = 0;
    for (const [k, n] of counts) {
      const [cx, cy, z] = k.split(",").map(Number);
      const x = occupancy.minX + (cx + 0.5) * occupancy.cell;
      const y = occupancy.minY + (cy + 0.5) * occupancy.cell;
      dummy.position.copy(V(x, y, z + 3));
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      /* Grease yellow ramp: quiet where people pass, bright where they live. */
      const f = Math.min(1, Math.log(1 + n) / Math.log(1 + peak));
      colour.setHSL(0.13, 0.55 * f + 0.1, 0.18 + 0.42 * f);
      inst.setColorAt(i, colour);
      i++;
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    gHeat.add(inst);
  }

  /* ---- the pattern picked in the coach panel ---- */

  const gOverlay = new THREE.Group();
  scene.add(gOverlay);

  function buildOverlay(){
    clearGroup(gOverlay);
    const lineup = state.selectedLineup;
    const routes = state.selectedRoutes;
    if (!state.analysis) return;

    if (lineup) {
      /* Every throw in the cluster at once: a practised smoke reads as a
         bundle of arcs landing on the same spot. */
      const tol = state.analysis.cfg.lineupImpactTol;
      const uses = state.analysis.throws.filter(t =>
        t.kind === lineup.kind && t.thrower !== null &&
        lineup.throwers.some(x => x.client === t.thrower) &&
        Math.hypot(t.impact[0] - lineup.impact[0], t.impact[1] - lineup.impact[1]) <= tol);
      for (const u of uses) {
        const pts = u.path.map(pt => V(pt[1], pt[2], pt[3]));
        if (pts.length < 2) continue;
        gOverlay.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: COL.grease, transparent: true,
                                        opacity: 0.45 })));
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(9, 8, 6),
          new THREE.MeshBasicMaterial({ color: COL.grease, transparent: true,
                                        opacity: 0.8, depthWrite: false }));
        dot.position.copy(V(u.impact[0], u.impact[1], u.impact[2]));
        gOverlay.add(dot);
      }
      /* The landing zone as a ring on the ground. */
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(tol * 0.6, 4, 8, 32),
        new THREE.MeshBasicMaterial({ color: COL.grease, transparent: true,
                                      opacity: 0.55, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(V(lineup.impact[0], lineup.impact[1], lineup.impact[2] + 4));
      gOverlay.add(ring);
      return;
    }

    if (routes) {
      routes.clusters.forEach((c, i) => {
        const pts = c.path.map(pt => {
          const z = occupancy ? MAPMESH.floorAt(occupancy, pt[0], pt[1]) : null;
          return V(pt[0], pt[1], (z === null ? 0 : z) + 30);
        });
        if (pts.length < 2) return;
        gOverlay.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({
            color: i === 0 ? COL.grease : 0x9AA79A,
            transparent: true, opacity: i === 0 ? 0.95 : 0.5 })));
      });
    }
  }

  state.on("overlay", buildOverlay);

  /* ---- loop ---- */

  let running = false, raf = null;

  function resize(){
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    cameras.setAspect(rect.width / rect.height);
  }

  function frame(){
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (!ready) return;
    const t = state.timeS;
    cameras.update(players, t);
    updatePlayers(t);
    updateTrails(t);
    updateKills(t);
    updateNades(t);
    if (!heatBuilt) buildHeat();
    renderer.render(scene, cameras.active());
  }

  function start(){
    if (running) return;
    running = true;
    resize();
    raf = requestAnimationFrame(frame);
  }
  function stop(){
    running = false;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  function rebuild(){
    ready = false;
    loadTexture(() => {
      buildMap();
      buildPlayers();
      heatBuilt = false;
      cameras.reset(state.model);
      buildOverlay();
      ready = true;
    });
  }

  state.on("load", () => { if (state.model) rebuild(); });
  state.on("view", () => { heatBuilt = false; });
  state.on("heat", () => { heatBuilt = false; });
  window.addEventListener("resize", resize);

  return {
    start, stop, resize, rebuild,
    get stats(){ return mapMesh ? mapMesh.stats : null; },
    cameras,
    canvas: renderer.domElement
  };
}

const API = { createViewport3D, PLAYER_H, EYE_H, COL };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_VIEWPORT3D = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
