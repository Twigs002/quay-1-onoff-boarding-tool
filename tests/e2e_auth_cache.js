// Proof that verifyCaller_ caches token -> role, so the dashboard's repeated polls and every button
// press do NOT each pay two serial Supabase round-trips (the main cause of the authed-POST hangs).
//
// Run:  node tests/e2e_auth_cache.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

console.log('=== auth token -> role caching ===');

const ADMIN = { id: 'u1', email: 'boss@quay1.co.za', name: 'The Boss', is_admin: true, is_super: false, is_senior_broker: false, active: true };
const g = loadGas({ props: DEFAULT_PROPS, dryRun: true, authUser: ADMIN });
const authFetches = () => g.calls.urlFetch.filter((f) => /\/auth\/v1\/user|\/rest\/v1\/staff/.test(f.url)).length;

// A. First verify does the two Supabase round-trips (/auth/v1/user + /rest/v1/staff).
const r1 = g.ctx.verifyCaller_('jwt-token-A');
check(!!r1 && r1.email === 'boss@quay1.co.za' && r1.isAdmin === true, 'first verify resolves the role');
check(authFetches() === 2, `first verify makes 2 Supabase fetches (got ${authFetches()})`);

// B. Second verify with the SAME token is served from cache - NO new fetches.
const r2 = g.ctx.verifyCaller_('jwt-token-A');
check(!!r2 && r2.email === 'boss@quay1.co.za' && r2.isAdmin === true, 'cached verify returns the same role');
check(authFetches() === 2, `second verify (same token) adds 0 fetches, still 2 (got ${authFetches()})`);

// C. Ten more calls with the same token stay served from cache (the real-world poll/press pattern).
for (let i = 0; i < 10; i++) g.ctx.verifyCaller_('jwt-token-A');
check(authFetches() === 2, `11 same-token verifies total still 2 fetches (got ${authFetches()})`);

// D. A DIFFERENT token is a cache miss -> its own 2 fetches (cache is keyed per token, not global).
g.ctx.verifyCaller_('jwt-token-B');
check(authFetches() === 4, `a different token adds its own 2 fetches, total 4 (got ${authFetches()})`);

// E. An empty token never touches the network.
const before = authFetches();
const r0 = g.ctx.verifyCaller_('');
check(r0 === null && authFetches() === before, 'empty token returns null with no fetch');

console.log('');
console.log(FAIL.length ? ('RESULT: FAIL (' + FAIL.length + ') -> ' + FAIL.join(' | '))
  : 'RESULT: PASS (token->role cached; repeat auths add no Supabase round-trips; keyed per token)');
process.exit(FAIL.length ? 1 : 0);
