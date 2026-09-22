#!/usr/bin/env node
/*!
 * cli.js - the demo inspector on the command line.
 *
 *   node tools/cli.js demo.dm_1                 summary and the top moments
 *   node tools/cli.js demo.dm_1 --top 20        more moments
 *   node tools/cli.js demo.dm_1 --kills         every kill as a table
 *   node tools/cli.js demo.dm_1 --model out.json  the whole model as JSON
 *   node tools/cli.js demo.dm_1 --inventory     which fields this demo carries
 *
 * The JSON that --model writes is what tools/py/highlights.py reads, so the
 * Python engine sees exactly the match the JS engine saw.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const fs = require("fs");
const path = require("path");

require("../js/core/netfields.js");
require("../js/core/snapshot.js");
const DM1 = require("../js/core/dm1.js");
const MODEL = require("../js/core/model.js");
const HL = require("../js/core/highlights.js");

/* ---- arguments ---- */

function parseArgs(argv){
  const out = { file: null, top: 10, kills: false, model: null, inventory: false,
                json: false, quiet: false, sample: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") out.top = parseInt(argv[++i], 10) || 10;
    else if (a === "--kills") out.kills = true;
    else if (a === "--model") out.model = argv[++i] || "model.json";
    else if (a === "--inventory") out.inventory = true;
    else if (a === "--json") out.json = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--sample") out.sample = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out.file = a;
  }
  return out;
}

const USAGE = [
  "CoD4 Demo Inspector",
  "",
  "  node tools/cli.js <demo.dm_1> [options]",
  "",
  "  --top N        how many moments to list (default 10)",
  "  --kills        print every kill",
  "  --model FILE   write the full match model as JSON",
  "  --inventory    report which fields this demo actually carries",
  "  --json         print the highlight list as JSON instead of a table",
  "  --sample       use the built in sample match instead of a demo file",
  "  --quiet        no progress output",
  ""
].join("\n");

/* ---- table printing ---- */

function pad(s, n, right){
  s = String(s === null || s === undefined ? "" : s);
  if (s.length > n) s = s.slice(0, n - 1) + "…";
  return right ? s.padStart(n) : s.padEnd(n);
}

