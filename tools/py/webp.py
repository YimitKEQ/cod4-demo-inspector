"""webp.py - re-encode a folder of PNG textures as WebP, in place.

    python tools/py/webp.py <dir> [--quality 82]

PNG is lossless, which for a photographic wall texture decoded from DXT means
paying for detail that was never there: a map's 128 colour maps came to 21 MB.
WebP at quality 82 looks the same at the size these are drawn and is a fraction
of the bytes, and it keeps the alpha channel that foliage and fences cut out
with. Alpha is stored lossless so cutout edges do not crawl.

Every JSON manifest in the folder, or one level up, that names a .png is rewritten to the .webp,
and the PNG is removed only after its WebP has been written.

Part of the CoD4 Demo Inspector. Free software under the GPL-3.0,
see LICENSE. No warranty of any kind.
"""
import json
import os
import sys

from PIL import Image


def convert(folder, quality):
    renamed = {}
    before = after = 0
    for name in sorted(os.listdir(folder)):
        if not name.lower().endswith(".png"):
            continue
        src = os.path.join(folder, name)
        dst = src[:-4] + ".webp"
        with Image.open(src) as im:
            has_alpha = im.mode in ("RGBA", "LA") and im.getextrema()[-1][0] < 255
            im = im.convert("RGBA" if has_alpha else "RGB")
            im.save(dst, "WEBP", quality=quality, method=4, alpha_quality=100)
        before += os.path.getsize(src)
        after += os.path.getsize(dst)
        os.remove(src)
        renamed[name] = name[:-4] + ".webp"

    # Manifests beside the textures and one level up (geometry.json names the
    # lightmaps as textures/<file>).
    parent = os.path.dirname(os.path.abspath(folder))
    manifests = [os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".json")]
    manifests += [os.path.join(parent, n) for n in os.listdir(parent) if n.endswith(".json")]
    for path in manifests:
        with open(path, encoding="utf8") as f:
            text = f.read()
        for old, new in renamed.items():
            text = text.replace('"' + old + '"', '"' + new + '"').replace("/" + old + '"', "/" + new + '"')
        with open(path, "w", encoding="utf8") as f:
            f.write(text)
    return len(renamed), before, after


def main():
    args = sys.argv[1:]
    if not args:
        print("  python tools/py/webp.py <dir> [--quality 82]")
        sys.exit(1)
    quality = 82
    if "--quality" in args:
        i = args.index("--quality")
        quality = int(args[i + 1])
        del args[i:i + 2]
    count, before, after = convert(args[0], quality)
    mb = lambda b: "%.1f MB" % (b / 1048576.0)
    print("  %d textures: %s -> %s" % (count, mb(before), mb(after)))


if __name__ == "__main__":
    main()
