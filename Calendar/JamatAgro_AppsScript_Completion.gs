/* =====================================================================
 * JamatAgro — Task-completion write-back  (Google Apps Script)
 * ---------------------------------------------------------------------
 * Turns a "task done" report into a proper row in the Task-log sheet,
 * resolving WHICH task it closes with the same engine the apps use.
 *
 * Two entry points, one append path:
 *   1) Completion Google Form  -> onFormSubmit()  (field staff, no app)
 *   2) Web App endpoint doPost() -> planner can POST its check-offs (no export)
 *
 * Setup: see JamatAgro_Automation_Setup_v1.md
 *   - paste this whole file into script.google.com (V8 runtime)
 *   - fill CONFIG below
 *   - run createCompletionForm() once (authorise when asked)
 *   - Deploy > New deployment > Web app (Execute as: Me, Access: Anyone)
 * ===================================================================== */

var CONFIG = {
  TASKLOG_SHEET_ID:  'PUT_TASKLOG_SPREADSHEET_ID_HERE',   // Task-log spreadsheet  (…/spreadsheets/d/<ID>/edit)
  TASKLOG_TAB:       'task_log',                          // tab name inside it
  CYCLES_SHEET_ID:   'PUT_CYCLES_SPREADSHEET_ID_HERE',    // Crop-cycles spreadsheet
  CYCLES_TAB:        'crop_cycles',
  TEMPLATES_URL:     'https://mjmj301-eng.github.io/jamatagro-map/Calendar/JamatAgro_CropTemplates_v3.json',
  MATCH_TOLERANCE_DAYS: 5,        // Form completion: a report within N days of the planned date matches that task
  SHARED_SECRET:     '',          // optional token required on doPost (leave blank = open). If set, planner must send it.

  // ----- #2 scheduled auto-close (reads the Activity/Form-responses sheet) -----
  ACTIVITY_SHEET_ID: 'PUT_ACTIVITY_SPREADSHEET_ID_HERE',  // the Activity Log spreadsheet (Form responses)
  ACTIVITY_TAB:      'Form Responses 1',
  AUTOCLOSE_TOLERANCE_DAYS: 3,    // stricter than the Form path — only close when the date is a tight fit
  AUTOCLOSE_LOOKBACK_DAYS:  21,   // only consider activity rows from the last N days

  // ----- #4 WhatsApp daily send -----
  DAILY_HOUR:        6,           // hour (0-23) to send the daily lists
  COORDINATOR_EMAIL: '',         // default mode: emailed a digest with one-tap WhatsApp links (leave blank to disable email mode)
  RECIPIENTS_SHEET_ID: '',       // optional private sheet of manager phones (KEEP OUT OF THE PUBLIC REPO)
  RECIPIENTS_TAB:    'recipients',   // columns: manager, phone (E.164 digits e.g. 2348…), email
  RECIPIENTS:        [],         // fallback list if no sheet, e.g. [{manager:'Dr Iginla', phone:'234…'}]
  WA_CLOUD: { enabled:false, phone_id:'', token:'', template:'' }  // optional full-auto via WhatsApp Business Cloud API (1:1, needs approved template for proactive sends)
};

// Task-log columns — MUST match the sheet header and the apps' schema exactly.
var LOGCOLS = ["entry_id","event_ts","cycle_id","task_code","occurrence_index","scheduled_date","action","new_date","done_date","anchor_name","by","source_entry_id","manager","adhoc_plot_no","adhoc_label","adhoc_category","adhoc_manager","adhoc_labour_days","crew_size","qty","qty_unit","note","notes"];
// Activity dropdown = the field form's Detail vocabulary.
var DETAILS = ["Weeding","Planting","Harvest","Clearing","Fertiliser/Spraying","Pruning","Other"];

/* ---------- sheet helpers ---------- */
function sheet_(id, tab){ var ss=SpreadsheetApp.openById(id); var sh=ss.getSheetByName(tab); if(!sh) sh=ss.insertSheet(tab); return sh; }
function ensureHeader_(sh, cols){ var last=sh.getLastRow(); if(last<1){ sh.getRange(1,1,1,cols.length).setValues([cols]); return; } var r=sh.getRange(1,1,1,cols.length).getValues()[0]; var empty=r.every(function(x){return x===''||x==null;}); if(empty) sh.getRange(1,1,1,cols.length).setValues([cols]); }
function readObjects_(sh){ var vals=sh.getDataRange().getValues(); if(!vals.length) return {head:[],rows:[]}; var head=vals[0].map(function(h){return String(h).trim();}); var rows=[]; for(var i=1;i<vals.length;i++){ var o={}; head.forEach(function(h,j){ o[h]=vals[i][j]==null?'':String(vals[i][j]); }); rows.push(o); } return {head:head, rows:rows}; }
function existingIds_(sh){ var s={}; readObjects_(sh).rows.forEach(function(r){ if(r.entry_id) s[r.entry_id]=true; }); return s; }
function rowFromEvent_(ev){ return LOGCOLS.map(function(c){ return ev[c]==null?'':ev[c]; }); }
function nowIso_(){ return Utilities.formatDate(new Date(),'Etc/UTC',"yyyy-MM-dd'T'HH:mm:ss"); }
function uid_(p){ return (p||'S')+'-'+Date.now()+'-'+Math.floor(Math.random()*99999); }

