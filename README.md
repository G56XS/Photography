# Photography

Just some photos that I took with my phone for fun.

- **Instagram:** [@Xovriet](https://instagram.com/Xovriet)
- **Email:** xovriet@gmail.com

## Adding photos

1. Drop any number of photos into `images/` — any filenames, no renaming.
2. Run `add_photo.py` (double-click `add_photo.bat` on Windows). It updates
   `index.html` with the new/removed files, commits, and pushes for you.
   It also syncs with GitHub first, so it won't get tangled up with commits
   made by the Action below.
3. A GitHub Action (`.github/workflows/build-gallery.yml`) then runs on
   GitHub's servers, generates `images/manifest.json` and webp thumbnails,
   and commits them back to the repo automatically. Give it a minute, then
   refresh your Pages URL. Check the "Actions" tab on your repo if you want
   to watch it run.

`hero.jpg` and `about.jpg` are the two feature photos (top banner + about-section
portrait) — the script skips them, so just save your picks under those exact names.

## Background music

Drop mp3 files into a `music/` folder next to `index.html`, then run
`add_photo.py` — it renames them to `dreamscape-01.mp3`, `dreamscape-02.mp3`,
etc. and lists them in `index.html`. The site shuffles through the playlist
endlessly; there's no mute or pause control anywhere in the UI on purpose.
