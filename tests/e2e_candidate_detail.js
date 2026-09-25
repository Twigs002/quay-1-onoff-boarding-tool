// Proof of candidateDetail_ - the structured record behind the Progress report click-through page:
// assembles the row + FICA + provisioning into one payload, computes the journey stepper
// (done/current/upcoming), drops Induction for Aqua, and scopes a non-admin to their own candidates.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_candidate_detail.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };
function isoPlusDays(n) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n);
  const mm = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + mm + '-' + dd;
}
const ADMIN = { email: 'admin@quay1.co.za', role: { is_admin: true } };

console.log('=== candidateDetail_ (Progress report click-through record) ===');

const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
g.getSheet('Onboarding');
const ctx = g.ctx;
g.getSheet('Provisioning Queue').appendRow(ctx.PQ_HEADERS);   // header row 1 (readQueue_ starts at row 2)
const C = ctx.ONB_COL;
const set = (fid, col, v) => ctx.setOnboardingCell_(fid, col, v);

// A Quay 1 hire: provisioned, FICA in, induction UPCOMING (so Induction is the current step).
ctx.upsertOnboardingRow_({
  folderId: 'CD-1', entity: 'quay1', name: 'Shané Burger', email: 'shane@personal.com', contact: '+27 67 416 4264',
  id_number: '9005105800088', team: 'Wombats', senior_name: 'Jamie-Lee Smith', senior_email: 'jamie@quay1.co.za',
  requester_name: 'Marthinus Bosman', designation: 'Sell · Residential · Broker', start_date: '16 September 2026',
  status: 'Provisioned',
});
set('CD-1', C.requester_email, 'marthinus@quay1.co.za');
['contract', 'id', 'poa', 'bank'].forEach((k) => ctx.tickFica_('CD-1', k));
set('CD-1', C.contract_emailed_at, '2026-09-14T09:00:00Z');
set('CD-1', C.fica_submitted_at, '2026-09-15T08:00:00Z');
set('CD-1', C.contract_verified_at, '2026-09-15T09:30:00Z');
set('CD-1', C.approved_at, '2026-09-15T10:00:00Z');
set('CD-1', C.provisioned_at, '2026-09-15T10:05:00Z');
ctx.setInduction_('CD-1', isoPlusDays(30), isoPlusDays(31));   // upcoming induction
ctx.enqueueProvision_({ folderId: 'CD-1', system: 'google', action: 'create', status: 'done' });
ctx.enqueueProvision_({ folderId: 'CD-1', system: 'propdata', action: 'create', status: 'pending' });

console.log('A. Full detail payload + stepper');
const d = ctx.candidateDetail_('CD-1', ADMIN);
check(d.ok === true && d.name === 'Shané Burger' && d.entity === 'quay1' && d.team === 'Wombats', 'identity fields');
check(d.personal.phone === '+27 67 416 4264' && d.personal.email === 'shane@personal.com' && d.personal.id_masked === '900510…', 'personal details (ID masked)');
check(d.onboarding.senior_name === 'Jamie-Lee Smith' && d.onboarding.requester_name === 'Marthinus Bosman', 'onboarding info');
check(d.fica.contract && d.fica.id && d.fica.poa && d.fica.bank && !d.fica.nda, 'FICA doc flags (NDA still out)');
check(!!d.induction && d.induction.venue.indexOf('200 On Main') >= 0, 'induction block present with venue');
check(d.accounts.length === 2 && d.accounts.some((a) => a.system === 'google' && a.status === 'done'), 'account rows from the provisioning queue');

const byKey = {}; d.steps.forEach((s) => { byKey[s.key] = s; });
check(byKey.contract.state === 'done' && byKey.fica.state === 'done' && byKey.verified.state === 'done' && byKey.approved.state === 'done' && byKey.accounts.state === 'done', 'first five steps done (incl. contract verified)');
check(byKey.induction.state === 'current', 'Induction is the current step (upcoming date)');
check(byKey.complete.state === 'upcoming', 'Complete is upcoming');
check(d.steps.length === 7, 'seven steps for Quay 1');

console.log('B. Ownership scope for a non-admin');
const owner = ctx.candidateDetail_('CD-1', { email: 'marthinus@quay1.co.za', role: {} });
check(owner.ok === true, 'the requesting broker (owner) can view');
const stranger = ctx.candidateDetail_('CD-1', { email: 'someone.else@quay1.co.za', role: {} });
check(stranger.ok === false && stranger.error === 'not_found', "another broker gets not_found (no cross-team leak)");
check(ctx.candidateDetail_('NOPE', ADMIN).ok === false, 'unknown folderId -> not ok');

console.log('C. Aqua drops the Induction step');
ctx.upsertOnboardingRow_({ folderId: 'CD-2', entity: 'aqua', name: 'Ada Aqua', email: 'ada@personal.com', status: 'Provisioned' });
['contract', 'id', 'poa', 'bank'].forEach((k) => ctx.tickFica_('CD-2', k));
set('CD-2', C.contract_emailed_at, '2026-09-14T09:00:00Z');
set('CD-2', C.contract_verified_at, '2026-09-15T09:30:00Z');
set('CD-2', C.approved_at, '2026-09-15T10:00:00Z');
set('CD-2', C.provisioned_at, '2026-09-15T10:05:00Z');
set('CD-2', C.welcome_email_at, '2026-09-15T10:06:00Z');
const a = ctx.candidateDetail_('CD-2', ADMIN);
check(a.ok === true && a.induction === null, 'Aqua: induction block is null');
check(!a.steps.some((s) => s.key === 'induction'), 'Aqua: no Induction step');
check(a.steps[a.steps.length - 1].key === 'complete' && a.steps[a.steps.length - 1].state === 'done', 'Aqua: Complete is done (welcome sent)');

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length})`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (detail payload, stepper states, ownership scope, Aqua variant)');
process.exit(0);
