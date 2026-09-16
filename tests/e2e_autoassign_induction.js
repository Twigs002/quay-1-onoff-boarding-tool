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
const expect = armed.ctx.assignInductionWeek_(rowB.fica_submitted_at);   // the persisted timestamp, not a fresh clock read (no cutoff-second flake)
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

// -- Candidate D: Quay 1, ARMED, ALREADY PROVISIONED. A resubmission must NOT move the assigned week. -
console.log('D. Provisioned candidate resubmits FICA - assigned week must NOT silently move');
armed.ctx.upsertOnboardingRow_({ folderId: 'DD-1', entity: 'quay1', name: 'Dan Done', email: 'dan@personal.com',
  provisioned_at: '2026-01-01T00:00:00Z', induction_wed: '2026-01-07', induction_thu: '2026-01-08' });
const rd = armed.ctx.ficaUpload_(ficaBody('DD-1'));
const rowD = armed.ctx.readOnboardingByFolder_('DD-1');
check(rd && rd.ok === true, `ficaUpload_ succeeds${rd && rd.ok ? '' : ' -> ' + (rd && rd.error)}`);
check(rowD.induction_wed === '2026-01-07' && rowD.induction_thu === '2026-01-08',
  `provisioned candidate keeps original week (${rowD.induction_wed} / ${rowD.induction_thu}, expected 2026-01-07 / 2026-01-08)`);

// -- Provisioning-time safety net: empty or stale (past) induction dates re-assign to an upcoming week -
console.log('E. _ensureInductionWeekForProvisioning_ re-assigns empty/past dates to a real upcoming week');
const todayIso = armed.ctx._isoDate_(new Date());
// (a) empty dates -> assign fresh
armed.ctx.upsertOnboardingRow_({ folderId: 'EE-1', entity: 'quay1', name: 'Ed Empty', email: 'ed@personal.com' });
const iwEmpty = armed.ctx._ensureInductionWeekForProvisioning_(armed.ctx.readOnboardingByFolder_('EE-1'));
check(!!iwEmpty.wed && iwEmpty.wed >= todayIso, `empty dates -> upcoming week assigned (${iwEmpty.wed})`);
check(armed.ctx.readOnboardingByFolder_('EE-1').induction_wed === iwEmpty.wed, 'empty-date re-assignment is persisted to the row');
// (b) stale (past) dates -> re-assign, never email a past date
armed.ctx.upsertOnboardingRow_({ folderId: 'EE-2', entity: 'quay1', name: 'Stan Stale', email: 'stan@personal.com',
  induction_wed: '2020-01-08', induction_thu: '2020-01-09' });
const iwStale = armed.ctx._ensureInductionWeekForProvisioning_(armed.ctx.readOnboardingByFolder_('EE-2'));
check(iwStale.wed >= todayIso, `stale past week -> re-assigned to upcoming (${iwStale.wed}, was 2020-01-08)`);
// (c) a valid upcoming week is left untouched
armed.ctx.upsertOnboardingRow_({ folderId: 'EE-3', entity: 'quay1', name: 'Val Valid', email: 'val@personal.com',
  induction_wed: '2099-01-07', induction_thu: '2099-01-08' });
const iwValid = armed.ctx._ensureInductionWeekForProvisioning_(armed.ctx.readOnboardingByFolder_('EE-3'));
check(iwValid.wed === '2099-01-07' && iwValid.thu === '2099-01-08', `valid upcoming week left untouched (${iwValid.wed})`);

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length} check(s))`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (auto-assign fires on FICA submit, Quay 1 only, DRY_RUN honoured)');
process.exit(0);
