// Sign-in with Spotify using the Authorization Code + PKCE flow.
// Nothing secret is stored: only your app's public Client ID and the tokens
// Spotify hands back, kept in this browser's local storage on this computer.

import { REDIRECT_URI, SCOPES } from './config.js';
import { store } from './util.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const K_CLIENT = 'gw.clientId', K_TOKENS = 'gw.tokens', K_PKCE = 'gw.pkce';

let tokens = store.get(K_TOKENS, null);
let refreshing = null;
let signedOutHandler = null;

export const getClientId = () => store.get(K_CLIENT, '') || '';
export const setClientId = id => store.set(K_CLIENT, String(id || '').trim());
export const isSignedIn = () => !!(tokens && tokens.refresh_token);
export const onSignedOut = fn => { signedOutHandler = fn; };

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomString = n => b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);

// Step 1: send the browser to Spotify's own sign-in page.
export async function beginLogin() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Add your Client ID first.');
  const verifier = randomString(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const state = randomString(16);
  store.set(K_PKCE, { verifier, state, t: Date.now() });
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: b64url(new Uint8Array(digest)),
    state,
  });
  location.assign(`${AUTH_URL}?${p}`);
}

// Step 2: Spotify sends the browser back to /callback?code=...; swap the code for tokens.
export async function completeLogin() {
  const q = new URLSearchParams(location.search);
  const pk = store.get(K_PKCE);
  store.remove(K_PKCE);
  history.replaceState(null, '', '/');
  if (q.get('error')) {
    throw new Error(q.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'Spotify sign-in failed: ' + q.get('error'));
  }
  const code = q.get('code');
  if (!code) return false;
  if (!pk || pk.state !== q.get('state')) throw new Error('That sign-in could not be verified. Please try again.');
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: getClientId(),
    code_verifier: pk.verifier,
  });
  return true;
}

async function tokenRequest(params) {
  let res, data = {};
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    data = await res.json().catch(() => ({}));
  } catch {
    throw new Error('Can’t reach Spotify. Check your internet connection.');
  }
  if (!res.ok || !data.access_token) {
    const e = new Error(data.error_description || data.error || `Sign-in failed (${res.status})`);
    e.code = data.error;
    throw e;
  }
  const fresh = params.grant_type === 'authorization_code';
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || (tokens && tokens.refresh_token),
    expires_at: Date.now() + (Math.max(120, data.expires_in || 3600) - 60) * 1000,
    authorized_at: fresh ? Date.now() : (tokens && tokens.authorized_at) || Date.now(),
  };
  store.set(K_TOKENS, tokens);
  return tokens.access_token;
}

// Returns a valid access token, refreshing it quietly when it is about to run out.
export async function getToken() {
  if (!tokens) throw new Error('Not signed in');
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  // Another window of the app may already have refreshed it.
  const saved = store.get(K_TOKENS, null);
  if (saved && saved.expires_at > Date.now()) { tokens = saved; return tokens.access_token; }
  return forceRefresh();
}

export function forceRefresh() {
  if (!tokens || !tokens.refresh_token) return Promise.reject(new Error('Not signed in'));
  if (!refreshing) {
    refreshing = tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: getClientId(),
    }).catch(e => {
      // Spotify ends a sign-in after 6 months (or if access is removed): ask to sign in again.
      if (e.code === 'invalid_grant' || e.code === 'invalid_client') signOut('Your Spotify sign-in ran out. Sign in again to keep listening.');
      throw e;
    }).finally(() => { refreshing = null; });
  }
  return refreshing;
}

export function signOut(message) {
  tokens = null;
  store.remove(K_TOKENS);
  if (signedOutHandler) signedOutHandler(message || null);
}