/* Append events to the Task-log sheet. Append-only + idempotent (dedupe by entry_id). */
function appendEvents_(events){
  var sh=sheet_(CONFIG.TASKLOG_SHEET_ID, CONFIG.TASKLOG_TAB); ensureHeader_(sh, LOGCOLS);
  var have=existingIds_(sh); var toWrite=[]; var n=0;
  (events||[]).forEach(function(ev){
    if(!ev.entry_id) ev.entry_id=uid_('S');
    if(!ev.event_ts) ev.event_ts=nowIso_();
    if(have[ev.entry_id]) return;                 // skip duplicates so re-sync is safe
    have[ev.entry_id]=true; toWrite.push(rowFromEvent_(ev)); n++;
  });
  if(toWrite.length) sh.getRange(sh.getLastRow()+1,1,toWrite.length,LOGCOLS.length).setValues(toWrite);
  return n;
}

/* ============ shared engine (JamatCal v4, verbatim — runs in Apps Script V8) ============ */
/*
 * JamatAgro Farm Calendar — Generation Engine v2
 * Adds recurring / seasonal / window task types, labour effort, date-range generation,
 * provisional second anchors, ad-hoc planned activities, and manager re-assignment —
 * while preserving the v1 guarantees (stable occurrence_index; plan_start_date bound).
 *
 * generate({ templates, cycles, taskLog, plots, plotUse, today, rangeStart, rangeEnd })
 *   -> { today, rangeStart, rangeEnd, occurrences, validation }
 *
 * occurrence_index is computed from each task's intrinsic origin (NOT the view range),
 * so it is stable no matter which window you render — completions never re-key.
 */
