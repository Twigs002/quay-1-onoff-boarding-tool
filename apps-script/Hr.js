/**
 * Hr.js - mirror onboarding rows into the company "Quay 1 - HR Information Sheet" (18fBKK..., owned
 * by lieze@). This replaces the old aqua-contracts _hrAdd_ append with a two-stage flow the team
 * asked for:
 *
 *   1. TRACKING  - on contract creation, a row is upserted (keyed on ID number) into the shared
 *      "New Starters (Tracking)" tab with whatever is known so far. As FICA data lands, the same
 *      row is updated in place (upsert), so HR can watch a starter fill in.
 *   2. PROMOTE   - once FICA is complete, the finished row is COPIED (append-only) into the entity
 *      destination tab - "New Brokers (Automated)" for Quay 1, "New Aqua (Automated)" for Aqua -
 *      and the tracking row is marked "Moved". Promotion is idempotent (guarded by hr_promoted_at):
 *      it never double-appends. It is non-destructive on the live sheet: the tracking row is marked,
 *      not deleted.
 *
 * Column layout mirrors the sheet's existing "IGSICA EMPLOYEES" / "New Brokers (Automated)" tabs
 * verbatim (HR_HEADERS below), so a promoted row drops straight into HR's normal columns. The Aqua
 * and tracking tabs are auto-created from this same layout if they do not exist yet.
 *
 * SAFETY: every write is gated by the HR_SYNC_ENABLED flag (hrSyncEnabled_), INDEPENDENT of DRY_RUN
 * so HR mirroring can be validated / armed on its own without also arming Google/PropData account
 * creation. Default OFF: nothing is written to the live HR sheet - the intended action is logged via
 * logAudit_ and the function returns { dryRun:true }. All entry points are wrapped by callers in
 * try/catch so an HR-sync failure never breaks onboarding.
 *
 * Public surface:
 *   hrTrackingUpsert_(folderId)   - upsert this candidate's row into "New Starters (Tracking)".
 *   hrPromote_(folderId)          - copy a FICA-complete row into the entity destination tab (once).
 *   saIdBirthday_(idNumber)       - 'YYYY-MM-DD' birthday decoded from a 13-digit SA ID, or ''.
 *   isSaId_(idNumber)             - true for a 13-digit all-numeric SA ID.
 */

/** The HR sheet id: a Script Property override, else the known company sheet. Not a secret. */
function hrSheetId_() {
  return optProp_(PROP.HR_SHEET_ID) || '18fBKKsuKJSKKshJ47RHGC44eB_7vRADSy0nzS6Y6DyE';
}

/** Destination tab per entity + the shared staging tab. Match the live sheet's tab names exactly. */
var HR_TAB = {
  quay1: 'New Brokers (Automated)',
  aqua: 'New Aqua (Automated)',
  tracking: 'New Starters (Tracking)',
};

/** The canonical column layout, verbatim from the live "New Brokers (Automated)" / "IGSICA
 *  EMPLOYEES" tabs. Auto-created Aqua + tracking tabs get this exact header row so every automated
 *  tab lines up column-for-column. Column N of this array = column N+1 on the sheet. */
var HR_HEADERS = [
  'Name & Surname', 'Start Date', 'End/Current Date', 'Identification Number', 'Nationality',
  'Email Address', 'Contact Number', 'Birthday', 'Bank', 'Account Number', 'Type of account',
  'Income Tax Number', 'Residential Address', 'Designation', 'Senior Broker', 'ID/Passport Copy',
  'Work Permit Expiry', 'Non Disclosure Signed', 'Bank Confirmation', 'Proof Of Address',
  'ID Received', 'Agreement Received', 'Ryan Greeff Signed', 'Welcome Email Sent',
  'Calender Check: BIRTHDAY', 'Calender Check: WORK ANNIVERSARY', 'Next of Kin Name',
  'Next of Kin Contact Number', 'Next of Kin Relationship', 'Next of Kin Email',
  'FFC CERTIFICATE NUMBER', 'Team working', 'FFC Status',
];

/** The tracking tab carries one extra trailing status column so HR can see promotion state without
 *  it colliding with the frozen destination layout. */
var HR_TRACKING_STATUS_HEADER = 'Tracking status';

// ---------------------------------------------------------------- public entry points

/** Upsert the candidate's HR row into the shared tracking tab (keyed on ID number). Called on
 *  contract creation and again as FICA data arrives. DRY_RUN-safe; caller wraps in try/catch. */
