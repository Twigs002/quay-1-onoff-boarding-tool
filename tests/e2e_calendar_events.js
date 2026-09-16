// End-to-end proof of the Phase 2 onboarding calendar events (createOnboardingCalendarEvents_):
// four events per Quay 1 starter, idempotent, one failure never blocks the others, DRY_RUN-safe,
// Quay 1 only. Uses the CalendarApp mock (tests/gas_mocks.js).
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_calendar_events.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

console.log('=== onboarding calendar events (Phase 2) ===');

// -- A. Armed: a full Quay 1 starter gets all four events, candidate invited, ids stored. -------------
console.log('A. Full Quay 1 starter -> 4 events (2 induction invites + birthday + anniversary series)');
const armed = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
armed.getSheet('Onboarding');
armed.ctx.upsertOnboardingRow_({
  folderId: 'CAL-1', entity: 'quay1', name: 'Cara Calendar', email: 'cara@personal.com',
  induction_wed: '2026-09-23', induction_thu: '2026-09-24', birthday: '1994-05-10', start_date: '2026-09-21',
});
const r1 = armed.ctx.createOnboardingCalendarEvents_('CAL-1', armed.ctx.readOnboardingByFolder_('CAL-1'));
check(r1.created.length === 4, `4 events created (${r1.created.join(',')})`);
const evs = armed.calls.calendarEvents;
const day1 = evs.find((e) => /Induction Day 1/.test(e.title));
const day2 = evs.find((e) => /Induction Day 2/.test(e.title));
const bday = evs.find((e) => /^Birthday/.test(e.title));
const anniv = evs.find((e) => /^Work anniversary/.test(e.title));
check(!!day1 && day1.cal === 'Quay 1 Inductions' && day1.guests === 'cara@personal.com', 'Day 1 on Inductions calendar, candidate invited');
check(!!day2 && day2.kind === 'event' && day2.cal === 'Quay 1 Inductions', 'Day 2 on Inductions calendar');
check(!!bday && bday.kind === 'series' && bday.cal === 'Quay 1 Team Dates', 'Birthday is a recurring series on Team Dates');
check(!!anniv && anniv.kind === 'series' && anniv.cal === 'Quay 1 Team Dates' && /joined 2026/.test(anniv.title), 'Work anniversary recurring series on Team Dates (joined 2026)');
const stored = JSON.parse(armed.ctx.readOnboardingByFolder_('CAL-1').calendar_events_json || '{}');
check(stored.day1 && stored.day2 && stored.birthday && stored.anniversary, 'all four event ids persisted to the row');
check(armed.calls.calendarsCreated.indexOf('Quay 1 Inductions') >= 0 && armed.calls.calendarsCreated.indexOf('Quay 1 Team Dates') >= 0, 'both shared calendars auto-created');

// -- B. Idempotent: a second run creates nothing new. -------------------------------------------------
console.log('B. Re-run is idempotent (no duplicate events)');
const beforeCount = armed.calls.calendarEvents.length;
const r2 = armed.ctx.createOnboardingCalendarEvents_('CAL-1', armed.ctx.readOnboardingByFolder_('CAL-1'));
check(r2.created.length === 0 && r2.skipped.length === 4, `re-run skips all 4 (created ${r2.created.length}, skipped ${r2.skipped.length})`);
check(armed.calls.calendarEvents.length === beforeCount, 'no new calendar events created on re-run');

// -- C. Missing data: only the events with data are created (no birthday/start -> just induction). ----
console.log('C. Missing birthday + start date -> only the two induction events');
armed.ctx.upsertOnboardingRow_({ folderId: 'CAL-2', entity: 'quay1', name: 'Ivan Induction', email: 'ivan@personal.com',
  induction_wed: '2026-09-23', induction_thu: '2026-09-24' });
const r3 = armed.ctx.createOnboardingCalendarEvents_('CAL-2', armed.ctx.readOnboardingByFolder_('CAL-2'));
check(r3.created.length === 2 && r3.created.indexOf('day1') >= 0 && r3.created.indexOf('day2') >= 0, `only induction days created (${r3.created.join(',')})`);

// -- D. Aqua is skipped entirely (no induction). ------------------------------------------------------
console.log('D. Aqua contractor -> no calendar events');
armed.ctx.upsertOnboardingRow_({ folderId: 'CAL-3', entity: 'aqua', name: 'Ada Aqua', email: 'ada@personal.com',
  induction_wed: '2026-09-23', induction_thu: '2026-09-24', birthday: '1990-01-01', start_date: '2026-09-21' });
const r4 = armed.ctx.createOnboardingCalendarEvents_('CAL-3', armed.ctx.readOnboardingByFolder_('CAL-3'));
check(r4.created.length === 0 && r4.skipped.length === 0 && r4.failed.length === 0, 'Aqua row creates nothing');

// -- E. DRY_RUN creates nothing. ----------------------------------------------------------------------
console.log('E. DRY_RUN -> log-only, no events, nothing persisted');
const dry = loadGas({ props: DEFAULT_PROPS, dryRun: true });
dry.getSheet('Onboarding');
dry.ctx.upsertOnboardingRow_({ folderId: 'CAL-4', entity: 'quay1', name: 'Dana Dry', email: 'dana@personal.com',
  induction_wed: '2026-09-23', induction_thu: '2026-09-24', birthday: '1994-05-10', start_date: '2026-09-21' });
const r5 = dry.ctx.createOnboardingCalendarEvents_('CAL-4', dry.ctx.readOnboardingByFolder_('CAL-4'));
check(r5.created.length === 0 && dry.calls.calendarEvents.length === 0, 'DRY_RUN creates no events');
check(!dry.ctx.readOnboardingByFolder_('CAL-4').calendar_events_json, 'DRY_RUN persists nothing');

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length})`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (4 events, idempotent, data-gated, Quay 1 only, DRY_RUN honoured)');
process.exit(0);
