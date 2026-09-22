/*!
 * state.js - one source of truth for what the app is currently showing.
 *
 * Every view reads this and nothing else, and every view is redrawn from a
 * change event rather than from whoever caused the change. That is what lets
 * the 2D view, the timeline and the kill browser stay in step, and what will
 * let the 3D view drop in beside them keeping the same time and selection.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const RATES = [0.25, 0.5, 1, 2, 4];

function createState(){
  const listeners = new Map();
  let nextId = 1;

  const s = {
    /* Loaded match. */
    model: null,
    highlights: null,
    analysis: null,
    fileName: "",

    /* A lineup or a route cluster picked in the coach panel, drawn over the
       map so the pattern is visible in space rather than only as a number. */
    selectedLineup: null,
    selectedRoutes: null,

    /* Frames per second in the 3D view, so performance is a number rather
       than an impression. */
    fps: 0,

    /* Whether the 3D map is the real extracted geometry or the reconstruction
       built from player positions. The difference is worth stating. */
    geometrySource: null,
    geometryStats: null,

    /* Restrict the heatmap to one player, which is the version that answers
       "where does he always go". Null means everyone. */
    heatClient: null,

    /* Playback. */
    timeS: 0,
    playing: false,
    rate: 1,
    /* When a clip is running the playhead stops at endS instead of running on
       to the end of the demo. */
    clip: null,

    /* Selection. */
    selectedKillId: null,
    selectedHighlightId: null,
    followClient: null,
    cursorIndex: 0,

    /* Kills ticked for the render queue. */
    checked: new Set(),

    /* What the viewport is currently drawing underneath the match: the map's
       own compass image, or the floor plan derived from where players walked.
       Set by the viewport, read by the demo panel so the difference is never
       left unexplained. */
    backdrop: null,

    /* Side panel. */
    tab: "kills",

    /* Kill browser filters. */
    filter: { text: "", player: null, weapon: null, round: null, tag: null,
              sort: "score" },

    /* View switches. */
    view: { trails: true, aimRays: true, killLines: true, grenades: true,
            heatmap: false, names: true, killfeed: true, xray: false,
            props: true }
  };

  /** Subscribe. Returns an unsubscribe function. */
  s.on = function (event, fn){
    const id = nextId++;
    if (!listeners.has(event)) listeners.set(event, new Map());
    listeners.get(event).set(id, fn);
    return () => listeners.get(event).delete(id);
  };

  s.emit = function (event, payload){
    const set = listeners.get(event);
    if (set) for (const fn of set.values()) fn(payload, s);
    if (event !== "*") {
      const all = listeners.get("*");
      if (all) for (const fn of all.values()) fn(event, s);
    }
  };

  /* ---- mutations, each one emitting exactly what changed ---- */

  s.load = function (model, highlights, analysis, fileName){
    s.model = model;
    s.highlights = highlights;
    s.analysis = analysis || null;
    s.selectedLineup = null;
    s.selectedRoutes = null;
    s.heatClient = null;
    s.fileName = fileName || "";
    s.backdrop = null;
    s.timeS = model.rounds.length ? model.rounds[0].startS : 0;
    s.playing = false;
    s.rate = 1;
    s.clip = null;
    s.selectedKillId = null;
    s.selectedHighlightId = null;
    s.followClient = model.info.povClient;
    s.cursorIndex = 0;
    s.checked = new Set();
    s.filter = { text: "", player: null, weapon: null, round: null, tag: null, sort: "score" };
    s.emit("load");
  };

  s.seek = function (t, opts){
    const end = s.model ? s.model.info.durationS : 0;
    const next = Math.max(0, Math.min(end, t));
    if (next === s.timeS) return;
    s.timeS = next;
    if (!(opts && opts.keepClip)) s.clip = null;
    s.emit("time");
  };

  s.setPlaying = function (on){
    if (s.playing === on) return;
    s.playing = on;
    s.emit("transport");
  };

  s.togglePlay = function (){ s.setPlaying(!s.playing); };

  s.setRate = function (r){
    const next = Math.max(RATES[0], Math.min(RATES[RATES.length - 1], r));
    if (next === s.rate) return;
    s.rate = next;
    s.emit("transport");
  };

  s.nudgeRate = function (dir){
    let i = RATES.indexOf(s.rate);
    if (i < 0) i = RATES.indexOf(1);
    s.setRate(RATES[Math.max(0, Math.min(RATES.length - 1, i + dir))]);
  };

  /**
   * Play a window: jump to its start, follow the player it is about, and stop
   * where it ends. This is the one click the kill browser promises, and the
   * same window the renderer is handed later.
   */
  s.playClip = function (clip){
    s.clip = { startS: clip.startS, endS: clip.endS, focusS: clip.focusS };
    s.timeS = clip.startS;
    if (clip.follow !== undefined && clip.follow !== null) s.followClient = clip.follow;
    s.rate = clip.rate || 1;
    s.playing = true;
    s.emit("time");
    s.emit("transport");
  };

  s.selectKill = function (id, opts){
    s.selectedKillId = id;
    s.selectedHighlightId = null;
    s.emit("selection");
    if (opts && opts.play && id) {
      const k = s.model.kills.find(x => x.id === id);
      if (k) s.playClip(killClip(k));
    }
  };

  s.selectHighlight = function (id, opts){
    s.selectedHighlightId = id;
    s.selectedKillId = null;
    s.emit("selection");
    if (opts && opts.play && id && s.highlights) {
      const h = s.highlights.merged.find(x => x.id === id) ||
                s.highlights.highlights.find(x => x.id === id);
      if (h) s.playClip({ startS: h.startS, endS: h.endS, focusS: h.focusS,
                          follow: h.primary });
    }
  };

  s.setFollow = function (client){
    if (s.followClient === client) return;
    s.followClient = client;
    s.emit("selection");
  };

  s.toggleChecked = function (id){
    if (s.checked.has(id)) s.checked.delete(id); else s.checked.add(id);
    s.emit("checked");
  };

  s.setChecked = function (ids, on){
    for (const id of ids) { if (on) s.checked.add(id); else s.checked.delete(id); }
    s.emit("checked");
  };

  s.clearChecked = function (){ s.checked = new Set(); s.emit("checked"); };

  s.setTab = function (tab){
    if (s.tab === tab) return;
    s.tab = tab;
    s.emit("tab");
  };

  s.setFilter = function (patch){
    Object.assign(s.filter, patch);
    s.cursorIndex = 0;
    s.emit("filter");
  };

  s.setHeatClient = function (client){
    if (s.heatClient === client) return;
    s.heatClient = client;
    s.emit("heat");
  };

  s.selectLineup = function (l){
    s.selectedLineup = s.selectedLineup === l ? null : l;
    s.selectedRoutes = null;
    s.emit("overlay");
  };

  s.selectRoutes = function (r){
    s.selectedRoutes = s.selectedRoutes === r ? null : r;
    s.selectedLineup = null;
    s.emit("overlay");
  };

  /* Turned off automatically when the frame rate collapses, and by the user
     from the viewport bar. Kept apart from the view switches because it is
     expensive enough to be worth its own signal. */
  s.setProps = function (on, automatic){
    if (s.view.props === on) return;
    s.view.props = on;
    s.propsAutoOff = !!(automatic && !on);
    s.emit("props");
  };

  s.toggleView = function (key){
    s.view[key] = !s.view[key];
    s.emit("view");
  };

  return s;
}

/**
 * The clip window for a single kill: four seconds of run up, the kill at half
 * speed, two seconds after. The same shape the highlight engine produces, so
 * both feed the renderer identically.
 */
function killClip(kill){
  return {
    startS: Math.max(0, kill.tS - 4),
    endS: kill.tS + 2,
    focusS: kill.tS,
    follow: kill.killer !== null ? kill.killer : kill.victim,
    rate: 1
  };
}

const API = { createState, killClip, RATES };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_STATE = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
