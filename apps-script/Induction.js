/**
 * Induction.js - Quay 1 induction assignment, the per-candidate progress report, and the Tuesday
 * digest. Quay 1 only (Aqua has no induction step).
 *
 * Owner: backend. induction_wed / induction_thu columns live on the Onboarding row (Tracker.js).
 *
 * Induction is AUTO-ASSIGNED from the FICA submission time (assignInductionWeek_, Tuesday 14:00 SAST
 * cutoff), wired in Fica.ficaUpload_. Candidates no longer pick a week: bookInduction_ now rejects,
 * and inductionPageHtml_ (doGet ?i=, token-less, folderId-gated) is a read-only status page.
 *
 * Public surface:
 *   assignInductionWeek_(iso)    - {monday, wed, thu}   PURE cutoff function (single source of truth).
 *   bookInduction_(body)         - {ok:false, error}    rejected: induction is auto-assigned now.
 *   inductionPageHtml_(folderId) - String   read-only candidate induction status page (branded).
 *   progressReport_(folderId)    - {ok, html}   per-candidate onboarding progress summary.
 *   tuesdayDigest_()             - void   TIME-TRIGGER target. Auto-send permitted (scoped).
 *
 * The temp password from provisioning is included ONLY in the induction email packet (email,
 * never WhatsApp) per SPEC section 4 - surfaced by whoever composes that packet, not here.
 */

/** Rejected: induction is auto-assigned from the FICA submission time now, not picked. Token-less. */
function bookInduction_(body) {
  // Induction is now assigned automatically from when the candidate submits FICA (Tuesday 14:00 SAST
  // cutoff - see assignInductionWeek_). Candidates no longer pick a week: new emails never link here
  // and the induction page is read-only. A stale/replayed link might still POST, so we reject it
  // gracefully rather than let it override the auto-assigned week.
  var folderId = String((body && body.folderId) || '');
  logAudit_('book_induction_rejected_autoassign', { folderId: folderId });
  return { ok: false, error: 'Induction is now assigned automatically from when you submit your FICA (before 14:00 on a Tuesday to join that week). There is nothing to book here - your induction dates are emailed to you once your FICA is received.' };
}

/**
 * Resend the induction packet for a candidate who has ALREADY booked a week (admin action from the
 * Progress report "Resend induction packet" button). Reads the booked Wed/Thu off the Onboarding row;
 * refuses if no week is booked yet or there is no candidate email.
 */
function resendInductionPacket_(folderId, ctx) {
  folderId = String(folderId || '');
  if (!folderId) return { ok: false, error: 'missing reference' };
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'not_found' };
  var wed = String(meta.induction_wed || '').trim();
  var thu = String(meta.induction_thu || '').trim();
  if (!wed && !thu) return { ok: false, error: 'No induction week is assigned yet - it is set automatically when the candidate submits FICA, so the packet can be resent once that has happened.' };
  if (!isEmail_(meta.email)) return { ok: false, error: 'No candidate email on file for this row.' };
  _sendInductionPacket_(folderId, meta, wed, thu);
  logAudit_('induction_packet_resent', { folderId: folderId, by: (ctx && ctx.email) || 'admin' });
  return { ok: true, wed: wed, thu: thu, resent: true };
}

/**
 * The induction week to use when the packet is sent at provisioning. Induction is normally assigned at
 * FICA submit, but the packet only goes out later (on acceptance/provisioning). If the row has NO week
 * (auto-assign was skipped, failed and was swallowed, or is a pre-feature/legacy row) or the assigned
 * week has ALREADY PASSED (acceptance lagged past the induction date), re-assign from now so the packet,
 * the tracker and the digest all reflect a real, upcoming week instead of blank or past dates. Persists
 * the (re)assignment + holiday flag. Quay 1 only; DRY_RUN writes nothing. Returns { wed, thu }.
 */
