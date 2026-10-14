// End-to-end proof that the Tuesday induction digest surfaces BOTH a Quay 1 inductee and an
// induction-eligible AQUA inductee due this week. Aqua Broker Assistants / Lead Nurturers now attend
// induction (see _maybeAquaInduction_), so an Aqua inductee with an induction week this week must show
// in the digest too - previously the digest filtered strictly to entity==='quay1' and silently dropped
// them. This drives the REAL tuesdayDigest_ (sending through the GmailApp mock) and inspects the sent
// digest's subject + HTML body.
//
// Run:  TZ=Africa/Johannesburg node tests/e2e_digest_aqua.js

const { loadGas, DEFAULT_PROPS } = require('./load_gas');

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

console.log('=== Tuesday induction digest includes Aqua inductees ===');

const g = loadGas({ props: Object.assign({}, DEFAULT_PROPS, { DRY_RUN: '0' }), dryRun: false });
g.getSheet('Onboarding');

// This week's induction Wednesday + Thursday (the same week tuesdayDigest_ buckets against).
const monday = g.ctx._mondayOfThisWeek_();
const wed = g.ctx._isoDate_(g.ctx._addDays_(monday, 2));
const thu = g.ctx._isoDate_(g.ctx._addDays_(monday, 3));
const approved = '2026-01-01T00:00:00Z';   // accepted -> not "Awaiting acceptance" noise

// A Quay 1 inductee due this week.
g.ctx.upsertOnboardingRow_({
  folderId: 'Q1-1', entity: 'quay1', name: 'Quinn Quay', email: 'quinn@personal.com',
  contact: '0820000001', ffc_status: 'full', induction_wed: wed, induction_thu: thu, approved_at: approved,
});
// An induction-eligible Aqua inductee (Broker Assistant) due the SAME week.
g.ctx.upsertOnboardingRow_({
  folderId: 'AQ-1', entity: 'aqua', name: 'Reuben Broker', email: 'reuben@personal.com',
  contact: '0820000002', ffc_status: 'full', designation: 'Broker Assistant',
  induction_wed: wed, induction_thu: thu, approved_at: approved,
});
// A non-attending Aqua contractor (Fancy Caller) with NO induction week - must NOT appear (we surface
// Aqua INDUCTEES, not every Aqua contractor).
g.ctx.upsertOnboardingRow_({
  folderId: 'AQ-2', entity: 'aqua', name: 'Faye Caller', email: 'faye@personal.com',
  contact: '0820000003', designation: 'Fancy Caller', approved_at: approved,
});

g.ctx.tuesdayDigest_();

const digest = g.calls.emailsSent.filter((e) => /induction digest/.test(e.subj || ''))[0];
const html = (digest && digest.o && digest.o.htmlBody) || '';

check(!!digest, `a digest email was sent${digest ? '' : ' (none found)'}`);
check(/\(2 due,/.test(digest ? digest.subj : ''), `subject counts 2 due (both inductees) -> "${digest ? digest.subj : ''}"`);
check(html.indexOf('Quinn Quay') >= 0, 'HTML body includes the Quay 1 inductee (Quinn Quay)');
check(html.indexOf('Reuben Broker') >= 0, 'HTML body includes the Aqua inductee (Reuben Broker)');
check(html.indexOf('(Aqua)') >= 0, 'Aqua inductee is clearly entity-labelled "(Aqua)"');
check(html.indexOf('Faye Caller') < 0, 'non-attending Aqua contractor (no induction week) is NOT listed');

console.log('');
console.log(FAIL.length ? ('RESULT: FAIL (' + FAIL.length + ') -> ' + FAIL.join(' | '))
  : 'RESULT: PASS (digest surfaces both the Quay 1 and the induction-eligible Aqua inductee; non-inductee Aqua excluded)');
process.exit(FAIL.length ? 1 : 0);
