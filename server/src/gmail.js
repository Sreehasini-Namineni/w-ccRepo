// Gmail API: Google OAuth (authorization code + PKCE, "Desktop app" client) and read-only mail.
import crypto from 'node:crypto';
import { secrets, saveSecrets } from './store.js';

export const SCOPES = 'openid email profile https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pending = new Map(); // state -> PKCE verifier, for in-flight sign-ins

export function configured() { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
export function connected() { return !!(secrets.google && secrets.google.refresh_token); }

export function authUrl(redirectUri) {
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  pending.set(state, verifier);
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params) {
  const body = new URLSearchParams(Object.assign({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET }, params));
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json();
  if (!res.ok) {
    // In "Testing" mode Google expires refresh tokens after 7 days.
    if (json.error === 'invalid_grant') { delete secrets.google; saveSecrets(); throw new Error('Google sign-in expired. Connect Gmail again.'); }
    throw new Error(`Google sign-in failed: ${json.error_description || json.error || res.status}`);
  }
  secrets.google = { access_token: json.access_token, refresh_token: json.refresh_token || (secrets.google || {}).refresh_token, expires_at: Date.now() + (json.expires_in - 60) * 1000 };
  saveSecrets();
}

export async function finishSignIn({ code, state, redirectUri }) {
  const verifier = pending.get(state);
  if (!verifier) throw new Error('Sign-in session expired. Try Connect Gmail again.');
  pending.delete(state);
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
}

export function disconnect() { delete secrets.google; saveSecrets(); }

async function accessToken() {
  const t = secrets.google;
  if (!t) throw new Error('Gmail is not connected');
  if (Date.now() >= t.expires_at) await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  return secrets.google.access_token;
}

export class RateLimited extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Google reports per-user quota limits as 429, or as 403 with one of these reasons.
const QUOTA_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED'];
const isQuota = (status, json) => status === 429 || (status === 403 && json && json.error &&
  (((json.error.errors || []).some((e) => QUOTA_REASONS.includes(e.reason))) || (json.error.details || []).some((d) => QUOTA_REASONS.includes(d.reason)) || /quota exceeded|rate limit/i.test(json.error.message || '')));

async function google(url) {
  let wait = 2000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401 && attempt === 0) { secrets.google.expires_at = 0; continue; }
    const json = await res.json().catch(() => null);
    if (isQuota(res.status, json) || res.status >= 500) {
      // exponential backoff with jitter; honour Retry-After when Google sends it
      await sleep((+res.headers.get('retry-after') * 1000) || wait + Math.random() * 1000);
      wait *= 2;
      continue;
    }
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${(json && json.error && json.error.message) || 'request failed'}`);
    return json;
  }
  throw new RateLimited('Google is rate-limiting this project’s Gmail requests.');
}

export async function me() {
  const u = await google('https://openidconnect.googleapis.com/v1/userinfo');
  return { name: u.name || u.email, email: (u.email || '').toLowerCase() };
}

const SYSTEM_LABELS = { INBOX: 'Inbox', SENT: 'Sent', STARRED: 'Starred', IMPORTANT: 'Important' };
/** Inbox, Sent, Starred, Important and your own labels. */
export async function labels() {
  const r = await google(`${API}/labels`);
  return (r.labels || []).filter((l) => l.type === 'user' || SYSTEM_LABELS[l.id]).map((l) => ({ id: l.id, name: SYSTEM_LABELS[l.id] || l.name }))
    .sort((a, b) => (SYSTEM_LABELS[a.id] ? 0 : 1) - (SYSTEM_LABELS[b.id] ? 0 : 1) || a.name.localeCompare(b.name));
}

/**
 * Reads up to `cap` of the newest messages in a label received after `sinceMs`, then hands
 * them to `onMessage` one at a time, oldest first, at a steady pace that stays inside
 * Google's per-user quota. The caller saves its position after each message, so an
 * interrupted sync resumes where it stopped. Promotions, social and forum mail are skipped.
 */
export async function readLabel(labelId, sinceMs, onMessage, cap = 150) {
  const ids = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ labelIds: labelId, q: `after:${Math.floor(sinceMs / 1000)} -category:promotions -category:social -category:forums`, maxResults: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await google(`${API}/messages?${q}`);
    (page.messages || []).forEach((m) => ids.push(m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < cap);
  let n = 0;
  for (const id of ids.slice(0, cap).reverse()) { // the list comes newest first
    const m = await google(`${API}/messages/${id}?format=full`);
    if (+m.internalDate > sinceMs && !(m.labelIds || []).includes('DRAFT')) { onMessage(m); n++; }
    await sleep(150); // about 6 reads a second
  }
  return n;
}