function _ensureInductionWeekForProvisioning_(o) {
  o = o || {};
  var wed = String(o.induction_wed || '').trim();
  var thu = String(o.induction_thu || '').trim();
  var today = _isoDate_(new Date());
  // Stale only once BOTH induction days have passed - compare the LATER day (thu, falling back to wed).
  // Provisioning on the induction Wednesday or Thursday must keep this week, not bump to the next.
  var lastDay = thu || wed;
  var stale = !!(lastDay && lastDay < today);    // YYYY-MM-DD compares lexically
  if (wed && thu && !stale) return { wed: wed, thu: thu, rescheduled: false };
  var wk = assignInductionWeek_(nowIso_());
  // rescheduled = a week the candidate was ALREADY told (via the FICA-received email) has passed and we
  // are moving them; the packet then leads with a gentle "rescheduled" note. An empty week (never
  // assigned) is a first-time assignment, not a reschedule.
  var rescheduled = stale;
  try {
    if (!DRY_RUN_()) {
      setInduction_(o.folderId, wk.wed, wk.thu);
      setOnboardingCell_(o.folderId, ONB_COL.induction_holiday_flag, _inductionHolidayFlag_(wk.wed, wk.thu));
    }
    logAudit_(stale ? 'induction_reassigned_stale' : 'induction_assigned_at_provision',
      { folderId: o.folderId, was_wed: wed || '', wed: wk.wed, thu: wk.thu, dry: DRY_RUN_() });
    return { wed: wk.wed, thu: wk.thu, rescheduled: rescheduled };
  } catch (e) {
    // Persist failed: return whatever is actually on the row so the packet never cites a week the
    // tracker/digest/flow have no record of. Blank dates fall through to the packet's defensive line.
    logAudit_('induction_provision_assign_failed', { folderId: o.folderId, error: String(e) });
    return { wed: wed, thu: thu, rescheduled: false };
  }
}

/**
 * Build + send the induction packet (booked dates + Google/HubSpot logins) to the candidate, CC the
 * senior broker, and alert the team when no HubSpot login is on record. Called at provisioning (via
 * _ensureInductionWeekForProvisioning_, which guarantees real upcoming dates) and by
 * resendInductionPacket_ (which refuses when no week is set). Wrapped so a send failure never
 * propagates to the caller.
 */
