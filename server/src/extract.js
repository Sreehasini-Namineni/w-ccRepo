// Claude reads each client message and returns the same `signals` the demo corpus carries
// (commitments, waiting-on, questions, opportunities, progress...). The agents in
// skyline/agents.js then reason over them exactly as they do in demo mode.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
let client = null;
const anthropic = () => (client = client || new Anthropic()); // ANTHROPIC_API_KEY, or an `ant auth login` profile

export const SIGNAL_TYPES = ['project', 'progress', 'mention', 'commit', 'status', 'fulfill', 'wait', 'question', 'answer', 'slip', 'concern', 'opp', 'deadline'];

const str = { type: 'string' };
const SIGNAL = {
  type: 'object',
  additionalProperties: false,
  required: ['t'],
  properties: {
    t: { type: 'string', enum: SIGNAL_TYPES },
    ws: str, key: str, owner: str, by: str, waiter: str, on: str, work: str, what: str, safeWhat: str,
    due: str, date: str, quote: str, asker: str, text: str, topic: str, why: str,
    supersedes: str, dependsOn: str, name: str, goLive: str,
    pct: { type: 'number' }, confidence: { type: 'number' }
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
const SYSTEM = `You read workplace messages (Outlook email and Slack) about one client implementation project and extract structured signals for Skyline, a tool that shows each client project as a city: workstreams are buildings, broken promises are fires, blocked handoffs are queues.

You get JSON with the client, the people involved (use their "id" values), the workstreams and keys already known, and a batch of messages. Return one result per message id. Most messages yield zero or one or two signals; return an empty list for logistics, greetings, newsletters and anything unrelated to the project.

Signal types and their fields:
- project {name, goLive}: the project's name and go-live date are stated.
- progress {ws, pct, quote}: a percent complete or a clear completion state ("done" = 100) for a workstream.
- mention {ws, quote}: the message does real work on a workstream without another signal. Use it so activity is counted.
- commit {key, ws, owner, what, due, quote, dependsOn?, supersedes?}: someone promises to deliver something. owner = who promised. due = when, if any date is given or implied. dependsOn = key of a deliverable this one waits on. supersedes = key of an earlier promise this one replaces (a renegotiated date).
- status {key, ws, quote}: evidence that an existing commitment (by key) is still NOT delivered.
- fulfill {key, quote}: an existing commitment (by key) was delivered.
- wait {key, waiter, on, work, what, ws, quote}: someone says they are blocked waiting on someone else. key = the deliverable they wait for (reuse its commit key); on = who owes it; waiter = who is blocked; what = the waiter's own blocked work; work = a new kebab-case key for that blocked work.
- question {key, ws, asker, text, topic, quote}: a direct question that needs an answer. text = the question, short. topic = one word (e.g. benefits, tax, payroll).
- answer {key}: an earlier question (by key) was answered.
- slip {key, ws, owner, what, quote}: something failed, broke or slipped (a failed test, a missed milestone).
- concern {key, ws, what, confidence, why, quote}: a risk nobody stated outright but you infer. confidence 0-1. why = one sentence of reasoning. Only when the evidence is real.
- opp {key, ws, what, quote}: the client asks for something new beyond the current scope (an upsell opportunity).
- deadline {ws, what, date, quote}: a milestone date (parallel run, cutover, carrier cutoff).

Rules:
- quote must be copied character for character from that message's body, at most 25 words. Skyline rejects any claim whose quote is not in the message.
- People fields (owner, waiter, on, asker, by) must be ids from the people list.
- ws is a short workstream name in sentence case, such as "Payroll setup", "Data migration" or "Benefits". Reuse a known workstream name exactly whenever one fits; create a new one only for genuinely different work.
- Reuse known keys when a message refers to the same deliverable, question or opportunity. New keys are short and kebab-case.
- Resolve relative dates ("end of next week", "by Tuesday") against the message timestamp. due is local time "YYYY-MM-DDTHH:MM" (use 17:00 when no time is given); date and goLive are "YYYY-MM-DD".
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
    results.set(r.id, (r.signals || []).filter((s) => validSignal(s, pids)));
  }
  return { results, usage, refused: false };
}

const PEOPLE_FIELDS = ['owner', 'waiter', 'on', 'asker', 'by'];
const NEEDS = { progress: ['ws', 'pct'], mention: ['ws'], commit: ['key', 'ws', 'owner', 'what'], status: ['key'], fulfill: ['key'], wait: ['key', 'waiter', 'on', 'what', 'ws'], question: ['key', 'ws', 'asker'], answer: ['key'], slip: ['key', 'ws', 'what'], concern: ['key', 'ws', 'what'], opp: ['key', 'ws', 'what'], deadline: ['ws', 'what', 'date'], project: ['name'] };
/** Drop signals that would break the agents (missing fields, people not in the directory). */
function validSignal(s, pids) {
  if (!SIGNAL_TYPES.includes(s.t)) return false;
  if ((NEEDS[s.t] || []).some((f) => s[f] === undefined || s[f] === '')) return false;
  for (const f of PEOPLE_FIELDS) if (s[f] && !pids.has(s[f])) { if (f === 'by') delete s.by; else return false; }
  if (s.t === 'wait' && !s.work) s.work = s.key + '-' + s.waiter.split('@')[0];
  if (s.t === 'concern' && typeof s.confidence !== 'number') s.confidence = 0.6;
  if (s.t === 'question' && !s.text) s.text = s.quote || 'Open question';
  return true;
}

export { Anthropic };
