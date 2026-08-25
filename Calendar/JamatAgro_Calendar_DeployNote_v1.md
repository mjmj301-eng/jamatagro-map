# JamatAgro Farm Calendar — Wiring & Deploy Note (v1)
**What this covers:** the calendar module wired into the live map viewer. The map now colours plots by calendar status, shows each plot's next tasks in its popup, and links to the full planner.

## What changed
- **`index.html`** (the live map) is now the wired viewer. It is byte-identical to the old v7 apart from the calendar additions, so this is a clean swap. The previous version is saved as **`index_v7_backup.html`**. A standalone copy of the wired viewer is also kept as **`JamatAgro_FarmMap_Viewer_v8.html`**.
- The **calendar engine is inlined** into `index.html` (no extra script to load). The map reads three calendar files from the **`Calendar/`** sub-folder.

## To go live (GitHub)
Commit and push these to the repo, keeping the paths exactly as shown:

```
/index.html                              ← wired viewer (replaces the old v7)
/JamatAgro_PlotGeometry.geojson          ← unchanged (already there)
/Calendar/JamatAgro_CropTemplates_v3.json
/Calendar/JamatAgro_CropCycles_v2.csv
/Calendar/JamatAgro_TaskLog_v2.csv
/Calendar/JamatAgro_Workforce_v1.csv
/Calendar/JamatAgro_Activity_sample_v1.csv   (sample; the planner’s live feed is the Google Form)
/Calendar/JamatAgro_CalendarEngine_v4.js     (reference copy; already inlined in index.html)
/Calendar/JamatAgro_PlanningViews_v4.html    ← the full planner
```

GitHub Pages serves same-origin, so the map’s `fetch`/PapaParse of the `Calendar/` files works once pushed. (Opening `index.html` from `file://` will show the map but **not** the calendar overlay — same reason the geometry only auto-loads when hosted.)

## How it behaves
- **New colour-by option “📅 Calendar status.”** Precedence per plot: **red** = a critical task past its window · **amber** = a task due within 7 days · **blue** = a harvest window is open today · **green** = has upcoming/on-time tasks · **grey** = no active cycle. Legend updates automatically.
- **Plot popup** now appends the plot’s status and its **next 5 outstanding tasks** (plain-language labels, ‼ for critical), plus an **“Open plot in planner ▸”** link that deep-links to that plot (`…PlanningViews_v4.html?plot=<n>`).
- **Sidebar button “📅 Open Farm Calendar (planner)”** opens the full Year/Month/Week/Plot/Report planner.
- The map is **read-only** for the calendar (by design — the site is static). Planning edits happen in the planner (which exports `task_log.csv`) or by editing the `Calendar/` CSVs.

## Maintaining the data
- **Add / change a crop cycle:** edit `Calendar/JamatAgro_CropCycles_v2.csv` (one row per crop on a plot: `plot_no`, `crop`, `template_version`, `anchor_date`, `manager`, …) and push. The overlay and popups update on next load. A bad row is listed in the map’s validation (it is skipped, never crashes).
- **Adjust agronomic timings / labour:** edit `Calendar/JamatAgro_CropTemplates_v3.json` — pure data, no code change. Bump the version and re-point cycles when you want the change to apply to existing cycles.
- **Crew sizes (capacity line in the planner):** edit `Calendar/JamatAgro_Workforce_v1.csv`.
- **Completions/actuals:** the planner writes these to `task_log.csv`; commit the updated file to `Calendar/` for the map to reflect them.

## Single source of truth — no duplicated data
Both the map and the planner now read their data from **one shared config**: `Calendar/JamatAgro_DataSources_v1.js` (`window.JAMAT_SRC`). Edit a source once there; both apps pick it up.

| Data | Single home | Read by |
|---|---|---|
| Plot attributes | **Register** Google Sheet (`REGISTER_CSV_URL`) | map + planner |
| Field activity / incidents | **Activity** Google Form → Sheet (`ACTIVITY_CSV_URL`) | map + planner |
| Crop cycles | **Cycles** Google Sheet (`CROP_CYCLES_URL`) | map + planner |
| Task log | **Task-log** Google Sheet (`TASK_LOG_URL`) | map + planner |
| Templates / workforce | one repo file each | map (templates) + planner |

The planner keeps a small **bundled copy** of the sample data so it still opens offline; when hosted it fetches the live sources and shows a "Live data loaded…" note. If a Sheet URL is blank, that source falls back to the repo CSV / bundled copy — nothing breaks.

### To activate the two remaining sheets (one-time)
1. **Crop cycles** sheet (`docs.google.com/…/14ywp7knw2agZfFFwTWjfeHel-AyrCIJAX4yvKxOMcsE`): paste the current `Calendar/JamatAgro_CropCycles_v2.csv` rows into it, then **File ▸ Share ▸ Publish to web ▸ (the tab) ▸ CSV ▸ Publish**. Copy the `…/pub?output=csv` link.
2. **Task-log** sheet (`…/19xsPGVFjEqB57MDfG-8z0XVynETjuZD5H1Xa5-D4ne0`): same — publish the tab as CSV.
3. Paste the two links into `Calendar/JamatAgro_DataSources_v1.js` on the `CROP_CYCLES_URL` and `TASK_LOG_URL` lines. **Confirm which sheet is which** (I've guessed 14ywp…=cycles, 19xsPG…=task-log — swap if reversed).
4. Commit & push. Both apps go live on those sheets automatically.

> ⚠ Use the **Publish-to-web → CSV** link (`…/pub?output=csv`). A normal `/edit` or Drive-share link returns the editor/sign-in page and will not load.

### The report Google Form
The report Form (`forms/d/1ntqZ…`) updates the **Activity** data — its responses land in the Activity Sheet, which both apps already read via `ACTIVITY_CSV_URL`. Nothing to wire; it's connected.

### Writes (task log)
The site is static, so writes stay export-and-append: the planner **exports `task_log.csv`**, and whoever owns the Task-log sheet appends the new rows (paste at the bottom — the log is append-only, deduped by `entry_id`). Both apps then read the updated sheet.

## Verified before hand-off
- Engine + viewer scripts parse clean; per-plot statuses compute correctly against the real 99-plot geometry (e.g. mature palm plot 1 → red/overdue harvest; 2026 blocks 35/57 → amber; cassava/tomato plots → green; plots with no cycle → grey).
- The deliberately broken cycle row is excluded with a plain-English fix hint, not a crash.