function _sendInductionPacket_(folderId, o, wed, thu, rescheduled) {
  o = o || {};
  try {
    var company = CFG.COMPANY[o.entity || 'quay1'] || CFG.COMPANY.quay1;
    var cred = _credentialFor_(folderId);
    var hub = _teamHubspotLogin_(o.team);                  // team HubSpot login row (recorded?)
    var teamLogin = (hub && hub.recorded) ? hub : null;    // include in the packet only when on record
    // Visibility net (CC-independent, sends nothing): if the packet will omit the HubSpot login,
    // log WHY - team name not matched in the "HubSpot Logins" tab, or matched but no password on file.
    if (!teamLogin) logAudit_('induction_hubspot_missing', { folderId: folderId, team: o.team, matched: !!hub, recorded: !!(hub && hub.recorded) });
    if (isEmail_(o.email)) {
      var loginText = cred ? ('\n\nYour first-login details:\nEmail: ' + (cred.email || '-') +
        '\nTemporary password: ' + (cred.temp_password || '-') +
        '\n(You will be asked to set your own password when you first sign in.)') : '';
      // Never silently omit the HubSpot line - when it is not on record yet, say so instead of
      // leaving the candidate to wonder why it is missing.
      var hubText = teamLogin ? ('\n\nYour team HubSpot login:\nUsername: ' + (teamLogin.username || '-') +
        '\nPassword: ' + (teamLogin.password || '-') +
        (teamLogin.code_to ? '\nVerification code goes to: ' + teamLogin.code_to : '')) :
        '\n\nYour team HubSpot login: not on file yet - we will send it to you separately once confirmed.';
      var propdataText = '\n\nPropData will send you a SEPARATE email to set up your account - if you ' +
        'do not see it, please check your spam / junk folder.';
      var linksText = '\n\nUseful links:\nQuay 1 Shared Drive: https://drive.google.com/drive/folders/' +
        '0B8WThNzNuhU_LUVBb3BwMzFvN3M?resourcekey=0-RyLU_9UCYYV8yz2PUTLLkg&usp=sharing' +
        '\nFlow (Broker App): https://flow.quay1.co.za/';
      // Defensive: callers guarantee real dates, but never emit "booked for  and ." if they are blank.
      var bookedLine = (wed || thu)
        ? ' induction is booked for ' + fmtDate_(wed) + ' and ' + fmtDate_(thu) + '.'
        : ' induction week will be confirmed with you shortly.';
      // When a previously-communicated week had passed and we rescheduled, lead with a gentle note.
      var reschedLine = rescheduled ? ' Please note your induction has been rescheduled.' : '';
      var plain = 'Hi ' + firstName_(o.name) + ',\n\nYour ' + company.name + bookedLine + reschedLine +
        loginText + hubText + propdataText + linksText + '\n\nWarm regards,\nThe ' + company.name + ' Team';
      GmailApp.sendEmail(o.email,
        'Your ' + company.name + ' Induction Packet' + (o.name ? ' - ' + o.name : ''),
        plain, {
          name: company.name,
          htmlBody: inductionPacketHtml_(company, o, { wed: wed, thu: thu, rescheduled: rescheduled }, cred, teamLogin),
          cc: (ccEnabled_() && isEmail_(o.senior_email)) ? o.senior_email : undefined,
        });
      // The induction packet IS the Quay 1 welcome pack: record that it went out and reflect it on the
      // HR row (which was promoted earlier, on acceptance). Non-fatal.
      try {
        setOnboardingCell_(folderId, ONB_COL.welcome_email_at, nowIso_());
        hrMarkWelcomeSent_(folderId);
      } catch (e) { logAudit_('welcome_sent_mark_failed', { folderId: folderId, error: String(e) }); }
    }
    // Team HubSpot login NOT on record -> alert the team (CC Sheldon + Marthinus) so the new hire
    // gets access and no one has to chase it. Suppressed when internal mail is off (ccEnabled_).
    if (hub && !hub.recorded && isEmail_(hub.username) && ccEnabled_()) {
      try {
        GmailApp.sendEmail(hub.username, 'HubSpot login needed - new ' + (o.team || '') + ' team member starting',
          'Hi ' + (o.team || 'team') + ' team,\n\nYour new team member ' + (o.name || 'a new starter') +
          ' is about to start, but we do not have a HubSpot login recorded for your team. Please reply with ' +
          'your team HubSpot password and who the verification code should go to, as soon as possible.\n\n' +
          'Thanks,\nThe ' + company.name + ' Team', { name: company.name, cc: 'sheldon@quay1.co.za' });
      } catch (e2) { logAudit_('hubspot_team_alert_failed', { folderId: folderId, error: String(e2) }); }
    }
    // Team name not on the "HubSpot Logins" tab at all: still chase the login from the TEAM, sending to
    // the team's own group email (<team>@quay1.co.za, from GROUPS_JSON where available) and CC'ing
    // Sheldon. Same ccEnabled_() gate as above. Falls back to Sheldon if no team email resolves.
    if (!hub && ccEnabled_()) {
      try {
        var teamEmail = _teamGroupEmail_(o.team);
        var noHubTo = isEmail_(teamEmail) ? teamEmail : 'sheldon@quay1.co.za';
        GmailApp.sendEmail(noHubTo, 'HubSpot login needed - new ' + (o.team || '') + ' team member starting',
          'Hi ' + (o.team || 'team') + ' team,\n\nYour new team member ' + (o.name || 'a new starter') +
          ' is about to start, but we do not have a HubSpot login recorded for your team. Please reply with ' +
          'your team HubSpot username, password and who the verification code should go to, as soon as possible.\n\n' +
          'Thanks,\nThe ' + company.name + ' Team', { name: company.name, cc: 'sheldon@quay1.co.za' });
      } catch (e2) { logAudit_('hubspot_team_alert_failed', { folderId: folderId, error: String(e2) }); }
    }
  } catch (err) {
    logAudit_('induction_packet_failed', { folderId: folderId, error: String(err) });
  }
}

/** Look up a team's HubSpot login in the 'HubSpot Logins' tab. Returns { team, username, password,
 *  code_to, recorded } (recorded = a password is on file) or null when the team is not listed.
 *  Columns: Team | Division | HubSpot Username | HubSpot Password | Code goes to (name) | ... */
function _teamHubspotLogin_(team) {
  var name = String(team || '').trim().toLowerCase();
  if (!name) return null;
  var t = sheet_().getSheetByName('HubSpot Logins');
  if (!t || t.getLastRow() < 2) return null;
  var v = t.getRange(2, 1, t.getLastRow() - 1, 5).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0] || '').trim().toLowerCase() === name) {
      var pw = String(v[i][3] || '').trim();
      return { team: v[i][0], username: String(v[i][2] || '').trim(), password: pw,
        code_to: String(v[i][4] || '').trim(), recorded: !!pw };
    }
  }
  return null;
}

