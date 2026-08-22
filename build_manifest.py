#!/usr/bin/env python3
"""
Run this any time you add or remove photos from the images/ folder.

What it does:
  1. Looks at every .jpg / .jpeg / .png / .webp file directly inside images/
     (skips hero.jpg, about.jpg, the thumbs/ folder, and manifest.json itself).
  2. Reads each photo's real width & height, so the site always shows it at
     its correct aspect ratio -- nothing gets cropped or squished.
  3. Saves a compressed .webp copy of each new/changed photo into
     images/thumbs/ for the gallery grid. Photos that already have an
     up-to-date thumbnail are skipped, so re-running this after adding just
     a few photos is fast -- it doesn't redo the whole folder.
  4. If you deleted a photo from images/, its entry disappears from the
     manifest and its leftover thumbnail is deleted automatically.
  5. Writes images/manifest.json, which is the file the website reads to
     build the gallery. You never edit HTML or type filenames -- just drop
     photos into images/ and run this script again.
  6. If this folder is a git repo, commits and pushes the changes for you
     (git add -A && git commit && git push). Skips this step quietly if
     there's nothing new to push, or if it's not a git repo at all.

Usage:
    python3 build_manifest.py

Requires Pillow:
    pip install pillow
"""
import json
import subprocess
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


def load_old_manifest():
    if not MANIFEST.exists():
        return []
    try:
        return json.loads(MANIFEST.read_text())
    except Exception:
        return []


def build_manifest():
    THUMBS_DIR.mkdir(exist_ok=True)

    files = sorted(
        p for p in IMAGES_DIR.iterdir()
        if p.is_file()
        and p.suffix.lower() in VALID_EXT
        and p.name not in SKIP_NAMES
    )

    old_files = {e["file"] for e in load_old_manifest()}

    manifest = []
    kept_thumbs = set()
    built, skipped, failed = 0, 0, 0

    for path in files:
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)  # respect phone camera rotation
                w, h = im.size

            thumb_name = path.stem + ".webp"
            thumb_path = THUMBS_DIR / thumb_name

            # Skip regenerating the thumbnail if it already exists and is
            # newer than the source photo -- this is what makes re-runs
            # fast once most of your photos already have thumbnails.
            up_to_date = thumb_path.exists() and thumb_path.stat().st_mtime >= path.stat().st_mtime

            if not up_to_date:
                with Image.open(path) as im2:
                    im2 = ImageOps.exif_transpose(im2)
                    thumb_im = im2.convert("RGB") if im2.mode not in ("RGB", "RGBA") else im2
                    thumb_im.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.LANCZOS)
                    thumb_im.save(thumb_path, "WEBP", quality=THUMB_QUALITY, method=6)
                built += 1
                print(f"  ✓ {path.name}  ({w}x{h})")
            else:
                skipped += 1

            kept_thumbs.add(thumb_name)
            manifest.append({
                "file": path.name,                # full-quality original, used in the lightbox
                "thumb": "thumbs/" + thumb_name,   # compressed webp, used in the grid
                "w": w,
                "h": h,
            })
        except Exception as e:
            failed += 1
            print(f"  ✗ skipped {path.name}: {e}")

    # clean up thumbnails for photos that were removed from images/
    removed = 0
    for old in THUMBS_DIR.glob("*.webp"):
        if old.name not in kept_thumbs:
            old.unlink()
            removed += 1
            print(f"  – removed {old.name} (photo no longer in images/)")

    MANIFEST.write_text(json.dumps(manifest, indent=2))

    new_files = {e["file"] for e in manifest}
    added = sorted(new_files - old_files)
    deleted = sorted(old_files - new_files)

    print(f"\n{len(manifest)} photos in manifest.json  "
          f"({built} new, {skipped} unchanged, {removed} thumb(s) cleaned up"
          + (f", {failed} failed" if failed else "") + ")")

    return added, deleted


def run_git(*args):
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True
    )


def git_sync(added, deleted):
    if not (ROOT / ".git").exists():
        print("(Not a git repo here, so skipping git push -- run this inside your cloned repo folder to enable that.)")
        return

    run_git("add", "-A")

    # nothing staged? nothing to do.
    if run_git("diff", "--cached", "--quiet").returncode == 0:
        print("Nothing new to push.")
        return

    parts = []
    if added:
        parts.append(f"+{len(added)} photo{'s' if len(added) != 1 else ''}")
    if deleted:
        parts.append(f"-{len(deleted)} photo{'s' if len(deleted) != 1 else ''}")
    message = "Update gallery: " + ", ".join(parts) if parts else "Update gallery"

    commit = run_git("commit", "-m", message)
    if commit.returncode != 0:
        print("git commit failed:\n" + (commit.stderr or commit.stdout))
        return
    print(f"Committed: {message}")

    push = run_git("push")
    if push.returncode != 0:
        print("git push failed (commit was made locally, you can push manually):\n" + (push.stderr or push.stdout))
        return
    print("Pushed to GitHub.")


def main():
    if not IMAGES_DIR.exists():
        sys.exit(f"Couldn't find {IMAGES_DIR} -- put this script next to your images/ folder.")

    files_present = any(
        p.suffix.lower() in VALID_EXT and p.name not in SKIP_NAMES
        for p in IMAGES_DIR.iterdir() if p.is_file()
    )
    if not files_present:
        sys.exit("No photos found in images/ (besides hero.jpg / about.jpg). Add some and re-run.")

    added, deleted = build_manifest()
    git_sync(added, deleted)


if __name__ == "__main__":
    main()