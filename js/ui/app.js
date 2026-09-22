/*!
 * app.js - bootstrap: load a demo, run the clock, wire the keyboard.
 *
 * Owns three things and nothing else: the file, the playback loop and the
 * key bindings. Everything on screen is drawn by its own module from the
 * shared state.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const { parseDemoAsync, analyze } = root.DM1;
const MODEL = root.DM1_MODEL;
const HIGHLIGHTS = root.DM1_HIGHLIGHTS;
const STATE = root.DM1_STATE;
const VIEWPORT = root.DM1_VIEWPORT;
const KILLBROWSER = root.DM1_KILLBROWSER;
const TIMELINE = root.DM1_TIMELINE;
const PANELS = root.DM1_PANELS;

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined && txt !== null) n.textContent = txt;
  return n;
};
const clean = s => String(s === null || s === undefined ? "" : s).replace(/\^./g, "");
const mmss = s => {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

const state = STATE.createState();
root.APP_STATE = state;   /* one handle for the console, and later for the worker */

/* ---- side panel ---- */

const sideBody = $("#side-body");
const tabButtons = [...document.querySelectorAll(".tab")];

/* The two list views keep their own DOM so their scroll position and cursor
   survive a tab switch. The static panels are rebuilt on demand. */
const listHosts = {
  kills: el("div", "side-host"),
  highlights: el("div", "side-host")
};
for (const host of Object.values(listHosts)) {
  host.style.display = "none";
  host.style.flexDirection = "column";
  host.style.flex = "1";
  host.style.minHeight = "0";
  sideBody.append(host);
}
const staticHost = el("div", "panel");
staticHost.style.display = "none";
sideBody.append(staticHost);

const killBrowser = KILLBROWSER.createKillBrowser(listHosts.kills, state);
const highlightList = KILLBROWSER.createHighlightList(listHosts.highlights, state);

function showTab(name){
  for (const host of Object.values(listHosts)) host.style.display = "none";
  staticHost.style.display = "none";
  if (listHosts[name]) {
    listHosts[name].style.display = "flex";
  } else {
    staticHost.style.display = "block";
    PANELS.renderPanel(name, staticHost, state);
  }
  for (const b of tabButtons) b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
}

for (const b of tabButtons) {
  b.addEventListener("click", () => state.setTab(b.dataset.tab));
}
state.on("tab", () => showTab(state.tab));

/* ---- viewport and timeline ---- */

const viewport = VIEWPORT.createViewport($("#viewport"), state);
const timeline = TIMELINE.createTimeline($("#timeline"), state);

/* ---- header ---- */

function renderHeader(){
  const m = state.model;
  const score = $("#score"), meta = $("#meta");
  score.replaceChildren();
  meta.replaceChildren();
  if (!m) return;
  const [a, b] = m.teams;
  score.append(
    el("span", "tname team-a", clean(a.name)),
    el("span", "num", String(a.wins)),
    el("span", "sep", ":"),
    el("span", "num", String(b.wins)),
    el("span", "tname team-b", clean(b.name))
  );
  const bits = [m.info.map, m.info.gametype];
  if (m.info.mod) bits.push(m.info.mod);
  if (m.info.ruleset) bits.push(clean(m.info.ruleset));
  bits.push("recorded by " + clean(m.info.povName));
  for (const t of bits) meta.append(el("span", null, t));
}

/* ---- kill feed overlay ---- */

const killfeedHost = $("#killfeed");
const KILLFEED_S = 6;

function renderKillfeed(){
  const m = state.model;
  killfeedHost.replaceChildren();
  if (!m || !state.view.killfeed) return;
  const t = state.timeS;
  const recent = m.kills.filter(k => k.tS <= t && t - k.tS < KILLFEED_S).slice(-5);
  for (const k of recent) {
    const row = el("div", "kf" + (t - k.tS < 0.6 ? " fresh" : ""));
    const teamClass = tm => (tm === m.teamNames[0] ? "team-a" : "team-b");
    if (k.suicide) {
      row.append(el("span", teamClass(k.victimTeam), clean(k.victimName)),
                 el("span", "mute", "died"));
    } else {
      row.append(el("span", teamClass(k.killerTeam), clean(k.killerName)),
                 el("span", "mute", k.headshot ? "headshot" : "killed"),
                 el("span", teamClass(k.victimTeam), clean(k.victimName)));
    }
    if (k.weaponKnown) row.append(el("span", "w", k.weaponLabel));
    killfeedHost.append(row);
  }
}

state.on("time", renderKillfeed);
state.on("view", renderKillfeed);

/* ---- the clock ---- */

let raf = null, lastFrame = 0;

