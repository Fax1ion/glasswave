GLASSWAVE
A glass-style player for your own Spotify account.


START IT
  Best: double-click "Install Glasswave" once. It makes Glasswave.exe
  and adds Glasswave to the Start menu. From then on, press the Windows
  key and type "Glasswave" to open it. In the Start menu you can
  right-click it to pin it to Start or the taskbar.

  Other ways: "Start Glasswave (own window)" opens the same window, and
  "Start Glasswave" opens the player in your browser instead.
  Optional: "Add desktop shortcut" puts a Glasswave icon on the desktop.


GLASSWAVE.EXE
  - It is built on this computer by "Install Glasswave", with the C#
    compiler that is part of Windows. Nothing is downloaded.
  - It should open faster than the older PowerShell way, because the
    window and its little file helper run inside one program, and
    nothing is rebuilt unless it changed.
  - It keeps itself up to date: when Glasswave's files change, it
    rebuilds what changed the next time it opens (a short "Updating
    Glasswave..." card shows while it does).
  - It uses the same sign-in, pins and window size as before.
  - If it ever stops working, run "Install Glasswave" again. The other
    ways to start Glasswave keep working regardless.
  - To remove it from the Start menu: open the Start menu, right-click
    Glasswave, choose "Open file location", and delete the shortcut.


FIRST-TIME SETUP (about 5 minutes)
  1. Go to https://developer.spotify.com/dashboard and open your app
     (the one you made for Spotifast is fine), then click Settings.
  2. Under "Redirect URIs" add exactly this, then click Add:

         http://127.0.0.1:8765/callback

  3. Under "APIs used", tick "Web API" and "Web Playback SDK".
     Click Save at the bottom.
  4. Copy the Client ID from that page, paste it into Glasswave and
     click "Sign in with Spotify". Use the same Spotify account that
     owns the developer app.

  Want to look around first? Click "Look around with demo music first"
  on the sign-in screen. Nothing plays in demo mode.


YOUR LIBRARY (the list on the left)
  - Playlists / Albums / Artists / Podcasts buttons show just that kind.
    Click the same button again to see everything.
  - The sort button (three lines) offers Recents, A to Z, Creator and
    Spotify order.
  - Right-click anything > "Pin". Pinned items stay first. Drag them
    up and down to put them in any order, or drag any other item onto
    a pinned one to pin it right there. Spotify does not tell
    outside apps which items you pinned there, so pins are set here.


GLASSWAVE'S OWN WINDOW (no browser buttons)
  Double-click "Start Glasswave (own window)". Glasswave opens in a
  window of its own, built on the web engine that is part of Windows
  (WebView2): no browser buttons, and the glass runs to the top edge
  with Glasswave's own minimise / maximise / close buttons.
  - It keeps its own sign-in, so paste your Client ID and sign in to
    Spotify once more the first time.
  - It uses more memory than a window of a browser you already have
    open, because it runs its own copy of the engine.
  - The window has no border. Drag any edge or corner to resize it,
    and drag the strip at the top to move it. Its size and place are
    remembered for next time (the mini player's too).
  - Desktop-wide shortcuts (see SETTINGS AND SHORTCUTS) work here.
  - Mini player: the small-window button (in the player bar and in the
    big now-playing view) shrinks Glasswave to a small card that stays
    on top of your other windows, with the song, the controls and the
    line being sung. Drag it anywhere, resize it by its edges. Its
    buttons go back to the full window or to full screen.
  - If it cannot start, a message says why and the details are saved in
    launcher\standalone.log. "Start Glasswave" keeps working either way.


LYRICS AND THE BIG NOW-PLAYING VIEW
  - Click the microphone in the player bar (or press L, or click the
    cover) for the big view: the cover, the controls, and the lyrics
    moving in time with the song. Click a line to jump to it.
  - The full-screen button (or F) fills the whole screen. Esc goes back.
  - When a song has no lyrics, the view shows its cover on its own.
  - Lyrics come from lrclib.net, a free public lyrics site. Glasswave
    sends it only the song's title, artist, album and length. Spotify's
    own lyrics stay inside Spotify's apps, so some songs will have no
    lyrics here, or untimed ones.


SETTINGS AND SHORTCUTS
  - Click your name at the bottom left to open the Settings page.
  - Shortcuts: choose key combos for previous song, play/pause, next
    song and full screen. Click a box, then press the keys together
    (for example Ctrl + Alt + Right). Esc cancels; the X clears one.
  - Full screen: choose which screen Glasswave fills when it goes full
    screen ("Show screen numbers" puts a big number on each screen).
    The full screen button, the F key and the shortcut all use it.
    From the shortcut, your game or app keeps the keyboard and mouse,
    and pressing it again puts Glasswave back where it was (minimised
    too, if it was).
  - In the Glasswave app (Glasswave.exe or "Start Glasswave (own
    window)") they work wherever you are: in a game, in another app,
    or with Glasswave minimised, as long as Glasswave is open. In a
    browser tab they only work while Glasswave is in front.
  - A combo needs Ctrl or Alt (or the Windows key), so normal typing
    still works everywhere. F1 to F24, the media keys, Pause and Scroll
    Lock can be used on their own.
  - If another program already uses a combo, Settings says so; pick a
    different one.


VISUALIZER
  - The bars button in the player bar (or V) opens the visualizer: a
    ring of bars around the cover that moves with the music. While it
    is open it is all there is of Glasswave; exit it (the X, V or Esc)
    to get the player back. F makes it full screen.
  - For music files from this computer it follows the sound itself.
  - For Spotify songs it works in Glasswave's own window: while the
    visualizer is open, the window listens to whatever this computer's
    speakers are playing and turns it into bar heights. Nothing is
    recorded or kept. Other sounds on the computer move the bars too.
  - It only hears this computer: a song playing on another Spotify
    device, or a Spotify song in a browser window, just drifts.


LOCAL FILES (music files on this computer)
  - "Local Files" in the left column lists the music in your Music
    folder (MP3, M4A, AAC, FLAC, WAV, OGG) and plays it right here.
    Titles, artists and covers are read from inside the files.
  - To add other folders, open "Local folders.txt" in this folder,
    write one folder per line, save, then press Rescan on the Local
    Files page.
  - Songs that Spotify shows as local files inside your playlists play
    from this computer when the same song is in those folders. Others
    stay greyed out.
  - Local files play from this computer only. They cannot be sent to
    another Spotify device, liked, or mixed into Spotify's queue.
  - Local Files need the little helper to be running. It always is in
    Glasswave's own window. In a browser window it rests after ten
    quiet minutes; start Glasswave again to wake it.


MAKE THE BROWSER WINDOW'S TOP BAR MATCH (optional, one time)
  Browsers only let installed apps colour the bar at the very top of
  the window. In Glasswave click your name (bottom left) to open
  Settings, click "Install as an app" and follow the three steps. After that, open Glasswave from
  its new icon or from "Start Glasswave" and the top bar follows the
  colours of the page you are on. Click the small arrow in that bar to
  let the glass run right up to the top edge.


COLOURS AND RECOMMENDATIONS
  - The colours follow the page you are on: a playlist, album, artist
    or podcast uses its own artwork, and each tab has its own colours.
    Opening the big now-playing view switches to the song's colours.
  - "Recommended for you" on Home and "Recommended" under your own
    playlists are picked by Glasswave from the genres and artists you
    play (Spotify does not share its own recommendations with outside
    apps). Press Refresh for a new set.
  - Smart Shuffle: press the shuffle button once for shuffle, twice
    for Smart Shuffle (the button gets a small sparkle), and a third
    time to turn shuffle off. With Smart Shuffle on, Glasswave adds a
    song that fits what you are playing after every three songs,
    picked the same way as "Recommended for you". Those songs have a
    sparkle next to their name. Turning it off skips any pick still
    waiting in the queue. This is Glasswave's own Smart Shuffle:
    Spotify does not let outside apps turn on Spotify's. If you turn on
    Spotify's in a Spotify app, Glasswave shows it, but only a Spotify
    app can turn it off. Music files from this computer and podcasts
    have plain shuffle only.


GOOD TO KNOW
  - Playing music needs Spotify Premium.
  - Chrome, Edge and Brave open Glasswave as its own window. Other
    browsers open it as a normal tab.
  - Spotify signs outside apps out every 6 months. Just sign in again.
  - Sometimes Spotify asks an app to slow down for a while ("too many
    requests"). Glasswave then waits as long as Spotify asks, keeps
    showing your library from last time, says so in the left column,
    and loads everything again by itself when the wait is over.
  - Settings (click your name, bottom left) has three effect levels:
    Lite (fastest), Glass, and Liquid (fanciest).
  - Space = play/pause.  Ctrl+Right / Ctrl+Left = next / previous.
    L = lyrics.  V = visualizer.  F = full screen.  Esc = back.
    "/" or Ctrl+K = search.  Right-click any song for more options.
  - Hover over any song (in a list or on a card) for a quick "add to
    queue" button.
  - Volume: point at a volume bar to see the exact percent under the
    pointer, then click to set it. The big lyrics view has a longer
    bar for finer steps. The mouse wheel and arrow keys move it 5% at
    a time, or 1% with Shift held.
  - For sound on this computer the bar follows how hearing works, so
    its lower half covers the quiet range (50% is about an eighth of
    full loudness). Other Spotify devices use their own volume steps.
  - Your sign-in is kept only in your browser on this computer.
    Glasswave talks to Spotify, and to lrclib.net for lyrics (song
    title, artist, album and length only). Nothing else.


WHAT SPOTIFY DOES NOT ALLOW IN OUTSIDE APPS
  Offline downloads, Spotify's own lyrics, Jam, DJ, Wrapped, turning
  on Spotify's own Smart Shuffle (Glasswave has its own), and the
  song lists of playlists you do not own (you can still play those
  playlists).
  Search shows 10 results at a time.


WHAT IS IN THIS FOLDER
  Install Glasswave.bat        makes Glasswave.exe and adds it to the
                               Start menu (run once)
  Glasswave.exe                Glasswave as an app (after installing)
  Start Glasswave.bat          opens the player in your browser
  Add desktop shortcut.bat     adds a desktop icon (optional)
  app\                         the player itself
  Start Glasswave (own window).bat   opens it in its own window
  Local folders.txt            extra music folders for Local Files
  launcher\                    small helpers: one hands the app's files
                               and your music files to the window and
                               fetches lyrics, one is the own window
                               (launcher\webview2 holds Microsoft's
                               WebView2 helper files; shell-fallback.cs
                               is a spare copy of the earlier window;
                               Glasswave.cs and helper.cs are what
                               Glasswave.exe is built from)
  To rename the player, change APP_NAME in app\js\config.js.

Glasswave is a personal, unofficial player. Music, artwork and data
come from Spotify.