/** The team's own Google group email (<team>@quay1.co.za). Prefers the real group from GROUPS_JSON
 *  (excluding the company-wide champions@ group); falls back to a normalised <team>@domain. '' when
 *  the team is blank. Used to chase a HubSpot login from a team not on the "HubSpot Logins" tab. */
function _teamGroupEmail_(team) {
  try {
    var groups = _groupsForTeam_(team) || [];
    for (var i = 0; i < groups.length; i++) {
      if (groups[i] && groups[i] !== CFG.COMPANY_GROUP) return groups[i];
    }
  } catch (e) { /* fall through to the naive derivation */ }
  var slug = String(team || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug ? slug + '@' + CFG.DOMAIN : '';
}

/** Find the Google-account credential for a folderId in the private Credentials tab. Returns
 *  { email, temp_password } or null. Header-name keyed (created_at, full_name, quay_email,
 *  temp_password, team, folderId) so it survives column reordering. */
function _credentialFor_(folderId) {
  var t = sheet_().getSheetByName(CFG.TAB.CREDENTIALS);
  if (!t || t.getLastRow() < 2) return null;
  var values = t.getRange(1, 1, t.getLastRow(), t.getLastColumn()).getValues();
  var headers = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var fIx = headers.indexOf('folderId');
  var eIx = headers.indexOf('quay_email');
  var pIx = headers.indexOf('temp_password');
  if (fIx < 0) return null;
  var key = String(folderId || '').trim();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][fIx] || '').trim() === key) {
      return {
        email: eIx >= 0 ? String(values[i][eIx] || '') : '',
        temp_password: pIx >= 0 ? String(values[i][pIx] || '') : '',
      };
    }
  }
  return null;
}

/** Per-candidate progress summary (contract, FICA ticks, induction, provisioning states). */
function progressReport_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'not_found' };
  var fica = ficaStatus_(folderId);
  var prov = readQueue_(CFG.TAB.PROVISION_QUEUE).filter(function (r) { return r.folderId === folderId; });
  var provBySystem = {};
  prov.forEach(function (r) { provBySystem[r.system] = r.status; });

  var row = function (label, val) {
    return '<tr><td style="padding:4px 14px 4px 0;color:#7A7358;font-size:13px">' + htmlEsc_(label) +
      '</td><td style="padding:4px 0;font-size:14px;font-weight:600">' + htmlEsc_(val) + '</td></tr>';
  };
  var yn = function (b) { return b ? 'Received' : 'Outstanding'; };
  var html =
    '<table role="presentation" cellpadding="0" cellspacing="0" style="font-family:Montserrat,Arial,sans-serif">' +
      row('Name', o.name) + row('Status', o.status) +
      row('FICA ID', yn(fica.id)) + row('FICA POA', yn(fica.poa)) + row('FICA bank', yn(fica.bank)) +
      row('FICA contract', yn(fica.contract)) + row('FICA NDA', yn(fica.nda)) +
      row('Induction', (o.induction_wed || '') + (o.induction_thu ? ' / ' + o.induction_thu : '')) +
      Object.keys(provBySystem).map(function (s) { return row('Provision ' + s, provBySystem[s]); }).join('') +
    '</table>';
  return { ok: true, html: html };
}

/**
 * Tuesday digest of Quay1 candidates and their induction status. Auto-send is permitted for this
 * scoped onboarding-pipeline digest (SPEC section 6). Installed via setupTriggers() (Setup.js).
 */
