// End-to-end proof of the admin manual induction-week override (setInductionWeekManual_):
// snaps a chosen date to that week's Wed/Thu, MOVES the two induction calendar invites, re-sends the
// induction packet with a rescheduled note, is a no-op when unchanged, refuses a past week / Aqua, and
// is DRY_RUN-safe. Uses the CalendarApp mock (tests/gas_mocks.js) with getEventById + deleteEvent.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_set_induction_week.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

// Local (SAST) YYYY-MM-DD, N days from now at noon (avoids UTC/midnight edge cases).
function isoPlusDays(n) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n);
  const mm = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + mm + '-' + dd;
}

console.log('=== admin manual induction-week override (setInductionWeekManual_) ===');

const armed = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
armed.getSheet('Onboarding');
const ctx = armed.ctx;

// Seed a Quay 1 starter whose induction week is ~10 days out, with calendar events already created.
const initWk = ctx._weekOfDate_(isoPlusDays(10));
ctx.upsertOnboardingRow_({
  folderId: 'SIW-1', entity: 'quay1', name: 'Wendy Weekchange', email: 'wendy@personal.com', team: 'Wombats',
  induction_wed: initWk.wed, induction_thu: initWk.thu, birthday: '1992-03-04', start_date: '2026-09-21',
});
ctx.createOnboardingCalendarEvents_('SIW-1', ctx.readOnboardingByFolder_('SIW-1'));
const before = JSON.parse(ctx.readOnboardingByFolder_('SIW-1').calendar_events_json || '{}');
const origDay1 = before.day1, origDay2 = before.day2, origBday = before.birthday;
check(!!(origDay1 && origDay2 && origBday), `seed created day1/day2/birthday events (${origDay1},${origDay2})`);
const emailsBefore = armed.calls.emailsSent.length;

// A. Move to a later week (~28 days out) -> snaps to that week's Wed/Thu.
console.log('A. Change to a later week -> new Wed/Thu, calendar moved, packet re-sent');
const targetDate = isoPlusDays(28);
const expect = ctx._weekOfDate_(targetDate);
const r = ctx.setInductionWeekManual_('SIW-1', targetDate, { email: 'admin@quay1.co.za' });
check(r.ok && r.wed === expect.wed && r.thu === expect.thu && r.rescheduled === true, `moved to ${r.wed} & ${r.thu}`);
const rowAfter = ctx.readOnboardingByFolder_('SIW-1');
check(rowAfter.induction_wed === expect.wed && rowAfter.induction_thu === expect.thu, 'row persisted the new induction week');
check(expect.wed !== initWk.wed, 'target week differs from the original (sanity)');

// Calendar: the two original induction-day events were deleted, and two fresh ones created on new dates.
check(armed.calls.calendarDeleted.indexOf(origDay1) >= 0 && armed.calls.calendarDeleted.indexOf(origDay2) >= 0, 'original day1 + day2 calendar events deleted');
check(armed.calls.calendarDeleted.indexOf(origBday) < 0, 'birthday series was NOT deleted (only induction days move)');
const after = JSON.parse(rowAfter.calendar_events_json || '{}');
check(after.day1 && after.day2 && after.day1 !== origDay1 && after.day2 !== origDay2, 'day1/day2 re-created with new event ids');
check(after.birthday === origBday, 'birthday event id unchanged');
const newDay1 = armed.calls.calendarEventsById[after.day1];
check(!!newDay1 && !newDay1.deleted && newDay1.cal === 'Quay 1 Inductions', 'new Day 1 lives on the Inductions calendar');

// Packet re-sent to the candidate.
const sentToWendy = armed.calls.emailsSent.slice(emailsBefore).some((e) => e.to === 'wendy@personal.com');
check(sentToWendy, 'induction packet re-sent to the candidate');

// B. Re-picking the SAME week is a no-op (no email, no calendar churn).
console.log('B. Re-select the same week -> unchanged, no side effects');
const delBefore = armed.calls.calendarDeleted.length, mailBefore2 = armed.calls.emailsSent.length;
const r2 = ctx.setInductionWeekManual_('SIW-1', expect.wed, { email: 'admin@quay1.co.za' });
check(r2.ok && r2.unchanged === true, 'same-week reselect returns unchanged');
check(armed.calls.calendarDeleted.length === delBefore && armed.calls.emailsSent.length === mailBefore2, 'no calendar deletes or emails on unchanged');

// C. A past week is refused.
console.log('C. Past week -> refused');
const rPast = ctx.setInductionWeekManual_('SIW-1', isoPlusDays(-14), { email: 'admin@quay1.co.za' });
check(rPast.ok === false && /passed/i.test(rPast.error || ''), 'past week rejected');

// D. Aqua contractor -> refused (no induction).
console.log('D. Aqua -> refused');
ctx.upsertOnboardingRow_({ folderId: 'SIW-2', entity: 'aqua', name: 'Ada Aqua', email: 'ada@personal.com' });
const rAqua = ctx.setInductionWeekManual_('SIW-2', targetDate, { email: 'admin@quay1.co.za' });
check(rAqua.ok === false && /Quay 1/i.test(rAqua.error || ''), 'Aqua row rejected');

// E. DRY_RUN writes/sends nothing.
console.log('E. DRY_RUN -> log-only');
const dry = loadGas({ props: DEFAULT_PROPS, dryRun: true });
dry.getSheet('Onboarding');
const dwk = dry.ctx._weekOfDate_(isoPlusDays(10));
dry.ctx.upsertOnboardingRow_({ folderId: 'SIW-3', entity: 'quay1', name: 'Dana Dry', email: 'dana@personal.com', induction_wed: dwk.wed, induction_thu: dwk.thu });
const rDry = dry.ctx.setInductionWeekManual_('SIW-3', isoPlusDays(28), { email: 'admin@quay1.co.za' });
check(rDry.ok && rDry.dryRun === true, 'DRY_RUN returns dryRun:true');
const dryRow = dry.ctx.readOnboardingByFolder_('SIW-3');
check(dryRow.induction_wed === dwk.wed, 'DRY_RUN did not change the induction week');
check(dry.calls.emailsSent.length === 0 && dry.calls.calendarDeleted.length === 0, 'DRY_RUN sent no email + moved no calendar');

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length})`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (week moves, calendar re-created, packet re-sent, unchanged no-op, past/Aqua refused, DRY_RUN honoured)');
process.exit(0);
