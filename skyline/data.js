// Mock corpus standing in for the Outlook, Slack and meeting-transcript connectors.
// `signals` on each message are what the extraction model would return for it.
// The agents in agents.js reason over these signals. No insight is hand-written.
window.SKY = window.SKY || {};
(function () {
  const SKY = window.SKY;

  SKY.DEMO_START = '2026-10-16T15:40';
  SKY.INTERNAL_DOMAIN = 'team.example';

  // ---------- formatting helpers shared by every module ----------
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = (x) => (x instanceof Date ? x : new Date(x));
  const pad = (n) => String(n).padStart(2, '0');
  SKY.fmt = {
    day: (x) => MON[d(x).getMonth()] + ' ' + d(x).getDate(),
    dow: (x) => DOW[d(x).getDay()] + ' ' + MON[d(x).getMonth()] + ' ' + d(x).getDate(),
    time: (x) => pad(d(x).getHours()) + ':' + pad(d(x).getMinutes()),
    dt: (x) => DOW[d(x).getDay()] + ' ' + MON[d(x).getMonth()] + ' ' + d(x).getDate() + ' · ' + pad(d(x).getHours()) + ':' + pad(d(x).getMinutes()),
    iso: (x) => { const v = d(x); return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate()) + 'T' + pad(v.getHours()) + ':' + pad(v.getMinutes()); }
  };
  SKY.srcLabel = (m) => {
    if (m.src === 'meeting') return m.where + ' · ' + SKY.fmt.day(m.ts) + ' · ' + m.offset;
    if (m.src === 'slack') return 'Slack ' + m.where + ' · ' + SKY.fmt.day(m.ts) + ' ' + SKY.fmt.time(m.ts);
    return 'Email · ' + SKY.fmt.day(m.ts) + ' ' + SKY.fmt.time(m.ts);
  };
  SKY.first = (id) => (SKY.people[id] ? SKY.people[id].name.split(' ')[0] : id);
  SKY.pname = (id) => (SKY.people[id] ? SKY.people[id].name : id);

  // ---------- directory ----------
  // Email domains are matched against the CRM to discover which client a thread is about.
  SKY.crm = [
    { id: 'brightline', name: 'Brightline Logistics', short: 'Brightline', domain: 'brightline.example', slack: 'brightline' },
    { id: 'harborpine', name: 'Harbor & Pine Clinics', short: 'Harbor & Pine', domain: 'harborpine.example', slack: 'harborpine' },
    { id: 'northwind', name: 'Northwind Foods', short: 'Northwind', domain: 'northwind.example', slack: 'northwind' },
    { id: 'cobalt', name: 'Cobalt Freight', short: 'Cobalt', domain: 'cobaltfreight.example', slack: 'cobalt' }
  ];

  const P = (name, role, domain, extra) => Object.assign({ name, role, email: name.toLowerCase().replace(/[^a-z ]/g, '').replace(' ', '.') + '@' + domain }, extra || {});
  SKY.people = {
    you: P('Jordan Avery', 'Implementation consultant', 'team.example', { you: true }),
    priya: P('Priya Shah', 'Payroll specialist', 'team.example', { skills: ['payroll'] }),
    ken: P('Ken Ito', 'Benefits specialist', 'team.example', { skills: ['benefits', '401k'] }),
    lena: P('Lena Ortiz', 'Account executive', 'team.example', { ae: true }),
    rafael: P('Rafael Gomez', 'Delivery manager', 'team.example'),
    dana: P('Dana Ruiz', 'HR director', 'brightline.example', { manager: 'tom' }),
    marcus: P('Marcus Lee', 'Payroll manager', 'brightline.example', { manager: 'dana' }),
    tom: P('Tom Brandt', 'VP, People', 'brightline.example'),
    alma: P('Alma Reyes', 'HR operations lead', 'harborpine.example', { manager: 'nadia' }),
    deshawn: P('Deshawn Cole', 'IT manager', 'harborpine.example', { manager: 'nadia' }),
    nadia: P('Nadia Brooks', 'COO', 'harborpine.example'),
    grace: P('Grace Okafor', 'Payroll lead', 'northwind.example', { manager: 'omar' }),
    omar: P('Omar Haddad', 'HR director', 'northwind.example'),
    ivan: P('Ivan Petrov', 'Controller', 'cobaltfreight.example', { manager: 'sofia' }),
    mei: P('Mei Lin', 'HR generalist', 'cobaltfreight.example', { manager: 'ivan' }),
    sofia: P('Sofia Marsh', 'CFO', 'cobaltfreight.example')
  };

  // ---------- access defaults (what Skyline may read) ----------
  SKY.defaultAccess = {
    outlook: { on: true, account: 'jordan.avery@team.example', transcripts: true, folders: { Inbox: true, Sent: true, Brightline: true, 'HR-Confidential': false } },
    slack: { on: true, workspace: 'team-impl', dms: false, channels: { '#brightline-impl': true, '#brightline-benefits': true, '#harborpine-impl': true, '#northwind-impl': true, '#cobalt-impl': true, '#random': false } },
    redact: true
  };
  SKY.sharedChannels = { '#brightline-impl': true }; // Slack Connect channels the client can also read

  SKY.connectorEvents = [
    { at: '2026-10-16T15:12', source: 'Slack', level: 'warn', text: 'Rate limited (HTTP 429) while reading #brightline-impl. Backed off 30s and retried. Recovered.' },
    { at: '2026-10-16T06:00', source: 'Outlook', level: 'ok', text: 'Access token refreshed. 0 messages missed.' }
  ];

  // ---------- messages ----------
  const msgs = [];
  const M = (id, o) => msgs.push(Object.assign({ id, to: [], signals: [] }, o));

  // Brightline Logistics: the full story from the reference design
  M('b1', { src: 'meeting', where: 'Kickoff call', ts: '2026-10-02T13:14', offset: '14:06', from: 'dana', to: ['marcus', 'you', 'priya'],
    body: "Jordan: Our first dependency is the employee census. Every downstream step reads from it.\nDana: I'll get you the full census file by end of next week.\nMarcus: Once that's in, I'll review job codes against it.\nDana: And we're still targeting a November 13 go-live.",
    signals: [
      { t: 'project', name: 'Payroll rollout', goLive: '2026-11-13', quote: "we're still targeting a November 13 go-live" },
      { t: 'commit', key: 'census', ws: 'Employee data import', owner: 'dana', what: 'Full employee census file', due: '2026-10-09T17:00', quote: "I'll get you the full census file by end of next week." },
      { t: 'commit', key: 'jobcodes', ws: 'Payroll setup', owner: 'marcus', by: 'marcus', what: 'Job code review', dependsOn: 'census', quote: "Once that's in, I'll review job codes against it." }
    ] });
  M('b2', { src: 'meeting', where: 'Weekly sync', ts: '2026-10-08T10:38', offset: '38:10', from: 'dana', to: ['marcus', 'you'],
    body: "Jordan: Can we lock a date for end-user training?\nDana: Let's figure out training closer to go-live.",
    signals: [{ t: 'progress', ws: 'Training', pct: 30, quote: "Let's figure out training closer to go-live." }, { t: 'mention', ws: 'Training', quote: "Let's figure out training closer to go-live." }] });
  M('b3', { src: 'slack', where: '#brightline-impl', ts: '2026-10-09T16:45', from: 'priya',
    body: "Census didn't come in today. I'll check again Monday.",
    signals: [{ t: 'status', key: 'census', ws: 'Employee data import', quote: "Census didn't come in today." }] });
  M('b4', { src: 'slack', where: '#brightline-benefits', ts: '2026-10-11T11:05', from: 'ken',
    body: 'First carrier file test failed validation. Re-sending once the plan codes are fixed.',
    signals: [{ t: 'slip', key: 'carrier-test', ws: 'Benefits', owner: 'ken', what: 'Carrier file test failed validation', quote: 'First carrier file test failed validation.' }, { t: 'progress', ws: 'Benefits', pct: 60 }] });
  M('b5', { src: 'email', where: 'Inbox', ts: '2026-10-12T09:14', from: 'dana', to: ['you', 'ken'], subject: 'Benefits: 401(k) contact', thread: 'bl-401k',
    body: "Hi both,\n\nQuick one: who's handling the 401(k) side? Our provider is asking for a contact.\n\nThanks,\nDana",
    signals: [{ t: 'question', key: '401k-owner', ws: 'Benefits', asker: 'dana', text: 'Who owns the 401(k) feed?', topic: '401k', quote: "who's handling the 401(k) side?" }] });
  M('b6', { src: 'email', where: 'Brightline', ts: '2026-10-13T10:02', from: 'dana', to: ['you'], subject: 'Tax setup status', thread: 'bl-tax',
    body: "Hi Jordan,\n\nAll three state registrations (Ohio, Texas, California) are confirmed. The only thing left is the local tax review for our Ohio warehouse.\n\nDana",
    signals: [{ t: 'progress', ws: 'Tax setup', pct: 90, quote: 'All three state registrations (Ohio, Texas, California) are confirmed.' }] });
  M('b7', { src: 'email', where: 'Inbox', ts: '2026-10-14T11:20', from: 'priya', to: ['you'], cc: ['rafael'], subject: 'Brightline parallel run 1 results', msgId: 'pr1-results', thread: 'bl-pr1',
    body: 'Parallel run 1 matched 181 of 182 checks. The one miss was a rounding issue on a terminated employee, now fixed.',
    signals: [{ t: 'progress', ws: 'Payroll setup', pct: 82, quote: 'Parallel run 1 matched 181 of 182 checks.' }] });
  M('b7b', { src: 'email', where: 'Brightline', ts: '2026-10-14T11:20', from: 'priya', to: ['you'], cc: ['rafael'], subject: 'Brightline parallel run 1 results', msgId: 'pr1-results', thread: 'bl-pr1',
    body: 'Parallel run 1 matched 181 of 182 checks. The one miss was a rounding issue on a terminated employee, now fixed.',
    signals: [{ t: 'progress', ws: 'Payroll setup', pct: 82, quote: 'Parallel run 1 matched 181 of 182 checks.' }] });
  M('b8', { src: 'slack', where: '#brightline-impl', ts: '2026-10-14T15:30', from: 'ken',
    body: 'T&A: time codes are mapped and pay rules config is about 75% done.',
    signals: [{ t: 'progress', ws: 'T&A', pct: 75, quote: 'pay rules config is about 75% done' }] });
  M('b9', { src: 'meeting', where: 'Weekly sync', ts: '2026-10-15T10:12', offset: '12:20', from: 'dana', to: ['marcus', 'you', 'priya'],
    body: "Dana: We're still pulling the census. It's taking longer than we thought.",
    signals: [{ t: 'status', key: 'census', ws: 'Employee data import', quote: "We're still pulling the census." }] });
  M('b10', { src: 'meeting', where: 'Weekly sync', ts: '2026-10-15T10:22', offset: '22:41', from: 'marcus', to: ['dana', 'you', 'priya'],
    body: 'Jordan: Any special overtime rules we should know about?\nMarcus: We just do standard overtime, nothing fancy.',
    signals: [{ t: 'concern', key: 'ca-overtime', ws: 'Payroll setup', what: 'California staff may need daily overtime rules', confidence: 0.64, quote: 'We just do standard overtime, nothing fancy.',
      why: 'Brightline registered a California location (Tax setup thread, Oct 13). California owes overtime daily after 8 hours, which "standard" weekly overtime does not cover.' }] });
  M('b11', { src: 'meeting', where: 'Weekly sync', ts: '2026-10-15T10:31', offset: '31:02', from: 'marcus', to: ['dana', 'you', 'priya'],
    body: 'Marcus: Our warehouse folks would love to clock in from their phones.',
    signals: [{ t: 'opp', key: 'mobile-clockin', ws: 'Time & attendance', what: 'Mobile clock-in for warehouse staff', quote: 'Our warehouse folks would love to clock in from their phones.' }] });
  M('b12', { src: 'meeting', where: 'Weekly sync', ts: '2026-10-15T10:44', offset: '44:15', from: 'marcus', to: ['dana', 'you', 'priya'],
    body: "Marcus: If the census slips again, we'll probably need to talk about the go-live date.",
    // Deliberately paraphrased quote: the Verifier should catch it and downgrade the claim.
    signals: [{ t: 'concern', key: 'golive-delay', ws: 'Employee data import', what: 'Client says go-live will be pushed', safeWhat: 'Client may revisit the go-live date if the census slips again', confidence: 0.7, quote: 'we will push the go-live date',
      why: 'Said during the weekly sync while discussing the late census.' }] });
  M('b13', { src: 'slack', where: '#brightline-impl', ts: '2026-10-15T16:02', from: 'marcus',
    body: "I'll go through the job codes once I have the census.",
    signals: [{ t: 'wait', key: 'census', waiter: 'marcus', work: 'jobcodes', on: 'dana', what: 'Job code review', ws: 'Payroll setup', quote: "I'll go through the job codes once I have the census." }] });
  M('b14', { src: 'slack', where: '#brightline-impl', ts: '2026-10-15T16:20', from: 'priya',
    body: "Can't map payroll until Marcus sends job codes. Parallel run 2 is Oct 27.",
    signals: [
      { t: 'wait', key: 'jobcodes', waiter: 'priya', work: 'mapping', on: 'marcus', what: 'Payroll mapping', ws: 'Payroll setup', quote: "Can't map payroll until Marcus sends job codes." },
      { t: 'deadline', ws: 'Payroll setup', what: 'Parallel run 2', date: '2026-10-27', quote: 'Parallel run 2 is Oct 27.' }
    ] });
  M('b15', { src: 'slack', where: '#brightline-impl', ts: '2026-10-15T16:31', from: 'you',
    body: "I'll schedule parallel run 2 as soon as Priya's mapping is in.",
    signals: [{ t: 'wait', key: 'mapping', waiter: 'you', work: 'pr2', on: 'priya', what: 'Parallel run 2', ws: 'Payroll setup', quote: "I'll schedule parallel run 2 as soon as Priya's mapping is in." }] });
  M('b16', { src: 'slack', where: '#brightline-impl', ts: '2026-10-16T09:10', from: 'priya',
    body: 'Data conversion scripts are ready to run the moment the census lands.',
    signals: [{ t: 'mention', ws: 'Data conversion', quote: 'Data conversion scripts are ready to run the moment the census lands.' }] });
  M('b17', { src: 'slack', where: '#random', ts: '2026-10-15T12:01', from: 'rafael', body: 'Anyone up for tacos?' });
  M('b18', { src: 'email', where: 'HR-Confidential', ts: '2026-10-14T17:02', from: 'dana', to: ['you'], subject: 'Exec salary bands', thread: 'bl-salary',
    body: 'Attached are the exec salary bands for payroll setup. Please keep this out of shared channels.\nRef: employee 4471, SSN 512-44-9081.',
    signals: [{ t: 'mention', ws: 'Payroll setup', quote: 'exec salary bands for payroll setup' }] });
  M('b19', { src: 'slack', where: 'DM · Lena Ortiz', dm: true, ts: '2026-10-13T13:30', from: 'lena', to: ['you'],
    body: 'Any expansion signals at Brightline? I hear their warehouse headcount is growing.' });
  M('b20', { src: 'email', where: 'Inbox', ts: '2026-10-16T08:50', from: 'marcus', to: ['you'], subject: 'Re: job codes', thread: 'bl-jobcodes',
    body: 'Hi Jordan,\n\nStill waiting on the census before I can start on job codes. Will jump on it the day it arrives.\n\nMarcus',
    signals: [{ t: 'wait', key: 'census', waiter: 'marcus', work: 'jobcodes', on: 'dana', what: 'Job code review', ws: 'Payroll setup', quote: 'Still waiting on the census before I can start on job codes.' }] });
  M('b21', { src: 'slack', where: '#brightline-impl', ts: '2026-10-14T10:05', from: 'priya', body: 'Payroll calendar for 2027 is loaded.',
    signals: [{ t: 'mention', ws: 'Payroll setup', quote: 'Payroll calendar for 2027 is loaded.' }] });
  M('b22', { src: 'slack', where: '#brightline-impl', ts: '2026-10-16T11:40', from: 'priya', body: 'Earnings codes reviewed with Marcus. All good.',
    signals: [{ t: 'mention', ws: 'Payroll setup', quote: 'Earnings codes reviewed with Marcus.' }] });
  M('b23', { src: 'email', where: 'Inbox', ts: '2026-10-15T14:10', from: 'ken', to: ['dana', 'you'], subject: 'Warehouse time clocks', thread: 'bl-clocks',
    body: 'Hi Dana,\n\nThe T&A clocks for the warehouse ship Oct 22. I will send install notes this week.\n\nKen',
    signals: [{ t: 'mention', ws: 'T&A', quote: 'The T&A clocks for the warehouse ship Oct 22.' }] });
  M('b24', { src: 'slack', where: '#brightline-impl', ts: '2026-10-13T09:30', from: 'priya', body: 'Field mapping template for the census is done. Migration is about 45% of the way there.',
    signals: [{ t: 'progress', ws: 'Employee data import', pct: 45, quote: 'Migration is about 45% of the way there.' }] });
  M('b25', { src: 'email', where: 'Brightline', ts: '2026-10-15T09:05', from: 'dana', to: ['you'], subject: 'Re: Tax setup status', thread: 'bl-tax',
    body: 'Ohio local tax review is confirmed for Oct 21.',
    signals: [{ t: 'mention', ws: 'Tax setup', quote: 'Ohio local tax review is confirmed for Oct 21.' }] });
  M('b26', { src: 'slack', where: '#brightline-impl', ts: '2026-10-16T13:15', from: 'priya', body: 'Census staging tables are built and validated.',
    signals: [{ t: 'mention', ws: 'Employee data import', quote: 'Census staging tables are built and validated.' }] });

  // Brightline live feed: arrives after the demo clock starts
  M('q1', { src: 'slack', where: '#brightline-impl', ts: '2026-10-16T16:05', from: 'priya',
    body: 'Any ETA on the census? Payroll mapping is still blocked.',
    signals: [{ t: 'status', key: 'census', ws: 'Employee data import', quote: 'Any ETA on the census?' }] });
  M('q2', { src: 'email', where: 'Inbox', ts: '2026-10-16T16:30', from: 'marcus', to: ['you'], subject: 'Mobile clock-in', thread: 'bl-mobile',
    body: "Hi Jordan,\n\nFollowing up on clocking in from phones: could it cover our drivers too? That's another 120 people.\n\nMarcus",
    signals: [{ t: 'opp', key: 'mobile-clockin', ws: 'Time & attendance', what: 'Mobile clock-in for warehouse staff and 120 drivers', quote: 'could it cover our drivers too?' }] });
  M('q3', { src: 'slack', where: '#brightline-impl', ts: '2026-10-16T17:10', from: 'you',
    body: 'Training: I can run the end-user session Nov 3 if that works for Dana.',
    signals: [{ t: 'mention', ws: 'Training', quote: 'I can run the end-user session Nov 3' }] });
  M('q4', { src: 'slack', where: '#harborpine-impl', ts: '2026-10-16T17:45', from: 'ken',
    body: 'Harbor & Pine carrier cutoff is in 7 days and we still have no elections file.',
    signals: [{ t: 'status', key: 'hp-elections', ws: 'Benefits', quote: 'we still have no elections file' }] });

  // Harbor & Pine Clinics: two fires
  M('h1', { src: 'meeting', where: 'Kickoff call', ts: '2026-09-21T10:09', offset: '09:12', from: 'alma', to: ['you', 'ken'],
    body: "Alma: We'll send the open-enrollment elections file by October 9.\nAlma: Go-live is December 1.",
    signals: [
      { t: 'project', name: 'HCM and benefits rollout', goLive: '2026-12-01', quote: 'Go-live is December 1.' },
      { t: 'commit', key: 'hp-elections', ws: 'Benefits', owner: 'alma', what: 'Open-enrollment elections file', due: '2026-10-09T17:00', quote: "We'll send the open-enrollment elections file by October 9." }
    ] });
  M('h2', { src: 'email', where: 'Inbox', ts: '2026-10-07T09:30', from: 'deshawn', to: ['you'], subject: 'Scheduling API access', thread: 'hp-api',
    body: "Hi Jordan,\n\nI'll get you the scheduling system API credentials by Oct 12.\n\nDeshawn",
    signals: [{ t: 'commit', key: 'hp-api', ws: 'Time & attendance', owner: 'deshawn', what: 'Scheduling system API credentials', due: '2026-10-12T17:00', quote: "I'll get you the scheduling system API credentials by Oct 12." }] });
  M('h3', { src: 'slack', where: '#harborpine-impl', ts: '2026-10-13T14:00', from: 'ken',
    body: "Still no elections file from Harbor & Pine. Carrier cutoff is Oct 23 and I can't upload enrollments without it.",
    signals: [
      { t: 'wait', key: 'hp-elections', waiter: 'ken', work: 'hp-carrier', on: 'alma', what: 'Carrier enrollment upload', ws: 'Benefits', quote: "I can't upload enrollments without it." },
      { t: 'status', key: 'hp-elections', ws: 'Benefits', quote: 'Still no elections file from Harbor & Pine.' },
      { t: 'progress', ws: 'Benefits', pct: 40 },
      { t: 'deadline', ws: 'Benefits', what: 'Carrier cutoff', date: '2026-10-23', quote: 'Carrier cutoff is Oct 23' }
    ] });
  M('h4', { src: 'slack', where: '#harborpine-impl', ts: '2026-10-14T11:15', from: 'priya',
    body: 'Shift differential rules are blocked until we can pull schedules from their system.',
    signals: [
      { t: 'wait', key: 'hp-api', waiter: 'priya', work: 'hp-shiftdiff', on: 'deshawn', what: 'Shift differential rules', ws: 'Time & attendance', quote: 'Shift differential rules are blocked until we can pull schedules from their system.' },
      { t: 'progress', ws: 'Time & attendance', pct: 35 }
    ] });
  M('h5', { src: 'email', where: 'Inbox', ts: '2026-10-15T09:00', from: 'priya', to: ['you'], subject: 'Harbor & Pine payroll config', thread: 'hp-pay',
    body: 'Payroll config is at 55%. Earnings codes are done; deductions next.',
    signals: [{ t: 'progress', ws: 'Payroll setup', pct: 55, quote: 'Payroll config is at 55%.' }] });
  M('h6', { src: 'slack', where: '#harborpine-impl', ts: '2026-10-16T10:20', from: 'priya', body: 'Harbor & Pine migration validation passed on the second load.',
    signals: [{ t: 'progress', ws: 'Employee data import', pct: 70, quote: 'migration validation passed on the second load' }] });
  M('h7', { src: 'meeting', where: 'Weekly sync', ts: '2026-09-30T11:05', offset: '05:40', from: 'alma', to: ['you'],
    body: 'Alma: Training can wait until December.',
    signals: [{ t: 'progress', ws: 'Training', pct: 20 }, { t: 'mention', ws: 'Training', quote: 'Training can wait until December.' }] });
  M('h8', { src: 'slack', where: '#harborpine-impl', ts: '2026-10-15T15:00', from: 'priya', body: 'Deductions mapping started for Harbor & Pine payroll.',
    signals: [{ t: 'mention', ws: 'Payroll setup', quote: 'Deductions mapping started' }] });
  M('h9', { src: 'email', where: 'Inbox', ts: '2026-10-14T16:30', from: 'deshawn', to: ['you'], subject: 'Re: Scheduling API access', thread: 'hp-api',
    body: 'Working on the credentials. Our security review is taking a while.',
    signals: [{ t: 'status', key: 'hp-api', ws: 'Time & attendance', quote: 'Our security review is taking a while.' }] });
  M('h10', { src: 'slack', where: '#harborpine-impl', ts: '2026-10-12T10:00', from: 'priya', body: 'Second migration load for Harbor & Pine is queued.',
    signals: [{ t: 'mention', ws: 'Employee data import', quote: 'Second migration load for Harbor & Pine is queued.' }] });

  // Northwind Foods: healthy, with an opportunity
  M('n0', { src: 'meeting', where: 'Kickoff call', ts: '2026-09-14T09:20', offset: '03:15', from: 'omar', to: ['you', 'grace'],
    body: 'Omar: We want payroll and time live by November 2.',
    signals: [{ t: 'project', name: 'Payroll and T&A rollout', goLive: '2026-11-02', quote: 'We want payroll and time live by November 2.' }] });
  M('n1', { src: 'email', where: 'Inbox', ts: '2026-10-14T09:40', from: 'grace', to: ['you'], subject: 'Tax registrations', thread: 'nw-tax',
    body: 'All tax registrations are done, including the two new Illinois locations.',
    signals: [{ t: 'progress', ws: 'Tax setup', pct: 95, quote: 'All tax registrations are done' }] });
  M('n2', { src: 'slack', where: '#northwind-impl', ts: '2026-10-15T13:10', from: 'priya', body: 'Northwind parallel run 2 matched 100%.',
    signals: [{ t: 'progress', ws: 'Payroll setup', pct: 88, quote: 'Northwind parallel run 2 matched 100%.' }] });
  M('n3', { src: 'meeting', where: 'Weekly sync', ts: '2026-10-15T15:18', offset: '18:30', from: 'grace', to: ['you', 'omar'],
    body: 'Grace: Is there a way to give our line workers early access to their pay? People keep asking.',
    signals: [{ t: 'opp', key: 'nw-ewa', ws: 'Payroll setup', what: 'Earned wage access for line workers', quote: 'Is there a way to give our line workers early access to their pay?' }] });
  M('n4', { src: 'slack', where: '#northwind-impl', ts: '2026-10-16T09:30', from: 'ken', body: 'Northwind T&A rules are at 80% and the clocks have shipped.',
    signals: [{ t: 'progress', ws: 'Time & attendance', pct: 80, quote: 'T&A rules are at 80%' }] });
  M('n5', { src: 'email', where: 'Inbox', ts: '2026-10-13T11:00', from: 'omar', to: ['you'], subject: 'Onboarding forms', thread: 'nw-onb',
    body: 'Onboarding forms are reviewed. E-signature setup next week.',
    signals: [{ t: 'progress', ws: 'Onboarding', pct: 60, quote: 'Onboarding forms are reviewed.' }] });
  M('n6', { src: 'email', where: 'Inbox', ts: '2026-10-12T10:00', from: 'grace', to: ['you'], subject: 'Garnishments', thread: 'nw-garn',
    body: "I'll send the garnishment list by Oct 20.",
    signals: [{ t: 'commit', key: 'nw-garn', ws: 'Payroll setup', owner: 'grace', what: 'Garnishment list', due: '2026-10-20T17:00', quote: "I'll send the garnishment list by Oct 20." }] });
  M('n7', { src: 'slack', where: '#northwind-impl', ts: '2026-10-15T09:00', from: 'priya', body: 'Northwind year-end calendar loaded.',
    signals: [{ t: 'mention', ws: 'Payroll setup', quote: 'Northwind year-end calendar loaded.' }] });
  M('n8', { src: 'email', where: 'Inbox', ts: '2026-10-16T12:00', from: 'omar', to: ['you'], subject: 'Onboarding portal', thread: 'nw-onb',
    body: 'Onboarding portal branding is approved.',
    signals: [{ t: 'mention', ws: 'Onboarding', quote: 'Onboarding portal branding is approved.' }] });
  M('n9', { src: 'slack', where: '#northwind-impl', ts: '2026-10-14T14:00', from: 'ken', body: 'Northwind time clock install scheduled for Monday.',
    signals: [{ t: 'mention', ws: 'Time & attendance', quote: 'time clock install scheduled' }] });

  // Cobalt Freight: a jam that hasn't caught fire yet, plus an unanswered question
  M('c0', { src: 'meeting', where: 'Kickoff call', ts: '2026-09-28T14:10', offset: '06:02', from: 'ivan', to: ['you', 'mei'],
    body: 'Ivan: Our target is a November 20 go-live.',
    signals: [{ t: 'project', name: 'Payroll migration', goLive: '2026-11-20', quote: 'Our target is a November 20 go-live.' }] });
  M('c1', { src: 'email', where: 'Inbox', ts: '2026-10-06T08:45', from: 'ivan', to: ['you'], subject: 'Bank verification', thread: 'cf-bank',
    body: "I'll complete the bank account verification by Oct 19.",
    signals: [{ t: 'commit', key: 'cf-bank', ws: 'Payroll setup', owner: 'ivan', what: 'Bank account verification', due: '2026-10-19T17:00', quote: "I'll complete the bank account verification by Oct 19." }] });
  M('c2', { src: 'slack', where: '#cobalt-impl', ts: '2026-10-15T10:30', from: 'priya', body: "Can't run the penny test until Cobalt verifies the bank account.",
    signals: [{ t: 'wait', key: 'cf-bank', waiter: 'priya', work: 'cf-penny', on: 'ivan', what: 'Penny test', ws: 'Payroll setup', quote: "Can't run the penny test until Cobalt verifies the bank account." }] });
  M('c3', { src: 'slack', where: '#cobalt-impl', ts: '2026-10-15T10:40', from: 'you', body: "Parallel run 1 waits on Priya's penny test.",
    signals: [{ t: 'wait', key: 'cf-penny', waiter: 'you', work: 'cf-pr1', on: 'priya', what: 'Parallel run 1', ws: 'Payroll setup', quote: "Parallel run 1 waits on Priya's penny test." }] });
  M('c4', { src: 'email', where: 'Inbox', ts: '2026-10-09T14:20', from: 'mei', to: ['you'], subject: 'Texas withholding', thread: 'cf-tx',
    body: 'Hi Jordan,\n\nCan someone confirm whether our Texas drivers need state withholding?\n\nMei',
    signals: [{ t: 'question', key: 'cf-tx', ws: 'Tax setup', asker: 'mei', text: 'Do Texas drivers need state withholding?', topic: 'tax', quote: 'Can someone confirm whether our Texas drivers need state withholding?' }, { t: 'progress', ws: 'Tax setup', pct: 70 }] });
  M('c5', { src: 'slack', where: '#cobalt-impl', ts: '2026-10-16T08:15', from: 'priya', body: 'Cobalt data migration second load ran clean.',
    signals: [{ t: 'progress', ws: 'Employee data import', pct: 65, quote: 'second load ran clean' }] });
  M('c6', { src: 'email', where: 'Inbox', ts: '2026-10-14T13:00', from: 'ivan', to: ['you'], subject: 'Earnings codes', thread: 'cf-earn',
    body: 'Earnings codes are confirmed on our side.',
    signals: [{ t: 'progress', ws: 'Payroll setup', pct: 50, quote: 'Earnings codes are confirmed on our side.' }] });
  M('c7', { src: 'slack', where: '#cobalt-impl', ts: '2026-10-13T11:00', from: 'priya', body: 'Cobalt migration first load had 12 address errors, fixing now.',
    signals: [{ t: 'mention', ws: 'Employee data import', quote: 'first load had 12 address errors' }] });

  SKY.messages = msgs;

  // ---------- scripted demo events (timestamps relative to the demo clock) ----------
  const plus = (now, min) => SKY.fmt.iso(new Date(+new Date(now) + min * 60000));
  const nextDow = (now, dow, hh) => { const x = new Date(now); x.setDate(x.getDate() + 1); while (x.getDay() !== dow) x.setDate(x.getDate() + 1); x.setHours(hh, 0, 0, 0); return SKY.fmt.iso(x); };
  SKY.scripted = {
    danaReply: (now) => ({ id: 'r-census', src: 'email', where: 'Inbox', ts: plus(now, 25), from: 'dana', to: ['you'], subject: 'Re: Census file', thread: 'fu-census',
      body: 'Hi Jordan,\n\nSorry for the delay. Our HR system export kept timing out. I can send the salaried employees by Tuesday and the hourly file by Friday.\n\nDana',
      signals: [
        { t: 'reply', ref: 'commit:census' },
        { t: 'commit', key: 'census-partial', ws: 'Employee data import', owner: 'dana', what: 'Partial census (salaried staff)', due: nextDow(now, 2, 17), supersedes: 'census', quote: 'I can send the salaried employees by Tuesday' }
      ] }),
    nwLive: (now) => ({ id: 'l-nw', src: 'email', where: 'Inbox', ts: plus(now, 20), from: 'omar', to: ['you', 'grace'], subject: 'We are live!', thread: 'nw-live',
      body: 'Hi Jordan,\n\nFirst live payroll ran clean this morning. Payroll, tax, time & attendance and onboarding are all signed off on our side. Grace sent the garnishment list over too.\n\nThanks to the whole team!\nOmar',
      signals: [
        { t: 'progress', ws: 'Payroll setup', pct: 100, quote: 'First live payroll ran clean this morning.' },
        { t: 'progress', ws: 'Tax setup', pct: 100, quote: 'Payroll, tax, time & attendance and onboarding are all signed off on our side.' },
        { t: 'progress', ws: 'Time & attendance', pct: 100, quote: 'Payroll, tax, time & attendance and onboarding are all signed off on our side.' },
        { t: 'progress', ws: 'Onboarding', pct: 100, quote: 'Payroll, tax, time & attendance and onboarding are all signed off on our side.' },
        { t: 'fulfill', key: 'nw-garn', quote: 'Grace sent the garnishment list over too.' }
      ] }),
    censusFile: (now) => ({ id: 'f-census', src: 'email', where: 'Inbox', ts: plus(now, 30), from: 'dana', to: ['you', 'marcus'], subject: 'Census file (salaried)', thread: 'fu-census',
      body: "Hi all,\n\nHere's the salaried census file: 412 employees. Hourly to follow Friday.\n\nDana",
      signals: [
        { t: 'fulfill', key: 'census-partial', quote: "Here's the salaried census file" },
        { t: 'fulfill', key: 'census', quote: "Here's the salaried census file" },
        { t: 'progress', ws: 'Employee data import', pct: 62, quote: '412 employees' }
      ] })
  };
})();
