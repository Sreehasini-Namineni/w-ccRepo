// UI: state, views, evidence, drafts, corrections and the demo clock.
(function () {
  const SKY = window.SKY;
  const F = SKY.fmt;
  const DAY = 864e5;
  const INK = '#26303A';
  const t = (s) => +new Date(s);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const first = SKY.first, pname = SKY.pname;
  const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const plural = (n, w, p) => n + ' ' + (n === 1 ? w : p || w + 's');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // A person's name that shows their role and email on hover or focus.
  const who = (id, short) => (SKY.people[id]
    ? '<span class="who" tabindex="0" data-email="' + esc(SKY.people[id].email) + '" data-role="' + esc(SKY.people[id].role) + '">' + esc(short ? first(id) : pname(id)) + '</span>'
    : esc(id));
  const qend = (q) => (/[.?!]$/.test(q) ? '' : '.'); // avoid “…?”.

  const nextBizMorning = (now, hh, mm) => {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    d.setHours(hh == null ? 9 : hh, mm || 0, 0, 0);
    return F.iso(d);
  };
  const addBizDays = (now, n) => { let d = new Date(now); while (n > 0) { d = new Date(nextBizMorning(d)); n--; } return d; };

  // ---------------- data sources: the demo corpus or the live server ----------------
  // Demo mode uses the mock corpus in data.js. Live mode swaps in a snapshot from
  // server/ (real Gmail + Slack messages with Claude-extracted signals). The agents
  // and the city run unchanged on either.
  const DEMO = { messages: SKY.messages, people: SKY.people, crm: SKY.crm, internal: SKY.INTERNAL_DOMAIN, access: SKY.defaultAccess, shared: SKY.sharedChannels, events: SKY.connectorEvents };
  const SERVED = location.protocol === 'http:' || location.protocol === 'https:';
  let LIVE = null; // latest server snapshot
  const ME = () => SKY.ME || 'you';
  const prefs = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } } };
  function applyDemo() {
    Object.assign(SKY, { messages: DEMO.messages, people: DEMO.people, crm: DEMO.crm, INTERNAL_DOMAIN: DEMO.internal, defaultAccess: DEMO.access, sharedChannels: DEMO.shared, connectorEvents: DEMO.events, ME: 'you' });
    LIVE = null;
  }
  function applyLive(snap) {
    LIVE = snap;
    Object.assign(SKY, { messages: snap.messages, people: snap.people, crm: snap.crm, INTERNAL_DOMAIN: snap.internalDomain || 'internal.invalid', defaultAccess: snap.access, sharedChannels: snap.sharedChannels, connectorEvents: snap.events, ME: snap.meId || 'me' });
    if (!SKY.people[SKY.ME]) SKY.people[SKY.ME] = { name: 'Me', email: snap.meId || '', role: 'You', you: true };
  }
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'The Skyline server returned ' + r.status);
    return j;
  }
  const isLive = () => S && S.mode === 'live';

  // ---------------- state ----------------
  let S;
  function fresh(mode) {
    return {
      mode: mode || 'demo', now: mode === 'live' ? F.iso(new Date()) : SKY.DEMO_START, messages: SKY.messages.slice(), access: clone(SKY.defaultAccess),
      corrections: [], followUps: {}, faults: {}, view: 'city', client: 'brightline', sel: null, profile: 'consultant',
      runs: [], model: null, toast: null, live: null, modal: null, demoOpen: false, busScope: 'client', citySig: null, detail: 'open', editPct: null, archived: {}
    };
  }

  const active = () => S.model.order.filter((id) => !S.archived[id]); // archived projects leave the region
  const cl = () => S.model.clients[S.client] || S.model.clients[active()[0]];
  const msg = (id) => S.model.msgsById[id] || S.messages.find((m) => m.id === id);
  const wsById = (c, id) => c.ws.find((w) => w.id === id);
  const allIssues = (c) => c.issues;
  const findItem = (id) => {
    for (const c of Object.values(S.model.clients)) {
      const i = c.issues.find((x) => x.id === id) || c.opps.find((x) => x.id === id) || c.jams.find((x) => x.id === id);
      if (i) return { c, i };
    }
    return null;
  };

  // ---------------- pipeline + diff ----------------
  function recompute(trigger, incoming) {
    const prev = S.model;
    const m = SKY.runPipeline({ messages: S.messages, now: S.now, access: S.access, corrections: S.corrections, followUps: S.followUps, faults: S.faults, archived: S.archived });
    S.model = m;
    const key = (e) => e.client + '|' + e.from + '|' + e.text;
    const prevKeys = new Set(prev ? prev.log.map(key) : []);
    const entries = prev ? m.log.filter((e) => !prevKeys.has(key(e))) : m.log;
    S.runs.unshift({ trigger, at: S.now, entries });
    S.runs = S.runs.slice(0, 20);
    if (!active().length) { S.toast = null; if (S.view === 'city') S.view = m.order.length ? 'archives' : 'sources'; render(); return []; }
    if (!m.clients[S.client] || S.archived[S.client]) S.client = active()[0];
    let ev = [];
    if (prev && prev.order.length) {
      ev = diff(prev, m);
      const mine = ev.filter((e) => e.client === S.client);
      const pick = mine[0] || ev[0];
      if (pick) S.toast = pick;
      else if (incoming) S.toast = { tone: 'ok', title: 'New ' + (incoming.src === 'slack' ? 'Slack message' : incoming.src === 'meeting' ? 'meeting note' : 'email') + ' from ' + first(incoming.from), body: 'Processed by all agents. Added as evidence; the city did not need to change.' };
    } else {
      S.toast = initialToast();
    }
    if (S.toast) S.toast.at = S.now;
    if (!selExists()) S.sel = defaultSel();
    render();
    return ev;
  }

  function initialToast() {
    const c = cl();
    const fire = c.issues.find((i) => i.kind === 'fire' && i.status === 'open');
    if (!fire) return { tone: 'ok', title: 'City is up to date', body: 'Skyline processed ' + S.model.stats.intake.processed + ' messages.' };
    const last = fire.evidence.filter((e) => e.role === 'Still not delivered').slice(-1)[0];
    const prom = fire.evidence.find((e) => e.role === 'The promise');
    return { tone: 'fire', client: c.id, title: wsById(c, fire.wsId).name + ' caught fire',
      body: (last ? SKY.srcLabel(msg(last.msgId)) + ': “' + last.quote + '” matched a promise from ' + F.day(msg(prom.msgId).ts) + '.' : fire.title) };
  }

  function diff(a, b) {
    const ev = [];
    Object.values(b.clients).forEach((cb) => {
      const ca = a.clients[cb.id];
      if (!ca) return;
      cb.ws.forEach((w) => {
        const pw = ca.ws.find((x) => x.id === w.id);
        if (!pw || (pw.status === w.status && pw.relit === w.relit)) return;
        const fire = w.issues.find((i) => i.kind === 'fire') || w.issues[0];
        const e = { client: cb.id, sel: 'ws:' + w.id };
        if (w.status === 'fire' && (pw.status === 'contained' || w.relit)) ev.push(Object.assign(e, { tone: 'fire', title: 'Alarm relit at ' + w.name, body: fire ? (fire.note || fire.title) : '' }));
        else if (w.status === 'fire') ev.push(Object.assign(e, { tone: 'fire', title: w.name + ' caught fire', body: fire ? fire.title : '' }));
        else if (w.status === 'contained') ev.push(Object.assign(e, { tone: 'ok', title: 'Fire contained at ' + w.name, body: fire ? fire.note : '' }));
        else if (pw.status === 'fire' || pw.status === 'contained') ev.push(Object.assign(e, { tone: 'ok', title: 'Fire out at ' + w.name, body: 'The promise was delivered. Skyline cleared the alarm and the traffic behind it.' }));
        else if (pw.status === 'quiet') ev.push(Object.assign(e, { tone: 'ok', title: 'Lights back on at ' + w.name, body: 'Someone is talking about it again.' }));
        else if (w.status === 'smoke') ev.push(Object.assign(e, { tone: 'smoke', title: 'Smoke at ' + w.name, body: fire ? fire.title : '' }));
        else if (w.status === 'done') ev.push(Object.assign(e, { tone: 'ok', title: w.name + ' is done', body: 'It reached 100%.' }));
        else if (w.status === 'quiet') ev.push(Object.assign(e, { tone: 'quiet', title: 'Lights off at ' + w.name, body: fire ? fire.title : '' }));
      });
      if (cb.done && !ca.done) ev.unshift({ client: cb.id, tone: 'ok', title: cb.name + ' is complete', body: 'Every building is at 100%. You can archive the project from the top-left panel or the Region page.' });
      cb.issues.forEach((i) => {
        const pi = ca.issues.find((x) => x.id === i.id);
        if (pi && ((i.renegotiated && !pi.renegotiated) || (i.reply && !pi.reply))) ev.push({ client: cb.id, sel: 'ws:' + i.wsId, tone: 'ok', title: first(i.owner) + ' replied', body: i.note });
      });
      cb.opps.forEach((o) => {
        const po = ca.opps.find((x) => x.id === o.id);
        if (!po) ev.push({ client: cb.id, sel: 'ws:' + o.wsId, tone: 'opp', title: 'New opportunity at ' + cb.name, body: o.title });
        else if (po.title !== o.title) ev.push({ client: cb.id, sel: 'ws:' + o.wsId, tone: 'opp', title: 'Opportunity grew', body: o.title + '. Merged with the earlier request, not duplicated.' });
      });
      ca.jams.forEach((j) => { if (!cb.jams.find((x) => x.id === j.id || x.wsId === j.wsId)) ev.push({ client: cb.id, tone: 'ok', title: 'Unblocked at ' + cb.name, body: plural(j.cars.length, 'person', 'people') + ' can start work again.' }); });
    });
    const rank = { fire: 0, ok: 1, opp: 2, smoke: 3, quiet: 4 };
    return ev.sort((x, y) => rank[x.tone] - rank[y.tone]);
  }

  function selExists() {
    if (!S.sel) return false;
    const c = cl();
    return S.sel.indexOf('ws:') === 0 && !!wsById(c, S.sel.slice(3));
  }
  function defaultSel() {
    const c = cl();
    const f = c.ws.find((w) => w.status === 'fire') || c.ws.find((w) => w.status === 'contained') || c.ws.find((w) => w.status === 'smoke');
    if (f) return 'ws:' + f.id;
    return c.ws[0] ? 'ws:' + c.ws[0].id : null;
  }

  // ---------------- render ----------------
  function render() {
    $('tip').hidden = true;
    renderNav();
    const city = S.view === 'city';
    ['stage', 'hud', 'legend'].forEach((id) => { $(id).hidden = !city; });
    if (!city) ['detail', 'detail-scrim', 'reopen'].forEach((id) => { $(id).hidden = true; });
    $('page').hidden = city;
    if (city) { renderCity(); renderHud(); renderDetail(); renderViewCtl(); } else renderPage();
    ['birds', 'viewctl'].forEach((id) => { $(id).hidden = !city; });
    renderDemo();
    renderModal();
  }

  function renderCity() {
    const c = cl();
    const sig = JSON.stringify([c.id, c.ws.map((w) => [w.id, w.pct, w.status, w.relit, w.opp, w.recent]), c.jams.map((j) => [j.id, j.wsId, j.cars.length, j.late, j.contained])]);
    if (sig !== S.citySig) { $('plane').innerHTML = SKY.renderCity(c); S.citySig = sig; }
    $('plane').querySelectorAll('[data-pick]').forEach((el) => el.classList.toggle('is-sel', el.dataset.pick === S.sel));
    fit();
  }
  // Where the city sits before you move it: scaled to the window, nudged right of the HUD.
  function baseView() {
    const w = window.innerWidth, h = window.innerHeight;
    return { s: Math.min(w / 1560, h / 960) * (w < 900 ? 1.2 : 1), x: w < 900 ? 0 : Math.round(Math.min(60, (w - 1200) / 4)), y: w < 900 ? -40 : 34 };
  }
  function fit() {
    const b = baseView();
    $('holder').style.transform = 'translate(' + (b.x + VIEW.x) + 'px,' + (b.y + VIEW.y) + 'px) scale(' + (b.s * VIEW.zoom).toFixed(3) + ')';
  }

  const PROFILES = [
    { id: 'consultant', label: 'CONSULTANT', desc: 'What you owe this week' },
    { id: 'pm', label: 'PROJECT MANAGER', desc: 'Risk across every workstream' },
    { id: 'exec', label: 'ACCOUNT EXEC', desc: 'Relationship health and growth' },
    { id: 'client', label: 'CLIENT VIEW', desc: 'What the client sees' }
  ];
  function daysTo(ts) { return Math.ceil((ts - t(S.now)) / DAY); }

  function renderHud() {
    const c = cl();
    const tst = S.toast;
    const dot = { fire: 'var(--fire)', ok: 'var(--ok)', opp: 'var(--gold)', smoke: 'var(--smoke)', quiet: 'var(--quiet)' }[tst && tst.tone] || 'var(--ok)';
    $('hud').innerHTML =
      '<div class="panel"><div class="phead teal"><span>SKYLINE</span><select class="viewas" data-act="profile-select" aria-label="View as">' + PROFILES.map((p) => '<option value="' + p.id + '"' + (S.profile === p.id ? ' selected' : '') + '>' + p.label + '</option>').join('') + '</select></div>' +
      '<div class="hud-body"><div class="hud-name">' + esc(c.name) + '</div>' +
      '<div class="hud-sub">' + esc(c.project || 'Implementation') + (c.goLive ? ' · go-live in ' + daysTo(c.goLive) + ' days' : '') + '</div>' +
      (c.done ? '<div class="donebox hud-done"><div><b>✓ Project complete</b><span>All ' + c.ws.length + ' buildings are at 100%.</span></div><button type="button" class="btn btn-p btn-sm" data-act="archive" data-id="' + c.id + '">ARCHIVE PROJECT</button></div>' : '') +
      '<button type="button" class="hud-back" data-act="view" data-view="region">← All my clients</button></div></div>' +
      (tst ? '<div class="panel toast" role="status"' + (tst.sel && tst.client === c.id ? ' data-act="pick" data-pick="' + tst.sel + '" style="cursor:pointer"' : '') + '><span class="dot" style="background:' + dot + '"></span><div>' +
        '<span class="toast-tag">JUST HEARD · ' + esc(F.dt(tst.at)) + (tst.client && tst.client !== c.id ? ' · ' + esc(S.model.clients[tst.client].name.toUpperCase()) : '') + '</span>' +
        '<span class="toast-title">' + esc(tst.title) + '</span><span class="toast-body">' + esc(tst.body) + '</span></div></div>' : '');
  }

  function renderNav() {
    const fires = active().reduce((n, id) => n + S.model.clients[id].counts.fire, 0);
    // Inside the macOS menu bar app, report the fire count for the menu bar badge.
    const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.skyline;
    if (native) native.postMessage({ fires });
    const nArch = Object.keys(S.archived).length;
    const tab = (v, label, n, calm) => '<button type="button" class="nav-tab" data-act="view" data-view="' + v + '"' + (S.view === v ? ' aria-current="page"' : '') + '>' + label + (n ? '<span class="n' + (calm ? ' calm' : '') + '">' + n + '</span>' : '') + '</button>';
    $('nav').innerHTML = tab('city', 'CITY') + tab('region', 'REGION', fires) + tab('sources', 'SOURCES') + tab('agents', 'AGENTS') + tab('archives', 'ARCHIVES', nArch, true) +
      '<span class="seg modeswitch" role="group" aria-label="Data source"><button type="button" data-act="mode" data-mode="demo" aria-pressed="' + !isLive() + '">DEMO</button><button type="button" data-act="mode" data-mode="live" aria-pressed="' + isLive() + '"' + (SERVED ? '' : ' title="Run the Skyline server to use live data"') + '>LIVE</button></span>' +
      '<span class="clock" title="' + (isLive() ? 'Live data' : 'Demo clock') + '">' + (S.live || (isLive() && LIVE && LIVE.status.syncing) ? '<span class="live-dot" aria-hidden="true"></span>' : '') + esc((isLive() ? 'LIVE · ' + F.time(S.now) : F.dt(S.now)).toUpperCase()) + '</span>' +
      (isLive()
        ? '<button type="button" class="nav-tab demo-btn" data-act="sync"' + (LIVE && LIVE.status.syncing ? ' disabled' : '') + '>' + (LIVE && LIVE.status.syncing ? 'SYNCING…' : 'SYNC NOW') + '</button>'
        : '<button type="button" class="nav-tab demo-btn" data-act="demo" aria-expanded="' + S.demoOpen + '">DEMO ▾</button>');
  }

  // ---------------- detail panel ----------------
  const HEADS = { ok: ['#9CC2B4', INK, 'HEALTHY'], fire: ['#F0552E', '#FFFFFF', 'ON FIRE'], contained: ['#CFE3DA', INK, 'CONTAINED'], quiet: ['#3E4B5A', '#EEF2F1', 'LIGHTS OFF'], smoke: ['#D6DCE1', INK, 'SMOKY'], opp: ['#F2C230', INK, 'OPPORTUNITY'], jam: ['#E9C46A', INK, 'BLOCKED HANDOFF'], jamcalm: ['#F3E2A6', INK, 'WAITING'], done: ['#9CC2B4', INK, 'DONE'] };
  const head = (name, key, label) => {
    const h = HEADS[key];
    const full = S.detail === 'full';
    return '<div class="dhead" style="background:' + h[0] + ';color:' + h[1] + '"><span class="n">' + esc(name) + '</span><span class="s">' + esc(label || h[2]) + '</span>' +
      '<span class="dctl"><button type="button" class="dbtn" data-act="detail-full" title="' + (full ? 'Back to the side panel' : 'Full screen') + '" aria-label="' + (full ? 'Exit full screen' : 'Open full screen') + '">' + (full ? '⤡' : '⤢') + '</button>' +
      '<button type="button" class="dbtn" data-act="detail-close" title="Close" aria-label="Close panel">✕</button></span></div>';
  };
  const clientView = () => S.profile === 'client';
  const internalOnly = (m) => m && (m.src === 'slack' && !SKY.sharedChannels[m.where]);

  function renderDetail() {
    const c = cl();
    const w = S.sel ? wsById(c, S.sel.slice(3)) : null;
    const open = !!w && S.detail !== 'closed';
    const d = $('detail');
    d.hidden = !open;
    d.classList.toggle('full', open && S.detail === 'full');
    $('detail-scrim').hidden = !(open && S.detail === 'full');
    $('reopen').hidden = open || !w;
    if (w) $('reopen').textContent = 'SHOW ' + w.name.toUpperCase();
    $('tip').hidden = true;
    if (!open) return;
    d.innerHTML = wsPanel(c, w);
    if (S.editPct) { const inp = d.querySelector('.pctform input'); if (inp) { inp.focus(); inp.select(); } }
  }

  function wsSummary(c, w) {
    const fire = w.issues.find((i) => i.kind === 'fire');
    const opp = c.opps.find((o) => o.wsId === w.id);
    if (w.status === 'fire') return fire.relit || fire.status === 'relit'
      ? 'Still no reply from ' + first(fire.owner) + '. ' + fire.what + ' is ' + plural(fire.daysLate, 'day') + ' late and ' + plural(fire.waiters, 'person', 'people') + ' are still stuck behind it.'
      : fire.what + ' is ' + plural(fire.daysLate, 'day') + ' late. ' + (fire.waiters ? plural(fire.waiters, 'person', 'people') + ' can’t start, and the fire is spreading toward go-live.' : '');
    if (w.status === 'contained') return 'Fire contained. ' + (fire && fire.note ? fire.note : '');
    if (w.status === 'smoke') return 'Smoke, not fire yet. ' + w.issues.filter((i) => i.kind === 'smoke').map((i) => i.title).join('. ') + '.';
    if (w.status === 'quiet') return 'Every window is dark. ' + w.issues.find((i) => i.kind === 'quiet').title + '.';
    if (w.status === 'done') return 'All done. Every piece of ' + lc(w.name) + ' is complete.';
    if (w.status === 'opp') return 'Healthy, and lit up: ' + first(opp.owner) + ' asked about ' + lc(opp.title) + '.';
    return w.pct + '% done with ' + plural(w.recent, 'message') + ' this week. ' + (w.issues.length ? plural(w.issues.length, 'thing') + ' to keep an eye on.' : 'Nothing needs you here.');
  }

  function wsPanel(c, w) {
    const st = w.status;
    const label = st === 'fire' && w.relit ? 'ALARM RELIT' : null;
    const cv = clientView();
    let issues = w.issues.slice().sort((a, b) => ({ fire: 0, smoke: 1, watch: 2, quiet: 3 }[a.kind] - { fire: 0, smoke: 1, watch: 2, quiet: 3 }[b.kind]));
    if (cv) issues = issues.filter((i) => i.type === 'commit' || i.type === 'question');
    const opps = cv ? [] : c.opps.filter((o) => o.wsId === w.id);
    const openRisks = w.issues.filter((i) => i.status !== 'contained').length;
    let body = '<div class="stats">' +
      '<div><div class="k">Progress</div>' + (S.editPct === w.id
        ? '<form class="pctform" data-form="pct" data-id="ws:' + c.id + '/' + w.id + '"><input type="number" name="pct" min="0" max="100" step="1" value="' + w.pct + '" aria-label="Progress percent"><span>%</span><button type="submit" class="btn btn-sm btn-p">SAVE</button><button type="button" class="link" data-act="pct-cancel">Cancel</button></form>'
        : '<div class="v">' + w.pct + '%' + (cv ? '' : '<button type="button" class="fix" data-act="pct-edit" data-id="' + w.id + '">edit</button>') + '</div>') + '</div>' +
      '<div><div class="k">Activity, 7 days</div><div class="v">' + plural(w.recent, 'message') + '</div></div>' +
      '<div><div class="k">Open risks</div><div class="v">' + openRisks + '</div></div></div>' +
      '<p class="summary">' + esc(wsSummary(c, w)) + '</p>';
    body += blockedByBox(c, w) + waitingBox(c, w);
    if (w.pct >= 100 && !cv) body += c.done
      ? '<div class="donebox"><div><b>✓ The whole project is complete</b><span>Every building in ' + esc(c.name) + ' is at 100%.</span></div><button type="button" class="btn btn-p" data-act="archive" data-id="' + c.id + '">ARCHIVE PROJECT</button></div>'
      : '<div class="donebox"><div><b>✓ This building is complete</b><span>' + plural(c.ws.filter((x) => x.pct < 100).length, 'building') + ' to go before the project can be archived.</span></div></div>';
    if (w.pctMsg && !issues.length && !opps.length) body += evidenceList([{ msgId: w.pctMsg.id, quote: w.pctQuote || w.pctMsg.body.split('\n')[0], by: w.pctMsg.from, role: 'Latest progress' }]);
    if (w.pctCorrected) body += '<p class="note">Progress set by you. Skyline keeps your number until you undo it below.</p>';
    body += issues.map((i, k) => issueCard(c, i, k === 0)).join('');
    if (w.aliases.length && !cv) body += '<p class="note">Also called ' + w.aliases.map((a) => '“' + esc(a) + '”').join(', ') + ' in conversations. Merged into one building.</p>';
    body += opps.map((o) => oppCard(c, o, !issues.length)).join('');
    body += correctedList(c, w.id);
    return head(w.name, st, label) + '<div class="dbody">' + body + '</div>';
  }

  function correctedList(c, wsId) {
    const mine = c.corrected.filter((x) => x.wsId === wsId);
    if (!mine.length || clientView()) return '';
    return '<div><div class="facts-k">YOUR CORRECTIONS</div><ul class="list">' + mine.map((x) => '<li><span><b>' + esc(x.title) + '</b>: ' + esc({ resolved: 'marked resolved', dismiss: 'marked not a risk', due: 'due date changed', owner: 'owner changed', pct: 'progress changed' }[x.field]) + (x.note ? ' · “' + esc(x.note) + '”' : '') + '</span><button type="button" class="link when" data-act="undo" data-id="' + x.id + '">Undo</button></li>').join('') + '</ul></div>';
  }

  function badge(i) {
    if (i.basis === 'confirmed') return '<span class="badge b-conf" title="Backed by a word-for-word quote or a count of messages">CONFIRMED</span>';
    return '<span class="badge b-inf" title="Skyline’s interpretation, not something anyone said outright">INFERRED · ' + Math.round(i.confidence * 100) + '%</span>';
  }

  function evidenceList(evs) {
    const cv = clientView();
    return '<div class="ev-list">' + evs.filter((e) => e.quote && !(cv && internalOnly(msg(e.msgId)))).map((e) => {
      const m = msg(e.msgId);
      return '<button type="button" class="ev" data-act="source" data-msg="' + e.msgId + '" data-q="' + esc(e.quote) + '">' +
        '<span class="ev-role">' + esc((e.role || 'Source').toUpperCase()) + (e.rewritten ? ' · QUOTE CORRECTED BY VERIFIER' : '') + '</span>' +
        '<span class="ev-q">“' + esc(e.quote) + '”</span>' +
        '<span class="ev-meta"><b>' + who(e.by || m.from) + '</b> · ' + esc(SKY.srcLabel(m)) + ' · <u>open source</u></span></button>';
    }).join('') + '</div>';
  }

  function chainHtml(chain) {
    return '<div class="chain">' + chain.map((ch, k) => '<span class="chip t-' + ch.tone + (ch.basis === 'inferred' ? ' inf' : '') + '" title="' + (ch.basis === 'inferred' ? 'Inferred, ' + Math.round(ch.confidence * 100) + '% confidence' : 'Confirmed') + '">' + esc(ch.text) +
      (ch.basis === 'inferred' ? ' <small>' + Math.round(ch.confidence * 100) + '%</small>' : '') + '</span>' + (k < chain.length - 1 ? '<span class="arrow" aria-hidden="true">→</span>' : '')).join('') + '</div>';
  }

  function issueCard(c, i, open) {
    const cv = clientView();
    const dot = { fire: 'var(--fire)', smoke: 'var(--smoke)', watch: 'var(--jam)', quiet: 'var(--quiet)' }[i.kind];
    let b = '';
    if (i.status === 'contained') b += '<div class="state state-ok">' + esc(i.note) + '</div>';
    if (i.status === 'relit') b += '<div class="state state-fire">' + esc(i.note) + '</div>';
    if (i.rewritten) b += '<p class="note">The Verifier could not find the original quote word for word, so it rewrote this as an interpretation and lowered its confidence.</p>';
    b += evidenceList(i.evidence.slice(0, 1));
    if (i.jamId) b += blockedBox(c, i);
    if (!cv) b += nbaHtml(recommend(c, i), i.id);
    let more = '';
    if (i.evidence.length > 1) more += evidenceList(i.evidence.slice(1));
    if (i.why && !cv) more += '<p class="why"><b>Why Skyline thinks so:</b> ' + esc(i.why) + '</p>';
    if (i.facts.length) more += '<div><div class="facts-k">WHAT SKYLINE KNOWS</div><ul class="facts">' + i.facts.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul></div>';
    if (!cv) more += '<button type="button" class="link" data-act="correct" data-id="' + i.id + '">Not right? Correct this insight</button>';
    if (more) b += '<details class="more"><summary>More' + (i.evidence.length > 1 ? ' · ' + plural(i.evidence.length - 1, 'more source') : '') + (i.facts.length ? ' · what Skyline knows' : '') + (cv ? '' : ' · correct it') + '</summary><div class="more-body">' + more + '</div></details>';
    return '<details class="ins"' + (open ? ' open' : '') + '><summary><span class="dot" style="background:' + dot + '"></span><span class="ins-title">' + esc(i.title) + '</span>' + badge(i) + '</summary><div class="ins-body">' + b + '</div></details>';
  }

  function oppCard(c, o, open) {
    let b = evidenceList(o.ev.slice(-1));
    if (o.sentTo) b += '<div class="state state-sent">Sent to ' + esc(pname(o.sentTo.to)) + ' ' + esc(F.dt(o.sentTo.sentAt)) + '.</div>';
    else b += nbaHtml(recommendOpp(c, o), o.id);
    b += '<details class="more"><summary>More' + (o.ev.length > 1 ? ' · ' + plural(o.ev.length - 1, 'earlier mention') : '') + ' · correct it</summary><div class="more-body">' + (o.ev.length > 1 ? evidenceList(o.ev.slice(0, -1)) : '') +
      '<button type="button" class="link" data-act="correct" data-id="' + o.id + '">Not right? Correct this insight</button></div></details>';
    return '<details class="ins"' + (open ? ' open' : '') + '><summary><span class="dot" style="background:var(--gold)"></span><span class="ins-title">' + esc(o.title) + '</span>' + badge(o) + '</summary><div class="ins-body">' + b + '</div></details>';
  }

  function nbaHtml(r, id) {
    if (!r) return '';
    const head = '<div class="nba"><div class="nba-k">NEXT BEST ACTION</div><div class="nba-t">' + esc(r.text) + '</div>' + (r.why ? '<div class="nba-why">' + esc(r.why) + '</div>' : '');
    if (r.fix) {
      const opts = r.actions.filter((a) => a && a.kind !== 'sources');
      const src = r.actions.find((a) => a && a.kind === 'sources');
      return head + '<details class="fixit"><summary class="btn btn-p' + (r.tone ? ' btn-' + r.tone : '') + '">FIX THIS ISSUE <span aria-hidden="true">▾</span></summary><div class="fix-opts">' +
        opts.map((a, k) => '<button type="button" class="fix-opt" data-act="draft" data-kind="' + a.kind + '" data-id="' + id + '"><span class="fix-ico" aria-hidden="true">' + ({ nudge: '✉', escalate: '↑', meeting: '◷' }[a.kind] || '→') + '</span><span><b>' + esc(a.label) + (k === 0 ? ' <em>RECOMMENDED</em>' : '') + '</b><small>' + esc(a.sub || '') + '</small></span></button>').join('') +
        '</div></details>' + (src ? '<button type="button" class="link" data-act="sources" data-id="' + id + '">' + esc(src.label) + '</button>' : '') + '</div>';
    }
    return head +
      '<div class="row">' + r.actions.filter(Boolean).map((a) => a.kind === 'sources'
        ? '<button type="button" class="link" data-act="sources" data-id="' + id + '">' + esc(a.label) + '</button>'
        : '<button type="button" class="btn' + (a.primary ? ' btn-p' + (a.tone ? ' btn-' + a.tone : '') : '') + '" data-act="draft" data-kind="' + a.kind + '" data-id="' + id + '">' + esc(a.label) + '</button>').join('') + '</div></div>';
  }

  function keyWhat(c, key) {
    if (c.commits[key]) return c.commits[key].what;
    for (const j of c.jams) { const e = j.cars.find((x) => x.work === key); if (e) return e.what; }
    return key;
  }

  // What an open fire is holding up, listed person by person.
  function blockedBox(c, i) {
    const j = c.jams.find((x) => x.id === i.jamId);
    if (!j) return '';
    const live = i.status !== 'contained';
    const rows = j.cars.map((e) => '<li><span class="blk-who">' + who(e.waiter) + '</span><span>can’t start <b>' + esc(lc(e.what)) + '</b>' +
      (e.wsId !== i.wsId ? ' · <button type="button" class="link" data-act="pick" data-pick="ws:' + e.wsId + '">' + esc(wsById(c, e.wsId).name) + '</button>' : '') + '</span></li>');
    (i.downstream || []).forEach((d) => rows.push('<li class="blk-risk"><span class="blk-who">' + esc(d.what) + '</span><span>' + esc(F.dow(d.date)) + ' is at risk <span class="badge b-inf">INFERRED</span></span></li>'));
    const gl = (i.chain || []).find((x) => x.text.indexOf('Go-live') === 0);
    if (gl) rows.push('<li class="blk-risk"><span class="blk-who">Go-live</span><span>' + esc(F.dow(c.goLive)) + ' is at risk <span class="badge b-inf">INFERRED · ' + Math.round(gl.confidence * 100) + '%</span></span></li>');
    return '<div class="blocked' + (live ? '' : ' calm') + '"><div class="blocked-h">' + (live ? '⛔ BLOCKED BY THIS FIRE' : 'STILL WAITING ON THIS') + ' · ' + plural(j.cars.length, 'person', 'people') + '</div><ul>' + rows.join('') + '</ul></div>';
  }
  // Shown on a building whose work is stuck behind a fire somewhere else.
  function blockedByBox(c, w) {
    const fires = (SKY.blockedMap(c)[w.id] || []);
    if (!fires.length) return '';
    return fires.map((fid) => {
      const j = c.jams.find((x) => x.wsId === fid);
      const mine = j ? j.cars.filter((e) => e.wsId === w.id) : [];
      return '<div class="blocked"><div class="blocked-h">⛔ BLOCKED BY A FIRE AT ' + esc(wsById(c, fid).name.toUpperCase()) + '</div><ul>' +
        mine.map((e) => '<li><span class="blk-who">' + who(e.waiter) + '</span><span>can’t start <b>' + esc(lc(e.what)) + '</b> until ' + who(e.on, true) + ' delivers ' + esc(lc(keyWhat(c, e.key))) + '</span></li>').join('') +
        '</ul><button type="button" class="btn btn-sm btn-fire" data-act="pick" data-pick="ws:' + fid + '">GO TO THE FIRE</button></div>';
    }).join('');
  }
  // A dated promise that people are queued behind, before it is late.
  function waitingBox(c, w) {
    const j = c.jams.find((x) => x.wsId === w.id && !x.late);
    if (!j) return '';
    const k = c.commits[j.rootKey];
    let b = '<div class="blocked calm"><div class="blocked-h">WAITING ON ' + esc(first(j.owner).toUpperCase()) + ' · DUE ' + esc(F.dow(k.due).toUpperCase()) + '</div><ul>' +
      j.cars.map((e) => '<li><span class="blk-who">' + who(e.waiter) + '</span><span>can’t start <b>' + esc(lc(e.what)) + '</b> until ' + esc(lc(keyWhat(c, e.key))) + ' lands</span></li>').join('') + '</ul></div>';
    if (clientView()) return b;
    if (S.followUps[j.id]) return b + '<div class="state state-sent">' + (S.followUps[j.id].kind === 'meeting' ? 'Meeting booked with ' + esc(first(j.owner)) + ' for ' + esc(F.dt(S.followUps[j.id].meetingAt)) : 'Reminder sent to ' + esc(first(j.owner)) + ' ' + esc(F.dt(S.followUps[j.id].sentAt))) + '.</div>';
    return b + nbaHtml({ text: 'Check in with ' + first(j.owner) + ' before ' + F.dow(k.due) + ' so this doesn’t turn into a fire.', why: plural(j.cars.length, 'person', 'people') + ' can’t start until it lands.', fix: true,
      actions: [{ label: 'Email ' + first(j.owner) + ' a reminder', sub: 'A short, friendly check-in', kind: 'remind' }, { label: 'Schedule a meeting', sub: '15 minutes with ' + first(j.owner), kind: 'meeting' }] }, j.id);
  }

  // ---------------- recommendations ----------------
  function suggestOwner(topic) {
    const p = Object.keys(SKY.people).find((id) => (SKY.people[id].skills || []).indexOf(topic) >= 0);
    return p || ME();
  }
  function recommend(c, i) {
    const ws = wsById(c, i.wsId);
    if (i.type === 'commit') {
      if (i.status === 'contained') return null;
      const mgr = SKY.people[i.owner] && SKY.people[i.owner].manager;
      const dl = (i.downstream || [])[0];
      const pm = msg(((i.evidence || []).find((e) => e.role === 'The promise') || i.evidence[0]).msgId);
      const other = i.jamId ? c.jams.find((j) => j.id === i.jamId).cars.find((e) => e.waiter !== ME()) : null;
      const meet = { label: 'Schedule a meeting with ' + first(i.owner) + (other ? ' and ' + first(other.waiter) : ''), sub: '20 minutes, agenda and blockers filled in, ' + F.dt(meetingSlots()[0]) + ' suggested', kind: 'meeting' };
      const esc8 = mgr && { label: 'Escalate to ' + pname(mgr), sub: 'Copies ' + first(i.owner) + ' and lays out what’s blocked', kind: 'escalate' };
      if (i.status === 'relit') return {
        text: first(i.owner) + ' hasn’t responded. Escalate to ' + pname(mgr) + ', or get everyone in a room.',
        why: (i.followUp.kind === 'meeting' ? 'The meeting on ' + F.dt(i.followUp.meetingAt) + ' didn’t move it.' : 'Your follow-up has gone unanswered since ' + F.dt(i.followUp.sentAt) + '.') + (i.waiters ? ' ' + plural(i.waiters, 'person is', 'people are') + ' still blocked.' : ''),
        fix: true, tone: 'fire',
        actions: [esc8, meet, { label: 'Email ' + first(i.owner) + ' again', sub: 'A firmer follow-up', kind: 'nudge' }, { label: 'Open ' + plural(i.evidence.length, 'source'), kind: 'sources' }]
      };
      const w1 = i.waiters ? c.jams.find((j) => j.id === i.jamId).cars[0].waiter : null;
      return {
        text: 'Ask ' + first(i.owner) + ' for whatever part of the ' + lc(i.what) + ' is ready now, with a firm date for the rest.',
        why: i.waiters ? plural(i.waiters, 'person is', 'people are') + ' queued behind it' + (dl ? ', and ' + dl.what + ' (' + F.day(dl.date) + ') is downstream' : '') + '. A partial delivery lets ' + (w1 === ME() ? 'you' : first(w1)) + ' start now.' : 'It is ' + plural(i.daysLate, 'day') + ' overdue.',
        fix: true, tone: i.kind === 'fire' ? 'fire' : null,
        actions: [{ label: 'Email ' + first(i.owner) + ' a follow-up', sub: 'Drafted from what ' + first(i.owner) + ' said ' + saidWhere(pm).replace('your email', 'an email') + ', ready to edit', kind: 'nudge' }, meet, esc8,
          { label: 'Open ' + plural(i.evidence.length, 'source'), kind: 'sources' }]
      };
    }
    if (i.status === 'contained') return null;
    if (i.type === 'question') {
      const o = suggestOwner(i.topic);
      return { text: o === ME() ? 'Answer ' + first(i.asker) + ' yourself; nobody else owns this.' : 'Name ' + pname(o) + ' as the owner and answer ' + first(i.asker) + '.',
        why: first(i.asker) + ' asked ' + F.dow(msg(i.evidence[0].msgId).ts) + ' and nobody has replied.' + (o !== ME() ? ' ' + pname(o) + ' (' + SKY.people[o].role + ') is the natural owner.' : ''),
        actions: [{ label: 'DRAFT THE ANSWER', kind: 'answer', primary: true }, { label: 'Schedule a meeting', kind: 'meeting' }] };
    }
    if (i.type === 'slip') return { text: 'Ask ' + first(i.owner) + ' for a new test date and put it on the plan.', why: 'A failed test with no new date usually becomes a missed deadline.', actions: [{ label: 'ASK FOR A NEW DATE', kind: 'slip', primary: true }] };
    if (i.type === 'concern') return { text: 'Confirm with ' + first(i.owner) + ' before this shows up in a paycheck.', why: 'This is Skyline’s interpretation, so one question settles it.', actions: [{ label: 'ASK ' + first(i.owner).toUpperCase(), kind: 'confirm', primary: true }, { label: 'Schedule a quick call', kind: 'meeting' }] };
    if (i.type === 'quiet') return { text: 'Propose a date to restart ' + lc(ws.name) + ' before it becomes the next fire.', why: c.goLive ? 'Go-live is ' + F.dow(c.goLive) + ', ' + daysTo(c.goLive) + ' days away, and nothing is scheduled.' : '', actions: [{ label: 'SUGGEST A DATE', kind: 'quiet', primary: true }, { label: 'Schedule a planning meeting', kind: 'meeting' }] };
    return null;
  }
  function recommendOpp(c, o) {
    const ae = Object.keys(SKY.people).find((id) => SKY.people[id].ae);
    return { text: 'Hand this to ' + (ae ? pname(ae) : 'your account exec') + ' while it’s warm.', why: first(o.owner) + ' raised it unprompted' + (o.ev.length > 1 ? ' and followed up (' + plural(o.ev.length, 'mention') + ')' : '') + '.', actions: [{ label: 'SEND TO THE ACCOUNT EXEC', kind: 'opp', primary: true, tone: 'gold' }] };
  }

  // ---------------- meetings ----------------
  function meetingSlots() {
    const d1 = new Date(nextBizMorning(S.now, 10, 0));
    const d2 = new Date(nextBizMorning(S.now, 14, 0));
    const d3 = new Date(nextBizMorning(d1, 11, 0));
    return [d1, d2, d3].map((d) => F.iso(d));
  }
  function buildMeeting(id) {
    const { c, i } = findItem(id);
    const ws = wsById(c, i.wsId);
    const j = i.cars ? i : i.jamId ? c.jams.find((x) => x.id === i.jamId) : null;
    const owner = i.type === 'question' ? i.asker : i.type === 'quiet' ? (i.owner && SKY.people[i.owner].email.indexOf(SKY.INTERNAL_DOMAIN) < 0 ? i.owner : c.people[0]) : i.owner;
    const people = [owner];
    if (j) j.cars.forEach((e) => { if (e.waiter !== ME() && people.indexOf(e.waiter) < 0 && people.length < 3) people.push(e.waiter); });
    if (i.type === 'question') { const o = suggestOwner(i.topic); if (o !== ME()) people.push(o); }
    const what = i.what || (c.commits[i.rootKey] || {}).what || i.title;
    const ev0 = (i.evidence || [])[0];
    const lines = [];
    if (ev0) lines.push('Context: ' + pname(ev0.by || msg(ev0.msgId).from) + ', ' + SKY.srcLabel(msg(ev0.msgId)) + ': “' + ev0.quote + '”');
    if (i.type === 'commit' || i.cars) {
      lines.push('', '1. Where is the ' + lc(what) + ', and what is holding it up?', '2. Can part of it come over by ' + F.dow(addBizDays(S.now, 2)) + '?', '3. Agree a firm date for the rest');
      if (j) lines.push('', 'Waiting on this: ' + j.cars.map((e) => first(e.waiter) + ' (' + lc(e.what) + ')').join(', '));
    } else {
      lines.push('', '1. ' + i.title, '2. Agree an owner and a date', '3. Next steps');
    }
    return { id, kind: 'meeting', to: owner, title: (ws ? ws.name + ': ' : '') + (i.type === 'commit' || i.cars ? 'unblock ' + lc(what) : lc(i.title)),
      emails: people.concat([ME()]).map((p) => SKY.people[p].email).join(', '), slots: meetingSlots(), slot: 0, minutes: 20, agenda: lines.join('\n') };
  }
  function sendMeeting() {
    const d = S.modal.draft;
    const at = d.slots[d.slot];
    if (isLive()) openInGoogle('meeting', { subject: d.title, body: d.agenda, to: d.emails.replace(/\s+/g, ''), start: at, end: t(at) + d.minutes * 60000 });
    const watchUntil = F.iso(new Date(t(at) + (d.minutes + 120) * 60000));
    S.followUps[d.id] = { kind: 'meeting', sentAt: S.now, to: d.to, meetingAt: at, subject: d.title, watchUntil };
    S.messages.push({ id: 'out-' + (S.messages.length + 1), src: 'email', where: 'Sent', ts: S.now, from: ME(), to: [d.to], subject: 'Invitation: ' + d.title, body: d.agenda, thread: 'fu-' + d.id, signals: [] });
    S.modal = null;
    const ev = recompute('You booked “' + d.title + '”').filter((e) => e.client === S.client);
    S.toast = { tone: 'ok', at: S.now, client: S.client, sel: ev[0] && ev[0].sel, title: ev[0] ? ev[0].title : 'Meeting booked',
      body: (isLive() ? 'Google Calendar opened with the invite for ' : 'Invite sent to ') + first(d.to) + ' for ' + F.dt(at) + '. Skyline relights the alarm if nothing has moved by ' + F.dt(watchUntil) + '.' };
    render();
  }

  // ---------------- drafts ----------------
  // "on our kickoff call on Oct 2" / "in your email on Oct 13" / "in #channel on Oct 15"
  function saidWhere(m) {
    if (m.src === 'meeting') return 'on our ' + lc(m.where) + ' on ' + F.day(m.ts);
    if (m.src === 'slack') return 'in ' + m.where + ' on ' + F.day(m.ts);
    return 'in your email on ' + F.day(m.ts);
  }
  function chainSentence(c, i) {
    const j = i.jamId ? c.jams.find((x) => x.id === i.jamId) : null;
    if (!j) return '';
    const dl = (i.downstream || [])[0];
    let dlUsed = false;
    const parts = j.cars.map((e, k) => {
      const when = dl && lc(dl.what) === lc(e.what) ? (dlUsed = true, ' (' + F.day(dl.date) + ')') : '';
      if (e.waiter === ME()) return 'I can’t start ' + lc(e.what) + when + ' until then';
      return k === 0 ? first(e.waiter) + ' is waiting on it to start the ' + lc(e.what) + when : first(e.waiter) + '’s ' + lc(e.what) + when + ' is queued behind that';
    });
    if (dl && !dlUsed) parts.push(dl.what + ' (' + F.day(dl.date) + ') depends on all of it');
    if (parts.length > 1) parts[parts.length - 1] = 'and ' + parts[parts.length - 1];
    return parts.join(', ') + '.';
  }
  function buildDraft(kind, id, tone) {
    const { c, i } = findItem(id);
    const me = SKY.people[ME()] || { name: 'Me' };
    const sign = '\n\nThanks,\n' + me.name.split(' ')[0];
    const toneLine = tone === 'firm' ? '\n\nTo keep the ' + (c.goLive ? F.day(c.goLive) + ' go-live' : 'plan') + ' on track, I need an answer by ' + F.dow(addBizDays(S.now, 1)) + '.'
      : tone === 'friendly' ? '\n\nHappy to jump on a quick call if that’s easier. I know how much is on your plate.' : '';
    const ev0 = (i.evidence || i.ev || [])[0];
    const prom = (i.evidence || []).find((e) => e.role === 'The promise') || ev0;
    const pm = prom ? msg(prom.msgId) : null;
    const partialBy = F.dow(addBizDays(S.now, 2));
    const ctx = [];
    (i.evidence || i.ev || []).forEach((e) => { const m = msg(e.msgId); if (m) ctx.push(SKY.srcLabel(m)); });
    let to, cc = [], subject, body;
    if (kind === 'nudge' || kind === 'remind') {
      const k = c.commits[i.rootKey || i.key];
      to = i.owner;
      subject = kind === 'remind' ? k.what + ': still on track for ' + F.dow(k.due) + '?' : i.what + ': can we get what’s ready?';
      body = kind === 'remind'
        ? 'Hi ' + first(to) + ',\n\nChecking in on the ' + lc(k.what) + ' you planned to finish by ' + F.dow(k.due) + '. ' + plural(i.cars.length, 'person is', 'people are') + ' lined up behind it, so I wanted to make sure nothing is stuck on your side.\n\nAre you still on track?'
        : 'Hi ' + first(to) + ',\n\nFollowing up on the ' + lc(i.what) + '. ' + saidWhere(pm).replace(/^./, (x) => x.toUpperCase()) + ' you said “' + prom.quote + '” We’re now ' + plural(i.daysLate, 'day') + ' past that.\n\n' +
          (i.waiters ? chainSentence(c, i).replace(/^./, (x) => x.toUpperCase()) + '\n\n' : '') +
          'Could you send whatever part is ready by ' + partialBy + '? Even a partial delivery lets us start, and we can take the rest when it’s done.';
      body += toneLine + sign;
      if (kind === 'remind') ctx.length = 0, i.cars.forEach((e) => ctx.push(SKY.srcLabel(msg(e.ev[0].msgId))));
    } else if (kind === 'escalate') {
      const mgr = SKY.people[i.owner].manager;
      to = mgr; cc = [i.owner];
      subject = i.what + ' is ' + plural(i.daysLate, 'day') + ' late: could you help?';
      body = 'Hi ' + first(mgr) + ',\n\nLooping you in on the ' + lc(i.what) + ' for the ' + lc(c.project || 'project') + '. ' + first(i.owner) + ' committed to it for ' + F.dow(c.commits[i.key].due) + ' (' + SKY.srcLabel(pm) + '), and it is now ' + plural(i.daysLate, 'day') + ' late.' +
        (i.followUp ? ' I followed up on ' + F.dt(i.followUp.sentAt) + ' and haven’t heard back.' : '') + '\n\n' + (i.waiters ? chainSentence(c, i).replace(/^./, (x) => x.toUpperCase()) + '\n\n' : '') +
        'Could you help us get a partial delivery, or a firm date, by ' + partialBy + '?' + toneLine + sign;
    } else if (kind === 'answer') {
      const o = suggestOwner(i.topic);
      const m = msg(ev0.msgId);
      to = i.asker; if (o !== ME()) cc = [o];
      subject = 'Re: ' + (m.subject || i.text);
      body = 'Hi ' + first(to) + ',\n\nSorry for the slow reply on “' + ev0.quote + '”' + qend(ev0.quote) + ' ' + (o === ME() ? 'I’m confirming the details and will come back to you by ' + F.dow(addBizDays(S.now, 1)) + '.' : pname(o) + ' will own this and will reach out this week.') + toneLine + sign;
    } else if (kind === 'slip') {
      to = i.owner;
      subject = 'New date for the re-test?';
      body = 'Hi ' + first(to) + ',\n\nOn ' + F.dow(msg(ev0.msgId).ts) + ' you flagged “' + ev0.quote + '” What’s the new re-test date? I’d like to put it on the plan and let ' + first(c.people[0]) + ' know.' + toneLine + sign;
    } else if (kind === 'confirm') {
      to = i.owner;
      subject = 'Quick check: ' + lc(i.title);
      body = 'Hi ' + first(to) + ',\n\nQuick check on something you said ' + saidWhere(msg(ev0.msgId)) + ': “' + ev0.quote + '”\n\n' + (i.why || '') + '\n\nCould you confirm how you handle this today? I want to get it right before the next parallel run.' + toneLine + sign;
    } else if (kind === 'quiet') {
      const ws = wsById(c, i.wsId);
      to = i.owner && SKY.people[i.owner].email.indexOf(SKY.INTERNAL_DOMAIN) < 0 ? i.owner : c.people[0];
      const d1 = new Date(c.goLive - 10 * DAY), d2 = new Date(c.goLive - 8 * DAY);
      subject = ws.name + ': let’s pick a date';
      body = 'Hi ' + first(to) + ',\n\nPicking ' + lc(ws.name) + ' back up.' + (ev0 && msg(ev0.msgId).from === to ? ' ' + saidWhere(msg(ev0.msgId)).replace(/^./, (x) => x.toUpperCase()) + ' you said “' + ev0.quote + '”' : '') + ' With go-live on ' + F.dow(c.goLive) + ', could we hold the session on ' + F.dow(d1) + ' or ' + F.dow(d2) + '?' + toneLine + sign;
    } else if (kind === 'opp') {
      to = Object.keys(SKY.people).find((x) => SKY.people[x].ae) || null;
      const o = i;
      subject = 'Opportunity at ' + c.name + ': ' + lc(o.title);
      body = 'Hi ' + (to ? first(to) : 'there') + ',\n\n' + pname(o.owner) + ' (' + SKY.people[o.owner].role + ') at ' + c.name + ' asked about ' + lc(o.title) + ':\n\n' +
        o.ev.map((e) => '“' + e.quote + '” (' + SKY.srcLabel(msg(e.msgId)) + ')').join('\n') +
        '\n\nThey’re mid-rollout' + (c.project ? ' (' + lc(c.project) + ', go-live ' + F.day(c.goLive) + ')' : '') + ', so the timing is good for a conversation. Want me to set up an intro?\n\n' + me.name.split(' ')[0];
    }
    return { kind, id, tone: tone || 'neutral', to, cc, toEmail: to ? SKY.people[to].email : '', ccEmail: cc.map((x) => SKY.people[x].email).join(', '), subject, body, ctx: [...new Set(ctx)] };
  }

  // Live mode never sends on its own: it opens Gmail (or Google Calendar) with the draft filled in.
  function openInGoogle(kind, f) {
    const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261019T140000Z
    const qs = (o) => Object.keys(o).map((k) => k + '=' + encodeURIComponent(o[k] || '')).join('&'); // %20, not +, for spaces
    const url = kind === 'meeting'
      ? 'https://calendar.google.com/calendar/render?' + qs({ action: 'TEMPLATE', text: f.subject, details: f.body, dates: stamp(f.start) + '/' + stamp(f.end), add: f.to })
      : 'https://mail.google.com/mail/?' + qs({ view: 'cm', fs: '1', to: f.to, cc: f.cc, su: f.subject, body: f.body });
    window.open(url, '_blank', 'noopener');
  }
  function sendDraft() {
    const d = S.modal.draft;
    if (isLive()) openInGoogle('mail', { to: d.toEmail, cc: d.ccEmail, subject: d.subject, body: d.body });
    const toId = Object.keys(SKY.people).find((id) => SKY.people[id].email === d.toEmail.trim()) || null;
    const watchUntil = nextBizMorning(S.now);
    S.followUps[d.id] = { sentAt: S.now, to: toId, subject: d.subject, kind: d.kind, watchUntil };
    S.messages.push({ id: 'out-' + (S.messages.length + 1), src: 'email', where: 'Sent', ts: S.now, from: ME(), to: toId ? [toId] : [], subject: d.subject, body: d.body, thread: 'fu-' + d.id, signals: [] });
    S.modal = null;
    const ev = recompute('You sent “' + d.subject + '”').filter((e) => e.client === S.client);
    const internal = toId && SKY.people[toId].email.indexOf(SKY.INTERNAL_DOMAIN) >= 0;
    S.toast = { tone: 'ok', at: S.now, sel: ev[0] && ev[0].sel, client: S.client,
      title: ev[0] ? ev[0].title : d.kind === 'opp' ? 'Handed to ' + pname(toId) : 'Follow-up sent to ' + (toId ? first(toId) : d.toEmail),
      body: internal && d.kind === 'opp' ? 'The opportunity stays lit until the account exec picks it up.' : (ev[0] ? (isLive() ? 'Gmail opened with your follow-up to ' : 'Follow-up sent to ') + (toId ? first(toId) : d.toEmail) + '. ' : '') + 'Skyline is watching for ' + (toId ? first(toId) + '’s' : 'a') + ' reply and relights the alarm if there is none by ' + F.dt(watchUntil) + '.' };
    render();
  }

  // ---------------- pages ----------------
  function renderPage() {
    const v = S.view;
    $('page').innerHTML = '<div class="page-in">' + (v === 'region' ? regionPage() : v === 'sources' ? sourcesPage() : v === 'agents' ? agentsPage() : archivesPage()) + '</div>';
  }

  function regionPage() {
    const ids = active();
    const cards = ids.map((id, k) => {
      const c = S.model.clients[id];
      const n = c.counts;
      const top = c.issues.filter((i) => i.status !== 'contained').sort((a, b) => ({ fire: 0, smoke: 1, watch: 2, quiet: 3 }[a.kind] - { fire: 0, smoke: 1, watch: 2, quiet: 3 }[b.kind]))[0];
      const cnt = (v, label, color) => '<span class="count' + (v ? '' : ' zero') + '"><span class="dot" style="background:' + color + '"></span>' + v + ' ' + label + '</span>';
      const flag = k === 0 && c.score > 0 ? '<span>NEEDS YOU FIRST</span>' : '<span>' + (c.done ? '✓ COMPLETE' : c.score ? 'WATCH' : 'HEALTHY') + '</span>';
      return '<div class="panel ccard" role="button" tabindex="0" data-act="open-client" data-id="' + id + '" aria-label="Open ' + esc(c.name) + '">' +
        '<div class="phead ' + (k === 0 && c.score > 0 ? '' : 'teal') + '" style="' + (k === 0 && c.score > 0 ? 'background:var(--fire);color:#fff' : '') + ';width:100%"><span>' + esc(c.name.toUpperCase()) + '</span>' + flag + '</div>' +
        '<div class="mini"><div class="holder"><div class="plane">' + SKY.renderCity(c, { mini: true }) + '</div></div></div>' +
        '<div class="ccard-body"><div class="ccard-sub">' + esc(c.project || '') + (c.goLive ? ' · go-live ' + F.day(c.goLive) + ' (' + daysTo(c.goLive) + ' days)' : '') + '</div>' +
        '<div class="counts">' + cnt(n.fire, n.fire === 1 ? 'fire' : 'fires', 'var(--fire)') + cnt(n.waiting, 'blocked', 'var(--jam)') + cnt(n.smoke, 'smoky', 'var(--smoke)') + cnt(n.quiet, 'dark', 'var(--quiet)') + cnt(n.opp, n.opp === 1 ? 'opportunity' : 'opportunities', 'var(--gold)') + '</div>' +
        (top ? '<div class="ccard-top">' + esc(top.title) + '</div>' : '<div class="ccard-top">Nothing needs you here.</div>') +
        (c.done ? '<div class="donebox"><div><b>✓ Project complete</b><span>Every building is at 100%.</span></div><button type="button" class="btn btn-p btn-sm" data-act="archive" data-id="' + id + '">ARCHIVE PROJECT</button></div>' : '') + '</div></div>';
    }).join('');
    return '<div><h1>Your region</h1><p class="lede">' + plural(ids.length, 'client') + ' as mini skylines, sorted so the city that needs help most comes first. Fires and blocked people count the most. Click a skyline to walk its streets.</p></div><div class="region">' + cards + '</div>';
  }

  function getPath(o, p) { return p.split('.').reduce((x, k) => x[k], o); }
  function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; }

  function discoveredHtml() {
    return S.model.order.map((id) => {
      const c = S.model.clients[id];
      return '<div class="panel"><div class="phead teal"><span>' + esc(c.name.toUpperCase()) + '</span><span>' + esc(c.domain) + '</span></div><div class="pbody">' +
        '<p class="note">Discovered from ' + plural(c.msgCount, 'message') + ': ' + Object.keys(c.how).map((k) => c.how[k] + ' by ' + ({ domain: 'email domain', channel: 'Slack channel name', mention: 'name mention' }[k])).join(', ') + '.' + (c.project ? ' Project “' + esc(c.project) + '”' + (c.goLive ? ', go-live ' + F.day(c.goLive) : '') + '.' : '') + '</p>' +
        '<div class="facts-k">CLIENT CONTACTS</div><div class="people">' + c.people.map((p) => '<span class="person"><b>' + who(p) + '</b> · ' + esc(SKY.people[p].role) + '</span>').join('') + '</div>' +
        '<div class="facts-k">TEAMMATES</div><div class="people">' + c.internal.map((p) => '<span class="person"><b>' + who(p) + '</b> · ' + esc(SKY.people[p].role) + '</span>').join('') + '</div>' +
        '<div class="facts-k">WORKSTREAMS</div><div class="people">' + c.ws.map((w) => '<span class="person"><b>' + esc(w.name) + '</b>' + (w.aliases.length ? ' · also “' + w.aliases.map(esc).join('”, “') + '”' : '') + '</span>').join('') + '</div></div></div>';
    }).join('');
  }

  function liveSourcesPage() {
    if (!LIVE) return '<div><h1>Sources</h1><p class="lede">Loading live data…</p></div>';
    const st = LIVE.status, A = LIVE.access;
    const count = (f) => SKY.messages.filter(f).length;
    const tog = (kind, key, on, label, n, sub) => '<label class="tog"><input type="checkbox" data-act="live-access" data-kind="' + kind + '" data-key="' + esc(key) + '"' + (on ? ' checked' : '') + '><span>' + esc(label) + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</span>' + (n === null ? '' : '<span class="cnt">' + plural(n, 'message') + '</span>') + '</label>';
    const pill = (on, yes, no) => '<span class="pill ' + (on ? 'on' : 'off') + '">' + (on ? yes : no) + '</span>';
    const mail = '<div class="panel"><div class="phead teal"><span>GMAIL</span><span>' + esc(st.gmail.account || 'GOOGLE') + '</span></div><div class="pbody">' +
      (!st.gmail.configured
        ? '<div class="conn">' + pill(false, '', 'NOT SET UP') + '</div><p class="note">Create a Google OAuth client (type “Desktop app”) and put its ID and secret in <code>server/.env</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, then restart the server. Steps are in server/README.md.</p>'
        : st.gmail.connected
          ? '<div class="conn">' + pill(true, 'CONNECTED', '') + '<button type="button" class="btn btn-sm" data-act="live-disconnect" data-src="gmail">Disconnect</button></div>' +
            '<div>' + st.labels.map((f) => tog('folder', f, A.outlook.folders[f] !== false && A.outlook.folders[f] !== undefined, f, count((m) => m.src === 'email' && m.where === f), /^(inbox|sent)$/i.test(f) ? '' : 'Off unless you turn it on')).join('') + '</div>' +
            '<p class="note">Read-only (gmail.readonly). Promotions and social mail are skipped. Turning a label off deletes what Skyline stored from it.</p>'
          : '<div class="conn">' + pill(false, '', 'NOT CONNECTED') + '<a class="btn btn-p btn-sm" href="/auth/google/start">CONNECT GMAIL</a></div><p class="note">You’ll sign in with Google. Skyline asks only to read your mail. Google may warn that the app is unverified, because it’s your own app; choose Continue.</p>') + '</div></div>';
    const slack = '<div class="panel"><div class="phead teal"><span>SLACK</span><span>' + esc(st.slack.team || 'WORKSPACE') + '</span></div><div class="pbody">' +
      (st.slack.connected
        ? '<div class="conn">' + pill(true, 'CONNECTED', '') + (st.slack.fromEnv ? '<span class="note">Token from server/.env</span>' : '<button type="button" class="btn btn-sm" data-act="live-disconnect" data-src="slack">Disconnect</button>') + '</div>' +
          '<div>' + st.channels.map((ch) => tog('channel', ch, A.slack.channels[ch] !== false, ch, count((m) => m.src === 'slack' && m.where === ch), SKY.sharedChannels[ch] ? 'Shared with the client' : '')).join('') +
          tog('dms', 'dms', A.slack.dms, 'Direct messages', count((m) => m.src === 'slack' && m.dm), st.dmCount + ' conversations · off by default') + '</div>' +
          '<p class="note">Skyline reads channels its token is a member of. Invite the app to a channel to add it.</p>'
        : '<div class="conn">' + pill(false, '', 'NOT CONNECTED') + '</div><form class="slackform" data-form="slack"><input name="token" type="password" autocomplete="off" placeholder="xoxp-… or xoxb-… token" aria-label="Slack token"><button type="submit" class="btn btn-p btn-sm">CONNECT SLACK</button></form>' +
          '<p class="note">Paste a user or bot token from your Slack app (scopes are listed in server/README.md). It stays on this computer in server/data.</p>') + '</div></div>';
    const u = st.usage;
    const claude = '<div class="panel"><div class="phead"><span>CLAUDE · SIGNAL EXTRACTION</span><span class="pill ' + (st.pending ? 'warn' : 'on') + '">' + (st.pending ? st.pending + ' TO READ' : 'UP TO DATE') + '</span></div><div class="pbody">' +
      '<p class="note">Only messages tied to a client are sent to Claude (claude-opus-5-5), after redaction. ' + plural(u.calls, 'request') + ' so far · ' + (u.input + u.output).toLocaleString() + ' tokens · ' + u.cacheRead.toLocaleString() + ' served from cache.</p>' +
      '<label class="tog"><input type="checkbox" data-act="live-access" data-kind="redact" data-key="redact"' + (A.redact ? ' checked' : '') + '><span>Redact SSNs and account numbers before anything is stored or sent<span class="sub">Applied on the server, before Claude or the agents see the text.</span></span></label></div></div>';
    const sync = '<div class="panel"><div class="phead"><span>CONTINUOUS PROCESSING</span><span class="pill ' + (st.syncing ? 'warn' : 'on') + '">' + (st.syncing ? 'SYNCING' : 'IDLE') + '</span></div><div class="pbody">' +
      '<p class="note">' + (st.lastSync ? 'Last sync ' + esc(F.dt(st.lastSync)) + '.' : 'Not synced yet.') + ' The server syncs every few minutes and this page refreshes on its own.</p>' +
      '<div class="row"><button type="button" class="btn btn-p" data-act="sync"' + (st.syncing ? ' disabled' : '') + '>' + (st.syncing ? 'SYNCING…' : 'SYNC NOW') + '</button></div>' +
      '<div class="facts-k">RECENT EVENTS</div><ul class="list">' + (LIVE.events.slice(0, 8).map((e) => '<li><span class="pill ' + ({ ok: 'on', warn: 'warn', bad: 'bad' }[e.level] || 'on') + '">' + esc(e.source.toUpperCase()) + '</span><span>' + esc(e.text) + '</span><span class="when">' + esc(F.dt(e.at)) + '</span></li>').join('') || '<li class="empty">Nothing yet.</li>') + '</ul></div></div>';
    const disc = discoveredHtml();
    return '<div><h1>Sources · live</h1><p class="lede">Your real Gmail and Slack. The Skyline server on this computer reads new messages, finds clients by their email domains, and has Claude pull out promises, blockers, questions and requests. Switch to DEMO at the top any time.</p></div>' +
      '<div class="grid2">' + mail + slack + claude + sync + '</div><h2>Discovered automatically</h2>' + (disc ? '<div class="grid2">' + disc + '</div>' : '<div class="panel"><div class="pbody"><p class="empty">No clients yet. Skyline treats an outside email domain as a client once you have two or more messages with it. Connect a source and sync.</p></div></div>');
  }

  function sourcesPage() {
    if (isLive()) return liveSourcesPage();
    const A = S.access;
    const recv = S.messages.filter((m) => t(m.ts) <= t(S.now));
    const count = (f) => recv.filter(f).length;
    const tog = (path, label, n, sub) => '<label class="tog"><input type="checkbox" data-act="access" data-path="' + path + '"' + (getPath(A, path) ? ' checked' : '') + '><span>' + esc(label) + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '') + '</span><span class="cnt">' + plural(n, 'message') + '</span></label>';
    const conn = (path, on) => '<div class="conn"><span class="pill ' + (on ? 'on' : 'off') + '">' + (on ? 'CONNECTED' : 'DISCONNECTED') + '</span><button type="button" class="btn btn-sm" data-act="access-flip" data-path="' + path + '">' + (on ? 'Disconnect' : 'Connect') + '</button></div>';
    const outlook = '<div class="panel"><div class="phead teal"><span>OUTLOOK</span><span>' + esc(A.outlook.account) + '</span></div><div class="pbody">' + conn('outlook.on', A.outlook.on) +
      '<div>' + Object.keys(A.outlook.folders).map((f) => tog('outlook.folders.' + f, f, count((m) => m.src === 'email' && m.where === f), f === 'HR-Confidential' ? 'Off by default: personal data' : '')).join('') +
      tog('outlook.transcripts', 'Teams meeting transcripts', count((m) => m.src === 'meeting'), 'Calls on your calendar') + '</div></div></div>';
    const slack = '<div class="panel"><div class="phead teal"><span>SLACK</span><span>' + esc(A.slack.workspace) + '</span></div><div class="pbody">' + conn('slack.on', A.slack.on) +
      '<div>' + Object.keys(A.slack.channels).map((ch) => tog('slack.channels.' + ch, ch, count((m) => m.src === 'slack' && m.where === ch), SKY.sharedChannels[ch] ? 'Shared with the client' : '')).join('') +
      tog('slack.dms', 'Direct messages', count((m) => m.src === 'slack' && m.dm), 'Off by default') + '</div></div></div>';
    const privacy = '<div class="panel"><div class="phead"><span>PRIVACY</span><span>' + S.model.redacted + ' REDACTED</span></div><div class="pbody">' +
      '<label class="tog"><input type="checkbox" data-act="access" data-path="redact"' + (A.redact ? ' checked' : '') + '><span>Redact SSNs and bank numbers before agents read a message<span class="sub">Applied in the Intake agent, before anything else sees the text.</span></span></label>' +
      '<p class="note">Skyline never sends anything on its own. Every email it drafts waits for you to review, edit and press Send.</p>' +
      '<div class="facts-k">SKIPPED UNDER YOUR RULES (' + S.model.skipped.length + ')</div><ul class="list">' + (S.model.skipped.map((s) => '<li><span>' + esc(s.label) + '</span><span class="when">' + esc(s.why) + '</span></li>').join('') || '<li class="empty">Nothing skipped.</li>') + '</ul></div></div>';
    const live = '<div class="panel"><div class="phead"><span>CONTINUOUS PROCESSING</span><span class="pill ' + (S.live ? 'warn' : 'on') + '" style="color:var(--ink)">' + (S.live ? 'STREAMING' : 'UP TO DATE') + '</span></div><div class="pbody">' +
      '<p class="note">Last checked ' + esc(F.dt(S.now)) + '. ' + S.model.stats.intake.processed + ' messages processed. ' + plural(S.messages.filter((m) => t(m.ts) > t(S.now)).length, 'message') + ' queued in the demo feed.</p>' +
      '<div class="row"><button type="button" class="btn btn-p" data-act="live">' + (S.live ? 'PAUSE LIVE FEED' : 'PLAY LIVE FEED') + '</button></div></div></div>';
    const disc = discoveredHtml();
    return '<div><h1>Sources</h1><p class="lede">Connect Outlook and Slack once. Skyline reads new messages continuously, finds the clients, people and workstreams by itself, and only touches what you allow here. Changing a switch re-runs every agent, and the city updates.</p></div>' +
      '<div class="grid2">' + outlook + slack + privacy + live + '</div><h2>Discovered automatically</h2><div class="grid2">' + disc + '</div>';
  }

  function agentsPage() {
    const st = S.model.stats;
    const av = (id) => { const a = SKY.AGENTS.find((x) => x.id === id); return a ? '<span class="av" style="background:' + a.color + '">' + a.name.slice(0, 2).toUpperCase() + '</span>' : '<span class="av" style="background:#9AA8B2">AD</span>'; };
    const nm = (id) => id === 'all' ? 'all agents' : id === 'admin' ? 'the team' : (SKY.AGENTS.find((x) => x.id === id) || { name: id }).name;
    const list = SKY.AGENTS.map((a) => '<div class="agent">' + av(a.id) + '<div><b>' + esc(a.name) + '</b> <span class="pill ' + (st[a.id].status === 'ok' ? 'on' : 'bad') + '">' + (st[a.id].status === 'ok' ? 'OK' : 'FAILED') + '</span><p>' + esc(a.role) + '</p></div></div>').join('');
    const scope = S.busScope;
    const runs = S.runs.map((r) => {
      const es = r.entries.filter((e) => scope === 'all' || !e.client || e.client === S.client);
      return '<div class="run"><div class="run-h"><span>' + esc(r.trigger) + '</span><span>' + esc(F.dt(r.at)) + '</span></div><div class="bus">' +
        (es.length ? es.map((e) => '<div class="bmsg">' + av(e.from) + '<div><span class="to"><b>' + esc(nm(e.from)) + '</b> → ' + esc(nm(e.to)) + (scope === 'all' && e.client ? ' · ' + esc(S.model.clients[e.client] ? S.model.clients[e.client].name : e.client) : '') + '</span><div>' + esc(e.text) + '</div></div></div>').join('') : '<div class="empty">No new findings in this run' + (scope === 'client' && S.model.order.length ? ' for ' + esc(cl().name) : '') + '.</div>') + '</div></div>';
    }).join('');
    return '<div><h1>Agent room</h1><p class="lede">Eight specialized agents share one message bus. Each posts what it found and hands it on. Fire watch proposes, the Verifier checks every claim against the original quote, and only verified findings reach the city. Each run below shows what was new.</p></div>' +
      '<div class="agents"><div class="panel"><div class="phead teal"><span>AGENTS</span><span>' + SKY.AGENTS.length + '</span></div><div class="pbody">' + list + '</div></div>' +
      '<div class="panel"><div class="phead ink"><span>MESSAGE BUS</span><span class="seg" role="group" aria-label="Scope"><button type="button" data-act="bus" data-scope="client" aria-pressed="' + (scope === 'client') + '">' + esc(S.model.order.length ? cl().name.toUpperCase() : 'THIS CLIENT') + '</button><button type="button" data-act="bus" data-scope="all" aria-pressed="' + (scope === 'all') + '">ALL CLIENTS</button></span></div>' + runs + '</div></div>';
  }

  function archivesPage() {
    const ids = Object.keys(S.archived).sort((x, y) => t(S.archived[y].at) - t(S.archived[x].at));
    const cards = ids.map((id) => {
      const a = S.archived[id];
      const c = S.model.clients[id];
      return '<div class="panel ccard-static"><div class="phead teal"><span>' + esc(a.name.toUpperCase()) + '</span><span>✓ ARCHIVED ' + esc(F.dow(a.at).toUpperCase()) + '</span></div>' +
        (c ? '<div class="mini"><div class="holder"><div class="plane">' + SKY.renderCity(c, { mini: true }) + '</div></div></div>' : '') +
        '<div class="ccard-body"><div class="ccard-sub">' + esc(a.project || 'Implementation') + (a.goLive ? ' · go-live ' + F.day(a.goLive) : '') + ' · ' + plural(a.msgCount, 'message') + '</div>' +
        '<div class="counts">' + a.ws.map((w) => '<span class="count">✓ ' + esc(w.name) + ' ' + w.pct + '%</span>').join('') + '</div>' +
        '<div class="row"><button type="button" class="btn btn-sm" data-act="restore" data-id="' + esc(id) + '">Restore to the region</button></div></div></div>';
    }).join('');
    return '<div><h1>Archives</h1><p class="lede">Finished projects leave your region, so the skyline only shows live work. Each one keeps its city and everything Skyline learned, and you can bring it back any time.</p></div>' +
      (cards ? '<div class="region">' + cards + '</div>' : '<div class="panel"><div class="pbody"><p class="empty">Nothing archived yet. When every building in a project reaches 100%, choose <b>Archive project</b> in the top-left panel or on its Region card.</p></div></div>');
  }

  // ---------------- modal ----------------
  function renderModal() {
    const md = S.modal;
    if (!md) { $('modal').innerHTML = ''; return; }
    let title = '', body = '';
    if (md.type === 'source') {
      title = md.items.length > 1 ? plural(md.items.length, 'SOURCE') : 'SOURCE';
      body = md.items.map((it) => messageCard(msg(it.msgId), it.quote)).join('');
    } else if (md.type === 'draft') {
      const d = md.draft;
      title = 'DRAFT · REVIEW BEFORE SENDING';
      body = '<div class="field"><label for="d-to">To</label><input id="d-to" data-draft="toEmail" value="' + esc(d.toEmail) + '"></div>' +
        '<div class="field"><label for="d-cc">Cc</label><input id="d-cc" data-draft="ccEmail" value="' + esc(d.ccEmail) + '"></div>' +
        '<div class="field"><label for="d-sub">Subject</label><input id="d-sub" data-draft="subject" value="' + esc(d.subject) + '"></div>' +
        '<textarea aria-label="Email body" data-draft="body">' + esc(d.body) + '</textarea>' +
        '<div class="ctx"><span>Context used:</span>' + d.ctx.map((x) => '<span class="chip">' + esc(x) + '</span>').join('') + '</div>' +
        '<div class="row"><span class="note">Tone</span><span class="seg" role="group" aria-label="Tone">' + ['friendly', 'neutral', 'firm'].map((x) => '<button type="button" data-act="tone" data-tone="' + x + '" aria-pressed="' + (d.tone === x) + '">' + x.toUpperCase() + '</button>').join('') + '</span></div>' +
        '<div class="row"><button type="button" class="btn btn-p' + (d.kind === 'nudge' && findItem(d.id).i.kind === 'fire' ? ' btn-fire' : '') + '" data-act="send">' + (isLive() ? 'OPEN IN GMAIL' : 'SEND') + '</button><button type="button" class="btn" data-act="close">Cancel</button></div>' +
        '<p class="note">' + (isLive() ? 'Opens Gmail with this email filled in. Nothing goes out until you press Send there. Skyline starts watching for a reply now.' : 'Nothing is sent until you press Send. In this demo Send records the email in your Sent folder and starts the reply watch; no real mail leaves the browser.') + '</p>';
    } else if (md.type === 'meeting') {
      const d = md.draft;
      title = 'MEETING INVITE · REVIEW BEFORE SENDING';
      body = '<div class="field"><label for="m-title">Title</label><input id="m-title" data-draft="title" value="' + esc(d.title) + '"></div>' +
        '<div class="field"><label for="m-to">Invite</label><input id="m-to" data-draft="emails" value="' + esc(d.emails) + '"></div>' +
        '<div class="field"><label>When</label><div class="slots" role="radiogroup" aria-label="Suggested times">' + d.slots.map((x, k) => '<button type="button" class="slot" role="radio" aria-checked="' + (d.slot === k) + '" data-act="slot" data-k="' + k + '">' + esc(F.dt(x)) + '</button>').join('') + '</div></div>' +
        '<div class="field"><label for="m-len">Length</label><select id="m-len" data-draft="minutes">' + [15, 20, 30, 45].map((m) => '<option value="' + m + '"' + (+d.minutes === m ? ' selected' : '') + '>' + m + ' minutes</option>').join('') + '</select></div>' +
        '<textarea aria-label="Agenda" data-draft="agenda">' + esc(d.agenda) + '</textarea>' +
        '<div class="row"><button type="button" class="btn btn-p" data-act="send-meeting">' + (isLive() ? 'OPEN IN GOOGLE CALENDAR' : 'SEND INVITE') + '</button><button type="button" class="btn" data-act="close">Cancel</button></div>' +
        '<p class="note">' + (isLive() ? 'Opens a new Google Calendar event with this filled in and the guests added. Nothing goes out until you press Save there.' : 'Suggested times are the next working slots. A Teams link is added when the invite goes out. In this demo the invite stays in the browser.') + '</p>';
    } else if (md.type === 'correct') {
      title = 'CORRECT THIS INSIGHT';
      body = '<form data-form="correct" class="cform-wrap">' + correctForm(md.id) + '</form>';
    }
    $('modal').innerHTML = '<div class="scrim" data-act="scrim"><div class="panel modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="phead ink"><span>' + esc(title) + '</span><button type="button" class="mclose" data-act="close">CLOSE ✕</button></div><div class="mbody">' + body + '</div></div></div>';
    const f = $('modal').querySelector('textarea, input, button');
    if (f && !md.focused) { f.focus(); md.focused = true; }
  }

  function messageCard(m, quote) {
    if (!m) return '<div class="empty">That message is no longer available under your access rules.</div>';
    const kind = m.src === 'meeting' ? 'TEAMS TRANSCRIPT · ' + m.where.toUpperCase() + ' @ ' + m.offset : m.src === 'slack' ? 'SLACK · ' + m.where.toUpperCase() : (isLive() ? 'GMAIL · ' : 'OUTLOOK · ') + m.where.toUpperCase();
    let text = esc(m.body);
    if (quote) {
      const idx = m.body.toLowerCase().indexOf(quote.toLowerCase());
      if (idx >= 0) text = esc(m.body.slice(0, idx)) + '<mark>' + esc(m.body.slice(idx, idx + quote.length)) + '</mark>' + esc(m.body.slice(idx + quote.length));
    }
    if (m.src === 'meeting') text = text.split('\n').map((l) => l.replace(/^([A-Z][a-z]+):/, '<span class="spk">$1:</span>')).join('\n');
    const whoList = (ids) => (ids || []).map((p) => who(p)).join(', ');
    return '<div class="msg-card"><div class="msg-src"><span>' + esc(kind) + '</span>' + (m.redacted ? '<span class="pill warn">REDACTED BY SKYLINE</span>' : '') + (m.link ? '<a href="' + esc(m.link) + '" target="_blank" rel="noopener">' : '<a href="#" data-act="noop">') + 'Open in ' + (m.src === 'slack' ? 'Slack' : isLive() ? 'Gmail' : 'Outlook') + ' ↗</a></div>' +
      '<dl class="msg-meta"><dt>From</dt><dd><b>' + esc(pname(m.from)) + '</b> &lt;' + esc(SKY.people[m.from].email) + '&gt;</dd>' +
      (m.to && m.to.length ? '<dt>' + (m.src === 'meeting' ? 'With' : 'To') + '</dt><dd>' + whoList(m.to) + (m.cc ? ' · cc ' + whoList(m.cc) : '') + '</dd>' : '') +
      '<dt>When</dt><dd>' + esc(F.dt(m.ts)) + (m.src === 'meeting' ? ' · at ' + esc(m.offset) + ' in the recording' : '') + '</dd>' +
      (m.subject ? '<dt>Subject</dt><dd>' + esc(m.subject) + '</dd>' : '') + '</dl><div class="msg-body">' + text + '</div></div>';
  }

  function correctForm(id) {
    if (id.indexOf('ws:') === 0) {
      const [cid, wid] = id.slice(3).split('/');
      const w = wsById(S.model.clients[cid], wid);
      return '<p class="summary">' + esc(w.name) + ' shows ' + w.pct + '% based on ' + (w.pctMsg ? esc(SKY.srcLabel(w.pctMsg)) : 'no progress message') + '. What is it really?</p>' +
        '<div class="cform"><input type="number" min="0" max="100" id="c-pct" value="' + w.pct + '" aria-label="Progress percent"><input id="c-note" placeholder="Why? (optional, helps the agents learn)"></div>' +
        '<div class="row"><button type="button" class="btn btn-p" data-act="save-correct">SAVE CORRECTION</button><button type="button" class="btn" data-act="close">Cancel</button></div>';
    }
    const { c, i } = findItem(id);
    const isCommit = i.type === 'commit';
    const k = isCommit ? c.commits[i.key] : null;
    const opt = (v, label, sub, extra) => '<label class="opt"><input type="radio" name="c-kind" value="' + v + '"' + (v === 'resolved' ? ' checked' : '') + '><span>' + label + (sub ? '<small>' + sub + '</small>' : '') + (extra || '') + '</span></label>';
    const people = Object.keys(SKY.people).filter((p) => c.people.indexOf(p) >= 0 || c.internal.indexOf(p) >= 0);
    return '<p class="summary">“' + esc(i.title) + '”</p><div class="cform">' +
      opt('resolved', 'This is already resolved', 'Skyline removes it and stops alerting on it.') +
      opt('dismiss', 'This isn’t a real ' + (i.ev ? 'opportunity' : 'risk'), 'Skyline removes it and notes why.') +
      (isCommit ? opt('due', 'The due date is wrong', '', '<input type="datetime-local" id="c-due" value="' + F.iso(k.due) + '">') +
        opt('owner', 'Someone else owns this', '', '<select id="c-owner">' + people.map((p) => '<option value="' + p + '"' + (p === k.owner ? ' selected' : '') + '>' + esc(pname(p)) + '</option>').join('') + '</select>') : '') +
      '<input id="c-note" placeholder="What’s actually going on? (optional)"></div>' +
      '<div class="row"><button type="submit" class="btn btn-p">SAVE CORRECTION</button><button type="button" class="btn" data-act="close">Cancel</button></div>' +
      '<p class="note">Corrections apply on top of what the agents find, so they survive new messages. You can undo them from the building’s panel.</p>';
  }

  function saveCorrection() {
    const id = S.modal.id;
    const note = ($('c-note') || {}).value || '';
    const cid = 'x' + (S.corrections.length + 1) + '-' + Date.now();
    if (id.indexOf('ws:') === 0) {
      const v = Math.max(0, Math.min(100, +$('c-pct').value || 0));
      const [c, w] = id.slice(3).split('/');
      S.corrections.push({ id: cid, target: id, field: 'pct', value: v, note, label: wsById(S.model.clients[c], w).name + ' progress → ' + v + '%' });
    } else {
      const kind = document.querySelector('input[name="c-kind"]:checked').value;
      const { c, i } = findItem(id);
      if (kind === 'due') S.corrections.push({ id: cid, target: 'commit:' + i.key, field: 'due', value: $('c-due').value, note, label: i.what + ' due ' + F.dow($('c-due').value) });
      else if (kind === 'owner') S.corrections.push({ id: cid, target: 'commit:' + i.key, field: 'owner', value: $('c-owner').value, note, label: i.what + ' → ' + pname($('c-owner').value) });
      else S.corrections.push({ id: cid, target: 'issue:' + id, field: kind, value: true, note });
      void c;
    }
    S.modal = null;
    recompute('You corrected an insight');
  }

  // ---------------- demo ----------------
  function queued() { return S.messages.filter((m) => t(m.ts) > t(S.now)).sort((a, b) => t(a.ts) - t(b.ts)); }
  function renderDemo() {
    if (!S.demoOpen) { $('demo').innerHTML = ''; return; }
    const q = queued();
    const fu = S.followUps['commit:census'];
    const replied = S.messages.some((m) => m.id === 'r-census');
    const arrived = S.messages.some((m) => m.id === 'f-census');
    const item = (act, label, sub, disabled) => '<button type="button" class="demo-item" data-act="' + act + '"' + (disabled ? ' disabled' : '') + '><b>' + label + '</b><span>' + sub + '</span></button>';
    $('demo').innerHTML = '<div class="panel demo"><div class="phead" style="background:var(--gold)"><span>DEMO CONTROLS</span><span>' + esc(F.dt(S.now).toUpperCase()) + '</span></div><div class="demo-body">' +
      item('live', S.live ? '❚❚ Pause the live feed' : '▶ Play the live feed', q.length ? plural(q.length, 'new message') + ' waiting. One arrives every few seconds and every agent re-runs.' : 'Inbox is caught up.', !q.length && !S.live) +
      item('reply', 'Dana replies to your follow-up', fu ? (replied ? 'Already replied.' : 'She offers a partial census by Tuesday. The fire becomes contained.') : 'Use Fix this issue on Employee data import first.', !fu || replied) +
      item('file', 'The census file arrives', arrived ? 'Already arrived.' : 'The fire goes out, blocked people can start, and the building grows.', arrived) +
      item('ff', 'Jump to the next business morning', 'Unanswered follow-ups relight their alarms. Late promises catch fire.') +
      item('golive', 'Northwind Foods goes live', S.messages.some((m) => m.id === 'l-nw') ? 'Already live.' : 'Omar signs off every workstream. The whole project hits 100% and can be archived.', S.messages.some((m) => m.id === 'l-nw')) +
      item('reset', 'Reset the demo', 'Back to Fri Oct 16, 15:40 with nothing sent.') + '</div></div>';
  }
  function advanceTo(m) { S.now = m.ts; recompute('New ' + (m.src === 'slack' ? 'Slack message in ' + m.where : m.src === 'meeting' ? 'meeting note' : 'email') + ' from ' + pname(m.from), m); }
  function toggleLive() {
    if (S.live) { clearInterval(S.live); S.live = null; render(); return; }
    const step = () => {
      const q = queued();
      if (!q.length) { clearInterval(S.live); S.live = null; S.toast = { tone: 'ok', at: S.now, title: 'Inbox caught up', body: 'Every new message has been processed.' }; render(); return; }
      advanceTo(q[0]);
    };
    S.live = setInterval(step, 3500);
    step();
  }

  // ---------------- moving the city and the birds ----------------
  // Drag to pan, pinch or ⌘-scroll to zoom, double-click empty ground to recenter.
  const VIEW = { x: 0, y: 0, zoom: 1 };
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function renderViewCtl() {
    const moved = VIEW.x || VIEW.y || VIEW.zoom !== 1;
    $('viewctl').innerHTML =
      '<button type="button" class="vbtn" data-act="zoom" data-k="0.8" aria-label="Zoom out" title="Zoom out">−</button>' +
      '<button type="button" class="vbtn" data-act="zoom" data-k="1.25" aria-label="Zoom in" title="Zoom in">+</button>' +
      '<button type="button" class="vbtn wide" data-act="recenter"' + (moved ? '' : ' disabled') + ' title="Put the city back (or double-click empty ground)">RECENTER</button>' +
      '<span class="vhint">Drag to move · pinch to zoom</span>';
  }

  const stage = $('stage');
  let drag = null, swallowClick = false;
  function clampView() {
    const w = window.innerWidth, h = window.innerHeight;
    VIEW.zoom = Math.max(0.5, Math.min(2.5, VIEW.zoom));
    VIEW.x = Math.max(-w * 0.75, Math.min(w * 0.75, VIEW.x));
    VIEW.y = Math.max(-h * 0.75, Math.min(h * 0.75, VIEW.y));
  }
  /** Zoom by `k`, keeping the point under the cursor (or the window centre) where it is. */
  function zoomAt(k, cx, cy) {
    const b = baseView();
    const ox = window.innerWidth / 2 + b.x + VIEW.x, oy = window.innerHeight / 2 + b.y + VIEW.y;
    const before = VIEW.zoom;
    VIEW.zoom *= k;
    clampView();
    const r = VIEW.zoom / before;
    const px = cx == null ? window.innerWidth / 2 : cx, py = cy == null ? window.innerHeight / 2 : cy;
    VIEW.x += (px - ox) * (1 - r);
    VIEW.y += (py - oy) * (1 - r);
    clampView();
    fit();
  }
  function recenter() {
    VIEW.x = 0; VIEW.y = 0; VIEW.zoom = 1;
    const holder = $('holder');
    holder.classList.add('ease');
    fit();
    setTimeout(() => holder.classList.remove('ease'), 400);
    renderViewCtl();
  }
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, vx: VIEW.x, vy: VIEW.y, id: e.pointerId, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return; // a small wobble is still a click
      drag.moved = true;
      stage.classList.add('panning');
    }
    VIEW.x = drag.vx + dx;
    VIEW.y = drag.vy + dy;
    clampView();
    fit();
  });
  function endDrag() {
    if (!drag) return;
    if (drag.moved) {
      swallowClick = true; // the click that ends a drag shouldn't select a building
      setTimeout(() => { swallowClick = false; }, 0);
      stage.classList.remove('panning');
      renderViewCtl();
    }
    drag = null;
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  document.addEventListener('click', (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; } }, true);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY); // pinch, or ⌘/ctrl + scroll
    else { VIEW.x -= e.deltaX; VIEW.y -= e.deltaY; clampView(); fit(); } // two-finger scroll pans
    renderViewCtl();
  }, { passive: false });
  // Safari and the menu bar app report trackpad pinches as gesture events
  let gestureZoom = 1;
  stage.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureZoom = VIEW.zoom; });
  stage.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt((gestureZoom * e.scale) / VIEW.zoom, e.clientX, e.clientY); });
  stage.addEventListener('gestureend', () => renderViewCtl());
  stage.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-pick]')) recenter(); });

  // A small flock crosses the sky now and then.
  function spawnFlock() {
    if (!S || S.view !== 'city' || document.hidden || reduceMotion()) return;
    const n = 3 + Math.floor(Math.random() * 4);
    const rtl = Math.random() < 0.5;
    const f = document.createElement('div');
    f.className = 'flock' + (rtl ? ' rtl' : '');
    f.style.top = (6 + Math.random() * 34) + '%';
    f.style.animationDuration = (16 + Math.random() * 10).toFixed(1) + 's';
    let html = '';
    for (let i = 0; i < n; i++) {
      // a loose V: followers trail behind the leader, alternating above and below
      const x = (rtl ? 1 : -1) * i * (18 + Math.random() * 6);
      const y = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (9 + Math.random() * 4);
      const size = 0.75 + Math.random() * 0.4;
      html += '<svg class="bird" width="' + Math.round(22 * size) + '" height="' + Math.round(12 * size) + '" viewBox="0 0 22 12" style="left:' + x.toFixed(0) + 'px;top:' + y.toFixed(0) + 'px;animation-delay:-' + (Math.random() * 0.4).toFixed(2) + 's">' +
        '<path d="M1 8 Q6 1 11 7 Q16 1 21 8" fill="none" stroke="#26303A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    f.innerHTML = html;
    f.addEventListener('animationend', (e) => { if (e.target === f) f.remove(); });
    $('birds').appendChild(f);
  }
  (function birdLoop() { setTimeout(() => { spawnFlock(); birdLoop(); }, 15000 + Math.random() * 20000); })();
  setTimeout(spawnFlock, 4000);

  // ---------------- events ----------------
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act],[data-pick]');
    if (!el) { if (S.demoOpen && !ev.target.closest('#demo')) { S.demoOpen = false; renderDemo(); renderNav(); } return; }
    const act = el.dataset.act;
    if (act === 'scrim' && ev.target !== el) return;
    if (act !== 'demo' && S.demoOpen && !el.closest('#demo')) { S.demoOpen = false; }
    if (!act && el.dataset.pick) { ev.preventDefault(); select(el.dataset.pick); renderCity(); renderDetail(); return; }
    switch (act) {
      case 'pick': select(el.dataset.pick); return render();
      case 'view': S.view = el.dataset.view; return render();
      case 'open-client': S.client = el.dataset.id; S.view = 'city'; S.sel = defaultSel(); return render();
      case 'detail-close': S.detail = 'closed'; S.editPct = null; return renderDetail();
      case 'detail-full': S.detail = S.detail === 'full' ? 'open' : 'full'; return renderDetail();
      case 'detail-open': S.detail = 'open'; return renderDetail();
      case 'detail-shrink': S.detail = 'open'; return renderDetail();
      case 'pct-edit': S.editPct = el.dataset.id; return renderDetail();
      case 'pct-cancel': S.editPct = null; return renderDetail();
      case 'slot': S.modal.draft.slot = +el.dataset.k; return renderModal();
      case 'send-meeting': return sendMeeting();
      case 'source': S.modal = { type: 'source', items: [{ msgId: el.dataset.msg, quote: el.dataset.q }] }; return renderModal();
      case 'sources': { const { i } = findItem(el.dataset.id); S.modal = { type: 'source', items: (i.evidence || i.ev).map((e) => ({ msgId: e.msgId, quote: e.quote })) }; return renderModal(); }
      case 'draft': S.modal = el.dataset.kind === 'meeting' ? { type: 'meeting', draft: buildMeeting(el.dataset.id) } : { type: 'draft', draft: buildDraft(el.dataset.kind, el.dataset.id) }; return renderModal();
      case 'tone': { const d = S.modal.draft; const nd = buildDraft(d.kind, d.id, el.dataset.tone); S.modal.draft = Object.assign(nd, { toEmail: d.toEmail, ccEmail: d.ccEmail }); return renderModal(); }
      case 'send': return sendDraft();
      case 'correct': S.modal = { type: 'correct', id: el.dataset.id }; return renderModal();
      case 'save-correct': return saveCorrection();
      case 'undo': S.corrections = S.corrections.filter((x) => x.id !== el.dataset.id); return recompute('You undid a correction');
      case 'close': case 'scrim': S.modal = null; return renderModal();
      case 'noop': ev.preventDefault(); return;
      case 'demo': S.demoOpen = !S.demoOpen; renderNav(); return renderDemo();
      case 'live': return toggleLive();
      case 'reply': { const m = SKY.scripted.danaReply(S.now); S.messages.push(m); return advanceTo(m); }
      case 'file': { const m = SKY.scripted.censusFile(S.now); S.messages.push(m); return advanceTo(m); }
      case 'ff': S.now = nextBizMorning(S.now, 9, 5); return recompute('Clock moved to ' + F.dt(S.now));
      case 'golive': { S.client = 'northwind'; S.view = 'city'; S.sel = null; const m = SKY.scripted.nwLive(S.now); S.messages.push(m); return advanceTo(m); }
      case 'archive': return archive(el.dataset.id);
      case 'restore': {
        const id = el.dataset.id, a = S.archived[id];
        delete S.archived[id];
        S.client = id; S.view = 'city'; S.sel = null; S.detail = 'open';
        recompute('You restored ' + a.name);
        S.toast = { tone: 'ok', at: S.now, title: a.name + ' is back', body: 'The project is back in your region.' };
        return render();
      }
      case 'reset': if (S.live) clearInterval(S.live); S = fresh(); return recompute('Initial sync of Outlook and Slack');
      case 'mode': return setMode(el.dataset.mode);
      case 'zoom': zoomAt(+el.dataset.k); return renderViewCtl();
      case 'recenter': return recenter();
      case 'sync': return liveCall(api('/api/sync', {}), 'Synced Gmail and Slack');
      case 'live-disconnect': return liveCall(api('/api/' + el.dataset.src + '/disconnect', {}), (el.dataset.src === 'slack' ? 'Slack' : 'Gmail') + ' disconnected');
      case 'access-flip': setPath(S.access, el.dataset.path, !getPath(S.access, el.dataset.path)); return recompute('Access rules changed');
      case 'bus': S.busScope = el.dataset.scope; return render();
    }
  });
  // Archive a whole client project: its city leaves the region and goes to Archives.
  function archive(cid) {
    const c = S.model.clients[cid];
    S.archived[cid] = { at: S.now, name: c.name, project: c.project, goLive: c.goLive, msgCount: c.msgCount, ws: c.ws.map((w) => ({ name: w.name, pct: w.pct })) };
    S.sel = null;
    const left = active().length;
    if (S.client === cid) { S.client = active()[0]; S.view = left ? 'region' : 'archives'; }
    recompute('You archived ' + c.name);
    S.toast = { tone: 'ok', at: S.now, title: c.name + ' archived', body: (c.project ? c.project + ' moved' : 'The project moved') + ' to Archives. You can restore it from there.' };
    render();
  }
  function select(pick) {
    if (S.sel !== pick) S.editPct = null;
    S.sel = pick;
    if (S.detail === 'closed') S.detail = 'open';
  }
  function savePct(form) {
    const v = Math.max(0, Math.min(100, Math.round(+form.pct.value || 0)));
    const target = form.dataset.id;
    const [cid, wid] = target.slice(3).split('/');
    const w = wsById(S.model.clients[cid], wid);
    const before = w.pct;
    S.corrections = S.corrections.filter((x) => !(x.target === target && x.field === 'pct'));
    S.corrections.push({ id: 'x' + (S.corrections.length + 1) + '-' + Date.now(), target, field: 'pct', value: v, note: '', label: w.name + ' progress → ' + v + '%' });
    S.editPct = null;
    recompute('You set ' + w.name + ' to ' + v + '%');
    S.toast = { tone: 'ok', at: S.now, client: cid, sel: 'ws:' + wid, title: 'Progress updated', body: w.name + ' went from ' + before + '% to ' + v + '%. The building ' + (v >= before ? 'grew' : 'shrank') + ' to match, and Skyline keeps your number until you undo it.' };
    render();
  }
  document.addEventListener('submit', (ev) => {
    const f = ev.target;
    if (f.dataset.form === 'pct') { ev.preventDefault(); savePct(f); }
    if (f.dataset.form === 'correct') { ev.preventDefault(); saveCorrection(); }
    if (f.dataset.form === 'slack') { ev.preventDefault(); liveCall(api('/api/slack/connect', { token: f.token.value }), 'Slack connected'); }
  });
  // hover / focus card for people: name, role, email
  const tip = () => $('tip');
  function showTip(el) {
    const r = el.getBoundingClientRect();
    tip().innerHTML = '<b>' + esc(el.textContent) + '</b><span>' + esc(el.dataset.role) + '</span><a href="mailto:' + esc(el.dataset.email) + '">' + esc(el.dataset.email) + '</a>';
    tip().hidden = false;
    const tw = tip().offsetWidth;
    tip().style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2)) + 'px';
    tip().style.top = (r.top - tip().offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip().offsetHeight - 8) + 'px';
  }
  document.addEventListener('mouseover', (ev) => { const el = ev.target.closest && ev.target.closest('.who'); if (el) showTip(el); else if (!ev.target.closest('#tip')) tip().hidden = true; });
  document.addEventListener('focusin', (ev) => { if (ev.target.classList && ev.target.classList.contains('who')) showTip(ev.target); });
  document.addEventListener('focusout', (ev) => { if (ev.target.classList && ev.target.classList.contains('who')) tip().hidden = true; });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.act === 'profile-select') { S.profile = el.value; return render(); }
    if (el.dataset.act === 'live-access') {
      const k = el.dataset.kind, key = el.dataset.key, on = el.checked;
      const access = k === 'folder' ? { mail: { labels: { [key]: on } } } : k === 'channel' ? { slack: { channels: { [key]: on } } } : k === 'dms' ? { slack: { dms: on } } : { redact: on };
      return liveCall(api('/api/settings', { access }), 'Access rules changed: ' + (k === 'redact' ? 'redaction' : key) + ' ' + (on ? 'on' : 'off'));
    }
    if (el.dataset.act === 'access') { setPath(S.access, el.dataset.path, el.checked); recompute('Access rules changed: ' + el.dataset.path.split('.').pop() + ' ' + (el.checked ? 'on' : 'off')); }
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.draft && S.modal && S.modal.draft) S.modal.draft[el.dataset.draft] = el.value;
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.getAttribute && ev.target.getAttribute('role') === 'button') { ev.preventDefault(); ev.target.click(); return; }
    if (ev.key === 'Escape') { if (S.modal) { S.modal = null; renderModal(); } else if (S.demoOpen) { S.demoOpen = false; render(); } else if (S.detail === 'full') { S.detail = 'open'; renderDetail(); } else if (S.editPct) { S.editPct = null; renderDetail(); } }
  });
  window.addEventListener('resize', () => { if (S.view === 'city') fit(); });

  function refreshLive(snap, trigger) {
    applyLive(snap);
    S.messages = SKY.messages.concat(S.messages.filter((m) => m.id.indexOf('out-') === 0)); // keep follow-ups you started here
    S.access = clone(SKY.defaultAccess);
    S.now = F.iso(new Date());
    recompute(trigger);
  }
  function liveCall(promise, trigger) {
    if (LIVE) LIVE.status.syncing = true;
    render();
    return promise.then((snap) => refreshLive(snap, trigger)).catch((e) => { S.toast = { tone: 'fire', at: S.now, title: 'Live data problem', body: e.message }; if (LIVE) LIVE.status.syncing = false; render(); });
  }
  let poll = null;
  async function setMode(mode) {
    if (mode === 'live') {
      if (!SERVED) {
        S.toast = { tone: 'fire', at: S.now, title: 'Live mode needs the Skyline server', body: 'In a terminal: cd server && npm start, then open http://localhost:8787. The demo keeps working here.' };
        return render();
      }
      try { applyLive(await api('/api/snapshot')); } catch (e) {
        S.toast = { tone: 'fire', at: S.now, title: 'Couldn’t reach the Skyline server', body: e.message };
        return render();
      }
    } else applyDemo();
    prefs.set('skyline-mode', mode);
    if (S && S.live) clearInterval(S.live);
    S = fresh(mode);
    if (mode === 'live' && location.hash === '#sources') S.view = 'sources';
    recompute(mode === 'live' ? 'Loaded live data from Gmail and Slack' : 'Initial sync of Outlook and Slack');
    clearInterval(poll);
    if (mode === 'live') {
      let last = JSON.stringify([LIVE.status.lastSync, LIVE.messages.length, LIVE.status.syncing, LIVE.status.pending]);
      poll = setInterval(async () => {
        try {
          const snap = await api('/api/snapshot');
          const sig = JSON.stringify([snap.status.lastSync, snap.messages.length, snap.status.syncing, snap.status.pending]);
          const changed = sig !== last;
          if (changed || t(F.iso(new Date())) - t(S.now) > 5 * 60000) { last = sig; refreshLive(snap, changed ? 'New messages from Gmail and Slack' : 'Checked for new messages'); }
        } catch (e) { /* server restarting; try again next tick */ }
      }, 20000);
    }
  }

  S = fresh();
  recompute('Initial sync of Outlook and Slack');
  const wanted = new URLSearchParams(location.search).get('mode') || prefs.get('skyline-mode');
  if (wanted === 'live' && SERVED) setMode('live');
  SKY.debug = () => S;
})();
