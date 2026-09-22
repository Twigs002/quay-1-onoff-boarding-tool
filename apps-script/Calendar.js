/**
 * Calendar.js - Phase 2 onboarding calendar events (Quay 1 only). At PROVISIONING (accounts exist and
 * the induction week / start date / birthday are all known) a new starter gets four events:
 *   - Induction Day 1 (Wed 09:00-12:00) and Day 2 (Thu 09:00-12:00) on the shared "Quay 1 Inductions"
 *     calendar, with the candidate invited (they get the invite on their own calendar).
 *   - Birthday and Work anniversary (both yearly, all-day) on the shared "Quay 1 Team Dates" calendar,
 *     for HR / colleagues to see and celebrate.
 *
 * Idempotent: created event ids are stored on the row (calendar_events_json); a re-run recreates only
 * the ones that are missing. Each event is independent - one failure never blocks the others, and any
 * failure logs a *_failed event (surfaced on the Alerts tab + Tuesday digest) and marks the set
 * incomplete. Honours DRY_RUN (creates nothing, logs only). Requires the Calendar OAuth scope in
 * appsscript.json - adding it forces a one-time re-authorisation of the project.
 *
 * Public surface:
 *   createOnboardingCalendarEvents_(folderId, o) - {created, skipped, failed}   the four events.
 */

// Keep in sync with the induction packet "Where" card (Email.js inductionPacketHtml_).
var INDUCTION_ADDRESS = 'Ground Floor, 200 On Main, 200 Main Rd, Claremont';

/**
 * ONE-TIME setup: authorize the Calendar scope AND create the two shared onboarding calendars.
 * Run this once in the editor after deploying the calendar feature - it is the FIRST call that touches
 * CalendarApp, so it triggers the Calendar consent screen; approve it, and it pre-creates + remembers
 * "Quay 1 Inductions" and "Quay 1 Team Dates" (idempotent). No trailing underscore so it shows in the
 * Apps Script Run picker alongside setupHub / setupTriggers. Share the two calendars with your team.
 */
function setupCalendars() {
  var ind = _onbCalendar_(PROP.CAL_INDUCTIONS_ID, 'Quay 1 Inductions');
  var team = _onbCalendar_(PROP.CAL_TEAM_DATES_ID, 'Quay 1 Team Dates');
  var msg = 'Calendars ready. "Quay 1 Inductions" = ' + ind.getId() + ' ; "Quay 1 Team Dates" = ' + team.getId() +
    '. Now share both with whoever should see them.';
  Logger.log(msg);
  return msg;
}

/** Get (or lazily create + remember by Script Property) a shared onboarding calendar. */
function _onbCalendar_(propKey, name) {
  var id = optProp_(propKey);
  if (id) {
    try { var existing = CalendarApp.getCalendarById(id); if (existing) return existing; }
    catch (e) { /* stored id no longer resolves - recreate below */ }
  }
  var cal = CalendarApp.createCalendar(name);
  _setProp_(propKey, cal.getId());
  logAudit_('onboarding_calendar_created', { name: name, id: cal.getId() });
  return cal;
}

// Month names -> 0-based index, for the human date format fmtDate_ produces ("16 September 2026").
var _MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parse a stored date to a Date at the given local hour (project timezone). Accepts BOTH the ISO form
 * (YYYY-MM-DD, e.g. induction_wed / birthday) AND the human form fmtDate_ writes to the tracker
 * ("16 September 2026", how start_date is persisted by the onboard) - otherwise work-anniversary
 * events silently never create because the start date is not ISO. Returns null on an unparseable value.
 */
function _dateAt_(val, hour) {
  var s = String(val == null ? '' : val).trim();
  if (!s) return null;
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], hour || 0, 0, 0);
  // fmtDate_ human format: "16 September 2026".
  var hm = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (hm) {
    var mi = _MONTH_INDEX[hm[2].toLowerCase()];
    if (mi != null) return new Date(+hm[3], mi, +hm[1], hour || 0, 0, 0);
  }
  // Last resort: let the engine try (e.g. "September 16, 2026"); normalise to local midnight + hour.
  var d = new Date(s);
  if (!isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour || 0, 0, 0);
  return null;
}

/**
 * Move a candidate's two induction calendar invites (Day 1 / Day 2) to the row's CURRENT induction
 * dates. Deletes the stored day1/day2 events off the "Quay 1 Inductions" calendar, drops those keys
 * from calendar_events_json, then recreates them on the new dates via createOnboardingCalendarEvents_
 * (which only makes the MISSING ones - the birthday + anniversary series are untouched). Called by
 * setInductionWeekManual_ after the new week is persisted; `o` must already carry the new
 * induction_wed/thu. Idempotent, Quay 1 only, non-fatal, DRY_RUN-safe.
 */
