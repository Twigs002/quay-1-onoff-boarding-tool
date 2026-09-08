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
  // HR rows are keyed on the ID number (_hrFindRowByKey_). With a blank id every call would fail to
  // find the prior row and blind-append a fresh keyless one, duplicating the person. id_number is
  // required + captured at contract stage, so a blank here is a data error - refuse + log, do not append.
  if (!String(o.id_number || '').trim()) {
    logAudit_('hr_skip_blank_id', { fn: 'hrTrackingUpsert_', folderId: folderId, name: o.name });
    return { ok: false, error: 'blank id_number - refusing to write a keyless HR tracking row' };
  }
  var row = _hrBuildRow_(o);

  if (!hrSyncEnabled_()) {
    // Previewable dry-run: surface the exact fields that WOULD be written to the HR sheet, so the
    // write can be reviewed before HR_SYNC is armed. The five contract-stage HR fields are named
    // explicitly; the full HR_HEADERS-ordered row is included for a complete preview.
    var preview = {
      name: o.name, id_number: o.id_number, contact: o.contact, email: o.email, start_date: o.start_date,
    };
    logAudit_('hr_tracking_dryrun', { folderId: folderId, tab: HR_TAB.tracking, fields: preview });
    return { ok: true, dryRun: true, tab: HR_TAB.tracking,
      would: 'upsert tracking row for ' + (o.name || o.id_number), fields: preview, row: row };
  }

  // Serialise the find-last-row -> write span: a concurrent upsert/promote for the same person must not
  // both compute "append at lastRow+1" and clobber each other. Reentrant-safe (see _acquireLock_), so a
  // locked caller (approveAndProvision_ / provisionReadyBatch_) nesting through here does not deadlock.
  var lock = _acquireLock_();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.openById(hrSheetId_());
    var sh = _hrEnsureTab_(ss, HR_TAB.tracking, true);
    var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
    var target = _hrFindRowByKey_(sh, keyCol, o.id_number);
    if (!target) target = Math.max(sh.getLastRow() + 1, 2);
    sh.getRange(target, 1, 1, HR_HEADERS.length).setNumberFormat('@').setValues([row]);
    sh.getRange(target, 1).setRichTextValue(_hrNameRich_(o));   // name (col A) -> link to their folder

    try { setOnboardingCell_(folderId, ONB_COL.hr_tracking_at, nowIso_()); } catch (e) { /* non-fatal */ }
    return { ok: true, row: target };
  } finally {
    lock.releaseLock();
  }
}

/** Copy a FICA-complete row into the entity destination tab (append-only, once). Idempotent via
 *  hr_promoted_at. Marks the tracking row "Moved <date>" (non-destructive). DRY_RUN-safe. */
