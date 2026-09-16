// Unit tests for assignInductionWeek_ - the Tuesday 14:00 SAST induction cutoff (brief Check 1).
// MUST run in the project timezone:  TZ=Africa/Johannesburg node tests/assign_induction_week.js
const { loadGas, DEFAULT_PROPS } = require('./load_gas');
const { ctx } = loadGas({ props: DEFAULT_PROPS });
const A = ctx.assignInductionWeek_;

let fails = 0;
function eq(got, want, label) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '[PASS] ' : '[FAIL] ') + label + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
  if (!ok) fails++;
}
function truthy(cond, label, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + label + (cond ? '' : '  ' + detail));
  if (!cond) fails++;
}

// Reference week: Monday 2026-09-14 -> induction Wed 2026-09-16 / Thu 2026-09-17.
const THIS = { monday: '2026-09-14', wed: '2026-09-16', thu: '2026-09-17' };
const NEXT = { monday: '2026-09-21', wed: '2026-09-23', thu: '2026-09-24' };

eq(A('2026-09-14T09:00:00+02:00'), THIS, 'Monday 09:00 SAST -> this week');
eq(A('2026-09-15T13:59:59+02:00'), THIS, 'Tuesday 13:59:59 SAST -> this week');
eq(A('2026-09-15T14:00:00+02:00'), NEXT, 'Tuesday 14:00:00 SAST -> next week');
eq(A('2026-09-15T14:00:01+02:00'), NEXT, 'Tuesday 14:00:01 SAST -> next week');
eq(A('2026-09-15T23:59:00+02:00'), NEXT, 'Tuesday 23:59 SAST -> next week');
eq(A('2026-09-16T00:01:00+02:00'), NEXT, 'Wednesday 00:01 SAST -> next week');
eq(A('2026-09-20T23:59:00+02:00'), NEXT, 'Sunday 23:59 SAST -> next week');

// UTC-given timestamps: the SAST wall-clock decides, never a naive UTC comparison.
eq(A('2026-09-15T13:30:00Z'), NEXT, 'UTC 13:30Z (=15:30 SAST Tue, past cutoff; naive UTC<14 would be WRONG) -> next week');
eq(A('2026-09-15T11:30:00Z'), THIS, 'UTC 11:30Z (=13:30 SAST Tue, before cutoff) -> this week');
eq(A('2026-09-15T12:00:00Z'), NEXT, 'UTC 12:00Z (=14:00:00 SAST Tue exactly, cutoff is SAST) -> next week');

// Month + year end boundary: Tuesday 2026-12-29.
eq(A('2026-12-29T13:59:00+02:00'), { monday: '2026-12-28', wed: '2026-12-30', thu: '2026-12-31' }, 'Tue 29 Dec 13:59 -> this week (30/31 Dec)');
eq(A('2026-12-29T14:00:00+02:00'), { monday: '2027-01-04', wed: '2027-01-06', thu: '2027-01-07' }, 'Tue 29 Dec 14:00 -> next week (crosses into Jan 2027)');

// Resubmission after a decline lands the person in a LATER week when it crosses the cutoff.
eq(A('2026-09-14T10:00:00+02:00'), THIS, 'first submission (Mon) -> this week');
eq(A('2026-09-15T15:00:00+02:00'), NEXT, 'resubmission Tue 15:00 (past cutoff) -> next (later) week');

// Holiday flagging (flag, never move): Wed 2026-12-16 is Day of Reconciliation.
const hf = ctx._inductionHolidayFlag_('2026-12-16', '2026-12-17');
truthy(/public holiday/.test(hf), 'holiday flag names Wed 2026-12-16 (Reconciliation Day)', JSON.stringify(hf));
truthy(ctx._inductionHolidayFlag_('2026-09-16', '2026-09-17') === '', 'no flag for a normal week (16/17 Sep)', ctx._inductionHolidayFlag_('2026-09-16', '2026-09-17'));
truthy(/not in holiday table/.test(ctx._inductionHolidayFlag_('2030-01-08', '2030-01-09')), 'uncovered year is flagged, not silently holiday-free', ctx._inductionHolidayFlag_('2030-01-08', '2030-01-09'));

console.log('\n' + (fails ? 'FAIL (' + fails + ')' : 'PASS - all cutoff + holiday cases'));
process.exit(fails ? 1 : 0);
