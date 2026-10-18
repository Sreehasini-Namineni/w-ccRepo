// Claude reads each client message and returns the same `signals` the demo corpus carries
// (commitments, waiting-on, questions, opportunities, progress...). The agents in
// skyline/agents.js then reason over them exactly as they do in demo mode.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
let client = null;
const anthropic = () => (client = client || new Anthropic()); // ANTHROPIC_API_KEY, or an `ant auth login` profile

export const SIGNAL_TYPES = ['project', 'progress', 'mention', 'commit', 'status', 'fulfill', 'wait', 'question', 'answer', 'slip', 'concern', 'opp', 'deadline'];

const str = { type: 'string' };
const num = { type: 'number' };
// Every field is required (empty string or 0 when unused). Optional fields multiply the
// grammar the API has to compile, and ~20 of them made the schema "too complex".
const FIELDS = ['t', 'ws', 'key', 'who', 'on', 'what', 'date', 'quote', 'work', 'supersedes', 'topic', 'why', 'pct', 'confidence'];
const SIGNAL = {
  type: 'object',
  additionalProperties: false,
  required: FIELDS,
  properties: {
    t: { type: 'string', enum: SIGNAL_TYPES },
    ws: str, key: str, who: str, on: str, what: str, date: str, quote: str, work: str, supersedes: str, topic: str, why: str,
    pct: num, confidence: num
  }
};
const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'signals'], properties: { id: str, signals: { type: 'array', items: SIGNAL } } }
    }
  }
};

// Stable across every request so it can be cached.
const SYSTEM = `You read workplace messages (email and Slack) about one client implementation project and extract structured signals for Skyline, a tool that shows each client project as a city: workstreams are buildings, broken promises are fires, blocked handoffs are queues.

You get JSON with the client, the people involved (use their "id" values), the workstreams and keys already known, and a batch of messages. Return one result per message id. Most messages yield zero or one or two signals; return an empty list for logistics, greetings, newsletters and anything unrelated to the project.

Every signal has the same fields: t, ws, key, who, on, what, date, quote, work, supersedes, topic, why, pct, confidence. Fill the ones a type uses and leave the rest as "" (or 0 for pct and confidence).

Signal types (t) and the fields they use:
- project {what = project name, date = go-live}: the project's name and go-live date are stated.
- progress {ws, pct, quote}: a percent complete or a clear completion state ("done" = 100) for a workstream.
- mention {ws, quote}: the message does real work on a workstream without another signal. Use it so activity is counted.
- commit {key, ws, who, what, date, quote, supersedes}: someone promises to deliver something. who = who promised. date = when, if any date is given or implied. supersedes = key of an earlier promise this one replaces (a renegotiated date).
- status {key, ws, quote}: evidence that an existing commitment (by key) is still NOT delivered.
- fulfill {key, quote}: an existing commitment (by key) was delivered.
- wait {key, who, on, work, what, ws, quote}: someone says they are blocked waiting on someone else. key = the deliverable they wait for (reuse its commit key); on = who owes it; who = who is blocked; what = the blocked person's own work; work = a new kebab-case key for that blocked work.
- question {key, ws, who, what, topic, quote}: a direct question that needs an answer. who = who asked. what = the question, short. topic = one word (e.g. benefits, tax, payroll).
- answer {key}: an earlier question (by key) was answered.
- slip {key, ws, who, what, quote}: something failed, broke or slipped (a failed test, a missed milestone). who = who reported or owns it.
- concern {key, ws, who, what, confidence, why, quote}: a risk nobody stated outright but you infer. who = who said the quoted line. confidence 0-1. why = one sentence of reasoning. Only when the evidence is real.
- opp {key, ws, what, quote}: the client asks for something new beyond the current scope (an upsell opportunity).
- deadline {ws, what, date, quote}: a milestone date (parallel run, cutover, carrier cutoff).

Rules:
- quote must be copied character for character from that message's body, at most 25 words. Skyline rejects any claim whose quote is not in the message.
- who and on must be ids from the people list.
- ws is a short workstream name in sentence case, such as "Payroll setup", "Data migration" or "Benefits". Reuse a known workstream name exactly whenever one fits; create a new one only for genuinely different work.
- Reuse known keys when a message refers to the same deliverable, question or opportunity. New keys are short and kebab-case.
- Resolve relative dates ("end of next week", "by Tuesday") against the message timestamp. For commit, date is local time "YYYY-MM-DDTHH:MM" (use 17:00 when no time is given); for project and deadline it is "YYYY-MM-DD".
- Extract only what the message supports. Do not guess owners or dates.`;