function hrPromote_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  // Append-only writer keyed on the ID number: a blank id would append a new keyless active-tab row on
  // every call (the marker-vs-live reconcile below sees existing=0 and re-appends). Refuse + log instead.
  if (!String(o.id_number || '').trim()) {
    logAudit_('hr_skip_blank_id', { fn: 'hrPromote_', folderId: folderId, name: o.name });
    return { ok: false, error: 'blank id_number - refusing to append a keyless HR destination row' };
  }

  var entity = (o.entity === 'aqua') ? 'aqua' : 'quay1';
  var destName = HR_TAB[entity];
  var row = _hrBuildRow_(o);

  if (!hrSyncEnabled_()) {
    logAudit_('hr_promote_dryrun', { folderId: folderId, name: o.name, entity: entity, dest: destName });
    return { ok: true, dryRun: true, would: 'append ' + (o.name || o.id_number) + ' to "' + destName + '"' };
  }

  // Serialise find-last-row -> append so two promotions cannot both target lastRow+1. Reentrant-safe,
  // so nesting under a locked caller (approveAndProvision_ / provisionReadyBatch_) does not deadlock.
  var lock = _acquireLock_();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.openById(hrSheetId_());
    var dest = _hrEnsureTab_(ss, destName, true);
    var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
    // Reconcile against the LIVE sheet, not just the hr_promoted_at marker. Three cases:
    //  - marker set AND the destination row still exists -> already correctly promoted; return WITHOUT
    //    overwriting, so HR-owned columns _hrBuildRow_ leaves blank (Ryan Greeff, cal-checks) are kept.
    //  - marker set BUT the destination row has vanished (deleted/moved - the Shane incident) -> re-append
    //    so HR's active tab is restored instead of silently missing them forever.
    //  - marker not set -> normal first promotion (write in place if a stray row exists, else append).
    var existing = _hrFindRowByKey_(dest, keyCol, o.id_number);
    if (o.hr_promoted_at && existing) {
      return { ok: true, skipped: 'already promoted', row: existing, dest: destName };
    }
    var target = existing || Math.max(dest.getLastRow() + 1, 2);
    dest.getRange(target, 1, 1, HR_HEADERS.length).setNumberFormat('@').setValues([row]);
    dest.getRange(target, 1).setRichTextValue(_hrNameRich_(o));   // name (col A) -> link to their folder

    // Mark the tracking row as moved (non-destructive) so HR sees it left the staging list.
    try {
      var track = _hrEnsureTab_(ss, HR_TAB.tracking, false);
      if (track) {
        var tKeyCol = HR_HEADERS.indexOf('Identification Number') + 1;
        var trow = _hrFindRowByKey_(track, tKeyCol, o.id_number);
        if (trow) {
          track.getRange(trow, HR_HEADERS.length + 1)
            .setNumberFormat('@').setValue('Moved to ' + destName + ' ' + fmtDate_(nowIso_()));
        }
      }
    } catch (e) { logAudit_('hr_tracking_mark_failed', { folderId: folderId, error: String(e) }); }

    // Log loudly if the idempotency marker fails to write - the append already landed, so a silent
    // failure here is the one thing that could let a retry re-touch the destination row.
    var restored = !!(o.hr_promoted_at && !existing);
    try { setOnboardingCell_(folderId, ONB_COL.hr_promoted_at, nowIso_()); }
    catch (e) { logAudit_('hr_promoted_marker_failed', { folderId: folderId, error: String(e) }); }
    logAudit_(restored ? 'hr_promoted_restored' : 'hr_promoted',
      { folderId: folderId, name: o.name, entity: entity, dest: destName });
    return { ok: true, row: target, dest: destName, restored: restored };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Refresh an ALREADY-promoted candidate's destination-tab row IN PLACE (never appends) with current
 * onboarding data. Only non-empty freshly-built values overwrite; where the row builder has nothing to
 * say the existing cell is kept - that is what protects the HR-owned columns the builder leaves blank
 * (Ryan Greeff Signed, Welcome Email Sent, the calendar checks) from being clobbered. No-op when the
 * person has no destination row yet: that first copy is hrPromote_'s job.
 *
 * This is what makes FICA (or an admin edit) that lands AFTER promotion actually show up on the entity
 * tab. Without it, hrPromote_ self-guards on hr_promoted_at and later doc ticks only ever reach the
 * tracking tab - the exact reason an imported Aqua contractor's later FICA never appeared on
 * "New Aqua (Automated)". DRY_RUN-safe (gated by hrSyncEnabled_); callers wrap in try/catch.
 */
function hrRefreshDest_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  var entity = (o.entity === 'aqua') ? 'aqua' : 'quay1';
  var destName = HR_TAB[entity];

  if (!hrSyncEnabled_()) {
    logAudit_('hr_refresh_dryrun', { folderId: folderId, name: o.name, dest: destName });
    return { ok: true, dryRun: true };
  }

  // Serialise the find-row -> read-merge -> write span so a concurrent promote/upsert cannot move the
  // row out from under us between the lookup and the write. Reentrant-safe (see _acquireLock_).
  var lock = _acquireLock_();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.openById(hrSheetId_());
    var dest = ss.getSheetByName(destName);
    if (!dest) return { ok: true, skipped: 'dest tab missing' };
    var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
    var target = _hrFindRowByKey_(dest, keyCol, o.id_number);
    if (!target) return { ok: true, skipped: 'no destination row yet' }; // never promoted; leave to hrPromote_

    var built = _hrBuildRow_(o);
    var existing = dest.getRange(target, 1, 1, HR_HEADERS.length).getValues()[0];
    // Merge: a non-empty freshly-built value wins; otherwise keep what HR has on the sheet.
    var merged = built.map(function (v, i) { return String(v).trim() ? v : existing[i]; });
    dest.getRange(target, 1, 1, HR_HEADERS.length).setNumberFormat('@').setValues([merged]);
    dest.getRange(target, 1).setRichTextValue(_hrNameRich_(o));   // keep the folder link fresh too
    logAudit_('hr_refresh_dest', { folderId: folderId, name: o.name, dest: destName, row: target });
    return { ok: true, row: target };
  } finally {
    lock.releaseLock();
  }
}

