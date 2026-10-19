# JamatAgro — Completion Form + write-back (setup)
**Goal:** a "task done" report lands as a proper row in the **Task-log sheet automatically** — no CSV export, no manual paste. Works for field staff (a Google Form) and, optionally, for the planner (direct sync).
**File:** `Calendar/JamatAgro_AppsScript_Completion.gs`

## What it does
When someone reports a completed task, the script runs the **same calendar engine the apps use** to find *which* task it closes, and appends a `done` event to the Task-log sheet keyed to the exact occurrence — capturing yield / crew / note too. If a report can't be matched confidently, it's still saved (flagged "review"), never lost. Writes are **append-only and de-duplicated by `entry_id`**, so nothing double-counts.

## Prerequisites
- The **Task-log** and **Crop-cycles** Google Sheets exist (the two you shared). Each needs a tab with a header row; the Task-log header must be the 23 columns the apps use (`entry_id, event_ts, …, notes`). The script writes that header automatically on first run if the tab is empty.
- Templates are published on GitHub Pages at the `TEMPLATES_URL` already in the script (adjust if your repo path differs).

## Steps (≈15 min, one time)
1. Go to **script.google.com → New project**. Delete the sample, and paste the entire contents of `JamatAgro_AppsScript_Completion.gs`.
2. In the **`CONFIG`** block at the top, fill:
   - `TASKLOG_SHEET_ID` — the ID in the Task-log sheet URL (`…/spreadsheets/d/`**`<ID>`**`/edit`).
   - `TASKLOG_TAB` — the tab name (default `task_log`).
   - `CYCLES_SHEET_ID` / `CYCLES_TAB` — same for the Crop-cycles sheet.
   - `TEMPLATES_URL` — leave as-is if your Pages URL is `mjmj301-eng.github.io/jamatagro-map`.
   - (optional) `SHARED_SECRET` — a token if you want to lock the Web App; leave blank for now.
3. **Save.** Run **`testWriteback`** once (▶). Google will ask you to **authorise** — approve (it needs Sheets access). Check the Task-log sheet: a `TEST/ping` row appears. Delete that test row.
   - Optional: run **`testMatch`** to confirm matching (defaults to plot 45 / Weeding / 2026-05-16 → cassava first weeding).
4. Run **`createCompletionForm`** once. Open **View → Logs**: it prints two links —
   - **"SHARE this link"** = the fill-in form for the team (put it in the WhatsApp group / bookmark on field phones).
   - "edit here" = the form editor if you want to tweak wording.
   This also installs the on-submit trigger automatically.
5. **Test the loop:** open the share link, submit a completion for a plot that has an open task, then reload the map or planner — that task shows **done** with your date. Done.

## Planner → sheet sync, no export  (built)
The same script exposes a Web App endpoint, and the planner now has a **"⇧ Sync to sheet"** button wired to it (it appears once `SYNC_URL` is set).
1. In Apps Script: **Deploy → New deployment → Web app**. Set **Execute as: Me**, **Who has access: Anyone**. Copy the **`/exec`** URL.
2. Paste it into `Calendar/JamatAgro_DataSources_v1.js` → `SYNC_URL` (and `SYNC_SECRET` too if you set `SHARED_SECRET` in the script). Commit & push.
3. In the planner, the header badge now reads **"N to sync"**; pressing **⇧ Sync to sheet** POSTs those events to the Task-log sheet and the badge clears to **"synced ✓"**.

How it behaves (all verified headless):
- **Optimistic + idempotent.** The server de-dupes by `entry_id`, so pressing Sync twice, or syncing then reloading, never double-counts. Re-syncing with nothing new sends nothing.
- **Offline-safe.** If the POST fails (no signal), the changes stay on the device and the badge still shows "to sync" — press again when online.
- **Self-cleaning.** When the planner next loads the live Task-log sheet, any local copy already present in the sheet is dropped, so the device buffer doesn't grow.
- The **Export task_log** button remains as a manual fallback (and for when `SYNC_URL` is blank).

> Note on CORS: Apps Script Web Apps don't return CORS headers, so the planner posts "fire-and-forget" (it can't read the reply). That's why the design leans on server-side de-dupe — the write is safe even though the browser can't read the confirmation. Reload to see the rows land.

## How reports are handled
| Report | Result |
|---|---|
| Matches one open task (plot + activity + date ±5 days) | `done` event written, keyed to that task's occurrence, with crew/qty/note |
| Matches tasks on **two crops** on the same plot | kept as "review" (never auto-closes the wrong crop) — confirm in the planner |
| No open task nearby | kept as `field_done` "review" row — visible, not lost |

`MATCH_TOLERANCE_DAYS` (default 5) controls how far a reported date can be from the planned date and still match.

