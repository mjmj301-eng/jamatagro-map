/*
 * JamatAgro Farm Calendar — Generation Engine (Slice 1)
 * Spec: JamatAgro Farm Calendar v2.0 · Terminology aligned to Master Plot Register + Activity Log.
 *
 * Pure, dependency-free. Tasks are COMPUTED from templates x cycles at call time;
 * only exceptions live in the append-only task log. The engine takes already-parsed
 * data (arrays/objects) and returns generated occurrences + a validation report.
 *
 * Public API:
 *   JamatCal.generate({ templates, cycles, taskLog, plots, today }) -> { today, occurrences, validation }
 *   JamatCal.csvParse(text) -> array of row objects   (convenience for the demo harness)
 *   JamatCal.parseVintageYear(str) -> int|null        (handles "2026 batch-2", "2013 & 2017", blanks)
 *
 * Guarantees encoded here:
 *   (1) Stable occurrence identity: occurrences are keyed on (cycle_id, task_code, occurrence_index),
 *       never on a date, so a completion survives an anchor re-base or a shift.
 *   (2) No historical flood: occurrences before cycle.plan_start_date are never emitted.
 */
var JamatCal = (function () {
  'use strict';

  // ---------- date helpers (UTC, date-only) ----------
  function parseDate(s) {
    if (!s) return null;
    var p = String(s).slice(0, 10).split('-');
    if (p.length < 3) return null;
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
  function diffDays(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }

  // ---------- misc ----------
  function parseVintageYear(v) { var m = String(v == null ? '' : v).match(/\d{4}/); return m ? +m[0] : null; }

  // minimal CSV parser (quoted fields, commas, CRLF) — the live app uses PapaParse;
  // this exists so the engine is self-contained for testing/demo.
  function csvParse(text) {
    var rows = [], row = [], field = '', i = 0, inQ = false, c;
    text = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    var head = rows.shift().map(function (h) { return h.trim(); });
    return rows.filter(function (r) { return r.some(function (x) { return x !== ''; }); })
      .map(function (r) { var o = {}; head.forEach(function (h, j) { o[h] = (r[j] == null ? '' : r[j]).trim(); }); return o; });
  }

  // ---------- template index ----------
  function indexTemplates(templates) {
    var byKey = {};
    (templates || []).forEach(function (t) { byKey[t.template_id + '@' + t.version] = t; });
    return byKey;
  }

  // ---------- phase inference (age in days from primary anchor) ----------
  function inferPhase(template, ageDays, override) {
    if (override) return override;
    for (var k = 0; k < template.phases.length; k++) {
      var ph = template.phases[k];
      var lo = ph.entry ? ph.entry.offset_days : -Infinity;
      var hi = ph.exit ? ph.exit.offset_days : Infinity;
      if (ageDays >= lo && ageDays < hi) return ph.phase_id;
    }
    var last = template.phases[template.phases.length - 1];
    if (last && !last.exit && ageDays >= (last.entry ? last.entry.offset_days : 0)) return last.phase_id;
    return null;
  }

  // ---------- append-only log -> effective state per occurrence ----------
  function effectiveEvents(taskLog) {
    var map = {};
    (taskLog || []).forEach(function (e) {
      var key = e.cycle_id + '|' + e.task_code + '|' + e.occurrence_index;
      if (!map[key] || String(e.event_ts) > String(map[key].event_ts)) map[key] = e;
    });
    return map;
  }

  // ---------- validation (file-based FK enforcement) ----------
  function validateCycle(c, byKey, plotSet) {
    var errs = [];
    if (plotSet && !plotSet.has(String(c.plot_no))) errs.push('plot_no ' + c.plot_no + ' not found in register/geometry');
    var tk = (c.template_version && c.template_version.indexOf('@') >= 0) ? c.template_version : null;
    if (!tk || !byKey[tk]) {
      errs.push('template_version "' + c.template_version + '" not found');
    } else {
      var t = byKey[tk];
      if (c.crop && t.maps_to_current_use && c.crop !== t.maps_to_current_use)
        errs.push('crop "' + c.crop + '" != template current_use "' + t.maps_to_current_use + '"');
      if (c.anchor_type && t.anchors.indexOf(c.anchor_type) < 0)
        errs.push('anchor_type "' + c.anchor_type + '" not one of template anchors [' + t.anchors.join(', ') + ']');
    }
    if (!parseDate(c.anchor_date)) errs.push('anchor_date "' + c.anchor_date + '" invalid');
    return errs;
  }

  // ---------- anchor resolution (incl. sets_anchor re-base) ----------
  function resolveAnchors(cycle, template, eff) {
    var anchors = {};
    anchors[cycle.anchor_type] = { date: parseDate(cycle.anchor_date), status: cycle.anchor_status || 'planned' };
    template.tasks.forEach(function (t) {
      if (!t.sets_anchor) return;
      for (var key in eff) {
        var e = eff[key];
        if (e.cycle_id === cycle.cycle_id && e.task_code === t.task_code && e.action === 'done' && e.done_date) {
          anchors[t.sets_anchor] = { date: parseDate(e.done_date), status: 'actual', source: e.entry_id };
        }
      }
    });
    return anchors;
  }

  // ---------- task expansion (Slice 1: offset; recurring/seasonal/window are hooks) ----------
  function expandTask(task, anchors, planStart) {
    var out = [], a = anchors[task.anchor];
    if (!a || !a.date) return out;
    if (task.type === 'offset') {
      out.push({ occurrence_index: 0, date: addDays(a.date, task.offset_days || 0) });
    } else if (task.type === 'recurring' || task.type === 'seasonal' || task.type === 'window') {
      // Sprint 3-4: implement interval / month-anchored / date-band expansion here.
      // occurrence_index must remain the deterministic chronological ordinal.
      return out;
    }
    return out.filter(function (o) { return !planStart || o.date.getTime() >= planStart.getTime(); });
  }

  // ---------- main ----------
  function generate(opts) {
    opts = opts || {};
    var today = opts.today ? parseDate(opts.today) : parseDate(iso(new Date()));
    var byKey = indexTemplates(opts.templates);
    var plotSet = opts.plots ? new Set(opts.plots.map(String)) : null;
    var eff = effectiveEvents(opts.taskLog || []);
    var validation = [], occurrences = [];

    (opts.cycles || []).forEach(function (c) {
      var errs = validateCycle(c, byKey, plotSet);
      if (errs.length) { validation.push({ cycle_id: c.cycle_id, plot_no: c.plot_no, errors: errs }); return; }
      if (['planned', 'active'].indexOf(c.status) < 0) return;

      var t = byKey[c.template_version];
      var anchors = resolveAnchors(c, t, eff);
      var primary = anchors[c.anchor_type];
      var ageDays = diffDays(today, primary.date);
      var phase = inferPhase(t, ageDays, c.phase_override || '');
      var planStart = parseDate(c.plan_start_date) || primary.date;

      t.tasks.forEach(function (task) {
        if (task.phase && task.phase !== phase) return;
        expandTask(task, anchors, planStart).forEach(function (o) {
          var key = c.cycle_id + '|' + task.task_code + '|' + o.occurrence_index;
          var e = eff[key];
          var sched = o.date, status, done_date = null, delta = null;

          if (e && e.action === 'skipped') { status = 'skipped'; }
          else if (e && e.action === 'done') {
            status = 'done';
            done_date = parseDate(e.done_date);
            if (done_date) delta = diffDays(done_date, o.date);
          } else {
            if (e && e.action === 'shifted' && e.new_date) { var nd = parseDate(e.new_date); if (nd) sched = nd; }
            if (sched.getTime() < today.getTime()) status = 'overdue';
            else if (diffDays(sched, today) <= 7) status = 'due_soon';
            else status = 'upcoming';
          }

          occurrences.push({
            cycle_id: c.cycle_id, plot_no: c.plot_no, crop: c.crop, manager: c.manager || '(unassigned)',
            phase: phase, task_code: task.task_code, label: task.label, category: task.category,
            activity_detail: task.activity_detail || '', occurrence_index: o.occurrence_index,
            planned_date: iso(o.date), scheduled_date: iso(sched), window_days: task.window_days || 0,
            inputs: task.inputs || '', critical: !!task.critical, status: status,
            done_date: done_date ? iso(done_date) : '', delta_days: delta,
            anchor_status: primary.status, area_ha: c.area_ha || ''
          });
        });
      });
    });

    occurrences.sort(function (a, b) {
      return a.scheduled_date < b.scheduled_date ? -1 : a.scheduled_date > b.scheduled_date ? 1 : 0;
    });
    return { today: iso(today), occurrences: occurrences, validation: validation };
  }

  return {
    parseDate: parseDate, iso: iso, addDays: addDays, diffDays: diffDays,
    csvParse: csvParse, parseVintageYear: parseVintageYear,
    inferPhase: inferPhase, generate: generate
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = JamatCal;