function frame(now){
  raf = requestAnimationFrame(frame);
  if (!state.playing || !state.model) { lastFrame = now; return; }
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  let next = state.timeS + dt * state.rate;
  const clip = state.clip;
  if (clip && next >= clip.endS) {
    state.seek(clip.endS, { keepClip: true });
    state.setPlaying(false);
    return;
  }
  if (next >= state.model.info.durationS) {
    state.seek(state.model.info.durationS);
    state.setPlaying(false);
    return;
  }
  state.seek(next, { keepClip: true });
}

function startClock(){
  if (raf === null) { lastFrame = performance.now(); raf = requestAnimationFrame(frame); }
}

state.on("transport", () => { if (state.playing) lastFrame = performance.now(); });

/* ---- view toggles ---- */

const toggles = [
  ["#v-trails", "trails"], ["#v-aim", "aimRays"], ["#v-kills", "killLines"],
  ["#v-nades", "grenades"], ["#v-names", "names"]
];
for (const [sel, key] of toggles) {
  const btn = $(sel);
  btn.addEventListener("click", () => state.toggleView(key));
}
state.on("view", () => {
  for (const [sel, key] of toggles) $(sel).classList.toggle("on", state.view[key]);
});

/* ---- clip recording straight off the canvas ---- */

let recorder = null;
$("#v-record").addEventListener("click", () => {
  if (recorder) { recorder.stop(); return; }
  if (!state.model) return;
  if (typeof MediaRecorder === "undefined" || !viewport.canvas.captureStream) {
    setError("This browser cannot record the canvas. Chrome and Edge can.");
    return;
  }
  const stream = viewport.canvas.captureStream(60);
  const chunks = [];
  const mime = ["video/webm;codecs=vp9", "video/webm"].find(
    t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "video/webm";
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    recorder = null;
    $("#v-record").textContent = "Record clip";
    $("#v-record").classList.remove("on");
    const blob = new Blob(chunks, { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.fileName || "clip").replace(/\.[^.]+$/, "") + "-" +
                 Math.round(state.timeS) + "s.webm";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  recorder.start();
  $("#v-record").textContent = "Stop recording";
  $("#v-record").classList.add("on");
});

const TAB_KEYS = ["highlights", "kills", "players", "rounds", "chat", "events", "demo"];

/* ---- loading a demo ---- */

const drop = $("#drop");
const prog = $("#prog");
const progMsg = $("#prog-msg");
const errEl = $("#drop-err");

function setError(msg){ errEl.textContent = msg || ""; }

async function loadFile(file){
  setError("");
  prog.hidden = false;
  prog.value = 0;
  progMsg.textContent = "Reading " + file.name;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    progMsg.textContent = "Parsing " + file.name;
    const parsed = await parseDemoAsync(buf, pct => {
      prog.value = pct;
      progMsg.textContent = "Parsing " + file.name + "  " + pct + "%";
    });
    const res = analyze(parsed);
    const model = MODEL.buildModel(res);
    const found = HIGHLIGHTS.detect(model);

    state.load(model, found, file.name);
    renderHeader();
    renderKillfeed();
    showTab(found.merged.length ? "highlights" : "kills");
    state.tab = found.merged.length ? "highlights" : "kills";
    $("#app").hidden = false;
    drop.classList.add("hidden");
    viewport.layout();
    viewport.draw();
    timeline.layout();
    timeline.draw();
    timeline.refreshControls();
    startClock();
  } catch (e) {
    prog.hidden = true;
    progMsg.textContent = "";
    setError("Could not read that demo: " + (e && e.message ? e.message : String(e)) +
             ". If it is a CoD4 .dm_1 file, the parser hit something it does not know yet.");
    return;
  }
  prog.hidden = true;
  progMsg.textContent = "";
}

/**
 * The sample match: a hand built S&D with a quad kill, a 1v3, a collateral,
 * a headshot run and a ninja defuse. It is the same fixture the tests assert
 * on, so what it shows here is exactly what the engine claims.
 */
function loadSample(){
  const synth = root.DM1_SYNTH;
  if (!synth) { setError("The sample match is not available in this build."); return; }
  const model = MODEL.buildModel(synth.referenceMatch());
  const found = HIGHLIGHTS.detect(model);
  state.load(model, found, "sample match");
  renderHeader();
  renderKillfeed();
  state.tab = "highlights";
  showTab("highlights");
  $("#app").hidden = false;
  drop.classList.add("hidden");
  viewport.layout(); viewport.draw();
  timeline.layout(); timeline.draw(); timeline.refreshControls();
  startClock();
}

$("#drop-sample").addEventListener("click", loadSample);

/* The URL carries what you are looking at, so a link opens on the same thing.
   Phase 2 extends this with the camera; the shape is already here. */
function applyUrl(){
  const q = new URLSearchParams(location.search);
  if (q.has("tab")) { const t = q.get("tab"); if (TAB_KEYS.includes(t)) state.setTab(t); }
  if (q.has("t")) { const t = Number(q.get("t")); if (isFinite(t)) state.seek(t); }
}
/**
 * Load a demo the page can reach over HTTP. That is what makes a link to a
 * moment work: same demo, same time, same panel. The file still never leaves
 * the machine, it is just fetched from the local server rather than dropped.
 */
async function loadUrl(url){
  setError("");
  prog.hidden = false;
  prog.value = 0;
  progMsg.textContent = "Fetching " + url;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("the server answered " + resp.status);
    const blob = await resp.blob();
    const name = url.split("/").pop() || "demo.dm_1";
    await loadFile(new File([blob], name));
  } catch (e) {
    prog.hidden = true;
    progMsg.textContent = "";
    setError("Could not fetch " + url + ": " + (e && e.message ? e.message : String(e)));
  }
}

