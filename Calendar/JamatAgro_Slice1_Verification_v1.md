# JamatAgro Farm Calendar — Slice 1 Verification Memo
**Scope:** Slice 1 (oil-palm establishment) per spec v2.0 §11 · **Date:** 27 July 2026 · **Status:** PASS
**Artifacts under test (in `JAMATAGRO/Calendar/`):** `JamatAgro_CropTemplates_v1.json`, `JamatAgro_CropCycles_v1.csv`, `JamatAgro_TaskLog_v1.csv`, `JamatAgro_CalendarEngine_v1.js`, `JamatAgro_CalendarDemo_v1.html`.
**Method:** Node harness driving the shipped engine against the sample data with the register's real 98 `plot_no` values as the validation set; headless DOM stub driving the demo's own render path. Fixed clock (`today`) supplied per test.

---

## 1. Result summary
Every Slice-1 P0 acceptance criterion that applies to the built scope passed. The two structural guarantees that cannot be deferred — stable occurrence identity under re-base, and no historical flood on onboarding — are demonstrated with assertions, not inspection.

| # | Acceptance criterion (spec §9) | Result | Evidence |
|---|---|---|---|
| P0-1 | Template renders correct plans with no crop-specific code; swapping an agronomic value changes output, not code | **PASS** | 3 establishment cycles → 18 occurrences purely from template data; all timings are offsets in JSON. |
| P0-2a | **Stable occurrence identity:** a completion survives a `sets_anchor` re-base | **PASS** | Test 2 — `land_clear_prep` completion intact after `transplant` re-based `field_planting`. |
| P0-2b | **Append-only merge** is lossless/order-independent | **PASS (design + unit)** | Effective-state resolves by latest `event_ts` per `(cycle_id, task_code, occurrence_index)`; keyed union has no in-place edits. |
| P0-3 | File round-trip (load → append events → export → reload) preserves state | **PASS** | Demo exports `task_log.csv` = base + session events; re-parse reproduces identical effective state. |
| P0-4 | Load-time validation flags bad rows with a reason; never crashes generation | **PASS** | Test 3 — bad row flagged with both reasons and excluded; other cycles unaffected. |
| P0-5 | **No historical flood:** onboarded old block → correct phase, forward-only plan | **PASS** | Test 1 — 2018 block (age 3,024 d) → `mature`, **0** occurrences. |
| P0-9 | WhatsApp text export per §8 contract | **PASS** | Demo emits per-manager/per-plot plain text, ‼ on critical. |

Out of Slice-1 scope (Sprint 3–4+): recurring/seasonal/window task types, V1/V2/V4 views, activity auto-match execution (vocabulary now resolved, see §4 below).

---

## 2. Guarantee 1 — stable occurrence identity under re-base (P0-2a)
**Setup:** cycle `CYC-2026-014` (plot 35), planting anchor `2026-09-01`. Baseline downstream dates: transplant `09-01`, cover_crop `09-15`, beat_up `10-31`. Then a `done` event for `transplant` with `done_date = 2026-09-10` (9 days late) is appended; `transplant` carries `sets_anchor: field_planting`, so the actual planting anchor re-bases to `09-10`.

**Observed after re-base (clock = 2026-09-30):**
```
transplant -> 2026-09-10 (done)
cover_crop -> 2026-09-24   (= 09-10 + 14)   expected 2026-09-24  PASS
beat_up    -> 2026-11-09   (= 09-10 + 60)   expected 2026-11-09  PASS
land_clear_prep completion SURVIVED re-base: status=done, done=2026-07-19
```
**Conclusion:** downstream schedules moved with the actual anchor while the pre-existing completion stayed attached — because the log keys on `occurrence_index`, not on the (now-moved) date. The v1.0 spec's date-keyed design would have orphaned the clearing completion here.

## 3. Guarantee 2 — no historical flood on onboarding (P0-5)
**Setup:** `CYC-ONB-001`, plot 1, onboarded from vintage 2018 with `anchor_date = 2018-04-15`, `plan_start_date = 2026-07-26` (load date), no `phase_override`.
**Observed (clock = 2026-07-26):** phase inferred = `mature` (age 3,024 days); **occurrences generated = 0**. The 2024 immature block likewise generates 0 in Slice 1. New 2026 blocks are unaffected and generate their full 6-task chain.
**Conclusion:** both mechanisms hold — the phase gate (establishment tasks don't apply to a mature block) and the `plan_start_date` lower bound (no pre-load occurrences). A decade-old block onboards clean.

## 4. Validation & data-health (P0-4)
The intentionally bad row `CYC-2026-099` (plot `999`, template `oil_palm@2.0`) is reported as:
```
✗ CYC-2026-099 (plot 999): plot_no 999 not found in register/geometry ;
                           template_version "oil_palm@2.0" not found
```
It is excluded from generation; the five valid cycles are unaffected. The demo surfaces this in a "Data health" panel rather than failing silently.

## 5. Planned-vs-actual (free by-product)
The seed completion of `land_clear_prep` (planned `2026-07-03`, done `2026-07-19`) yields `status=done, delta_days=+16` with no extra data entry — confirming the P1 planned-vs-actual delta falls out of the same mechanism.

## 6. Terminology conformance
Generated records key on integer `plot_no`, carry `crop = "Oil palm"` (matching the register's `current_use`), real managers (`Dr Iginla`, `Mr Hassan`), and an `activity_detail` per task drawn from the field form's dropdown (`Clearing`, `Planting`, `Other`). This closes former Open Question #1 (auto-match vocabulary): the mapping target is the existing form value, so no new vocabulary is introduced. Ref: `JamatAgro_TerminologyAlignment_v1.md`.

## 7. Known limitations / follow-ups
1. **Only `offset` tasks are implemented.** `recurring` / `seasonal` / `window` are stubbed hooks (return empty) — Sprint 3–4. `occurrence_index` numbering for those must remain the deterministic chronological ordinal to preserve Guarantee 1.
2. **`plan_start_date` default rule** needs the spec amendment agreed during the build: new cycles should default to `anchor_date + earliest task offset` (or today, whichever is earlier), not bare `anchor_date`, so negative-offset prep tasks are not dropped. The sample data already uses the corrected value.
3. **Vintage parsing at onboarding.** `parseVintageYear()` takes the first 4-digit year; `2013 & 2017` (mixed-age) and blank vintages need manual review before bulk onboarding — flagged in the alignment doc.
4. **Append-only merge** is verified at unit level; a multi-file merge tool (union + de-dupe by `entry_id`) is the operational deliverable when more than one supervisor exports.
5. **Browser copy-to-clipboard** in the demo uses `execCommand` fallback; on `file://` some browsers restrict `navigator.clipboard` — cosmetic only.

## 8. Verdict
Slice 1 meets its acceptance bar and is safe to wire into the map viewer. The two decisions that would have been expensive to retrofit — occurrence identity and generation bounds — are implemented and proven, so extending to the remaining task types and views is additive, not structural.
