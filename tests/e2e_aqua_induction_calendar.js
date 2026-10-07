// End-to-end proof that an induction-eligible Aqua contractor AUTOMATICALLY gets the four calendar
// events (Induction Day 1 + Day 2, Birthday, Work anniversary) with the standing team-dates guest
// (Kat) on ALL of them, including the induction days. Drives _maybeAquaInduction_, the single function
// both provisioning completion paths call (approveAndProvision_ and provisionReadyBatch_), so a pass
// here means the calendar events fire on every normal Aqua provision, not just a manual backfill.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_aqua_induction_calendar.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const KAT = 'kat@quay1.co.za';
const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

console.log('=== Aqua inductee automatic calendar events (Kat on all four) ===');

const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
g.getSheet('Onboarding');
const evsFor = (needle) => g.calls.calendarEvents.filter((e) => new RegExp(needle).test(e.title));

// -- A. Eligible Aqua "Lead Nurturer" -> 4 events via the automatic path, Kat on all. ----------------
console.log('A. Aqua Lead Nurturer -> 4 events, candidate + Kat on induction days, Kat on series');
g.ctx.upsertOnboardingRow_({
  folderId: 'AQI-1', entity: 'aqua', name: 'Lena Nurturer', email: 'lena@personal.com',
  designation: 'Lead Nurturer', induction_wed: '2099-01-06', induction_thu: '2099-01-07',
  birthday: '1992-03-15', start_date: '2026-10-07',
});
g.ctx._maybeAquaInduction_('AQI-1', g.ctx.readOnboardingByFolder_('AQI-1'));
const d1 = evsFor('Induction Day 1 - Lena')[0];
const d2 = evsFor('Induction Day 2 - Lena')[0];
const bd = evsFor('^Birthday - Lena')[0];
const an = evsFor('^Work anniversary - Lena')[0];
check(!!d1 && d1.cal === 'Quay 1 Inductions', 'Day 1 created on Inductions calendar');
check(!!d1 && /lena@personal\.com/.test(d1.guests || '') && new RegExp(KAT).test(d1.guests || ''), 'Day 1 guests = candidate + Kat');
check(!!d2 && /lena@personal\.com/.test(d2.guests || '') && new RegExp(KAT).test(d2.guests || ''), 'Day 2 guests = candidate + Kat');
check(!!bd && bd.kind === 'series' && (bd.guests || []).indexOf(KAT) >= 0, 'Birthday series has Kat');
check(!!an && an.kind === 'series' && (an.guests || []).indexOf(KAT) >= 0, 'Work anniversary series has Kat');
const stored1 = JSON.parse(g.ctx.readOnboardingByFolder_('AQI-1').calendar_events_json || '{}');
check(stored1.day1 && stored1.day2 && stored1.birthday && stored1.anniversary, 'all four event ids persisted to the row');

// -- B. Near-miss designation "Lead Nurturing" is still eligible -> events created. ------------------
console.log('B. Aqua "Lead Nurturing" (near-miss) -> still inducted, events created');
g.ctx.upsertOnboardingRow_({
  folderId: 'AQI-2', entity: 'aqua', name: 'Nathi Gerund', email: 'nathi@personal.com',
  designation: 'Lead Nurturing', induction_wed: '2099-01-06', induction_thu: '2099-01-07',
  birthday: '1990-07-01', start_date: '2026-10-07',
});
g.ctx._maybeAquaInduction_('AQI-2', g.ctx.readOnboardingByFolder_('AQI-2'));
check(evsFor('Induction Day 1 - Nathi').length === 1 && evsFor('^Birthday - Nathi').length === 1,
  'near-miss "Lead Nurturing" got induction day + birthday');

// -- C. Non-attending designation "Relationship Manager" -> NO events. -------------------------------
console.log('C. Aqua Relationship Manager -> no calendar events (does not attend induction)');
g.ctx.upsertOnboardingRow_({
  folderId: 'AQI-3', entity: 'aqua', name: 'Riaan Relations', email: 'riaan@personal.com',
  designation: 'Relationship Manager', induction_wed: '2099-01-06', induction_thu: '2099-01-07',
  birthday: '1988-02-02', start_date: '2026-10-07',
});
g.ctx._maybeAquaInduction_('AQI-3', g.ctx.readOnboardingByFolder_('AQI-3'));
check(evsFor(' - Riaan').length === 0 && evsFor('Riaan').length === 0, 'Relationship Manager created no events');

// -- D. Idempotent: a second automatic run creates no new calendar events. ---------------------------
console.log('D. Re-run for the same inductee creates no duplicate events');
const before = g.calls.calendarEvents.length;
g.ctx._maybeAquaInduction_('AQI-1', g.ctx.readOnboardingByFolder_('AQI-1'));
check(g.calls.calendarEvents.length === before, 'no new events on a second run (idempotent via calendar_events_json)');

console.log('');
console.log(FAIL.length ? ('RESULT: FAIL (' + FAIL.length + ') -> ' + FAIL.join(' | '))
  : 'RESULT: PASS (eligible Aqua inductees auto-create 4 events with Kat on all; non-attending excluded; idempotent)');
process.exit(FAIL.length ? 1 : 0);