function tuesdayDigest_() {
  var weekStart = _mondayOfThisWeek_();
  var weekEnd = _addDays_(weekStart, 6);
  var buckets = { dueThisWeek: [], unbooked: [] };
  listOnboarding_(function (o) { return o.entity === 'quay1' && !_isMigratedLegacy_(o); }).forEach(function (o) {
    var wed = _asDate_(o.induction_wed);
    // Due this week = anyone assigned this week who has not dropped out (not declined). We deliberately
    // do NOT require approved_at here: an imminent-but-not-yet-accepted candidate is EXACTLY who the
    // digest must surface so an admin approves them before Wed/Thu. Their acceptance status is shown as
    // a per-row note ("Awaiting acceptance") rather than hiding them. Holiday clashes are flagged too.
    if (wed && wed >= weekStart && wed <= weekEnd && !o.declined_at) buckets.dueThisWeek.push(o);
    // Awaiting = anyone who has been SENT their contract (contract_emailed_at stamped) but has not yet
    // submitted FICA (so no induction week assigned). Scoping to contract-sent keeps out non-starters;
    // excluding declined keeps out rows that have dropped out.
    else if (!o.induction_wed && !o.induction_thu && o.contract_emailed_at && !o.declined_at) buckets.unbooked.push(o);
  });
  var company = CFG.COMPANY.quay1;
  var to = CFG.DIGEST_NOTIFY.filter(function (x) { return x; }).join(',');
  var awaitingAccept = buckets.dueThisWeek.filter(function (o) { return !o.approved_at; }).length;
  var holidayClashes = buckets.dueThisWeek.filter(function (o) { return o.induction_holiday_flag; }).length;
  // Operator health line: system alerts logged this week (swallowed *_failed events) + a heads-up when
  // the SA public-holiday table is about to run out. Both are otherwise invisible to whoever reads this.
  var health = {
    alerts: _recentAlertCount_(_isoDate_(_addDays_(new Date(), -7))),
    holidayWarning: _holidayTableWarning_(),
  };
  var subject = company.name + ' - induction digest (' + buckets.dueThisWeek.length +
    ' due, ' + buckets.unbooked.length + ' awaiting FICA)' + (health.alerts ? ' [' + health.alerts + ' alert' + (health.alerts === 1 ? '' : 's') + ']' : '');
  var body = 'Induction status. Due this week: ' + buckets.dueThisWeek.length +
    ' (' + awaitingAccept + ' still awaiting acceptance). Awaiting FICA: ' + buckets.unbooked.length + '.' +
    (holidayClashes ? '\n\nATTENTION: ' + holidayClashes + ' induction day this week clashes with a SA public holiday - see the Status column.' : '') +
    (health.alerts ? '\n\nSystem alerts this week: ' + health.alerts + ' - see the Alerts tab in the tracker.' : '') +
    (health.holidayWarning ? '\n\n' + health.holidayWarning : '');
  GmailApp.sendEmail(to, subject, body,
    { name: company.name, htmlBody: inductionDigestHtml_(company, buckets, health) });
}

/** Count Alerts-tab rows logged on/after `sinceIso` (a YYYY-MM-DD). 0 when the tab/tracker is absent. */
function _recentAlertCount_(sinceIso) {
  try {
    var id = optProp_(PROP.TRACKER_SHEET_ID);
    if (!id) return 0;
    var t = SpreadsheetApp.openById(id).getSheetByName(CFG.TAB.ALERTS);
    if (!t) return 0;
    var last = t.getLastRow();
    if (last < 2) return 0;
    var when = t.getRange(2, 1, last - 1, 1).getValues();
    var since = String(sinceIso || '').slice(0, 10);
    var n = 0;
    for (var i = 0; i < when.length; i++) { if (String(when[i][0]).slice(0, 10) >= since) n++; }
    return n;
  } catch (e) { return 0; }
}

/** A heads-up string when the SA public-holiday table is about to run out (so induction dates keep
 *  getting holiday-checked), else ''. Warns from October of the last covered year, and urgently once
 *  the current year is past the table. */
function _holidayTableWarning_() {
  var hs = CFG.SA_PUBLIC_HOLIDAYS || [];
  if (!hs.length) return '';
  var maxYear = 0;
  hs.forEach(function (h) { var y = parseInt(String(h).slice(0, 4), 10); if (y > maxYear) maxYear = y; });
  var now = new Date();
  if (now.getFullYear() > maxYear) {
    return 'The SA public-holiday table ended ' + maxYear + '. Add this year\'s holidays to SA_PUBLIC_HOLIDAYS (Config.js) - induction dates are no longer being holiday-checked against a real table.';
  }
  if (now.getFullYear() === maxYear && now.getMonth() >= 9) {
    return 'The SA public-holiday table ends ' + maxYear + '. Please add ' + (maxYear + 1) + '\'s holidays to SA_PUBLIC_HOLIDAYS (Config.js) before year-end so induction dates keep being holiday-checked.';
  }
  return '';
}