var JamatCal = (function () {
  'use strict';

  function parseDate(s){ if(!s) return null; var p=String(s).slice(0,10).split('-'); if(p.length<3) return null; var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); return isNaN(d.getTime())?null:d; }
  function iso(d){ return d.toISOString().slice(0,10); }
  function addDays(d,n){ var x=new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }
  function diffDays(a,b){ return Math.round((a.getTime()-b.getTime())/86400000); }
  function ymd(y,m,day){ return new Date(Date.UTC(y,m-1,day||1)); }
  function parseVintageYear(v){ var m=String(v==null?'':v).match(/\d{4}/); return m?+m[0]:null; }

  function csvParse(text){ var rows=[],row=[],field='',i=0,inQ=false,c; text=String(text).replace(/\r\n/g,'\n').replace(/\r/g,'\n');
    for(i=0;i<text.length;i++){ c=text[i];
      if(inQ){ if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else inQ=false; } else field+=c; }
      else if(c==='"') inQ=true; else if(c===','){ row.push(field); field=''; }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; } else field+=c; }
    if(field.length||row.length){ row.push(field); rows.push(row); } if(!rows.length) return [];
    var head=rows.shift().map(function(h){return h.trim();});
    return rows.filter(function(r){return r.some(function(x){return x!=='';});})
      .map(function(r){ var o={}; head.forEach(function(h,j){ o[h]=(r[j]==null?'':r[j]).trim(); }); return o; }); }

  function indexTemplates(t){ var b={}; (t||[]).forEach(function(x){ b[x.template_id+'@'+x.version]=x; }); return b; }

  function inferPhase(tp, age, ov){ if(ov) return ov;
    for(var k=0;k<tp.phases.length;k++){ var ph=tp.phases[k]; var lo=ph.entry?ph.entry.offset_days:-Infinity; var hi=ph.exit?ph.exit.offset_days:Infinity; if(age>=lo && age<hi) return ph.phase_id; }
    var last=tp.phases[tp.phases.length-1]; if(last && !last.exit && age>=(last.entry?last.entry.offset_days:0)) return last.phase_id; return null; }

  function effectiveEvents(log){ var m={}; (log||[]).forEach(function(e){ if(e.action==='adhoc_created'||e.action==='assigned') return; var k=e.cycle_id+'|'+e.task_code+'|'+e.occurrence_index; if(!m[k]||String(e.event_ts)>String(m[k].event_ts)) m[k]=e; }); return m; }
  // assignment is a distinct event so it never overwrites a done/shifted status
  function assignments(log){ var m={}; (log||[]).forEach(function(e){ if(e.action!=='assigned') return; var k=e.cycle_id+'|'+e.task_code+'|'+e.occurrence_index; if(!m[k]||String(e.event_ts)>String(m[k].event_ts)) m[k]=e.manager||e.adhoc_manager||''; }); return m; }

  function validateCycle(c, byKey, plotSet, plotUse){ var errs=[];
    if(plotSet && !plotSet.has(String(c.plot_no))) errs.push('plot_no '+c.plot_no+' not found in register/geometry');
    var tk=(c.template_version && c.template_version.indexOf('@')>=0)?c.template_version:null;
    if(!tk || !byKey[tk]){ errs.push('template_version "'+c.template_version+'" not found'); }
    else { var t=byKey[tk];
      if(c.crop && t.crop_name && c.crop!==t.crop_name) errs.push('crop "'+c.crop+'" != template crop "'+t.crop_name+'"');
      if(plotUse && plotUse[c.plot_no] && t.maps_to_current_use && plotUse[c.plot_no]!==t.maps_to_current_use)
        errs.push('plot land-use "'+plotUse[c.plot_no]+'" incompatible with template use "'+t.maps_to_current_use+'"');
      if(c.anchor_type && t.anchors.indexOf(c.anchor_type)<0) errs.push('anchor_type "'+c.anchor_type+'" not in template anchors');
    }
    if(!parseDate(c.anchor_date)) errs.push('anchor_date "'+c.anchor_date+'" invalid');
    return errs; }

  // resolve primary + sets_anchor (actual) + provisional second anchors
  function resolveAnchors(cycle, tp, eff){ var a={};
    a[cycle.anchor_type]={date:parseDate(cycle.anchor_date), status:cycle.anchor_status||'planned'};
    tp.tasks.forEach(function(t){ if(!t.sets_anchor) return;
      for(var k in eff){ var e=eff[k]; if(e.cycle_id===cycle.cycle_id && e.task_code===t.task_code && e.action==='done' && e.done_date){ a[t.sets_anchor]={date:parseDate(e.done_date), status:'actual', source:e.entry_id}; } } });
    // provisional for any declared anchor still unresolved
    (tp.anchors||[]).forEach(function(an){ if(a[an]) return;
      var setter=tp.tasks.filter(function(t){return t.sets_anchor===an;})[0];
      if(setter && a[setter.anchor] && a[setter.anchor].date){ a[an]={date:addDays(a[setter.anchor].date, setter.offset_days||0), status:'provisional'}; } });
    return a; }

  function labourFor(task, area){ var A=parseFloat(area); if(!isNaN(A) && task.labour_per_ha!=null) return Math.round(A*task.labour_per_ha*10)/10; if(task.labour_days!=null) return task.labour_days; return null; }

  // expand one task to occurrences [{occurrence_index, date, end_date?}] up to rangeEnd.
  // primaryDate = the cycle's primary-anchor date (used as the base year for seasonal tasks,
  // which are month-anchored and carry no `anchor` field).
  function expandTask(task, anchors, primaryDate, rangeEnd){ var out=[], CAP=6000;
    if(task.type==='seasonal'){ var baseY=primaryDate.getUTCFullYear(); var months=(task.months||[]).slice(); var endY=rangeEnd.getUTCFullYear();
      for(var Y=baseY; Y<=endY; Y++){ for(var mi=0; mi<months.length; mi++){ var d2=ymd(Y, months[mi], task.day||1); if(d2.getTime()>rangeEnd.getTime()) continue; out.push({occurrence_index:(Y-baseY)*months.length+mi, date:d2}); } }
      return out; }
    var a=anchors[task.anchor]; if(!a||!a.date) return out;
    if(task.type==='offset'){ out.push({occurrence_index:0, date:addDays(a.date, task.offset_days||0)}); }
    else if(task.type==='window'){ out.push({occurrence_index:0, date:addDays(a.date, task.start_offset_days||0), end_date:addDays(a.date, task.end_offset_days||0)}); }
    else if(task.type==='recurring'){ var first=addDays(a.date, task.active_from_days||0); var last=(task.active_to_days!=null)?addDays(a.date, task.active_to_days):rangeEnd;
      var k=0, d=first; while(d.getTime()<=last.getTime() && d.getTime()<=rangeEnd.getTime() && k<CAP){ out.push({occurrence_index:k, date:d}); k++; d=addDays(first, k*(task.interval_days||1)); } }
    return out; }

  // v3 status model — separates "not reported" (silence) from "overdue" (genuinely late),
  // and treats a task still inside its tolerance window as on-time.
  //   windowEnd = end_date (window tasks) OR planned + window_days.
  function classify(sched, windowEnd, today, critical){
    if(today.getTime() < sched.getTime()) return diffDays(sched,today)<=7 ? 'due_soon' : 'upcoming';
    if(today.getTime() <= windowEnd.getTime()) return 'in_window';   // past nominal date but still inside tolerance
    return critical ? 'overdue' : 'not_reported';                    // past tolerance, no event
  }

  function generate(opts){ opts=opts||{};
    var today=opts.today?parseDate(opts.today):parseDate(iso(new Date()));
    var byKey=indexTemplates(opts.templates);
    var plotSet=opts.plots?new Set(opts.plots.map(String)):null;
    var plotUse=opts.plotUse||null;
    var eff=effectiveEvents(opts.taskLog||[]);
    var asg=assignments(opts.taskLog||[]);
    var rangeEnd=opts.rangeEnd?parseDate(opts.rangeEnd):addDays(today,420);
    var rangeStartOpt=opts.rangeStart?parseDate(opts.rangeStart):null;
    var validation=[], occ=[];

    (opts.cycles||[]).forEach(function(c){
      var errs=validateCycle(c, byKey, plotSet, plotUse);
      if(errs.length){ validation.push({cycle_id:c.cycle_id, plot_no:c.plot_no, errors:errs}); return; }
      if(['planned','active'].indexOf(c.status)<0) return;
      var t=byKey[c.template_version];
      var anchors=resolveAnchors(c, t, eff);
      var primary=anchors[c.anchor_type]; if(!primary||!primary.date) return;
      var planStart=parseDate(c.plan_start_date)||primary.date;
      // no-flood lower bound; overview mode (year view) bypasses plan_start but is still
      // bounded to the requested range, so at most one screen's worth of history appears.
      var lowBound = opts.ignorePlanStart ? (rangeStartOpt||planStart)
        : (rangeStartOpt && rangeStartOpt.getTime()>planStart.getTime() ? rangeStartOpt : planStart);

      t.tasks.forEach(function(task){
        expandTask(task, anchors, primary.date, rangeEnd).forEach(function(o){
          // no-flood + range filters (index already assigned from intrinsic origin -> stable)
          if(o.date.getTime()<lowBound.getTime()) return;
          if(o.date.getTime()>rangeEnd.getTime()) return;
          // phase gate evaluated at the OCCURRENCE date (handles multi-year perennials)
          if(task.phase){ var ageAt=diffDays(o.date, primary.date); if(inferPhase(t, ageAt, c.phase_override||'')!==task.phase) return; }
          var key=c.cycle_id+'|'+task.task_code+'|'+o.occurrence_index;
          var e=eff[key]; var sched=o.date, status, dd=null, delta=null;
          var mgr=asg[key]||c.manager||'(unassigned)';
          if(e && e.action==='skipped'){ status='skipped'; }
          else if(e && e.action==='done'){ status='done'; dd=parseDate(e.done_date); if(dd) delta=diffDays(dd,o.date); }
          else {
            if(e && e.action==='shifted' && e.new_date){ var nd=parseDate(e.new_date); if(nd) sched=nd; }
            var winEnd = o.end_date ? o.end_date : addDays(sched, task.window_days||0);
            status=classify(sched, winEnd, today, !!task.critical);
          }
          var winEndOut = o.end_date ? o.end_date : addDays(sched, task.window_days||0);
          occ.push({ cycle_id:c.cycle_id, plot_no:c.plot_no, crop:c.crop, manager:mgr, field_label:task.field_label||'', phase:task.phase||inferPhase(t, diffDays(o.date,primary.date), c.phase_override||''),
            task_code:task.task_code, label:task.label, category:task.category, activity_detail:task.activity_detail||'', type:task.type,
            occurrence_index:o.occurrence_index, planned_date:iso(o.date), scheduled_date:iso(sched), end_date:o.end_date?iso(o.end_date):'', window_end:iso(winEndOut),
            window_days:task.window_days||0, inputs:task.inputs||'', labour_days:labourFor(task, c.area_ha), critical:!!task.critical,
            status:status, done_date:dd?iso(dd):'', delta_days:delta, anchor_status:primary.status, area_ha:c.area_ha||'', adhoc:false,
            pattern:(opts.ignorePlanStart && o.date.getTime()<planStart.getTime()) });
        });
      });
    });

    // ad-hoc planned activities (rows with action 'adhoc_created')
    (opts.taskLog||[]).forEach(function(e){ if(e.action!=='adhoc_created') return;
      var d=parseDate(e.new_date)||parseDate(e.scheduled_date); if(!d) return;
      if(rangeStartOpt && d.getTime()<rangeStartOpt.getTime()) return; if(d.getTime()>rangeEnd.getTime()) return;
      var key=(e.cycle_id||'FARM')+'|'+e.entry_id+'|0'; var ov=eff[key]; var status, dd=null, sched=d;
      if(ov && ov.action==='skipped') status='skipped'; else if(ov && ov.action==='done'){ status='done'; dd=parseDate(ov.done_date); }
      else { if(ov && ov.action==='shifted' && ov.new_date){ var nd=parseDate(ov.new_date); if(nd) sched=nd; } status=classify(sched, sched, today, false); }
      occ.push({ cycle_id:e.cycle_id||'', plot_no:e.adhoc_plot_no||'', crop:'(ad-hoc)', field_label:e.adhoc_label||'', manager:asg[key]||e.adhoc_manager||'(unassigned)',
        phase:'', task_code:e.entry_id, label:e.adhoc_label||e.notes||'Ad-hoc task', category:e.adhoc_category||'other', activity_detail:'', type:'adhoc',
        occurrence_index:0, planned_date:iso(d), scheduled_date:iso(sched), end_date:'', window_days:0, inputs:'', labour_days:(e.adhoc_labour_days!=null&&e.adhoc_labour_days!=='')?+e.adhoc_labour_days:null,
        critical:false, status:status, done_date:dd?iso(dd):'', delta_days:null, anchor_status:'planned', area_ha:'', adhoc:true });
    });

    // recurring-run grouping (stable within the returned range) so the UI can collapse a run
    var runs={};
    occ.forEach(function(o){ if(o.type!=='recurring')return; var rid=o.cycle_id+'|'+o.task_code; (runs[rid]=runs[rid]||[]).push(o); });
    Object.keys(runs).forEach(function(rid){ var arr=runs[rid].sort(function(a,b){return a.scheduled_date<b.scheduled_date?-1:1;}); arr.forEach(function(o,i){ o.run_id=rid; o.run_index=i; o.run_total=arr.length; }); });

    occ.sort(function(a,b){ return a.scheduled_date<b.scheduled_date?-1:a.scheduled_date>b.scheduled_date?1:0; });
    return { today:iso(today), rangeStart:rangeStartOpt?iso(rangeStartOpt):'', rangeEnd:iso(rangeEnd), occurrences:occ, validation:validation };
  }

  // Suggested completions from the existing activity log (spec P0-7). Matches open occurrences on
  // plot_no + activity_detail + date within tolerance; nearest-date tie-break; multi-cycle -> ambiguous.
  function autoMatch(activity, occurrences, tolDays){
    tolDays = (tolDays==null)?5:tolDays;
    var open = (occurrences||[]).filter(function(o){ return o.status!=='done' && o.status!=='skipped' && !o.adhoc; });
    var sug=[];
    (activity||[]).forEach(function(a,ai){
      var type=String(a.type||'').toLowerCase(); if(type.indexOf('incident')>=0) return;
      var detail=String(a.detail||'').trim().toLowerCase(); var ad=parseDate(a.date); if(!detail||!ad) return;
      var plot=String(a.plot_no);
      var cand=open.filter(function(o){ return String(o.plot_no)===plot && String(o.activity_detail||'').toLowerCase()===detail && Math.abs(diffDays(parseDate(o.scheduled_date),ad))<=tolDays; });
      if(!cand.length) return;
      cand.sort(function(x,y){ return Math.abs(diffDays(parseDate(x.scheduled_date),ad))-Math.abs(diffDays(parseDate(y.scheduled_date),ad)); });
      var cycles={}; cand.forEach(function(o){ cycles[o.cycle_id]=1; });
      var ambiguous=Object.keys(cycles).length>1;
      sug.push({ activity_index:ai, date:a.date, by:a.by||'', detail:a.detail, plot_no:a.plot_no, ambiguous:ambiguous, candidates:cand, chosen: ambiguous?null:cand[0] });
    });
    return sug;
  }

  return { parseDate:parseDate, iso:iso, addDays:addDays, diffDays:diffDays, csvParse:csvParse, parseVintageYear:parseVintageYear, inferPhase:inferPhase, generate:generate, autoMatch:autoMatch };
})();

