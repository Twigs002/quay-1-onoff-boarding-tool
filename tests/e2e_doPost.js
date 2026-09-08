// End-to-end doPost harness: drives the REAL Router -> Auth -> handler chain with
// UI-shaped POST bodies, against mocked Google + a mocked-authenticated Supabase
// caller. Proves, at runtime, which UI<->backend seams work and which drift.
//
// No live anything: UrlFetchApp answers the Supabase auth calls from `authUser`;
// all Sheet/Drive/Admin access is the in-memory mock; DRY_RUN on.
//
// Run:  node tests/e2e_doPost.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

// Admin caller so authenticated kinds resolve.
const ADMIN = { id: 'u1', email: 'boss@quay1.co.za', name: 'The Boss', is_admin: true, is_super: false, is_broker: false, active: true };

const gas = loadGas({ props: DEFAULT_PROPS, dryRun: true, authUser: ADMIN });
const { ctx, getSheet } = gas;
getSheet('Provisioning Queue');
getSheet('Offboarding Queue');
getSheet('Onboarding');

// Helper: call doPost with a body object, return the parsed JSON response.
function post(body) {
  const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.getContent());
}

console.log('=== end-to-end doPost seam proof ===');

// The CANONICAL payload per docs/CONTRACTS.md section 8 (SPEC-3.1 field names, the
// systems array as `systems`). This harness is the authoritative CONFORMANCE GATE:
// it goes green only when BOTH sides conform to section 8. A `config`-class error
// (missing Script Property for a template/folder) counts as "past the seam" - the
// seam contract is satisfied; live config is a separate, user-gated concern.
const canonOnboardQuay1 = {
  kind: 'onboard_quay1', accessToken: 'jwt',
  name: 'Jane Doe', id_number: '9001010000000', contact: '0820000000',
  email: 'jane@personal.com', start_date: '2026-08-01', division: 'Sales',
  team: 'Alpha', designation: 'agent', senior_name: 'Sam Senior',
  senior_email: 'sam@quay1.co.za', commission: '60',
  systems: ['google', 'propdata', 'dialfire'], programs: ['cma'],
  requester_name: 'ignored', requester_email: 'ignored@x.com',
};
const SEAM_ERR = /full_name and id_number are required|valid candidate_email is required/;

console.log('1. auth: JWT key alignment (accessToken end-to-end)');
check(post(canonOnboardQuay1).error !== 'unauthorized',
  'canonical accessToken authenticates (not unauthorized) -> JWT seam aligned');
check(post({ kind: 'onboard_quay1', name: 'x', id_number: '1' }).error === 'unauthorized',
  'missing token -> unauthorized (auth gate works)');

console.log('2. onboard_quay1 accepts the CANONICAL names (CONTRACTS 8.1)');
const r1 = post(canonOnboardQuay1);
check(!(r1.ok === false && SEAM_ERR.test(r1.error || '')),
  `backend accepts canonical name/email (past the field seam)${r1.ok ? '' : ` -> got "${r1.error}"`}`);

console.log('3. status returns rows[] per CONTRACTS 8.3 (UI pills read rows[].status)');
const rs = post({ kind: 'status', accessToken: 'jwt' });
check(rs.ok === true && Array.isArray(rs.rows),
  `status response carries rows:[] ${Array.isArray(rs.rows) ? '' : `(got keys: ${Object.keys(rs).join(',')})`}`);

console.log('4. offboard (CONTRACTS 8.5)');
const ro = post({ kind: 'offboard', accessToken: 'jwt', full_name: 'Jane Doe', quay_email: 'jane@quay1.co.za', requested_by: 'boss@quay1.co.za', requested_by_name: 'The Boss' });
check(ro.ok === true && /^OFF-/.test(ro.offb_id || '') && !!ro.fire_at,
  `offboard end-to-end OK (offb_id ${ro.offb_id}, fires ${ro.fire_at})`);

console.log('5. retry requires super; unknown kind rejected');
check(/forbidden/.test(post({ kind: 'retry', accessToken: 'jwt', queue_id: 'Q1' }).error || ''),
  'retry as non-super -> forbidden (admin is not super)');
check(/unknown action/.test(post({ kind: 'bogus', accessToken: 'jwt' }).error || ''),
  'unknown kind -> unknown action error');

