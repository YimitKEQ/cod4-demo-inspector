#!/usr/bin/env python3
"""crosscheck.py - the JS and Python highlight engines must agree.

The parser already has two independent implementations that are checked field
for field. The highlight engine joins that discipline: this reads a model
bundle, which carries both the match and the answer the JS engine produced
from it, recomputes the highlights in Python, and diffs the two field by
field. Any disagreement is a bug in one of them.

  node tools/cli.js demo.dm_1 --model bundle.json --quiet
  python tools/py/crosscheck.py bundle.json

Or, with no demo at hand, against the sample match:

  node tools/cli.js --sample --model bundle.json --quiet
  python tools/py/crosscheck.py bundle.json

Exits non zero on any disagreement, so it can be a gate.

Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
see LICENSE. No warranty of any kind.
"""

import argparse
import json
import sys
from typing import Any, Dict, List

import highlights as PY

# Fields compared on every highlight. Floats are compared with a tolerance
# because the two languages round the last digit differently; anything larger
# than this is a real disagreement.
FLOAT_FIELDS = ("startS", "endS", "focusS")
EXACT_FIELDS = ("kind", "score", "round", "roundIdx", "primary", "title",
                "detail", "approx")
LIST_FIELDS = ("tags", "killIds", "players")

TOLERANCE = 0.011


def compare(js: List[Dict[str, Any]], py: List[Dict[str, Any]]) -> List[str]:
    problems: List[str] = []

    if len(js) != len(py):
        problems.append("count: JS found %d highlights, Python found %d" % (len(js), len(py)))

    # Match on identity rather than list order, so a pure ordering difference
    # is reported as exactly that instead of drowning every row in noise.
    def key(h: Dict[str, Any]) -> tuple:
        return (h["kind"], h["roundIdx"], h["primary"], tuple(sorted(h["killIds"])))

    js_by = {}
    for h in js:
        js_by.setdefault(key(h), []).append(h)
    py_by = {}
    for h in py:
        py_by.setdefault(key(h), []).append(h)

    for k in sorted(set(js_by) | set(py_by), key=str):
        a, b = js_by.get(k, []), py_by.get(k, [])
        if len(a) != len(b):
            problems.append("only in %s: %s x%d vs x%d" % (
                "JS" if len(a) > len(b) else "Python", k, len(a), len(b)))
            continue
        for ha, hb in zip(a, b):
            for f in EXACT_FIELDS:
                if ha.get(f) != hb.get(f):
                    problems.append("%s.%s: JS %r vs Python %r" % (k[0], f, ha.get(f), hb.get(f)))
            for f in FLOAT_FIELDS:
                va, vb = ha.get(f), hb.get(f)
                if va is None or vb is None:
                    if va != vb:
                        problems.append("%s.%s: JS %r vs Python %r" % (k[0], f, va, vb))
                elif abs(va - vb) > TOLERANCE:
                    problems.append("%s.%s: JS %r vs Python %r" % (k[0], f, va, vb))
            for f in LIST_FIELDS:
                if list(ha.get(f) or []) != list(hb.get(f) or []):
                    problems.append("%s.%s: JS %r vs Python %r" % (
                        k[0], f, ha.get(f), hb.get(f)))

    # Order matters too: the top of the list is what gets rendered.
    order_js = [h["id"] for h in js]
    order_py = [h["id"] for h in py]
    if order_js != order_py and not problems:
        problems.append("ordering differs: JS %s vs Python %s" % (order_js[:6], order_py[:6]))

    return problems


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="Diff the JS and Python highlight engines.")
    ap.add_argument("bundle", help="model bundle written by tools/cli.js --model")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    with open(args.bundle, "r", encoding="utf-8") as fh:
        bundle = json.load(fh)

    js = bundle.get("jsHighlights")
    if js is None:
        print("This bundle carries no JS highlights. Write it with a current "
              "tools/cli.js --model.", file=sys.stderr)
        return 2

    found = PY.detect(bundle)
    py = found["highlights"]

    problems = compare(js, py)

    js_floor = bundle.get("bombFloorS")
    if js_floor != found["bombFloorS"]:
        problems.append("bombFloorS: JS %r vs Python %r" % (js_floor, found["bombFloorS"]))

    if problems:
        print("Cross check FAILED, %d disagreement%s:" % (
            len(problems), "" if len(problems) == 1 else "s"))
        for p in problems[:40]:
            print("  " + p)
        if len(problems) > 40:
            print("  ... and %d more" % (len(problems) - 40))
        return 1

    if not args.quiet:
        print("Cross check passed: %d highlights identical in both engines "
              "(bomb floor %s s)." % (len(js), found["bombFloorS"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
