#!/usr/bin/env node
/*!
 * shot.js - drive a real Chrome and take a screenshot once the page says it
 * is ready, reporting anything the console complained about.
 *
 * Chrome's --screenshot flag needs --virtual-time-budget to wait for async
 * work, and virtual time races ahead while the parser yields: it advances the
 * clock on every yield, exhausts the budget and aborts requests that are still
 * in flight. That made the map image look like it had failed to load when it
 * had simply been cancelled. This drives the browser over the DevTools
 * protocol instead, on real time, so what is captured is what a person sees.
 *
 *   node tools/shot.js <url> <out.png> [--wait 20000] [--size 1680,950]
 *
 * Exits non zero if the page logged an error, so a broken screen fails loudly
 * instead of producing a nice picture of a broken screen.
 *
 * No dependencies: Node's built in WebSocket speaks to Chrome directly.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
];

function findChrome(){
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("No Chrome or Edge found. Set CHROME to the executable path.");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll the debugger endpoint until Chrome is listening. */
async function waitForEndpoint(port, timeoutMs){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch("http://127.0.0.1:" + port + "/json/version");
      if (resp.ok) return (await resp.json()).webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  throw new Error("Chrome did not open a debugging port within " + timeoutMs + " ms");
}

/** Minimal DevTools protocol client over Node's built in WebSocket. */
function connect(url){
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", e => reject(new Error("debugger socket failed")));
  });

  ws.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg.method, msg.params);
    }
  });

  return {
    ready,
    send(method, params, sessionId){
      const id = nextId++;
      const payload = { id, method, params: params || {} };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(fn){ listeners.push(fn); },
    close(){ try { ws.close(); } catch (e) { /* already gone */ } }
  };
}

function parseArgs(argv){
  const out = { url: null, out: null, waitMs: 25000, width: 1680, height: 950, settleMs: 700, evals: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wait") out.waitMs = parseInt(argv[++i], 10) || out.waitMs;
    else if (a === "--settle") out.settleMs = parseInt(argv[++i], 10) || out.settleMs;
    else if (a === "--eval") out.evals.push(argv[++i]);
    else if (a === "--size") {
      const [w, h] = String(argv[++i]).split(",").map(Number);
      if (w) out.width = w;
      if (h) out.height = h;
    } else rest.push(a);
  }
  out.url = rest[0];
  out.out = rest[1];
  return out;
}

async function main(){
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.out) {
    process.stdout.write("  node tools/shot.js <url> <out.png> [--wait ms] [--size w,h]\n");
    process.exit(1);
  }

  const chrome = process.env.CHROME || findChrome();
  const port = 9222 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dm1-shot-"));

  const proc = spawn(chrome, [
    "--headless=new",
    /* Software WebGL: headless has no GPU, and without this the 3D view gets
       a null context and renders nothing at all. */
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--hide-scrollbars",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "--window-size=" + args.width + "," + args.height,
    "about:blank"
  ], { stdio: "ignore" });

  const problems = [];
  let client = null;
  try {
    const wsUrl = await waitForEndpoint(port, 15000);
    client = connect(wsUrl);
    await client.ready;

    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });

    client.on((method, params) => {
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        problems.push("console.error: " +
          params.args.map(a => a.description || a.value || a.type).join(" "));
      } else if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails;
        problems.push("uncaught: " + (d.exception && d.exception.description
          ? d.exception.description.split("\n")[0] : d.text));
      }
    });

    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.enable", {}, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false
    }, sessionId);

    await client.send("Page.navigate", { url: args.url }, sessionId);

    /* Wait for the app to be ready rather than for a fixed time. The page is
       ready when a match is loaded and the drop screen is gone; a page with no
       demo to load is ready as soon as it has painted. */
    const deadline = Date.now() + args.waitMs;
    let ready = false;
    while (Date.now() < deadline) {
      const r = await client.send("Runtime.evaluate", {
        expression: "(() => { try {" +
          "  const s = window.APP_STATE;" +
          "  const drop = document.getElementById('drop');" +
          "  const wants = location.search.includes('demo=') || location.search.includes('sample');" +
          "  if (!wants) return document.readyState === 'complete';" +
          "  return !!(s && s.model) && drop && drop.classList.contains('hidden');" +
          "} catch (e) { return false; } })()",
        returnByValue: true
      }, sessionId);
      if (r.result && r.result.value === true) { ready = true; break; }
      await sleep(200);
    }
    if (!ready) problems.push("the page never reported a loaded match within " +
                              args.waitMs + " ms");

    /* Let late arrivals (the map image) finish painting. */
    await sleep(args.settleMs);

    /* Anything the caller wants done or read before the capture: move a
       camera, pick a player, read a value. Results are printed, so a probe
       and a screenshot are one command. Each runs after the previous one had
       a second to render. */
    for (const expr of args.evals) {
      const r = await client.send("Runtime.evaluate", {
        expression: expr, returnByValue: true, awaitPromise: true
      }, sessionId);
      const v = r.exceptionDetails ? "threw: " + r.exceptionDetails.text
        : JSON.stringify(r.result && r.result.value);
      process.stdout.write("  eval: " + (v || "undefined") + "\n");
      await sleep(1000);
    }

    const shot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fs.writeFileSync(args.out, Buffer.from(shot.data, "base64"));

    /* Report what the app itself says it is drawing, which is the difference
       between a real asset failure and a harness artefact. */
    const info = await client.send("Runtime.evaluate", {
      expression: "(() => { const s = window.APP_STATE; return s && s.model ? JSON.stringify({" +
        "map: s.model.info.map, backdrop: s.backdrop, kills: s.model.kills.length," +
        "rounds: s.model.rounds.length, moments: s.highlights ? s.highlights.merged.length : 0" +
        "}) : 'no match'; })()",
      returnByValue: true
    }, sessionId);
    process.stdout.write(args.out + "  " + (info.result ? info.result.value : "") + "\n");
  } finally {
    if (client) client.close();
    proc.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* locked */ }
  }

  if (problems.length) {
    for (const p of problems) process.stderr.write("  " + p + "\n");
    process.exit(1);
  }
}

main().catch(e => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + "\n");
  process.exit(2);
});