// tuesdayInductionNudge_ (the Tuesday-noon "book before 1:45" nudge) was removed when induction became
// auto-assigned from the FICA submission time. There is nothing for a candidate to book, so there is
// nothing to nudge. Its trigger is no longer installed (see setupTriggers) and inductionNudgeHtml_ was
// removed with it (see Email.js).

// ---------------------------------------------------------------- candidate induction page (read-only)

/** Serve the branded candidate induction page (doGet ?i=<folderId>). Token-less: the unguessable
 *  folderId is the credential. READ-ONLY since induction became auto-assigned - it shows the assigned
 *  Wed/Thu (or the auto-assign rule if none is set yet). No picker, no POST. */
function inductionPageHtml_(folderId) {
  var meta = readOnboardingByFolder_(folderId);
  var known = !!meta;
  var company = CFG.COMPANY[(meta && meta.entity)] || CFG.COMPANY.quay1;
  var companyName = htmlEsc_(company.name);
  var first = known ? htmlEsc_(firstName_(meta.name)) : '';
  var B = CFG.BRAND;

  // Read-only: induction is assigned automatically from the FICA submission time (Tuesday 14:00 SAST
  // cutoff - see assignInductionWeek_). This page no longer offers a picker; it just shows the status.
  var booked = known && !!(meta.induction_wed || meta.induction_thu);
  var statusBlock = booked
    ? '<div class="note ok show">You are booked for induction on ' +
        htmlEsc_(fmtDate_(meta.induction_wed)) +
        (meta.induction_thu ? ' and ' + htmlEsc_(fmtDate_(meta.induction_thu)) : '') +
        '. We look forward to seeing you there.</div>'
    : '<div class="note info show">Your induction week is assigned automatically once we receive your FICA. Submit your FICA before 14:00 on a Tuesday to join that week - FICA received after 14:00 on a Tuesday joins the following week. Your dates will be emailed to you as soon as they are set.</div>';

  var badLink = known ? '' :
    '<div class="note err show">This link is not recognised. Please use the personal link from your ' +
    companyName + ' email, or reply to that email for help.</div>';

  var html =
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>' + companyName + ' induction booking</title><style>' +
':root{--navy:' + B.navy + ';--navy-d:' + B.navyDark + ';--ink:' + B.ink + ';--slate:' + B.slate + ';--muted:#7A8296;' +
'--paper:' + B.paper + ';--card:#fff;--card2:#F4F7FC;--line:#D5E0F2;--r:12px;--r-sm:8px;' +
'--sans:Montserrat,system-ui,-apple-system,Arial,sans-serif;--gold:' + B.gold + ';--gold-ink:' + B.goldInk + ';' +
'--green:' + B.green + ';--green-t:' + B.greenT + ';--green-b:' + B.greenB + ';--red:' + B.red + ';--red-t:#FDECEA;--amber:' + B.amber + ';--amber-t:' + B.amberT + ';}' +
'*{box-sizing:border-box}body{margin:0;font-family:var(--sans);background:var(--paper);color:var(--ink);line-height:1.55}' +
'.wrap{max-width:640px;margin:0 auto;padding:26px 18px 60px}' +
'.hero{background:var(--navy);color:#fff;border-radius:var(--r);padding:26px 24px;margin:14px 0 20px}' +
'.hero h1{margin:0 0 6px;font-size:21px;font-weight:800;text-transform:uppercase;letter-spacing:.4px}' +
'.hero p{margin:0;font-size:14.5px;color:#D9E4F5}' +
'.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;margin-bottom:16px}' +
'.sec{font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--navy);margin:0 0 12px}' +
'.note{margin-top:14px;font-size:14px;padding:12px 14px;border-radius:var(--r-sm);display:none}' +
'.note.show{display:block}.note.ok{background:var(--green-t);color:var(--green);border:1px solid var(--green-b)}' +
'.note.err{background:var(--red-t);color:var(--red);border:1px solid #F5C6C0}' +
'.note.info{background:var(--amber-t);color:var(--amber);border:1px solid #F5E3B3}' +
'.foot{text-align:center;font-size:12px;color:var(--muted);margin-top:24px}' +
'@media (max-width:520px){.wrap{padding:16px 12px 44px}.hero{padding:20px 17px}.hero h1{font-size:18px}' +
'.card{padding:16px 15px}}' +
'@media (min-width:900px){.wrap{max-width:680px}}' +
'</style></head><body><div class="wrap">' +
'<div class="hero"><h1>' + companyName + '</h1>' +
'<p>' + (first ? ('Hi ' + first + '. ') : '') + 'Here is your induction information. Induction runs on the Wednesday and Thursday of your assigned week.</p></div>' +
badLink +
'<div class="card"><p class="sec">Your induction</p>' + statusBlock + '</div>' +
'<p class="foot">' + companyName + ' - we look forward to welcoming you.</p>' +
'</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('Quay 1 Induction')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------- date helpers

function _addDays_(d, n) { return new Date(d.getTime() + n * 24 * 60 * 60 * 1000); }

function _isoDate_(d) {
  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
  var dd = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + mm + '-' + dd;
}

/**
 * ASSIGN the induction week from a FICA submission timestamp. Pure + deterministic. Every comparison
 * is in the project timezone (Africa/Johannesburg / SAST) because Apps Script Date getters use the
 * project timezone - never UTC. The single source of truth for the cutoff rule.
 *
 * Cutoff = Tuesday 14:00 SAST:
 *   - Submitted BEFORE Tuesday 14:00:00 of a week -> that week's induction.
 *   - Submitted AT 14:00:00 or later on Tuesday, or on Wed..Mon -> the next upcoming Tuesday 14:00
 *     decides, so they land in the week of that Tuesday.
 * Induction runs Wednesday (day 1) + Thursday (day 2) = that week's Monday + 2 and Monday + 3.
 *
 * @param {string} submittedAtIso ISO timestamp of the FICA submission (a UTC 'Z' ISO is fine - the SAST
 *                                project timezone is applied by the Date getters). Blank/invalid -> now.
 * @return {{monday:string, wed:string, thu:string}} SAST ISO dates (YYYY-MM-DD).
 */
function assignInductionWeek_(submittedAtIso) {
  var d = submittedAtIso ? new Date(submittedAtIso) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  var day = d.getDay();                               // 0 Sun .. 6 Sat, in the SAST project timezone
  var diffToMon = (day === 0 ? -6 : 1 - day);
  var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMon);   // SAST 00:00 Monday
  var cutoff = new Date(monday.getTime() + (24 + 14) * 60 * 60 * 1000);            // Tuesday 14:00 SAST
  var assigned = d.getTime() < cutoff.getTime() ? monday : _addDays_(monday, 7);
  return {
    monday: _isoDate_(assigned),
    wed: _isoDate_(_addDays_(assigned, 2)),
    thu: _isoDate_(_addDays_(assigned, 3)),
  };
}

