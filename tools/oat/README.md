# OpenAssetTools patch

`tools/ffbatch.js` and `tools/ffworld.js` build the 3D maps straight from the
game's fastfiles. OpenAssetTools already loads a map's compiled render world
(`GfxWorld`) but ships no writer for it on IW3, so this patch adds two things
to [OpenAssetTools](https://github.com/Laupetin/OpenAssetTools) v0.33.0:

1. **A GfxWorld dumper for IW3** (`src/ObjWriting/Game/IW3/GfxWorld/`). It
   writes `<map>.world.bin` (the raw vertex and index arrays) and
   `<map>.world.json` (surfaces, materials with their colour maps and lit pass
   state bits, static model placements, lightmaps, the sun).
2. **A JSON copy of every XAnim** next to the compiled one
   (`xanim_json/<name>.json`), with the reconstructed bone tracks in their
   quantised form, for the animated player models.

Both are plain additions: nothing existing changes behaviour.

## Build (Windows)

Needs Git and Visual Studio 2022 Build Tools with the C++ workload.

```
git clone --recursive --branch v0.33.0 https://github.com/Laupetin/OpenAssetTools.git oat-src
cd oat-src
git apply <path to this repo>/tools/oat/openassettools-v0.33.0.patch
generate.bat                                  (or: build\premake5.exe vs2022)
msbuild build\OpenAssetTools.sln /t:Tools\UnlinkerCli /p:Configuration=Release /p:Platform=Win32
```

The Unlinker lands in `build\bin\Release_x86\Unlinker.exe`. Point
`OAT_UNLINKER` at it and run `node tools/ffbatch.js`.

OpenAssetTools is GPL-3.0, like this project.