function hrTrackingUpsert_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  var row = _hrBuildRow_(o);

  if (!hrSyncEnabled_()) {
    logAudit_('hr_tracking_dryrun', { folderId: folderId, name: o.name, id: o.id_number });
    return { ok: true, dryRun: true, would: 'upsert tracking row for ' + (o.name || o.id_number) };
  }

  var ss = SpreadsheetApp.openById(hrSheetId_());
  var sh = _hrEnsureTab_(ss, HR_TAB.tracking, true);
  var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
  var target = _hrFindRowByKey_(sh, keyCol, o.id_number);
  if (!target) target = Math.max(sh.getLastRow() + 1, 2);
  sh.getRange(target, 1, 1, HR_HEADERS.length).setNumberFormat('@').setValues([row]);
  sh.getRange(target, 1).setRichTextValue(_hrNameRich_(o));   // name (col A) -> link to their folder

  try { setOnboardingCell_(folderId, ONB_COL.hr_tracking_at, nowIso_()); } catch (e) { /* non-fatal */ }
  return { ok: true, row: target };
}

/** Copy a FICA-complete row into the entity destination tab (append-only, once). Idempotent via
 *  hr_promoted_at. Marks the tracking row "Moved <date>" (non-destructive). DRY_RUN-safe. */
function hrPromote_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  if (o.hr_promoted_at) return { ok: true, skipped: 'already promoted' };

  var entity = (o.entity === 'aqua') ? 'aqua' : 'quay1';
  var destName = HR_TAB[entity];
  var row = _hrBuildRow_(o);

  if (!hrSyncEnabled_()) {
    logAudit_('hr_promote_dryrun', { folderId: folderId, name: o.name, entity: entity, dest: destName });
    return { ok: true, dryRun: true, would: 'append ' + (o.name || o.id_number) + ' to "' + destName + '"' };
  }

  var ss = SpreadsheetApp.openById(hrSheetId_());
  var dest = _hrEnsureTab_(ss, destName, true);
  var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
  // Idempotent against the LIVE sheet, not just the hr_promoted_at marker: if a prior run appended
  // this person but its marker write failed, re-running must NOT duplicate the destination row.
  var existing = _hrFindRowByKey_(dest, keyCol, o.id_number);
  var target = existing || Math.max(dest.getLastRow() + 1, 2);
  dest.getRange(target, 1, 1, HR_HEADERS.length).setNumberFormat('@').setValues([row]);
  dest.getRange(target, 1).setRichTextValue(_hrNameRich_(o));   // name (col A) -> link to their folder

  // Mark the tracking row as moved (non-destructive) so HR sees it left the staging list.
  try {
    var track = _hrEnsureTab_(ss, HR_TAB.tracking, false);
    if (track) {
      var keyCol = HR_HEADERS.indexOf('Identification Number') + 1;
      var trow = _hrFindRowByKey_(track, keyCol, o.id_number);
      if (trow) {
        track.getRange(trow, HR_HEADERS.length + 1)
          .setNumberFormat('@').setValue('Moved to ' + destName + ' ' + fmtDate_(nowIso_()));
      }
    }
  } catch (e) { logAudit_('hr_tracking_mark_failed', { folderId: folderId, error: String(e) }); }

  // Log loudly if the idempotency marker fails to write - the append already landed, so a silent
  // failure here is the one thing that could let a retry re-touch the destination row.
  try { setOnboardingCell_(folderId, ONB_COL.hr_promoted_at, nowIso_()); }
  catch (e) { logAudit_('hr_promoted_marker_failed', { folderId: folderId, error: String(e) }); }
  logAudit_('hr_promoted', { folderId: folderId, name: o.name, entity: entity, dest: destName });
  return { ok: true, row: target, dest: destName };
}

// ---------------------------------------------------------------- row builder

/** Build the HR_HEADERS-ordered values array from an onboarding field object. Doc ticks in the
 *  boarding tracker are non-empty strings ("Received <iso>") when a doc is in, so a truthy check =
 *  received. Formula/manual HR columns (cal-checks, Ryan Greeff, welcome email) are left blank for
 *  HR to fill or for the sheet's own formulas. */