/* ---------- data the matcher needs ---------- */
function fetchTemplates_(){ try{ var t=UrlFetchApp.fetch(CONFIG.TEMPLATES_URL,{muteHttpExceptions:true}); var j=JSON.parse(t.getContentText()); return (j&&j.templates)||j; }catch(e){ return []; } }
function loadCycles_(){ try{ return readObjects_(sheet_(CONFIG.CYCLES_SHEET_ID, CONFIG.CYCLES_TAB)).rows.filter(function(r){return r.cycle_id;}); }catch(e){ return []; } }
function loadTaskLog_(){ var sh=sheet_(CONFIG.TASKLOG_SHEET_ID, CONFIG.TASKLOG_TAB); ensureHeader_(sh,LOGCOLS); return readObjects_(sh).rows.filter(function(r){return r.entry_id;}); }
function detailToCat_(det){ det=String(det).toLowerCase(); if(det.indexOf('weed')>=0)return'weeding'; if(det.indexOf('plant')>=0)return'planting'; if(det.indexOf('harvest')>=0)return'harvest'; if(det.indexOf('clear')>=0)return'infrastructure'; if(det.indexOf('fert')>=0||det.indexOf('spray')>=0)return'fertilizer'; if(det.indexOf('prun')>=0)return'crop_protection'; return'other'; }
function normDate_(s){ if(!s) return ''; var d=new Date(s); if(!isNaN(d.getTime())) return Utilities.formatDate(d,'Etc/UTC','yyyy-MM-dd'); return String(s).slice(0,10); }

