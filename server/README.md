# Skyline live server

Connects Skyline to your real Outlook and Slack. The server runs on your computer, reads new messages, and has Claude turn each client message into the same signals the demo uses: promises, blockers, questions, requests and progress. The web app and its agents then build the city from them.

Demo mode is untouched. Use the **DEMO / LIVE** switch at the top of the app to move between them.

## Run it

```bash
cd server
cp .env.example .env      # then fill it in (see below)
npm install
npm start
```

Open **http://localhost:8787**, switch to **LIVE**, and connect your sources on the **Sources** page. The menu bar app uses this server automatically whenever it's running.

## 1. Claude (required for live signals)

Put an Anthropic API key in `.env` as `ANTHROPIC_API_KEY`, or run `ant auth login` once and leave it blank.

Extraction uses `claude-opus-5-5` with structured output, so every answer matches the signal schema. Refusal fallback is on: if Claude declines a message, the API retries it on Anthropic's recommended fallback model. The fixed instructions are cached, which keeps repeat syncs cheap.

Only messages tied to a client are sent, after redaction, and each message is read once.

## 2. Outlook (Microsoft Graph)

1. Go to [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**.
   - Name: `Skyline`
   - Supported accounts: whatever fits (work accounts only, or work + personal)
   - Redirect URI: platform **Public client/native (mobile & desktop)**, URI `http://localhost:8787/auth/outlook/callback`
2. Under **API permissions**, add **Microsoft Graph → Delegated → `User.Read`, `Mail.Read`**. Some organizations require admin consent for `Mail.Read`.
3. Copy the **Application (client) ID** into `.env` as `MS_CLIENT_ID`. Set `MS_TENANT` to your tenant ID to allow only your organization, or leave it as `common`.
4. Restart the server, open Sources, and click **Connect Outlook**.

Skyline asks only to read mail. It never sends anything. "Open in Outlook" opens a pre-filled draft or meeting in Outlook on the web, and you press Send yourself. `OUTLOOK_WEB` picks work (`outlook.office.com`) or personal (`outlook.live.com`).

By default it reads **Inbox** and **Sent Items**. Turn other folders on in Sources.

## 3. Slack

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) (**From scratch**).
2. Under **OAuth & Permissions**, add these **User Token Scopes** (or Bot Token Scopes):
   `channels:read channels:history groups:read groups:history im:read im:history mpim:read mpim:history users:read users:read.email team:read`
3. **Install to Workspace** and copy the token (`xoxp-…` user token or `xoxb-…` bot token).
4. Paste it on the Sources page, or put it in `.env` as `SLACK_TOKEN`.

A bot token only sees channels the bot has been invited to. A user token sees the channels you're in. Direct messages are off until you turn them on. Thread replies aren't read yet; only top-level messages are.

## How clients are found

There's no CRM, so a client is any outside email domain you've exchanged two or more messages with. Public mail providers and automated senders (no-reply, notifications) are excluded.

Slack channels belong to a client when their name starts with the client's domain word: `#acme-impl` goes to `acme.com`. Internal-only emails are matched when they mention the client by name.

## Privacy

- **What's stored:** tokens, synced messages and extracted signals stay in `server/data/`. That folder is git-ignored and readable only by you.
- **Turning things off:** turning a folder or channel off, or disconnecting a source, deletes what Skyline stored from it.
- **Redaction:** SSNs and long account numbers are redacted before anything is stored or sent to Claude.
- **Local only:** the server listens on `localhost` only and rejects requests from other sites.

## Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | Must match the Outlook redirect URI |
| `SKYLINE_LOOKBACK_DAYS` | `21` | How far back the first sync reads |
| `SKYLINE_SYNC_MINUTES` | `5` | Minutes between automatic syncs; `0` turns it off |
| `SKYLINE_INTERNAL_DOMAIN` | your email's domain | Which domain counts as your team |
| `SKYLINE_OFFLINE` | off | Serve stored data without syncing (development) |

## Not yet covered

- Teams meeting transcripts, which need an extra admin-consented Graph permission.
- Slack thread replies.
- Renaming discovered clients from the UI. Today you set `clientNames` in `data/store.json`.