function _hrBuildRow_(o) {
  var received = function (v) { return String(v || '').trim() ? 'TRUE' : ''; };
  var sa = isSaId_(o.id_number);
  var nationality = String(o.nationality || '').trim() || (sa ? 'South African' : '');
  var birthday = String(o.birthday || '').trim() || (sa ? saIdBirthday_(o.id_number) : '');
  // A South African needs no work permit; show N/A to match the sheet's existing convention.
  var permit = String(o.work_permit_expiry || '').trim() || (sa ? 'N/A' : '');

  var map = {
    'Name & Surname': o.name,
    'Start Date': o.start_date,
    'End/Current Date': 'Current',
    'Identification Number': o.id_number,
    'Nationality': nationality,
    'Email Address': o.email,
    'Contact Number': o.contact,
    'Birthday': birthday,
    'Bank': o.bank_name,
    'Account Number': o.account_number,
    'Type of account': o.account_type,
    'Income Tax Number': o.tax_number,
    'Residential Address': o.residential_address,
    'Designation': o.designation,
    'Senior Broker': o.senior_name,
    'ID/Passport Copy': String(o.fica_id || '').trim() ? 'ID' : '',
    'Work Permit Expiry': permit,
    'Non Disclosure Signed': received(o.fica_nda),
    'Bank Confirmation': received(o.fica_bank),
    'Proof Of Address': received(o.fica_poa),
    'ID Received': received(o.fica_id),
    'Agreement Received': received(o.fica_contract),
    'Ryan Greeff Signed': '',
    'Welcome Email Sent': '',
    'Calender Check: BIRTHDAY': '',
    'Calender Check: WORK ANNIVERSARY': '',
    'Next of Kin Name': o.nok_name,
    'Next of Kin Contact Number': o.nok_contact,
    'Next of Kin Relationship': o.nok_relationship,
    'Next of Kin Email': o.nok_email,
    'FFC CERTIFICATE NUMBER': o.ffc_number,
    'Team working': o.team,
    // FFC status (full/candidate/none) - a Quay 1 concept only, so blank for Aqua contractors.
    'FFC Status': (String(o.entity) === 'quay1' ? String(o.ffc_status || '') : ''),
  };
  return HR_HEADERS.map(function (h) { var v = map[h]; return v == null ? '' : String(v); });
}

/** Rich-text value for the "Name & Surname" cell (column A): the person's name as a clickable
 *  hyperlink to their onboarding Drive folder (contract + FICA docs). Falls back to plain name text
 *  when the folder id is missing or unreadable. Applied AFTER the bulk row write, since setValues
 *  cannot carry a link. */
function _hrNameRich_(o) {
  var name = String((o && o.name) || '').trim() || 'Unnamed';
  var url = '';
  try { if (o && o.folderId) url = DriveApp.getFolderById(o.folderId).getUrl(); } catch (e) { url = ''; }
  // Surface a dropped link instead of silently writing a plain-text name: a missing/unreadable
  // folder id is the root cause of "HR folders not being linked", so leave an audit trail.
  if (!url) logAudit_('hr_name_link_missing', { name: name, folderId: (o && o.folderId) || '' });
  var b = SpreadsheetApp.newRichTextValue().setText(name);
  if (url) b.setLinkUrl(url);
  return b.build();
}

/**
 * Editor one-off: backfill the column-A name hyperlink onto existing HR rows (tracking + both
 * destination tabs). For every onboarding row it finds the matching HR row by Identification Number
 * and rewrites the name cell as a link to that person's folder. New/re-synced rows already get it;
 * this is for rows written before the link existed. Gated by HR sync. Safe to re-run.
 */
function backfillHrNameLinks() {
  if (!hrSyncEnabled_()) { Logger.log('HR sync OFF - not touching the HR sheet'); return 'HR sync OFF'; }
  var ss = SpreadsheetApp.openById(hrSheetId_());
  var keyCol = HR_HEADERS.indexOf('Identification Number') + 1;
  var out = {};
  Object.keys(HR_TAB).forEach(function (k) { out[HR_TAB[k]] = 0; });
  var rowsById = {};
  listOnboarding_().forEach(function (o) { if (o.id_number) rowsById[String(o.id_number).trim()] = o; });
  Object.keys(HR_TAB).forEach(function (k) {
    var name = HR_TAB[k], sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var keys = sh.getRange(2, keyCol, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      var o = rowsById[String(keys[i][0]).trim()];
      if (o) { sh.getRange(i + 2, 1).setRichTextValue(_hrNameRich_(o)); out[name]++; }
    }
  });
  logAudit_('hr_name_links_backfill', out);
  Logger.log(JSON.stringify(out, null, 2));
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- tab + row helpers

/**
 * Editor one-off: add the "FFC Status" header column to the EXISTING live HR tabs so their layout
 * matches the updated HR_HEADERS (auto-created tabs already get it). Adds it to the shared tracking
 * tab and the Quay 1 destination tab only - FFC is a Quay 1 concept, so the Aqua tab is left alone.
 * The tracking tab has a trailing "Tracking status" column sitting where FFC Status now goes, so we
 * INSERT a column there to push it right (no data lost); the destination tab just gets the header
 * appended. Idempotent - skips a tab that already has the header. Existing rows are NOT backfilled
 * (they populate on their next sync); run from the editor after deploying the code. Gated by HR sync.
 */
/** Editor diagnostic: log row 1 (headers) of each HR tab with absolute column numbers, so we can see
 *  the TRUE live layout vs HR_HEADERS. Read-only. Run from the editor and paste the log. */
function dumpHrHeaders() {
  var ss = SpreadsheetApp.openById(hrSheetId_());
  var out = [];
  [HR_TAB.tracking, HR_TAB.quay1, HR_TAB.aqua].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { out.push(name + ': NOT FOUND'); return; }
    var last = sh.getLastColumn();
    var hdr = sh.getRange(1, 1, 1, last).getValues()[0];
    var cells = hdr.map(function (h, i) { return (i + 1) + ':' + String(h == null ? '' : h).trim(); });
    out.push('=== ' + name + ' (' + last + ' cols) ===\n' + cells.join('  |  '));
  });
  var msg = out.join('\n\n');
  Logger.log(msg);
  return msg;
}

