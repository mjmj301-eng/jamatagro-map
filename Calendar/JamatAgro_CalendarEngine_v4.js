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
if (typeof module!=='undefined' && module.exports) module.exports=JamatCal;
