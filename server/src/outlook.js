// Microsoft Graph: OAuth (authorization code + PKCE) and read-only mail access.
import crypto from 'node:crypto';
import { secrets, saveSecrets } from './store.js';

export const SCOPES = 'offline_access User.Read Mail.Read';
const authority = () => `https://login.microsoftonline.com/${process.env.MS_TENANT || 'common'}/oauth2/v2.0`;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pending = new Map(); // state -> PKCE verifier, for in-flight sign-ins

export function configured() { return !!process.env.MS_CLIENT_ID; }
export function connected() { return !!(secrets.outlook && secrets.outlook.refresh_token); }

export function authUrl(redirectUri) {
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  pending.set(state, verifier);
  const q = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
    scope: SCOPES, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account'
  });
  return `${authority()}/authorize?${q}`;
}

async function tokenRequest(params) {
  const body = new URLSearchParams(Object.assign({ client_id: process.env.MS_CLIENT_ID, scope: SCOPES }, params));
  if (process.env.MS_CLIENT_SECRET) body.set('client_secret', process.env.MS_CLIENT_SECRET);
  const res = await fetch(`${authority()}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json();
  if (!res.ok) throw new Error(`Microsoft sign-in failed: ${json.error_description || json.error || res.status}`);
  secrets.outlook = { access_token: json.access_token, refresh_token: json.refresh_token || (secrets.outlook || {}).refresh_token, expires_at: Date.now() + (json.expires_in - 60) * 1000 };
  saveSecrets();
}

export async function finishSignIn({ code, state, redirectUri }) {
  const verifier = pending.get(state);
  if (!verifier) throw new Error('Sign-in session expired. Try Connect Outlook again.');
  pending.delete(state);
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
}

export function disconnect() { delete secrets.outlook; saveSecrets(); }

async function accessToken() {
  const t = secrets.outlook;
  if (!t) throw new Error('Outlook is not connected');
  if (Date.now() >= t.expires_at) await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  return secrets.outlook.access_token;
}

async function graph(url, extraHeaders) {
  const full = url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(full, { headers: Object.assign({ Authorization: `Bearer ${await accessToken()}` }, extraHeaders || {}) });
    if (res.status === 401 && attempt === 0) { secrets.outlook.expires_at = 0; continue; }
    if (res.status === 429 || res.status === 503) { await new Promise((r) => setTimeout(r, (+res.headers.get('retry-after') || 5) * 1000)); continue; }
    const json = await res.json();
    if (!res.ok) throw new Error(`Graph ${res.status}: ${(json.error && json.error.message) || 'request failed'}`);
    return json;
  }
  throw new Error('Graph kept rate-limiting the request');
}

export async function me() {
  const u = await graph('/me?$select=displayName,mail,userPrincipalName');
  return { name: u.displayName, email: (u.mail || u.userPrincipalName || '').toLowerCase() };
}

/** Top-level folders plus one level of children (e.g. Inbox/ClientName). */
export async function folders() {
  const top = await graph('/me/mailFolders?$top=100&$select=id,displayName,childFolderCount,totalItemCount');
  const out = [];
  for (const f of top.value) {
    out.push({ id: f.id, name: f.displayName, count: f.totalItemCount });
    if (f.childFolderCount) {
      const kids = await graph(`/me/mailFolders/${f.id}/childFolders?$top=100&$select=id,displayName,totalItemCount`);
      kids.value.forEach((k) => out.push({ id: k.id, name: `${f.displayName}/${k.displayName}`, count: k.totalItemCount }));
    }
  }
  return out;
}

/** Messages received after `sinceIso`, oldest first, capped. Bodies come back as plain text. */
export async function messagesSince(folderId, sinceIso, cap = 300) {
  const q = new URLSearchParams({
    $filter: `receivedDateTime gt ${sinceIso}`, $orderby: 'receivedDateTime asc', $top: '50',
    $select: 'id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink,isDraft'
  });
  let url = `/me/mailFolders/${folderId}/messages?${q}`;
  const out = [];
  while (url && out.length < cap) {
    const page = await graph(url, { Prefer: 'outlook.body-content-type="text"' });
    out.push(...page.value.filter((m) => !m.isDraft));
    url = page['@odata.nextLink'];
  }
  return out.slice(0, cap);
}
