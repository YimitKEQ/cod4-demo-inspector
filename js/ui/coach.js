/*!
 * coach.js - the panel that tells you something you did not already know.
 *
 * Reads core/analysis.js and lays it out in the order a coach would look at
 * it: what the team does that an opponent can read, who wins first contact,
 * whether deaths get traded, how predictable everyone is.
 *
 * Every number says where it came from. A metric that could not be computed
 * says so rather than showing a zero.
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

const clean = s => String(s === null || s === undefined ? "" : s).replace(/\^./g, "");
const pct = v => (v === null || v === undefined ? "-" : Math.round(v * 100) + "%");

const KIND_LABEL = { frag: "Frag", smoke: "Smoke", flash: "Flash", other: "Other" };

/** A headline figure with the one line that says what it means. */
function stat(value, label, detail){
  const box = el("div", "stat");
  box.append(el("div", "stat-v", value));
  box.append(el("div", "stat-l", label));
  if (detail) box.append(el("div", "stat-d", detail));
  return box;
}

function section(title, hint){
  const h = el("div", "coach-head");
  h.append(el("h3", null, title));
  if (hint) h.append(el("div", "coach-hint", hint));
  return h;
}

function coachPanel(state){
  const a = state.analysis;
  const m = state.model;
  const wrap = el("div");

  if (!a) {
    wrap.append(el("div", "empty", "No analysis for this demo."));
    return wrap;
  }

  const teamClass = t => (t === m.teamNames[0] ? "team-a" : "team-b");

  /* ---- headline ---- */
  const row = el("div", "stat-row");
  row.append(stat(pct(a.duels.openingConversion), "Opening kill wins the round",
                  "across " + a.duels.openings.length + " rounds with a kill"));
  row.append(stat(pct(a.utility.utilityBeforeEntryRate), "Rounds with utility before first contact",
                  "something landed in the 8 s before the first kill"));
  row.append(stat(a.duels.firstContactMedianS + " s", "Median first contact",
                  "spread " + a.duels.firstContactSpreadS + " s"));
  row.append(stat(String(a.lineups.length), "Repeated grenade lineups",
                  "same throw, same landing, 3 or more times"));
  wrap.append(row);

  for (const n of a.notes) wrap.append(el("div", "note", n));

  /* ---- lineups ---- */
  wrap.append(section("Utility the opponent can learn",
    "A lineup is the same grenade thrown from the same place to the same place. " +
    "A tight time spread means it is scripted. Click one to watch it."));

  if (!a.lineups.length) {
    wrap.append(el("div", "empty", "No grenade was thrown the same way three times."));
  } else {
    const list = el("div", "lineups");
    for (const l of a.lineups.slice(0, 24)) {
      const rowEl = el("div", "lineup");
      const top = l.throwers[0];
      rowEl.append(el("div", "lineup-n num", l.uses + "x"));

      const body = el("div", "lineup-body");
      const head = el("div", "lineup-head");
      head.append(el("span", "chip chip-hot", KIND_LABEL[l.kind] || l.kind));
      head.append(el("span", teamClass(l.team), clean(l.team)));
      head.append(el("span", "dim", "mostly " + clean(m.nameOf(top.client))));
      body.append(head);

      const det = el("div", "lineup-det");
      det.textContent = "thrown at " + l.medianRoundTS + " s into the round" +
        (l.spreadS <= 1 ? ", within " + l.spreadS + " s every time" :
                          ", spread " + l.spreadS + " s") +
        " · rounds " + l.rounds.slice(0, 8).join(", ") +
        (l.rounds.length > 8 ? " and " + (l.rounds.length - 8) + " more" : "");
      body.append(det);
      rowEl.append(body);

      if (l.spreadS <= 0.5 && l.uses >= 5) {
        rowEl.append(el("span", "chip chip-hot", "scripted"));
      }

      rowEl.addEventListener("click", () => {
        /* Jump to the first use and follow whoever throws it most. */
        const use = a.throws.find(t =>
          t.round === l.rounds[0] && t.kind === l.kind && t.thrower === top.client);
        if (use) {
          state.setFollow(top.client);
          state.playClip({ startS: Math.max(0, use.tS - 3), endS: use.impactS + 6,
                           focusS: use.tS, follow: top.client, rate: 1 });
        }
        state.selectLineup(l);
      });
      if (state.selectedLineup === l) rowEl.classList.add("on");
      list.append(rowEl);
    }
    wrap.append(list);
  }

  /* ---- duels ---- */
  wrap.append(section("Opening duels and trades",
    "Who wins first contact, and whether a death gets answered within 3 s. " +
    "A low trade rate is a spacing problem, not an aim problem."));

  const duelTable = el("table", "data");
  duelTable.append(headRow(["Player", "Open W", "Open L", "Rate", "Deaths", "Traded"]));
  const tb = el("tbody");
  for (const p of a.duels.players) {
    if (p.openingWins + p.openingLosses === 0 && p.deaths === 0) continue;
    const tr = el("tr");
    tr.append(cell(clean(p.name), teamClass(p.team)));
    tr.append(cell(p.openingWins, "n"));
    tr.append(cell(p.openingLosses, "n"));
    tr.append(cell(p.openingRate === null ? "-" : pct(p.openingRate), "n"));
    tr.append(cell(p.deaths, "n"));
    tr.append(cell(p.tradedRate === null ? "-" : pct(p.tradedRate), "n"));
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => state.setFollow(p.client));
    tb.append(tr);
  }
  duelTable.append(tb);
  wrap.append(duelTable);

  /* ---- utility per player ---- */
  wrap.append(section("Utility used",
    "Promod gives one frag plus one special grenade a life, so a player with " +
    "no flashes chose smoke. Attribution is by nearest player when the grenade " +
    "appeared, since the demo does not record who threw it."));

  const utilTable = el("table", "data");
  utilTable.append(headRow(["Player", "Frag", "Smoke", "Flash", "Per round"]));
  const utb = el("tbody");
  for (const p of a.utility.perPlayer) {
    if (!p.total) continue;
    const tr = el("tr");
    tr.append(cell(clean(p.name), teamClass(p.team)));
    tr.append(cell(p.frag, "n"));
    tr.append(cell(p.smoke, "n"));
    tr.append(cell(p.flash, "n"));
    tr.append(cell(p.perRound, "n"));
    utb.append(tr);
  }
  utilTable.append(utb);
  wrap.append(utilTable);

  /* ---- predictability ---- */
  wrap.append(section("How readable is each player",
    "The first " + a.cfg.routeS + " s of every round, clustered. A high score " +
    "means the same line out of spawn nearly every round."));

  for (const r of a.routes) {
    const line = el("div", "readable");
    line.append(el("span", "readable-n num", r.score === null ? "-" : r.score));
    const b = el("div", "readable-b");
    b.append(el("div", teamClass(r.team), clean(r.name)));
    b.append(el("div", "mute", r.why));
    line.append(b);
    line.style.cursor = "pointer";
    line.addEventListener("click", () => {
      state.setFollow(r.client);
      state.selectRoutes(r);
    });
    if (state.selectedRoutes === r) line.classList.add("on");
    wrap.append(line);
  }

  /* ---- movement ---- */
  wrap.append(section("Movement",
    "Strafe jumping and wall running are legitimate technique in promod and " +
    "both show as speed above a sprint while airborne. Approximate: the tracks " +
    "carry no ground flag, so airborne is inferred from height."));

  const moveTable = el("table", "data");
  moveTable.append(headRow(["Player", "Median", "Peak", "Jumps/rd", "Fast air"]));
  const mtb = el("tbody");
  for (const mv of a.movement) {
    const tr = el("tr");
    tr.append(cell(clean(mv.name), teamClass(mv.team)));
    if (!mv.playing) {
      const td = el("td", null, mv.note);
      td.colSpan = 4;
      td.className = "mute";
      tr.append(td);
    } else {
      tr.append(cell(mv.medianSpeed, "n"));
      tr.append(cell(mv.peakSpeed, "n"));
      tr.append(cell(mv.jumpsPerRound, "n"));
      tr.append(cell(pct(mv.strafeJumpShare), "n"));
    }
    mtb.append(tr);
  }
  moveTable.append(mtb);
  wrap.append(moveTable);

  return wrap;
}

function headRow(labels){
  const thead = el("thead"), tr = el("tr");
  labels.forEach((l, i) => {
    const th = el("th", i ? "n" : null, l);
    if (i) th.style.textAlign = "right";
    tr.append(th);
  });
  thead.append(tr);
  return thead;
}

function cell(v, cls){
  const td = el("td", cls === "n" ? "n" : null);
  if (cls && cls !== "n") td.className = cls;
  td.textContent = v;
  return td;
}

const API = { coachPanel };
if (typeof module === "object" && module.exports) module.exports = API;
root.DM1_COACH = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
