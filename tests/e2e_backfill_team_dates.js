// Proof of the one-time Team Dates backfill (backfillTeamDates): it adds birthday + work-anniversary
// events for already-provisioned Quay 1 starters who are missing them, WITHOUT creating induction-day
// invites (teamDatesOnly). Idempotent, Quay 1 + provisioned only, DRY_RUN-safe.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_backfill_team_dates.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

console.log('=== Team Dates backfill (backfillTeamDates) ===');

const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
g.getSheet('Onboarding');
const ctx = g.ctx;
const prov = (fid) => ctx.setOnboardingCell_(fid, ctx.ONB_COL.provisioned_at, '2026-09-01T08:00:00Z');

// Provisioned Quay 1 starter, has birthday + start date, NO calendar events yet, PAST induction week.
ctx.upsertOnboardingRow_({ folderId: 'BF-1', entity: 'quay1', name: 'Wendy Ware', email: 'wendy@personal.com',
  birthday: '1994-05-10', start_date: '2026-09-14', induction_wed: '2026-09-16', induction_thu: '2026-09-17' });
prov('BF-1');
// Provisioned starter who ALREADY has both team-date events (must be skipped).
ctx.upsertOnboardingRow_({ folderId: 'BF-2', entity: 'quay1', name: 'Al Ready', email: 'al@personal.com',
  birthday: '1990-01-01', start_date: '2026-09-14', calendar_events_json: JSON.stringify({ birthday: 'ser_x', anniversary: 'ser_y' }) });
prov('BF-2');
// NOT provisioned (still in pipeline) -> skipped.
ctx.upsertOnboardingRow_({ folderId: 'BF-3', entity: 'quay1', name: 'Nel Notyet', email: 'nel@personal.com', birthday: '1992-02-02', start_date: '2026-09-14' });
// Aqua provisioned -> skipped (no induction/team dates).
ctx.upsertOnboardingRow_({ folderId: 'BF-4', entity: 'aqua', name: 'Ada Aqua', email: 'ada@personal.com', birthday: '1993-03-03', start_date: '2026-09-14' });
prov('BF-4');
// Provisioned but NO birthday/start date -> nothing to create.
ctx.upsertOnboardingRow_({ folderId: 'BF-5', entity: 'quay1', name: 'Dana Nodata', email: 'dana@personal.com' });
prov('BF-5');

console.log('A. Backfill run');
const r = ctx.backfillTeamDates();
check(r.added.length === 1 && r.added[0].folderId === 'BF-1', `only the eligible starter got events (${r.added.map((a) => a.folderId).join(',') || 'none'})`);
check(r.events === 2, `two events created (birthday + anniversary), got ${r.events}`);

const evs = g.calls.calendarEvents;
const team = evs.filter((e) => e.cal === 'Quay 1 Team Dates');
const inductions = evs.filter((e) => e.cal === 'Quay 1 Inductions');
check(team.some((e) => /^Birthday - Wendy Ware/.test(e.title) && e.kind === 'series'), 'birthday series created on Team Dates');
check(team.some((e) => /^Work anniversary - Wendy Ware/.test(e.title) && e.kind === 'series'), 'work-anniversary series created on Team Dates');
check(inductions.length === 0, 'NO induction-day events created (teamDatesOnly - no stale invites for past induction)');

const storedBF1 = JSON.parse(ctx.readOnboardingByFolder_('BF-1').calendar_events_json || '{}');
check(storedBF1.birthday && storedBF1.anniversary && !storedBF1.day1 && !storedBF1.day2, 'BF-1 row stores birthday + anniversary ids only');

console.log('B. Re-run is idempotent');
const before = g.calls.calendarEvents.length;
const r2 = ctx.backfillTeamDates();
check(r2.added.length === 0 && r2.events === 0, 're-run creates nothing new');
check(g.calls.calendarEvents.length === before, 'no additional calendar events on re-run');

console.log('C. DRY_RUN backfill creates nothing');
const dry = loadGas({ props: DEFAULT_PROPS, dryRun: true });
dry.getSheet('Onboarding');
dry.ctx.upsertOnboardingRow_({ folderId: 'BF-D', entity: 'quay1', name: 'Dry Run', email: 'dry@personal.com', birthday: '1994-05-10', start_date: '2026-09-14' });
dry.ctx.setOnboardingCell_('BF-D', dry.ctx.ONB_COL.provisioned_at, '2026-09-01T08:00:00Z');
const rD = dry.ctx.backfillTeamDates();
check(dry.calls.calendarEvents.length === 0, 'DRY_RUN created no events');
check(!dry.ctx.readOnboardingByFolder_('BF-D').calendar_events_json, 'DRY_RUN persisted nothing');

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length})`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (birthday + anniversary backfilled, no induction invites, provisioned-Quay1-only, idempotent, DRY_RUN honoured)');
process.exit(0);