function rescheduleInductionCalendar_(folderId, o) {
  o = o || {};
  if ((o.entity || 'quay1') !== 'quay1') return;
  if (DRY_RUN_()) { logAudit_('induction_calendar_move_dryrun', { folderId: folderId }); return; }
  var have = {};
  try { have = JSON.parse(o.calendar_events_json || '{}') || {}; } catch (e) { have = {}; }
  var cal = null;
  try { cal = _onbCalendar_(PROP.CAL_INDUCTIONS_ID, 'Quay 1 Inductions'); } catch (e) { cal = null; }
  ['day1', 'day2'].forEach(function (key) {
    var id = have[key];
    if (id && cal) {
      try { var ev = cal.getEventById(id); if (ev) ev.deleteEvent(); }
      catch (e) { logAudit_('induction_calendar_delete_failed', { folderId: folderId, key: key, error: String(e) }); }
    }
    delete have[key];   // dropped so createOnboardingCalendarEvents_ recreates it on the new date
  });
  // Persist the stripped set AND reflect it on the in-memory row, so the recreate below (which reads
  // o.calendar_events_json) sees day1/day2 as missing rather than skipping them as already-created.
  var stripped = JSON.stringify(have);
  o.calendar_events_json = stripped;
  try { setOnboardingCell_(folderId, ONB_COL.calendar_events_json, stripped); }
  catch (e) { logAudit_('induction_calendar_move_save_failed', { folderId: folderId, error: String(e) }); }
  createOnboardingCalendarEvents_(folderId, o);   // recreates day1/day2 on the new induction dates
}

/**
 * Create the four onboarding calendar events for a Quay 1 starter, idempotently.
 * Returns { created:[keys], skipped:[keys], failed:[keys] }. Non-fatal + DRY_RUN-safe.
 * opts.teamDatesOnly: create ONLY the birthday + work-anniversary (Team Dates) events, never the
 *   induction Day 1/Day 2. Used by the backfill (backfillTeamDates) so an already-provisioned starter
 *   whose induction is in the past does not get induction invites re-sent for a past event.
 */
/** Standing guests (CFG.TEAM_DATES_GUESTS, e.g. Kat) invited to every birthday + work-anniversary
 *  series so they see/are-reminded of the whole team's dates. Returns a createAllDayEventSeries
 *  options object {guests, sendInvites}, or {} when none are configured. */
function _teamDatesGuestOpts_() {
  var list = (CFG.TEAM_DATES_GUESTS || []).filter(function (e) { return isEmail_(e); });
  return list.length ? { guests: list.join(','), sendInvites: true } : {};
}

