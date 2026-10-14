// Proof that the HR writes resolve destination columns BY HEADER NAME, not by a fixed HR_HEADERS
// position - so a human-maintained tab whose columns drift (reordered / renamed / a different layout
// like the Aqua tab) can no longer have values written into the wrong cell, and a drifted header is
// surfaced loudly instead of silently swallowed.
//
// Covers audit finding #2 (HIGH) + M1 + H3/2D:
//   - hrMarkWelcomeSent_   writes "Welcome Email Sent" into the NAMED column (Aqua reordered layout).
//   - hrTrackingUpsert_    writes every value into its NAMED column on a reordered tracking tab, leaves
//                          columns the tool does not own (a human column + "Tracking status") untouched.
//   - loud-fail            a tool field with no matching destination column logs hr_field_unmapped_failed
//                          (mirrored to the Alerts tab); the welcome column going missing fails loudly.
//   - repairHrIds_         keys the ID repair on the ACTUAL "Identification Number" column, never a fixed
//                          column 4 - so a tab whose column 4 is an account number is not mangled.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_hr_coupling.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

// Arm HR sync (the only gate for hrTrackingUpsert_ / hrMarkWelcomeSent_, independent of DRY_RUN).
const PROPS = Object.assign({}, DEFAULT_PROPS, { HR_SYNC_ENABLED: '1', DRY_RUN: '0' });

// Seed a tab's header row (row 1) and optional data rows in the in-memory mock spreadsheet.
function seedTab(g, name, headers, rows) {
  const sh = g.getSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  (rows || []).forEach((r, i) => {
    const line = headers.map((_, c) => (r[c] == null ? '' : r[c]));
    sh.getRange(2 + i, 1, 1, line.length).setValues([line]);
  });
  return sh;
}
// Read one cell (1-based) back out of the mock sheet as a string.
const cell = (g, name, row, col) => String(g.getSheet(name).getRange(row, col).getValue() || '');
// The audit kinds Logger.log recorded this run (logAudit_ writes "[audit] <iso> <kind> <json>").
const auditKinds = (g) => g.calls.logs.filter((l) => /^\[audit\]/.test(l));

console.log('=== HR header-driven coupling (no fixed-index writes to human tabs) ===');

// -- A. hrMarkWelcomeSent_ on the Aqua tab whose columns are in a DIFFERENT order than HR_HEADERS. ----
// In HR_HEADERS, "Identification Number" is col 4 and "Welcome Email Sent" is col 24. Here they are at
// col 5 and col 6. A fixed-index write would key off col 4 ("Contact Number") and miss, or write the
// date into col 24 (off the end). The named resolution must land it in col 6.
console.log('A. Aqua reordered tab -> welcome date lands in the NAMED column, not a fixed index');
{
  const g = loadGas({ props: PROPS, dryRun: false });
  g.getSheet('Onboarding');
  const aquaHeaders = ['Name & Surname', 'Personal Email', 'Part Time / Full Time', 'Contact Number',
    'Identification Number', 'Welcome Email Sent', 'Start Date', 'Birthday', 'Bank'];
  const ID = '8001015009087';
  seedTab(g, 'AQUA EMPLOYEES (Automated)', aquaHeaders,
    [['Brandon Hayward', 'brandon@personal.com', 'Full Time', '0821234567', ID, '', '2026-01-05', '', 'FNB']]);
  g.ctx.upsertOnboardingRow_({ folderId: 'WC-A', entity: 'aqua', name: 'Brandon Hayward',
    id_number: ID, email: 'brandon@personal.com', contact: '0821234567' });
  g.ctx.setOnboardingCell_('WC-A', g.ctx.ONB_COL.welcome_email_at, '2026-02-03');

  const r = g.ctx.hrMarkWelcomeSent_('WC-A');
  check(r.ok === true && r.tab === 'AQUA EMPLOYEES (Automated)', 'A: write reported against the Aqua tab');
  check(cell(g, 'AQUA EMPLOYEES (Automated)', 2, 6) === '3 February 2026', 'A: welcome date in the NAMED "Welcome Email Sent" column (col 6)');
  check(cell(g, 'AQUA EMPLOYEES (Automated)', 2, 4) === '0821234567', 'A: "Contact Number" (fixed-index col 4) was NOT clobbered');
  check(cell(g, 'AQUA EMPLOYEES (Automated)', 2, 5) === ID, 'A: "Identification Number" cell left intact');
}

