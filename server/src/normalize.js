// Turns Gmail and Slack messages into the message shape the Skyline agents read
// (the same shape as the demo corpus in skyline/data.js), and discovers clients.

export const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com']);
const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|newsletters?|bounces?|calendar|alerts?|marketing|digest)\b[^@]*@/i;
const pad = (n) => String(n).padStart(2, '0');

/** Local wall-clock ISO (YYYY-MM-DDTHH:MM), which is what the web app parses. */
export function localIso(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

export const isAutomated = (email) => AUTOMATED.test(email);
export const domainOf = (email) => (email.split('@')[1] || '').toLowerCase();

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const ACCOUNT = /\b\d{9,17}\b/g; // bank / routing / account numbers
/** Applied before anything is stored or sent to Claude. */
export function redact(text) {
  let hit = false;
  const out = text.replace(SSN, () => { hit = true; return '•••-••-••••'; }).replace(ACCOUNT, (m) => { hit = true; return '••••' + m.slice(-4); });
  return { text: out, redacted: hit };
}

/** Keep the new part of an email: drop quoted replies and signatures' reply chains. */
export function cleanEmailBody(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    if (out.length && /^\s*(-{2,}\s*Original Message|From:\s.+|On .+ wrote:\s*$|_{8,})/i.test(line)) break;
    if (out.length && /^\s*wrote:\s*$/i.test(line) && /^\s*On\s/.test(out[out.length - 1])) { out.pop(); break; }
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

export function addPerson(people, email, name, extra) {
  const id = email.toLowerCase();
  const local = id.split('@')[0];
  if (!people[id]) people[id] = { name: name || local, email: id, role: '' };
  else if (name && people[id].name === local) people[id].name = name;
  if (extra) Object.keys(extra).forEach((k) => { if (extra[k]) people[id][k] = extra[k]; });
  return id;
}

/** "Name <a@b.com>, "Last, First" <c@d.com>" -> [{ name, email }] */
export function parseAddresses(value) {
  const parts = [];
  let cur = '', quoted = false;
  for (const ch of String(value || '')) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => {
    const m = p.match(/<([^>]+)>/);
    const email = (m ? m[1] : p).trim().replace(/^mailto:/i, '');
    return email.includes('@') ? { name: m ? p.slice(0, m.index).replace(/"/g, '').trim() : '', email } : null;
  }).filter(Boolean);
}

const header = (m, name) => { const h = ((m.payload && m.payload.headers) || []).find((x) => x.name.toLowerCase() === name); return h ? h.value : ''; };
const decode = (data) => Buffer.from(data, 'base64url').toString('utf8');
function findPart(part, type) {
  if (!part) return null;
  if (part.mimeType === type && part.body && part.body.data) return part.body.data;
  for (const p of part.parts || []) { const hit = findPart(p, type); if (hit) return hit; }
  return null;
}
/** Plain text if the message has it, otherwise the HTML part with tags stripped. */
function gmailBody(payload) {
  const plain = findPart(payload, 'text/plain');
  if (plain) return decode(plain);
  const html = findPart(payload, 'text/html');
  if (!html) return '';
  return decode(html).replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}

export function fromGmail(m, labelName, people, redactOn) {
  const sender = parseAddresses(header(m, 'from'))[0];
  if (!sender || isAutomated(sender.email)) return null;
  const from = addPerson(people, sender.email, sender.name);
  const pids = (h) => parseAddresses(header(m, h)).map((a) => addPerson(people, a.email, a.name));
  const body = cleanEmailBody(gmailBody(m.payload));
  const r = redactOn ? redact(body) : { text: body, redacted: false };
  return {
    id: 'g:' + m.id, msgId: header(m, 'message-id') || m.id, src: 'email', where: labelName, ts: localIso(+m.internalDate),
    from, to: pids('to'), cc: pids('cc'), subject: header(m, 'subject') || '(no subject)', body: r.text, redacted: r.redacted || undefined,
    thread: m.threadId, link: `https://mail.google.com/mail/u/0/#all/${m.threadId}`
  };
}

function slackText(text, users) {
  return String(text)
    .replace(/<@([A-Z0-9]+)(\|[^>]+)?>/g, (_, id) => '@' + ((users[id] && users[id].name) || id))
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** A Slack user's person id is their email when Slack shares it, otherwise a team-local id. */
export function slackPerson(people, users, uid, teamId) {
  const u = users[uid] || { name: uid, email: '' };
  return addPerson(people, u.email || `${uid.toLowerCase()}@slack-${(teamId || 'team').toLowerCase()}.local`, u.name, { role: u.title });
}

export function fromSlack(msg, channel, people, users, team, redactOn) {
  const from = slackPerson(people, users, msg.user, team && team.id);
  const where = channel.dm ? 'DM · ' + ((users[channel.dmUser] && users[channel.dmUser].name) || 'direct message') : '#' + channel.name;
  const r = redactOn ? redact(slackText(msg.text, users)) : { text: slackText(msg.text, users), redacted: false };
  const link = team && team.url ? `${team.url.replace(/\/$/, '')}/archives/${channel.id}/p${msg.ts.replace('.', '')}` : undefined;
  return {
    id: `s:${channel.id}:${msg.ts}`, src: 'slack', where, dm: channel.dm || undefined, ts: localIso(+msg.ts * 1000),
    from, to: channel.dm && channel.dmUser ? [slackPerson(people, users, channel.dmUser, team && team.id)] : [], body: r.text.slice(0, 4000), redacted: r.redacted || undefined,
    thread: msg.thread_ts || msg.ts, link
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const title = (s) => s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
function baseName(domain) {
  const parts = domain.split('.');
  parts.pop();
  if (parts.length > 1 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1] || domain;
}

/**
 * Clients you name yourself, by contact address, in SKYLINE_TEST_CLIENTS:
 *   "Brightline Logistics: a@gmail.com, b@gmail.com; Harbor & Pine Clinics: c@gmail.com"
 * These count as clients even on public mail domains (useful for testing with Gmail).
 */
export function configuredClients() {
  return String(process.env.SKYLINE_TEST_CLIENTS || '').split(';').map((part) => {
    const i = part.indexOf(':');
    if (i < 0) return null;
    const name = part.slice(0, i).trim();
    const emails = part.slice(i + 1).split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
    if (!name || !emails.length) return null;
    const word = name.split(/\s+/)[0];
    // `domain` is a label here, never a real domain, so it can't capture other Gmail users
    return { id: slug(name), name, short: word, domain: 'test contacts', emails, slack: slug(word) };
  }).filter(Boolean);
}

/**
 * Clients are the clients you configured (above) plus the external email domains you
 * actually correspond with (two or more messages), minus public mail providers and
 * automated senders. A real CRM could replace this.
 */
export function discoverClients(messages, internalDomain, names) {
  const configured = configuredClients();
  const listed = new Set([].concat(...configured.map((c) => c.emails)));
  const counts = {};
  messages.forEach((m) => {
    const doms = new Set([m.from].concat(m.to || [], m.cc || []).filter((p) => !isAutomated(p) && !listed.has(p)).map(domainOf));
    doms.forEach((d) => { if (d && d !== internalDomain && !PUBLIC_MAIL.has(d) && !d.endsWith('.local')) counts[d] = (counts[d] || 0) + 1; });
  });
  return configured.concat(Object.keys(counts).filter((d) => counts[d] >= 2).sort((a, b) => counts[b] - counts[a]).map((domain) => {
    const base = baseName(domain);
    // `short` is what mention-matching looks for, so it stays the domain's base word
    // ("Brightline") even when the display name is overridden ("Brightline Logistics").
    return { id: slug(base), name: names[domain] || title(base), short: title(base), domain, slack: slug(base) };
  }));
}

/** Same rule the Cartographer agent uses: external participant, then channel prefix, then a mention. */
export function resolveClient(m, crm, internalDomain) {
  for (const p of [m.from].concat(m.to || [], m.cc || [])) {
    const c = crm.find((x) => (x.emails && x.emails.includes(p)) || (!x.emails && x.domain === domainOf(p)));
    if (c) return c;
  }
  if (m.src === 'slack' && !m.dm) { const c = crm.find((x) => m.where.indexOf('#' + x.slack) === 0); if (c) return c; }
  const text = ((m.subject || '') + ' ' + m.body).toLowerCase();
  return crm.find((x) => clientAliases(x).some((a) => text.includes(a))) || null;
}

/** Ways people refer to a client in text: domain word, display name, and the name's first word. */
export function clientAliases(c) {
  return [...new Set([c.short, c.name, c.name.split(/\s+/)[0]].map((a) => (a || '').toLowerCase()).filter((a) => a.length >= 4))];
}