/** True if an ISO date (YYYY-MM-DD) is a SA public holiday listed in CFG.SA_PUBLIC_HOLIDAYS. */
function _isSaPublicHoliday_(iso) {
  return (CFG.SA_PUBLIC_HOLIDAYS || []).indexOf(String(iso || '').slice(0, 10)) >= 0;
}

/** Public-holiday flag for an assigned induction week. '' when neither day clashes. Otherwise a human
 *  note naming the clash - and it flags a date whose YEAR is not in the holiday table, so an un-updated
 *  year is never silently treated as holiday-free. We FLAG, never move (an admin decides). */
function _inductionHolidayFlag_(wed, thu) {
  var years = (CFG.SA_PUBLIC_HOLIDAYS || []).map(function (h) { return h.slice(0, 4); });
  var hits = [];
  [['Wed', wed], ['Thu', thu]].forEach(function (p) {
    var iso = String(p[1] || '').slice(0, 10);
    if (!iso) return;
    if (_isSaPublicHoliday_(iso)) hits.push(p[0] + ' ' + iso + ' is a SA public holiday');
    else if (years.indexOf(iso.slice(0, 4)) < 0) hits.push(p[0] + ' ' + iso + ' year not in holiday table - verify manually');
  });
  return hits.join('; ');
}

function _mondayOfThisWeek_() {
  var now = new Date();
  var day = now.getDay(); // 0 Sun .. 6 Sat
  var diff = (day === 0 ? -6 : 1 - day); // back to Monday
  var mon = _addDays_(now, diff);
  return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
}

