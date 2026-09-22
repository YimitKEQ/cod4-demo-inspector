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

  const propsBtn = el("button", "btn btn-quiet on", "Props");
  propsBtn.title = "The map's clutter: foliage, rubble, barriers. " +
                   "Switch it off if the view struggles.";
  propsBtn.addEventListener("click", () => state.setProps(!state.view.props, false));

  const replayBtn = el("button", "btn", "Replay kill");
  replayBtn.title = "Frame the selected kill in 3D and swing around the shot (R)";
  replayBtn.disabled = true;

  const stats = el("span", "mute");
  stats.style.fontSize = "11px";
  stats.style.marginLeft = "auto";

  /* Shown over the middle of the view while the map streams in, because the
     alternative is a dark rectangle that looks broken. */
  const loading = el("div", "loading3d");
  loading.hidden = true;
  host.append(loading);

  bar.append(btn3d, camBar, propsBtn, replayBtn, stats);

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
      if (!v) {
        /* ensure3d has already said why. Stay on the flat map rather than
           switching to an empty panel. */
        btn3d.classList.remove("on");
        return;
      }
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

  /* A blank 3D view must never be silent.
     If the renderer has been running for a few seconds and has still not put
     a single triangle on screen, something is wrong that the person looking
     at it cannot diagnose, so say what was found rather than showing them an
     empty rectangle and letting them guess. */
  let blankSince = 0;
  function watchForBlank(){
    if (mode !== "3d" || !vp3d) { blankSince = 0; return; }
    if (state.drawnTriangles > 0) { blankSince = 0; return; }
    if (!blankSince) { blankSince = Date.now(); return; }
    if (Date.now() - blankSince < 4000) return;
    blankSince = 0;
    const l = state.loading;
    if (l && l.done < l.total) return;   /* still arriving, not yet blank */
    if (root.APP_REPORT) {
      root.APP_REPORT("The 3D view is drawing nothing",
        (state.contextLost
          ? "The graphics context was lost and has not come back. "
          : "") +
        "Geometry: " + (state.geometrySource || "none yet") +
        "  ·  props: " + (state.propCount || 0) +
        "  ·  " + (state.fps || 0) + " fps. " +
        "Press V for the flat map, which always works.");
    }
  }

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
    propsBtn.classList.toggle("on", !!state.view.props);
    propsBtn.style.display = mode === "3d" ? "" : "none";
    if (mode === "3d" && vp3d) {
      const cur = vp3d.cameras.mode;
      for (const [id, b] of camButtons) b.classList.toggle("on", id === cur);
      const real = state.geometrySource === "extracted";
      const g = state.geometryStats, s = vp3d.stats;
      const tris = real && g ? g.triangles : (s ? s.triangles : 0);
      stats.textContent = (state.fps ? state.fps + " fps  ·  " : "") +
        (real ? "extracted map, " : "reconstructed map, ") +
        tris.toLocaleString() + " triangles" +
        (state.propCount && state.view.props
          ? "  ·  " + state.propCount.toLocaleString() + " props" : "") +
        (state.propsAutoOff
          ? "  ·  props off, the view was struggling" : "");
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
  state.on("props", refresh);

  /* A frame rate watchdog.
     A frame slow enough to trip a graphics driver's timeout gets the whole
     WebGL context killed, and the view goes black with no explanation. Rather
     than let that happen, the heaviest thing in the scene is dropped when the
     view is clearly struggling, and it says so. */
  let slowSamples = 0;
  state.on("fps", () => {
    refresh();
    watchForBlank();
    if (mode !== "3d" || !state.view.props) return;
    /* Never judge the frame rate while the map is still streaming in. Loading
       is bursty by nature, and dropping the props because a download was in
       flight would punish a slow connection for a fast machine's work. */
    const l = state.loading;
    if (l && l.done < l.total) { slowSamples = 0; return; }
    if (state.fps > 0 && state.fps < 12) slowSamples++;
    else slowSamples = 0;
    if (slowSamples >= 6) {
      slowSamples = 0;
      state.setProps(false, true);
    }
  });
  state.on("geometry", refresh);
  state.on("loading", () => {
    const l = state.loading;
    if (!l || mode !== "3d" || l.done >= l.total) { loading.hidden = true; return; }
    loading.hidden = false;
    loading.textContent = "Loading the map: " + l.done + " of " + l.total +
      " files (" + l.what + ")";
  });
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
