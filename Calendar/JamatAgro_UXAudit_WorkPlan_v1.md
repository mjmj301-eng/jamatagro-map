# JamatAgro Farm Calendar — UX-Audit Implementation Work Plan (v1)
**Source:** *UX Audit · Field Data Systems* against `JamatAgro_PlanningViews_v1.html`, Spec v2.0 §8–§9.
**Covers:** all 30 findings (IN-01…11, HD-01…06, UT-01…07, FC-01…06) + the 6 verified strengths (do-not-break list).
**Target files:** `JamatAgro_PlanningViews_v1.html` (markup+CSS `_head.html` / logic `_app.js`), `JamatAgro_CalendarEngine_v2.js`, `JamatAgro_CropTemplates_v2.json`, `JamatAgro_CropCycles_v2.csv`, `JamatAgro_TaskLog_v2.csv`, and the existing `JamatAgro_CalendarDemo_v1.html` (already contains a working V3 daily list + WhatsApp export to port).
**Sequencing principle:** trust-per-hour — order by how much each change moves whether the team keeps using the tool, weighted by build cost. Wave 1 clears every blocker in ~1 week.

---

## 1. How to read this plan
Each work item is a self-contained ticket: **what to change**, **which file/function**, **effort**, **dependencies**, and **acceptance criteria** a reviewer can check. Findings are grouped into three waves plus a small **Wave 0** of foundation changes that several later items depend on. A full **traceability matrix (§7)** maps every one of the 30 findings to its work item, so nothing is dropped. Effort: **S** ≈ ≤2h, **M** ≈ ½–1 day, **L** ≈ 1–3 days.

**Do-not-break (verified strengths):** stable `occurrence_index` from intrinsic origin; append-only log + union-by-`entry_id` merge; `plan_start_date` floor; validation-degrades-not-crashes; labour = `labour_per_ha × area_ha`; phase gating at occurrence date; terminology already reconciled to the map viewer. Every change below must preserve these — they are the foundation and are not being rebuilt.

## 2. Wave summary
| Wave | Goal | Findings closed | Duration |
|---|---|---|---|
| **0 — Foundation** | Schema + engine + config hooks the UI work depends on | (enabling: HD-06, parts of HD-01, UT-01, UT-03, HD-03, IN-08, FC-03) | ~1.5 days |
| **1 — Blockers** | Stop data loss and false-red; get the plan out of the office | IN-01, IN-02, IN-03, IN-04, IN-05, HD-01, UT-01, + FC-06, HD-06 | ~1 week |
| **2 — Close the loops** | Auto-match, capacity, plot-centricity, recurring collapse, capture | IN-06, IN-07, IN-08, HD-03, UT-02, UT-05, UT-06, IN-10, HD-02 | ~1–1.5 weeks |
| **3 — Reach & polish** | Contrast, forward-roll, identity, language, reporting, incidents | IN-09, IN-11, HD-04, HD-05, UT-04, UT-07, FC-01, FC-02, FC-03, FC-04, FC-05 | ~1–1.5 weeks |

---

## 3. Wave 0 — Foundation (do first; unblocks Wave 1–2)

### F1 · `task_log` schema extension — **[S]**
Add the columns the capture and identity work needs, keeping the log append-only.
- **File:** `JamatAgro_TaskLog_v2.csv` header + `LOGCOLS` in `_app.js` + serialiser.
- **Change:** add `manager` (fixes HD-06 — assignment currently survives only via a duplicate `adhoc_manager` write), and capture columns `crew_size`, `qty`, `qty_unit`, `note`. Keep spec fields `anchor_name`, `link_activity_id`.
- **Accept:** export round-trips an `assigned` event with `manager` populated (no reliance on the `adhoc_manager` coincidence); new columns present and blank-safe on reload.

### F2 · Engine status model — split *not-reported* from *overdue*, add *in-window* — **[M]**
- **File:** `JamatAgro_CalendarEngine_v2.js` → `classify()` and occurrence build.
- **Change:** return a richer status: `done` · `in_window` (today ≤ planned + `window_days`) · `due_soon` · `not_reported` (past, no event, non-critical tolerance elapsed) · `overdue` (past + `critical` or window elapsed) · `skipped`. Expose `window_end = planned + window_days` and keep `end_date` for window tasks.
- **Accept:** a task one day past its date but inside `window_days` classifies `in_window`, not overdue; a past task with no event classifies `not_reported`, not `overdue`. Unit test on land-clearing (14-day window) and a critical task.

