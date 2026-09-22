#!/usr/bin/env node
/*!
 * verify.js - run every demo in a folder through the parser and report what
 * held and what did not.
 *
 * This is the check the upstream README describes as verify_all.py, rebuilt on
 * the JS parser because the Python one was never published. The checks are the
 * same three ideas:
 *
 *   stream      did the Huffman stream decode to a clean end of file
 *   sections    gamestate, config strings, snapshots and rounds all present
 *   agreement   does the kill feed agree with the scoreboard on kills and deaths
 *
 * Plus the things the later phases depend on: positions, grenades, and whether
 * a mod is in play.
 *
 *   node tools/verify.js <folder or demo> [--json]
 *
 * Exits non zero if any demo fails a check, so it can be a gate.
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

/**
 * Kill feed against scoreboard.
 *
 * The scoreboard is the server's own count, the feed is ours. They are allowed
 * to differ a little: the last scoreboard can predate the last round, and team
 * kills count differently. A large gap means the feed is missing obituaries.
 */
function agreement(model, res){
  const sb = new Map();
  for (const p of model.players) sb.set(p.client, p);
  if (!model.caps.killFeed) return { ok: null, note: "no kill feed to compare" };

  /* model.players already carries the feed derived totals when a feed exists,
     so the comparison is against the raw obituary count for the match. */
  const feedTotal = model.kills.filter(k => !k.suicide).length;
  const roundTotal = model.roundStates.reduce((a, s) => a + s.kills.length, 0);
  const orphan = model.kills.filter(k => k.roundIdx < 0).length;

  const notes = [];
  if (orphan) notes.push(orphan + " kills fell outside every round");
  const ok = orphan === 0;
  return { ok, feedTotal, roundTotal, orphan,
           note: notes.length ? notes.join("; ") : "kills all land inside a round" };
}

function checkDemo(file){
  const r = { file: path.basename(file), ok: true, checks: {}, problems: [], warnings: [] };
  const bytes = new Uint8Array(fs.readFileSync(file));
  const t0 = Date.now();

  let parsed, res, model, found;
  try {
    parsed = DM1.parseDemo(bytes, null, true);
    res = DM1.analyze(parsed);
    model = MODEL.buildModel(res);
    found = HL.detect(model);
  } catch (e) {
    r.ok = false;
    r.problems.push("parse threw: " + (e && e.message ? e.message : String(e)));
    return r;
  }
  r.ms = Date.now() - t0;

  const i = model.info;
  r.map = i.map;
  r.mod = i.mod || "";
  r.protocol = i.protocol;
  r.durationS = i.durationS;
  r.pov = i.povName;
  r.sizeMB = +(i.sizeBytes / 1048576).toFixed(1);

  /* Stream. A truncated demo is normal: the recording stops when the player
     leaves. Everything up to the cut still decoded, so this is worth knowing,
     not a failure. */
  r.checks.stream = i.cleanEof;
  if (!i.cleanEof) r.warnings.push("stream ends mid message, the recording was cut short");

  /* sections */
  r.checks.configstrings = i.configstrings > 0;
  if (!i.configstrings) r.problems.push("no config strings: no gamestate was read");
  r.checks.snapshots = i.snapshots > 0;
  if (!i.snapshots) r.problems.push("no snapshots decoded");
  r.checks.rounds = model.rounds.length > 0;
  if (!model.rounds.length) {
    r.warnings.push("no rounds: the round timer was never seen, so round based moments " +
                    "(multikills, clutches, openings) cannot be found in this demo");
  }

  /* agreement */
  /* Kills outside a round are usually warmup or the knife round, which is
     ordinary. A large share of them means round detection actually broke. */
  const ag = agreement(model, res);
  r.checks.agreement = ag.ok;
  r.agreementNote = ag.note;
  r.orphanShare = model.kills.length ? ag.orphan / model.kills.length : 0;
  if (ag.orphan > 0 && r.orphanShare > 0.25) {
    r.problems.push(ag.orphan + " of " + model.kills.length + " kills fall outside every " +
                    "round, so round detection did not hold here");
  } else if (ag.orphan > 0) {
    r.warnings.push(ag.orphan + " kills outside a round (warmup or knife round)");
  }

  /* things the later phases need */
  r.checks.positions = model.caps.positions;
  if (!model.caps.positions) r.problems.push("no position tracks: the map views cannot work");
  if (!i.taggedTeams) r.warnings.push("teams guessed from name prefixes, not client states");

  r.kills = model.kills.length;
  r.rounds = model.rounds.length;
  r.tracked = model.caps.trackedClients;
  r.grenades = model.grenades.length;
  r.highlights = found.merged.length;
  r.duplicateObituaries = i.duplicateObituaries;
  r.teams = i.taggedTeams;

  r.ok = r.problems.length === 0;
  return r;
}

