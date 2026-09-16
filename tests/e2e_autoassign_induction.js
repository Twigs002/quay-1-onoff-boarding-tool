// End-to-end proof of the auto-assign-induction wiring (brief Check 3): drive the REAL ficaUpload_
// for three fake candidates and prove the induction week is assigned from the FICA submission time,
// Quay 1 only, honouring DRY_RUN (log-only, no writes, no sends).
//
// The cutoff MATHS is proved deterministically at fixed times in tests/assign_induction_week.js
// (Check 1). This harness proves the SEAM: that ficaUpload_ calls assignInductionWeek_ with the
// submission time and persists the result on the row (armed) or writes nothing (DRY_RUN), and that
// Aqua is skipped.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_autoassign_induction.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

// A minimal-but-valid FICA upload body. A PERMIT file satisfies the right-to-work gate regardless of
// the ID value, so we do not depend on a checksum-valid SA ID. base64Decode is mocked to [] (0 bytes).
function ficaBody(folderId) {
  return {
    folderId: folderId, ffc_status: 'full', ffc_number: 'FFC123',
    details: { Bank: 'FNB', 'Account number': '123456789', 'Account type': 'cheque', 'Income tax number': '9876543210' },
    files: [
      { label: 'PERMIT', ext: 'pdf', mimeType: 'application/pdf', dataBase64: 'AAAA' },
      { label: 'ID', ext: 'pdf', mimeType: 'application/pdf', dataBase64: 'AAAA' },
    ],
  };
}

console.log('=== auto-assign induction: end-to-end FICA submit (Check 3) ===');

// -- Candidate A: Quay 1, DRY_RUN. Submitting FICA must NOT write an induction week; it logs only. ----
console.log('A. Quay 1 candidate submits FICA in DRY_RUN (log-only, nothing written, nothing sent)');
const dry = loadGas({ props: DEFAULT_PROPS, dryRun: true });
dry.getSheet('Onboarding');
dry.ctx.upsertOnboardingRow_({ folderId: 'AA-1', entity: 'quay1', name: 'Amy Attend', email: 'amy@personal.com' });
const ra = dry.ctx.ficaUpload_(ficaBody('AA-1'));
const rowA = dry.ctx.readOnboardingByFolder_('AA-1');
check(ra && ra.ok === true, `ficaUpload_ succeeds${ra && ra.ok ? '' : ' -> ' + (ra && ra.error)}`);
check(!rowA.induction_wed && !rowA.induction_thu, 'DRY_RUN: no induction week written to the row');
check(!rowA.fica_submitted_at, 'DRY_RUN: fica_submitted_at NOT stamped');
// The only email ficaUpload_ sends is the pre-existing FICA-received team notification (1). If our
// auto-assign block had sent anything of its own the count would be higher, so <=1 proves it stayed silent.
check(dry.calls.emailsSent.length <= 1, `DRY_RUN: auto-assign block sends nothing of its own (total sends ${dry.calls.emailsSent.length})`);

// -- Candidate B: Quay 1, ARMED. The row must carry the week assignInductionWeek_ picks for now. -------
console.log('B. Quay 1 candidate submits FICA ARMED (week assigned from submission time + persisted)');
const armed = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
armed.getSheet('Onboarding');
armed.ctx.upsertOnboardingRow_({ folderId: 'BB-1', entity: 'quay1', name: 'Ben Booked', email: 'ben@personal.com' });
const rb = armed.ctx.ficaUpload_(ficaBody('BB-1'));
const rowB = armed.ctx.readOnboardingByFolder_('BB-1');
const expect = armed.ctx.assignInductionWeek_(armed.ctx.nowIso_());   // same clock second the upload used
check(rb && rb.ok === true, `ficaUpload_ succeeds${rb && rb.ok ? '' : ' -> ' + (rb && rb.error)}`);
check(rowB.induction_wed === expect.wed && rowB.induction_thu === expect.thu,
  `ARMED: induction Wed/Thu = auto-assigned week (${rowB.induction_wed} / ${rowB.induction_thu} vs ${expect.wed} / ${expect.thu})`);
check(!!rowB.fica_submitted_at, `ARMED: fica_submitted_at stamped (${rowB.fica_submitted_at || 'MISSING'})`);
check(rowB.induction_holiday_flag === armed.ctx._inductionHolidayFlag_(expect.wed, expect.thu),
  `ARMED: induction_holiday_flag mirrors the holiday check ("${rowB.induction_holiday_flag}")`);

// -- Candidate C: Aqua, ARMED. Aqua has no induction, so nothing is assigned even when armed. ----------
console.log('C. Aqua contractor submits FICA ARMED (no induction step for Aqua - nothing assigned)');
armed.ctx.upsertOnboardingRow_({ folderId: 'CC-1', entity: 'aqua', name: 'Cara Contract', email: 'cara@personal.com' });
const rc = armed.ctx.ficaUpload_(ficaBody('CC-1'));
const rowC = armed.ctx.readOnboardingByFolder_('CC-1');
check(rc && rc.ok === true, `ficaUpload_ succeeds for Aqua${rc && rc.ok ? '' : ' -> ' + (rc && rc.error)}`);
check(!rowC.induction_wed && !rowC.induction_thu && !rowC.fica_submitted_at,
  'Aqua: no induction week and no fica_submitted_at (induction is Quay 1 only)');

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length} check(s))`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (auto-assign fires on FICA submit, Quay 1 only, DRY_RUN honoured)');
process.exit(0);