// -- B. hrMarkWelcomeSent_ when the welcome column is renamed away -> loud-fail, no guessed write. -----
console.log('B. Welcome column missing -> loud hr_field_unmapped_failed, nothing written');
{
  const g = loadGas({ props: PROPS, dryRun: false });
  g.getSheet('Onboarding');
  const ID = '8001015009087';
  // No "Welcome Email Sent" column (renamed to "Welcome Sent On"); the person IS on the tab.
  seedTab(g, 'AQUA EMPLOYEES (Automated)',
    ['Name & Surname', 'Identification Number', 'Welcome Sent On'],
    [['Brandon Hayward', ID, '']]);
  g.ctx.upsertOnboardingRow_({ folderId: 'WC-B', entity: 'aqua', name: 'Brandon Hayward', id_number: ID });
  g.ctx.setOnboardingCell_('WC-B', g.ctx.ONB_COL.welcome_email_at, '2026-02-03');

  const r = g.ctx.hrMarkWelcomeSent_('WC-B');
  check(r.ok === false && /Welcome Email Sent/.test(String(r.error || '')), 'B: returns a clear error instead of writing');
  check(cell(g, 'AQUA EMPLOYEES (Automated)', 2, 3) === '', 'B: the look-alike "Welcome Sent On" column was NOT written');
  const alerted = auditKinds(g).some((l) => /hr_field_unmapped_failed/.test(l) && /"field":"Welcome Email Sent"/.test(l));
  check(alerted, 'B: logged hr_field_unmapped_failed for "Welcome Email Sent"');
  check(g.getSheet('Alerts').getLastRow() >= 2, 'B: alert mirrored to the visible Alerts tab');
}

// -- C. hrTrackingUpsert_ on a reordered tracking tab -> every value in its NAMED column; the human ----
// column and the trailing "Tracking status" are left untouched; no spurious unmapped alerts.
console.log('C. Reordered tracking tab -> values land by name; human + status columns untouched');
{
  const g = loadGas({ props: PROPS, dryRun: false });
  g.getSheet('Onboarding');
  // A human column up front, HR_HEADERS reversed (a thorough shuffle), the status column at the end.
  const HR_HEADERS = g.ctx.HR_HEADERS;
  const STATUS = g.ctx.HR_TRACKING_STATUS_HEADER;
  const trackHeaders = ['HR Notes'].concat(HR_HEADERS.slice().reverse()).concat([STATUS]);
  const idIdx = trackHeaders.indexOf('Identification Number');   // 0-based
  const statusIdx = trackHeaders.length - 1;
  const ID = '8001015009087';
  // Pre-seed the candidate's row so this exercises the UPDATE (find-by-key) path, with values in the
  // columns the tool must NOT touch.
  const seedRow = trackHeaders.map(() => '');
  seedRow[0] = 'keep me';            // HR Notes (human column)
  seedRow[idIdx] = ID;               // Identification Number
  seedRow[statusIdx] = 'was here';   // Tracking status
  seedTab(g, 'New Starters (Tracking)', trackHeaders, [seedRow]);

  g.ctx.upsertOnboardingRow_({ folderId: 'TK-C', entity: 'quay1', name: 'Reorder Test',
    id_number: ID, email: 'reorder@test.com', contact: '0829998888', start_date: '2026-01-05', birthday: '1980-01-01' });

  const r = g.ctx.hrTrackingUpsert_('TK-C');
  check(r.ok === true && r.row === 2, 'C: updated the existing (keyed) row 2');
  const at = (header) => cell(g, 'New Starters (Tracking)', 2, trackHeaders.indexOf(header) + 1);
  check(at('Name & Surname') === 'Reorder Test', 'C: Name landed in its NAMED column');
  check(at('Identification Number') === ID, 'C: ID preserved in its NAMED column');
  check(at('Contact Number') === '0829998888', 'C: Contact landed in its NAMED column');
  check(at('Email Address') === 'reorder@test.com', 'C: Email landed in its NAMED column');
  check(at('Birthday') === '1980-01-01', 'C: Birthday landed in its NAMED column');
  check(cell(g, 'New Starters (Tracking)', 2, 1) === 'keep me', 'C: human "HR Notes" column untouched');
  check(cell(g, 'New Starters (Tracking)', 2, statusIdx + 1) === 'was here', 'C: "Tracking status" column untouched');
  check(!auditKinds(g).some((l) => /hr_field_unmapped_failed/.test(l)), 'C: no spurious unmapped-field alert on a fully-present layout');
}

