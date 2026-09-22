/*!
 * panels.js - the quieter side panels: players, rounds, chat, events, demo.
 *
 * These used to compete with the map for the screen. They still hold every
 * number they held before, they just sit in the side panel now and let the
 * viewport be the thing you look at.
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

const mmss = s => {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/** Strip the CoD4 colour codes so names read as names. */
const clean = s => String(s === null || s === undefined ? "" : s).replace(/\^./g, "");

function table(headers, rows){
  const t = el("table", "data");
  const thead = el("thead"), tr = el("tr");
  for (const h of headers) {
    const th = el("th", h.n ? "n" : null, h.label);
    if (h.n) th.style.textAlign = "right";
    tr.append(th);
  }
  thead.append(tr); t.append(thead);
  const tb = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    r.cells.forEach((c, i) => {
      const td = el("td", headers[i].n ? "n" : null);
      if (c instanceof Node) td.append(c); else td.textContent = c;
      row.append(td);
    });
    if (r.onClick) { row.style.cursor = "pointer"; row.addEventListener("click", r.onClick); }
    tb.append(row);
  }
  t.append(tb);
  return t;
}

function playersPanel(state){
  const m = state.model;
  const wrap = el("div");
  for (const team of m.teamNames) {
    const members = m.players.filter(p => p.team === team);
    if (!members.length) continue;
    const head = el("div", "panel-pad");
    head.style.paddingBottom = "4px";
    if (wrap.childElementCount) head.style.paddingTop = "20px";
    const h = el("h3", team === m.teamNames[0] ? "team-a" : "team-b", clean(team));
    head.append(h);
    wrap.append(head);
    wrap.append(table(
      [{ label: "Player" }, { label: "K", n: true }, { label: "D", n: true },
       { label: "A", n: true }, { label: "+/-", n: true }, { label: "Ping", n: true }],
      members.map(p => ({
        cells: [clean(p.name), p.kills, p.deaths, p.assists,
                (p.kills - p.deaths > 0 ? "+" : "") + (p.kills - p.deaths), p.ping],
        onClick: () => state.setFollow(p.client)
      }))
    ));
  }
  if (m.info.scoreboardStale) {
    wrap.append(el("div", "note",
      "The server sent no scoreboard after the last round, so assists and ping are from the " +
      "last one it did send. Kills and deaths come from the kill feed and are current."));
  }
  return wrap;
}

function roundsPanel(state){
  const m = state.model;
  return table(
    [{ label: "#", n: true }, { label: "Winner" }, { label: "How" },
     { label: "Score", n: true }, { label: "At", n: true }],
    m.rounds.map(r => ({
      cells: [r.n,
              (() => {
                const s = el("span", r.winner === m.teamNames[0] ? "team-a" : "team-b",
                             clean(r.winner));
                return s;
              })(),
              r.reason, r.score, mmss(r.startS)],
      onClick: () => state.seek(r.startS)
    }))
  );
}

function chatPanel(state){
  const m = state.model;
  if (!m.chat.length) return el("div", "empty", "Nobody said anything in this demo.");
  const wrap = el("div", "panel-pad");
  for (const c of m.chat) {
    const line = el("div");
    line.style.marginBottom = "5px";
    line.style.fontFamily = "var(--prose)";
    line.style.fontSize = "13px";
    const t = el("span", "mute num", mmss(c.tS) + "  ");
    const scope = el("span", "chip", c.scope === "team" ? "team" : "all");
    scope.style.marginRight = "5px";
    line.append(t, scope, document.createTextNode(clean(c.text)));
    line.addEventListener("click", () => state.seek(c.tS));
    line.style.cursor = "pointer";
    wrap.append(line);
  }
  return wrap;
}

function eventsPanel(state){
  const m = state.model;
  if (!m.events.length) return el("div", "empty", "No events in this demo.");
  const wrap = el("div", "panel-pad");
  for (const e of m.events) {
    const line = el("div");
    line.style.marginBottom = "3px";
    line.style.fontSize = "13px";
    line.style.cursor = "pointer";
    line.append(el("span", "mute num", mmss(e.tS) + "  "),
                document.createTextNode(clean(e.text)));
    line.addEventListener("click", () => state.seek(e.tS));
    wrap.append(line);
  }
  return wrap;
}

/**
 * What this demo actually carries. This is the honest panel: it says where
 * every number came from and what is missing, so nothing on screen has to be
 * taken on trust.
 */
function demoPanel(state){
  const m = state.model;
  const i = m.info;
  const wrap = el("div", "panel-pad");

  const kv = el("dl", "kv");
  const add = (k, v) => { kv.append(el("dt", null, k), el("dd", null, v)); };
  add("File", state.fileName || "unknown");
  add("Map", i.map);
  add("Game type", i.gametype);
  add("Mod", i.mod || "none (stock)");
  add("Ruleset", clean(i.ruleset) || "unknown");
  add("Server", clean(i.server) || "unknown");
  add("Protocol", root.DM1_MODEL.protocolLabel(i.protocol));
  add("Recorded by", clean(i.povName) + " (client " + i.povClient + ")");
  add("Length", mmss(i.durationS));
  add("Size", (i.sizeBytes / 1048576).toFixed(1) + " MB");
  wrap.append(kv);

  wrap.append(el("h3", null, "Where the numbers come from"));
  const kv2 = el("dl", "kv");
  const add2 = (k, v) => { kv2.append(el("dt", null, k), el("dd", null, v)); };
  add2("Stats", i.statsSource === "killfeed"
    ? "Kill feed (" + i.obituaries + " obituaries, " + i.duplicateObituaries + " duplicates removed)"
    : "Scoreboard deltas, because this demo has no kill feed");
  add2("Positions", m.caps.positions
    ? m.caps.trackedClients + " players tracked"
    : "none: this demo was parsed without snapshot decoding");
  add2("Teams", i.taggedTeams ? "From client states" : "Guessed from name prefixes");
  add2("Map backdrop", {
    image: "The map's own compass image, placed on the world rectangle",
    derived: "Built from every recorded position: this map has no image, so cells " +
             "nobody walked through are drawn as wall",
    noBounds: "None: the demo carries no compass rectangle, so an image cannot be placed",
    loading: "Loading"
  }[state.backdrop] || "Unknown");
  add2("End of file", i.cleanEof ? "Clean" : "Truncated, the demo stops mid stream");
  wrap.append(kv2);

  wrap.append(el("div", "note",
    "Only the recorder has exact data every frame. Everyone else comes from entity state, " +
    "which the server sends only when they matter to the recorder. Anything derived from it " +
    "is marked approximate."));

  if (state.highlights) {
    for (const n of state.highlights.notes) wrap.append(el("div", "note", n));
  }
  return wrap;
}

const PANELS = {
  players: playersPanel,
  rounds: roundsPanel,
  chat: chatPanel,
  events: eventsPanel,
  demo: demoPanel
};

function renderPanel(name, container, state){
  container.replaceChildren();
  if (!state.model) { container.append(el("div", "empty", "No demo loaded.")); return; }
  const fn = PANELS[name];
  if (!fn) { container.append(el("div", "empty", "Nothing here.")); return; }
  container.append(fn(state));
}

const API = { renderPanel, PANELS, clean, table };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_PANELS = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
