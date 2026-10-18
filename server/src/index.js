// Skyline live server: serves the web app, connects Gmail and Slack, and turns new
// messages into signals with Claude. Listens on localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, db, saveDb, secrets, logEvent, loadEnv } from './store.js';
import * as gmail from './gmail.js';
import * as slack from './slack.js';
import { addPerson, domainOf, discoverClients, configuredClients, resolveClient, fromGmail, fromSlack, localIso, PUBLIC_MAIL } from './normalize.js';
import { extractBatch, Anthropic } from './extract.js';

loadEnv();
const PORT = +process.env.PORT || 8787;
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
// Google "Desktop app" clients accept any loopback redirect, so nothing has to be registered.
const REDIRECT = `http://127.0.0.1:${PORT}/auth/google/callback`;
const WEB_DIR = path.join(ROOT, '..', 'skyline');
const LOOKBACK_DAYS = +process.env.SKYLINE_LOOKBACK_DAYS || 21;
const BATCH = 12;
db.people = db.people || {};

// ---------------------------------------------------------------- helpers
const meEmail = () => (db.gmail.me && db.gmail.me.email) || (db.slack.me && db.slack.me.email) || '';
// On a public address (you@gmail.com) only you are internal; otherwise your whole domain is.
const internalDomain = () => process.env.SKYLINE_INTERNAL_DOMAIN || (PUBLIC_MAIL.has(domainOf(meEmail())) ? '' : domainOf(meEmail()));
const isInternal = (id) => id === meEmail() || (!!internalDomain() && domainOf(id) === internalDomain());
const slackName = (c) => (c.dm ? null : '#' + c.name);

function sourceEnabled(m) {
  if (m.src === 'slack') return m.dm ? !!db.access.slack.dms : db.access.slack.channels[m.where] !== false;
  return (m.labels || [m.where]).some((l) => db.access.mail.labels[l] !== false);
}
/** The label a message is shown under: the first one you've left on. */
const shownLabel = (m) => (m.labels || [m.where]).find((l) => db.access.mail.labels[l] !== false) || m.where;
/** Turning a source off deletes what Skyline stored from it. */
function prune() {
  for (const id of Object.keys(db.messages)) {
    const m = db.messages[id];
    const gone = (m.src === 'email' && !gmail.connected()) || (m.src === 'slack' && !slack.connected());
    if (gone || !sourceEnabled(m)) { delete db.messages[id]; delete db.signals[id]; }
  }
}

// ---------------------------------------------------------------- sync
let syncing = null;
const OFFLINE = !!process.env.SKYLINE_OFFLINE; // serve stored data only; no Gmail/Slack/Claude calls (dev and tests)
export function sync(reason) {
  if (OFFLINE) return Promise.resolve(reason);
  if (!syncing) syncing = runSync(reason).finally(() => { syncing = null; });
  return syncing;
}