/** Set the "Welcome Email Sent" cell on the candidate's HR row, called when the welcome pack actually
 *  sends (Quay 1 induction packet / Aqua welcome). Because HR promotion happens earlier (on
 *  acceptance), the row usually already exists on the entity destination tab; we update it in place,
 *  falling back to the staging tracking tab, and no-op if neither exists yet (a later promotion will
 *  pick the value up from welcome_email_at via _hrBuildRow_). DRY_RUN/HR_SYNC-safe; caller wraps in
 *  try/catch. */
function hrMarkWelcomeSent_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  if (!hrSyncEnabled_()) {
    logAudit_('hr_welcome_sent_dryrun', { folderId: folderId, name: o.name });
    return { ok: true, dryRun: true, would: 'mark Welcome Email Sent for ' + (o.name || o.id_number) };
  }
  var ss = SpreadsheetApp.openById(hrSheetId_());
  var keyCol = HR_HEADERS.indexOf('Identification Number') + 1;
  var col = HR_HEADERS.indexOf('Welcome Email Sent') + 1;
  var val = fmtDate_(o.welcome_email_at || nowIso_());
  var entity = (o.entity === 'aqua') ? 'aqua' : 'quay1';
  var tabs = [HR_TAB[entity], HR_TAB.tracking];   // prefer the "active" destination tab, else staging
  for (var i = 0; i < tabs.length; i++) {
    var sh = _hrEnsureTab_(ss, tabs[i], false);
    if (!sh) continue;
    var row = _hrFindRowByKey_(sh, keyCol, o.id_number);
    if (row) {
      sh.getRange(row, col).setNumberFormat('@').setValue(val);
      return { ok: true, tab: tabs[i], row: row };
    }
  }
  return { ok: true, skipped: 'no HR row yet - reflected on promotion' };
}

// ---------------------------------------------------------------- row builder

/** Build the HR_HEADERS-ordered values array from an onboarding field object. Doc ticks in the
 *  boarding tracker are non-empty strings ("Received <iso>") when a doc is in, so a truthy check =
 *  received. "Welcome Email Sent" is auto-stamped from welcome_email_at; the remaining formula/manual
 *  HR columns (cal-checks, Ryan Greeff) are left blank for HR to fill or for the sheet's own formulas. */
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
    'Welcome Email Sent': o.welcome_email_at ? fmtDate_(o.welcome_email_at) : '',
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

// ---------------------------------------------------------------- work-permit expiry alerts

/** Whole days from today (script-local midnight) until a stored work_permit_expiry, or null when the
 *  value is not a parseable date. Stored format is 'YYYY-MM-DD' - the value comes straight from the
 *  FICA page's <input type="date"> (Fica.js), persisted verbatim as text (Tracker _putOnb_). Using
 *  Date.UTC for both endpoints cancels the timezone so the difference is whole calendar days. */
function _workPermitDaysLeft_(expiry) {
  var s = String(expiry == null ? '' : expiry).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  var expUtc = Date.UTC(y, mo - 1, d);
  var chk = new Date(expUtc);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  var now = new Date();
  var todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((expUtc - todayUtc) / 86400000);
}

/**
 * Weekly HR alert for work permits that are expiring soon or have already lapsed. Nothing else ever
 * re-reads work_permit_expiry after FICA captures it, so without this a permit can quietly expire while
 * the person keeps access. Scans the onboarding rows, keeps active staff (provisioned_at set) whose
 * permit is within CFG.WORK_PERMIT_ALERT_DAYS of expiry or already past it, and - when any are found -
 * sends ONE digest to CFG.WORK_PERMIT_ALERT_TO listing each person soonest-first.
 *
 * Stateless / idempotent-by-cadence: no columns, no per-row marker. It only emails when someone is in
 * window, so a weekly run is a natural non-spammy reminder cadence. Follows the DRY_RUN pattern of
 * _requestManualAccount_ / _maybeNotifyAquaAccepted_ (Provisioning.js): in DRY_RUN it DRAFTS (previewable),
 * when armed it sends. Never throws - wrapped in try/catch, failures go to logAudit_. Returns a small
 * summary object { ok, count, dryRun, alerted:[{name,id,daysLeft}] }.
 */
