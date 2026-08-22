# Photography

Just some photos that I took with my phone for fun.

- **Instagram:** [@Xovriet](https://instagram.com/Xovriet)
- **Email:** xovriet@gmail.com

## Adding photos (GitHub Pages)

A GitHub Action (`.github/workflows/build-gallery.yml`) does this for you automatically:

1. Drop any number of photos into `images/` — any filenames, no renaming.
2. Commit and push.
3. GitHub runs `build_manifest.py` on its own servers, generates `images/manifest.json` + webp thumbnails, and commits them back to the repo. Give it a minute, then refresh your Pages URL.

You never run anything locally or type a filename into any file. Check the "Actions" tab on your repo if you want to watch it run.

`hero.jpg` and `about.jpg` are the two feature photos (top banner + about-section portrait) — the script skips them, so just save your picks under those exact names.

### Running it locally instead (optional)

If you ever want to generate the manifest yourself instead of waiting on the Action — e.g. testing on your own computer before pushing — you can run `build_manifest.py` directly (needs `pip install pillow` once). Windows: double-click `build_manifest.bat`. Mac: double-click `build_manifest.command`.

## Background music

Drop a `music.mp3` file next to `index.html` and it'll play automatically when the site loads.