async function runSync(reason) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
  const people = db.people;

  if (gmail.connected() && Date.now() < (db.gmail.pausedUntil || 0)) {
    logEvent('Gmail', 'warn', `Paused after Google's rate limit. Resuming at ${localIso(db.gmail.pausedUntil).slice(11)}.`);
  } else if (gmail.connected()) {
    let n = 0;
    try {
      if (!db.gmail.me) db.gmail.me = await gmail.me();
      addPerson(people, db.gmail.me.email, db.gmail.me.name);
      db.gmail.labels = await gmail.labels();
      db.gmail.labels.forEach((l) => { if (db.access.mail.labels[l.name] === undefined) db.access.mail.labels[l.name] = l.id === 'INBOX' || l.id === 'SENT'; });
      const firstCap = +process.env.SKYLINE_FIRST_SYNC_CAP || 150;
      for (const l of db.gmail.labels.filter((x) => db.access.mail.labels[x.name])) {
        await gmail.readLabel(l.id, db.gmail.cursor[l.id] || +since, (m) => {
          db.gmail.cursor[l.id] = Math.max(db.gmail.cursor[l.id] || 0, +m.internalDate); // resume point
          const msg = fromGmail(m, l.name, people, db.access.redact);
          if (msg) {
            const had = db.messages[msg.id];
            // one Gmail message can carry several labels: keep it once, remember all of them
            if (had) { if (!had.labels.includes(l.name)) had.labels.push(l.name); }
            else { msg.labels = [l.name]; db.messages[msg.id] = msg; n++; }
          }
          if (n % 20 === 0) saveDb();
        }, firstCap);
      }
      db.gmail.pausedUntil = 0;
      logEvent('Gmail', 'ok', `Synced ${n} new message${n === 1 ? '' : 's'}.`);
    } catch (e) {
      if (e instanceof gmail.RateLimited) {
        db.gmail.pausedUntil = Date.now() + 2 * 60000; // don't hammer the quota on every Sync press
        logEvent('Gmail', 'warn', `Google is rate-limiting Gmail reads. Kept the ${n} message${n === 1 ? '' : 's'} read so far and will continue in about 2 minutes.`);
      } else logEvent('Gmail', 'warn', e.message);
    }
  }

  if (slack.connected()) {
    try {
      const who = await slack.whoami();
      db.slack.team = who.team;
      if (!db.slack.users[who.userId]) db.slack.users[who.userId] = await slack.user(who.userId);
      db.slack.me = db.slack.users[who.userId];
      db.slack.channels = await slack.channels();
      db.slack.channels.forEach((c) => { if (!c.dm && db.access.slack.channels[slackName(c)] === undefined) db.access.slack.channels[slackName(c)] = true; });
      let n = 0;
      for (const c of db.slack.channels.filter((x) => (x.dm ? db.access.slack.dms : db.access.slack.channels[slackName(x)]))) {
        const list = await slack.history(c.id, db.slack.cursor[c.id] || String(Math.floor(since / 1000)));
        for (const uid of new Set(list.map((m) => m.user).concat(c.dmUser ? [c.dmUser] : []))) {
          if (!db.slack.users[uid]) { try { db.slack.users[uid] = await slack.user(uid); } catch { db.slack.users[uid] = { name: uid, email: '' }; } }
        }
        list.forEach((m) => { const msg = fromSlack(m, c, people, db.slack.users, db.slack.team, db.access.redact); db.messages[msg.id] = msg; n++; });
        if (list.length) db.slack.cursor[c.id] = list[list.length - 1].ts;
      }
      logEvent('Slack', 'ok', `Synced ${n} new message${n === 1 ? '' : 's'} from ${db.slack.team.name}.`);
    } catch (e) { logEvent('Slack', 'warn', e.message); }
  }

  prune();
  saveDb();
  await extractPending();
  db.lastSync = new Date().toISOString();
  saveDb();
  return reason;
}

/** Send every client message that hasn't been read yet through Claude, client by client, oldest first. */
async function extractPending() {
  const all = Object.values(db.messages);
  const crm = discoverClients(all, internalDomain(), db.clientNames);
  const byClient = new Map();
  all.filter((m) => !db.signals[m.id]).forEach((m) => {
    const c = resolveClient(m, crm, internalDomain());
    if (!c) return; // not about a client: never sent to Claude
    if (!byClient.has(c.id)) byClient.set(c.id, { c, msgs: [] });
    byClient.get(c.id).msgs.push(m);
  });
  let done = 0;
  for (const { c, msgs } of byClient.values()) {
    msgs.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    for (let i = 0; i < msgs.length; i += BATCH) {
      const batch = msgs.slice(i, i + BATCH);
      const ctx = clientContext(c, batch);
      try {
        const { results, usage, refused } = await extractBatch(ctx);
        batch.forEach((m) => { db.signals[m.id] = results.get(m.id) || []; });
        db.usage.calls++;
        db.usage.input += usage.input_tokens || 0;
        db.usage.output += usage.output_tokens || 0;
        db.usage.cacheRead += usage.cache_read_input_tokens || 0;
        if (refused) logEvent('Claude', 'warn', `Declined to read ${batch.length} ${c.name} messages; they were skipped.`);
        done += batch.length;
        saveDb();
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) { logEvent('Claude', 'bad', 'No working Claude credentials. Set ANTHROPIC_API_KEY in server/.env or run `ant auth login`.'); return; }
        if (e instanceof Anthropic.RateLimitError) { logEvent('Claude', 'warn', 'Rate limited. The rest will be read on the next sync.'); return; }
        if (e instanceof Anthropic.APIError) { logEvent('Claude', 'warn', `API error ${e.status}: ${e.message}`); continue; }
        if (e instanceof Anthropic.APIConnectionError) { logEvent('Claude', 'warn', 'Could not reach the Claude API. Will retry next sync.'); return; }
        logEvent('Claude', 'warn', `Could not read a ${c.name} batch: ${e.message}`);
      }
    }
  }
  if (done) logEvent('Claude', 'ok', `Read ${done} client message${done === 1 ? '' : 's'} and extracted signals.`);
}

