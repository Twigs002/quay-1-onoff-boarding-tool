// Proof that calendar date parsing (_dateAt_) accepts the HUMAN date format fmtDate_ stores for
// start_date ("16 September 2026"), so the work-anniversary event actually creates. Previously _dateAt_
// only accepted ISO, so every anniversary silently failed (start_date is persisted human-formatted).
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_calendar_startdate_format.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

console.log('=== calendar date parsing tolerates the stored (human) start_date format ===');

const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
g.getSheet('Onboarding');
const ctx = g.ctx;

// A. _dateAt_ unit checks: ISO, human (fmtDate_), "Month D, YYYY", and junk.
console.log('A. _dateAt_ parses ISO + human formats');
const iso = ctx._dateAt_('2026-09-16', 0);
check(!!iso && iso.getFullYear() === 2026 && iso.getMonth() === 8 && iso.getDate() === 16, 'ISO "2026-09-16" -> 16 Sep 2026');
const human = ctx._dateAt_('16 September 2026', 0);
check(!!human && human.getFullYear() === 2026 && human.getMonth() === 8 && human.getDate() === 16, 'human "16 September 2026" -> 16 Sep 2026');
const comma = ctx._dateAt_('September 16, 2026', 0);
check(!!comma && comma.getMonth() === 8 && comma.getDate() === 16, '"September 16, 2026" -> 16 Sep 2026');
check(ctx._dateAt_('', 0) === null && ctx._dateAt_('not a date', 0) === null, 'blank / junk -> null');

// B. End-to-end: a starter whose start_date is human-formatted still gets a work-anniversary series.
console.log('B. Human-format start_date -> work-anniversary event created');
ctx.upsertOnboardingRow_({ folderId: 'DF-1', entity: 'quay1', name: 'Shane Burger', email: 'shane@personal.com',
  birthday: '1990-05-10', start_date: '16 September 2026',
  induction_wed: '2026-12-16', induction_thu: '2026-12-17' });
const r = ctx.createOnboardingCalendarEvents_('DF-1', ctx.readOnboardingByFolder_('DF-1'));
check(r.created.indexOf('anniversary') >= 0, `anniversary created (${r.created.join(',')})`);
const anniv = g.calls.calendarEvents.find((e) => /^Work anniversary - Shane Burger/.test(e.title));
check(!!anniv && anniv.kind === 'series' && anniv.cal === 'Quay 1 Team Dates' && /joined 2026/.test(anniv.title), 'anniversary is a Team Dates series titled "(joined 2026)"');

// C. The backfill now fills anniversaries too for a human-format start_date.
console.log('C. Backfill creates the missing anniversary for a human-format start_date');
ctx.upsertOnboardingRow_({ folderId: 'DF-2', entity: 'quay1', name: 'Nicole van Tonder', email: 'nicole@personal.com',
  birthday: '1992-05-01', start_date: '17 September 2026' });
ctx.setOnboardingCell_('DF-2', ctx.ONB_COL.provisioned_at, '2026-09-01T08:00:00Z');
// Pretend the birthday was already backfilled (as in production) - only the anniversary is missing.
ctx.setOnboardingCell_('DF-2', ctx.ONB_COL.calendar_events_json, JSON.stringify({ birthday: 'ser_existing' }));
const bf = ctx.backfillTeamDates();
const added = bf.added.find((a) => a.folderId === 'DF-2');
check(!!added && added.created.indexOf('anniversary') >= 0 && added.created.indexOf('birthday') < 0, 'backfill adds ONLY the missing anniversary for DF-2');

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length})`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (_dateAt_ parses ISO + human start_date; anniversary events create; backfill fills them)');
process.exit(0);