console.log('6. broker role: onboarding provisions (no admin gate INSIDE provisionAll_), offboard + standalone provision stay admin-only');
// A separate gas instance whose caller is a pure broker (not super/admin).
// Onboarders are SENIOR brokers now (is_senior_broker), reconciled with the frontend gate.
const BROKER = { id: 'u2', email: 'broker@quay1.co.za', name: 'Bree Broker', is_admin: false, is_super: false, is_senior_broker: true, active: true };
const brokerGas = loadGas({ props: DEFAULT_PROPS, dryRun: true, authUser: BROKER });
brokerGas.getSheet('Provisioning Queue'); brokerGas.getSheet('Offboarding Queue'); brokerGas.getSheet('Onboarding');
const bpost = (body) => JSON.parse(brokerGas.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
// (a) Onboard clears the ENTRY role gate for a broker (config error, not a role error).
const rbOn = bpost(canonOnboardQuay1);
check(rbOn.error !== 'unauthorized' && !/forbidden/.test(rbOn.error || ''),
  `broker onboard_quay1 clears the entry role gate${rbOn.ok ? '' : ` -> got "${rbOn.error}"`}`);
// (b) THE REGRESSION THIS FIX GUARDS: the inline provisioning step must NOT re-enforce admin.
//     Call provisionAll_ directly with a broker ctx - it is the exact line that used to throw
//     'forbidden' AFTER the contract was generated and the candidate emailed.
let provErr = null, provRes = null;
try { provRes = brokerGas.ctx.provisionAll_('F-broker', ['dialfire'], { role: { is_broker: true, is_admin: false, is_super: false } }); }
catch (e) { provErr = String(e); }
check(provErr === null && provRes && provRes.ok === true,
  `provisionAll_ runs for a broker (inline onboard path, no admin gate)${provErr ? ' -> threw ' + provErr : ''}`);
// (c) The STANDALONE 'provision' kind stays admin-only: a broker is forbidden up front.
check(/forbidden/.test(bpost({ kind: 'provision', accessToken: 'jwt', folderId: 'F-broker' }).error || ''),
  'standalone provision kind -> forbidden for a broker (admin-only)');
// (d) An admin passes the standalone provision gate (fails later on the missing row, not forbidden).
check(!/forbidden/.test(post({ kind: 'provision', accessToken: 'jwt', folderId: 'F-broker' }).error || ''),
  'standalone provision kind -> admin passes the gate');
// (e) Offboarding stays super/admin: a broker is forbidden.
const rbOff = bpost({ kind: 'offboard', accessToken: 'jwt', full_name: 'Jane Doe', quay_email: 'jane@quay1.co.za', requested_by: 'broker@quay1.co.za', requested_by_name: 'Bree Broker' });
check(/forbidden/.test(rbOff.error || ''),
  `broker offboard -> forbidden (offboarding stays super/admin)${rbOff.ok ? ' -> WRONGLY ALLOWED' : ''}`);

console.log('7. decline_fica: structured per-document declines + contract_incorrect (SPEC 9.2)');
ctx.upsertOnboardingRow_({ folderId: 'DECL-1', entity: 'quay1', name: 'Deb Decline', email: 'deb@personal.com' });
// (a) nothing selected -> validation error
const dNone = post({ kind: 'decline_fica', accessToken: 'jwt', folderId: 'DECL-1' });
check(dNone.ok === false && /at least one/.test(dNone.error || ''),
  'decline with nothing selected -> validation error');
// (b) per-document declines + contract incorrect -> ok, reasons stored AGAINST each document
const dOk = post({ kind: 'decline_fica', accessToken: 'jwt', folderId: 'DECL-1',
  declines: { id: 'blurry scan', bank: 'wrong account holder' }, contract_incorrect: 'commission % is wrong' });
check(dOk.ok === true && dOk.declined === true, 'structured decline returns ok/declined');
const declRow = ctx.readOnboardingByFolder_('DECL-1');
const declRec = JSON.parse(declRow.fica_declines_json || '{}');
check(!!(declRec.docs && declRec.docs.id && /blurry/.test(declRec.docs.id.reason) && declRec.docs.bank && !declRec.docs.poa),
  'reasons stored PER document (id + bank present with their own reasons, poa absent)');
check(!!(declRec.contract_incorrect && /commission/.test(declRec.contract_incorrect.reason)),
  'contract_incorrect stored separately with its own reason');
check(String(declRow.status) === 'FICA declined' && !!declRow.declined_at && declRow.declined_by === 'boss@quay1.co.za',
  'status FICA declined + durable declined_at/declined_by stamped (who + when)');
// (c) legacy single { reason } still accepted (back-compat, never regress the old client)
ctx.upsertOnboardingRow_({ folderId: 'DECL-2', entity: 'quay1', name: 'Leg Acy', email: 'leg@personal.com' });
check(post({ kind: 'decline_fica', accessToken: 'jwt', folderId: 'DECL-2', reason: 'general problem' }).ok === true,
  'legacy single { reason } decline still accepted (back-compat)');

console.log('8. aqua acceptance notice: drafts (not sends) in DRY_RUN, no-op for quay1 (SPEC 9.4)');
ctx.upsertOnboardingRow_({ folderId: 'AQ-1', entity: 'aqua', name: 'Aqua Contractor', email: 'aq@personal.com', start_date: '2026-09-01', team: 'Promo', designation: 'Promoter' });
check(ctx._maybeNotifyAquaAccepted_('AQ-1', ctx.readOnboardingByFolder_('AQ-1')) === false,
  'aqua notice in DRY_RUN drafts and returns false (deferred send once armed)');
check(!ctx.readOnboardingByFolder_('AQ-1').aqua_accept_notified_at,
  'aqua notice NOT stamped in DRY_RUN (previewable; the real send still fires once armed)');
ctx.upsertOnboardingRow_({ folderId: 'Q1-1', entity: 'quay1', name: 'Quay Person' });
check(ctx._maybeNotifyAquaAccepted_('Q1-1', ctx.readOnboardingByFolder_('Q1-1')) === false,
  'aqua notice is a no-op for a quay1 row');

console.log('9. aqua provisioning scope: Google + Dialfire only, PropData/CMA stripped (SPEC 8)');
const aqSys = ctx.resolveSystems_('aqua', [], null, '', '');
check(aqSys.indexOf('google') >= 0 && aqSys.indexOf('dialfire') >= 0 && aqSys.indexOf('propdata') < 0 && aqSys.indexOf('cma') < 0,
  'aqua defaults to google + dialfire (no propdata, no cma)');
const aqExplicit = ctx.resolveSystems_('aqua', ['cma'], ['google', 'propdata', 'cma', 'dialfire'], '', '').slice().sort().join(',');
check(aqExplicit === 'dialfire,google', `aqua caps an explicit propdata/cma request to google + dialfire only (got ${aqExplicit})`);
check(ctx.resolveSystems_('quay1', [], ['google', 'propdata'], '', '').indexOf('propdata') >= 0,
  'quay1 scope UNCHANGED (explicit propdata retained)');

console.log('10. aqua contract stage validates the five HR fields (SPEC 7)');
// Use a checksum-VALID SA ID so onboardAqua_'s ID validation (added in #38) passes and we reach the
// five-HR-field checks this test actually exercises; '9001010000000' fails the SA ID checksum.
check(/cell phone number is required/.test(post({ kind: 'onboard_aqua', accessToken: 'jwt', name: 'A B', id_number: '9001015000085', email: 'a@b.com', start_date: '2026-09-01' }).error || ''),
  'aqua onboard requires a cell number');
check(/start date is required/.test(post({ kind: 'onboard_aqua', accessToken: 'jwt', name: 'A B', id_number: '9001015000085', email: 'a@b.com', contact: '0820000000' }).error || ''),
  'aqua onboard requires a start date');

console.log('11. decline gates acceptance - a declined candidate cannot be accepted (review fix B)');
ctx.upsertOnboardingRow_({ folderId: 'GATE-1', entity: 'quay1', name: 'Gaby Gate', email: 'gaby@personal.com',
  fica_contract: 'Received x', fica_id: 'Received x', fica_poa: 'Received x', fica_bank: 'Received x' });
post({ kind: 'decline_fica', accessToken: 'jwt', folderId: 'GATE-1', declines: { bank: 'wrong account holder' } });
const gate = post({ kind: 'approve', accessToken: 'jwt', folderId: 'GATE-1' });
check(gate.ok === false && /declined/.test(gate.error || ''),
  `approve is refused while declined_at is set${gate.ok ? ' -> WRONGLY ALLOWED' : ''}`);
ctx.setOnboardingCell_('GATE-1', ctx.ONB_COL.declined_at, '');   // simulate the candidate re-uploading (ficaUpload_ clears it)
const gate2 = post({ kind: 'approve', accessToken: 'jwt', folderId: 'GATE-1' });
check(!(gate2.error && /declined/.test(gate2.error)), 'once the decline is cleared, approval is no longer blocked by the decline gate');

console.log('12. provisionAll_ re-applies the Aqua entity cap (review fix D)');
ctx.upsertOnboardingRow_({ folderId: 'CAP-1', entity: 'aqua', name: 'Cappy Cap', email: 'cap@personal.com', approved_at: '2026-01-01' });
const cap = ctx.provisionAll_('CAP-1', ['google', 'propdata', 'cma', 'dialfire'], { email: 'boss@quay1.co.za', role: { is_admin: true } });
check(!!(cap.results && cap.results.google) && !cap.results.propdata && !cap.results.cma,
  `provisionAll_ strips propdata/cma for an aqua person even when passed explicitly (got ${Object.keys(cap.results || {}).join(',') || 'none'})`);

console.log();
if (FAIL.length) {
  console.log(`RESULT: SEAM NOT YET CONFORMED (${FAIL.length} check(s) fail CONTRACTS section 8)`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (doPost conforms to CONTRACTS section 8 end-to-end)');
process.exit(0);