/**
 * @param {object} ctx { client, today, people, workstreams, keys, messages }
 * @returns {Promise<{results: Map<string, object[]>, usage: object, refused: boolean}>}
 */
export async function extractBatch(ctx) {
  const payload = {
    client: ctx.client, today: ctx.today,
    people: ctx.people.map((p) => ({ id: p.id, name: p.name, org: p.org })),
    known_workstreams: ctx.workstreams, known_keys: ctx.keys,
    messages: ctx.messages.map((m) => ({ id: m.id, source: m.src, where: m.where, from: m.from, to: m.to, timestamp: m.ts, subject: m.subject, body: m.body }))
  };
  const res = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // On a safety decline, the API re-runs the request on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: JSON.stringify(payload) }]
  });
  const usage = res.usage || {};
  const results = new Map();
  if (res.stop_reason === 'refusal') return { results, usage, refused: true };
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);
  const ids = new Set(ctx.messages.map((m) => m.id));
  const pids = new Set(ctx.people.map((p) => p.id));
  for (const r of parsed.results || []) {
    if (!ids.has(r.id)) continue;
    results.set(r.id, (r.signals || []).map((s) => toAgentSignal(s, pids)).filter(Boolean));
  }
  return { results, usage, refused: false };
}

const NEEDS = { progress: ['ws'], mention: ['ws'], commit: ['key', 'ws', 'who', 'what'], status: ['key'], fulfill: ['key'], wait: ['key', 'who', 'on', 'what', 'ws'], question: ['key', 'ws', 'who'], answer: ['key'], slip: ['key', 'ws', 'what'], concern: ['key', 'ws', 'what'], opp: ['key', 'ws', 'what'], deadline: ['ws', 'what', 'date'], project: ['what'] };
/**
 * Turns Claude's compact signal into the shape the agents read (the same shape as the
 * demo corpus), or null if it's missing something the agents need.
 */
export function toAgentSignal(raw, pids) {
  if (!SIGNAL_TYPES.includes(raw.t)) return null;
  if ((NEEDS[raw.t] || []).some((f) => !raw[f])) return null;
  for (const f of ['who', 'on']) if (raw[f] && !pids.has(raw[f])) { if (raw.t === 'concern' && f === 'who') raw.who = ''; else return null; }
  const s = { t: raw.t };
  ['ws', 'key', 'quote'].forEach((f) => { if (raw[f]) s[f] = raw[f]; });
  switch (raw.t) {
    case 'project': s.name = raw.what; if (raw.date) s.goLive = raw.date.slice(0, 10); break;
    case 'progress': s.pct = Math.max(0, Math.min(100, Math.round(raw.pct || 0))); break;
    case 'commit': s.owner = raw.who; s.what = raw.what; if (raw.date) s.due = raw.date.length === 10 ? raw.date + 'T17:00' : raw.date.slice(0, 16); if (raw.supersedes) s.supersedes = raw.supersedes; break;
    case 'wait': s.waiter = raw.who; s.on = raw.on; s.what = raw.what; s.work = raw.work || raw.key + '-' + raw.who.split('@')[0]; break;
    case 'question': s.asker = raw.who; s.text = raw.what || raw.quote || 'Open question'; if (raw.topic) s.topic = raw.topic; break;
    case 'slip': s.what = raw.what; if (raw.who) s.owner = raw.who; break;
    case 'concern': s.what = raw.what; s.confidence = raw.confidence > 0 && raw.confidence <= 1 ? raw.confidence : 0.6; if (raw.why) s.why = raw.why; if (raw.who) s.by = raw.who; break;
    case 'opp': s.what = raw.what; break;
    case 'deadline': s.what = raw.what; s.date = raw.date.slice(0, 10); break;
  }
  return s;
}

export { Anthropic };
