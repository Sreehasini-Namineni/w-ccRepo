// Slack Web API, read-only, with a user (xoxp) or bot (xoxb) token.
import { secrets, saveSecrets } from './store.js';

export function token() { return (secrets.slack && secrets.slack.token) || process.env.SLACK_TOKEN || ''; }
export function connected() { return !!token(); }

async function api(method, params) {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params || {})}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, (+res.headers.get('retry-after') || 3) * 1000)); continue; }
    const json = await res.json();
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
    return json;
  }
  throw new Error(`Slack ${method}: rate limited`);
}

/** Validates a token and remembers it. */
export async function connect(newToken) {
  const prev = secrets.slack;
  secrets.slack = { token: newToken.trim() };
  try { const t = await api('auth.test'); saveSecrets(); return t; } catch (e) { secrets.slack = prev; throw e; }
}
export function disconnect() { delete secrets.slack; saveSecrets(); }

export async function whoami() {
  const t = await api('auth.test');
  return { team: { id: t.team_id, name: t.team, url: t.url }, userId: t.user_id };
}

/** Conversations the token can read history from. */
export async function channels() {
  const out = [];
  let cursor = '';
  do {
    const page = await api('conversations.list', { types: 'public_channel,private_channel,mpim,im', exclude_archived: 'true', limit: '200', cursor });
    page.channels.forEach((c) => {
      if (!c.is_im && !c.is_member) return; // history needs membership; bots must be invited
      out.push({ id: c.id, name: c.is_im ? null : c.name, dm: !!(c.is_im || c.is_mpim), dmUser: c.user || null, shared: !!(c.is_ext_shared || c.is_shared) });
    });
    cursor = page.response_metadata && page.response_metadata.next_cursor;
  } while (cursor);
  return out;
}

/** Top-level messages after `oldest` (epoch seconds as a string), oldest first. */
export async function history(channel, oldest, cap = 400) {
  const out = [];
  let cursor = '';
  do {
    const page = await api('conversations.history', { channel, oldest, limit: '200', cursor });
    out.push(...page.messages.filter((m) => m.type === 'message' && (!m.subtype || m.subtype === 'thread_broadcast') && m.user && m.text));
    cursor = page.has_more && page.response_metadata && page.response_metadata.next_cursor;
  } while (cursor && out.length < cap);
  return out.sort((a, b) => +a.ts - +b.ts).slice(-cap);
}

export async function user(id) {
  const u = (await api('users.info', { user: id })).user;
  return { name: (u.profile && (u.profile.real_name || u.profile.display_name)) || u.real_name || u.name, email: ((u.profile && u.profile.email) || '').toLowerCase(), title: (u.profile && u.profile.title) || '' };
}
