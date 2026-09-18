// Proof that a per-document FICA decline makes the resubmit form + backend collect ONLY the flagged
// document(s): the form renders just those uploads, and ficaUpload_ accepts a doc-only resubmit without
// requiring FFC / a work permit and WITHOUT blanking the details the candidate already submitted.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_fica_correction.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };
const file = (label) => ({ label, ext: 'pdf', mimeType: 'application/pdf', dataBase64: 'AA==' });

console.log('=== FICA correction mode (resubmit only the declined document) ===');

const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
g.getSheet('Onboarding');
const ctx = g.ctx;

// -- A. Aqua contractor, ONLY the signed contract was declined (the reported scenario). ----------------
console.log('A. Aqua, contract-only decline -> form shows just the contract; resubmit preserves data');
ctx.upsertOnboardingRow_({
  folderId: 'FC-A', entity: 'aqua', name: 'Brandon Hayward', email: 'brandon@personal.com',
  bank_name: 'FNB', account_number: '1234567', nok_name: 'Jo Hayward',
});
['id', 'poa', 'bank', 'contract'].forEach((k) => ctx.tickFica_('FC-A', k));   // everything was on file
ctx.setOnboardingCell_('FC-A', ctx.ONB_COL.fica_declines_json, JSON.stringify({ docs: {}, contract_incorrect: { reason: 'wrong version', by: 'admin', at: '2026-01-01' } }));

const formA = ctx.ficaForm_('FC-A').getContent();
check(/Just a quick correction/.test(formA) && /your signed contract/.test(formA), 'A: correction banner names the contract');
check(/id="f_contract"/.test(formA), 'A: contract upload is shown');
check(!/id="f_id"/.test(formA) && !/id="f_addr"/.test(formA) && !/id="f_bank"/.test(formA), 'A: ID / proof-of-address / bank uploads are NOT shown');
// Match the CARD HEADERS (the field labels also appear in the submit script, so match "- X</p>").
check(!/Next of kin<\/p>/.test(formA) && !/Bank details<\/p>/.test(formA) && !/Professional status<\/p>/.test(formA), 'A: unrelated cards (NoK / bank / FFC) are NOT shown');

const rA = ctx.ficaUpload_({ folderId: 'FC-A', details: {}, files: [file('CONTRACT')] });
check(rA.ok === true, 'A: contract-only resubmit succeeds');
const rowA = ctx.readOnboardingByFolder_('FC-A');
check(ctx.ficaStatus_('FC-A').contract === true, 'A: contract re-ticked');
check(String(rowA.fica_declines_json || '') === '', 'A: decline record cleared');
check(rowA.bank_name === 'FNB' && rowA.account_number === '1234567' && rowA.nok_name === 'Jo Hayward', 'A: previously-submitted details NOT blanked');

// -- B. Quay 1 broker on a PASSPORT, only proof of address declined. FFC + work-permit gates skipped. --
console.log('B. Quay 1 broker (passport), POA-only decline -> no FFC / no permit required, FFC preserved');
ctx.upsertOnboardingRow_({
  folderId: 'FC-B', entity: 'quay1', name: 'Pieter Passport', email: 'pieter@personal.com',
  id_number: 'A1234567', ffc_status: 'full', ffc_number: 'FFC99', bank_name: 'ABSA',
});
['id', 'poa', 'bank', 'contract'].forEach((k) => ctx.tickFica_('FC-B', k));
ctx.setOnboardingCell_('FC-B', ctx.ONB_COL.fica_declines_json, JSON.stringify({ docs: { poa: { reason: 'blurry', by: 'admin', at: '2026-01-01' } } }));

const formB = ctx.ficaForm_('FC-B').getContent();
check(/id="f_addr"/.test(formB), 'B: proof-of-address upload is shown');
check(!/id="f_contract"/.test(formB) && !/id="f_bank"/.test(formB) && !/Professional status/.test(formB), 'B: contract / bank / FFC cards are NOT shown');

// Resubmit POA only: NO ffc_status, NO work permit in the body.
const rB = ctx.ficaUpload_({ folderId: 'FC-B', details: {}, files: [file('POA')] });
check(rB.ok === true, 'B: POA-only resubmit succeeds despite passport ID + no FFC in the post');
const rowB = ctx.readOnboardingByFolder_('FC-B');
check(ctx.ficaStatus_('FC-B').poa === true, 'B: proof of address re-ticked');
check(rowB.ffc_status === 'full' && rowB.ffc_number === 'FFC99', 'B: FFC status/number preserved');
check(rowB.bank_name === 'ABSA', 'B: bank details preserved');

// -- C. Regression: a fresh candidate (no decline) still gets the FULL form. ---------------------------
console.log('C. No decline -> the full FICA form is unchanged');
ctx.upsertOnboardingRow_({ folderId: 'FC-C', entity: 'quay1', name: 'Fiona First', email: 'fiona@personal.com' });
const formC = ctx.ficaForm_('FC-C').getContent();
check(/Next of kin<\/p>/.test(formC) && /Bank details<\/p>/.test(formC) && /Professional status<\/p>/.test(formC) && !/Just a quick correction/.test(formC), 'C: full form shown, no correction banner');

console.log();
if (FAIL.length) {
  console.log(`RESULT: FAIL (${FAIL.length})`);
  FAIL.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('RESULT: PASS (declined-only uploads shown; doc-only resubmit skips FFC/permit + preserves data; full form intact)');
process.exit(0);