## #2 — Auto-close high-confidence field reports (scheduled)
Turns the ordinary **Activity log** (your existing report Form) into automatic completions: once a day the script reads recent work reports, matches each to an open task with the engine, and writes the `done` row **only when the match is unambiguous and a tight date fit**. Anything ambiguous (two crops on a plot) or with no open task is left alone for a human — it still shows as a "suggested completion" in the planner.

Setup (same script project):
1. In `CONFIG`, set `ACTIVITY_SHEET_ID` and `ACTIVITY_TAB` to the Activity/Form-responses sheet.
2. (Optional) tune `AUTOCLOSE_TOLERANCE_DAYS` (default 3 — stricter than the Form path's 5) and `AUTOCLOSE_LOOKBACK_DAYS` (default 21).
3. Run **`autoCloseFromActivity`** once by hand to see the log (`matched / written / ambiguous / no-match`). Check the Task-log sheet for the new `auto-closed from field report` rows.
4. Run **`installAutoCloseTrigger`** once to schedule it daily (~6am).

Safety: the written event's `entry_id` is a fingerprint of the activity row, and a closed task no longer matches — so re-runs never double-write. Incidents are ignored. Verified against real data: reports on plot 37 (Planting) and plot 1 (Harvest) auto-closed to the correct occurrences; a second run wrote 0.

## #3 — Save → live (no manual publish/deploy)
Two halves, both now automatic:

**Google Sheets (data).** Once a sheet is *Published to web → CSV*, Google re-serves the latest content automatically after each edit — no re-publishing per change. The apps now add a **cache-buster** to every data fetch, so a page **reload always pulls the newest sheet content** (removes the "why isn't my edit showing?" browser-cache trap). Google's publish cache can lag a few minutes; a reload a minute later is the fix.

**Repo files (templates, workforce, geometry, the apps).** A **GitHub Pages deploy Action** (`.github/workflows/deploy-pages.yml`) publishes the site on every push — *push = live* in ~1 minute. One-time: repo **Settings → Pages → Source = "GitHub Actions"**. (If your default branch is `master`, change the `branches:` line in the workflow.)

Optional zero-lag reads: if the few-minute sheet cache ever matters, point `CROP_CYCLES_URL` / `TASK_LOG_URL` at an Apps Script `doGet` that returns the sheet as JSONP instead of the published CSV — instant, no publish step. Not needed for normal use; ask and I'll wire it.

## #4 — WhatsApp daily send
Each morning, build every manager's outstanding list for the day and get it to WhatsApp. Two modes (choose in `CONFIG`):

**Default — coordinator email with one-tap links (zero setup, works with your group).**
1. Set `COORDINATOR_EMAIL` in `CONFIG` (and `DAILY_HOUR`, default 6).
2. Provide manager phone numbers **outside the public repo** — either a private Google Sheet (`RECIPIENTS_SHEET_ID` + a `recipients` tab with columns `manager, phone, email`) or the `RECIPIENTS` array in the script. Phone in international digits, e.g. `2348…` (no `+`). Numbers are optional — without one, the link opens WhatsApp's chat picker so the coordinator can drop it in the group.
3. Run **`sendDailyLists`** once to test — you'll get an email with, per manager, a **"Open … in WhatsApp ▸"** link (opens WhatsApp with the message pre-filled) and a copy-paste block.
4. Run **`installDailyWhatsAppTrigger`** to schedule it daily.

This deliberately keeps a human tap at the end so it can target your **WhatsApp group** (the official API can't post to groups) and there's a moment to glance before sending.

**Optional — full auto, 1:1 via WhatsApp Business Cloud API.**
Set `WA_CLOUD = { enabled:true, phone_id:'…', token:'…', template:'…' }` and give each manager a `phone`. The job then messages each manager directly, no tap. Caveats to know before choosing this: it needs a Meta WhatsApp Business number + access token; it sends to **individuals, not the group**; and a proactive message sent outside a 24-hour window from the recipient requires a **Meta-approved message template** (free-form text only works inside that window). For a farm team this is usually more setup than it's worth — the email-links mode is the pragmatic default.

Recipients sheet columns: `manager, phone, email`. Keep this sheet **private** — do not commit phone numbers to the GitHub repo.

## Guardrails
- The apps stay **read-only static pages**. All writing happens in this Apps Script on Google's side, so the "no backend, works offline, low-bandwidth" property is unchanged.
- **Append-only + dedupe** means resubmitting or re-syncing can't corrupt the log.
- The completion Form captures the same vocabulary as your existing Activity Form, so the two never disagree.

## Verified before hand-off
Ran the server matcher against the real templates/cycles/log:
- plot 45 · Weeding · 2026-05-16 → cassava `weed_1` (occurrence 0), `done`, crew 6 captured.
- plot 1 · Harvest · 2026-08-13 → mature-palm `harvest_round` (occurrence 132), `done`, 2.4 t captured.
- plot 99 (no cycle) → kept as `field_done` review row.
