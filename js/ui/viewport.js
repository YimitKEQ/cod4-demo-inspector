/*!
 * viewport.js - the map viewport, 2D.
 *
 * The largest thing on screen and the only loud one. Annotations are drawn
 * like grease pencil on acetate: thick strokes, round caps, slightly
 * translucent, crisp at any zoom.
 *
 * Honesty rules that the drawing follows:
 *  - a player the server was not sending is hollow, never a solid dot in the
 *    wrong place
 *  - a player with no position at all in the current life is not drawn
 *  - a grenade impact that was extrapolated rather than transmitted is drawn
 *    as a ring, not a cross
 *
 * The 3D view lands beside this one in Phase 2 and shares the same state, so
 * everything here reads from the store and owns no time of its own.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const MODEL = root.DM1_MODEL;

/* How stale a sample may be before the player is drawn hollow. One snapshot
   at 20 Hz is 50 ms, so a third of a second means the server has genuinely
   stopped sending them. */
const FRESH_S = 0.35;

/* Trail length in seconds. */
const TRAIL_S = 6;

/* A kill line stays on screen this long after the kill. */
const KILL_LINE_S = 2.5;

/* Smoke burns for this long once it lands. */
const SMOKE_S = 18;
const FLASH_RADIUS = 600;

const MAP_IMAGE_DIR = "maps/";
const CELL = 48;

/** mp_backlot_x -> backlot: promod variants carry a suffix, the map is the same. */
function mapImageName(map){
  return String(map || "").replace(/^mp_/, "").replace(/_(x|hq|sd|promod)$/, "");
}

/**
 * Occupancy grid from the tracks themselves.
 *
 * The geometry is not in the demo, but what is walkable is given away by where
 * players went. Over a full match ten players cover the accessible area almost
 * completely. This is the fallback when no map image exists, and it is also
 * the honest one: it only ever claims floor where somebody actually stood.
 */
function buildFloor(tracks, minX, minY, maxX, maxY){
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const rows = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const visits = new Uint32Array(cols * rows);
  for (const id of Object.keys(tracks)) {
    for (const p of tracks[id]) {
      const cx = Math.floor((p[1] - minX) / CELL), cy = Math.floor((p[2] - minY) / CELL);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      visits[cy * cols + cx]++;
    }
  }
  /* One pass of dilation so single footsteps join into corridors. */
  const grown = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (!visits[y * cols + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) grown[ny * cols + nx] = 1;
    }
  }
  return { cols, rows, grown };
}