const query = new URLSearchParams(location.search);
if (query.has("sample")) {
  window.addEventListener("load", () => { loadSample(); applyUrl(); });
} else if (query.has("demo")) {
  window.addEventListener("load", () => { loadUrl(query.get("demo")).then(applyUrl); });
}

$("#drop-pick").addEventListener("click", () => $("#file").click());
$("#btn-open").addEventListener("click", () => {
  drop.classList.remove("hidden");
  $("#file").click();
});
$("#file").addEventListener("change", e => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFile(f);
});

for (const ev of ["dragenter", "dragover"]) {
  window.addEventListener(ev, e => {
    e.preventDefault();
    drop.classList.remove("hidden");
    drop.classList.add("over");
  });
}
window.addEventListener("dragleave", e => {
  if (e.relatedTarget === null) drop.classList.remove("over");
});
window.addEventListener("drop", e => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
  else if (state.model) drop.classList.add("hidden");
});

/* ---- keyboard ---- */

const help = $("#help");
$("#btn-help").addEventListener("click", () => help.classList.toggle("hidden"));
help.addEventListener("click", () => help.classList.add("hidden"));

window.addEventListener("keydown", e => {
  const tag = (e.target && e.target.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

  if (e.key === "Escape") {
    if (!help.classList.contains("hidden")) { help.classList.add("hidden"); return; }
    if (typing) { e.target.blur(); return; }
    if (state.clip) { state.clip = null; state.setPlaying(false); state.emit("time"); }
    return;
  }
  if (e.key === "?") { help.classList.toggle("hidden"); e.preventDefault(); return; }
  if (typing || !state.model) return;

  /* The active list gets first refusal on the arrow keys. */
  const list = state.tab === "kills" ? killBrowser
             : state.tab === "highlights" ? highlightList : null;
  if (list && !e.shiftKey && ["ArrowUp", "ArrowDown", "Enter", "x", "X"].includes(e.key)) {
    if (list.handleKey(e)) { e.preventDefault(); return; }
  }

  switch (e.key) {
    case " ": state.togglePlay(); e.preventDefault(); break;
    case "j": case "J": state.nudgeRate(-1); break;
    case "l": case "L": state.nudgeRate(1); break;
    case "k": case "K": state.setPlaying(false); break;
    case "ArrowLeft":
      if (e.shiftKey) timeline.jumpKill(-1); else state.seek(state.timeS - 0.1);
      e.preventDefault(); break;
    case "ArrowRight":
      if (e.shiftKey) timeline.jumpKill(1); else state.seek(state.timeS + 0.1);
      e.preventDefault(); break;
    case "Home":
      state.seek(state.model.rounds.length ? state.model.rounds[0].startS : 0);
      e.preventDefault(); break;
    case "t": case "T": state.toggleView("trails"); break;
    case "a": case "A": state.toggleView("aimRays"); break;
    case "n": case "N": state.toggleView("names"); break;
    case "g": case "G": state.toggleView("grenades"); break;
    default:
      if (e.key >= "1" && e.key <= "7") {
        const name = TAB_KEYS[Number(e.key) - 1];
        if (name) state.setTab(name);
      }
  }
});

/* Static panels follow the clock where it matters (the demo panel does not). */
state.on("selection", () => {
  if (!["kills", "highlights"].includes(state.tab)) PANELS.renderPanel(state.tab, staticHost, state);
});

showTab("highlights");

})(typeof globalThis !== "undefined" ? globalThis : this);