function migrateHrAddFfcStatus() {
  if (!hrSyncEnabled_()) { Logger.log('HR sync is OFF - not touching the HR sheet'); return 'HR sync OFF'; }
  var ffcCol = HR_HEADERS.indexOf('FFC Status') + 1;
  if (!ffcCol) { Logger.log('deploy the code first - FFC Status not in HR_HEADERS'); return 'FFC Status not in HR_HEADERS'; }
  var ss = SpreadsheetApp.openById(hrSheetId_());
  var out = [];
  [HR_TAB.tracking, HR_TAB.quay1].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { out.push(name + ': tab not found'); return; }
    if (String(sh.getRange(1, ffcCol).getValue()).trim() === 'FFC Status') { out.push(name + ': already has FFC Status'); return; }
    if (sh.getMaxColumns() < ffcCol) sh.insertColumnsAfter(sh.getMaxColumns(), ffcCol - sh.getMaxColumns());
    var occupant = String(sh.getRange(1, ffcCol).getValue()).trim();
    if (occupant) { sh.insertColumnBefore(ffcCol); }   // preserve whatever is there (e.g. Tracking status)
    sh.getRange(1, ffcCol).setValue('FFC Status').setFontWeight('bold');
    out.push(name + ': FFC Status set at col ' + ffcCol + (occupant ? ' (inserted; preserved "' + occupant + '")' : ''));
  });
  logAudit_('hr_add_ffc_status', { result: out });
  Logger.log(out.join('\n'));
  return out.join(' | ');
}

/** Get a tab by name; create it (with the HR_HEADERS header row, + the tracking status column for
 *  the tracking tab) when missing and `createIfMissing`. Returns null if absent and not creating. */
function _hrEnsureTab_(ss, name, createIfMissing) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  if (!createIfMissing) return null;
  sh = ss.insertSheet(name);
  var headers = HR_HEADERS.slice();
  if (name === HR_TAB.tracking) headers.push(HR_TRACKING_STATUS_HEADER);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/** Row number whose `keyCol` equals `key` (as text), or 0. Skips the header row. */
function _hrFindRowByKey_(sh, keyCol, key) {
  var k = String(key || '').trim();
  if (!k) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === k) return i + 2;
  }
  return 0;
}

// ---------------------------------------------------------------- SA ID helpers

/** True for a 13-digit, all-numeric South African ID number. */
function isSaId_(idNumber) {
  return /^\d{13}$/.test(String(idNumber || '').trim());
}

/** Decode the birthday ('YYYY-MM-DD') from a 13-digit SA ID (YYMMDD prefix). '' if not an SA ID or
 *  the date is impossible. Century pivot: YY <= current 2-digit year -> 2000s, else 1900s. */