function createViewport(container, state){
  const cv = document.createElement("canvas");
  container.append(cv);
  const g = cv.getContext("2d");

  let W = 0, H = 0, dpr = 1;
  let minX = 0, minY = 0, scale = 1, offX = 0, offY = 0;
  let floor = null, floorImage = null;
  let mapImage = null, mapImageTried = "";
  let ready = false;

  const px = x => (x - minX) * scale + offX;
  const py = y => H - ((y - minY) * scale + offY);

  function theme(name){
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ---- layout and projection ---- */

  function layout(){
    const m = state.model;
    const rect = container.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(rect.width * dpr));
    H = Math.max(1, Math.round(rect.height * dpr));
    cv.width = W; cv.height = H;
    cv.style.width = rect.width + "px";
    cv.style.height = rect.height + "px";
    if (!m) return;

    let bx0, by0, bx1, by1;
    const src = m.bounds;
    if (src && src.length === 4) {
      bx0 = src[0]; by0 = src[1]; bx1 = src[2]; by1 = src[3];
    } else {
      /* No compass rectangle: fall back to the extent of the tracks. */
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const id of Object.keys(m.tracks)) for (const p of m.tracks[id]) {
        lo[0] = Math.min(lo[0], p[1]); hi[0] = Math.max(hi[0], p[1]);
        lo[1] = Math.min(lo[1], p[2]); hi[1] = Math.max(hi[1], p[2]);
      }
      if (!isFinite(lo[0])) { lo = [0, 0]; hi = [1, 1]; }
      const pad = 200;
      bx0 = lo[0] - pad; by0 = lo[1] - pad; bx1 = hi[0] + pad; by1 = hi[1] + pad;
    }
    minX = Math.min(bx0, bx1); minY = Math.min(by0, by1);
    const maxX = Math.max(bx0, bx1), maxY = Math.max(by0, by1);
    const worldW = maxX - minX || 1, worldH = maxY - minY || 1;
    const pad = 16 * dpr;
    scale = Math.min((W - pad * 2) / worldW, (H - pad * 2) / worldH);
    offX = (W - worldW * scale) / 2;
    offY = (H - worldH * scale) / 2;

    floor = buildFloor(m.tracks, minX, minY, maxX, maxY);
    floorImage = null;
    ready = true;
  }

  /* ---- backdrop ---- */

  function loadMapImage(){
    const name = mapImageName(state.model.info.map);
    if (mapImageTried === name) return;
    mapImageTried = name;
    mapImage = null;
    if (!name) return;
    const img = new Image();
    img.onload = () => { mapImage = img; draw(); };
    img.onerror = () => { mapImage = null; draw(); };
    img.src = MAP_IMAGE_DIR + name + ".png";
  }

  function drawBackdrop(){
    g.fillStyle = theme("--slate");
    g.fillRect(0, 0, W, H);

    if (mapImage) {
      /* The compass image covers exactly the world rectangle. */
      const m = state.model;
      const src = m.bounds;
      if (src && src.length === 4) {
        const x0 = px(Math.min(src[0], src[2])), x1 = px(Math.max(src[0], src[2]));
        const y0 = py(Math.max(src[1], src[3])), y1 = py(Math.min(src[1], src[3]));
        g.globalAlpha = 0.62;
        g.drawImage(mapImage, x0, y0, x1 - x0, y1 - y0);
        g.globalAlpha = 1;
        return;
      }
    }

    /* Derived floor plan. Cells nobody entered stay background. */
    if (!floor) return;
    if (!floorImage) {
      const off = document.createElement("canvas");
      off.width = W; off.height = H;
      const o = off.getContext("2d");
      o.fillStyle = theme("--drab");
      const s = CELL * scale;
      for (let y = 0; y < floor.rows; y++) for (let x = 0; x < floor.cols; x++) {
        if (!floor.grown[y * floor.cols + x]) continue;
        const sx = px(minX + x * CELL), sy = py(minY + (y + 1) * CELL);
        o.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(s) + 1, Math.ceil(s) + 1);
      }
      floorImage = off;
    }
    g.drawImage(floorImage, 0, 0);
  }

  /* ---- match drawing ---- */

  /** Is this client alive at t, by the kill feed? */
  function isAlive(client, t){
    const m = state.model;
    const r = m.roundStates.find(x => t >= x.startS && t <= x.endS);
    if (!r) return true;           // between rounds nobody is dead
    return !r.deaths.some(d => d.client === client && d.tS <= t);
  }

  /** The round a time falls in, or null between rounds. */
  function roundAt(t){
    return state.model.roundStates.find(x => t >= x.startS && t <= x.endS) || null;
  }

  function colorOf(client){
    const m = state.model;
    const team = m.teamOf(client);
    return team === m.teamNames[0] ? theme("--allies") : theme("--opfor");
  }

  function drawTrails(t){
    const m = state.model;
    const r = roundAt(t);
    const from = r ? Math.max(r.startS, t - TRAIL_S) : t - TRAIL_S;
    g.lineCap = "round"; g.lineJoin = "round";
    for (const id of Object.keys(m.tracks)) {
      const client = Number(id);
      if (!isAlive(client, t)) continue;
      const track = m.tracks[id];
      const a = MODEL.sampleIndexAt(track, from);
      const b = MODEL.sampleIndexAt(track, t);
      if (b < 0 || b <= a) continue;
      g.strokeStyle = colorOf(client);
      g.globalAlpha = 0.22;
      g.lineWidth = 2.4 * dpr;
      g.beginPath();
      for (let i = Math.max(0, a); i <= b; i++) {
        const p = track[i];
        if (i === Math.max(0, a)) g.moveTo(px(p[1]), py(p[2])); else g.lineTo(px(p[1]), py(p[2]));
      }
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  function drawGrenades(t){
    const m = state.model;
    g.lineCap = "round";
    for (const nade of m.grenades) {
      const t0 = nade.path[0][0] / 100;
      const tImpact = (nade.impactS !== null && nade.impactS !== undefined
                       ? nade.impactS : nade.path[nade.path.length - 1][0]) / 100;
      if (t < t0 - 0.2) continue;

      const smoke = nade.kind === "smoke";
      const liveUntil = smoke ? tImpact + SMOKE_S : tImpact + 2.5;
      if (t > liveUntil) continue;

      /* Flight path up to now. */
      const tint = nade.kind === "smoke" ? "#9AA79A"
                 : nade.kind === "flash" ? theme("--bone")
                 : theme("--grease");
      g.strokeStyle = tint;
      g.globalAlpha = 0.5;
      g.lineWidth = 1.8 * dpr;
      g.beginPath();
      let drew = false;
      for (const p of nade.path) {
        const pt = p[0] / 100;
        if (pt > t) break;
        if (!drew) { g.moveTo(px(p[1]), py(p[2])); drew = true; } else g.lineTo(px(p[1]), py(p[2]));
      }
      if (drew) g.stroke();
      g.globalAlpha = 1;

      if (t < tImpact) continue;
      const ix = px(nade.impact[0]), iy = py(nade.impact[1]);

      if (smoke) {
        const age = (t - tImpact) / SMOKE_S;
        const radius = 160 * scale;
        g.fillStyle = "#9AA79A";
        g.globalAlpha = 0.16 * (1 - age * 0.55);
        g.beginPath(); g.arc(ix, iy, radius, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
      } else if (nade.kind === "flash") {
        g.strokeStyle = theme("--bone");
        g.globalAlpha = 0.35;
        g.lineWidth = 1.4 * dpr;
        g.beginPath(); g.arc(ix, iy, FLASH_RADIUS * scale, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 1;
      }

      /* A predicted impact is a ring, a transmitted one is a cross. The
         difference is real: the prediction ignores walls. */
      g.strokeStyle = tint;
      g.lineWidth = 2 * dpr;
      g.beginPath();
      if (nade.predicted) {
        g.arc(ix, iy, 4.5 * dpr, 0, Math.PI * 2);
      } else {
        const d = 4.5 * dpr;
        g.moveTo(ix - d, iy - d); g.lineTo(ix + d, iy + d);
        g.moveTo(ix + d, iy - d); g.lineTo(ix - d, iy + d);
      }
      g.stroke();
    }
  }

  function drawKillLines(t){
    const m = state.model;
    for (const k of m.kills) {
      if (k.tS > t || t - k.tS > KILL_LINE_S) continue;
      if (!k.killerPos || !k.victimPos) continue;
      const age = (t - k.tS) / KILL_LINE_S;
      g.globalAlpha = 0.85 * (1 - age);
      g.strokeStyle = k.headshot ? theme("--grease") : theme("--bone");
      g.lineWidth = (k.headshot ? 2.6 : 2) * dpr;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(px(k.killerPos.x), py(k.killerPos.y));
      g.lineTo(px(k.victimPos.x), py(k.victimPos.y));
      g.stroke();

      /* Marker on the victim. */
      const vx = px(k.victimPos.x), vy = py(k.victimPos.y);
      g.lineWidth = 2 * dpr;
      const d = 5 * dpr;
      g.beginPath();
      g.moveTo(vx - d, vy - d); g.lineTo(vx + d, vy + d);
      g.moveTo(vx + d, vy - d); g.lineTo(vx - d, vy + d);
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  function drawPlayers(t){
    const m = state.model;
    const R = 5 * dpr;
    for (const id of Object.keys(m.tracks)) {
      const client = Number(id);
      if (!isAlive(client, t)) continue;

      /* Only from the life currently running: a position from an earlier
         round is not where this player is now. */
      const r = roundAt(t);
      const pos = MODEL.positionAt(m.tracks, client, t, null);
      if (!pos) continue;
      if (r && pos.ageS > t - r.startS) continue;

      const fresh = pos.ageS <= FRESH_S;
      const x = px(pos.x), y = py(pos.y);
      const col = colorOf(client);
      const isFollowed = state.followClient === client;

      /* Facing wedge, and the aim ray if switched on. */
      const rad = pos.yaw * Math.PI / 180;
      if (state.view.aimRays) {
        g.strokeStyle = col;
        g.globalAlpha = fresh ? 0.5 : 0.22;
        g.lineWidth = 1.6 * dpr;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(rad) * 26 * dpr, y - Math.sin(rad) * 26 * dpr);
        g.stroke();
        g.globalAlpha = 1;
      }

      /* The dot. Solid when the server is sending them, hollow when it is not. */
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      if (fresh) {
        g.fillStyle = col; g.fill();
      } else {
        g.strokeStyle = col; g.lineWidth = 1.8 * dpr; g.stroke();
      }

      if (isFollowed) {
        g.strokeStyle = theme("--grease");
        g.lineWidth = 1.8 * dpr;
        g.beginPath(); g.arc(x, y, R + 4 * dpr, 0, Math.PI * 2); g.stroke();
      }

      if (state.view.names) {
        const p = m.playerBy.get(client);
        const label = p ? p.name : ("client " + client);
        g.font = (11 * dpr) + "px " + "'Barlow Condensed', sans-serif";
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillStyle = fresh ? theme("--bone") : theme("--bone-mute");
        g.fillText(label, x, y - R - 3 * dpr);
      }
    }
  }

  /* ---- public draw ---- */

  function draw(){
    if (!state.model) {
      g.clearRect(0, 0, cv.width, cv.height);
      return;
    }
    if (!ready) layout();
    const t = state.timeS;
    drawBackdrop();
    if (state.view.trails) drawTrails(t);
    if (state.view.grenades) drawGrenades(t);
    if (state.view.killLines) drawKillLines(t);
    drawPlayers(t);
  }

  /* ---- events ---- */

  const onResize = () => { layout(); draw(); };
  window.addEventListener("resize", onResize);

  state.on("load", () => {
    ready = false;
    mapImageTried = "";
    layout();
    loadMapImage();
    draw();
  });
  state.on("time", draw);
  state.on("selection", draw);
  state.on("view", draw);

  /* Clicking a player follows them. */
  cv.addEventListener("click", ev => {
    if (!state.model) return;
    const rect = cv.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * dpr, sy = (ev.clientY - rect.top) * dpr;
    let best = null, bestD = 18 * dpr;
    for (const id of Object.keys(state.model.tracks)) {
      const client = Number(id);
      const pos = MODEL.positionAt(state.model.tracks, client, state.timeS, null);
      if (!pos) continue;
      const d = Math.hypot(px(pos.x) - sx, py(pos.y) - sy);
      if (d < bestD) { bestD = d; best = client; }
    }
    if (best !== null) state.setFollow(best);
  });

  return { draw, layout, canvas: cv,
           destroy(){ window.removeEventListener("resize", onResize); } };
}

const API = { createViewport, mapImageName, buildFloor };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_VIEWPORT = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
