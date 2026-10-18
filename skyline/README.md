# Skyline

Skyline turns every conversation about a client into a living 3D city. Workstreams are buildings, broken commitments are fires, a red dashed line runs from a fire to every building it blocks, and every element links back to the email, Slack message or meeting line that caused it.

This is a working front-end prototype. The visual design is ported from `../ADP Hack Concepts – City · 3D.html`.

## Run it

Open `index.html` in a browser. There is no build step and no server, and plain `<script>` tags work from `file://`. Fonts load from Google Fonts; without a network connection the system fonts are used instead.

**Demo or live.** The **DEMO / LIVE** switch at the top chooses the data. Demo is the mock corpus below and works anywhere. Live reads your real Gmail and Slack through the local server in `../server`: run `npm start` there and open http://localhost:8787. See [server/README.md](../server/README.md) for setup.

In demo mode, use **DEMO ▾** (top right) to drive the story:

1. Click the burning **Employee data import** building, then **Fix this issue**. Choose to email Dana, schedule a meeting, or escalate. Review the draft or invite, then send it. The fire becomes *contained*.
2. **Jump to the next business morning**. Nobody replied, so the alarm relights.
3. **Reset**, send again, then choose **Dana replies**. The promise is renegotiated, and the building stays contained while Skyline watches the new date.
4. **The census file arrives**. The fire goes out, the blocked people can start, and the building grows.
5. **Play the live feed**. New messages arrive one at a time and every agent re-runs on each one.
6. **Northwind Foods goes live**. Omar signs off every workstream, so all of Northwind's buildings reach 100% and the project is complete. Choose **Archive project** in the top-left panel or on its Region card. The whole city moves to the **Archives** tab, and **Restore** brings it back to your region.

## How it fits together

| File | What it does |
| --- | --- |
| `data.js` | Mock connector output: 4 clients, ~60 Outlook emails, Slack messages and Teams transcript segments, with `signals` on each message |
| `agents.js` | The 8-agent pipeline. It is pure: messages + clock + access rules + corrections + follow-ups in, city model out |
| `city.js` | Isometric CSS-3D renderer (full city and mini skylines) |
| `app.js` | Views, evidence viewer, draft editor, corrections, demo clock |

**What is mocked (demo mode only):** the connectors and the extraction model. Each message carries `signals` (commitment, waiting-on, question, opportunity, progress, and so on) that stand in for what an LLM extraction step would return. Everything after that is real logic: client and workstream discovery, alias merging, dependency chains, fire-or-smoke decisions, quote verification, follow-up tracking and relighting.

Live mode does exactly that. The server reads Gmail and Slack, and Claude generates `signals` for each client message, so `runPipeline` runs unchanged on either source.

### The agents

Intake → Cartographer → Surveyor → Traffic → Fire watch → Scout → Dispatcher → Verifier. They post to a shared bus, which you can read on the **Agents** page. Each run shows only what is new. The Verifier checks every insight's quote against the original message. A paraphrased quote is rewritten to the real line and downgraded to **INFERRED**. The demo includes one: "we will push the go-live date". A claim with no support is rejected.

## User stories → where to see them

| Story | Where |
| --- | --- |
| Connect Outlook / Slack, control what Skyline reads | **Sources**: connect toggles, per-folder and per-channel switches, DMs and HR-Confidential off by default, SSN redaction |
| Auto-discover clients, teammates, projects | **Sources → Discovered automatically**: from email domains, channel names and mentions |
| Continuous processing | **Play the live feed**; the clock in the nav |
| Agents collaborate and verify | **Agents** (message bus), Verifier lines, CONFIRMED / INFERRED badges |
| Workstreams, commitments, deadlines | Buildings, tagged "82% · PAYROLL SETUP"; deadlines in each fire's blocked list |
| Risks / broken commitments | Fire (late, with people waiting) or smoke (late with no one waiting, unanswered question, failed test) |
| People waiting on others | "Blocked by this fire" list in the panel; red dashed line and a BLOCKED tag on the blocked building; "Waiting on …" box before anything is late |
| Height = progress, windows = activity | Building height = %, lit windows = messages in the last 7 days, dark after 7 quiet days |
| Opportunities light up | Gold beacon; repeat mentions merge into one opportunity |
| Click anything for details and evidence | Every quote opens the original message with the exact line highlighted, plus sender and timestamp |
| Correct inaccurate insights | "Not right? Correct this insight" (resolved, not a risk, due date, owner) and inline **edit** on progress (Enter saves), with Undo |
| Next best action + drafted follow-ups you review | NEXT BEST ACTION → **Fix this issue**: email draft (editable, with tone and the context it used), meeting invite (suggested times, agenda), or escalation |
| Detect replies, relight unresolved alarms | Dispatcher agent; demo **Dana replies** and **Jump to next business morning** |
| Manager view of mini skylines, prioritized | **Region**: sorted by fires, blocked people, smoke and dark buildings |
| Finished projects | When every building in a client's city is at 100%, **Archive project** appears in the top-left panel, on the Region card and in each building's panel. The **Archives** tab lists archived projects as mini skylines with a Restore button |

The picker in the SKYLINE header switches between Consultant, Project manager, Account exec and Client view. Client view hides internal Slack evidence, opportunities and actions.

The details panel can be closed (✕) or opened full screen (⤢). Hover or tab to any person's name to see their role and email.
