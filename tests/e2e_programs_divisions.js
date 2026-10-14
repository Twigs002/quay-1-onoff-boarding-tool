// Proof that _programsDivisions_ is resilient: a failed or unusable divisions fetch serves the
// last-known-good copy instead of an empty tree (which would make every account read "none"), and it
// never throws. The hot-path decoupling (own cache key, not busted on mutations) is by construction.
//
// The default harness UrlFetchApp mock answers the divisions URL with {"mock":true} (a 200 with no
// `sections`), which is exactly the "unusable body" case, so it exercises the fallback path.
//
// Run:  node tests/e2e_programs_divisions.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

console.log('=== programs divisions resilience ===');

// A. A usable last-known-good in Script Properties is served when the live fetch is unusable.
const LKG = JSON.stringify({ sections: [{ name: 'Rangers', teams: [] }] });
const gA = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { PROGRAMS_DIVISIONS_LKG: LKG }), dryRun: true });
const rA = gA.ctx._programsDivisions_();
check(rA && rA.sections && rA.sections.length === 1 && rA.sections[0].name === 'Rangers',
  'unusable fetch + stored LKG -> serves the last-known-good (not empty)');

// B. No last-known-good: graceful empty tree, and never throws.
const gB = loadGas({ props: DEFAULT_PROPS, dryRun: true });
let threw = false, rB = null;
try { rB = gB.ctx._programsDivisions_(); } catch (e) { threw = true; }
check(!threw, 'never throws');
check(rB && Array.isArray(rB.sections) && rB.sections.length === 0, 'cold failure with no LKG -> {sections:[]}');

console.log('');
console.log(FAIL.length ? ('RESULT: FAIL (' + FAIL.length + ') -> ' + FAIL.join(' | '))
  : 'RESULT: PASS (divisions fetch serves stale on failure, never empties or throws)');
process.exit(FAIL.length ? 1 : 0);