function table(headers, rows){
  const widths = headers.map((h, i) =>
    Math.max(h.label.length, ...rows.map(r => String(r[i] === null ? "" : r[i]).length)));
  const line = cells => "  " + cells.map((c, i) => pad(c, widths[i], headers[i].right)).join("  ");
  const out = [line(headers.map(h => h.label)),
               "  " + widths.map(w => "-".repeat(w)).join("  ")];
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

const mmss = s => {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/* ---- inventory: what is actually in this demo ---- */

/**
 * The data inventory the handoff asks for in Phase 0: which fields exist per
 * frame, for the recorder and for everyone else, and how often other players
 * drop out of the snapshots.
 */
function inventory(model){
  const pov = model.info.povClient;
  const lines = [];
  const tracks = model.tracks;
  const clients = Object.keys(tracks).map(Number).sort((a, b) => a - b);

  lines.push("Demo: " + model.info.map + "  " + model.info.gametype +
             "  protocol " + model.info.protocol +
             (model.info.mod ? "  fs_game " + model.info.mod : "  no mod"));
  lines.push("Recorder: client " + pov + " (" + model.info.povName + ")");
  lines.push("");
  lines.push("Per client coverage.");
  lines.push("  raw gap    longest stretch with no sample at all, dead time included");
  lines.push("  alive cov  share of living seconds where the player could be placed");
  lines.push("  alive gap  longest stretch unplaceable while alive and in a round");
  lines.push("");

  /* Coverage is only meaningful while a player is alive and in a round. A
     dead player is correctly not sent, and the gap between rounds is not a
     dropout, so counting those made every player look half missing. This
     walks each player's living seconds and asks how many had a sample fresh
     enough to place them. That is the number the 3D view depends on. */
  const STEP = 0.25;
  const rows = [];
  for (const cl of clients) {
    const p = model.playerBy.get(cl);
    const t = tracks[String(cl)];
    let maxGap = 0;
    for (let i = 1; i < t.length; i++) {
      const gap = (t[i][0] - t[i - 1][0]) / 100;
      if (gap > maxGap) maxGap = gap;
    }
    let live = 0, covered = 0, liveGapMax = 0, sinceSample = 0;
    for (const st of model.roundStates) {
      const death = st.deaths.find(d => d.client === cl);
      const until = death ? death.tS : st.endS;
      sinceSample = 0;
      for (let time = st.startS; time <= until; time += STEP) {
        live++;
        const pos = MODEL.positionAt(tracks, cl, time, MODEL.STALE_S);
        if (pos && pos.ageS <= MODEL.STALE_S) {
          covered++;
          sinceSample = 0;
        } else {
          sinceSample += STEP;
          if (sinceSample > liveGapMax) liveGapMax = sinceSample;
        }
      }
    }
    const spanS = (t[t.length - 1][0] - t[0][0]) / 100;
    rows.push([
      cl,
      p ? p.name : "(not on a team)",
      cl === pov ? "playerState" : "entityState",
      t.length,
      spanS.toFixed(0) + " s",
      maxGap.toFixed(1) + " s",
      live ? (100 * covered / live).toFixed(0) + "%" : "-",
      liveGapMax.toFixed(1) + " s"
    ]);
  }
  lines.push(table([
    { label: "cl", right: true }, { label: "name" }, { label: "source" },
    { label: "samples", right: true }, { label: "span", right: true },
    { label: "raw gap", right: true }, { label: "alive cov", right: true },
    { label: "alive gap", right: true }
  ], rows));

  lines.push("");
  lines.push("Fields present per position sample: t, x, y, z, yaw, weaponId.");
  lines.push("Pitch, velocity, stance, lean, ADS and the animation indices are decoded by");
  lines.push("snapshot.js but are not carried into the tracks yet. Phase 6 needs the");
  lines.push("animation indices, so they get added to buildMap when that work starts.");
  lines.push("");
  lines.push("Kill feed: " + (model.caps.killFeed ? model.info.obituaries + " obituaries, " +
             model.info.duplicateObituaries + " duplicates removed" : "absent"));
  lines.push("Grenades: " + model.grenades.length + " flight paths" +
             (model.grenades.length ? " (" + model.grenades.filter(g => g.predicted).length +
              " with a predicted impact)" : ""));
  lines.push("Stats source: " + model.info.statsSource);
  return lines.join("\n");
}

/* ---- main ---- */

function main(){
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.file && !args.sample)) {
    process.stdout.write(USAGE);
    process.exit(args.file || args.sample ? 0 : 1);
  }

  const t0 = Date.now();
  let res;
  if (args.sample) {
    /* The same fixture the tests assert on, so the cross check and the CLI
       can both be exercised before any real demo exists. */
    res = require("../tests/fixtures/synth.js").referenceMatch();
    if (!args.file) args.file = "sample-match";
  } else {
    if (!fs.existsSync(args.file)) {
      process.stderr.write("No such demo: " + args.file + "\n");
      process.exit(1);
    }
    const bytes = new Uint8Array(fs.readFileSync(args.file));
    const parsed = DM1.parseDemo(bytes, args.quiet ? null : pct => {
      process.stderr.write("\rParsing " + String(pct).padStart(3) + "%");
    }, true);
    if (!args.quiet) process.stderr.write("\r                \r");
    res = DM1.analyze(parsed);
  }

  const model = MODEL.buildModel(res);
  const found = HL.detect(model, { top: args.top });
  const parseMs = Date.now() - t0;

  if (args.model) {
    /* The model carries Maps and functions, which JSON cannot hold. What the
       Python side needs is the plain match plus the derived kills. */
    const payload = {
      info: model.info,
      teams: model.teams,
      players: model.players,
      rounds: model.rounds,
      kills: model.kills,
      roundStates: model.roundStates.map(s => ({
        n: s.n, idx: s.idx, startS: s.startS, endS: s.endS, half: s.half,
        winner: s.winner, reason: s.reason,
        rosters: Object.fromEntries(s.rosters),
        deaths: s.deaths,
        bomb: s.bomb, plant: s.plant, defuse: s.defuse
      })),
      caps: model.caps,
      grenades: model.grenades,
      bombFloorS: found.bombFloorS,
      /* The JS engine's own answer travels with the input, so the Python
         engine can recompute from the same match and diff against it without
         a second parse. tools/py/crosscheck.py reads exactly this. */
      jsHighlights: found.highlights
    };
    fs.writeFileSync(args.model, JSON.stringify(payload, null, 2));
    process.stderr.write("Model written to " + args.model + "\n");
  }

  if (args.inventory) { process.stdout.write(inventory(model) + "\n"); return; }

  if (args.json) {
    process.stdout.write(JSON.stringify({ info: model.info, highlights: found.merged,
                                          notes: found.notes }, null, 2) + "\n");
    return;
  }

  /* ---- summary ---- */
  const i = model.info;
  const [a, b] = model.teams;
  process.stdout.write("\n  " + path.basename(args.file) + "\n");
  process.stdout.write("  " + a.name + " " + a.wins + " : " + b.wins + " " + b.name +
                       "   " + i.map + "  " + i.gametype +
                       (i.mod ? "  " + i.mod : "") +
                       "   recorded by " + i.povName + "\n");
  process.stdout.write("  " + mmss(i.durationS) + ", " + model.rounds.length + " rounds, " +
                       model.kills.length + " kills, parsed in " + parseMs + " ms\n");

  for (const n of found.notes) process.stdout.write("\n  Note: " + n + "\n");

  if (args.kills) {
    process.stdout.write("\n  Kills\n\n");
    process.stdout.write(table([
      { label: "rd", right: true }, { label: "time", right: true }, { label: "killer" },
      { label: "victim" }, { label: "weapon" }, { label: "dist", right: true },
      { label: "score", right: true }, { label: "tags" }
    ], found.kills.map(k => [
      k.round === null ? "-" : k.round, mmss(k.tS),
      k.killerName || "(world)", k.victimName, k.weaponLabel,
      k.distanceM === null ? "-" : k.distanceM.toFixed(0) + " m",
      k.score, k.tags.join(", ")
    ])) + "\n");
  }

  if (found.merged.length) {
    process.stdout.write("\n  Top " + found.merged.length + " moments\n\n");
    process.stdout.write(table([
      { label: "#", right: true }, { label: "score", right: true }, { label: "rd", right: true },
      { label: "at", right: true }, { label: "clip", right: true }, { label: "moment" }
    ], found.merged.map((h, n) => [
      n + 1, h.score, h.round === null ? "-" : h.round, mmss(h.focusS),
      (h.endS - h.startS).toFixed(1) + " s",
      h.title + (h.approx ? "  (approx)" : "")
    ])) + "\n");
  }
  process.stdout.write("\n");
}

if (require.main === module) main();
module.exports = { inventory, parseArgs };