function clientContext(c, batch) {
  const internal = internalDomain();
  const theirs = Object.values(db.messages).filter((m) => db.signals[m.id] && resolveClient(m, [c], internal));
  const ws = new Set(), keys = new Map();
  theirs.forEach((m) => db.signals[m.id].forEach((s) => {
    if (s.ws) ws.add(s.ws);
    if (s.key && !keys.has(s.key) && ['commit', 'question', 'opp', 'slip', 'concern'].includes(s.t)) keys.set(s.key, { key: s.key, type: s.t, what: s.what || s.text, owner: s.owner || s.asker });
  }));
  const ids = new Set();
  batch.forEach((m) => [m.from].concat(m.to || [], m.cc || []).forEach((p) => ids.add(p)));
  if (meEmail()) ids.add(meEmail());
  Object.keys(db.people).filter(isInternal).slice(0, 40).forEach((p) => ids.add(p));
  const people = [...ids].filter((p) => db.people[p]).map((p) => ({
    id: p, name: db.people[p].name,
    org: p === meEmail() ? 'internal team (the user)' : isInternal(p) ? 'internal team' : (c.emails ? c.emails.includes(p) : domainOf(p) === c.domain) ? c.name : 'other'
  }));
  return { client: { name: c.name, domain: c.domain }, today: localIso(new Date()), people, workstreams: [...ws], keys: [...keys.values()].slice(-80), messages: batch };
}

// ---------------------------------------------------------------- snapshot for the web app
function snapshot() {
  const internal = internalDomain();
  const all = Object.values(db.messages).filter(sourceEnabled);
  const crm = discoverClients(all, internal, db.clientNames);
  const me = meEmail();
  const people = {};
  Object.keys(db.people).forEach((id) => {
    const p = db.people[id];
    const client = crm.find((c) => (c.emails ? c.emails.includes(id) : c.domain === domainOf(id)));
    people[id] = { name: p.name, email: p.email, role: p.role || (client ? client.name : isInternal(id) ? 'Teammate' : domainOf(id)), you: id === me || undefined };
  });
  if (me && !people[me]) people[me] = { name: (db.gmail.me && db.gmail.me.name) || (db.slack.me && db.slack.me.name) || 'Me', email: me, role: 'You', you: true };
  const shared = {};
  db.slack.channels.forEach((c) => { if (c.shared && !c.dm) shared[slackName(c)] = true; });
  const pending = all.filter((m) => !db.signals[m.id] && resolveClient(m, crm, internal)).length;
  return {
    mode: 'live', meId: me, internalDomain: internal, people, crm, sharedChannels: shared,
    messages: all.map((m) => Object.assign({}, m, { where: m.src === 'email' ? shownLabel(m) : m.where, signals: db.signals[m.id] || [] })),
    access: {
      outlook: { on: gmail.connected(), account: me || '', transcripts: false, folders: Object.assign({}, db.access.mail.labels) }, // email access (web app key name)
      slack: { on: slack.connected(), workspace: (db.slack.team && db.slack.team.name) || '', dms: !!db.access.slack.dms, channels: Object.assign({}, db.access.slack.channels) },
      redact: db.access.redact
    },
    events: db.events.map((e) => ({ at: localIso(e.at), source: e.source, level: e.level, text: e.text })),
    status: {
      gmail: { configured: gmail.configured(), connected: gmail.connected(), account: (db.gmail.me && db.gmail.me.email) || '' },
      slack: { connected: slack.connected(), team: (db.slack.team && db.slack.team.name) || '', fromEnv: !!process.env.SLACK_TOKEN && !(secrets.slack && secrets.slack.token) },
      syncing: !!syncing, lastSync: db.lastSync && localIso(db.lastSync), pending, usage: db.usage,
      labels: db.gmail.labels.map((l) => l.name), channels: db.slack.channels.filter((c) => !c.dm).map(slackName), dmCount: db.slack.channels.filter((c) => c.dm).length
    }
  };
}

