BACKGROUND MUSIC
================

Drop mp3 files in here and the site will shuffle through them forever as
background music once a visitor lands on the page. There's no mute/pause
button anywhere on purpose -- it just plays.

I can't pull the actual audio from a YouTube video for you (that's
copyrighted, and I don't have a way to legally rip it), but any set of
ambient / "dreamscape" / lo-fi instrumental tracks will get the same
effect. A few places to find royalty-free ones:

  - YouTube Audio Library (studio.youtube.com > Audio Library) --
    filter by genre "Ambient" or "Cinematic", mood "Calm"/"Dreamy"
  - Pixabay Music (pixabay.com/music) -- search "dreamscape" or "ambient"
  - Free Music Archive (freemusicarchive.org)

By default index.html expects these four filenames:

    music/dreamscape-01.mp3
    music/dreamscape-02.mp3
    music/dreamscape-03.mp3
    music/dreamscape-04.mp3

You don't need exactly four -- add, remove, or rename as many as you
want, just update the MUSIC_TRACKS array near the bottom of index.html
(search for "background music") to match whatever files are actually in
this folder.