/* Resolve a completion report to a task occurrence and write the right event. */
function resolveCompletion_(a, extra){
  extra=extra||{};
  var d=a.date;
  var templates=fetchTemplates_(), cycles=loadCycles_(), tasklog=loadTaskLog_();
  var res=JamatCal.generate({ templates:templates, cycles:cycles, taskLog:tasklog, today:d,
    rangeStart:JamatCal.iso(JamatCal.addDays(JamatCal.parseDate(d),-(CONFIG.MATCH_TOLERANCE_DAYS+3))),
    rangeEnd:  JamatCal.iso(JamatCal.addDays(JamatCal.parseDate(d), (CONFIG.MATCH_TOLERANCE_DAYS+3))) });
  var sug=JamatCal.autoMatch([{plot_no:a.plot_no, type:'Work', detail:a.detail, date:a.date, by:a.by}], res.occurrences, CONFIG.MATCH_TOLERANCE_DAYS);
  if(sug.length && sug[0].chosen){
    var c=sug[0].chosen;
    return appendEvents_([{ cycle_id:c.cycle_id, task_code:c.task_code, occurrence_index:c.occurrence_index,
      scheduled_date:c.scheduled_date, action:'done', done_date:a.date, by:a.by||'field',
      crew_size:extra.crew||'', qty:extra.qty||'', qty_unit:extra.unit||'', note:extra.note||'',
      notes:'completion form — matched' }]);
  }
  // No confident match: keep the completion (never lose it), flagged for review.
  return appendEvents_([{ cycle_id:'', task_code:'field_done', occurrence_index:'0', scheduled_date:a.date,
    action:'done', done_date:a.date, by:a.by||'field', adhoc_plot_no:a.plot_no, adhoc_label:a.detail,
    adhoc_category:detailToCat_(a.detail), crew_size:extra.crew||'', qty:extra.qty||'', qty_unit:extra.unit||'',
    note:extra.note||'', notes:'completion form — UNMATCHED, review' }]);
}

