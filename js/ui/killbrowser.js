/*!
 * killbrowser.js - the kill browser and the highlight list.
 *
 * Every kill in the demo as a row: round, time, killer, victim, weapon,
 * headshot, distance, tags. Filter it, sort it, press enter and it plays in
 * the viewport in well under a second because nothing is rendered. Tick the
 * ones worth real footage and they go to the render queue in Phase 5.
 *
 * Keyboard, because that is how this gets used: up and down move, enter
 * plays, x ticks.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
(function (root) {
"use strict";

const STATE = root.DM1_STATE;

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

/* ---- filtering and sorting, kept pure so it is testable ---- */

const SORTS = {
  score: (a, b) => b.score - a.score || a.tS - b.tS,
  time: (a, b) => a.tS - b.tS,
  distance: (a, b) => (b.distanceM || 0) - (a.distanceM || 0) || a.tS - b.tS
};

/**
 * Apply the current filter to a kill list.
 * Text matches either name or the weapon label, so typing a nickname or "ak"
 * both work without a separate box for each.
 */
function filterKills(kills, filter){
  const text = (filter.text || "").trim().toLowerCase();
  const out = kills.filter(k => {
    if (filter.player !== null && filter.player !== undefined &&
        k.killer !== filter.player && k.victim !== filter.player) return false;
    if (filter.weapon && k.weaponLabel !== filter.weapon) return false;
    if (filter.round !== null && filter.round !== undefined && k.round !== filter.round) return false;
    if (filter.tag && k.tags.indexOf(filter.tag) < 0) return false;
    if (text) {
      const hay = ((k.killerName || "") + " " + k.victimName + " " + k.weaponLabel + " " +
                   k.tags.join(" ")).toLowerCase();
      if (hay.indexOf(text) < 0) return false;
    }
    return true;
  });
  out.sort(SORTS[filter.sort] || SORTS.score);
  return out;
}

/* ---- kill browser ---- */

