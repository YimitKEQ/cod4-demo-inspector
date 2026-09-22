/*!
 * viewport3d.js - the 3D view.
 *
 * The map is reconstructed from where players walked (core/mapmesh.js) and
 * draped with the map's own compass image, so it reads as the real place at
 * real heights without a single game asset extracted.
 *
 * Everything drawn per frame is allocated once and updated in place. The
 * first version rebuilt every trail, kill line and grenade arc from scratch
 * on every frame, which meant hundreds of geometries created and disposed a
 * second, and the garbage that produced was the stutter. Nothing in the frame
 * loop allocates now.
 *
 * It owns no time. It reads the same store the 2D view reads, so switching
 * between them keeps the moment and the selected player.
 *
 * Honesty carries over from 2D: a player the server was not sending is
 * ghosted, one with no position in the current life is not drawn, and a
 * predicted grenade impact is a ring rather than a solid marker.
 *
 * three.js r160, pinned and vendored in js/vendor so this works offline.
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

/* Pool sizes. Anything beyond these is not drawn, which is better than
   allocating mid frame. Sized against real demos with headroom. */
const MAX_TRAIL_PTS = 512;
const KILL_SLOTS = 16;
const NADE_SLOTS = 28;
const MAX_NADE_PTS = 96;

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
  if (!THREE) {
    if (root.APP_REPORT) root.APP_REPORT("3D is unavailable",
      "three.js did not load, so the 3D view cannot start. The flat map still works.");
    return null;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: false, powerPreference: "high-performance"
    });
  } catch (e) {
    /* No WebGL at all: a blocked context, a driver refusing, software
       rendering disabled. Whatever the cause, saying so beats a black box. */
    if (root.APP_REPORT) root.APP_REPORT("This browser would not give a 3D canvas",
      (e && e.message ? e.message : String(e)) +
      "  ·  check that hardware acceleration is on, or try another browser.");
    return null;
  }

  /* Losing the context is survivable and must be survived.
     Windows resets a GPU driver that takes too long on one frame, and the
     browser hands back a dead canvas: the view renders once and then goes
     black forever. Calling preventDefault lets the browser give the context
     back, and rebuilding on restore puts the scene into it. */
  let contextLost = false;
  renderer.domElement.addEventListener("webglcontextlost", ev => {
    ev.preventDefault();
    contextLost = true;
    ready = false;
    state.contextLost = true;
    state.emit("geometry");
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    contextLost = false;
    state.contextLost = false;
    if (state.model) rebuild();
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.slate);
  scene.fog = new THREE.Fog(COL.slate, 6000, 26000);

  scene.add(new THREE.HemisphereLight(0xF6F8F0, 0x4E5845, 3.1));
  const key = new THREE.DirectionalLight(0xFFF8E6, 1.9);
  key.position.set(1200, 2400, 900);
  scene.add(key);

  const cameras = root.DM1_CAMERAS.createCameraRig(THREE, renderer.domElement, state);
  scene.add(cameras.group);

  const gMap = new THREE.Group();
  const gPlayers = new THREE.Group();
  const gTrails = new THREE.Group();
  const gKills = new THREE.Group();
  const gNades = new THREE.Group();
  const gHeat = new THREE.Group();
  const gOverlay = new THREE.Group();
  const gProps = new THREE.Group();
  scene.add(gMap, gProps, gPlayers, gTrails, gKills, gNades, gHeat, gOverlay);

  let occupancy = null;
  let mapMesh = null;
  let mapTexture = null;
  let players = new Map();
  let trails = new Map();
  let killSlots = [];
  let nadeSlots = [];
  let ready = false;

  /* What is still downloading. The 3D view pulls tens of megabytes of map,
     textures, props and bodies, and without a word about it an empty looking
     canvas is indistinguishable from a broken one. */
  const loading = { total: 0, done: 0, what: "" };
  function track(what, n){
    loading.total += n;
    loading.what = what;
    state.loading = { ...loading };
    state.emit("loading");
  }
  function tick(){
    loading.done++;
    state.loading = { ...loading };
    state.emit("loading");
  }

  /* Scratch objects, so the frame loop never allocates. */
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  function clearGroup(g){
    const dropMaterial = m => {
      if (!m) return;
      /* A disposed material still holds its textures, and a texture still
         holds GPU memory. Rebuilding without this leaks a whole map's worth
         every time. */
      if (m.map && m.map.dispose) m.map.dispose();
      m.dispose();
    };
    while (g.children.length) {
      const c = g.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (Array.isArray(c.material)) c.material.forEach(dropMaterial);
      else dropMaterial(c.material);
    }
  }

  /* The world to scene axis mapping, inlined.
   *
   * MAPMESH.toScene is the canonical definition and returns an array, which
   * is fine for cold paths and ruinous here: the trails alone call it about
   * five thousand times a frame, and that garbage was the remaining stutter.
   * tests/mapmesh.test.js asserts this inline form and toScene agree, so
   * there is still one definition of the truth. */
  const V = (x, y, z, into) => (into || new THREE.Vector3()).set(x, z, -y);

  /* The round containing a time, cached: the answer changes a few times a
     match and was being searched for on every frame. */
  let roundCache = null;
  function roundAt(t){
    if (roundCache && t >= roundCache.startS && t <= roundCache.endS) return roundCache;
    roundCache = state.model.roundStates.find(r => t >= r.startS && t <= r.endS) || null;
    return roundCache;
  }

/* A plausible colour for a surface whose texture could not be resolved.
   The real image name lives in the material asset inside the fastfiles, which
   is a much larger read; until then a material called me_ground_dirt03 should
   at least be the colour of dirt rather than a uniform grey that makes the
   whole map look unfinished. */
const MATERIAL_TINTS = [
  [/grass|foliage|hedge|bush/, 0x6B7A4C],
  [/dirt|ground|mud|earth|soil/, 0x8A7654],
  [/sand|desert/, 0xBCA985],
  [/asphalt|road|tarmac/, 0x585856],
  [/concrete|cement|sidewalk|curb|kerb/, 0x96958C],
  [/brick|adobe|clay/, 0x8C5A44],
  [/wood|beam|plank|timber|crate/, 0x7A5F3E],
  [/metal|steel|iron|pipe|fence/, 0x6E7278],
  [/rubble|debris|trash|rubbish/, 0x7E7566],
  [/roof|tile|shingle/, 0x7A6857],
  [/glass|window/, 0x8FA2A8],
  [/paper|decal|poster/, 0x9A9384]
];

function materialColour(name){
  const n = String(name || "").toLowerCase();
  for (const [re, colour] of MATERIAL_TINTS) if (re.test(n)) return colour;
  return 0x8A9380;
}

  /* ---- the map ---- */

  /**
   * Real map geometry, when it has been extracted.
   *
   * tools/mapsrc.js turns a Radiant .map source into maps3d/<map>/geometry.bin.
   * When that exists it replaces the reconstruction entirely: it is the actual
   * geometry rather than an inference from footsteps. The occupancy grid is
   * still built alongside it, because the heatmap and the route overlays need
   * floor heights.
   */
  function tryRealGeometry(then){
    const map = state.model.info.map;
    const base = "maps3d/" + map + "/";
    track("map", 1);
    fetch(base + "geometry.json")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("no manifest"))))
      .then(manifest => fetch(base + "geometry.bin")
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("no geometry"))))
        .then(buf => ({ manifest, buf })))
      .then(({ manifest, buf }) => fetch(base + "textures/textures.json")
        .then(r => (r.ok ? r.json() : { textures: {} }))
        .catch(() => ({ textures: {} }))
        .then(tex => ({ manifest, buf, tex, base })))
      .then(({ manifest, buf, tex, base }) => {
        const find = n => manifest.layout.find(l => l.name === n);
        const pos = find("position"), nor = find("normal");
        const uv = find("uv"), idx = find("index");
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(
          new Float32Array(buf, pos.byteOffset, pos.byteLength / 4), 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(
          new Float32Array(buf, nor.byteOffset, nor.byteLength / 4), 3));
        geo.setAttribute("uv", new THREE.BufferAttribute(
          new Float32Array(buf, uv.byteOffset, uv.byteLength / 4), 2));
        geo.setIndex(new THREE.BufferAttribute(
          new Uint32Array(buf, idx.byteOffset, idx.byteLength / 4), 1));
        geo.computeBoundingSphere();
        tick();
        then({ geo, manifest, tex, base });
      })
      .catch(() => { tick(); then(null); });
  }

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
    if (built.colors) geo.setAttribute("color", new THREE.BufferAttribute(built.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(built.indices, 1));
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      color: mapTexture ? 0xFFFFFF : COL.floor,
      map: mapTexture || null,
      vertexColors: !!built.colors,
      roughness: 0.82,
      metalness: 0.0,
      side: THREE.DoubleSide
    });
    gMap.add(new THREE.Mesh(geo, mat));

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 24),
      new THREE.LineBasicMaterial({ color: 0x1B1F18, transparent: true, opacity: 0.30 })
    );
    gMap.add(edges);

    cameras.setBounds(built.bounds);
    state.mapStats = built.stats;

    const span = Math.max(built.bounds.maxX - built.bounds.minX,
                          built.bounds.maxY - built.bounds.minY);
    scene.fog.near = span * 1.4;
    scene.fog.far = span * 4.2;
  }

  /**
   * The compass image, applied to the existing material when it arrives.
   * Building the map only after the image loaded made the whole 3D setup
   * asynchronous, which let a camera chosen from a link be silently undone.
   */
  function loadTexture(){
    const name = root.DM1_VIEWPORT.mapImageName(state.model.info.map);
    state.backdrop = name ? "loading" : "derived";
    if (!name) return;
    new THREE.TextureLoader().load(
      "maps/" + name + ".png",
      tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy
          ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
        mapTexture = tex;
        /* Only the reconstruction wears the overhead image. Real geometry has
           the game's own textures on each material and must not be painted
           over with a photograph of itself from above. */
        if (state.geometrySource !== "extracted") {
          const mesh = gMap.children.find(c => c.isMesh);
          if (mesh && !Array.isArray(mesh.material)) {
            mesh.material.map = tex;
            mesh.material.color.setHex(0xFFFFFF);
            mesh.material.needsUpdate = true;
          }
        }
        state.backdrop = "image";
      },
      undefined,
      () => { mapTexture = null; state.backdrop = "derived"; }
    );
  }

  /* ---- players ---- */

  function nameSprite(text){
    const cv = document.createElement("canvas");
    const pad = 8, font = "500 34px 'Barlow Condensed', sans-serif";
    let g = cv.getContext("2d");
    g.font = font;
    cv.width = Math.ceil(g.measureText(text).width) + pad * 2;
    cv.height = 48;
    g = cv.getContext("2d");
    g.font = font;
    g.fillStyle = "rgba(47,53,44,0.78)";
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = "#E4DFCF";
    g.textBaseline = "middle";
    g.fillText(text, pad, cv.height / 2 + 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
      sizeAttenuation: false
    }));
    spr.scale.set(cv.width / 5200, cv.height / 5200, 1);
    spr.renderOrder = 10;
    return spr;
  }

  /* Shared geometry for every soldier: ten players is sixty meshes, and they
     all point at the same handful of buffers. */
  let SOLDIER = null;
  function soldierGeometry(){
    if (SOLDIER) return SOLDIER;
    SOLDIER = {
      leg: new THREE.BoxGeometry(8, 34, 9),
      torso: new THREE.BoxGeometry(21, 25, 13),
      arm: new THREE.BoxGeometry(6, 23, 7),
      head: new THREE.SphereGeometry(7, 12, 10),
      helmet: new THREE.SphereGeometry(7.6, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
      gun: new THREE.BoxGeometry(3.4, 3.4, 30)
    };
    return SOLDIER;
  }

  /**
   * A readable soldier rather than a capsule.
   *
   * Roughly the proportions of a CoD4 player: 72 units tall, eyes at 60. It is
   * not the game's model, which lives inside the fastfiles, but it reads as a
   * person facing a direction with a weapon up, which is what the view needs
   * in order to be about a match rather than about dots.
   */
  function buildSoldier(colour){
    const G = soldierGeometry();
    const parts = [];
    const group = new THREE.Group();

    const kit = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.62 });
    const dark = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colour).multiplyScalar(0.55), roughness: 0.78 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xC8A683, roughness: 0.8 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2B2E29, roughness: 0.5 });

    const put = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      group.add(m);
      parts.push(m);
      return m;
    };

    put(G.leg, dark, -5, 17, 0);
    put(G.leg, dark, 5, 17, 0);
    put(G.torso, kit, 0, 47, 0);
    put(G.arm, dark, -13, 47, -2);
    put(G.arm, dark, 13, 47, -2);
    put(G.head, skin, 0, 65, 0);
    put(G.helmet, kit, 0, 65, 0);
    /* Weapon held across the chest, pointing where the player looks. */
    put(G.gun, steel, 7, 52, -14);

    return { group, parts };
  }

  /**
   * The game's own multiplayer bodies, when they have been extracted.
   *
   * tools/players.js writes one per side into maps3d/_players. They are
   * skinned with no animation baked in, which means the vertex data is the
   * rest pose and can be read straight: joint matrices times inverse bind
   * matrices are identity when nothing has moved the skeleton.
   *
   * Loading is asynchronous, so every player starts as the built in figure and
   * is upgraded in place when the real model arrives. Nothing is ever waiting
   * on a download to show something.
   */
  let playerModels = null;
  function loadPlayerModels(){
    if (playerModels) { applyPlayerModels(); return; }
    fetch("maps3d/_players/players.json")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("none"))))
      .then(spec => {
        const jobs = [];
        playerModels = {};
        for (const side of ["allies", "opfor"]) {
          const entry = spec.sides && spec.sides[side];
          if (!entry) continue;
          track("bodies", 1);
          jobs.push(root.DM1_GLB.load(THREE, "maps3d/_players/" + entry.body)
            .then(built => { playerModels[side] = built; tick(); })
            .catch(() => { tick(); }));
        }
        return Promise.all(jobs);
      })
      .then(() => applyPlayerModels())
      .catch(() => { playerModels = null; });
  }

  /** Swap each player's placeholder figure for the real body. */
  function applyPlayerModels(){
    if (!playerModels) return;
    const m = state.model;
    for (const [client, node] of players) {
      const side = m.teamOf(client) === m.teamNames[0] ? "allies" : "opfor";
      const built = playerModels[side];
      if (!built || node.real) continue;

      /* Shared geometry, per player materials so ghosting can fade one player
         without fading the whole team. */
      const mats = built.materials.map(src => {
        const c = src.clone();
        c.transparent = true;
        return c;
      });
      const mesh = new THREE.Mesh(built.geometry, mats);

      node.holder.remove(node.body);
      node.holder.add(mesh);
      node.body = mesh;
      node.parts = [mesh];
      node.real = true;

      /* A team stripe so sides stay readable at a glance, because two brown
         soldiers at two hundred units apart are not obviously enemies. */
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(13, 13, 5, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: node.colour, transparent: true,
                                      opacity: 0.85, side: THREE.DoubleSide })
      );
      band.position.y = 50;
      node.holder.add(band);
      node.parts.push(band);
    }
    state.playerModels = true;
    state.emit("geometry");
  }

  function buildPlayers(){
    clearGroup(gPlayers);
    clearGroup(gTrails);
    players = new Map();
    trails = new Map();
    const m = state.model;

    for (const id of Object.keys(m.tracks)) {
      const client = Number(id);
      const p = m.playerBy.get(client);
      const team = m.teamOf(client);
      const colour = team === m.teamNames[0] ? COL.allies : COL.opfor;

      const figure = buildSoldier(colour);
      const body = figure.group;

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
      /* The whole figure faces the way the cone does. */
      figure.parts.forEach(m => { m.material.transparent = true; });

      const label = nameSprite(p ? p.name.replace(/\^./g, "") : ("client " + client));
      label.position.y = PLAYER_H + 34;
      holder.add(label);

      const marker = new THREE.Sprite(new THREE.SpriteMaterial({
        color: colour, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false, sizeAttenuation: false
      }));
      marker.scale.set(0.011, 0.011, 1);
      marker.position.y = PLAYER_H * 0.55;
      marker.renderOrder = 9;
      holder.add(marker);

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
                            parts: figure.parts, real: false });

      /* One trail line per player, buffer allocated once. */
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(MAX_TRAIL_PTS * 3);
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: colour, transparent: true, opacity: 0.55 }));
      line.frustumCulled = false;
      line.visible = false;
      gTrails.add(line);
      trails.set(client, { line, pos, geo });
    }
  }

  function updatePlayers(t, round){
    const m = state.model;
    const camPos = cameras.active().position;
    for (const [client, node] of players) {
      const dead = round && round.deaths.some(d => d.client === client && d.tS <= t);
      const pos = dead ? null : MODEL.positionAt(m.tracks, client, t, null);
      const stale = pos && round && pos.ageS > t - round.startS;
      if (!pos || stale) { node.holder.visible = false; continue; }

      node.holder.visible = true;
      V(pos.x, pos.y, pos.z, node.holder.position);
      /* CoD yaw 0 looks along world +X. A three.js object with rotation.y = 0
         looks along its own -Z, which the world to scene mapping puts at world
         +Y. That is a quarter turn apart, and without this correction every
         player and every view cone pointed ninety degrees away from where they
         were actually looking. Verified against the kill feed: at the moment
         of a kill the killer's aim now sits a median two degrees off the
         victim. */
      node.holder.rotation.y = ((pos.yaw - 90) * Math.PI) / 180;

      const fresh = pos.ageS <= FRESH_S;
      const bodyAlpha = fresh ? 1 : 0.28;
      for (const part of node.parts) part.material.opacity = bodyAlpha;
      node.cone.material.opacity = fresh ? 0.22 : 0.07;
      node.label.material.opacity = fresh ? 1 : 0.4;
      node.ring.visible = state.followClient === client;
      node.cone.visible = state.view.aimRays;
      node.label.visible = state.view.names;
      node.label.position.y = PLAYER_H + 24 + camPos.distanceTo(node.holder.position) * 0.018;
    }
  }

  function updateTrails(t, round){
    const show = state.view.trails;
    const m = state.model;
    const from = round ? Math.max(round.startS, t - TRAIL_S) : t - TRAIL_S;

    for (const [client, tn] of trails) {
      const pnode = players.get(client);
      if (!show || !pnode || !pnode.holder.visible) { tn.line.visible = false; continue; }
      const tr = m.tracks[String(client)];
      const a = Math.max(0, MODEL.sampleIndexAt(tr, from));
      const b = MODEL.sampleIndexAt(tr, t);
      if (b <= a) { tn.line.visible = false; continue; }

      /* Subsample rather than grow the buffer: a trail is a shape, not a
         record, and 512 points draw the same curve as 4000. */
      const total = b - a + 1;
      const stride = Math.max(1, Math.ceil(total / MAX_TRAIL_PTS));
      let n = 0;
      for (let i = a; i <= b && n < MAX_TRAIL_PTS; i += stride) {
        const p = tr[i];
        tn.pos[n * 3] = p[1];
        tn.pos[n * 3 + 1] = p[3] + 6;
        tn.pos[n * 3 + 2] = -p[2];
        n++;
      }
      tn.geo.setDrawRange(0, n);
      tn.geo.attributes.position.needsUpdate = true;
      tn.line.visible = n >= 2;
    }
  }

  /* ---- kills, from a pool ---- */

  function buildKillPool(){
    clearGroup(gKills);
    killSlots = [];
    /* One geometry shared by every slot; only the transform differs. */
    const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    const hitGeo = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < KILL_SLOTS; i++) {
      const tube = new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false }));
      const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false }));
      tube.frustumCulled = false; hit.frustumCulled = false;
      tube.visible = false; hit.visible = false;
      gKills.add(tube, hit);
      killSlots.push({ tube, hit });
    }
  }

  function updateKills(t){
    let slot = 0;
    if (state.view.killLines) {
      const m = state.model;
      for (const k of m.kills) {
        if (slot >= KILL_SLOTS) break;
        if (k.tS > t || t - k.tS > KILL_LINE_S) continue;
        if (!k.killerPos || !k.victimPos) continue;

        const age = (t - k.tS) / KILL_LINE_S;
        V(k.killerPos.x, k.killerPos.y, k.killerPos.z + EYE_H, _a);
        V(k.victimPos.x, k.victimPos.y,
          k.victimPos.z + (k.headshot ? EYE_H : PLAYER_H * 0.55), _b);
        _d.subVectors(_b, _a);
        const len = _d.length();
        if (len < 1) continue;

        const s = killSlots[slot++];
        const r = k.headshot ? 3.2 : 2.2;
        s.tube.scale.set(r, len, r);
        s.tube.position.copy(_a).addScaledVector(_d, 0.5);
        s.tube.quaternion.setFromUnitVectors(_up, _d.normalize());
        s.tube.material.color.setHex(k.headshot ? COL.grease : COL.bone);
        s.tube.material.opacity = 0.9 * (1 - age);
        s.tube.visible = true;

        s.hit.position.copy(_b);
        s.hit.scale.setScalar(k.headshot ? 10 : 7);
        s.hit.material.color.setHex(k.headshot ? COL.grease : COL.opfor);
        s.hit.material.opacity = 0.95 * (1 - age);
        s.hit.visible = true;
      }
    }
    for (let i = slot; i < KILL_SLOTS; i++) {
      killSlots[i].tube.visible = false;
      killSlots[i].hit.visible = false;
    }
  }

  /* ---- grenades, from a pool ---- */

  function buildNadePool(){
    clearGroup(gNades);
    nadeSlots = [];
    const ringGeo = new THREE.TorusGeometry(16, 2.5, 6, 18);
    const dotGeo = new THREE.SphereGeometry(9, 10, 8);
    const cloudGeo = new THREE.SphereGeometry(150, 16, 12);
    for (let i = 0; i < NADE_SLOTS; i++) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(MAX_NADE_PTS * 3);
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        transparent: true, opacity: 0.75 }));
      line.frustumCulled = false; line.visible = false;

      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false }));
      const cloud = new THREE.Mesh(cloudGeo, new THREE.MeshBasicMaterial({
        color: 0xAEB8AC, transparent: true, depthWrite: false }));
      ring.frustumCulled = false; dot.frustumCulled = false; cloud.frustumCulled = false;
      ring.visible = false; dot.visible = false; cloud.visible = false;

      gNades.add(line, ring, dot, cloud);
      nadeSlots.push({ line, pos, geo, ring, dot, cloud });
    }
  }

  function updateNades(t){
    let slot = 0;
    if (state.view.grenades) {
      const m = state.model;
      for (const nade of m.grenades) {
        if (slot >= NADE_SLOTS) break;
        const t0 = nade.path[0][0] / 100;
        const tImpact = (nade.impactS !== null && nade.impactS !== undefined
                         ? nade.impactS : nade.path[nade.path.length - 1][0]) / 100;
        if (t < t0 - 0.2) continue;
        const smoke = nade.kind === "smoke";
        if (t > (smoke ? tImpact + SMOKE_S : tImpact + 3)) continue;

        const s = nadeSlots[slot++];
        const tint = smoke ? 0x9AA79A : nade.kind === "flash" ? COL.bone : COL.grease;

        let n = 0;
        for (const p of nade.path) {
          if (p[0] / 100 > t || n >= MAX_NADE_PTS) break;
          s.pos[n * 3] = p[1];
          s.pos[n * 3 + 1] = p[3];
          s.pos[n * 3 + 2] = -p[2];
          n++;
        }
        s.geo.setDrawRange(0, n);
        s.geo.attributes.position.needsUpdate = true;
        s.line.material.color.setHex(tint);
        s.line.visible = n >= 2;

        const landed = t >= tImpact;
        V(nade.impact[0], nade.impact[1], nade.impact[2], _a);

        s.ring.visible = landed && nade.predicted;
        s.dot.visible = landed && !nade.predicted;
        if (landed) {
          const marker = nade.predicted ? s.ring : s.dot;
          marker.position.copy(_a);
          marker.material.color.setHex(tint);
          marker.material.opacity = 0.9;
        }

        if (landed && smoke) {
          const age = (t - tImpact) / SMOKE_S;
          s.cloud.position.copy(_a);
          s.cloud.position.y += 70;
          s.cloud.material.opacity = 0.20 * (1 - age * 0.5);
          s.cloud.visible = true;
        } else {
          s.cloud.visible = false;
        }
      }
    }
    for (let i = slot; i < NADE_SLOTS; i++) {
      const s = nadeSlots[i];
      s.line.visible = false; s.ring.visible = false;
      s.dot.visible = false; s.cloud.visible = false;
    }
  }

  /* ---- heatmap, built once per change ---- */

  let heatBuilt = false;
  function buildHeat(){
    clearGroup(gHeat);
    heatBuilt = true;
    if (!state.view.heatmap || !occupancy) return;
    const m = state.model;
    const counts = new Map();
    const only = state.heatClient;
    for (const id of Object.keys(m.tracks)) {
      if (only !== null && only !== undefined && Number(id) !== only) continue;
      for (const p of m.tracks[id]) {
        const cx = Math.floor((p[1] - occupancy.minX) / occupancy.cell);
        const cy = Math.floor((p[2] - occupancy.minY) / occupancy.cell);
        const z = MAPMESH.floorAt(occupancy, p[1], p[2], p[3]);
        if (z === null) continue;
        const k = cx + "," + cy + "," + Math.round(z);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    if (!counts.size) return;
    const sorted = [...counts.values()].sort((a, b) => a - b);
    const ref = sorted[Math.floor(sorted.length * 0.98)] || sorted[sorted.length - 1];
    const FLOOR = 0.34;

    const keep = [...counts.entries()].filter(
      ([, n]) => Math.min(1, Math.log(1 + n) / Math.log(1 + ref)) > FLOOR);
    if (!keep.length) return;

    const geo = new THREE.PlaneGeometry(occupancy.cell, occupancy.cell);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6,
                                              depthWrite: false });
    const inst = new THREE.InstancedMesh(geo, mat, keep.length);
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();
    keep.forEach(([k, n], i) => {
      const [cx, cy, z] = k.split(",").map(Number);
      const x = occupancy.minX + (cx + 0.5) * occupancy.cell;
      const y = occupancy.minY + (cy + 0.5) * occupancy.cell;
      V(x, y, z + 3, dummy.position);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const raw = Math.min(1, Math.log(1 + n) / Math.log(1 + ref));
      const f = (raw - FLOOR) / (1 - FLOOR);
      colour.setHSL(0.13, 0.55 * f + 0.1, 0.18 + 0.44 * f);
      inst.setColorAt(i, colour);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    gHeat.add(inst);
  }

  /* ---- the pattern picked in the coach panel ---- */

  function buildOverlay(){
    clearGroup(gOverlay);
    const lineup = state.selectedLineup;
    const routes = state.selectedRoutes;
    if (!state.analysis) return;

    if (lineup) {
      const tol = state.analysis.cfg.lineupImpactTol;
      const uses = state.analysis.throws.filter(th =>
        th.kind === lineup.kind && th.thrower !== null &&
        lineup.throwers.some(x => x.client === th.thrower) &&
        Math.hypot(th.impact[0] - lineup.impact[0],
                   th.impact[1] - lineup.impact[1]) <= tol);
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
        V(u.impact[0], u.impact[1], u.impact[2], dot.position);
        gOverlay.add(dot);
      }
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(tol * 0.6, 4, 8, 32),
        new THREE.MeshBasicMaterial({ color: COL.grease, transparent: true,
                                      opacity: 0.55, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      V(lineup.impact[0], lineup.impact[1], lineup.impact[2] + 4, ring.position);
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

  /* ---- props ---- */

  /**
   * The map's clutter: foliage, rubble, barriers, vehicles.
   *
   * A stock map places a couple of thousand of these from a couple of dozen
   * models, so each model is drawn once as an instanced mesh however many
   * times it appears. mp_crash is 2,454 placements in 34 draw calls.
   *
   * Placement maths. The models come out of the dump already converted from
   * CoD's Z up to glTF's Y up, which is a quarter turn about X; call that M.
   * A prop's rotation is given in CoD's own frame, so the rotation to apply in
   * the scene is M R M inverse, and its position is simply M applied to the
   * origin. Getting this wrong lays every tree on its side.
   */
  function loadProps(){
    clearGroup(gProps);
    if (!state.view.props) {
      state.propCount = 0;
      state.loading = null;
      state.emit("loading");
      state.emit("geometry");
      return;
    }
    const map = state.model.info.map;
    const base = "maps3d/" + map + "/";

    fetch(base + "props.json")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("none"))))
      .then(spec => {
        const inst = spec.instances;
        const perModel = new Map();
        for (let i = 0; i < inst.model.length; i++) {
          const m = inst.model[i];
          if (!perModel.has(m)) perModel.set(m, []);
          perModel.get(m).push(i);
        }

        const qM = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        const qMi = qM.clone().invert();
        const ax = new THREE.Vector3(1, 0, 0);
        const ay = new THREE.Vector3(0, 1, 0);
        const az = new THREE.Vector3(0, 0, 1);
        const D = Math.PI / 180;

        track("props", spec.models.length);

        /* One model at a time.
           Firing thirty four parallel downloads and uploading every mesh and
           texture to the GPU in the same handful of frames is what made a
           frame take long enough for the driver to give up on it. Sequential
           loading spreads the work over many frames and keeps every one of
           them short. */
        const queue = spec.models.map((model, mi) => ({ model, mi }));
        let placed = 0;

        const next = () => {
          const job = queue.shift();
          if (!job) return;
          const rows = perModel.get(job.mi);
          if (!rows || !rows.length) { tick(); return next(); }

          root.DM1_GLB.load(THREE, base + "props/" + job.model.file).then(built => {
            const mesh = new THREE.InstancedMesh(
              built.geometry, built.materials, rows.length);
            const mat = new THREE.Matrix4();
            const pos = new THREE.Vector3();
            const scl = new THREE.Vector3();
            rows.forEach((i, n) => {
              /* CoD angles are pitch, yaw, roll about Y, Z and X. */
              const q = new THREE.Quaternion()
                .setFromAxisAngle(az, inst.yaw[i] * D)
                .multiply(new THREE.Quaternion().setFromAxisAngle(ay, inst.pitch[i] * D))
                .multiply(new THREE.Quaternion().setFromAxisAngle(ax, inst.roll[i] * D));
              const qScene = qM.clone().multiply(q).multiply(qMi);
              V(inst.x[i], inst.y[i], inst.z[i], pos);
              const k = inst.scale[i] || 1;
              scl.set(k, k, k);
              mat.compose(pos, qScene, scl);
              mesh.setMatrixAt(n, mat);
            });
            mesh.instanceMatrix.needsUpdate = true;
            /* An instanced mesh needs a bounding volume that covers every
               instance before the renderer can cull it; without one the only
               safe thing it can do is draw all of them, every frame. */
            mesh.computeBoundingSphere();
            gProps.add(mesh);
            placed += rows.length;
            state.propCount = placed;
            tick();
            state.emit("geometry");
            /* Yield a frame before the next one so the view stays alive
               while the map fills in. */
            requestAnimationFrame(next);
          }).catch(() => { tick(); requestAnimationFrame(next); });
        };
        next();
      })
      .catch(() => { state.propCount = 0; });
  }

  /* ---- x-ray ---- */

  let xrayOn = null;
  function applyXray(){
    const want = state.view.xray || cameras.mode === "replay";
    if (want === xrayOn) return;
    xrayOn = want;
    const mesh = gMap.children.find(c => c.isMesh);
    if (mesh) {
      mesh.material.transparent = want;
      mesh.material.opacity = want ? 0.42 : 1;
      mesh.material.depthWrite = !want;
      mesh.material.needsUpdate = true;
    }
    const edges = gMap.children.find(c => c.isLineSegments);
    if (edges) edges.material.opacity = want ? 0.5 : 0.3;
  }

  /* ---- loop ---- */

  let running = false, raf = null;
  let frames = 0, fpsSince = 0;

  function resize(){
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    cameras.setAspect(rect.width / rect.height);
  }

  function frame(now){
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (contextLost || !ready) return;

    applyXray();
    const t = state.timeS;
    const round = roundAt(t);
    cameras.update(players, t);
    updatePlayers(t, round);
    updateTrails(t, round);
    updateKills(t);
    updateNades(t);
    if (!heatBuilt) buildHeat();

    /* A camera with a NaN anywhere in it renders a perfectly clean nothing:
       three.js builds the matrices, every vertex lands outside the frustum,
       and the frame comes out as flat background. There is no error and
       nothing in the console. Rather than show that, put the camera back
       where it started and carry on. */
    const cam = cameras.active();
    if (!Number.isFinite(cam.position.x + cam.position.y + cam.position.z)) {
      cameras.reset(state.model);
      cameras.setAspect(cam.aspect || 1);
    }

    renderer.render(scene, cameras.active());
    /* What actually reached the screen, so a blank view can be told apart
       from a slow one. */
    state.drawnTriangles = renderer.info.render.triangles;

    /* A frame rate readout, because "janky" should be a number. */
    frames++;
    if (!fpsSince) fpsSince = now;
    else if (now - fpsSince >= 500) {
      state.fps = Math.round((frames * 1000) / (now - fpsSince));
      frames = 0; fpsSince = now;
      state.emit("fps");
    }
  }

  function start(){
    if (running) return;
    running = true;
    frames = 0; fpsSince = 0;
    resize();
    raf = requestAnimationFrame(frame);
  }
  function stop(){
    running = false;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  /** Swap the reconstruction for real geometry once it has loaded. */
  function applyRealGeometry(real){
    if (!real) { state.geometrySource = "reconstructed"; state.emit("geometry"); return; }
    clearGroup(gMap);

    const geo = real.geo;
    const ranges = real.manifest.ranges || [];
    const textures = (real.tex && real.tex.textures) || {};
    const loader = new THREE.TextureLoader();
    const mats = [];

    geo.clearGroups();
    ranges.forEach((r, i) => {
      if (!r.count) return;
      geo.addGroup(r.start, r.count, mats.length);

      const info = textures[r.material];
      const mat = new THREE.MeshStandardMaterial({
        color: info ? 0xFFFFFF : materialColour(r.material),
        roughness: 0.92, metalness: 0, side: THREE.DoubleSide
      });

      if (info) {
        /* The mesh carries texture coordinates in texels, because the image
           size was not known when it was built. Dividing by the real size
           here is what turns them into the coordinates the game used. */
        track("textures", 1);
        loader.load(real.base + "textures/" + info.file, tex => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(1 / info.width, -1 / info.height);
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy
            ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
          mat.map = tex;
          mat.needsUpdate = true;
          tick();
        }, undefined, () => { tick(); });
      }
      mats.push(mat);
    });

    gMap.add(new THREE.Mesh(geo, mats.length ? mats : new THREE.MeshStandardMaterial({
      color: 0x8A9380, roughness: 0.92, side: THREE.DoubleSide })));

    /* A ground plane under everything. The extracted shell has gaps where a
       surface was caulk or a brush was never drawn, and without this you see
       straight through them into the void, which reads as broken rather than
       as missing. */
    const b = real.manifest.bounds;
    const pad = 1500;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry((b.maxX - b.minX) + pad * 2, (b.maxY - b.minY) + pad * 2),
      new THREE.MeshStandardMaterial({ color: 0x5E6656, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    V((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.minZ - 12, ground.position);
    gMap.add(ground);

    xrayOn = null;
    state.texturedGroups = ranges.filter(r => textures[r.material]).length;
    state.totalGroups = ranges.length;

    /* Frame the real geometry, not the reconstruction it replaced. The
       extracted map extends past the playable area (terrain, skybox shells),
       so the camera is given the intersection of the two: the part of the
       real map that players actually occupied.

       That intersection has to be checked. Two boxes that do not overlap
       intersect to an inside out box, where min is greater than max, and
       everything downstream then quietly goes wrong in the worst possible
       way: the span comes out negative, the fog gets a negative near and far,
       and a negative fog range makes every fragment fully fogged. The result
       is a view that draws one correct frame from the reconstruction and then
       turns into a flat rectangle of fog colour the moment the real geometry
       arrives. It reads exactly like a crash and is nothing of the kind.

       When the two do not overlap, the real map is the honest answer: it is
       the thing actually on screen. */
    const rb = real.manifest.bounds;
    const pb = mapMesh ? mapMesh.bounds : null;
    const overlap = pb ? {
      minX: Math.max(rb.minX, pb.minX - 400), maxX: Math.min(rb.maxX, pb.maxX + 400),
      minY: Math.max(rb.minY, pb.minY - 400), maxY: Math.min(rb.maxY, pb.maxY + 400),
      minZ: rb.minZ, maxZ: rb.maxZ
    } : null;
    const usable = o => o && Number.isFinite(o.minX) && Number.isFinite(o.maxX) &&
      Number.isFinite(o.minY) && Number.isFinite(o.maxY) &&
      o.maxX - o.minX > 1 && o.maxY - o.minY > 1;
    const framed = usable(overlap) ? overlap : rb;
    cameras.setBounds(framed);

    /* Fog has to stay positive and has to start beyond the map, or the map is
       inside its own haze. */
    const span = Math.max(1, framed.maxX - framed.minX, framed.maxY - framed.minY);
    scene.fog.near = span * 1.5;
    scene.fog.far = span * 4.5;

    state.geometrySource = "extracted";
    state.geometryStats = real.manifest.stats;
    state.emit("geometry");
  }

  function rebuild(){
    ready = false;
    buildMap();
    tryRealGeometry(applyRealGeometry);
    buildPlayers();
    buildKillPool();
    buildNadePool();
    heatBuilt = false;
    xrayOn = null;
    roundCache = null;
    cameras.reset(state.model);
    buildOverlay();
    loadProps();
    loadPlayerModels();
    ready = true;
    loadTexture();
  }

  state.on("load", () => { if (state.model) rebuild(); });
  state.on("view", () => { heatBuilt = false; });
  state.on("props", loadProps);
  state.on("quality", loadProps);
  state.on("heat", () => { heatBuilt = false; });
  state.on("overlay", buildOverlay);
  window.addEventListener("resize", resize);

  return {
    start, stop, resize, rebuild,
    get stats(){ return mapMesh ? mapMesh.stats : null; },
    get running(){ return running; },
    cameras, scene, renderer,
    canvas: renderer.domElement
  };
}

const API = { createViewport3D, PLAYER_H, EYE_H, COL };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_VIEWPORT3D = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