function workPermitExpirySweep_() {
  try {
    var horizon = Number(CFG.WORK_PERMIT_ALERT_DAYS);
    if (isNaN(horizon)) horizon = 30;

    // Active, non-legacy staff only: skip migrated-legacy imports and abandoned drafts (no provisioned_at).
    var rows = listOnboarding_(function (o) {
      if (_isMigratedLegacy_(o)) return false;
      if (!String(o.provisioned_at || '').trim()) return false;
      return String(o.work_permit_expiry || '').trim() !== '';
    });

    var items = [];
    rows.forEach(function (o) {
      var daysLeft = _workPermitDaysLeft_(o.work_permit_expiry);
      if (daysLeft == null) {
        logAudit_('work_permit_unparsable', { folderId: o.folderId, name: o.name, value: String(o.work_permit_expiry) });
        return;
      }
      if (daysLeft <= horizon) {
        items.push({
          name: o.name || o.id_number || '(unnamed)',
          entity: o.entity || '',
          expiry: String(o.work_permit_expiry).trim(),
          daysLeft: daysLeft,
          id_number: o.id_number || '',
        });
      }
    });

    if (!items.length) {
      logAudit_('work_permit_sweep', { count: 0 });
      return { ok: true, count: 0, dryRun: DRY_RUN_(), alerted: [] };
    }

    // Soonest-first: most-expired at the top, then nearest expiry.
    items.sort(function (a, b) { return a.daysLeft - b.daysLeft; });

    var recipients = (CFG.WORK_PERMIT_ALERT_TO || []).filter(Boolean);
    var alerted = items.map(function (it) { return { name: it.name, id: it.id_number, daysLeft: it.daysLeft }; });

    if (!recipients.length) {
      logAudit_('work_permit_no_recipients', { count: items.length, alerted: alerted });
      return { ok: false, count: items.length, error: 'no recipients', alerted: alerted };
    }

    var company = (CFG.COMPANY && CFG.COMPANY.quay1) || { name: 'Quay 1', full: 'Quay 1 International Realty' };
    var subject = 'Work permit expiry alert - ' + items.length + ' to review';
    var lines = items.map(function (it) {
      var when = (it.daysLeft < 0)
        ? ('EXPIRED ' + Math.abs(it.daysLeft) + ' day' + (Math.abs(it.daysLeft) === 1 ? '' : 's') + ' ago')
        : (it.daysLeft === 0) ? 'expires today'
        : (it.daysLeft + ' day' + (it.daysLeft === 1 ? '' : 's') + ' left');
      return '- ' + it.name + (it.entity ? ' (' + it.entity + ')' : '') +
        ': permit expiry ' + fmtDate_(it.expiry) + ', ' + when;
    });
    var plain = 'The following staff have a work permit that has expired or is expiring soon.\n' +
      'Please follow up so nobody keeps access on a lapsed permit.\n\n' + lines.join('\n') +
      '\n\nThanks,\nThe ' + company.name + ' Team';
    var opts = { name: company.name, htmlBody: workPermitAlertHtml_(company, items) };

    if (DRY_RUN_()) {
      // Test mode: DRAFT only (previewable), mirroring _requestManualAccount_ / _maybeNotifyAquaAccepted_.
      GmailApp.createDraft(recipients.join(','), subject, plain, opts);
      logAudit_('work_permit_sweep_drafted', { count: items.length, to: recipients.join(','), alerted: alerted });
      return { ok: true, count: items.length, dryRun: true, alerted: alerted };
    }
    GmailApp.sendEmail(recipients.join(','), subject, plain, opts);
    logAudit_('work_permit_sweep_sent', { count: items.length, to: recipients.join(','), alerted: alerted });
    return { ok: true, count: items.length, dryRun: false, alerted: alerted };
  } catch (err) {
    logAudit_('work_permit_sweep_failed', { error: String(err) });
    return { ok: false, error: String(err) };
  }
}