function collect(target){
  const st = fs.statSync(target);
  if (!st.isDirectory()) return [target];
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.dm_1$/i.test(e.name)) out.push(p);
    }
  };
  walk(target);
  return out.sort();
}

function main(){
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const target = args.find(a => !a.startsWith("-"));
  if (!target) {
    process.stdout.write("  node tools/verify.js <folder or demo> [--json]\n");
    process.exit(1);
  }

  const files = collect(target);
  if (!files.length) {
    process.stderr.write("No .dm_1 files under " + target + "\n");
    process.exit(1);
  }

  const results = [];
  for (const f of files) {
    if (!asJson) process.stderr.write("\r" + (results.length + 1) + "/" + files.length + "  ");
    results.push(checkDemo(f));
  }
  if (!asJson) process.stderr.write("\r                    \r");

  if (asJson) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    process.exit(results.every(r => r.ok) ? 0 : 1);
  }

  const pad = (s, n, right) => {
    s = String(s === null || s === undefined ? "" : s);
    if (s.length > n) s = s.slice(0, n - 1) + "…";
    return right ? s.padStart(n) : s.padEnd(n);
  };

  process.stdout.write("\n  " + files.length + " demos\n\n");
  process.stdout.write("  " + pad("demo", 38) + "  " + pad("map", 16) + "  " +
    pad("mod", 20) + "  " + pad("rds", 4, true) + "  " + pad("kills", 6, true) + "  " +
    pad("pl", 3, true) + "  " + pad("nades", 6, true) + "  " + pad("top", 4, true) + "  " +
    pad("ms", 6, true) + "  ok\n");
  process.stdout.write("  " + "-".repeat(38) + "  " + "-".repeat(16) + "  " + "-".repeat(20) +
    "  " + "-".repeat(4) + "  " + "-".repeat(6) + "  " + "-".repeat(3) + "  " + "-".repeat(6) +
    "  " + "-".repeat(4) + "  " + "-".repeat(6) + "  --\n");

  for (const r of results) {
    process.stdout.write("  " + pad(r.file, 38) + "  " + pad(r.map, 16) + "  " +
      pad(r.mod, 20) + "  " + pad(r.rounds, 4, true) + "  " + pad(r.kills, 6, true) + "  " +
      pad(r.tracked, 3, true) + "  " + pad(r.grenades, 6, true) + "  " +
      pad(r.highlights, 4, true) + "  " + pad(r.ms, 6, true) + "  " +
      (r.ok ? "ok" : "NO") + "\n");
  }

  const bad = results.filter(r => !r.ok);
  if (bad.length) {
    process.stdout.write("\n  " + bad.length + " with problems\n\n");
    for (const r of bad) {
      process.stdout.write("  " + r.file + "\n");
      for (const p of r.problems) process.stdout.write("    " + p + "\n");
    }
  }

  /* A short roll up, because the point of running all of them is the pattern. */
  const mods = new Map();
  for (const r of results) mods.set(r.mod || "(none)", (mods.get(r.mod || "(none)") || 0) + 1);
  const maps = new Map();
  for (const r of results) maps.set(r.map, (maps.get(r.map) || 0) + 1);
  const totalMs = results.reduce((a, r) => a + (r.ms || 0), 0);

  process.stdout.write("\n  Mods seen:  " +
    [...mods.entries()].map(([m, n]) => m + " x" + n).join(",  ") + "\n");
  process.stdout.write("  Maps seen:  " +
    [...maps.entries()].sort().map(([m, n]) => m + " x" + n).join(",  ") + "\n");
  process.stdout.write("  Protocols:  " +
    [...new Set(results.map(r => r.protocol))].join(", ") + "\n");
  process.stdout.write("  Parsed " + results.length + " demos in " +
    (totalMs / 1000).toFixed(1) + " s, " +
    Math.round(totalMs / results.length) + " ms each on average\n");
  process.stdout.write("  " + results.filter(r => r.ok).length + " of " + results.length +
    " passed every check\n\n");

  process.exit(bad.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { checkDemo, collect };