### F3 · Recurring-run grouping metadata — **[M]**
- **File:** engine occurrence objects.
- **Change:** stamp each recurring occurrence with `run_id` (`cycle_id|task_code`), `run_index`, `run_total` within the active window, so the UI can collapse a run to one row with "picks 5 of 14" and range-close.
- **Accept:** tomato `harvest_picks` occurrences share one `run_id` with correct `run_total`; `occurrence_index` unchanged (identity preserved).

### F4 · Workforce config — **[S]**
- **File:** new `JamatAgro_Workforce_v1.csv` (`manager, crew_size`) loaded like the other CSVs.
- **Change:** a per-manager establishment headcount, joined in the UI for capacity lines.
- **Accept:** file loads; missing manager → capacity line hidden gracefully, not a crash.

### F5 · Plain-language `field_label` on template tasks — **[S]**
- **File:** `JamatAgro_CropTemplates_v2.json`.
- **Change:** add `field_label` beside each agronomic `label` (e.g. "Remove early flower bunches" for *Ablation of early inflorescences*). Structural hook also carries a future translation.
- **Accept:** every task has a `field_label`; adding one requires no code change (data-driven).

> Wave 0 is deliberately schema/engine-only so the Wave 1 UI can be built against final shapes and not reworked.

---

## 4. Wave 1 — Blockers (≈1 week; clears all 7 blockers)

### W1.1 · Persist session + safe Reset — closes **IN-01** — **[S]**
- **File:** `_app.js` (`sessionLog`, `initControls`).
- **Steps:** (1) mirror `sessionLog` to `localStorage` on every push; hydrate on load. (2) `beforeunload` guard when unsynced events exist. (3) header badge "**N unsynced**". (4) `Reset` → confirm dialog; relabel "Clear unsynced".
- **Accept:** tap 20 tasks → refresh → all 20 survive; badge shows 20; Reset asks first.

### W1.2 · Rebuild the action row — closes **IN-02, IN-03, IN-04** — **[L]**
- **File:** `_head.html` (`.task`, `.act` CSS), `_app.js` (`taskRow`, `onAction`).
- **Steps:** (1) targets ≥ **44 px**, ≥13 px labels; drop the cramped 5-col grid to a 2-row card on narrow widths. (2) **Done opens a date picker** defaulting to today (not As-of) — fixes `done_date = asof`; write the chosen date to `done_date`. (3) every event is reversible: an **Undo** on the row and a session "recent events" list that appends a compensating event (the append-only log already supports this); `done`/`skipped` rows remain reachable (show a muted "done ✓ — undo").
- **Accept:** buttons measure ≥44 px at 375 px; completing on Fri for Tue work records Tue; skip is undoable; no action is irreversible from the UI.

### W1.3 · Daily work list + WhatsApp export + print — closes **IN-05** — **[M]**
- **File:** new tab in `JamatAgro_PlanningViews_v1.html`; **port** the working V3 list + WhatsApp text already in `JamatAgro_CalendarDemo_v1.html` (§8 contract) rather than rebuild.
- **Steps:** (1) "Today / Daily" tab: per-manager, per-day list, field-labels (F5), inputs. (2) "Copy as WhatsApp" per manager (existing contract; `‼` on critical). (3) `@media print` stylesheet for a paper round.
- **Accept:** a supervisor's day copies to WhatsApp as plain text; page prints one clean list per manager.

### W1.4 · Not-reported ≠ missed in Week Review — closes **HD-01** (interim) — **[M]**
- **File:** `_app.js` `renderWeek()` using F2 statuses.
- **Steps:** (1) show three buckets — **done · not reported · missed(critical/overdue)** — not one red count. (2) completion % computed on *reported* only; exclude `not_reported`. (3) distinct neutral styling for `not_reported` (grey/hatched), red reserved for genuine overdue.
- **Accept:** the demo's "4 planned · 0 done · 4 missed · 0%" becomes "4 planned · 0 reported · — % (nothing reported yet)"; no red for silence. (Permanent fix = auto-match, W2.2.)

