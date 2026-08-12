# Euronics Digital Command Centre — Automated Data Sync

This replaces the dashboard's old client-side sync (which only worked while a
browser tab stayed open, and called Anthropic's API with no key at all — a
setup that only functioned inside Claude.ai's artifact preview). Data now
refreshes server-side on a schedule, and the dashboard just reads a JSON file.

## What's in this repo

```
.github/workflows/sync-dashboard-data.yml   ← the daily cron job
scripts/sync-data.mjs                       ← the actual fetch/merge/prune logic
data/bank.json                              ← the data file the dashboard reads (seeded, updated daily)
dashboard.html                              ← the dashboard, modified to fetch data/bank.json instead of embedding it
```

## ⚠️ One thing to confirm before this goes live

`scripts/sync-data.mjs` supports two ways of authenticating to TMR, controlled by
the `TMR_AUTH_MODE` variable:

- **`anthropic_mcp`** (default) — calls Anthropic's API with `mcp_servers` pointing
  at TMR's MCP endpoint, same shape the dashboard used to call client-side. This
  requires a **real Anthropic API key** (`ANTHROPIC_API_KEY` secret). I could not
  verify from here whether TMR's MCP endpoint accepts this kind of call outside
  Claude.ai's session-based proxying, or whether it needs an additional OAuth
  token tied to your TMR account.
- **`tmr_direct`** — a placeholder for calling TMR's own API directly, if they
  have one separate from the MCP layer (check hub.twominutereports.com → account
  / API settings). This avoids spending Anthropic tokens just to fetch data and
  is architecturally cleaner if it exists. The endpoint URL in the script is a
  guess and **will need correcting** once you find their real docs.

**Recommended first step:** run the workflow manually once (Actions tab →
"Sync Euronics Dashboard Data" → "Run workflow") with `TMR_AUTH_MODE=anthropic_mcp`
and watch the log. If every connector fails with an auth error, that confirms
you need TMR's direct API path instead — check their account settings for an
API key, update `fetchViaTmrDirect()` with the real endpoint, and switch the
`TMR_AUTH_MODE` repository variable to `tmr_direct`.

## Setup

1. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `ANTHROPIC_API_KEY` — a real key from console.anthropic.com (used for both
     the TMR fetch, if using `anthropic_mcp` mode, and for generating the daily
     AI insights)
   - `TMR_API_KEY` — only needed if you switch to `tmr_direct` mode

2. **(Optional) Set `TMR_AUTH_MODE`** as a repo variable (Settings → Secrets and
   variables → Actions → Variables tab) if you want `tmr_direct` instead of the
   default.

3. **Host the two files** (`dashboard.html` + `data/bank.json`) together —
   GitHub Pages is the easiest zero-cost option:
   - Settings → Pages → deploy from the `main` branch, root folder
   - The dashboard will then be reachable at `https://<your-org>.github.io/<repo>/dashboard.html`
   - If you want it on `dashboard.euronics.co.in` instead, add a `CNAME` file
     and point your DNS at GitHub Pages per their custom-domain docs

4. **Password-protect it** if it's going on a public domain — GitHub Pages
   itself has no built-in auth. Cloudflare Access (free tier) sitting in front
   of the domain is the simplest way to add a login wall without touching the
   dashboard's code.

## How the daily sync works

- Runs at 11:00 AM IST via GitHub Actions cron (`30 5 * * *` UTC)
- For each connector, fetches only the days missing since the last successful
  sync (same delta logic the old client-side version used)
- Merges new rows in, keeps a rolling 95-day window (the dashboard's own
  `slice(-90)` logic still enforces the true 90-day display cap on top of this)
- Per-connector failures are caught and logged — one broken connector (like the
  Shopify permission issue or the GA4 property mismatch you've hit before)
  never blocks the others from updating
- GA4 stays permanently flagged stale until you fix the underlying TMR
  connection — this script will never silently fabricate data for it
- Also pre-generates the "Analyse / Working / Not working / Improve" text for
  every tab (using the real 30-day numbers), so those buttons are instant in
  the browser with zero live API calls
- Commits the updated `data/bank.json` back to the repo

You can also trigger a sync manually anytime: Actions tab → "Sync Euronics
Dashboard Data" → "Run workflow" button. Useful right after fixing a broken
connector, instead of waiting for 11am.

## What's intentionally NOT included: live "Ask AI"

The free-text "Ask AI" box in each tab needs a live backend endpoint that can
answer on demand — GitHub Actions only runs on a schedule/manual trigger, it
can't serve real-time requests from someone typing a question in the browser.
Right now that box shows an explanation instead of failing silently.

### Upgrading to live Ask AI

If you want this back, the smallest addition is a single serverless function
(Cloudflare Worker or Vercel Edge Function both have generous free tiers) that:

1. Receives `{tab, question}` from the dashboard
2. Holds `ANTHROPIC_API_KEY` as a server-side secret (never sent to the browser)
3. Calls Anthropic, returns the answer

That's maybe half a day of work on top of this setup, and it's the only piece
of the original "Cloudflare Workers" production-grade scope that this
GitHub-Actions version deliberately skips to stay fast-to-ship.

## Known data limitations (unchanged from before, not introduced by this sync)

- **GA4**: disconnected from TMR (property 350385395 no longer in the team's
  connections) — flagged stale, needs reconnecting in TMR's Connections page
- **LinkedIn Organic, LinkedIn Ads**: some days have thin or zero data — this
  is genuine account activity, not a sync bug
- Amazon Marketplace and Shopify sometimes report a day behind (their own
  platform reporting lag, not this sync's fault) — the merge logic handles
  this fine, it just fills in whenever the source catches up
