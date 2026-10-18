# Skyline live server

Connects Skyline to your real Gmail and Slack. The server runs on your computer, reads new messages, and has Claude turn each client message into the same signals the demo uses: promises, blockers, questions, requests and progress. The web app and its agents then build the city from them.

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

## 2. Gmail

This needs no company admin: you create the Google sign-in yourself, in a free Google Cloud project.

1. In [Google Cloud console](https://console.cloud.google.com), create a project, for example `Skyline`.
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**. Choose **Internal** instead if your Google Workspace allows it; that also avoids the 7-day expiry below.
   - Add the scope `https://www.googleapis.com/auth/gmail.readonly`.
   - Under **Test users** (Audience), add your own Gmail address.
4. **Credentials → Create credentials → OAuth client ID**, application type **Desktop app**. No redirect URI needs registering, because desktop clients accept any `127.0.0.1` address.
5. Copy the client ID and client secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. Restart the server, open Sources, and click **Connect Gmail**. Google will say the app isn't verified, because it's your own app. Choose **Continue**.

Two things to know:

- **7-day expiry:** while the app's publishing status is **Testing**, Google expires the sign-in after 7 days, and Skyline will ask you to connect Gmail again. Publishing the app (or making it Internal on Workspace) removes the limit.
- **Your own team:** if your address is a personal `@gmail.com`, set `SKYLINE_INTERNAL_DOMAIN` to your team's domain if you have one. Otherwise everyone counts as an outside contact.

Skyline asks only to read mail (`gmail.readonly`) and never sends anything. "Open in Gmail" opens a pre-filled draft, and a meeting opens a pre-filled Google Calendar event; you send them yourself.

By default it reads **Inbox** and **Sent**. Turn on Starred, Important or your own labels in Sources. Promotions, social and forum mail are always skipped.

## 3. Slack

Use a **user token** (`xoxp-…`). Skyline then reads the channels you're already in, and nothing has to be invited.

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From scratch**, then pick your workspace.
2. Open **OAuth & Permissions**. Under **User Token Scopes** (not Bot Token Scopes), add:
   `channels:read` `channels:history` `groups:read` `groups:history` `im:read` `im:history` `mpim:read` `mpim:history` `users:read` `users:read.email` `team:read`
3. Click **Install to Workspace** and allow. Some workspaces send this to an admin for approval first.
4. Copy the **User OAuth Token** (starts with `xoxp-`) and put it in `.env` as `SLACK_TOKEN`, or paste it on the Sources page.

If you change scopes later, click **Reinstall to Workspace**. That gives you a new token to copy.

Direct messages stay off until you turn them on in Sources. Thread replies aren't read yet, only top-level messages.

<details><summary>Using a bot token instead</summary>

A bot token (`xoxb-…`) works too, but add the same scopes under **Bot Token Scopes**, and `/invite` the app into every channel you want Skyline to read. It can't see your DMs.

</details>

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
| `PORT` | `8787` | Where the app and the Gmail sign-in redirect live |
| `SKYLINE_LOOKBACK_DAYS` | `21` | How far back the first sync reads |
| `SKYLINE_SYNC_MINUTES` | `5` | Minutes between automatic syncs; `0` turns it off |
| `SKYLINE_INTERNAL_DOMAIN` | your email's domain | Which domain counts as your team |
| `SKYLINE_OFFLINE` | off | Serve stored data without syncing (development) |

## Not yet covered

- Meeting transcripts (Google Meet or Teams).
- Slack thread replies.
- Renaming discovered clients from the UI. Today you set `clientNames` in `data/store.json`.
