// Proof that hrPromote_ ALWAYS lands the HR folder link: when the destination tab (the brokers tab
// "IGSICA EMPLOYEES (Automated)" and the Aqua tab ship without one) has no folder column, it creates a
// "Folder link" column at the far right and writes the URL, instead of silently dropping it. Idempotent.
//
// Run:  node tests/e2e_hr_folder_link.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };
const lc = (h) => String(h == null ? '' : h).trim().toLowerCase();

console.log('=== HR folder link lands on a tab with no folder column ===');

const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0', HR_SYNC_ENABLED: '1', HR_SHEET_ID: 'MOCK_HR' }), dryRun: false });
g.getSheet('Onboarding');
// Brokers destination tab with real headers but NO folder/link column (the live situation).
const dest = g.getSheet('IGSICA EMPLOYEES (Automated)');
dest.appendRow(['Name & Surname', 'Identification Number', 'Designation', 'Team working']);

g.ctx.upsertOnboardingRow_({ folderId: 'FL-1', entity: 'quay1', name: 'Brad Broker', id_number: '8001015009087', team: 'Lions' });
const r = g.ctx.hrPromote_('FL-1');
check(!!r && r.ok === true, `hrPromote_ succeeds (${r && r.ok})`);

const headers = dest.getDataRange().getValues()[0];
const fIdx = headers.findIndex((h) => lc(h) === 'folder link');
check(fIdx >= 0, `a "Folder link" column was created (headers: ${headers.join(' | ')})`);
const rows = dest.getDataRange().getValues();
const bradRow = rows.find((row) => String(row[1]) === '8001015009087');
check(!!bradRow && String(bradRow[fIdx]) === 'https://drive.google.com/drive/folders/FL-1',
  `the folder URL was written to Brad's row (got "${bradRow ? bradRow[fIdx] : 'no row'}")`);

// Idempotent: a second promote reuses the column (no duplicate) and the link stays.
g.ctx.hrPromote_('FL-1');
const headers2 = dest.getDataRange().getValues()[0];
check(headers2.filter((h) => lc(h) === 'folder link').length === 1, 'no duplicate Folder link column on re-run');
const rows2 = dest.getDataRange().getValues();
check(rows2.filter((row) => String(row[1]) === '8001015009087').length === 1, 'no duplicate row for Brad on re-run');

console.log('');
console.log(FAIL.length ? ('RESULT: FAIL (' + FAIL.length + ') -> ' + FAIL.join(' | '))
  : 'RESULT: PASS (folder link always lands; column auto-created when absent; idempotent)');
process.exit(FAIL.length ? 1 : 0);
