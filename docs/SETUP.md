# Machine setup

What is on the coding PC, found rather than assumed. Phase 5 turns this into a
script; this file is the record so far.

## Found

| | |
|---|---|
| CoD4 install | `C:\Program Files (x86)\Activision\Call of Duty 4 - Modern Warfare` |
| Executables | `iw3mp.exe` (multiplayer, the one that plays demos), `iw3sp.exe` |
| CoD4X | Installed by Lodie. Required: every demo here is protocol 21. |
| ffmpeg | 8.1.2 full build on PATH, so GPU encoding is available for Phase 5 |
| Node | 24.13.0 |
| Python | 3.14.2 (`py` and `python` both work) |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe`, used by `tools/shot.js` |

## Running the inspector

No build step and no dependencies.

```
python -m http.server 8899
```

then open `http://127.0.0.1:8899/index.html`, or append
`?demo=demos/<file>.dm_1` to open one straight away. Dropping a demo on the
window works too, and nothing is uploaded: the file is read in the browser.

## The checks

```
node tests/run.js                              unit tests
node tools/verify.js <folder>                  every demo through the parser
node tools/cli.js <demo> --model bundle.json   write the model bundle
python tools/py/crosscheck.py bundle.json      JS against Python
node tools/shot.js <url> out.png               screenshot, fails on console errors
```

## Not done yet

The separate render folder for Phase 5 does not exist. It must be a copy of the
install, never the install itself, and the worker must refuse to launch pointed
at an online server. Nothing in this repo touches the game yet.
