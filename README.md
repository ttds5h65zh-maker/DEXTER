# Dexter

Dexter is a personal command center. Paste a messy email, upload a PDF or write a
note, and Dexter pulls out the **deadlines**, **decisions** and **open questions**
in it. Every finding shows the original passage it came from, so you can check
it, correct it or dismiss it. From a finding you can create a task, put it on
Today, or have Dexter draft a follow-up. Everything is saved as you go, so you can
close Dexter and pick up where you left off.

The home screen answers three questions: **What needs my attention today?**
**What am I waiting on?** **What is ready for me to review?**

All dates and times are in **Asia/Dubai** (UTC+4).

## Run it

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else is required.

```bash
git clone https://github.com/ttds5h65zh-maker/DEXTER.git
cd DEXTER
git checkout claude/dexter-command-center-323hc6
npm start
```

Then open **http://localhost:4173**.

To stop Dexter, press `Ctrl+C` in the terminal. Your work is saved in
`data/dexter.json` after every change; run `npm start` again to continue.

The first start loads a **demo** with fictional university and personal items,
labelled *Demo*, so you can try the whole workflow straight away. Remove it from
the banner on the home screen or from Settings. To start empty instead, use
`DEXTER_DEMO=off npm start` the first time (or delete `data/dexter.json` and start
that way).

## The workflow

1. **Import** (top right): paste an email, write a note, or upload a PDF. There is
   a sample email and a sample PDF in the import window if you want to try one.
2. **Review**: on a desktop the original source sits beside Dexter's findings;
   highlighted passages link the two. On a tablet, *Source* and *Findings* are one
   tap apart. Missing something? Select any passage in the source to add it as a
   finding yourself.
3. **Check the dates**: wording like "next Thursday", "end of the week" or
   "03/12" is shown with Dexter's reading and the other likely readings. Nothing
   with an unconfirmed date is scheduled until you confirm or correct it.
4. **Act**: create a task, add it to Today, or draft a follow-up email. Drafts can
   also be a calendar event or a university submission note.
5. **Approve**: each draft has a review page where you edit the text and see where
   it is going. Dexter never sends email, submits coursework or changes your
   calendar by itself. After you approve, you open the email in your own mail
   app, download the calendar file, or copy the text. Then mark it as done, and
   a sent follow-up shows up under *Waiting on*.

Search (press `/`) covers sources, findings, tasks and drafts.

## AI extraction (optional)

Without AI, Dexter uses built-in rules (English wording) plus your own review,
and drafts start from templates. To let a Claude model do the extraction and
drafting:

```bash
npm install                                   # installs the Anthropic SDK
ANTHROPIC_API_KEY=your-key npm start          # Windows PowerShell: $env:ANTHROPIC_API_KEY="your-key"; npm start
```

- The setting that enables it is **`ANTHROPIC_API_KEY`**. Settings in Dexter
  shows whether AI is on and, if not, why.
- The model is `claude-opus-5-5`; set `DEXTER_MODEL` to use another one.
- When AI is on, the text of each source you import is sent to Anthropic's API.
  You can turn AI off for a single import in the import window, or entirely
  with `DEXTER_AI=off`.
- Every AI finding must quote a passage that exists in your source, or it is
  dropped. Dates are worked out by Dexter; when Dexter cannot read the wording
  (for example Arabic), it shows the AI's reading and asks you to confirm it.
- If the model declines a request, Anthropic's server-side fallback re-runs it
  on another model. If AI fails, Dexter falls back to its rules and says so.

## Use it on a tablet

By default Dexter only accepts connections from the computer it runs on. To
open it from a tablet on the same Wi-Fi:

```bash
HOST=0.0.0.0 npm start
```

Then on the tablet open `http://<your computer's IP address>:4173`. Dexter has no
login, so only do this on a network you trust. To use a host name instead of an
IP address, add it to `DEXTER_ALLOWED_HOSTS` (comma-separated).

## Settings

Set these in front of `npm start`, for example `PORT=4180 npm start`. In Windows
PowerShell, set them first: `$env:PORT="4180"; npm start`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4173` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on (`0.0.0.0` for tablet access) |
| `DEXTER_DATA_DIR` | `./data` | Where `dexter.json` is kept |
| `DEXTER_DEMO` | on | `off` starts with no demo data on first run |
| `ANTHROPIC_API_KEY` | not set | Enables AI extraction and drafting |
| `DEXTER_MODEL` | `claude-opus-5-5` | Model used when AI is on |
| `DEXTER_AI` | on | `off` keeps AI off even if a key is set |
| `DEXTER_ALLOWED_HOSTS` | not set | Extra host names Dexter answers to (`*` for any) |

## Your data

Sources, findings, tasks, drafts and their history live in one file,
`data/dexter.json` (ignored by git). Settings → *Download a copy* exports it.
Deleting the file resets Dexter.

No email, calendar or university accounts are connected in this version, and
none are needed.

## Tests

```bash
npm test            # unit, pilot-regression and HTTP workflow tests (includes a restart)
npm run test:e2e    # browser walk-through (see below for Playwright)
```

The browser test needs Playwright and Chromium:
`npm install --no-save playwright && npx playwright install chromium`.

The browser test imports a source, inspects evidence, checks that an ambiguous
date blocks scheduling, corrects a date, creates tasks, edits and approves a
draft, searches, restarts the server and checks that everything is unchanged,
then repeats the review on a tablet-sized screen with a PDF. Screenshots go to
`tests/output/`.

## Known limits

- Built-in rules read English. Arabic text displays and searches correctly, and
  you can add findings from it by selecting text, but automatic extraction from
  Arabic needs AI to be on.
- Scanned PDFs (images without a text layer) and password-protected PDFs cannot
  be read; Dexter says so and suggests pasting the text instead.
- The rules are deliberately cautious about dates, so some wording that is clear
  to a person still asks for confirmation.

## Layout

```
server.js           HTTP server: JSON API and the web app (no dependencies)
lib/core.js         sources, findings, tasks, drafts, approvals, history
lib/extract.js      built-in extraction: segmentation, cue words, email headers
lib/pdf.js          PDF text reader (pages, compression, right-to-left text)
lib/ai.js           optional AI extraction and drafting (Anthropic SDK)
lib/drafts.js       template drafts and calendar files
lib/seed.js         the fictional demo
shared/dates.js     Asia/Dubai dates and date-phrase interpretation (server and browser)
public/             the web app
samples/            sample email and PDF used by the import window
tests/              tests and fixtures
scripts/            scripts that regenerate the sample and test PDFs
```