function createKillBrowser(container, state){
  const toolbar = el("div", "toolbar");
  const search = el("input", "field grow");
  search.type = "search";
  search.placeholder = "Filter by player, weapon or tag";
  search.setAttribute("aria-label", "Filter kills");

  const sortSel = el("select", "field");
  sortSel.style.width = "auto";
  for (const [v, label] of [["score", "Best first"], ["time", "In order"],
                            ["distance", "Furthest first"]]) {
    const o = el("option", null, label); o.value = v; sortSel.append(o);
  }

  const playerSel = el("select", "field");
  playerSel.style.width = "auto";
  const roundSel = el("select", "field");
  roundSel.style.width = "auto";

  const selectHot = el("button", "btn", "Tick highlights");
  const clearBtn = el("button", "btn btn-quiet", "Clear");
  const countLabel = el("span", "mute");
  countLabel.style.fontSize = "13px";

  toolbar.append(search, sortSel, playerSel, roundSel, selectHot, clearBtn, countLabel);

  const list = el("div", "panel kill-list");
  list.tabIndex = 0;
  list.setAttribute("role", "listbox");
  container.append(toolbar, list);

  let rows = [];

  function rebuildSelects(){
    const m = state.model;
    playerSel.replaceChildren();
    const any = el("option", null, "All players"); any.value = ""; playerSel.append(any);
    for (const p of m.players) {
      const o = el("option", null, p.name); o.value = String(p.client); playerSel.append(o);
    }
    roundSel.replaceChildren();
    const anyR = el("option", null, "All rounds"); anyR.value = ""; roundSel.append(anyR);
    for (const r of m.rounds) {
      const o = el("option", null, "Round " + r.n); o.value = String(r.n); roundSel.append(o);
    }
  }

  function rowFor(k, index){
    const row = el("div", "kill");
    row.setAttribute("role", "option");
    row.dataset.id = k.id;

    const box = el("div", "box" + (state.checked.has(k.id) ? " on" : ""));
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", state.checked.has(k.id) ? "true" : "false");
    box.title = "Tick for rendering";
    box.addEventListener("click", ev => { ev.stopPropagation(); state.toggleChecked(k.id); });

    const rd = el("div", "rd num", k.round === null ? "-" : k.round);
    const at = el("div", "at num", mmss(k.tS));

    const who = el("div", "who");
    const line = el("div", "line");
    const teamClass = t => (t === state.model.teamNames[0] ? "team-a" : "team-b");
    if (k.suicide) {
      line.append(el("span", "nm " + teamClass(k.victimTeam), k.victimName),
                  el("span", "kills-arrow", "died"));
    } else {
      line.append(el("span", "nm " + teamClass(k.killerTeam), k.killerName || "world"),
                  el("span", "kills-arrow", "on"),
                  el("span", "nm " + teamClass(k.victimTeam), k.victimName));
    }
    who.append(line);

    const sub = el("div", "sub");
    sub.append(el("span", null, k.weaponLabel));
    if (k.distanceM !== null) {
      const d = el("span", null, k.distanceM.toFixed(0) + " m");
      if (k.distanceApprox) d.title = "Approximate: computed from entity state positions";
      sub.append(d);
    }
    for (const t of k.tags) {
      if (t === "Headshot") { sub.append(el("span", "chip chip-hot", t)); continue; }
      sub.append(el("span", "chip", t));
    }
    who.append(sub);

    const sc = el("div", "sc num" + (k.score >= 60 ? " hot" : ""), k.score || "");

    row.append(box, rd, at, who, sc);
    row.addEventListener("click", () => {
      state.cursorIndex = index;
      state.selectKill(k.id, { play: true });
    });
    return row;
  }

  function render(){
    if (!state.model) { list.replaceChildren(el("div", "empty", "No demo loaded.")); return; }
    rows = filterKills(state.model.kills, state.filter);
    countLabel.textContent = rows.length + " of " + state.model.kills.length;

    if (!rows.length) {
      list.replaceChildren(el("div", "empty", "No kills match this filter."));
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((k, i) => {
      const row = rowFor(k, i);
      if (state.selectedKillId === k.id) row.setAttribute("aria-selected", "true");
      if (i === state.cursorIndex) row.classList.add("cursor");
      frag.append(row);
    });
    list.replaceChildren(frag);
    scrollCursorIntoView();
  }

  function scrollCursorIntoView(){
    const node = list.children[state.cursorIndex];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
  }

  function moveCursor(delta){
    if (!rows.length) return;
    state.cursorIndex = Math.max(0, Math.min(rows.length - 1, state.cursorIndex + delta));
    for (const n of list.children) n.classList.remove("cursor");
    const node = list.children[state.cursorIndex];
    if (node) { node.classList.add("cursor"); scrollCursorIntoView(); }
  }

  /** Keys handled while the list has focus. Returns true when consumed. */
  function handleKey(e){
    if (!rows.length) return false;
    if (e.key === "ArrowDown") { moveCursor(1); return true; }
    if (e.key === "ArrowUp") { moveCursor(-1); return true; }
    if (e.key === "Enter") {
      const k = rows[state.cursorIndex];
      if (k) state.selectKill(k.id, { play: true });
      return true;
    }
    if (e.key === "x" || e.key === "X") {
      const k = rows[state.cursorIndex];
      if (k) state.toggleChecked(k.id);
      return true;
    }
    return false;
  }

  /* ---- wiring ---- */

  search.addEventListener("input", () => state.setFilter({ text: search.value }));
  sortSel.addEventListener("change", () => state.setFilter({ sort: sortSel.value }));
  playerSel.addEventListener("change", () =>
    state.setFilter({ player: playerSel.value === "" ? null : Number(playerSel.value) }));
  roundSel.addEventListener("change", () =>
    state.setFilter({ round: roundSel.value === "" ? null : Number(roundSel.value) }));

  selectHot.addEventListener("click", () => {
    if (!state.highlights) return;
    const ids = new Set();
    for (const h of state.highlights.merged) for (const id of h.killIds) ids.add(id);
    state.setChecked([...ids], true);
  });
  clearBtn.addEventListener("click", () => {
    state.setFilter({ text: "", player: null, weapon: null, round: null, tag: null });
    search.value = ""; playerSel.value = ""; roundSel.value = "";
  });

  list.addEventListener("keydown", e => { if (handleKey(e)) e.preventDefault(); });

  state.on("load", () => { rebuildSelects(); search.value = ""; render(); });
  state.on("filter", render);
  state.on("selection", render);
  state.on("checked", render);

  return { render, handleKey, focus: () => list.focus() };
}

/* ---- highlight list ---- */

function createHighlightList(container, state){
  const toolbar = el("div", "toolbar");
  const tickAll = el("button", "btn", "Tick all");
  const countLabel = el("span", "mute");
  countLabel.style.fontSize = "13px";
  toolbar.append(tickAll, countLabel);

  const list = el("div", "panel hl");
  list.tabIndex = 0;
  container.append(toolbar, list);

  let items = [];
  let cursor = 0;

  function render(){
    if (!state.highlights) {
      list.replaceChildren(el("div", "empty", "No demo loaded."));
      return;
    }
    items = state.highlights.merged;
    countLabel.textContent = items.length + " moments";

    const frag = document.createDocumentFragment();
    for (const note of state.highlights.notes) {
      frag.append(el("div", "note", note));
    }
    if (!items.length) {
      frag.append(el("div", "empty", "Nothing stood out in this demo."));
      list.replaceChildren(frag);
      return;
    }

    items.forEach((h, i) => {
      const row = el("div", "hl-row");
      row.dataset.id = h.id;
      if (state.selectedHighlightId === h.id) row.setAttribute("aria-selected", "true");
      if (i === cursor) row.classList.add("cursor");

      const allChecked = h.killIds.length > 0 && h.killIds.every(id => state.checked.has(id));
      const box = el("div", "box" + (allChecked ? " on" : ""));
      box.setAttribute("role", "checkbox");
      box.title = "Tick every kill in this moment";
      box.addEventListener("click", ev => {
        ev.stopPropagation();
        state.setChecked(h.killIds, !allChecked);
      });

      const score = el("div", "score num" + (h.score >= 70 ? " hot" : ""), h.score);
      const body = el("div", "body");
      body.append(el("div", "ttl", h.title));
      body.append(el("div", "det", h.detail));
      const tags = el("div", "tags");
      for (const t of h.tags) tags.append(el("span", "chip", t));
      if (h.approx) tags.append(el("span", "chip chip-approx", "approx"));
      body.append(tags);

      const when = el("div", "when num");
      when.append(el("div", null, "r" + (h.round === null ? "-" : h.round)));
      when.append(el("div", null, mmss(h.focusS)));

      row.append(box, score, body, when);
      row.addEventListener("click", () => {
        cursor = i;
        state.selectHighlight(h.id, { play: true });
      });
      frag.append(row);
    });
    list.replaceChildren(frag);
  }

  function handleKey(e){
    if (!items.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      cursor = Math.max(0, Math.min(items.length - 1, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      render();
      const node = list.querySelector(".hl-row.cursor");
      if (node) node.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (e.key === "Enter") { state.selectHighlight(items[cursor].id, { play: true }); return true; }
    if (e.key === "x" || e.key === "X") {
      const h = items[cursor];
      const all = h.killIds.every(id => state.checked.has(id));
      state.setChecked(h.killIds, !all);
      return true;
    }
    return false;
  }

  tickAll.addEventListener("click", () => {
    const ids = new Set();
    for (const h of items) for (const id of h.killIds) ids.add(id);
    state.setChecked([...ids], true);
  });
  list.addEventListener("keydown", e => { if (handleKey(e)) e.preventDefault(); });

  state.on("load", () => { cursor = 0; render(); });
  state.on("selection", render);
  state.on("checked", render);

  return { render, handleKey, focus: () => list.focus() };
}

const API = { createKillBrowser, createHighlightList, filterKills, SORTS };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_KILLBROWSER = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
