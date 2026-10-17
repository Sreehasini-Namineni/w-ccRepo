// The agent pipeline. Each agent reads what earlier agents produced, posts to a shared
// bus (out.log), and hands its findings on. The pipeline is pure: same inputs, same city.
(function () {
  const SKY = window.SKY;
  const DAY = 864e5;
  const t = (s) => +new Date(typeof s === 'string' && s.length === 10 ? s + 'T12:00' : s); // date-only strings are local noon, not UTC
  const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const slug = (s) => norm(s).replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const F = SKY.fmt;
  const first = SKY.first;
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // Name variants the extraction model normalizes to one workstream.
  const ALIASES = { 'data conversion': 'Employee data import', 'conversion': 'Employee data import', 'data migration': 'Employee data import', 't&a': 'Time & attendance', 'time and attendance': 'Time & attendance', 'payroll': 'Payroll setup', 'tax': 'Tax setup' };

  SKY.AGENTS = [
    { id: 'intake', name: 'Intake', color: '#4F7B8E', role: 'Pulls new Outlook and Slack messages, applies your access rules, redacts sensitive fields and drops duplicate copies.' },
    { id: 'discovery', name: 'Cartographer', color: '#6FA8E6', role: 'Discovers clients, people and workstreams, and merges name variants so one workstream never becomes two buildings.' },
    { id: 'workstream', name: 'Surveyor', color: '#B79ED0', role: 'Tracks progress, commitments and deadlines for every workstream.' },
    { id: 'dependency', name: 'Traffic', color: '#E9C46A', role: 'Finds who is waiting on whom and builds handoff chains.' },
    { id: 'risk', name: 'Fire watch', color: '#F0552E', role: 'Spots broken commitments, unanswered questions, slips and dark workstreams, and decides fire or smoke.' },
    { id: 'opportunity', name: 'Scout', color: '#F2C230', role: 'Notices when a client asks for something new.' },
    { id: 'followup', name: 'Dispatcher', color: '#9CC2B4', role: 'Tracks the follow-ups you send, detects replies, and relights an alarm when nobody answers.' },
    { id: 'verifier', name: 'Verifier', color: '#3E4B5A', role: 'Checks every insight against the original quote, and keeps confirmed facts apart from interpretation.' }
  ];

  function accessReason(m, a) {
    if (m.src === 'slack') {
      if (!a.slack.on) return 'Slack is disconnected';
      if (m.dm) return a.slack.dms ? null : 'Direct messages are off';
      if (a.slack.channels[m.where] === undefined) return m.where + ' is not shared with Skyline';
      return a.slack.channels[m.where] ? null : m.where + ' is off';
    }
    if (!a.outlook.on) return 'Outlook is disconnected';
    if (m.src === 'meeting') return a.outlook.transcripts ? null : 'Meeting transcripts are off';
    return a.outlook.folders[m.where] === false ? 'Folder “' + m.where + '” is off' : null;
  }

  const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
  const redact = (m) => (SSN.test(m.body) ? Object.assign({}, m, { body: m.body.replace(new RegExp(SSN.source, 'g'), '•••-••-••••'), redacted: true }) : m);

  const words = (s) => norm(s).replace(/[^a-z0-9' ]/g, ' ').split(' ').filter((w) => w.length > 2);
  function bestSentence(body, quote) {
    const q = new Set(words(quote));
    let best = null, score = 0;
    body.split(/(?<=[.?!])\s+|\n/).forEach((sRaw) => {
      const s = sRaw.replace(/^[A-Z][a-z]+: /, '').trim();
      if (!s) return;
      const w = words(s);
      const hit = w.filter((x) => q.has(x)).length / Math.max(q.size, 1);
      if (hit > score) { score = hit; best = s; }
    });
    return { sentence: best, score };
  }

  SKY.runPipeline = function (input) {
    const now = t(input.now);
    const out = { now, log: [], errors: [], dedupe: [], skipped: [], redacted: 0, clients: {}, order: [], stats: {}, msgsById: {} };
    SKY.AGENTS.forEach((a) => { out.stats[a.id] = { processed: 0, errors: 0, ms: 0, status: 'ok' }; });
    const say = (from, to, text, client) => out.log.push({ from, to, text, client: client || null });
    const run = (id, fn) => {
      const t0 = performance.now();
      try { fn(); } catch (e) {
        out.stats[id].errors++; out.stats[id].status = 'failed';
        out.errors.push({ agent: id, text: e.message, retry: !!e.retry, at: now });
        say(id, 'admin', 'I failed: ' + e.message + ' The other agents carried on without me.');
      }
      out.stats[id].ms += performance.now() - t0;
    };
    const corr = (target, field) => (input.corrections || []).filter((c) => c.target === target && (!field || c.field === field)).slice(-1)[0];

    // ---------------- Intake ----------------
    const msgs = [];
    run('intake', () => {
      const seen = new Map();
      input.messages.filter((m) => t(m.ts) <= now).sort((a, b) => t(a.ts) - t(b.ts)).forEach((m) => {
        const why = accessReason(m, input.access);
        if (why) { out.skipped.push({ id: m.id, why, label: SKY.srcLabel(m) }); return; }
        const k = m.msgId || m.id;
        if (seen.has(k)) {
          out.dedupe.push({ agent: 'intake', text: '“' + m.subject + '” was in both ' + seen.get(k).where + ' and ' + m.where + '. Kept one copy.' });
          return;
        }
        seen.set(k, m);
        const mm = input.access.redact ? redact(m) : m;
        if (mm.redacted) out.redacted++;
        msgs.push(mm);
        out.msgsById[mm.id] = mm;
        out.stats.intake.processed++;
      });
      const by = (s) => msgs.filter((m) => m.src === s).length;
      say('intake', 'discovery', 'Pulled ' + msgs.length + ' messages (' + by('email') + ' email, ' + by('slack') + ' Slack, ' + by('meeting') + ' meeting segments). Skipped ' + out.skipped.length + ' under your access rules' +
        (out.dedupe.length ? ', dropped ' + plural(out.dedupe.length, 'duplicate copy').replace('copys', 'copies') : '') + (out.redacted ? ', and redacted an SSN before any agent read it.' : '.'));
    });

    // ---------------- Cartographer (discovery) ----------------
    const C = {};
    run('discovery', () => {
      const crmByDomain = {};
      SKY.crm.forEach((c) => { crmByDomain[c.domain] = c; });
      const orgOf = (pid) => { const p = SKY.people[pid]; if (!p) return null; const dom = p.email.split('@')[1]; return dom === SKY.INTERNAL_DOMAIN ? null : crmByDomain[dom] || null; };
      const resolve = (m) => {
        for (const p of [m.from].concat(m.to || [], m.cc || [])) { const c = orgOf(p); if (c) return { c, how: 'domain' }; }
        if (m.src === 'slack' && !m.dm) { const c = SKY.crm.find((x) => m.where.indexOf('#' + x.slack) === 0); if (c) return { c, how: 'channel' }; }
        const text = norm((m.subject || '') + ' ' + m.body);
        const c = SKY.crm.find((x) => text.indexOf(norm(x.short)) >= 0);
        return c ? { c, how: 'mention' } : null;
      };
      let unplaced = 0;
      msgs.forEach((m) => {
        const r = resolve(m);
        out.stats.discovery.processed++;
        if (!r) { unplaced++; return; }
        const crm = r.c;
        const c = C[crm.id] || (C[crm.id] = { id: crm.id, name: crm.name, domain: crm.domain, project: null, goLive: null, msgs: [], people: new Set(), internal: new Set(), ws: {}, wsOrder: [], how: {} });
        c.how[r.how] = (c.how[r.how] || 0) + 1;
        m.client = crm.id;
        c.msgs.push(m);
        [m.from].concat(m.to || [], m.cc || []).forEach((p) => { if (!SKY.people[p]) return; (orgOf(p) ? c.people : c.internal).add(p); });
        m.sigs = (m.signals || []).map((s) => Object.assign({}, s, { m }));
        m.sigs.forEach((s) => {
          if (s.t === 'project') { c.project = s.name; c.goLive = t(s.goLive); }
          if (s.ws) s.wsId = canon(c, s.ws);
        });
      });
      function mk(c, id, name) { c.ws[id] = { id, name, aliases: [], msgIds: new Set(), lastTs: 0, lastMsg: null, lastQuote: null, pct: null, pctMsg: null, pctQuote: null, pctTs: 0, deadlines: [] }; c.wsOrder.push(id); }
      function canon(c, name) {
        const n = norm(name);
        const hit = c.wsOrder.find((id) => norm(c.ws[id].name) === n || c.ws[id].aliases.indexOf(n) >= 0);
        if (hit) return hit;
        const target = ALIASES[n];
        if (target) {
          const tid = slug(target);
          if (!c.ws[tid]) mk(c, tid, target);
          c.ws[tid].aliases.push(n);
          out.dedupe.push({ agent: 'discovery', client: c.id, text: '“' + name + '” is the same workstream as ' + target + ' at ' + c.name + '. Merged it, so there is no duplicate building.' });
          say('discovery', 'workstream', '“' + name + '” and “' + target + '” are one workstream. Merged.', c.id);
          return tid;
        }
        mk(c, slug(name), name);
        return slug(name);
      }
      if (unplaced) say('discovery', 'admin', 'Could not tie ' + plural(unplaced, 'message') + ' to any client. Left them out of every city.');
      Object.values(C).forEach((c) => {
        say('discovery', 'all', 'Found ' + c.name + ' (' + c.domain + ') from ' + plural(c.msgs.length, 'message') + ': ' + c.wsOrder.length + ' workstreams, ' + c.people.size + ' client contacts, ' + c.internal.size + ' teammates' + (c.project ? '. Project: ' + c.project + ', go-live ' + F.day(c.goLive) + '.' : '.'), c.id);
      });
    });

    const clients = Object.values(C);

    // ---------------- Surveyor (workstreams, commitments, deadlines) ----------------
    run('workstream', () => {
      clients.forEach((c) => {
        c.commits = {};
        c.msgs.forEach((m) => m.sigs.forEach((s) => {
          out.stats.workstream.processed++;
          const ws = s.wsId ? c.ws[s.wsId] : null;
          const ts = t(m.ts);
          if (ws) {
            ws.msgIds.add(m.id);
            if (ts >= ws.lastTs) { if (ws.lastMsg !== m) ws.lastQuote = null; ws.lastTs = ts; ws.lastMsg = m; if (s.quote) ws.lastQuote = s.quote; }
          }
          if (s.t === 'progress' && ws && ts >= ws.pctTs) { ws.pct = s.pct; ws.pctMsg = m; ws.pctQuote = s.quote || null; ws.pctTs = ts; }
          if (s.t === 'deadline' && ws) ws.deadlines.push({ what: s.what, date: t(s.date), m, quote: s.quote });
          if (s.t === 'commit') {
            c.commits[s.key] = { key: s.key, wsId: s.wsId, owner: s.owner, what: s.what, due: s.due ? t(s.due) : null, dependsOn: s.dependsOn || null, supersedes: s.supersedes || null,
              ev: [{ msgId: m.id, quote: s.quote, by: s.by || m.from, role: 'The promise' }], notSeen: [], fulfilled: null, madeAt: ts };
            if (s.supersedes && c.commits[s.supersedes]) {
              c.commits[s.supersedes].supersededBy = s.key;
              say('workstream', 'risk', first(s.owner) + ' renegotiated “' + c.commits[s.supersedes].what + '”: now “' + s.what + '” by ' + F.dow(s.due) + '.', c.id);
            }
          }
          if (s.t === 'status' && c.commits[s.key]) c.commits[s.key].notSeen.push({ msgId: m.id, quote: s.quote, by: m.from, role: 'Still not delivered' });
          if (s.t === 'fulfill' && c.commits[s.key]) c.commits[s.key].fulfilled = { msgId: m.id, quote: s.quote, at: ts };
        }));
        // user corrections to commitments and progress
        Object.values(c.commits).forEach((k) => {
          const cd = corr('commit:' + k.key, 'due'); if (cd) { k.due = t(cd.value); k.corrected = 'due'; }
          const co = corr('commit:' + k.key, 'owner'); if (co) { k.owner = co.value; k.corrected = 'owner'; }
        });
        c.wsOrder.forEach((id) => {
          const ws = c.ws[id];
          ws.recent = [...ws.msgIds].filter((mid) => { const m = out.msgsById[mid]; return m && t(m.ts) > now - 7 * DAY; }).length;
          const cp = corr('ws:' + c.id + '/' + id, 'pct'); if (cp) { ws.pct = +cp.value; ws.pctCorrected = true; }
          if (ws.pct == null) ws.pct = 10;
        });
        Object.values(c.commits).filter((k) => k.due && !k.fulfilled && !k.supersededBy).forEach((k) => {
          const late = k.due < now;
          say('workstream', 'risk', first(k.owner) + ' promised “' + k.what + '” by ' + F.dow(k.due) + '. ' + (late ? (k.notSeen.length ? 'Not delivered; ' + plural(k.notSeen.length, 'message') + ' since confirm it is still outstanding.' : 'No delivery seen in any connected source.') : 'Not due yet.'), c.id);
        });
      });
    });

    // ---------------- Traffic (dependencies, handoff chains) ----------------
    run('dependency', () => {
      clients.forEach((c) => {
        const edges = [], byId = {};
        c.msgs.forEach((m) => m.sigs.filter((s) => s.t === 'wait').forEach((s) => {
          out.stats.dependency.processed++;
          let key = s.key;
          while (c.commits[key] && c.commits[key].supersededBy) key = c.commits[key].supersededBy;
          const id = s.waiter + '>' + key;
          const ev = { msgId: m.id, quote: s.quote, by: m.from, role: 'Waiting' };
          if (byId[id]) {
            byId[id].ev.push(ev);
            out.dedupe.push({ agent: 'dependency', client: c.id, text: first(s.waiter) + ' waiting on ' + first(s.on) + ' was reported again (' + SKY.srcLabel(m) + '). Same handoff, counted once.' });
            return;
          }
          const e = { waiter: s.waiter, on: s.on, key, work: s.work, what: s.what, wsId: s.wsId, ev: [ev], movedFrom: key !== s.key ? s.key : null };
          byId[id] = e; edges.push(e);
        }));
        // a fulfilled commitment clears the cars queued behind it
        const live = edges.filter((e) => {
          const k = c.commits[e.key];
          if (k && k.fulfilled) { say('dependency', 'risk', first(e.waiter) + ' is unblocked: ' + (k.what || e.key) + ' arrived. Work can move again.', c.id); return false; }
          return true;
        });
        const works = new Set(live.map((e) => e.work));
        const roots = [...new Set(live.map((e) => e.key))].filter((k) => !works.has(k));
        c.jams = [];
        roots.forEach((rk) => {
          const root = c.commits[rk];
          if (!root || !root.due) return; // nothing promised with a date, so this is ordinary flow
          const cars = [];
          const q = [rk];
          const seenK = new Set();
          while (q.length) {
            const k = q.shift();
            if (seenK.has(k)) continue;
            seenK.add(k);
            live.filter((e) => e.key === k).forEach((e) => { cars.push(e); q.push(e.work); });
          }
          const moved = cars.filter((e) => e.movedFrom);
          if (moved.length) say('dependency', 'risk', 'Moved ' + plural(moved.length, 'handoff') + ' from the old promise to “' + root.what + '”.', c.id);
          c.jams.push({ id: 'jam:' + c.id + ':' + rk, client: c.id, rootKey: rk, owner: root.owner, wsId: root.wsId, what: root.what, cars, late: root.due < now });
          say('dependency', 'risk', plural(cars.length, 'person') .replace('persons', 'people') + ' queued behind “' + root.what + '”: ' + [root.owner].concat(cars.map((e) => e.waiter)).map(first).join(' → ') + '.', c.id);
        });
      });
    });

    // ---------------- Fire watch (risks) ----------------
    run('risk', () => {
      clients.forEach((c) => {
        c.issues = [];
        const add = (i) => { i.client = c.id; i.status = 'open'; c.issues.push(i); out.stats.risk.processed++; };
        Object.values(c.commits).forEach((k) => {
          if (k.fulfilled || !k.due) return;
          if (k.supersededBy) {
            const nk = c.commits[k.supersededBy];
            if (nk && !nk.fulfilled && nk.due >= now) add({ id: 'commit:' + k.key, type: 'commit', kind: 'fire', key: k.key, wsId: k.wsId, owner: k.owner, title: k.what + ' was renegotiated', what: k.what,
              basis: 'confirmed', confidence: 1, evidence: k.ev.concat(nk.ev.map((e) => Object.assign({}, e, { role: 'New promise' }))), facts: ['New date: ' + nk.what + ' by ' + F.dow(nk.due)], chain: [], renegotiated: nk });
            return;
          }
          if (k.due >= now) return;
          const jam = c.jams.find((j) => j.rootKey === k.key);
          const waiters = jam ? jam.cars.length : 0;
          const daysLate = Math.max(1, Math.round((now - k.due) / DAY));
          const prior = Object.values(c.commits).find((x) => x.supersededBy === k.key);
          const chain = [{ text: k.what + ' · ' + daysLate + 'd late', tone: 'fire', basis: 'confirmed' }];
          const downstream = [];
          if (jam) {
            jam.cars.forEach((e) => chain.push({ text: first(e.waiter) + ' blocked: ' + e.what, tone: 'jam', basis: 'confirmed' }));
            const wsIds = new Set(jam.cars.map((e) => e.wsId));
            wsIds.forEach((id) => c.ws[id] && c.ws[id].deadlines.filter((d) => d.date > now).forEach((d) => { downstream.push(d); chain.push({ text: d.what + ' · ' + F.day(d.date) + ' at risk', tone: 'grey', basis: 'inferred', confidence: 0.78 }); }));
          }
          if (c.goLive && waiters) chain.push({ text: 'Go-live ' + F.day(c.goLive) + ' at risk', tone: 'grey', basis: 'inferred', confidence: Math.min(0.9, Math.round((0.4 + daysLate * 0.04 + waiters * 0.05) * 100) / 100) });
          const ev = (prior ? prior.ev.slice(0, 1) : []).concat(k.ev, k.notSeen.slice(-2));
          add({ id: 'commit:' + k.key, type: 'commit', kind: waiters ? 'fire' : 'smoke', key: k.key, wsId: k.wsId, owner: k.owner, what: k.what, daysLate, waiters, jamId: jam ? jam.id : null, downstream,
            title: k.what + ' is ' + plural(daysLate, 'day') + ' late' + (prior ? ' (the renegotiated date, too)' : ''),
            basis: 'confirmed', confidence: 1, evidence: ev, chain,
            facts: [first(k.owner) + ' promised it for ' + F.dow(k.due) + (k.corrected === 'due' ? ' (date corrected by you)' : ''), k.notSeen.length ? 'Still outstanding as of ' + SKY.srcLabel(out.msgsById[k.notSeen[k.notSeen.length - 1].msgId]) : 'No delivery seen in any connected source', waiters ? plural(waiters, 'person').replace('persons', 'people') + ' waiting behind it' : 'Nothing is waiting on it yet'] });
          say('risk', 'verifier', 'Proposing ' + (waiters ? 'FIRE' : 'SMOKE') + ' on ' + c.ws[k.wsId].name + ': “' + k.what + '” is ' + plural(daysLate, 'day') + ' late' + (waiters ? ' with ' + waiters + ' waiting' : '') + '. Please check the evidence.', c.id);
        });
        const answered = new Set();
        c.msgs.forEach((m) => m.sigs.forEach((s) => { if (s.t === 'answer') answered.add(s.key); }));
        c.msgs.forEach((m) => m.sigs.forEach((s) => {
          if (s.t === 'question' && !answered.has(s.key)) {
            const age = Math.floor((now - t(m.ts)) / DAY);
            if (age < 3) return;
            add({ id: 'q:' + s.key, type: 'question', kind: 'smoke', key: s.key, wsId: s.wsId, owner: s.asker, asker: s.asker, topic: s.topic, text: s.text, title: first(s.asker) + '’s question is unanswered after ' + plural(age, 'day'),
              basis: 'confirmed', confidence: 1, evidence: [{ msgId: m.id, quote: s.quote, by: m.from, role: 'The question' }], facts: ['Asked ' + F.dow(m.ts), 'No reply in any connected thread'], chain: [] });
            say('risk', 'verifier', 'Proposing SMOKE on ' + c.ws[s.wsId].name + ': ' + first(s.asker) + ' asked “' + s.text + '” ' + age + ' days ago with no answer.', c.id);
          }
          if (s.t === 'slip') {
            add({ id: 'slip:' + s.key, type: 'slip', kind: 'smoke', key: s.key, wsId: s.wsId, owner: s.owner, title: s.what, basis: 'confirmed', confidence: 1,
              evidence: [{ msgId: m.id, quote: s.quote, by: m.from, role: 'The slip' }], facts: ['Reported ' + F.dow(m.ts), 'No new test date yet'], chain: [] });
            say('risk', 'verifier', 'Proposing SMOKE on ' + c.ws[s.wsId].name + ': ' + s.what.toLowerCase() + '.', c.id);
          }
          if (s.t === 'concern') {
            add({ id: 'concern:' + s.key, type: 'concern', kind: 'watch', key: s.key, wsId: s.wsId, owner: s.by || m.from, title: s.what, safeWhat: s.safeWhat, why: s.why,
              basis: 'inferred', confidence: s.confidence, evidence: [{ msgId: m.id, quote: s.quote, by: s.by || m.from, role: 'What was said' }], facts: [], chain: [] });
            say('risk', 'verifier', 'Possible risk, my interpretation: “' + s.what + '”. Confidence ' + Math.round(s.confidence * 100) + '%.', c.id);
          }
        }));
        c.wsOrder.forEach((id) => {
          const ws = c.ws[id];
          const quiet = Math.floor((now - ws.lastTs) / DAY);
          if (quiet >= 7) {
            add({ id: 'quiet:' + c.id + ':' + id, type: 'quiet', kind: 'quiet', wsId: id, owner: ws.lastMsg ? ws.lastMsg.from : null, title: 'No one has mentioned ' + ws.name.toLowerCase() + ' in ' + quiet + ' days',
              basis: 'confirmed', confidence: 1, evidence: ws.lastMsg ? [{ msgId: ws.lastMsg.id, quote: ws.lastQuote, by: ws.lastMsg.from, role: 'Last mention' }] : [], facts: ['0 messages in the last 7 days', 'Last mention ' + F.dow(ws.lastTs)], chain: [] });
            say('risk', 'all', ws.name + ' has gone dark: last mention ' + F.day(ws.lastTs) + '. Turning the lights off.', c.id);
          }
        });
      });
    });

    // ---------------- Scout (opportunities) ----------------
    run('opportunity', () => {
      clients.forEach((c) => { c.opps = []; });
      clients.forEach((c) => {
        const by = {};
        c.msgs.forEach((m) => m.sigs.filter((s) => s.t === 'opp').forEach((s) => {
          out.stats.opportunity.processed++;
          if (input.faults && input.faults.opportunity) { const e = new Error('Model call timed out while classifying ' + SKY.srcLabel(m) + '. The message is queued for retry.'); e.retry = true; throw e; }
          const ev = { msgId: m.id, quote: s.quote, by: m.from, role: 'Client asked' };
          if (by[s.key]) {
            by[s.key].ev.push(ev); by[s.key].title = s.what;
            out.dedupe.push({ agent: 'opportunity', client: c.id, text: 'New mention of “' + s.what + '” merged into the existing opportunity instead of opening a second one.' });
            say('opportunity', 'verifier', 'The opportunity grew: “' + s.what + '”. Merged into the existing one.', c.id);
            return;
          }
          const o = { id: 'opp:' + s.key, key: s.key, wsId: s.wsId, owner: m.from, title: s.what, ev: [ev], basis: 'confirmed', confidence: 1, client: c.id };
          by[s.key] = o; c.opps.push(o);
          say('opportunity', 'verifier', first(m.from) + ' asked for something new: “' + s.what + '”.', c.id);
        }));
      });
    });

    // ---------------- Dispatcher (follow-ups, replies, relighting) ----------------
    run('followup', () => {
      clients.forEach((c) => {
        c.issues.forEach((i) => {
          const f = input.followUps[i.id];
          if (i.renegotiated) {
            i.status = 'contained';
            i.note = first(i.owner) + ' replied with a new date: ' + i.renegotiated.what.toLowerCase() + ' by ' + F.dow(i.renegotiated.due) + '. Skyline relights the alarm if it slips.';
            say('followup', 'risk', first(i.owner) + ' replied. Downgrading the fire to contained and watching the new date.', c.id);
            return;
          }
          if (!f) return;
          out.stats.followup.processed++;
          const reply = c.msgs.find((m) => t(m.ts) > t(f.sentAt) && m.from === f.to && m.sigs.some((s) => s.t === 'reply' && s.ref === i.id));
          i.followUp = f;
          if (reply) { i.status = 'contained'; i.reply = reply; i.note = first(f.to) + ' replied ' + F.dt(reply.ts) + '.'; return; }
          if (now < t(f.watchUntil)) {
            i.status = 'contained';
            i.note = f.kind === 'meeting'
              ? 'Meeting with ' + first(f.to) + ' booked for ' + F.dt(f.meetingAt) + '. Skyline holds this as contained and relights it if nothing has moved by ' + F.dt(f.watchUntil) + '.'
              : 'Follow-up sent to ' + first(f.to) + ' ' + F.dt(f.sentAt) + '. Skyline relights the alarm if there is no reply by ' + F.dt(f.watchUntil) + '.';
            say('followup', 'risk', 'Follow-up to ' + first(f.to) + ' is out. Holding “' + i.title + '” as contained until ' + F.dt(f.watchUntil) + '.', c.id);
          } else {
            i.status = 'relit';
            i.note = f.kind === 'meeting'
              ? 'The meeting with ' + first(f.to) + ' on ' + F.dt(f.meetingAt) + ' came and went, and nothing has moved. Alarm relit.'
              : 'No reply from ' + first(f.to) + ' since ' + F.dt(f.sentAt) + '. Alarm relit.';
            say('followup', 'all', 'No reply from ' + first(f.to) + ' by ' + F.dt(f.watchUntil) + '. Relighting “' + i.title + '”.', c.id);
          }
        });
        c.opps.forEach((o) => { const f = input.followUps[o.id]; if (f) o.sentTo = f; });
      });
    });

    // ---------------- Verifier ----------------
    run('verifier', () => {
      clients.forEach((c) => {
        let ok = 0, rewritten = 0, rejected = 0;
        const check = (item, kind) => {
          const evs = item.evidence || item.ev || [];
          for (const e of evs) {
            out.stats.verifier.processed++;
            const m = out.msgsById[e.msgId];
            if (!m || !e.quote) continue;
            if (norm(m.body).indexOf(norm(e.quote)) >= 0) { e.verified = true; continue; }
            const b = bestSentence(m.body, e.quote);
            if (b.score >= 0.35) {
              say('verifier', 'risk', 'The quote “' + e.quote + '” is not in ' + SKY.srcLabel(m) + '. Closest real line: “' + b.sentence + '”. Rewrote the insight' + (item.safeWhat ? ' as “' + item.safeWhat + '”' : '') + ' and marked it INFERRED.', c.id);
              e.quote = b.sentence; e.verified = true; e.rewritten = true;
              item.basis = 'inferred';
              item.confidence = Math.round((item.confidence || 1) * 0.8 * 100) / 100;
              if (item.safeWhat) item.title = item.safeWhat;
              item.rewritten = true; rewritten++;
            } else {
              say('verifier', 'risk', 'Rejected “' + (item.title || '') + '”: nothing in ' + SKY.srcLabel(m) + ' supports it.', c.id);
              item.rejected = true; rejected++;
              return;
            }
          }
          if (!item.rewritten) ok++;
          if (kind === 'fire' && !item.rewritten) {
            const pe = evs.find((e) => e.role === 'The promise');
            if (pe) say('verifier', 'risk', 'Confirmed “' + item.title + '”: the promise is quoted word for word in ' + SKY.srcLabel(out.msgsById[pe.msgId]) + '.', c.id);
          }
        };
        c.issues.forEach((i) => check(i, i.kind));
        c.opps.forEach((o) => check(o, 'opp'));
        (c.jams || []).forEach((j) => j.cars.forEach((e) => check(e, 'car')));
        c.issues = c.issues.filter((i) => !i.rejected);
        c.opps = c.opps.filter((o) => !o.rejected);
        say('verifier', 'all', 'Checked ' + (ok + rewritten + rejected) + ' findings for ' + c.name + ' against the original messages: ' + ok + ' confirmed word for word' + (rewritten ? ', ' + rewritten + ' rewritten as interpretation' : '') + (rejected ? ', ' + rejected + ' rejected' : '') + '.', c.id);
      });
    });

    // ---------------- user corrections + city state ----------------
    clients.forEach((c) => {
      c.corrected = [];
      c.issues = c.issues.filter((i) => {
        const x = corr('issue:' + i.id);
        if (x && (x.field === 'resolved' || x.field === 'dismiss')) { c.corrected.push({ id: x.id, wsId: i.wsId, title: i.title, field: x.field, note: x.note }); return false; }
        return true;
      });
      c.opps = c.opps.filter((o) => {
        const x = corr('issue:' + o.id);
        if (x) { c.corrected.push({ id: x.id, wsId: o.wsId, title: o.title, field: x.field, note: x.note }); return false; }
        return true;
      });
      (input.corrections || []).filter((x) => x.target.indexOf('commit:') === 0 || x.target.indexOf('ws:' + c.id + '/') === 0).forEach((x) => {
        const k = c.commits[x.target.slice(7)];
        if (x.target.indexOf('commit:') === 0 && !k) return;
        c.corrected.push({ id: x.id, wsId: k ? k.wsId : x.target.split('/')[1], title: x.label, field: x.field, note: x.note });
      });
      (c.jams || []).forEach((j) => {
        const root = c.issues.find((i) => i.type === 'commit' && (i.key === j.rootKey || (i.renegotiated && i.renegotiated.key === j.rootKey)));
        j.issueId = root ? root.id : null;
        j.contained = !!root && root.status === 'contained';
        j.dismissed = !root && j.late;
      });
      c.jams = (c.jams || []).filter((j) => !j.dismissed);
      const ws = c.wsOrder.map((id) => {
        const w = c.ws[id];
        const iss = c.issues.filter((i) => i.wsId === id);
        const open = (i) => i.status === 'open' || i.status === 'relit';
        let status = 'ok';
        if (iss.some((i) => i.kind === 'fire' && open(i))) status = 'fire';
        else if (iss.some((i) => i.kind === 'fire' && i.status === 'contained')) status = 'contained';
        else if (iss.some((i) => i.kind === 'smoke' && open(i))) status = 'smoke';
        else if (iss.some((i) => i.kind === 'quiet')) status = 'quiet';
        else if (c.opps.some((o) => o.wsId === id)) status = 'opp';
        return { id, name: w.name, aliases: w.aliases, pct: w.pct, pctCorrected: !!w.pctCorrected, pctMsg: w.pctMsg, pctQuote: w.pctQuote, recent: w.recent, lastTs: w.lastTs, deadlines: w.deadlines,
          status, relit: iss.some((i) => i.status === 'relit'), opp: c.opps.some((o) => o.wsId === id), issues: iss };
      });
      const counts = {
        fire: ws.filter((w) => w.status === 'fire').length,
        smoke: ws.filter((w) => w.status === 'smoke').length,
        quiet: ws.filter((w) => w.status === 'quiet').length,
        contained: ws.filter((w) => w.status === 'contained').length,
        jam: c.jams.length,
        waiting: c.jams.reduce((n, j) => n + j.cars.length, 0),
        opp: c.opps.length
      };
      out.clients[c.id] = {
        id: c.id, name: c.name, domain: c.domain, project: c.project, goLive: c.goLive, how: c.how,
        people: [...c.people], internal: [...c.internal], msgCount: c.msgs.length,
        ws, issues: c.issues, jams: c.jams, opps: c.opps, commits: c.commits, corrected: c.corrected, counts,
        score: counts.fire * 6 + counts.jam * 3 + counts.waiting + counts.smoke * 2 + counts.quiet
      };
    });
    out.order = Object.values(out.clients).sort((a, b) => b.score - a.score).map((c) => c.id);
    return out;
  };
})();
