/**
 * CandidateDetail.js - the structured per-candidate record behind the Progress report "click-through"
 * detail page (web/app.detail.js). Assembles one candidate's full onboarding picture from the row +
 * FICA ticks + provisioning queue + credential, and precomputes the journey stepper so the frontend
 * just renders. Read-only. Additive + self-contained so the whole detail feature can be removed later.
 *
 * Public surface:
 *   candidateDetail_(folderId, ctx) - { ok, ...detail } | { ok:false, error }   auth/ownership enforced.
 *
 * The stepper stages (Quay 1): Contract sent -> FICA received -> Approved -> Accounts set up ->
 * Induction -> Complete. Aqua drops Induction (no induction step). Each stage is done / current /
 * upcoming: the earliest not-done stage is "current", everything before it "done", the rest "upcoming".
 */

/** Mask an ID/passport for display: keep the first 6, hide the rest. '' stays ''. */
function _maskId_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return s.length <= 6 ? s : s.slice(0, 6) + '…';
}

/** Build the ordered journey steps with done/current/upcoming state + a date each. */
function _candidateSteps_(o, fica, isAqua) {
  var docsIn = !!(fica.contract && fica.id && fica.poa && fica.bank);
  var inductionPassed = _inductionDayPassed_(o);
  var steps = [
    { key: 'contract', label: 'Contract sent', date: o.contract_emailed_at || '', done: !!o.contract_emailed_at },
    { key: 'fica', label: 'FICA received', date: o.fica_submitted_at || '', done: docsIn },
    { key: 'approved', label: 'Approved', date: o.approved_at || '', done: !!o.approved_at },
    { key: 'accounts', label: 'Accounts set up', date: o.provisioned_at || '', done: !!o.provisioned_at },
  ];
  if (!isAqua) {
    steps.push({ key: 'induction', label: 'Induction', date: o.induction_wed || '', done: inductionPassed });
  }
  var completeDone = !!o.provisioned_at && (isAqua ? !!o.welcome_email_at : inductionPassed);
  steps.push({ key: 'complete', label: 'Complete', date: '', done: completeDone });

  // Earliest not-done step = current; everything before it = done; after = upcoming.
  var currentIx = -1;
  for (var i = 0; i < steps.length; i++) { if (!steps[i].done) { currentIx = i; break; } }
  steps.forEach(function (s, ix) {
    s.state = s.done ? 'done' : (ix === currentIx ? 'current' : 'upcoming');
  });
  return steps;
}

/**
 * Full detail for one candidate. requireOnboarder_ is asserted at the call site; here we additionally
 * scope a non-admin caller to their OWN candidates (same _ownsRow_ gate as the pipeline), returning a
 * not_found rather than leaking another team's record.
 */
function candidateDetail_(folderId, ctx) {
  folderId = String(folderId || '');
  if (!folderId) return { ok: false, error: 'missing reference' };
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'not_found' };

  var isAdmin = !!(ctx && ctx.role && (ctx.role.is_super || ctx.role.is_admin));
  var email = ctx && ctx.email ? String(ctx.email).toLowerCase() : '';
  if (!isAdmin && !_ownsRow_(o, email)) return { ok: false, error: 'not_found' };

  var isAqua = (o.entity || 'quay1') === 'aqua';
  var fica = ficaStatus_(folderId);
  var cred = _credentialFor_(folderId) || {};

  // Account setup: the provisioning-queue rows for this candidate (system -> status). CMA / Dialfire are
  // request-based, so surface a "Requested" marker from their stamps when not already a queue row.
  var accounts = [];
  var seen = {};
  readQueue_(CFG.TAB.PROVISION_QUEUE).forEach(function (r) {
    if (r.folderId !== folderId) return;
    seen[String(r.system || '').toLowerCase()] = true;
    accounts.push({ system: r.system, status: r.status });
  });
  if (o.cma_requested_at && !seen.cma) accounts.push({ system: 'cma', status: 'requested' });
  if (o.dialfire_requested_at && !seen.dialfire) accounts.push({ system: 'dialfire', status: 'requested' });

  var steps = _candidateSteps_(o, fica, isAqua);

  return {
    ok: true,
    folderId: folderId,
    name: o.name || '',
    entity: o.entity || 'quay1',
    team: o.team || '',
    status: o.status || '',
    started_at: o.contract_emailed_at || '',
    personal: {
      phone: o.contact || '',
      email: o.email || '',
      id_masked: _maskId_(o.id_number),
      quay_email: cred.email || '',
    },
    onboarding: {
      senior_name: o.senior_name || '',
      senior_email: o.senior_email || '',
      requester_name: o.requester_name || '',
      designation: o.designation || '',
      start_date: o.start_date || '',
      commission: o.commission || '',
    },
    fica: { contract: !!fica.contract, id: !!fica.id, poa: !!fica.poa, bank: !!fica.bank, nda: !!fica.nda },
    induction: isAqua ? null : {
      wed: o.induction_wed || '', thu: o.induction_thu || '',
      venue: INDUCTION_ADDRESS, holiday_flag: o.induction_holiday_flag || '',
    },
    accounts: accounts,
    steps: steps,
    declined_at: o.declined_at || '',
    // Per-candidate communications history (every email actually sent to them), newest-first.
    comms: readComms_(folderId),
  };
}
