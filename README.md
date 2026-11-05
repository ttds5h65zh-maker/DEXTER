# Dexter Almana

Sultan's personal AI assistant. Dexter Almana understands his context (AUS, Information Systems & Business Analytics, Asia/Dubai), remembers useful information, organises ongoing work, and completes practical tasks through connected tools. Anything that sends, submits, changes or deletes something waits for his explicit approval.

The interface is deliberately quiet: a warm, writing-first design with serif replies, one sidebar and a single centred conversation.

- **Sidebar** – *New chat*, four places (Today, Tasks, Courses, Files), your recent chats, and a profile menu with Settings, Memory, Reminders & routines, Approvals and theme. A small banner appears only when something is waiting for you.
- **Chat** – new chats open on a greeting with the composer in the middle. Replies stream in; each tool Dexter Almana uses shows as a quiet one-line step you can expand; approvals and sign-in hand-offs appear right in the conversation; Send becomes Stop while it works. Attach files with **+** or by dropping them.
- **Today** – what needs you (only when something does), what's due soon, today's calendar and reminders, and **Brief me**.
- **Tasks** – grouped by Overdue / Today / This week / Later, with a simple detail panel: due, status, course, notes, the recorded outcome and an Activity log with evidence (confirmation ids). Interrupted work can be resumed. **Reminders & routines** (one-off reminders, daily briefings, "tell me when…" watches) run on a real scheduler with retries, cancellation and duplicate prevention.
- **Courses** – AUS courses with requirements, weighted grade items and current grade, tasks, files and drafts.
- **Files** – upload, preview (images, PDF, text, Word), organise, download. Documents keep version history and "approved wording" locks the assistant cannot change, and export to Word, Markdown or HTML.
- **Settings** – General (including the assistant's name), Connections, Notifications, Privacy (what it may do without asking, and anything you said not to ask about again), and Memory (inspect, edit, pin, delete — each with its source and last update).

The assistant's name defaults to **Dexter Almana** and can be changed in Settings → General.

## Quick start

Requirements: **Node.js 22.13 or newer**. There are no npm dependencies; the server uses Node's built-in `node:sqlite`, `fetch` and crypto.

```bash
cp .env.example .env        # then edit .env (at least ANTHROPIC_API_KEY)
npm start                   # http://localhost:3210
```

`npm run dev` restarts on server changes. Data (SQLite database, uploaded files, the generated encryption key, the browser profile) lives in `./data/`, which is git-ignored.

Without an API key Dexter Almana still runs: it shows a clear "Claude is not connected" state, and the commands `/task`, `/remind`, `/remember`, `/brief` and `/jobs` perform real local actions.

### Optional: visible browser for iLearn and Banner

```bash
npm install playwright
npx playwright install chromium
```

Run it on your own computer (with a display) so the browser window is visible; sign-in and MFA are handed to you. Set the iLearn and Banner addresses in **Settings → Connections**.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | for the assistant | Claude API key (server-side only) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Gmail/Calendar | Google OAuth client ("Web application") |
| `PORT` | no (3210) | HTTP port |
| `HOST` | no (127.0.0.1) | Bind address. Keep the default unless you also set `DEXTER_PASSWORD` |
| `PUBLIC_URL` | no (`http://localhost:PORT`) | Base URL used for the OAuth redirect |
| `DEXTER_PASSWORD` | recommended off-localhost | Require a password to open Dexter |
| `DEXTER_ALLOWED_HOSTS` | no | Extra allowed `Host` names, comma-separated |
| `DEXTER_SECRET_KEY` | no | Key for encrypting stored OAuth tokens; otherwise generated in `data/secret.key` |
| `DEXTER_DATA_DIR` | no (`./data`) | Storage location |
| `DEXTER_ANTHROPIC_BASE_URL` | no | Override the Claude API URL |
| `DEXTER_BROWSER_HEADLESS` | no | `1` = browser without a window (sign-in hand-off then unavailable) |
| `DEXTER_CHROMIUM_PATH` | no | Use a specific Chromium binary |
| `DEXTER_MAX_UPLOAD_MB` | no (25) | Upload size limit |
| `DEXTER_LOG_LEVEL` | no (info) | `debug`, `info`, `warn`, `error`, `silent` |

## Connecting Google (Gmail + Calendar)

1. In Google Cloud Console, create a project and enable the **Gmail API** and **Google Calendar API**.
2. Configure the OAuth consent screen (testing mode is fine) and add your Google account as a test user.
3. Create an **OAuth client ID → Web application** with the authorised redirect URI `PUBLIC_URL/api/integrations/google/callback` (for example `http://localhost:3210/api/integrations/google/callback`).
4. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, restart Dexter, then press **Connect Google** in **Settings → Connections**.

Scopes requested: `gmail.readonly`, `gmail.compose` (drafts, and sending only after approval) and `calendar.events` (changes only after approval). The refresh token is stored encrypted with AES-256-GCM.

## How it works

```
web/            framework-free ES-module UI (no build step), live updates over SSE
server/
  api/          HTTP routes (thin)            security.js  host/origin/CSRF/password guards
  assistant/    Claude client (raw HTTP + SSE), agent loop, prompts, slash commands
  tools/        tool registry: local, Google, browser; each with a risk level
  services/     tasks, memory, files, documents, courses, approvals, notifications…
  scheduler/    jobs, scheduler loop, runners (reminder, briefing, monitor, agent)
  integrations/ Google OAuth/Gmail/Calendar, Playwright browser, safe page fetching
  db.js         SQLite schema + migrations (node:sqlite)
```

- **Model.** Default `claude-opus-5-5`, with adaptive thinking, configurable effort, streaming, progress updates between tool calls, server-side refusal fallback, and Claude's web search tool for sourced research. The system prompt is stable. Per-turn context (Dubai time, relevant memories, open tasks, connection status) is appended as a mid-conversation system message, so history is replayed byte-for-byte. If the account rejects an optional beta feature, the request is retried without it.
- **Agent loop.** Tool inputs are validated before anything runs. Read and organise tools execute directly. Actions pause the run and create an approval, and the run continues after the decision. A tool that needs you (sign-in, MFA) creates a hand-off and blocks the run until you continue. If the same exact action already succeeded in the run, it is never executed twice.
- **Honesty rules.** An external action counts as complete only when the service returns a confirmation; that id is stored with the task and the approval. If Dexter stops mid-action, the action is marked "outcome unknown" and is **not** retried automatically. Dexter cannot mark a task completed without an outcome. Disconnected integrations return setup instructions, never placeholder data. There is no demo data.
- **Untrusted content.** Emails, web pages, files and browser pages reach the model wrapped as untrusted data. Approvals created after reading such content say so. Page fetching blocks private and loopback addresses.
- **Scheduler.** Each occurrence is one `job_runs` row (unique per job and time). Runs are claimed with a lease, retried with exponential backoff (3 attempts), and recovered after a restart. Occurrences missed by more than 6 hours are recorded as skipped. Cancelling a job aborts an in-flight check. Notifications carry a dedupe key, and monitors remember every matching item, so the same event alerts once.
- **Security.** Binds to 127.0.0.1 by default, checks the `Host` header (DNS rebinding) and Origin, and requires a custom header on state-changing requests (CSRF). Optional password login uses an HttpOnly SameSite=Strict cookie. A strict CSP applies, HTML uploads are never rendered, and secrets are redacted from logs and never sent to the browser.

## Testing

```bash
npm test          # 36 tests: unit + end-to-end API workflows
npm run test:e2e  # drives the real UI in Chromium (needs Playwright)
npm run check     # syntax-check all files
```

The integration tests run the real server, agent loop, scheduler and HTTP clients against local fakes of the Claude Messages API (SSE) and the Google APIs. They cover:

- conversation → task + reminder → scheduler delivery exactly once
- approval → single execution → confirmation recorded; rejection; standing authorization and its scope
- superseded approvals
- refusal handling, invalid tool JSON, and optional-feature downgrade
- restart recovery, including never re-sending an uncertain email
- monitor retries, condition-only alerts and dedupe; missed-run skipping; cancellation mid-run
- approved-wording protection and DOCX export
- slash commands without an API key
- CSRF, Host and password guards
- OAuth PKCE and state checks, plus revoked tokens
- the real Playwright browser reading a site and submitting a form only after approval
- the sign-in hand-off

## Implemented vs. planned

**Implemented and tested:** everything listed above. The following parts are implemented but verified only against local fakes:

- **Gmail and Calendar** follow Google's documented REST APIs and OAuth. No real Google account was available while building.
- **Claude** was checked live only for reachability and error handling (a real 401). Full conversations ran against a faithful SSE fake, because no API key was available.
- **iLearn and Banner** go through a general-purpose visible-browser workflow: open, read, follow links, approval-gated clicks and form submissions, sign-in hand-off. It is tested with real Chromium against stand-in pages, not the real AUS sites.

**Not yet built / planned:**

- Site-specific iLearn/Banner helpers (for example, importing grades or deadlines automatically into Courses). The generic browser workflow is there; per-site parsing needs access to the real pages.
- Reading PDFs stored in Files from tools. PDFs attached in chat are sent to Claude directly; server-side PDF text extraction is not available.
- Email attachments, Google Drive, and other mail or calendar providers.
- Native mobile app or web push. Phone notifications use an ntfy-compatible URL.
- Conversation compaction for extremely long chats, and backup/export of the database.
- Purchasing or publishing tools. None exist, so Dexter cannot do either; adding one would go through the approval system.
- Multi-user accounts. Dexter is single-user by design.
