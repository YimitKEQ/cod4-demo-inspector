/*!
 * timeline.js - a real editor timeline, not a progress bar.
 *
 * Round blocks labelled by number, kill ticks coloured by team, highlight
 * markers, the playhead in grease yellow. J K L shuttle, space plays, the
 * arrow keys step, shift with them jumps to the next kill.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

/* Lane geometry, in device pixels at dpr 1. */
const LANE = {
  rounds: { y: 6, h: 20 },
  kills: { y: 30, h: 16 },
  highlights: { y: 50, h: 9 }
};

const mmss = s => {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

function createTimeline(container, state){
  const controls = document.createElement("div");
  controls.className = "timeline-controls";

  const mk = (cls, txt, title) => {
    const b = document.createElement("button");
    b.className = cls; b.textContent = txt;
    if (title) b.title = title;
    return b;
  };

  const playBtn = mk("btn", "Play", "Space");
  const backBtn = mk("btn btn-quiet", "Slower", "J");
  const fwdBtn = mk("btn btn-quiet", "Faster", "L");
  const prevKill = mk("btn btn-quiet", "Prev kill", "Shift + left arrow");
  const nextKill = mk("btn btn-quiet", "Next kill", "Shift + right arrow");

  const clock = document.createElement("div");
  clock.className = "clock num";
  const rate = document.createElement("div");
  rate.className = "rate num";
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "? for keys";

  controls.append(playBtn, backBtn, rate, fwdBtn, prevKill, nextKill, clock, spacer, hint);

  const cv = document.createElement("canvas");
  container.append(controls, cv);
  const g = cv.getContext("2d");

  let W = 0, H = 0, dpr = 1;
  const PAD = 8;

  const theme = name =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const duration = () => (state.model ? Math.max(1, state.model.info.durationS) : 1);
  const tToX = t => PAD * dpr + (t / duration()) * (W - PAD * 2 * dpr);
  const xToT = x => ((x - PAD * dpr) / (W - PAD * 2 * dpr)) * duration();

  function layout(){
    const rect = cv.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(rect.width * dpr));
    H = Math.max(1, Math.round(rect.height * dpr));
    cv.width = W; cv.height = H;
  }

  function draw(){
    if (!W || !H) layout();
    g.fillStyle = theme("--drab");
    g.fillRect(0, 0, W, H);
    if (!state.model) return;

    const m = state.model;
    const sc = v => v * dpr;

    /* Round blocks. */
    g.font = (11 * dpr) + "px 'Barlow Condensed', sans-serif";
    g.textBaseline = "middle";
    g.textAlign = "center";
    for (const r of m.rounds) {
      const x0 = tToX(r.startS), x1 = tToX(r.startS + r.durS);
      const w = Math.max(2, x1 - x0);
      const winnerIsA = r.winner === m.teamNames[0];
      g.fillStyle = theme("--slate");
      g.fillRect(x0, sc(LANE.rounds.y), w, sc(LANE.rounds.h));
      /* A hairline on the winning side's edge, rather than tinting the whole
         block, which would make team colour compete with the map. */
      g.fillStyle = winnerIsA ? theme("--allies") : theme("--opfor");
      g.fillRect(x0, sc(LANE.rounds.y), w, sc(2));
      if (w > 16 * dpr) {
        g.fillStyle = theme("--bone-dim");
        g.fillText(String(r.n), x0 + w / 2, sc(LANE.rounds.y + LANE.rounds.h / 2) + dpr);
      }
    }

    /* Kill ticks, coloured by the killer's team. */
    for (const k of m.kills) {
      const x = tToX(k.tS);
      const team = k.suicide ? k.victimTeam : k.killerTeam;
      g.fillStyle = team === m.teamNames[0] ? theme("--allies") : theme("--opfor");
      const h = k.headshot ? LANE.kills.h : LANE.kills.h - 5;
      g.globalAlpha = k.suicide ? 0.4 : 1;
      g.fillRect(Math.round(x), sc(LANE.kills.y + (LANE.kills.h - h)), Math.max(1, dpr), sc(h));
      g.globalAlpha = 1;
    }

    /* Highlight markers. */
    if (state.highlights) {
      for (const h of state.highlights.merged) {
        const x0 = tToX(h.startS), x1 = tToX(h.endS);
        g.fillStyle = h.score >= 70 ? theme("--grease") : theme("--webbing");
        g.globalAlpha = h.score >= 70 ? 0.85 : 0.6;
        g.fillRect(x0, sc(LANE.highlights.y), Math.max(2, x1 - x0), sc(LANE.highlights.h - 4));
        g.globalAlpha = 1;
      }
    }

    /* The clip window currently loaded, as a bracket under everything. */
    if (state.clip) {
      const x0 = tToX(state.clip.startS), x1 = tToX(state.clip.endS);
      g.strokeStyle = theme("--grease");
      g.globalAlpha = 0.5;
      g.lineWidth = dpr;
      g.beginPath();
      g.moveTo(x0, sc(LANE.highlights.y + LANE.highlights.h));
      g.lineTo(x1, sc(LANE.highlights.y + LANE.highlights.h));
      g.stroke();
      g.globalAlpha = 1;
    }

    /* Playhead. */
    const px = Math.round(tToX(state.timeS)) + 0.5;
    g.strokeStyle = theme("--grease");
    g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, H);
    g.stroke();
  }

  function refreshControls(){
    playBtn.textContent = state.playing ? "Pause" : "Play";
    playBtn.classList.toggle("on", state.playing);
    rate.textContent = state.rate + "x";
    const total = state.model ? state.model.info.durationS : 0;
    clock.replaceChildren();
    const now = document.createElement("span");
    now.textContent = mmss(state.timeS);
    const of = document.createElement("span");
    of.className = "of";
    of.textContent = " / " + mmss(total);
    clock.append(now, of);
  }

  /* ---- interaction ---- */

  function seekFromEvent(ev){
    const rect = cv.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * dpr;
    state.seek(xToT(x));
  }

  let scrubbing = false;
  cv.addEventListener("pointerdown", ev => {
    scrubbing = true;
    cv.setPointerCapture(ev.pointerId);
    seekFromEvent(ev);
  });
  cv.addEventListener("pointermove", ev => { if (scrubbing) seekFromEvent(ev); });
  cv.addEventListener("pointerup", ev => {
    scrubbing = false;
    if (cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
  });

  playBtn.addEventListener("click", () => state.togglePlay());
  backBtn.addEventListener("click", () => state.nudgeRate(-1));
  fwdBtn.addEventListener("click", () => state.nudgeRate(1));
  prevKill.addEventListener("click", () => jumpKill(-1));
  nextKill.addEventListener("click", () => jumpKill(1));

  /** Jump the playhead to the next or previous kill. */
  function jumpKill(dir){
    if (!state.model) return;
    const times = state.model.kills.map(k => k.tS);
    const t = state.timeS;
    if (dir > 0) {
      const next = times.find(x => x > t + 0.05);
      if (next !== undefined) state.seek(next - 0.6);
    } else {
      let prev = null;
      for (const x of times) if (x < t - 0.8) prev = x;
      if (prev !== null) state.seek(prev - 0.6);
    }
  }

  const onResize = () => { layout(); draw(); };
  window.addEventListener("resize", onResize);

  state.on("load", () => { layout(); draw(); refreshControls(); });
  state.on("time", () => { draw(); refreshControls(); });
  state.on("transport", () => { draw(); refreshControls(); });
  state.on("selection", draw);

  return { draw, layout, jumpKill, refreshControls };
}

const API = { createTimeline };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_TIMELINE = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