// -- D. hrTrackingUpsert_ when a tool field's column is renamed -> that field is surfaced loudly. ------
console.log('D. Tracking tab with "Birthday" renamed -> hr_field_unmapped_failed for Birthday');
{
  const g = loadGas({ props: PROPS, dryRun: false });
  g.getSheet('Onboarding');
  const HR_HEADERS = g.ctx.HR_HEADERS;
  const STATUS = g.ctx.HR_TRACKING_STATUS_HEADER;
  // Full canonical layout EXCEPT "Birthday" is renamed to "Date of Birth" (a drifted header).
  const headers = HR_HEADERS.map((h) => (h === 'Birthday' ? 'Date of Birth' : h)).concat([STATUS]);
  const ID = '8001015009087';
  seedTab(g, 'New Starters (Tracking)', headers, []);
  g.ctx.upsertOnboardingRow_({ folderId: 'TK-D', entity: 'quay1', name: 'Drift Birthday',
    id_number: ID, email: 'drift@test.com', birthday: '1985-05-05' });

  const r = g.ctx.hrTrackingUpsert_('TK-D');
  check(r.ok === true, 'D: upsert still succeeds for the mappable columns');
  const unmapped = auditKinds(g).filter((l) => /hr_field_unmapped_failed/.test(l));
  check(unmapped.length === 1 && /"field":"Birthday"/.test(unmapped[0]), 'D: exactly one loud alert, for "Birthday"');
  check(cell(g, 'New Starters (Tracking)', 2, headers.indexOf('Date of Birth') + 1) === '', 'D: the renamed "Date of Birth" column was NOT written');
  check(cell(g, 'New Starters (Tracking)', 2, headers.indexOf('Name & Surname') + 1) === 'Drift Birthday', 'D: mappable field (Name) still landed');
}

// -- E. hrTrackingUpsert_ when the KEY column is missing -> hard loud-fail, no write. ------------------
console.log('E. Tracking tab missing "Identification Number" -> loud hr_tracking_key_col_failed');
{
  const g = loadGas({ props: PROPS, dryRun: false });
  g.getSheet('Onboarding');
  seedTab(g, 'New Starters (Tracking)', ['Name & Surname', 'ID No', 'Email Address'], []);
  g.ctx.upsertOnboardingRow_({ folderId: 'TK-E', entity: 'quay1', name: 'No Key', id_number: '8001015009087', email: 'nokey@test.com' });

  const r = g.ctx.hrTrackingUpsert_('TK-E');
  check(r.ok === false && /Identification Number/.test(String(r.error || '')), 'E: returns a clear error, does not write to the wrong column');
  check(auditKinds(g).some((l) => /hr_tracking_key_col_failed/.test(l)), 'E: logged hr_tracking_key_col_failed');
  check(g.getSheet('New Starters (Tracking)').getLastRow() === 1, 'E: no data row was appended');
}

// -- F. repairHrIds_ keys the ID repair on the NAMED ID column, never a fixed column 4. ----------------
// Column 4 here is "Account Number"; the real ID is at column 5. The repair must scan column 5 (and
// surface its unfixable value for review), and never touch the account-number column.
console.log('F. repairHrIds_ -> keys on the NAMED ID column (col 5), not fixed column 4');
{
  const g = loadGas({ props: PROPS, dryRun: false });
  const ACCOUNT = '12345678901234';   // col 4, a 14-digit account number - must be left alone
  const BAD_ID = '1234567890123';     // col 5, a 13-digit value with a bad checksum -> 'unfixable' (review)
  seedTab(g, 'IGSICA EMPLOYEES (Automated)',
    ['Name & Surname', 'Start Date', 'End/Current Date', 'Account Number', 'Identification Number'],
    [['Someone', '2026-01-01', 'Current', ACCOUNT, BAD_ID]]);

  const summary = g.ctx.repairHrIds_(true);
  const t = summary.tabs['IGSICA EMPLOYEES (Automated)'];
  const reviewed = (t && t.review ? t.review : []).map((x) => String(x.value));
  check(reviewed.indexOf(BAD_ID) >= 0, 'F: the col-5 ID value was scanned (surfaced for review)');
  check(reviewed.indexOf(ACCOUNT) < 0, 'F: the col-4 account number was NOT scanned as an ID');
  check(cell(g, 'IGSICA EMPLOYEES (Automated)', 2, 4) === ACCOUNT, 'F: the account-number column was left untouched');
}

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length})`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (HR writes resolve columns by header name; drift fails loudly; ID repair keys the real ID column)');
process.exit(0);