/* ---------- 1) Completion Form submit ---------- */
function onFormSubmit(e){
  var v=(e&&e.namedValues)||{};
  function g(name){ var x=v[name]; return (x&&x[0])?String(x[0]).trim():''; }
  var a={ plot_no:g('Plot number'), detail:g('Activity done'), date:normDate_(g('Date done')), by:g('Your name') };
  if(!a.plot_no || !a.detail || !a.date) return;
  resolveCompletion_(a, { qty:g('Quantity (optional)'), unit:g('Unit'), crew:g('Crew size (optional)'), note:g('Note (optional)') });
}

/* ---------- 2) Web App endpoint (planner sync — no export) ---------- */
function doPost(e){
  try{
    var body=JSON.parse((e&&e.postData&&e.postData.contents)||'{}');
    if(CONFIG.SHARED_SECRET && body.secret!==CONFIG.SHARED_SECRET) return json_({ok:false,error:'bad secret'});
    var events = body.events || (body.event?[body.event]:[]);
    return json_({ok:true, written:appendEvents_(events)});
  }catch(err){ return json_({ok:false, error:String(err)}); }
}
function doGet(){ return json_({ok:true, service:'JamatAgro completion write-back', tab:CONFIG.TASKLOG_TAB}); }
function json_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ---------- run ONCE to build the Form + install the trigger ---------- */
function createCompletionForm(){
  var form=FormApp.create('JamatAgro — Task completion');
  form.setDescription('Report a task you finished. It updates the farm calendar automatically.');
  form.addTextItem().setTitle('Plot number').setRequired(true);
  form.addListItem().setTitle('Activity done').setChoiceValues(DETAILS).setRequired(true);
  form.addDateItem().setTitle('Date done').setRequired(true);
  form.addTextItem().setTitle('Your name').setRequired(true);
  form.addTextItem().setTitle('Quantity (optional)');
  form.addListItem().setTitle('Unit').setChoiceValues(['','tonnes','kg','bags','crates']);
  form.addTextItem().setTitle('Crew size (optional)');
  form.addParagraphTextItem().setTitle('Note (optional)');
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
  Logger.log('Completion form — SHARE this link with the team: '+form.getPublishedUrl());
  Logger.log('Completion form — edit here: '+form.getEditUrl());
  return { publish:form.getPublishedUrl(), edit:form.getEditUrl() };
}

/* =====================================================================
 * #2 — Scheduled auto-close of high-confidence field reports
 * Reads the Activity sheet, matches each recent work report to an open
 * task, and writes a `done` row ONLY when the match is unambiguous and a
 * tight date fit. Ambiguous / no-match are left for a human (the planner's
 * suggested-completions). Idempotent: the event's entry_id is a fingerprint
 * of the activity row, so re-runs never double-write; and once a task is
 * closed the matcher won't match it again.
 * Install: run installAutoCloseTrigger() once (daily ~6am).
 * ===================================================================== */
