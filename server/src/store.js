// Local persistence: two JSON files under server/data (git-ignored, owner-only permissions).
// secrets.json holds OAuth/API tokens; store.json holds synced messages and extracted signals.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');
export const DATA_DIR = process.env.SKYLINE_DATA_DIR || path.join(ROOT, 'data'); // override for tests
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; }
}
function write(name, value) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

export const secrets = read('secrets.json', {});
export function saveSecrets() { write('secrets.json', secrets); }

const EMPTY = {
  gmail: { me: null, labels: [], cursor: {} },
  slack: { team: null, me: null, channels: [], cursor: {}, users: {} },
  access: { mail: { labels: {} }, slack: { channels: {}, dms: false }, redact: true },
  messages: {},   // id -> normalized message
  signals: {},    // id -> extracted signals (present once a message has been through Claude)
  clientNames: {}, // domain -> display name override
  events: [],     // connector / extraction events for the Sources page
  usage: { calls: 0, input: 0, output: 0, cacheRead: 0 },
  lastSync: null
};
export const db = Object.assign(structuredClone(EMPTY), read('store.json', {}));
export function saveDb() { write('store.json', db); }

export function logEvent(source, level, text) {
  db.events.unshift({ at: new Date().toISOString(), source, level, text });
  db.events = db.events.slice(0, 40);
}

// Minimal .env loader (no dependency): KEY=value lines, # comments.
export function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env: rely on the environment */ }
}