// ---------------------------------------------------------------- http
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (res, code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;padding:32px;max-width:640px;color:#26303A;background:#EEF2F1"><h2>${title}</h2><p>${msg}</p><p><a href="/">Back to Skyline</a></p>`;
const readJson = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Only this machine, and only pages served from here, may call the API.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) return send(res, 403, { error: 'bad host' });
  if (req.method === 'POST' && req.headers.origin && !ORIGINS.has(req.headers.origin)) return send(res, 403, { error: 'bad origin' });
  try {
    if (url.pathname === '/api/snapshot') return send(res, 200, snapshot());
    if (url.pathname === '/api/sync' && req.method === 'POST') { await sync('manual'); return send(res, 200, snapshot()); }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.access) {
        const a = body.access;
        if (a.mail && a.mail.labels) Object.assign(db.access.mail.labels, a.mail.labels);
        if (a.slack && a.slack.channels) Object.assign(db.access.slack.channels, a.slack.channels);
        if (a.slack && typeof a.slack.dms === 'boolean') db.access.slack.dms = a.slack.dms;
        if (typeof a.redact === 'boolean') db.access.redact = a.redact;
      }
      if (body.clientNames) Object.assign(db.clientNames, body.clientNames);
      prune();
      saveDb();
      sync('settings');
      return send(res, 200, snapshot());
    }
    if (url.pathname === '/api/slack/connect' && req.method === 'POST') {
      const { token } = await readJson(req);
      if (!token || !/^xox[bp]-/.test(token.trim())) return send(res, 400, { error: 'That doesn’t look like a Slack token (xoxb-… or xoxp-…).' });
      try { await slack.connect(token); } catch (e) { return send(res, 400, { error: e.message }); }
      sync('slack connected');
      return send(res, 200, snapshot());
    }
    if (url.pathname === '/api/slack/disconnect' && req.method === 'POST') { slack.disconnect(); db.slack = { team: null, me: null, channels: [], cursor: {}, users: {} }; prune(); saveDb(); return send(res, 200, snapshot()); }
    if (url.pathname === '/api/gmail/disconnect' && req.method === 'POST') { gmail.disconnect(); db.gmail = { me: null, labels: [], cursor: {} }; prune(); saveDb(); return send(res, 200, snapshot()); }
    if (url.pathname === '/auth/google/start') {
      if (!gmail.configured()) return send(res, 400, page('Gmail isn’t set up yet', 'Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>server/.env</code> (see server/README.md), restart the server, and try again.'), 'text/html; charset=utf-8');
      res.writeHead(302, { Location: gmail.authUrl(REDIRECT) });
      return res.end();
    }
    if (url.pathname === '/auth/google/callback') {
      const back = (msg) => page('Gmail sign-in ' + msg[0], msg[1]).replace('href="/"', `href="http://localhost:${PORT}/"`);
      if (url.searchParams.get('error')) return send(res, 400, back(['was cancelled', url.searchParams.get('error')]), 'text/html; charset=utf-8');
      try { await gmail.finishSignIn({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), redirectUri: REDIRECT }); } catch (e) { return send(res, 400, back(['failed', e.message]), 'text/html; charset=utf-8'); }
      db.gmail = { me: null, labels: [], cursor: {} };
      logEvent('Gmail', 'ok', 'Connected.');
      sync('gmail connected');
      // back to the address you started from (the redirect itself lands on 127.0.0.1)
      res.writeHead(302, { Location: `http://localhost:${PORT}/?mode=live#sources` });
      return res.end();
    }
    // static web app
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file, 'utf8'), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Skyline live server: http://localhost:${PORT}`);
  console.log(`  Gmail:   ${gmail.configured() ? (gmail.connected() ? 'connected' : 'ready to connect') : 'not set up (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)'}`);
  console.log(`  Slack:   ${slack.connected() ? 'connected' : 'not connected'}`);
  if (OFFLINE) console.log('  Offline: serving stored data, not syncing');
  if (gmail.connected() || slack.connected()) sync('startup');
  const every = process.env.SKYLINE_SYNC_MINUTES === undefined ? 5 : +process.env.SKYLINE_SYNC_MINUTES;
  if (every > 0) setInterval(() => { if (gmail.connected() || slack.connected()) sync('scheduled'); }, every * 60000);
});