function shortHash_(s){ var h=0; for(var i=0;i<String(s).length;i++){ h=((h<<5)-h+String(s).charCodeAt(i))|0; } return (h>>>0).toString(36); }
function activityFingerprint_(a){ return 'AC-'+shortHash_([a.plot_no,a.detail,a.date,a.by].join('|')); }
function normActivityRow_(o){
  var low={}; for(var k in o) low[String(k).trim().toLowerCase()]=o[k];
  function pick(){ for(var i=0;i<arguments.length;i++){ if(low[arguments[i]]) return String(low[arguments[i]]); } for(var key in low){ for(var j=0;j<arguments.length;j++){ if(key.indexOf(arguments[j])>=0 && low[key]) return String(low[key]); } } return ''; }
  var detail=pick('detail'), sev=pick('severity'), type=pick('typ','type');
  var isInc = sev!=='' || ['fire','flood','pest','disease','theft'].indexOf(detail.toLowerCase())>=0 || /incident/i.test(type);
  return { plot_no:pick('plot_no','plot number','plot'), type:isInc?'Incident':'Work', detail:detail, date:normDate_(pick('date','timestamp','zeitstempel')), by:pick('your name','by','name') };
}
function autoCloseFromActivity(){
  var sh=sheet_(CONFIG.ACTIVITY_SHEET_ID, CONFIG.ACTIVITY_TAB);
  var rows=readObjects_(sh).rows.map(normActivityRow_).filter(function(a){ return a.plot_no && a.date && a.type==='Work' && a.detail; });
  var templates=fetchTemplates_(), cycles=loadCycles_(), tlog=loadTaskLog_();
  var today=new Date(), lookback=CONFIG.AUTOCLOSE_LOOKBACK_DAYS||21, tol=CONFIG.AUTOCLOSE_TOLERANCE_DAYS||3;
  var toClose=[], claimed={}, closed=0, ambiguous=0, nomatch=0;
  rows.forEach(function(a){
    var ad=JamatCal.parseDate(a.date); if(!ad) return;
    if((today-ad)/86400000 > lookback) return;
    var res=JamatCal.generate({ templates:templates, cycles:cycles, taskLog:tlog, today:a.date,
      rangeStart:JamatCal.iso(JamatCal.addDays(ad,-(tol+2))), rangeEnd:JamatCal.iso(JamatCal.addDays(ad,(tol+2))) });
    var sug=JamatCal.autoMatch([a], res.occurrences, tol);
    if(!sug.length){ nomatch++; return; }
    var s=sug[0];
    if(s.ambiguous || !s.chosen){ ambiguous++; return; }       // two crops etc → leave for a human
    var c=s.chosen, okey=c.cycle_id+'|'+c.task_code+'|'+c.occurrence_index;
    if(claimed[okey]) return;                                    // don't let two reports claim the same occurrence in one run
    claimed[okey]=true;
    toClose.push({ entry_id:activityFingerprint_(a), cycle_id:c.cycle_id, task_code:c.task_code, occurrence_index:c.occurrence_index,
      scheduled_date:c.scheduled_date, action:'done', done_date:a.date, by:a.by||'field', notes:'auto-closed from field report' });
    closed++;
  });
  var written=appendEvents_(toClose);                            // dedupe by entry_id across runs
  Logger.log('auto-close: matched '+closed+' (wrote '+written+' new), '+ambiguous+' ambiguous left for review, '+nomatch+' with no open task');
  return { matched:closed, written:written, ambiguous:ambiguous, nomatch:nomatch };
}
function installAutoCloseTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='autoCloseFromActivity') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('autoCloseFromActivity').timeBased().atHour(6).everyDays(1).create();
  Logger.log('Daily auto-close trigger installed (~6am). Run autoCloseFromActivity() now to test.');
}

/* =====================================================================
 * #4 — WhatsApp daily send
 * Builds each manager's outstanding list for today and delivers it:
 *   default) emails CONFIG.COORDINATOR_EMAIL a digest with one-tap wa.me
 *            links (open WhatsApp with the text ready → pick the group/manager → send)
 *   optional) if CONFIG.WA_CLOUD.enabled, sends 1:1 via WhatsApp Business Cloud API.
 * Install: run installDailyWhatsAppTrigger() once.
 * ===================================================================== */
