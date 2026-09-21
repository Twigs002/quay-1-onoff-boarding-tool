// Lightweight smoke test for web/app.detail.js: load the module with a minimal fake DOM + HUB stub,
// open a candidate, and assert the rendered HTML contains the stepper + detail sections (no exceptions,
// no undefined refs). Not a full DOM test - just proves the template + wiring path executes cleanly.
//
// Run:  node tests/detail_render_smoke.js

const FAIL = [];
const check = (cond, label) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`); if (!cond) FAIL.push(label); };

function fakeNode() {
  return {
    _html: '', className: '', style: {}, hidden: false, disabled: false,
    children: [], value: '2026-10-14',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(el) { this._appended = el; return el; },
    remove() {}, focus() {},
    addEventListener() {},
    classList: { add() {}, remove() {} },
    querySelector() { return fakeNode(); },
    querySelectorAll() { return []; },
  };
}

const STUB = {
  ok: true, folderId: 'CD-1', name: 'Shané Burger', entity: 'quay1', team: 'Wombats',
  status: 'Provisioned', started_at: '2026-09-14T09:00:00Z', declined_at: '',
  personal: { phone: '+27 67 416 4264', email: 'shane@personal.com', id_masked: '900510…', quay_email: 'shane@quay1.co.za' },
  onboarding: { senior_name: 'Jamie-Lee Smith', requester_name: 'Marthinus Bosman', designation: 'Sell · Residential · Broker', start_date: '16 September 2026' },
  fica: { contract: true, id: true, poa: true, bank: true, nda: false },
  induction: { wed: '2026-10-14', thu: '2026-10-15', venue: 'Ground Floor, 200 On Main, 200 Main Rd, Claremont', holiday_flag: '' },
  accounts: [{ system: 'google', status: 'done' }, { system: 'propdata', status: 'pending' }, { system: 'cma', status: 'requested' }],
  steps: [
    { key: 'contract', label: 'Contract sent', date: '2026-09-14T09:00:00Z', state: 'done' },
    { key: 'fica', label: 'FICA received', date: '2026-09-15', state: 'done' },
    { key: 'approved', label: 'Approved', date: '2026-09-15', state: 'done' },
    { key: 'accounts', label: 'Accounts set up', date: '2026-09-15', state: 'done' },
    { key: 'induction', label: 'Induction', date: '2026-10-14', state: 'current' },
    { key: 'complete', label: 'Complete', date: '', state: 'upcoming' },
  ],
};

global.window = {
  HUB: {
    esc: (s) => String(s == null ? '' : s), el: () => fakeNode(), $: () => fakeNode(),
    api: async () => STUB, toast: () => {},
    KINDS: { candidateDetail: 'candidate_detail', resendPacket: 'resend_packet', setInductionWeek: 'set_induction_week' },
    getUser: () => ({ isAdmin: true }),
    entTag: (e) => `<span class="entity-tag ${e}">${e}</span>`,
  },
};
global.document = { createElement: () => fakeNode() };

console.log('=== app.detail.js render smoke ===');
try {
  require('../web/app.detail.js');
  check(typeof window.HUB.openCandidateDetail === 'function', 'module registered HUB.openCandidateDetail');

  const wrap = fakeNode();
  wrap.children = [fakeNode(), fakeNode()];
  (async () => {
    await window.HUB.openCandidateDetail('CD-1', wrap);
    const html = wrap._appended && wrap._appended._html || '';
    check(/Back to Progress report/.test(html), 'back button rendered');
    check(/class="card steps"/.test(html) && /class="step done"/.test(html) && /class="step current"/.test(html), 'stepper with done + current states');
    check(/Shané Burger/.test(html) && /Wombats/.test(html), 'candidate identity rendered');
    check(/fs-title">Personal details/.test(html) && /fs-title">FICA documents/.test(html) && /fs-title">Account setup/.test(html), 'detail sections rendered');
    check(/Google Workspace/.test(html) && /doc-on">Created/.test(html), 'accounts mapped to labels + chips');
    check(/data-cd-changeweek/.test(html) && /data-cd-resend/.test(html), 'admin stage actions present');
    check(!/undefined/.test(html), 'no "undefined" leaked into the HTML');

    console.log();
    if (FAIL.length) { console.log(`RESULT: FAIL (${FAIL.length})`); FAIL.forEach((f) => console.log('  - ' + f)); process.exit(1); }
    console.log('RESULT: PASS (module loads, detail renders stepper + sections + actions cleanly)');
    process.exit(0);
  })();
} catch (e) {
  console.log('  [FAIL] threw: ' + e.message);
  process.exit(1);
}
