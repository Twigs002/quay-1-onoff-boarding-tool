// Proof of the three provisioning-safety audit fixes, using the real backend via the node harness:
//   (a) #4  entity fail-closed: a BLANK-entity row is refused by the provision path - no Google account
//           is created and provisioned_at is never stamped (no default-to-quay1 across the Active/Quay 1 wall).
//   (b) #6  POPIA: the propdata dry-run audit payload does NOT contain the full SA id_number - only a
//           presence flag + last-4 land in the log.
//   (c) #7  worker dry-run cross-check: a create queue row whose result_json carries dry_run:true does NOT
//           count as a completed setup - the hire stays surfaced on the pipeline as setup_incomplete.
//
// Runs ARMED (DRY_RUN=0) for (a) so the real create path (not the dry-run branch) is what the entity gate
// has to stop.
//
// Run:  node tests/e2e_provision_safety.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };
const inserts = (g) => g.calls.adminDirectory.filter((a) => a.op === 'Users.insert').length;

const ADMIN = { email: 'boss@quay1.co.za', role: { is_super: false, is_admin: true, is_senior_broker: false } };

console.log('=== provisioning safety (entity fail-closed / PII redaction / worker dry-run) ===');

// ---------------------------------------------------------------- (a) #4 entity fail-closed
const gA = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
gA.getSheet('Onboarding');
gA.getSheet('Provisioning Queue');
gA.getSheet('Google Credentials');

// A FICA-complete, verifiable row with NO entity. Armed approve must REFUSE rather than default to quay1.
gA.ctx.upsertOnboardingRow_({
  folderId: 'BE-1', entity: '', name: 'Blank Entity', email: 'blank@personal.com',
  fica_contract: 'Received', fica_id: 'Received', fica_poa: 'Received', fica_bank: 'Received',
  systems_json: '["google"]', start_date: '2026-10-19', team: 'Lions',
});
const ra = gA.ctx.approveAndProvision_('BE-1', ADMIN, { contractVerified: true });
check(!!ra && ra.ok === false && /entity missing/i.test(String(ra.error || '')),
  `blank-entity approve is refused (ok=${ra && ra.ok}, error=${ra && ra.error})`);
check(inserts(gA) === 0, `no Google account created for a blank-entity row (inserts=${inserts(gA)})`);
const beRow = gA.ctx.readOnboardingByFolder_('BE-1');
check(!String(beRow.provisioned_at || '').trim(), 'provisioned_at NOT stamped on the refused row');
const refusedLog = gA.calls.logs.find((l) => /provision_refused_blank_entity/.test(l));
check(!!refusedLog, 'a provision_refused_blank_entity audit line was logged');

// Control: the SAME row, given an entity, provisions for real (one account, stamped) - proving the gate
// is the blank entity, not some unrelated block.
gA.ctx.upsertOnboardingRow_({ folderId: 'BE-1', entity: 'quay1' });
const ra2 = gA.ctx.approveAndProvision_('BE-1', ADMIN, { contractVerified: true });
check(!!ra2 && ra2.ok === true && !ra2.dryRun, `same row WITH entity=quay1 provisions (ok=${ra2 && ra2.ok})`);
check(inserts(gA) === 1, `exactly one Google account once the entity is set (inserts=${inserts(gA)})`);

// ---------------------------------------------------------------- (b) #6 PII redaction in logs
const gB = loadGas({ props: DEFAULT_PROPS, dryRun: true });
const FULL_ID = '9001015800083';
gB.ctx._propdata_({ first_name: 'Test', last_name: 'Person', email: 't@p.com', id_number: FULL_ID }, 'create');
const ddLog = gB.calls.logs.find((l) => /propdata_dryrun/.test(l));
check(!!ddLog, 'propdata_dryrun was logged');
check(!!ddLog && !new RegExp(FULL_ID).test(ddLog), 'the full SA id_number is NOT present in the audit log');
check(!!ddLog && /id_last4/.test(ddLog) && /0083/.test(ddLog), 'a redacted id_last4 (0083) IS present instead');
check(!!ddLog && /id_present/.test(ddLog), 'an id_present flag is logged');

// ---------------------------------------------------------------- (c) #7 worker dry-run cross-check
const gC = loadGas({ props: DEFAULT_PROPS, dryRun: true });
gC.getSheet('Onboarding');
gC.getSheet('Provisioning Queue').appendRow(gC.ctx.PQ_HEADERS);   // headers at row 1 so queue rows read back

// DR-1: provisioned + booked, but its ONLY create row is a worker DRY-RUN 'done' (no real account).
gC.ctx.upsertOnboardingRow_({
  folderId: 'DR-1', entity: 'quay1', name: 'Dusty Dryrun', email: 'd@p.com',
  fica_contract: 'Received', fica_id: 'Received', fica_poa: 'Received', fica_bank: 'Received',
  systems_json: '["propdata"]', start_date: '2026-10-19', team: 'Lions',
  approved_at: '2026-10-10T00:00:00.000Z', provisioned_at: '2026-10-11T00:00:00.000Z',
  induction_wed: '2026-10-21', induction_thu: '2026-10-22',
});
gC.ctx.enqueueProvision_({ folderId: 'DR-1', system: 'propdata', action: 'create', status: 'done', result: { dry_run: true } });

// DR-2 (control): same shape, but a REAL 'done' create row (no dry_run) -> fully set up -> drops off.
gC.ctx.upsertOnboardingRow_({
  folderId: 'DR-2', entity: 'quay1', name: 'Reva Real', email: 'r@p.com',
  fica_contract: 'Received', fica_id: 'Received', fica_poa: 'Received', fica_bank: 'Received',
  systems_json: '["propdata"]', start_date: '2026-10-19', team: 'Tigers',
  approved_at: '2026-10-10T00:00:00.000Z', provisioned_at: '2026-10-11T00:00:00.000Z',
  induction_wed: '2026-10-21', induction_thu: '2026-10-22',
});
gC.ctx.enqueueProvision_({ folderId: 'DR-2', system: 'propdata', action: 'create', status: 'done', result: {} });

const pq = gC.ctx.readQueue_(gC.ctx.CFG.TAB.PROVISION_QUEUE);
const pipeline = gC.ctx._onboardingPipeline_(true, '', pq);
const dr1 = pipeline.find((e) => e.folderId === 'DR-1');
const dr2 = pipeline.find((e) => e.folderId === 'DR-2');
check(!!dr1, 'the dry-run-done hire is NOT dropped from the pipeline (still surfaced)');
check(!!dr1 && dr1.setup_incomplete === true, 'a dry-run create row marks the hire setup_incomplete (not complete)');
check(!dr2, 'the real-done hire DOES drop off the pipeline (control: fully set up)');

console.log('');
console.log(FAIL.length ? ('RESULT: FAIL (' + FAIL.length + ') -> ' + FAIL.join(' | '))
  : 'RESULT: PASS (entity fail-closed, id_number redacted in logs, worker dry-run not counted complete)');
process.exit(FAIL.length ? 1 : 0);