### W1.5 · Capacity line on the manpower bars — closes **UT-01** — **[M]**
- **File:** `_app.js` `renderMonth()` weekly bars; join F4 crew sizes.
- **Steps:** (1) bars scaled to an **absolute** person-day axis, not `max(week)`. (2) draw a **capacity line** = crew_size × working-days/week per manager. (3) apply the already-defined `.peak` style when a week exceeds capacity, with an "N short" caption.
- **Accept:** a week over capacity renders past the line and is flagged; the bar for a light week is visibly short (not full).

### W1.6 · As-of defaults to today + relabel — closes **FC-06** — **[S]**
- **File:** `_head.html` (`value="2026-07-26"`), `_app.js`.
- **Steps:** default `As of` to `today` at load; tooltip "date the plan is viewed as — a time-travel control, not a filter".
- **Accept:** opening the tool on any day shows correct statuses without edits.

### W1.7 · Persist assignment column — closes **HD-06** (data-loss half) — **[S]**
- Depends on **F1**. Write `assigned` events into the real `manager` column; drop reliance on the `adhoc_manager` fallback. **Accept:** assignment survives export→reload via `manager`.

**Wave 1 verification:** reload-survival test; 44 px measurement at 360/375 px; Fri-logs-Tue delta test; WhatsApp copy on a phone; Week Review shows no false red; capacity line flags an over-booked week.

---

## 5. Wave 2 — Close the loops (≈1–1.5 weeks)

### W2.1 · Render tolerance windows everywhere — closes **UT-03, IN-07** — **[M]**
- Use F2's `window_end`/`end_date`. Show the window as a band on rows and Year cells; a task inside its window reads **"on time (within Xd)"**, not overdue. Replace the hard-coded `+7d` shift with a **date picker + quick chips** (+ window_days, +7, +14, custom). **Accept:** land-clearing not red until day 15; cassava harvest shows a month 9–15 band, not a single day; arbitrary reschedule in two taps, one row.