function createOnboardingCalendarEvents_(folderId, o, opts) {
  o = o || {};
  opts = opts || {};
  var result = { created: [], skipped: [], failed: [] };
  if ((o.entity || 'quay1') === 'aqua') return result;   // Quay 1 only (Aqua has no induction)

  var have = {};
  try { have = JSON.parse(o.calendar_events_json || '{}') || {}; } catch (e) { have = {}; }
  var name = String(o.name || 'New starter').trim();
  var first = firstName_(name) || name;

  if (DRY_RUN_()) {
    logAudit_('calendar_events_dryrun', { folderId: folderId, wed: o.induction_wed || '', thu: o.induction_thu || '', birthday: o.birthday || '', start: o.start_date || '' });
    return result;
  }

  // Lazily resolve each shared calendar only when a task actually needs it.
  var indCal = null, teamCal = null;
  function inductions() { return indCal || (indCal = _onbCalendar_(PROP.CAL_INDUCTIONS_ID, 'Quay 1 Inductions')); }
  function teamDates() { return teamCal || (teamCal = _onbCalendar_(PROP.CAL_TEAM_DATES_ID, 'Quay 1 Team Dates')); }

  var tasks = [
    { key: 'day1', make: function () {
        var s = _dateAt_(o.induction_wed, 9); if (!s) return null;
        var e = new Date(s.getTime() + 3 * 3600 * 1000);
        return inductions().createEvent('Induction Day 1 - ' + name, s, e, {
          location: INDUCTION_ADDRESS,
          guests: isEmail_(o.email) ? o.email : undefined, sendInvites: true,
          description: 'Welcome to Quay 1, ' + first + '. Day 1 of your induction, 09:00 - 12:00, at ' + INDUCTION_ADDRESS + '.',
        }).getId();
      } },
    { key: 'day2', make: function () {
        var s = _dateAt_(o.induction_thu, 9); if (!s) return null;
        var e = new Date(s.getTime() + 3 * 3600 * 1000);
        return inductions().createEvent('Induction Day 2 - ' + name, s, e, {
          location: INDUCTION_ADDRESS,
          guests: isEmail_(o.email) ? o.email : undefined, sendInvites: true,
          description: 'Day 2 of your Quay 1 induction, 09:00 - 12:00, at ' + INDUCTION_ADDRESS + '.',
        }).getId();
      } },
    { key: 'birthday', make: function () {
        var d = _dateAt_(o.birthday, 0); if (!d) return null;
        return teamDates().createAllDayEventSeries('Birthday - ' + name, d,
          CalendarApp.newRecurrence().addYearlyRule(), _teamDatesGuestOpts_()).getId();
      } },
    { key: 'anniversary', make: function () {
        var d = _dateAt_(o.start_date, 0); if (!d) return null;
        // Year from the PARSED date, not a slice of the raw string - start_date is stored human-
        // formatted ("16 September 2026"), so slicing the first 4 chars would give "16 S", not the year.
        return teamDates().createAllDayEventSeries('Work anniversary - ' + name + ' (joined ' + d.getFullYear() + ')', d,
          CalendarApp.newRecurrence().addYearlyRule(), _teamDatesGuestOpts_()).getId();
      } },
  ];

  if (opts.teamDatesOnly) tasks = tasks.filter(function (t) { return t.key === 'birthday' || t.key === 'anniversary'; });

  tasks.forEach(function (t) {
    if (have[t.key]) { result.skipped.push(t.key); return; }   // already created - idempotent
    try {
      var id = t.make();
      if (id) { have[t.key] = id; result.created.push(t.key); }
      else { logAudit_('calendar_event_skipped_no_data', { folderId: folderId, key: t.key }); }
    } catch (err) {
      result.failed.push(t.key);
      logAudit_('calendar_event_failed', { folderId: folderId, key: t.key, error: String(err) });
    }
  });

  try { setOnboardingCell_(folderId, ONB_COL.calendar_events_json, JSON.stringify(have)); }
  catch (e) { logAudit_('calendar_events_save_failed', { folderId: folderId, error: String(e) }); }

  // "Invites incomplete" signal: a *_failed audit event (visible on the Alerts tab + Tuesday digest).
  if (result.failed.length) {
    logAudit_('calendar_invites_incomplete_failed', { folderId: folderId, missing: result.failed.join(',') });
  }
  logAudit_('calendar_events_run', {
    folderId: folderId, created: result.created.join(',') || 'none',
    skipped: result.skipped.join(',') || 'none', failed: result.failed.join(',') || 'none',
  });
  return result;
}

/**
 * ONE-TIME BACKFILL (run-picker; no trailing underscore so it shows in the editor Run menu). Creates
 * the birthday + work-anniversary events on "Quay 1 Team Dates" for every already-provisioned Quay 1
 * starter who is missing them. The normal path only creates these at provisioning, so anyone set up
 * before the calendar feature went live never got them and there is no auto-backfill.
 *
 * teamDatesOnly: it deliberately does NOT create the induction Day 1/Day 2 events - those invite the
 * candidate, and for a past induction that would fire invites for an event already gone. The live
 * per-starter flow still creates induction days for future starters. Idempotent (skips anyone whose
 * calendar_events_json already has both), Quay 1 only, DRY_RUN-safe. Safe to run more than once.
 */
function backfillTeamDates() {
  var out = { added: [], events: 0, skipped: 0, no_data: [], errors: [] };
  listOnboarding_().forEach(function (o) {
    try {
      if ((o.entity || 'quay1') !== 'quay1') return;   // Quay 1 only
      if (!o.provisioned_at) return;                    // only people actually set up
      var have = {};
      try { have = JSON.parse(o.calendar_events_json || '{}') || {}; } catch (e) { have = {}; }
      var needBirthday = !have.birthday && !!o.birthday;
      var needAnniv = !have.anniversary && !!o.start_date;
      if (!needBirthday && !needAnniv) { out.skipped++; return; }   // already has them, or no dates to use
      var r = createOnboardingCalendarEvents_(o.folderId, o, { teamDatesOnly: true });
      var made = r.created.filter(function (k) { return k === 'birthday' || k === 'anniversary'; });
      if (made.length) { out.added.push({ folderId: o.folderId, name: o.name, created: made }); out.events += made.length; }
      else out.no_data.push(o.folderId);
    } catch (err) { out.errors.push({ folderId: o.folderId, error: String(err) }); }
  });
  logAudit_('team_dates_backfill_run', { people: out.added.length, events: out.events, skipped: out.skipped, errors: out.errors.length, dry: DRY_RUN_() });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
