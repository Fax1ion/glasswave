// Glasswave settings. Change APP_NAME here if you want to rename the player.
export const APP_NAME = 'Glasswave';

// The address Spotify sends you back to after sign-in. It must be listed,
// exactly, under "Redirect URIs" in your app on the Spotify developer dashboard.
export const REDIRECT_URI = location.origin + '/callback';

// What the player asks Spotify for permission to do.
export const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',            // play audio in this window
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'user-read-recently-played', 'user-top-read', 'user-read-playback-position',
  'user-library-read', 'user-library-modify',
  'user-follow-read', 'user-follow-modify',
  'playlist-read-private', 'playlist-read-collaborative',
  'playlist-modify-private', 'playlist-modify-public',
].join(' ');

// Open the app with ?demo to look around with made-up music and no Spotify account.
export const DEMO = new URLSearchParams(location.search).has('demo');