function saIdBirthday_(idNumber) {
  var id = String(idNumber || '').trim();
  if (!isSaId_(id)) return '';
  var yy = parseInt(id.substr(0, 2), 10);
  var mm = parseInt(id.substr(2, 2), 10);
  var dd = parseInt(id.substr(4, 2), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  var pivot = new Date().getFullYear() % 100;
  var year = (yy <= pivot) ? 2000 + yy : 1900 + yy;
  var d = new Date(year, mm - 1, dd);
  if (d.getFullYear() !== year || d.getMonth() !== mm - 1 || d.getDate() !== dd) return '';
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return year + '-' + p(mm) + '-' + p(dd);
}

/** Luhn check over all 13 digits (the 13th is the check digit). SA IDs are Luhn-valid; this lets the
 *  repair below distinguish a genuinely dropped leading zero from a coincidental short number. */
function saIdChecksumOk_(id) {
  var s = String(id || '');
  if (!/^\d{13}$/.test(s)) return false;
  var sum = 0, alt = false;
  for (var i = s.length - 1; i >= 0; i--) {
    var d = parseInt(s.charAt(i), 10);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Classify + repair a stored ID/passport value WITHOUT touching a sheet (pure, so it is testable and
 * reused by both the Onboarding and HR repair scans). Returns { value, action }:
 *   'blank'      - empty; nothing to do.
 *   'passport'   - contains a letter; a passport, left exactly as-is.
 *   'ok'         - already a clean, checksum-valid 13-digit SA ID; no change.
 *   'normalized' - a valid 13-digit SA ID that carried spaces / dashes / a leading text-force
 *                  apostrophe; `value` is the cleaned 13 digits (safe to rewrite).
 *   'repaired'   - fewer than 13 digits whose leading zero(s) were dropped by a numeric Sheet cell;
 *                  `value` is the zero-restored 13-digit ID. Only returned when the restored ID is
 *                  BOTH Luhn-valid AND decodes to a real birthday, so a coincidence cannot be "fixed".
 *   'unfixable'  - numeric but no leading-zero padding yields a valid SA ID (13-digit bad checksum, or
 *                  too short/garbled). Left untouched and surfaced for a human to check.
 * Post-2000 SA IDs start with 0 (e.g. 06...), so a numeric cell silently drops that zero to 12 digits;
 * a year-2000 ID (00...) can lose two. That is the mangling this restores.
 */
function saIdRepair_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return { value: s, action: 'blank' };
  var t = s.replace(/^'/, '').replace(/[\s.\-]/g, ''); // drop text-force apostrophe + separators
  if (/[^0-9]/.test(t)) return { value: s, action: 'passport' };
  if (/^\d{13}$/.test(t)) {
    if (!saIdChecksumOk_(t)) return { value: s, action: 'unfixable' };
    return { value: t, action: (t === s ? 'ok' : 'normalized') };
  }
  if (t.length >= 11 && t.length < 13) {
    for (var pad = 1; pad <= 13 - t.length; pad++) {
      var cand = '';
      for (var z = 0; z < pad; z++) cand += '0';
      cand += t;
      if (saIdChecksumOk_(cand) && saIdBirthday_(cand)) return { value: cand, action: 'repaired' };
    }
  }
  return { value: s, action: 'unfixable' };
}

/**
 * Repair mangled Identification Number cells IN PLACE across the HR sheet's automated tabs (tracking +
 * both destination tabs). In-place (same row, same key column), so it never desyncs a row keyed on the
 * old value. Writes only when `apply === true` AND HR sync is armed (hrSyncEnabled_) - the same gate as
 * every other HR write; otherwise it previews. Called by repairMangledIds(); returns a per-tab summary.
 */
function repairHrIds_(apply) {
  var armed = apply === true && hrSyncEnabled_();
  var summary = { apply: armed, tabs: {} };
  var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
  var ss;
  try { ss = SpreadsheetApp.openById(hrSheetId_()); }
  catch (e) { logAudit_('hr_id_repair_failed', { error: String(e) }); summary.error = String(e); return summary; }

  Object.keys(HR_TAB).forEach(function (k) {
    var name = HR_TAB[k];
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var t = { scanned: 0, repaired: 0, normalized: 0, review: [] };
    summary.tabs[name] = t;
    var last = sh.getLastRow();
    if (last < 2) return;
    var vals = sh.getRange(2, keyCol, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var raw = vals[i][0];
      if (raw === '' || raw == null) continue;
      t.scanned++;
      var r = saIdRepair_(raw);
      if (r.action === 'repaired' || r.action === 'normalized') {
        t[r.action]++;
        if (armed) sh.getRange(i + 2, keyCol).setNumberFormat('@').setValue(r.value);
        logAudit_('hr_id_repair', { tab: name, row: i + 2, from: String(raw), to: r.value, action: r.action, apply: armed });
      } else if (r.action === 'unfixable') {
        t.review.push({ row: i + 2, value: String(raw) });
      }
    }
  });
  logAudit_('hr_id_repair_summary', summary);
  return summary;
}
