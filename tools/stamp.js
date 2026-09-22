#!/usr/bin/env node
/*!
 * stamp.js - make the browser fetch the build it was sent, not the last one.
 *
 * GitHub Pages serves everything with a ten minute cache and no fingerprint in
 * the filename, so for ten minutes after a deploy a returning visitor keeps
 * the previous scripts. A fix that shipped correctly then looks like it did
 * nothing at all, and worse, a page can end up holding a mix of old and new
 * files that never existed together and was never tested.
 *
 * This rewrites the references in index.html to carry a short hash of the
 * contents they point at. Change a file and its URL changes with it; change
 * nothing and the URL is stable, so the cache still does its job.
 *
 *   node tools/stamp.js [index.html]
 *
 * Meant to run in CI against the copy being uploaded. It is safe to run on a
 * working tree too: running it twice in a row is a no op.
 *
 * Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
 * see LICENSE. No warranty of any kind.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** Eight hex characters of the file's contents, or null if it is not there. */
function hashOf(file){
  if (!fs.existsSync(file)) return null;
  return crypto.createHash("sha1").update(fs.readFileSync(file))
    .digest("hex").slice(0, 8);
}

/**
 * Add or refresh a ?v= stamp on every local script and stylesheet.
 *
 * Absolute URLs are left alone: they are somebody else's cache to manage.
 */
function stamp(htmlFile){
  const dir = path.dirname(htmlFile);
  let html = fs.readFileSync(htmlFile, "utf8");
  let changed = 0, missing = [];

  html = html.replace(
    /(<(?:script|link)\b[^>]*?(?:src|href)=")([^"?]+)(?:\?v=[0-9a-f]+)?(")/g,
    (all, head, url, tail) => {
      if (/^(https?:)?\/\//.test(url) || url.startsWith("data:")) return all;
      if (!/\.(js|css)$/i.test(url)) return all;
      const h = hashOf(path.join(dir, url));
      if (!h) { missing.push(url); return all; }
      changed++;
      return head + url + "?v=" + h + tail;
    });

  /* One id for the whole bundle, shown in the app, so "which build am I
     looking at" is answerable from a screenshot instead of a guess. */
  const build = crypto.createHash("sha1").update(html).digest("hex").slice(0, 7);
  const meta = '<meta name="dm1-build" content="' + build + '">';
  html = /<meta name="dm1-build"/.test(html)
    ? html.replace(/<meta name="dm1-build" content="[^"]*">/, meta)
    : html.replace("</title>", ["</title>", meta].join("\n"));

  fs.writeFileSync(htmlFile, html);
  return { changed, missing, build };
}

function main(){
  const file = process.argv[2] || "index.html";
  if (!fs.existsSync(file)) {
    process.stderr.write("No such file: " + file + "\n");
    process.exit(1);
  }
  const r = stamp(file);
  process.stdout.write("  stamped " + r.changed + " references in " + file + "\n");
  if (r.missing.length) {
    /* A reference to a file that is not there is a broken page, not a cache
       problem, and it should stop the deploy rather than ship. */
    process.stderr.write("  referenced but missing: " + r.missing.join(", ") + "\n");
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { stamp, hashOf };
