/*!
 * run.js - the test runner. No dependencies, like the rest of the app.
 *
 *   node tests/run.js            run everything
 *   node tests/run.js highlight  run the suites whose name matches
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const path = require("path");
const fs = require("fs");

const suites = [];
let current = null;

function describe(name, fn){
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

function it(name, fn){
  if (!current) throw new Error("it() outside describe()");
  current.tests.push({ name, fn });
}

function fail(msg){
  const err = new Error(msg);
  err.assertion = true;
  throw err;
}

const show = v => {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(show).join(", ") + "]";
  return String(v);
};

const assert = {
  ok(v, msg){ if (!v) fail(msg || "expected a truthy value, got " + show(v)); },
  equal(a, b, msg){
    if (a !== b) fail((msg ? msg + ": " : "") + "expected " + show(b) + ", got " + show(a));
  },
  close(a, b, tol, msg){
    if (typeof a !== "number" || Math.abs(a - b) > tol)
      fail((msg ? msg + ": " : "") + "expected " + show(b) + " +/- " + tol + ", got " + show(a));
  },
  deep(a, b, msg){
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) fail((msg ? msg + ": " : "") + "expected " + sb + ", got " + sa);
  },
  includes(list, v, msg){
    if (list.indexOf(v) < 0)
      fail((msg ? msg + ": " : "") + show(v) + " not found in " + show(list));
  },
  throws(fn, msg){
    try { fn(); } catch (e) { return; }
    fail(msg || "expected a throw");
  }
};

/* ---- run ---- */

const filter = process.argv[2] || "";
const dir = __dirname;
for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith(".test.js")) continue;
  global.describe = describe; global.it = it; global.assert = assert;
  require(path.join(dir, f));
}

let passed = 0, failed = 0, skipped = 0;
const failures = [];

for (const s of suites) {
  if (filter && s.name.toLowerCase().indexOf(filter.toLowerCase()) < 0) {
    skipped += s.tests.length;
    continue;
  }
  process.stdout.write("\n  " + s.name + "\n");
  for (const t of s.tests) {
    try {
      t.fn();
      passed++;
      process.stdout.write("    ok   " + t.name + "\n");
    } catch (e) {
      failed++;
      failures.push({ suite: s.name, test: t.name, err: e });
      process.stdout.write("    FAIL " + t.name + "\n");
    }
  }
}

if (failures.length) {
  process.stdout.write("\n" + "-".repeat(60) + "\n");
  for (const f of failures) {
    process.stdout.write("\n" + f.suite + " > " + f.test + "\n  " + f.err.message + "\n");
    if (!f.err.assertion) process.stdout.write(String(f.err.stack).split("\n").slice(1, 4).join("\n") + "\n");
  }
}

process.stdout.write("\n" + passed + " passed, " + failed + " failed" +
                     (skipped ? ", " + skipped + " skipped" : "") + "\n");
process.exit(failed ? 1 : 0);
