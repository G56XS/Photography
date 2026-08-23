#!/usr/bin/env python3
"""
Run this any time images/ or music/ has changed. No image editing,
nothing turned into webp.

Photos -- looks at every .jpg/.jpeg/.png/.webp file directly inside
images/ (skips hero.jpg and about.jpg) and compares it against the WORK
array already baked into index.html:
    - on disk but not in the list  -> new photo, gets appended
      (numbering continues from the current highest n)
    - in the list but not on disk  -> was deleted, gets removed
Existing entries you didn't touch keep their original n, so this never
renumbers or reorders photos you didn't add or remove. The "Photos
shared" stat on the page reads WORK.length directly, so it always
matches -- nothing to update there.

Music -- looks at every audio file in music/. Anything not already
named "dreamscape-NN.ext" gets renamed to the next free number, then
the MUSIC_TRACKS array in index.html is rewritten to match whatever is
actually in the folder (add an mp3, it's added; delete one, it's
dropped). Just drop files in there with any name -- no need to
pre-rename them yourself.

Either kind of change gets committed to git, one commit per photo:
    new photo     -> git add images/<file>, index.html; commit -m "<file>"
    removed photo -> git rm images/<file>; commit -m "Remove <file>"
and one combined commit for any music changes, then a single `git push`
at the end.

If nothing changed, it just says so and exits -- safe to run as often
as you like.

Usage:
    python3 add_photo.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
IMAGES_DIR = ROOT / "images"
MUSIC_DIR = ROOT / "music"
INDEX_HTML = ROOT / "index.html"

VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}
SKIP_NAMES = {"hero.jpg", "about.jpg"}

ARRAY_RE = re.compile(r'(var WORK = \[\r\n)(.*?)(\r\n\r\n(\s*)\];)', re.S)
ENTRY_RE = re.compile(r'\{ file: "([^"]+)", n: (\d+) \}')

MUSIC_EXT = {".mp3", ".wav", ".ogg", ".m4a"}
MUSIC_ARRAY_RE = re.compile(r"(var MUSIC_TRACKS = \[\r\n)(.*?)(\r\n(\s*)\];)", re.S)
MUSIC_TRACK_RE = re.compile(r"'music/([^']+)'")
MUSIC_NAMED_RE = re.compile(r'^dreamscape-(\d{2,})(\.[^.]+)$', re.IGNORECASE)


def sync_music(html):
    """Rename any oddly-named files in music/ to dreamscape-NN.ext, then
    rewrite MUSIC_TRACKS in index.html to match what's actually there.
    Returns (possibly updated html, changed: bool)."""
    if not MUSIC_DIR.exists():
        return html, False

    files = [p for p in MUSIC_DIR.iterdir() if p.is_file() and p.suffix.lower() in MUSIC_EXT]

    taken = set()
    for p in files:
        m = MUSIC_NAMED_RE.match(p.name)
        if m:
            taken.add(int(m.group(1)))

    next_num = 1
    for p in sorted(files, key=lambda p: p.name.lower()):
        if MUSIC_NAMED_RE.match(p.name):
            continue
        while next_num in taken:
            next_num += 1
        new_name = f"dreamscape-{next_num:02d}{p.suffix.lower()}"
        taken.add(next_num)
        new_path = MUSIC_DIR / new_name
        p.rename(new_path)
        print(f"  renamed {p.name} -> {new_name}")

    final_files = sorted(
        (p.name for p in MUSIC_DIR.iterdir() if p.is_file() and p.suffix.lower() in MUSIC_EXT),
        key=str.lower,
    )

    m2 = MUSIC_ARRAY_RE.search(html)
    if not m2:
        print("  (couldn't find MUSIC_TRACKS array in index.html -- skipping playlist update)")
        return html, False

    current_tracks = MUSIC_TRACK_RE.findall(m2.group(2))
    if current_tracks == final_files:
        return html, False

    lines = [f"    'music/{f}'" for f in final_files]
    new_body = ",\r\n".join(lines)
    html = html[:m2.start()] + m2.group(1) + new_body + m2.group(3) + html[m2.end():]
    return html, True


def run_git(args, check=True):
    print("  $ git " + " ".join(args))
    try:
        result = subprocess.run(["git"] + args, cwd=ROOT)
    except FileNotFoundError:
        sys.exit("Couldn't find git. Install it from git-scm.com and make sure it's on your PATH.")
    if check and result.returncode != 0:
        sys.exit(f"\n'git {' '.join(args)}' failed -- stopping here so nothing gets half-committed.")
    return result


def commit_if_staged(message):
    """Commit only if something is actually staged -- e.g. a "removed"
    file that was never tracked by git in the first place would otherwise
    leave nothing to commit and make `git commit` fail for no real reason."""
    nothing_staged = subprocess.run(
        ["git", "diff", "--cached", "--quiet"], cwd=ROOT
    ).returncode == 0
    if nothing_staged:
        print(f"  (nothing to commit for \"{message}\", skipping)")
        return
    run_git(["commit", "-m", message])


def main():
    if not IMAGES_DIR.exists():
        sys.exit(f"Couldn't find {IMAGES_DIR} -- put this script next to your images/ folder.")
    if not INDEX_HTML.exists():
        sys.exit(f"Couldn't find {INDEX_HTML} -- this script expects to sit next to index.html.")

    with open(INDEX_HTML, "r", encoding="utf-8", newline="") as f:
        html = f.read()

    m = ARRAY_RE.search(html)
    if not m:
        sys.exit("Couldn't find the WORK array in index.html -- did the file format change?")

    entries = ENTRY_RE.findall(m.group(2))  # list of (file, n) in file order, as strings
    entries = [(f, int(n)) for f, n in entries]
    existing_files = {f for f, n in entries}
    next_n = (max(n for f, n in entries) + 1) if entries else 1

    disk_files = {
        p.name for p in IMAGES_DIR.iterdir()
        if p.is_file()
        and p.suffix.lower() in VALID_EXT
        and p.name not in SKIP_NAMES
    }

    new_files = sorted(disk_files - existing_files)
    removed_files = sorted(existing_files - disk_files)

    if removed_files:
        print("Removed from images/: " + ", ".join(removed_files))
    if new_files:
        print("New in images/: " + ", ".join(new_files))

    # --- rebuild the WORK array: drop removed, keep the rest as-is, append new ---
    kept = [(f, n) for f, n in entries if f not in removed_files]
    for f in new_files:
        kept.append((f, next_n))
        next_n += 1

    lines = [f'    {{ file: "{f}", n: {n} }}' for f, n in kept]
    new_body = ",\r\n".join(lines)
    html = html[:m.start()] + m.group(1) + new_body + m.group(3) + html[m.end():]

    print("Checking music/ ...")
    html, music_changed = sync_music(html)

    if not new_files and not removed_files and not music_changed:
        print("Nothing changed in images/ or music/ -- nothing to do.")
        return

    with open(INDEX_HTML, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    print("Updated index.html.")

    # --- commit: index.html rides along on the very first commit below ---
    run_git(["add", "index.html"])
    for f in removed_files:
        run_git(["rm", "--ignore-unmatch", str(Path("images") / f)])
        commit_if_staged(f"Remove {f}")
    for f in new_files:
        run_git(["add", str(Path("images") / f)])
        commit_if_staged(f)
    if music_changed:
        run_git(["add", "index.html"])
        run_git(["add", "-A", "--", "music"])
        commit_if_staged("Update background music")

    run_git(["push"])
    print("\nDone -- pushed.")


if __name__ == "__main__":
    main()
