/*!
 * viewswitch.js - owns which viewport is on screen and the camera controls.
 *
 * 2D and 3D read the same store, so switching keeps the moment, the followed
 * player and the selection. Only one of them runs a render loop at a time.
 *
 * This is also where "show me the kill" lives: selecting a kill while 3D is up
 * frames it and swings around the shot, which is the whole point of having the
 * 3D view at all.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined && txt !== null) n.textContent = txt;
  return n;
};

/**
 * @param host        the .viewport element, holding both canvases
 * @param bar         the .viewport-bar element to add controls to
 * @param viewport2d  the 2D viewport
 * @param state       the shared store
 */
function createViewSwitch(host, bar, viewport2d, state){
  const host3d = el("div", "viewport-3d");
  host3d.style.position = "absolute";
  host3d.style.inset = "0";
  host3d.style.display = "none";
  host.insertBefore(host3d, host.firstChild);

  let vp3d = null;
  let mode = "2d";

  /* ---- controls ---- */

  const btn3d = el("button", "btn", "3D");
  btn3d.title = "Switch between the flat map and the 3D reconstruction (V)";

  const camBar = el("div", "cambar");
  camBar.style.display = "none";
  const camButtons = new Map();
  const CAMS = [
    ["fly", "1", "Free fly"], ["orbit", "2", "Orbit"], ["follow", "3", "Follow"],
    ["eyes", "4", "Recorder eyes"], ["eyesApprox", "5", "Player eyes"],
    ["tactical", "6", "Tactical"]
  ];
  for (const [id, key, label] of CAMS) {
    const b = el("button", "btn btn-quiet", label);
    b.title = label + " (" + key + ")";
    b.addEventListener("click", () => setCamera(id));
    camButtons.set(id, b);
    camBar.append(b);
  }

  const replayBtn = el("button", "btn", "Replay kill");
  replayBtn.title = "Frame the selected kill in 3D and swing around the shot (R)";
  replayBtn.disabled = true;

  const stats = el("span", "mute");
  stats.style.fontSize = "11px";
  stats.style.marginLeft = "auto";

  bar.append(btn3d, camBar, replayBtn, stats);

  /* ---- switching ---- */

  function ensure3d(){
    if (vp3d) return vp3d;
    if (!root.THREE) return null;
    vp3d = root.DM1_VIEWPORT3D.createViewport3D(host3d, state);
    if (vp3d && state.model) vp3d.rebuild();
    return vp3d;
  }

  function setMode(next){
    if (next === mode) return;
    if (next === "3d") {
      const v = ensure3d();
      if (!v) return;
      host3d.style.display = "block";
      viewport2d.canvas.style.visibility = "hidden";
      v.resize();
      v.start();
    } else {
      if (vp3d) vp3d.stop();
      host3d.style.display = "none";
      viewport2d.canvas.style.visibility = "visible";
      viewport2d.layout();
      viewport2d.draw();
    }
    mode = next;
    btn3d.classList.toggle("on", mode === "3d");
    btn3d.textContent = mode === "3d" ? "3D" : "3D";
    camBar.style.display = mode === "3d" ? "flex" : "none";
    refresh();
    state.emit("viewmode");
  }

  function toggle(){ setMode(mode === "3d" ? "2d" : "3d"); }

  function setCamera(id){
    const v = ensure3d();
    if (!v) return;
    if (mode !== "3d") setMode("3d");
    v.cameras.setMode(id);
    refresh();
  }

  /* ---- the replay ---- */

  function selectedKill(){
    const m = state.model;
    if (!m) return null;
    if (state.selectedKillId) return m.kills.find(k => k.id === state.selectedKillId) || null;
    if (state.selectedHighlightId && state.highlights) {
      const h = state.highlights.merged.find(x => x.id === state.selectedHighlightId) ||
                state.highlights.highlights.find(x => x.id === state.selectedHighlightId);
      if (h && h.killIds.length) {
        /* The last kill of a moment is the one that finished it. */
        return m.kills.find(k => k.id === h.killIds[h.killIds.length - 1]) || null;
      }
    }
    return null;
  }

  /**
   * Play the selected kill: rewind to the run up, follow the killer, and in 3D
   * frame the shot itself. Slowed through the moment, because at full speed a
   * CoD4 kill is over in three frames.
   */
  function replaySelected(){
    const k = selectedKill();
    if (!k) return false;
    const v = ensure3d();
    if (!v) return false;
    if (mode !== "3d") setMode("3d");
    state.playClip({
      startS: Math.max(0, k.tS - 4),
      endS: k.tS + 2.5,
      focusS: k.tS,
      follow: k.killer !== null ? k.killer : k.victim,
      rate: 0.5
    });
    v.cameras.startReplay(k, state.model);
    return true;
  }

  replayBtn.addEventListener("click", replaySelected);
  btn3d.addEventListener("click", toggle);

  /* ---- keys ---- */

  const CAM_KEYS = { Digit1: "fly", Digit2: "orbit", Digit3: "follow",
                     Digit4: "eyes", Digit5: "eyesApprox", Digit6: "tactical" };

  function handleKey(e){
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    if (e.key === "v" || e.key === "V") { toggle(); return true; }
    if (e.key === "r" || e.key === "R") { return replaySelected(); }
    if (CAM_KEYS[e.code]) { setCamera(CAM_KEYS[e.code]); return true; }
    return false;
  }

  /* ---- state ---- */

  function refresh(){
    replayBtn.disabled = !selectedKill();
    if (mode === "3d" && vp3d) {
      const cur = vp3d.cameras.mode;
      for (const [id, b] of camButtons) b.classList.toggle("on", id === cur);
      const real = state.geometrySource === "extracted";
      const g = state.geometryStats, s = vp3d.stats;
      const tris = real && g ? g.triangles : (s ? s.triangles : 0);
      stats.textContent = (state.fps ? state.fps + " fps  ·  " : "") +
        (real ? "extracted map, " : "reconstructed map, ") +
        tris.toLocaleString() + " triangles";
      stats.title = real
        ? "Real geometry from the map's own Radiant source."
        : "Reconstructed from every position players occupied. It only claims " +
          "floor where somebody actually stood. Run tools/mapsrc.js on a map " +
          "source to replace this with the real thing.";
    } else {
      stats.textContent = "";
    }
  }

  state.on("selection", () => {
    refresh();
    /* Selecting a kill while 3D is up frames it straight away: that is the
       point of the view. In 2D the existing clip playback already handles it. */
    if (mode === "3d" && vp3d) {
      const k = selectedKill();
      if (k) vp3d.cameras.startReplay(k, state.model);
    }
  });
  state.on("camera", refresh);
  state.on("fps", refresh);
  state.on("geometry", refresh);
  state.on("load", () => {
    if (vp3d) vp3d.rebuild();
    refresh();
  });

  refresh();

  return {
    handleKey, setMode, toggle, setCamera, replaySelected, refresh,
    get mode(){ return mode; },
    get viewport3d(){ return vp3d; }
  };
}

const API = { createViewSwitch };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_VIEWSWITCH = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
