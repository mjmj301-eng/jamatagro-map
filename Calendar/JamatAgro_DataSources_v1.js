/* =====================================================================
   JamatAgro — SHARED DATA SOURCES  (single source of truth)
   Both the map (index.html) and the planner (Calendar/JamatAgro_PlanningViews_v4.html)
   read their data from the URLs below. Edit a source ONCE here; both apps update.

   IMPORTANT: these must be "Publish to web -> CSV" links (…/pub?output=csv),
   NOT /edit or Drive-share links. For a multi-tab sheet, publish EACH tab and
   the URL will carry its own &gid=… . An /edit link returns the editor page and
   will NOT load.
   ===================================================================== */
window.JAMAT_SRC = {

  /* Plot register — plot attributes (use, vintage, manager, cleared…). Already live. */
  REGISTER_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQiWG52Sc_IqsEvbf0AmNOYmCW8Wof88elt79zvPtfcq0rHSX4Sfv8w41ZYOTJsbVdKDYvxjxpjM7hs/pub?output=csv',

  /* Activity log — field reports & incidents (Google Form). Already live. */
  ACTIVITY_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS68ealVuRhDHEksYgnngTfS3BlUa07rHQa0lhGIUzSWO2UleVy3bgyD1ZfDTCYhy1FycR3hdYUN5_L/pub?output=csv',

  /* Crop cycles — one row per crop on a plot.
     Sheet you shared: https://docs.google.com/spreadsheets/d/14ywp7knw2agZfFFwTWjfeHel-AyrCIJAX4yvKxOMcsE/edit
     TODO: File > Share > Publish to web > (Cycles tab) > CSV, then paste that pub?output=csv link here. */
  CROP_CYCLES_URL: '',

  /* Task log — append-only completions/shifts/skips/ad-hoc (planner exports; a person appends to the sheet).
     Sheet you shared: https://docs.google.com/spreadsheets/d/19xsPGVFjEqB57MDfG-8z0XVynETjuZD5H1Xa5-D4ne0/edit
     TODO: Publish to web > (Task-log tab) > CSV, then paste that pub?output=csv link here. */
  TASK_LOG_URL: '',

  /* Agronomic templates + crew sizes — versioned config, stay as repo files (page-relative). */
  CROP_TEMPLATES_FILE: 'JamatAgro_CropTemplates_v3.json',   // relative to whichever page loads it
  WORKFORCE_FILE:      'JamatAgro_Workforce_v1.csv'
};
