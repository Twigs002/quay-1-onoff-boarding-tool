// Proof that the provisioning lock-scope refactor is correct (audit 1C + 2A):
//  - interactive approve still provisions + stamps, and the post-lock handoff (HR/induction/calendar/
//    Flow) still runs, now OUTSIDE the script lock;
//  - a re-approve of a provisioned row is an idempotent no-op (no second account, no new events);
//  - the scheduled batch does not re-provision an already-provisioned row (the race re-check), and
//    provisions a ready row end-to-end through the locked path + the shared handoff.
//
// Runs ARMED (DRY_RUN=0) so the real success path (not the dry-run branch) is exercised.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_provision_lockscope.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };
const inserts = (g) => g.calls.adminDirectory.filter((a) => a.op === 'Users.insert').length;

console.log('=== provisioning lock-scope + batch race (armed) ===');

const ADMIN = { email: 'boss@quay1.co.za', role: { is_super: false, is_admin: true, is_senior_broker: false } };
const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
g.getSheet('Onboarding');
g.getSheet('Provisioning Queue');
g.getSheet('Offboarding Queue');
g.getSheet('Google Credentials');

// A. Interactive approve, armed: provisions, stamps, and the post-lock handoff creates the 4 calendar
//    events + sends - proving the handoff still runs after the lock is released.
g.ctx.upsertOnboardingRow_({
  folderId: 'LK-1', entity: 'quay1', name: 'Lara Lock', email: 'lara@personal.com',
  fica_contract: 'Received', fica_id: 'Received', fica_poa: 'Received', fica_bank: 'Received',
  systems_json: '["google"]', birthday: '1995-04-12', start_date: '2026-10-19', team: 'Lions',
});
const r1 = g.ctx.approveAndProvision_('LK-1', ADMIN, { contractVerified: true });
check(!!r1 && r1.ok === true && !r1.dryRun, `approve succeeds armed (ok=${r1 && r1.ok}, dryRun=${r1 && r1.dryRun})`);
const row1 = g.ctx.readOnboardingByFolder_('LK-1');
check(!!String(row1.provisioned_at || '').trim(), 'provisioned_at stamped');
check(String(row1.status || '') === 'Provisioned', `status = Provisioned (got "${row1.status}")`);
check(inserts(g) === 1, `exactly one Google account created (got ${inserts(g)})`);
const cevs1 = g.calls.calendarEvents.filter((e) => /Lara/.test(e.title));
check(cevs1.length === 4, `post-lock handoff created 4 calendar events (got ${cevs1.length})`);
check(g.calls.emailsSent.length >= 1, `the handoff sent at least one email (got ${g.calls.emailsSent.length})`);

// B. Idempotent re-approve: already:true, no second account, no new calendar events.
const calB = g.calls.calendarEvents.length;
const insB = inserts(g);
const r2 = g.ctx.approveAndProvision_('LK-1', ADMIN, { contractVerified: true });
check(!!r2 && r2.ok === true && r2.already === true, 'second approve returns already:true');
check(inserts(g) === insB, 'no second Google account on the idempotent re-approve');
check(g.calls.calendarEvents.length === calB, 'no new calendar events on the idempotent re-approve');

// C. Batch does NOT re-provision the already-provisioned row (top skip + re-read-under-lock race guard).
const insC = inserts(g);
g.ctx.provisionReadyBatch_();
check(inserts(g) === insC, 'batch did not re-provision the already-provisioned row');

// D. Batch provisions a ready, unprovisioned row end-to-end through the locked path + the shared handoff.
g.ctx.upsertOnboardingRow_({
  folderId: 'LK-2', entity: 'quay1', name: 'Barry Batch', email: 'barry@personal.com',
  fica_contract: 'Received', fica_id: 'Received', fica_poa: 'Received', fica_bank: 'Received',
  approved_at: '2026-10-10T08:00:00.000Z', systems_json: '["google"]',
  birthday: '1990-02-02', start_date: '2026-10-19', team: 'Tigers',
});
const bout = g.ctx.provisionReadyBatch_();
const row2 = g.ctx.readOnboardingByFolder_('LK-2');
check(!!String(row2.provisioned_at || '').trim(), 'batch provisioned the ready row (provisioned_at set)');
check((bout.provisioned || []).indexOf('LK-2') >= 0, 'batch reported LK-2 as provisioned');
const cevs2 = g.calls.calendarEvents.filter((e) => /Barry/.test(e.title));
check(cevs2.length === 4, `batch handoff created 4 calendar events for the row (got ${cevs2.length})`);

console.log('');
console.log(FAIL.length ? ('RESULT: FAIL (' + FAIL.length + ') -> ' + FAIL.join(' | '))
  : 'RESULT: PASS (lock-scoped provision + handoff correct, idempotent, batch race-guarded)');
process.exit(FAIL.length ? 1 : 0);