### W2.2 · Auto-match suggested completions (spec P0-7) — permanent close of **HD-01** — **[L]**
- **File:** engine + a "suggestions" UI. Match `activity.csv` rows on `(plot_no, activity_detail↔detail, date ± 5d)` to open occurrences; surface as one-tap "confirm" that appends a `done` (with the activity's real date and `by`). Tie-break: nearest open occurrence; multi-cycle plots → list, never auto-pick. **Accept:** a matching activity row yields a one-tap suggested completion; intercropped plot never auto-closes the wrong crop.

### W2.3 · Collapse recurring runs — closes **HD-03** — **[M]**
- Use F3 metadata. Render a run as **one row** with "picks 5 of 14" progress and a **range-close** ("mark all up to today done"). **Accept:** July shows one tomato-picks row, not six; one action closes a date range; stats stop being polluted by 14 unticked rows.

### W2.4 · Completion capture: quantity, crew, note — closes **IN-08** — **[M]**
- Depends on F1. Done dialog optionally captures `qty`+`qty_unit` (FFB tonnage / crates / bags), `crew_size`, `note`. Harvest rows prompt for yield. **Accept:** a harvest completion stores tonnage against plot+round; a labour task can store crew size, resolving person-days into "8 people × 3 days".

### W2.5 · Plot filter + plot detail — closes **UT-02** (and enables map overlay) — **[M]**
- Add a **plot filter + search** to the control bar; a **plot detail** panel = that plot's next N tasks across crops (handles intercropping). Groundwork for the spec V4 map overlay (colour plots by calendar status) as a follow-on. **Accept:** "what's the plan for plot 45?" answerable in one action, showing both cassava and any ad-hoc.

### W2.6 · Ad-hoc validation + visibility — closes **IN-10** — **[S]**
- Validate `adhoc_plot_no` against the register (reuse validation); reject plot 999. Stop ad-hoc rows vanishing under a crop filter — treat ad-hoc as plot-scoped so a "Cassava"/plot-45 filter still shows the plot-45 emergency spray (or add an "include ad-hoc" default-on). **Accept:** bad plot rejected at entry; emergency spray visible when reviewing its plot.

### W2.7 · Data-driven crop filter + full filter set — closes **UT-06** — **[S/M]**
- Build the crop dropdown from templates (not the 3 hard-coded `<option>`s) so a 4th crop needs no code (restores the spec's "add a crop = no code"). Add **category, critical-only, status** filters and "everything overdue" / "critical only" quick triage. **Accept:** adding a template auto-populates the crop filter; critical-only and overdue filters work.

### W2.8 · Year matrix: tap-to-drill + decimals — closes **UT-05** — **[S]**
- Cells become **tap-to-filter into Month** (touch has no hover); show one decimal below 10 pd so 0.5-ha tomato fertiliser isn't "0". **Accept:** tapping a cell filters Month to that crop+month; sub-10 pd values show a decimal.

### W2.9 · Label Year-view pattern-only region — closes **HD-02** — **[S]**
- In `ignorePlanStart` (overview) mode, **shade/label** the pre-`plan_start_date` portion for onboarded blocks as *pattern, not plan* (e.g. hatched), so half of plot-1's harvest totals aren't read as real planned labour. **Accept:** pre-plan-start months visually distinct; a caption explains "pattern shown for reference".

**Wave 2 verification:** auto-match suggestion on a seeded activity row; recurring collapse count; capture writes tonnage; plot filter returns intercropped tasks; adding a 4th template shows in the crop filter with zero code edits.

---

## 6. Wave 3 — Reach & polish (≈1–1.5 weeks)

- **W3.1 · Contrast + non-colour cues + legend — FC-02** [M]: raise `upcoming`/done text to ≥4.5:1; add a category **legend** to Month/Week; encode status with icon/shape too, not colour alone (8% CVD). **Accept:** contrast checker passes at 4.5:1; category readable without colour.
- **W3.2 · Roll planning surfaces forward — HD-04, HD-05** [S]: Week "Plan" panel = **next** week (not `mondayOf(asof)` which is the current/past week); Month planner = **rolling 8 weeks from today**. **Accept:** on a Friday the Plan panel is next week; no five-weeks-ago bar.
- **W3.3 · Real reporter identity — IN-09, IN-06, IN-11** [M]: capture a real reporter (`by`) at session start (shared-tablet aware); replace `prompt()` assign with the existing **manager dropdown**; per-manager export filename `task_log_<manager>.csv`. **Accept:** events signed by a real person; no free-text manager typos; two supervisors' exports don't collide.
- **W3.4 · Plain-language labels in UI + print — FC-03, IN-05** [S]: render `field_label` (F5) as the primary string, agronomic label secondary; keep the print stylesheet. Scope a Yoruba/Hausa path as a later data-only translation of `field_label`. **Accept:** supervisor-facing strings are plain; `pd`/`plan-start`/`task_log` not user-visible.
- **W3.5 · Season roll-up report — UT-04** [M]: aggregate `delta_days` into **slippage by category / manager / crop** + a season CSV export. **Accept:** "systematically ~2 weeks late on clearing" is a one-click figure.
- **W3.6 · Incident capture — UT-07** [M]: a "report incident" action on the plot/task context writing the form's `Incident` vocabulary (Fire/Flood/Pest-Disease/Theft) into the log. **Accept:** an incident can be logged from the plot the supervisor is already viewing.
- **W3.7 · Data-health repair path — FC-04** [S]: each flagged row links to the offending record, states plots/area affected, and gives the fix; render once, not per tab. **Accept:** a bad row is repairable without leaving the app to hunt the CSV.
- **W3.8 · Sticky group headers — FC-05** [S]: sticky manager/month headers + jump nav in long Month lists. **Accept:** the owning manager stays visible when scrolled.
- **W3.9 · Phone strategy decision — FC-01** [M, needs decision]: either make the planner genuinely responsive (collapse control bar, horizontal-scroll Year matrix, apply the unused `.mockup-hide`) **or** declare planner = desktop/tablet and make the **phone path = WhatsApp text (W1.3)**. **Accept:** a decision is recorded and the chosen path works at 360 px.

---

## 7. Traceability — every finding mapped
| Finding | Sev | Work item | Wave |
|---|---|---|---|
| IN-01 memory-only session | Blocker | W1.1 | 1 |
| IN-02 22px buttons | Blocker | W1.2 | 1 |
| IN-03 Done=As-of date | Blocker | W1.2 | 1 |
| IN-04 no undo/confirm | Blocker | W1.2 (+W1.1 Reset) | 1 |
| IN-05 no daily list/WhatsApp/print | Blocker | W1.3 (+W3.4 print) | 1 |
| HD-01 silence scored as failure | Blocker | W1.4 interim, **W2.2** permanent | 1→2 |
| UT-01 capacity-less manpower | Blocker | W1.5 (+F4) | 1 |
| FC-06 As-of hard-coded | — | W1.6 | 1 |
| HD-06 manager not in LOGCOLS | Moderate | F1 + W1.7 | 0/1 |
| IN-06 free-text prompt() assign | Serious | W3.3 | 3 |
| IN-07 only +7d reschedule | Serious | W2.1 | 2 |
| IN-08 no yield/crew capture | Serious | W2.4 (+F1) | 2 |
| IN-09 reporter = "planner" | Serious | W3.3 | 3 |
| IN-10 ad-hoc weak validation/hidden | Moderate | W2.6 | 2 |
| IN-11 export filename collision | Moderate | W3.3 | 3 |
| HD-02 tabs disagree (overview) | Serious | W2.9 | 2 |
| HD-03 recurring floods list | Serious | W2.3 (+F3) | 2 |
| HD-04 Plan panel is the past | Serious | W3.2 | 3 |
| HD-05 Month opens near-over month | Moderate | W3.2 | 3 |
| UT-02 no plot view | Serious | W2.5 | 2 |
| UT-03 window discarded | Serious | W2.1 (+F2) | 2 |
| UT-04 no aggregate planned-vs-actual | Serious | W3.5 | 3 |
| UT-05 hover-only drill / rounding | Serious | W2.8 | 2 |
| UT-06 missing filters / hard-coded crops | Moderate | W2.7 | 2 |
| UT-07 no incident route | Moderate | W3.6 | 3 |
| FC-01 phone layout not viable | Serious | W3.9 (decision) | 3 |
| FC-02 contrast/colour-only | Serious | W3.1 | 3 |
| FC-03 developer vocabulary | Serious | W3.4 (+F5) | 3 |
| FC-04 health reports, no repair | Moderate | W3.7 | 3 |
| FC-05 no sticky context | Moderate | W3.8 | 3 |

## 8. Decisions needed before/within the plan
1. **Phone strategy (FC-01):** responsive planner **or** desktop/tablet-planner + WhatsApp-as-phone-path? Changes W1.3 and W3.9 scope. *Recommend the latter — cheaper, matches the field reality the audit describes.*
2. **Crew numbers (UT-01/F4):** source of `crew_size` per manager — a config file we maintain, or a value the manager sets in-app? *Recommend the config CSV now, in-app editing later.*
3. **Yoruba/Hausa (FC-03):** in scope as a data-only translation of `field_label`, or English-only for v1 with the hook in place? *Recommend hook now, translation later.*
4. **Capture fields (IN-08):** confirm the units per crop with the farm manager (FFB tonnage, cassava kg/bags, tomato crates) before W2.4.

## 9. Suggested calendar
- **Week 1:** Wave 0 (1.5 d) → Wave 1 (rest of week). Ship: no data loss, honest Week Review, real completion dates, 44 px controls, WhatsApp daily list, capacity line. *This alone makes it a field tool.*
- **Weeks 2–3:** Wave 2 — auto-match, window rendering, recurring collapse, capture, plot filter. *Closes the double-entry loop and the plot-centric gap.*
- **Weeks 4–5:** Wave 3 — contrast, forward-roll, identity, language, season report, incidents. *Reach and durability.*

*Every item preserves the six verified strengths in §1. The engine is not being rebuilt — this plan is almost entirely the thin layer between it and the phone.*
