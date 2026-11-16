# Dexter Payments

A private payments dashboard for an owner and their accountant. It brings paper files, spreadsheets and
bank statements into one ledger and answers four questions quickly:

1. What do I need to pay next?
2. How much do I still owe?
3. What money should I receive?
4. What is coming up that I have not been billed for yet?

Defaults: **AED**, **Asia/Dubai**. Totals stay separate per currency unless the owner enters an exchange rate.

## Run it

Requires **Node.js 22.13 or newer** (it uses Node's built-in SQLite, so there is no database to install).

```bash
npm install
npm start            # http://127.0.0.1:4000
```

On first open you create the owner account. Leave "Start with a fictional demo" ticked to try everything
with invented data, then clear it under **Settings → Workspace → Clear demo and start for real**.
Add your accountant under **Settings → People and access**.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Port to listen on |
| `HOST` | `127.0.0.1` | Only this computer by default. `0.0.0.0` exposes it to the network; put HTTPS in front |
| `DEXTER_DATA_DIR` | `./data` | SQLite database, uploaded originals, OCR cache. **Back this folder up** |
| `DEXTER_SECURE_COOKIES` | off | Set `1` when served over HTTPS |
| `DEXTER_TRUST_PROXY` | off | Set `1` behind a reverse proxy (for correct client IPs and HTTPS detection) |
| `SMTP_URL`, `MAIL_FROM` | unset | Email reminders (see below) |
| `OCR_LANGS` | `eng` | OCR language(s), e.g. `eng+ara` (see below) |
| `DEXTER_OCR` | on | `off` disables OCR for images |

```bash
npm test             # end-to-end test against a real server process with a throwaway data folder
```

## What is in it

- **Dashboard**: Next 30 days (7 / 30 / 90), next payment, overdue, expected in, projected difference,
  money in vs out per week, confirmed vs estimated share, timeline by date or by group, entries open to
  the invoice, schedule or statement behind them.
- **Calendar and weekly summary.**
- **Groups**: Household & family, Vehicles (a page per car: loan, next installment, remaining balance, final
  installment, balloon, insurance, registration, service, cost per year), Properties (rent payable or
  receivable, mortgage, maintenance, contractor bills, multi-installment schedules), Loans & cards
  (schedules, statement balance, minimum due, purchases linked to the statement), Business (payables and
  who owes what).
- **Import Inbox**: paper files (OCR + side-by-side review), Excel/CSV (map, validate, flag duplicates),
  bank and card statements (suggested matches with reasons, confirm, split, set aside transfers), Needs review.
- **Ledger**: full and part payments, refunds, credits, proof of payment, change history per record.
- **Two roles**, enforced on the server: *owner* (everything plus people and workspace settings) and
  *accountant* (all financial records, documents, imports, matching, payments, exports).

Amounts are labelled **Confirmed**, **Estimated** or **Needs review**. A schedule you generate rather than
copy from the lender is labelled **Projected · not verified** until you mark it verified.

## OCR

Works out of the box, on your computer, with nothing sent to an outside service:

- PDFs with a text layer are read directly.
- Photos, scans and image-only PDFs go through `tesseract.js`; the English model ships with `npm install`.
- Arabic or other languages: set `OCR_LANGS=eng+ara`. Tesseract then downloads that language model once
  (needs internet the first time), or point `OCR_LANG_PATH` at a folder of `*.traineddata.gz` files.
- HEIC photos are stored but not read; set the phone camera to JPEG ("Most compatible").

OCR is a first draft. Every field carries a confidence; uncertain ones are outlined in amber and nothing
becomes a record until someone confirms it. Handwriting and poor photos will need manual correction.

## Reminders

- **In-app**: on from the start (bell icon). Default 30, 7 and 1 days before the due date, editable per user.
- **Email**: needs an SMTP account. Start the app with

  ```bash
  SMTP_URL='smtps://USER:PASSWORD@smtp.example.com:465' MAIL_FROM='Dexter Payments <reminders@example.com>' npm start
  ```

  Then each user opens **Settings → Reminders**, sends a confirmation code to their own address and types
  it back. Email is shown as working only after that code is confirmed. Digests go out on start and every
  30 minutes; each reminder is emailed once.
- **Push**: not implemented. It needs HTTPS plus a web-push key pair.

## Privacy and safety notes

- Originals are stored in `data/uploads` under their content hash and served only to signed-in users.
- Re-uploading the same file returns the earlier import; statement lines are fingerprinted so overlapping
  exports do not duplicate.
- Document contents are only parsed with fixed patterns and shown for review; they are never executed or
  acted on. The access log records method, path and status only.
- Passwords are hashed with scrypt; sessions are HttpOnly, SameSite=Strict cookies; state-changing requests
  need a same-origin header.
- The app records payments you make yourself. It does not connect to a bank or move money.
- The demo data is entirely fictional. `data/` is git-ignored; keep real files out of the repository.

## Known limits

- Statement import reads CSV and Excel exports. PDF statements can be attached but are not read line by line.
- One workspace per installation. No automatic bank feeds.
- No built-in HTTPS. For access from a phone outside your home network, put it behind a reverse proxy or VPN.