function fmtD_(iso){ var M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; var p=String(iso).split('-'); return (+p[2])+' '+M[+p[1]-1]; }
function dailyOccurrences_(){
  var templates=fetchTemplates_(), cycles=loadCycles_(), tlog=loadTaskLog_();
  var today=Utilities.formatDate(new Date(),'Etc/UTC','yyyy-MM-dd');
  var res=JamatCal.generate({ templates:templates, cycles:cycles, taskLog:tlog, today:today,
    rangeStart:JamatCal.iso(JamatCal.addDays(JamatCal.parseDate(today),-45)),
    rangeEnd:JamatCal.iso(JamatCal.addDays(JamatCal.parseDate(today),1)) });
  var occ=res.occurrences.filter(function(o){ return o.scheduled_date<=today && ['overdue','not_reported','in_window','due_soon'].indexOf(o.status)>=0; });
  return { today:today, occ:occ };
}
function dailyTextFor_(manager, occ, today){
  var mo=occ.filter(function(o){ return (o.manager||'(unassigned)')===manager; });
  if(!mo.length) return '';
  var byPlot={}; mo.forEach(function(o){ (byPlot[o.plot_no]=byPlot[o.plot_no]||[]).push(o); });
  var t='JamatAgro — '+manager+' — '+fmtD_(today)+'\n';
  Object.keys(byPlot).sort(function(a,b){return a-b;}).forEach(function(pn){
    var r=byPlot[pn]; t+='Plot '+pn+(r[0].area_ha?' ('+r[0].area_ha+' ha)':'')+'\n';
    r.forEach(function(o){ t+='  • '+(o.critical?'‼ ':'')+(o.field_label||o.label)+(o.inputs?' ['+o.inputs+']':'')+'\n'; });
  });
  return t.replace(/\s+$/,'');
}
function loadRecipients_(){
  if(CONFIG.RECIPIENTS_SHEET_ID){ try{ return readObjects_(sheet_(CONFIG.RECIPIENTS_SHEET_ID, CONFIG.RECIPIENTS_TAB)).rows.filter(function(r){return r.manager;}).map(function(r){ return {manager:r.manager, phone:r.phone||'', email:r.email||''}; }); }catch(e){} }
  return CONFIG.RECIPIENTS||[];
}
function waSendText_(to, body){
  var url='https://graph.facebook.com/v19.0/'+CONFIG.WA_CLOUD.phone_id+'/messages';
  var payload={ messaging_product:'whatsapp', to:String(to).replace(/[^0-9]/g,''), type:'text', text:{ body:body } };
  var res=UrlFetchApp.fetch(url,{ method:'post', contentType:'application/json', headers:{ Authorization:'Bearer '+CONFIG.WA_CLOUD.token }, payload:JSON.stringify(payload), muteHttpExceptions:true });
  if(res.getResponseCode()>=300) throw new Error('WA API '+res.getResponseCode()+': '+res.getContentText());
}
function sendDailyLists(){
  var d=dailyOccurrences_(), occ=d.occ, today=d.today;
  var managers=[]; occ.forEach(function(o){ var m=o.manager||'(unassigned)'; if(managers.indexOf(m)<0) managers.push(m); });
  if(!managers.length){ Logger.log('No outstanding tasks today — nothing to send.'); return; }
  var byName={}; loadRecipients_().forEach(function(r){ byName[r.manager]=r; });
  var sentApi=0, blocks=[];
  managers.forEach(function(m){
    var text=dailyTextFor_(m, occ, today); if(!text) return;
    var rc=byName[m]||{};
    if(CONFIG.WA_CLOUD && CONFIG.WA_CLOUD.enabled && rc.phone){
      try{ waSendText_(rc.phone, text); sentApi++; return; }catch(e){ blocks.push({m:m,text:text,phone:rc.phone,err:String(e)}); return; }
    }
    blocks.push({ m:m, text:text, phone:rc.phone||'' });
  });
  if(blocks.length && CONFIG.COORDINATOR_EMAIL){
    var html='<p>Daily task lists for '+fmtD_(today)+'. Tap a link to open WhatsApp with the message ready, then choose the group or the manager and press send.</p>';
    var plain='';
    blocks.forEach(function(b){
      var link = b.phone ? ('https://wa.me/'+String(b.phone).replace(/[^0-9]/g,'')+'?text='+encodeURIComponent(b.text))
                         : ('https://wa.me/?text='+encodeURIComponent(b.text));
      html += '<h3>'+b.m+(b.err?' (API failed — send manually)':'')+'</h3>'
            + '<p><a href="'+link+'">Open '+b.m+"'s list in WhatsApp ▸</a></p>"
            + '<pre style="white-space:pre-wrap;font-family:monospace">'+b.text.replace(/</g,'&lt;')+'</pre>';
      plain += b.text+'\n\n';
    });
    MailApp.sendEmail({ to:CONFIG.COORDINATOR_EMAIL, subject:'JamatAgro daily lists — '+fmtD_(today), htmlBody:html, body:plain });
  }
  Logger.log('WhatsApp daily: '+sentApi+' sent via API, '+blocks.length+' in coordinator email.');
  return { api:sentApi, email:blocks.length };
}
function installDailyWhatsAppTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){ if(t.getHandlerFunction()==='sendDailyLists') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDailyLists').timeBased().atHour(CONFIG.DAILY_HOUR||6).everyDays(1).create();
  Logger.log('Daily WhatsApp trigger installed (~'+(CONFIG.DAILY_HOUR||6)+':00). Run sendDailyLists() now to test.');
}

/* ---------- quick self-test (no form needed) ---------- */
function testWriteback(){
  var n=appendEvents_([{ cycle_id:'TEST', task_code:'ping', occurrence_index:'0', action:'done', done_date:nowIso_().slice(0,10), by:'setup-test', notes:'testWriteback' }]);
  Logger.log('Wrote '+n+' test row to '+CONFIG.TASKLOG_TAB+' (delete it afterwards).');
}
function testMatch(){
  // change plot/detail/date to something that has an open task, then run to see if it matches
  Logger.log('rows written: '+resolveCompletion_({plot_no:'45', detail:'Weeding', date:'2026-05-16', by:'setup-test'}, {}));
}
