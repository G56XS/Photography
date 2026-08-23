#!/usr/bin/env python3
"""
Run this any time you add or remove photos from the images/ folder.

What it does:
  1. Looks at every .jpg / .jpeg / .png / .webp file directly inside images/
     (skips hero.jpg, about.jpg, the thumbs/ folder, and manifest.json itself).
  2. Reads each photo's real width & height, so the site always shows it at
     its correct aspect ratio -- nothing gets cropped or squished.
  3. Saves a compressed .webp copy of each photo into images/thumbs/ for the
     gallery grid (small + fast). The original file is left completely
     untouched and is what opens full quality when you click a photo.
  4. Writes images/manifest.json, which is the file the website actually
     reads to build the gallery. You never edit HTML or type filenames --
     just drop photos into images/ and run this script again.

Usage:
    python3 build_manifest.py

Requires Pillow:
    pip install pillow
"""
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is required. Install it with:  pip install pillow")

ROOT = Path(__file__).parent
IMAGES_DIR = ROOT / "images"
THUMBS_DIR = IMAGES_DIR / "thumbs"
MANIFEST = IMAGES_DIR / "manifest.json"

VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}
SKIP_NAMES = {"hero.jpg", "about.jpg"}
THUMB_MAX_EDGE = 1600   # long-edge size for grid thumbnails
THUMB_QUALITY = 78


def main():
    if not IMAGES_DIR.exists():
        sys.exit(f"Couldn't find {IMAGES_DIR} -- put this script next to your images/ folder.")

    THUMBS_DIR.mkdir(exist_ok=True)

    files = sorted(
        p for p in IMAGES_DIR.iterdir()
        if p.is_file()
        and p.suffix.lower() in VALID_EXT
        and p.name not in SKIP_NAMES
    )

    if not files:
        sys.exit("No photos found in images/ (besides hero.jpg / about.jpg). Add some and re-run.")

    manifest = []
    kept_thumbs = set()

    for path in files:
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)  # respect phone camera rotation
                w, h = im.size

                thumb_name = path.stem + ".webp"
                thumb_path = THUMBS_DIR / thumb_name

                thumb_im = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
                thumb_im.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.LANCZOS)
                thumb_im.save(thumb_path, "WEBP", quality=THUMB_QUALITY, method=6)
                kept_thumbs.add(thumb_name)

            manifest.append({
                "file": path.name,                       # full-quality original, used in the lightbox
                "thumb": "thumbs/" + thumb_name,          # compressed webp, used in the grid
                "w": w,
                "h": h,
            })
            print(f"  ✓ {path.name}  ({w}x{h})")
        except Exception as e:
            print(f"  ✗ skipped {path.name}: {e}")

    # clean up orphaned thumbnails from deleted photos
    for old in THUMBS_DIR.glob("*.webp"):
        if old.name not in kept_thumbs:
            old.unlink()
            print(f"  – removed stale thumb {old.name}")

    MANIFEST.write_text(json.dumps(manifest, indent=2))
    print(f"\nDone. {len(manifest)} photos in manifest.json.")


if __name__ == "__main__":
    main()
