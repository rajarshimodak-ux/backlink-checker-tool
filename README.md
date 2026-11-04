# Backlink Checker

Checks a sheet of placed backlinks and tells you, per row:

- **Status Code** of the live `Backlink URL` (follows redirects and shows the full chain, e.g. `301 → 200`, or `404`, `TIMEOUT`, etc.)
- **Keyword Found** — whether the `Keyword` actually appears on the live page (`Yes` / `Partial` / `No`)
- **Page Match** — whether the `Page` value matches the live page's `<title>`
- **Client Site Linked** — whether the `BL Website` is present as a real `<a href>` link in the article (not just mentioned as text)
- **Anchor Match** — whether the actual anchor text matches the `Anchor Text` column
- **Referring Domain DR** and **Referring Domain Traffic** — current Ahrefs Domain Rating + organic traffic of the referring domain
- **Quality** — `Good` / `Average` / `Low` / `Unknown`, based on DR/traffic thresholds you set in the UI

Two ways to use it:

1. **Web app** (`public/` + `api/`) — paste/upload a CSV, or a public Google Sheet link, run the checks, export results to CSV.
2. **Google Apps Script add-on** (`apps-script/backlink-checker.gs`) — bind it to your live tracker sheet and it checks + writes results back into the same sheet, no export/import needed.

## Expected columns

`WO ID, Domain, Page, Keyword, BL Website, Anchor Text, Content Link, Status, WO Created Date, Due Date, Author, Backlink URL`

Only `Backlink URL` is required. `Domain` (referring domain), `Page`, `Keyword`, `BL Website` (client site) and `Anchor Text` are used for the content checks — missing ones are just skipped (shown as `N/A`). Column order doesn't matter; matching is by header name (case-insensitive).

## Option 1: Web app

### Architecture

```
public/index.html   → UI: paste/upload CSV or a public Google Sheet link, results table, CSV export
api/check.js         → runs link checks (batched) + Ahrefs DR/traffic lookups
api/_linkcheck.js     → fetches a URL, follows redirects, scans HTML for keyword/page/client-site matches
api/_ahrefs.js        → Ahrefs API v3 client (Batch Analysis, falls back to per-domain Site Explorer calls)
api/fetch-sheet.js    → server-side fetch of a public Google Sheet's CSV export (avoids browser CORS)
api/_auth.js          → shared-password gate (x-app-password header, constant-time compare)
```

The Ahrefs key lives only on the server (Vercel function env), never sent to the browser.

### Setup

```bash
cp .env.example .env.local   # add your AHREFS_API_KEY (same key as ahrefs-keyword-extractor)
vercel dev
```

### Deploy

```bash
npm i -g vercel
vercel login
vercel env add AHREFS_API_KEY
vercel --prod
```

### Notes

- Reading a Google Sheet via the pasted link only works for sheets shared as **"Anyone with the link can view"**, and is read-only (export to CSV from the web app to save results). For true in-place read/write on a private sheet, use the Apps Script option below.
- Live-link checks run client-side in batches of 10 rows and DR/traffic is resolved once per unique referring domain up front (not per row), to keep Ahrefs usage and serverless execution time down.
- Each URL fetch times out after 20s and follows up to 6 redirects.

## Option 2: Google Apps Script (in-sheet, live read/write)

1. Open your tracker sheet → **Extensions → Apps Script** → paste in `apps-script/backlink-checker.gs` → Save.
2. Reload the sheet. A **Backlink Tools** menu appears.
3. **Backlink Tools → Set Ahrefs API key** → paste your Ahrefs API v3 key (stored in Script Properties, not in the file).
4. Open the tab with your backlinks and run **Backlink Tools → Check backlinks on this sheet**.

It writes these columns back into the same sheet (creating them if they don't exist): `Status Code, Keyword Found, Page Match, Client Site Linked, Anchor Match, Referring Domain DR, Referring Domain Traffic, Quality, Notes, Checked At`.

Quality thresholds (`MIN_DR`, `MIN_TRAFFIC`) are set at the top of the script — edit `CFG` if you want different cutoffs than DR 30 / 500 monthly traffic.

## API cost note

Ahrefs is billed by rows/units returned. This tool calls Batch Analysis once per up to 100 **unique** referring domains (not per row), so repeated domains across many backlinks don't cost extra.
