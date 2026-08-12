/**
 * Provisioning.js - account creation. Google Workspace + PropData are API-based and run INLINE
 * here, written to the Provisioning Queue as done/error for audit. CMA and Dialfire
 * have no usable API, so this module ENQUEUES pending rows for the Python worker.
 *
 * Owner: backend. See docs/SPEC.md section 4 and docs/CONTRACTS.md section 1.
 *
 * BLOCKER B0 (RESEARCH 0 + 4.1): Google/AdminDirectory has NO prior implementation. Built fresh
 * as an AdminDirectory advanced service (enabled in appsscript.json + Cloud console Admin SDK).
 * The Apps Script owner must be a Workspace super-admin for inserts to succeed. Cannot be
 * live-tested from here; ships behind DRY_RUN. The va-automation key on disk is a DIFFERENT
 * project and does NOT authorize Directory writes.
 *
 * Google is the linchpin: created FIRST so quay_email is available to later rows.
 *
 * Public surface:
 *   resolveSystems_(entity, programs, explicit, team, activity) - [system...]  core + mapped programs + team map, then the entitlements matrix strips systems the broker role may not hold.
 *   provisionAll_(folderId, systems, ctx)       - {ok, results:{system:status}}  auth enforced at call site.
 *   provisionReadyBatch_()                      - {provisioned,...}  SCHEDULED Wed 08:00: provision every row whose signed contract + FICA are in (nothing is created at onboard time).
 *   googleCreate_(person)        - {email, tempPw, dryRun?}  Users.insert + Members.insert.
 *   googleSuspend_(email)        - {ok, ...}  Users.update {suspended:true}. Suspend only (user choice).
 *   recordCredential_(entry)     - void  upsert the created email + temp password into the private
 *                                  'Google Credentials' tab (superuser-readable). Live path only.
 *   propdataCreate_(person) / propdataDeactivate_(person) - {ok, dryRun?}  feeds-api REST.
 *   enqueueBrowserSystems_(person, systems, action) - [queue_id...]  pending worker rows.
 *
 * DRY_RUN_() default true: inline provisioners log the payload they WOULD send and write a done
 * row with {"dry_run":true}. No live mutation until armed.
 */

/** Resolve the systems to provision. An explicit list (the form's ticked systems) is the base
 *  selection; when none is given we fall back to the entity core set plus any systems mapped from
 *  ticked programs. On TOP of either, the team's Team-Directory Systems are ALWAYS unioned in as a
 *  baseline (Blocker B.3) - a team configured to always need a system gets it even when the
 *  operator's explicit ticks omit it. Filtered to the SYSTEMS enum; hubspot excluded here (seat
 *  create is a separate flag-gated concern). `team` is optional - behaviour is unchanged when the
 *  team has no mapped systems (the default until the Systems column is filled). */
function resolveSystems_(entity, programs, explicit, team, activity) {
  var set = {};
  var add = function (s) {
    s = String(s || '').toLowerCase();
    if (CFG.SYSTEMS.indexOf(s) >= 0 && s !== 'hubspot') set[s] = true;
  };
  if (explicit && explicit.length) {
    explicit.forEach(add);
  } else {
    (CFG.CORE_SYSTEMS[entity] || []).forEach(add);
    _programCodes_(programs).forEach(function (code) {
      var sys = CFG.PROGRAM_SYSTEM[code];
      if (sys) add(sys);
    });
  }
  // Team-configured systems are a baseline that applies in BOTH branches (see docstring).
  if (team) teamMapping_(team).systems.forEach(add);
  // Entitlements matrix has the FINAL say: strip systems this broker role may not hold, even when
  // explicitly ticked or team-mapped (e.g. a JB assistant never gets CMA). See Config.
  return entitlementFilter_(Object.keys(set), activity);
}

/** Extract the broker role token ('sb' full Broker | 'jb' Assistant) from a broker-activity value.
 *  Handles BOTH the code form (sell_res_jb) and the human label form ("... (JB)"). '' if unknown. */
function brokerRole_(activity) {
  var s = String(activity == null ? '' : activity).toLowerCase();
  if (/_jb\b/.test(s) || /\(jb\)/.test(s)) return 'jb';
  if (/_sb\b/.test(s) || /\(sb\)/.test(s)) return 'sb';
  return '';
}

/** Apply the entitlements matrix: remove any system barred for this broker role. Logs what it
 *  strips (audit trail) so a missing CMA on a JB is explained, not silent. */
function entitlementFilter_(systems, activity) {
  var role = brokerRole_(activity);
  var barred = (role && CFG.ENTITLEMENTS_BARRED[role]) || [];
  if (!barred.length) return systems.slice();
  var removed = [];
  var kept = systems.filter(function (s) {
    if (barred.indexOf(s) >= 0) { removed.push(s); return false; }
    return true;
  });
  if (removed.length) logAudit_('entitlement_barred', { role: role, activity: activity, removed: removed });
  return kept;
}

/** Normalise programs (array of {code} / strings / comma string) to lower-case code strings. */
function _programCodes_(programs) {
  var arr = Array.isArray(programs) ? programs
    : (typeof programs === 'string' ? safeJsonParse_(programs, []) : []);
  if (!Array.isArray(arr)) arr = [];
  return arr.map(function (p) {
    return String((p && p.code != null) ? p.code : p).trim().toLowerCase();
  }).filter(Boolean);
}

/** Load the person fields provisioning needs from the Onboarding row. */
function _personFor_(folderId) {
  var o = readOnboardingByFolder_(folderId) || {};
  return {
    folderId: folderId,
    full_name: o.name || '',
    first_name: firstName_(o.name || ''),
    last_name: lastName_(o.name || ''),
    id_number: o.id_number || '',
    cell: o.contact || '',
    email: o.email || '',
    team: o.team || '',
    designation: o.designation || '',
    // FFC intake fields -> PropData profile type (agent|specialist). profile_type is persisted at
    // FICA time; ffc_status is kept as a fallback so the role still derives if it was not.
    ffc_status: o.ffc_status || '',
    propdata_profile_type: o.propdata_profile_type || '',
    photo_file_id: o.photo_file_id || '',   // FICA headshot -> branded profile photo (full-status only)
    quay_email: '',
  };
}

/** The PropData role for a person: the FICA-persisted profile type, else derived from FFC status.
 *  Unknown/empty FFC -> 'specialist' (the conservative numbered profile) - the full agent profile is
 *  only granted once a 'full' FFC is declared at FICA, which happens AFTER onboard-time provisioning.
 *  PropData creation is B2-blocked + dry-run, so a pre-FICA placeholder never becomes a real profile. */
function _propdataRole_(person) {
  return person.propdata_profile_type || propdataProfileType_(person.ffc_status);
}

/**
 * Orchestrate provisioning for one person: Google first (inline), then PropData (inline), then
 * enqueue the browser systems for the worker. Returns { ok, results:{system:status} }.
 */
// NOTE: auth is enforced at the CALL SITE, not here. provisionAll_ runs from two paths:
//   - the scheduled provisionReadyBatch_ (Wednesday 08:00), which provisions a row ONLY once its
//     signed contract + FICA docs are in - NOTHING is created at onboard time anymore;
//   - the standalone 'provision' kind (_provisionDispatch_), which asserts requireAdmin_.
// ctx is passed through for downstream audit/identity use.
function provisionAll_(folderId, systems, ctx) {
  var person = _personFor_(folderId);
  var results = {};
  var anyError = false;

  if (systems.indexOf('google') >= 0) {
    var g = _runInline_(person, 'google', function () { return googleCreate_(person); });
    results.google = g.status;
    if (g.status === 'error') anyError = true;
    if (g.result && g.result.email) person.quay_email = g.result.email;
  }

  // PropData is now a browser-worker system (see WORKER_SYSTEMS); it is enqueued below
  // with the other browser systems rather than created inline via the old feeds-api REST.
  var browser = systems.filter(function (s) { return CFG.WORKER_SYSTEMS.indexOf(s) >= 0; });
  enqueueBrowserSystems_(person, browser, 'create');
  browser.forEach(function (s) { results[s] = 'pending'; });

  // dryRun: in test mode the inline provisioners only log; nothing real was created, so callers must
  // NOT mark the row permanently provisioned (it must still run for real once armed). anyError: an
  // inline system threw and was recorded as an 'error' queue row, so the row is NOT fully set up.
  return { ok: !anyError, results: results, anyError: anyError, dryRun: DRY_RUN_() };
}

/**
 * ONE-OFF armed test: create ONLY the Google account for a specific onboarding folder, live.
 * Bypasses the provisioned_at gate (calls provisionAll_ directly) and forces systems to ['google']
 * so it never touches PropData/Dialfire (no worker + no alan email). DRY_RUN must be 0 for this to
 * create a real account; with DRY_RUN on it just logs. Run from the editor. Safe to delete after.
 */
function provisionGoogleLiveFor_(folderId) {
  var r = provisionAll_(folderId, ['google'], { email: 'admin@' + CFG.DOMAIN, role: 'admin', name: 'Admin' });
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}
function provisionJohnSmithGoogleLive() {
  return provisionGoogleLiveFor_('1ix1BEEuQ9VMu2_zfWGxDvhcZ194L38FR');  // "John Smith Test"
}

/** ONE-OFF cleanup: delete the "John Smith Test" live Google Workspace account. The tracker rows
 *  (onboarding / credentials / queue) are removed separately; the PDMS agent is removed by hand. */
function removeJohnSmithTestGoogle() {
  var email = 'john@quay1.co.za';
  var out = {};
  try { AdminDirectory.Users.remove(email); out.google = 'deleted ' + email; }
  catch (e) { out.google = 'error (may already be gone): ' + String(e); }
  Logger.log(JSON.stringify(out));
  return out;
}

/** ONE-OFF cleanup after the 2026-08-10 end-to-end test run: delete the leftover test Google
 *  Workspace accounts (john@ from the earlier go-live, zztest@ from the full-flow test) and trash
 *  the two test candidate Drive folders (Zztest + Zzdecline, with their contract/FICA files). The
 *  tracker rows were already removed via gspread. Idempotent - re-running is safe (already-gone
 *  items just report an error string). Run once from the editor. */
function cleanupTestArtifacts() {
  var out = { users: {}, folders: {} };
  ['john@quay1.co.za', 'zztest@quay1.co.za'].forEach(function (email) {
    try { AdminDirectory.Users.remove(email); out.users[email] = 'deleted'; }
    catch (e) { out.users[email] = 'error (may already be gone): ' + String(e); }
  });
  // Zztest Candidate + Zzdecline Testcase folders (contract PDF + FICA uploads live inside).
  ['1vq4sMRxGLI0q58X3UYGJzBXj-FDlQJUF', '1BVqp_f3gWrTSKkinUQPqFZNYUDxjfl74'].forEach(function (fid) {
    try { DriveApp.getFolderById(fid).setTrashed(true); out.folders[fid] = 'trashed'; }
    catch (e) { out.folders[fid] = 'error (may already be gone): ' + String(e); }
  });
  Logger.log(JSON.stringify(out));
  return out;
}

/**
 * ONE-SHOT GO-LIVE: arm the live flags atomically, then run the ready-batch so every ready candidate
 * (currently just "John Smith Test") is provisioned for real. setProperties(..., false) only ADDS/
 * updates these four keys - it never touches the other Script Properties (Supabase keys, template
 * IDs, folders), so there is no corruption risk. Google is created inline here; PropData is enqueued
 * for the Python worker (run poll.py after). Run once from the editor. Returns the batch summary.
 */
function goLiveAndProvisionAll() {
  PropertiesService.getScriptProperties().setProperties({
    DRY_RUN: '0',
    PROPDATA_LIVE: '1',
    HR_SYNC_ENABLED: '1',
    WORKER_SA_EMAIL: 'va-sheets-bot@va-automation-497708.iam.gserviceaccount.com',
  }, false);
  var out = provisionReadyBatch_();
  Logger.log('ARMED (DRY_RUN=0, PROPDATA_LIVE=1, HR_SYNC_ENABLED=1) + batch: ' + JSON.stringify(out, null, 2));
  return out;
}

// ---------------------------------------------------------------- deferred provisioning batch

/** Docs are in when the signed contract AND the three FICA docs (ID, proof of address, bank) are
 *  all uploaded. NDA (R) is a manual internal doc and does NOT gate provisioning (user decision).
 *  Docs-in is NECESSARY but NOT sufficient - an admin must still approve (see _provisionReady_). */
function _docsReady_(o) {
  return !!(o && o.fica_contract && o.fica_id && o.fica_poa && o.fica_bank);
}

/** Ready to provision = docs are in AND an admin has clicked "Approve & set up" (approved_at stamped).
 *  This is the ONE guard between an onboarded candidate and real account creation. A wrong-but-signed
 *  contract still cannot mint accounts until a human has reviewed and approved it. */
function _provisionReady_(o) {
  return !!(o && _docsReady_(o) && o.approved_at);
}

/**
 * SCHEDULED BATCH (Wednesday 08:00, installed by setupTriggers). Nothing is created at onboard time;
 * this is where accounts are actually provisioned - and ONLY for a row that is _provisionReady_ (a
 * signed contract + full FICA) and not already provisioned (provisioned_at empty). Idempotent: the
 * provisioned_at marker + the queue's own dedup mean a re-run never double-provisions. Uses the
 * systems resolved + persisted at onboard (systems_json); falls back to re-resolving if absent.
 * Google/DRY_RUN gating still applies inside googleCreate_ - an unarmed batch is a safe dry-run.
 */
function provisionReadyBatch_() {
  var ctx = { email: 'batch@' + CFG.DOMAIN, role: 'system', name: 'Provisioning batch' };
  var out = { provisioned: [], not_ready: 0, already: 0, errors: [] };
  listOnboarding_().forEach(function (o) {
    if (o.provisioned_at) { out.already++; return; }        // done in a prior run
    if (!_provisionReady_(o)) { out.not_ready++; return; }   // waiting on signed contract / FICA
    var systems = safeJsonParse_(o.systems_json, null);
    if (!Array.isArray(systems) || !systems.length) {
      systems = resolveSystems_(o.entity || 'quay1', o.programs, null, o.team, o.activity || o.designation);
    }
    try {
      var prov = provisionAll_(o.folderId, systems, ctx);
      if (prov.anyError) {
        setOnboardingStatus_(o.folderId, 'Setup error');
        out.errors.push({ folderId: o.folderId, error: 'an inline system failed' });
        return;   // leave provisioned_at empty so a later run retries it
      }
      if (prov.dryRun) { return; }   // test mode: do not mark done; the armed run will provision for real
      setOnboardingCell_(o.folderId, ONB_COL.provisioned_at, nowIso_());
      setOnboardingStatus_(o.folderId, 'Provisioned');
      _sendInductionInvite_(o.folderId, o);   // same one-time invite as the interactive accept path
      _maybeRequestCma_(o.folderId, o, systems);        // CMA/Dialfire account-requests also fire from
      _maybeRequestDialfire_(o.folderId, o, systems);   // the batch path (idempotent, stamped once)
      out.provisioned.push(o.folderId);
    } catch (err) {
      out.errors.push({ folderId: o.folderId, error: String(err) });
      logAudit_('provision_batch_failed', { folderId: o.folderId, error: String(err) });
    }
  });
  logAudit_('provision_batch_run', out);
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * IMMEDIATE-ON-APPROVE (kind:'approve'). An admin reviews the signed contract + FICA docs on the site
 * and clicks "Approve & set up". This is the ONLY path that turns a candidate into real accounts, and
 * it happens on that deliberate click - not on onboard, not on a timer. Idempotent: a row already
 * provisioned is a no-op success. requireAdmin_ is asserted at the call site (Router._approveDispatch_).
 */
function approveAndProvision_(folderId, ctx) {
  // Serialise: two concurrent "Approve & set up" clicks must not both provision (double account).
  // The lock also makes the read-check-provision-stamp one critical section.
  var lock = _acquireLock_();
  lock.waitLock(30000);
  try {
    var o = readOnboardingByFolder_(folderId);
    if (!o) return { ok: false, error: 'onboarding row not found' };
    if (o.provisioned_at) return { ok: true, already: true, message: 'already set up on ' + o.provisioned_at };
    if (!_docsReady_(o)) {
      return { ok: false, error: 'not ready: the signed contract and all FICA documents (ID, proof of address, bank) must be uploaded before approval' };
    }
    // Stamp the approval FIRST - a human approved, and that fact holds even if provisioning fails or
    // is deferred (test mode). It satisfies the gate for any later retry by the batch.
    var approvedAt = nowIso_();
    var approvedBy = (ctx && ctx.email) || 'admin';
    setOnboardingCell_(folderId, ONB_COL.approved_at, approvedAt);
    setOnboardingCell_(folderId, ONB_COL.approved_by, approvedBy);
    logAudit_('onboard_approved', { folderId: folderId, by: approvedBy });

    var systems = safeJsonParse_(o.systems_json, null);
    if (!Array.isArray(systems) || !systems.length) {
      systems = resolveSystems_(o.entity || 'quay1', o.programs, null, o.team, o.activity || o.designation);
    }

    var prov = provisionAll_(folderId, systems, ctx);

    // CMA + Dialfire are not auto-created (CMA costs money; Dialfire has no create API), so an
    // entitled candidate triggers a manual account-request email - CMA to Sheldon + Marthinus,
    // Dialfire to Alan. After provisionAll_ so no one is asked to set up an account before the rest
    // of setup has started. Both idempotent + test-safe inside (see helpers).
    // These are FUNCTIONAL account-request emails (CMA -> Sheldon + Marthinus, Dialfire -> Alan), not
    // CC copies, so they fire on approval REGARDLESS of the CC toggle. ccsOff only silences candidate
    // CC/BCC + the internal HubSpot-login alert; it must not stop a CMA/Dialfire account from being
    // requested. Entitlement, idempotency (stamped so never re-sent) + DRY_RUN handling are inside.
    _maybeRequestCma_(folderId, o, systems);
    _maybeRequestDialfire_(folderId, o, systems);

    // Only mark the candidate PROVISIONED (dropping them off the pipeline) when real accounts were
    // actually created. On an error, leave provisioned_at empty so it stays visible and retryable.
    // In test mode (DRY_RUN), leave it too so the real batch provisions once armed.
    if (prov.anyError) {
      setOnboardingStatus_(folderId, 'Setup error');
      return { ok: false, error: 'approved, but account setup hit an error - the candidate stays on the Progress report so it can be retried.', approved_at: approvedAt, provisioning: prov.results };
    }
    if (prov.dryRun) {
      setOnboardingStatus_(folderId, 'Approved (test mode)');
      return { ok: true, dryRun: true, approved_at: approvedAt, approved_by: approvedBy, message: 'Approved. The system is in test mode, so no live accounts were created yet.', provisioning: prov.results };
    }
    setOnboardingCell_(folderId, ONB_COL.provisioned_at, nowIso_());
    setOnboardingStatus_(folderId, 'Provisioned');
    // Real accounts exist now, so invite the candidate to pick an induction week (CC the senior).
    _sendInductionInvite_(folderId, o);
    return { ok: true, approved_at: approvedAt, approved_by: approvedBy, provisioning: prov.results };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Candidate "pick your induction week" invite. Sent ONCE, the moment a row first reaches the
 * provisioned state - from BOTH transition points (the interactive approveAndProvision_ and the
 * scheduled provisionReadyBatch_), each guarded by the provisioned_at check so there is no double
 * send. Fully guarded: a missing email or a mail failure logs and returns without breaking
 * provisioning. CC of the senior broker is suppressed while CC is off; the candidate send is
 * unconditional so the candidate always gets it.
 */
function _sendInductionInvite_(folderId, o) {
  try {
    if (!isEmail_(o && o.email)) { logAudit_('induction_invite_skipped_no_email', { folderId: folderId }); return; }
    var company = CFG.COMPANY[o.entity || 'quay1'] || CFG.COMPANY.quay1;
    var link = inductionLink_(folderId);
    if (!link) logAudit_('induction_invite_no_link', { folderId: folderId });   // WEBAPP_URL unset -> dead link
    GmailApp.sendEmail(o.email, 'Pick your ' + company.name + ' induction week' + (o.name ? ' - ' + o.name : ''),
      'Hi ' + firstName_(o.name) + ',\n\nWelcome aboard. Please pick your ' + company.name +
      ' induction week here: ' + link + '\n\nWarm regards,\nThe ' + company.name + ' Team',
      { name: company.name, htmlBody: inductionInviteHtml_(company, firstName_(o.name), link),
        cc: (ccEnabled_() && isEmail_(o.senior_email)) ? o.senior_email : undefined });
  } catch (e) { logAudit_('induction_invite_failed', { folderId: folderId, error: String(e) }); }
}

/**
 * DECLINE FICA (kind:'decline_fica'). An admin reviews the uploaded FICA documents on the site and
 * rejects them (wrong doc, illegible, expired). Sets the status to 'FICA declined' and emails the
 * candidate the admin's reason plus their FICA link so they can re-submit. The FICA ticks are left
 * intact on purpose - a fresh upload re-ticks the relevant box. requireAdmin_ is asserted at the call
 * site. The email send is guarded so a mail failure still returns ok. Returns { ok, declined }.
 */
function declineFica_(folderId, reason, ctx) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  setOnboardingStatus_(folderId, 'FICA declined');
  var company = CFG.COMPANY[o.entity || 'quay1'] || CFG.COMPANY.quay1;
  var ficaUrl = ficaLink_(folderId);
  var why = String(reason || '').trim();
  try {
    GmailApp.sendEmail(o.email, 'Action needed on your ' + company.name + ' FICA documents',
      'Hi ' + firstName_(o.name) + ',\n\n' +
      'We were unable to accept your FICA documents' + (why ? ' for the following reason:\n\n' + why : '.') +
      '\n\nPlease re-submit using your personal, secure link: ' + ficaUrl +
      '\n\nWarm regards,\nThe ' + company.name + ' Team',
      { name: company.name, htmlBody: ficaDeclineHtml_(company, firstName_(o.name), why, ficaUrl),
        cc: (ccEnabled_() && isEmail_(o.senior_email)) ? o.senior_email : undefined });
  } catch (e) { logAudit_('fica_decline_email_failed', { folderId: folderId, error: String(e) }); }
  logAudit_('fica_declined', { folderId: folderId, reason: why, by: (ctx && ctx.email) || '' });
  return { ok: true, declined: true };
}

/**
 * Shared "manual account request" email for a system that is NOT auto-created (CMA carries a per-seat
 * cost; Dialfire has no usable create API). On admin acceptance of an entitled starter we email
 * whoever creates the account with just the starter's name + team. A deliberate, scoped exception to
 * the draft-only rule (user asked for these to actually send). Idempotent: stamps spec.col and never
 * re-sends. Test-safe: in DRY_RUN it DRAFTS without stamping, so the real send still fires once armed.
 * Never throws (an email failure must not block approval).
 *   spec = { system, label, subjectTitle, recipients, requestedField, col, html(company,name,team),
 *            noteTitle?, noteBody? }
 */
function _requestManualAccount_(folderId, o, systems, spec) {
  try {
    if (o && o[spec.requestedField]) return false;                          // already requested
    if (!Array.isArray(systems) || systems.indexOf(spec.system) < 0) return false;  // not entitled
    var recipients = (spec.recipients || []).filter(Boolean);
    if (!recipients.length) return false;

    var company = (CFG.COMPANY && (CFG.COMPANY[o.entity || 'quay1'] || CFG.COMPANY.quay1)) || { name: 'Quay 1', full: 'Quay 1 International Realty' };
    var name = o.name || 'New starter';
    var team = o.team || '';

    var subject = spec.subjectTitle + ' - ' + name;
    var plain = 'Please create a ' + spec.label + ' account for a new ' + company.name + ' starter.\n\n' +
      'Name: ' + name + '\nTeam: ' + team + '\n' +
      (spec.noteBody ? '\n' + spec.noteBody + '\n' : '') +
      '\nThanks,\nThe ' + company.name + ' Team';
    var opts = { name: company.name, htmlBody: spec.html(company, name, team) };

    if (DRY_RUN_()) {
      // Test mode: DRAFT only, and DELIBERATELY do NOT stamp spec.col - stamping would permanently
      // suppress the real send once armed (mirrors provisioned_at staying unstamped in test mode).
      GmailApp.createDraft(recipients.join(','), subject, plain, opts);
      logAudit_(spec.system + '_request_drafted', { folderId: folderId, to: recipients.join(','), name: name });
      return false;
    }
    // Live (user asked for these to auto-send): send once and stamp so it never re-sends.
    GmailApp.sendEmail(recipients.join(','), subject, plain, opts);
    setOnboardingCell_(folderId, spec.col, nowIso_());
    logAudit_(spec.system + '_request_sent', { folderId: folderId, to: recipients.join(','), name: name });
    return true;
  } catch (err) {
    logAudit_(spec.system + '_request_failed', { folderId: folderId, error: String(err) });
    return false;
  }
}

/** CMA access request -> CMA_APPROVERS (Sheldon + Marthinus). Entitled = 'cma' in resolved systems
 *  (full brokers only; the entitlements matrix bars JB assistants). Subject "CMA Account Request - <name>". */
function _maybeRequestCma_(folderId, o, systems) {
  return _requestManualAccount_(folderId, o, systems, {
    system: 'cma', label: 'CMA (cmainfo.co.za)', subjectTitle: 'CMA Account Request',
    recipients: CFG.CMA_APPROVERS, requestedField: 'cma_requested_at', col: ONB_COL.cma_requested_at,
    noteBody: 'CMA carries a cost, so please approve or decline before it is set up.',
    html: function (c, n, t) { return cmaRequestHtml_(c, n, t); },
  });
}

/** Dialfire account request -> DIALFIRE_APPROVERS (Alan). Entitled = 'dialfire' in resolved systems
 *  (the onboarder ticked the Dialfire program). Subject "Dialfire Account Request - <name>". */
function _maybeRequestDialfire_(folderId, o, systems) {
  return _requestManualAccount_(folderId, o, systems, {
    system: 'dialfire', label: 'Dialfire', subjectTitle: 'Dialfire Account Request',
    recipients: CFG.DIALFIRE_APPROVERS, requestedField: 'dialfire_requested_at', col: ONB_COL.dialfire_requested_at,
    html: function (c, n, t) { return dialfireRequestHtml_(c, n, t); },
  });
}

/** Shallow copy of a provisioner result with the temp password stripped, so it never lands in the
 *  broadly-readable Provisioning Queue. Leaves the plaintext credential to the restricted Credentials tab. */
function _redactResult_(result) {
  if (!result || typeof result !== 'object') return result;
  var out = {}, k;
  for (k in result) { if (result.hasOwnProperty(k) && k !== 'tempPw' && k !== 'temp_password') out[k] = result[k]; }
  if ('tempPw' in result || 'temp_password' in result) out.temp_pw_issued = true;
  return out;
}

/** Run an inline (API) provisioner, write its done/error PQ row, and return {status, result}. */
function _runInline_(person, system, fn) {
  var status = 'done', result;
  try {
    result = fn() || {};
  } catch (err) {
    status = 'error';
    result = { error: String(err) };
  }
  enqueueProvision_({
    folderId: person.folderId, full_name: person.full_name, first_name: person.first_name,
    id_number: person.id_number, quay_email: person.quay_email || (result && result.email) || '',
    cell: person.cell, system: system, action: 'create',
    // The stored result must not carry the plaintext temp password (the Queue is broadly readable);
    // the credential lives only in the restricted Credentials tab. Strip it before persisting.
    payload: _inlinePayload_(person, system, result), status: status, result: _redactResult_(result),
  });
  return { status: status, result: result };
}

/** payload_json written on an inline row (CONTRACTS section 1, payload_json shapes). The temp password
 *  is NOT stored here - the Provisioning Queue is broadly readable, so the credential lives ONLY in the
 *  restricted Credentials tab (recordCredential_). We keep a boolean marker for traceability. */
function _inlinePayload_(person, system, result) {
  if (system === 'google') {
    return { groups: _groupsForTeam_(person.team), designation: person.designation, temp_pw_issued: !!(result && result.tempPw) };
  }
  if (system === 'propdata') {
    return { vendor_branch: person.team || '', role: _propdataRole_(person) };
  }
  return {};
}

// ---------------------------------------------------------------- Google Workspace

/**
 * Groups a newly onboarded broker is added to. TWO are always present (the onboarding rule):
 *   - the company-wide group CFG.COMPANY_GROUP (champions@) - every broker, no exceptions;
 *   - the broker's own team group, derived from the team name (wombats -> wombats@quay1.co.za).
 * Any groups an admin configured in the Team Directory tab (teamMapping_) are UNIONED on top, so a
 * team needing extra groups still gets them. Case-insensitive de-dup. See Teams.js (Blocker B.3).
 */
function _groupsForTeam_(team) {
  var groups = teamMapping_(team).groups.slice(); // admin-configured extras (may be [])
  _pushGroup_(groups, CFG.COMPANY_GROUP);
  _pushGroup_(groups, _teamGroup_(team));
  return groups;
}

/** Derive a team's Google group email from its name: 'Wombats' -> 'wombats@quay1.co.za'.
 *  Non-alphanumerics are stripped. '' when the team name has no usable characters. */
function _teamGroup_(team) {
  var slug = String(team == null ? '' : team).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug ? slug + '@' + CFG.DOMAIN : '';
}

/** Push a group email onto the list unless a case-insensitive match is already present. */
function _pushGroup_(arr, email) {
  if (!email) return;
  var k = String(email).toLowerCase();
  if (arr.some(function (g) { return String(g).toLowerCase() === k; })) return;
  arr.push(email);
}

/** A random, per-user temporary password that meets Google's complexity rules (mixed case + digit +
 *  symbol, 14 chars). Not derived from any personal detail, so it cannot be guessed from a name.
 *  changePasswordAtNextLogin forces the broker to set their own on first sign-in. */
function _randomTempPw_() {
  var upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnpqrstuvwxyz';
  var digit = '23456789', sym = '!@#$%*?';
  var all = upper + lower + digit + sym;
  var pick = function (set) { return set.charAt(Math.floor(Math.random() * set.length)); };
  var out = pick(upper) + pick(lower) + pick(digit) + pick(sym);  // guarantee one of each class
  for (var i = 0; i < 10; i++) out += pick(all);
  return out.split('').sort(function () { return Math.random() - 0.5; }).join('');
}

/**
 * Create the Google Workspace user. DRY_RUN (default): log + return the payload it WOULD send.
 * Live: Users.insert first@quay1.co.za (fallback first.surname@ on 409), then Members.insert
 * per group. Random per-user temp password (see _randomTempPw_), changePasswordAtNextLogin.
 */
function googleCreate_(person) {
  var first = String(person.first_name || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  var last = String(person.last_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  var primary = first + '@' + CFG.DOMAIN;
  var fallback = (first + (last ? '.' + last : '')) + '@' + CFG.DOMAIN;
  var tempPw = _randomTempPw_();  // random per user; handed over via the private Credentials tab, never guessable
  var groups = _groupsForTeam_(person.team);

  if (DRY_RUN_()) {
    logAudit_('google_create_dryrun', { primary: primary, fallback: fallback, groups: groups });
    return { dryRun: true, email: primary, tempPw: tempPw, would: { primary: primary, groups: groups } };
  }

  var email = primary;
  var body = {
    primaryEmail: primary,
    name: { givenName: person.first_name || 'User', familyName: person.last_name || (person.first_name || 'User') },
    password: tempPw,
    changePasswordAtNextLogin: true,
  };
  try {
    AdminDirectory.Users.insert(body);
  } catch (err) {
    if (/409|dupli|exist/i.test(String(err))) {
      email = fallback;
      body.primaryEmail = fallback;
      AdminDirectory.Users.insert(body);
    } else {
      throw err;
    }
  }
  groups.forEach(function (grp) {
    try { AdminDirectory.Members.insert({ email: email, role: 'MEMBER' }, grp); }
    catch (e) { logAudit_('google_group_add_failed', { email: email, group: grp, error: String(e) }); }
  });
  recordCredential_({ full_name: person.full_name, quay_email: email, temp_password: tempPw,
    team: person.team, folderId: person.folderId });
  return { email: email, tempPw: tempPw, groups: groups };
}

// ---------------------------------------------------------------- Credentials ledger
// A superuser-readable record of every Google account created (email + temp password), so ops can
// hand a broker their login without digging through the Provisioning Queue's payload_json. It lives
// in the PRIVATE tracker Sheet, so who-can-open-the-sheet IS the access control. Only written on the
// LIVE create path (a dry-run makes no real account, so there is nothing to hand out).

var CRED_HEADERS = ['created_at', 'full_name', 'quay_email', 'temp_password', 'team', 'folderId'];

/** Create/repair the Credentials tab with its header row (idempotent). Returns the Sheet. */
function ensureCredentialsTab_(ss) {
  var t = ss.getSheetByName(CFG.TAB.CREDENTIALS) || ss.insertSheet(CFG.TAB.CREDENTIALS);
  t.getRange(1, 1, 1, CRED_HEADERS.length).setValues([CRED_HEADERS]).setFontWeight('bold');
  t.setFrozenRows(1);
  return t;
}

/** Upsert (by quay_email) one credential row so re-provisioning refreshes rather than duplicates.
 *  Best-effort: a ledger write must never fail the account creation, so errors are logged only. */
function recordCredential_(entry) {
  try {
    var email = String((entry && entry.quay_email) || '').trim();
    if (!email) return;
    var t = ensureCredentialsTab_(sheet_());
    var row = [nowIso_(), entry.full_name || '', email, entry.temp_password || '', entry.team || '', entry.folderId || ''];
    var text = function (r) { return r.map(function (v) { return String(v == null ? '' : v); }); };
    var last = t.getLastRow();
    if (last > 1) {
      var emails = t.getRange(2, 3, last - 1, 1).getValues(); // col C = quay_email
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).trim().toLowerCase() === email.toLowerCase()) {
          t.getRange(i + 2, 1, 1, CRED_HEADERS.length).setNumberFormat('@').setValues([text(row)]);
          return;
        }
      }
    }
    t.getRange(last + 1, 1, 1, CRED_HEADERS.length).setNumberFormat('@').setValues([text(row)]);
  } catch (e) {
    logAudit_('credential_record_failed', { email: entry && entry.quay_email, error: String(e) });
  }
}

/** Look up a credential row by quay_email; null when absent. (Used by the live smoke test.) */
function _findCredential_(email) {
  var t = sheet_().getSheetByName(CFG.TAB.CREDENTIALS);
  if (!t || t.getLastRow() < 2) return null;
  var key = String(email || '').trim().toLowerCase();
  var vals = t.getRange(2, 1, t.getLastRow() - 1, CRED_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][2]).trim().toLowerCase() === key) {
      return { created_at: vals[i][0], full_name: vals[i][1], quay_email: vals[i][2],
        temp_password: vals[i][3], team: vals[i][4], folderId: vals[i][5] };
    }
  }
  return null;
}

/** Delete every credential row for an email (cleanup after the throwaway smoke-test account). */
function _removeCredential_(email) {
  var t = sheet_().getSheetByName(CFG.TAB.CREDENTIALS);
  if (!t || t.getLastRow() < 2) return;
  var key = String(email || '').trim().toLowerCase();
  var col = t.getRange(2, 3, t.getLastRow() - 1, 1).getValues(); // col C = quay_email
  for (var i = col.length - 1; i >= 0; i--) { // bottom-up so row indices stay valid
    if (String(col[i][0]).trim().toLowerCase() === key) t.deleteRow(i + 2);
  }
}

/**
 * Suspend a Google account. Deliberately suspend-ONLY (user choice): a suspended account cannot log
 * in anywhere, so group membership and Drive are left untouched. Gated by BOTH DRY_RUN and
 * OFFBOARD_ARMED: only a live, armed call actually suspends. Idempotent (suspend on an
 * already-suspended user succeeds). Returns a result object for the Offboarding Queue google_result.
 */
function googleSuspend_(email) {
  if (!email) return { ok: false, error: 'no email' };
  if (DRY_RUN_() || !offboardArmed_()) {
    logAudit_('google_suspend_dryrun', { email: email, armed: offboardArmed_() });
    return { ok: true, suspended: false, dryRun: true, armed: offboardArmed_(), would: 'suspend ' + email };
  }
  AdminDirectory.Users.update({ suspended: true }, email); // idempotent
  logAudit_('google_suspended', { email: email });
  return { ok: true, email: email, suspended: true };
}

// ---------------------------------------------------------------- PropData REST (feeds-api)

/** Derive the PropData profile type from the self-declared FFC status. A full FFC holder gets a full
 *  agent profile; a candidate practitioner or no-status hire gets a numbered specialist profile.
 *  Shared by the FICA intake (which persists it) and provisioning (which sends it as the role). */
function propdataProfileType_(ffcStatus) {
  return String(ffcStatus || '').toLowerCase() === 'full' ? 'agent' : 'specialist';
}

function _propdataReady_() {
  return propdataLive_() && !!optProp_(PROP.PROPDATA_API_KEY) && !!optProp_(PROP.PROPDATA_VENDOR_ID);
}

// DEPRECATED: PropData now provisions via the browser worker (worker/provisioners/propdata.py),
// not this feeds-api REST path. These helpers are retained only for reference / manual use and are
// no longer called by provisionAll_. Do not re-wire them into the provisioning flow.
function propdataCreate_(person) { return _propdata_(person, 'create'); }
function propdataDeactivate_(person) { return _propdata_(person, 'deactivate'); }

/** DEPRECATED (see note above). POST an agent create/deactivate to feeds-api.propdata.net. Dry-run
 *  unless PROPDATA_LIVE and both creds present. Endpoint path was never confirmed (old Blocker B2). */
function _propdata_(person, action) {
  var payload = {
    action: action, first_name: person.first_name, last_name: person.last_name,
    email: person.quay_email || person.email, id_number: person.id_number,
    vendor_id: optProp_(PROP.PROPDATA_VENDOR_ID), role: _propdataRole_(person),
  };
  if (!_propdataReady_()) {
    logAudit_('propdata_dryrun', { action: action, payload: payload });
    return { ok: true, dryRun: true, would: payload };
  }
  // TODO(B2): confirm the real agent endpoint path with api-support@propdata.net.
  var url = 'https://feeds-api.propdata.net/v1/agents';
  var res = UrlFetchApp.fetch(url, {
    method: action === 'deactivate' ? 'delete' : 'post',
    contentType: 'application/json', muteHttpExceptions: true,
    headers: { api_key: optProp_(PROP.PROPDATA_API_KEY), 'vendor-id': optProp_(PROP.PROPDATA_VENDOR_ID) },
    payload: JSON.stringify(payload),
  });
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true, code: code, body: safeJsonParse_(res.getContentText(), res.getContentText()) };
  throw new Error('propdata ' + action + ' failed: HTTP ' + code + ' ' + res.getContentText());
}

// ---------------------------------------------------------------- browser systems (enqueue)

/** Write pending Provisioning Queue rows for the browser-only systems. Returns the queue_ids. */
function enqueueBrowserSystems_(person, systems, action) {
  var ids = [];
  (systems || []).forEach(function (s) {
    if (CFG.WORKER_SYSTEMS.indexOf(s) < 0) return;
    // Dialfire is now a manual email request to Alan (no create API), so it is NOT enqueued for the
    // worker - it would only hit an unimplemented DOM path. See _maybeRequestDialfire_.
    if (s === 'dialfire') return;
    var payload = _browserPayload_(s, person);
    // Grant the worker's service account read access to the FICA headshot it will download to build
    // the branded profile photo. Non-fatal: a share failure just means the worker uses the logo.
    if (s === 'propdata' && payload.photo_file_id) _sharePhotoWithWorker_(payload.photo_file_id);
    var id = enqueueProvision_({
      folderId: person.folderId, full_name: person.full_name, first_name: person.first_name,
      id_number: person.id_number, quay_email: person.quay_email, cell: person.cell,
      system: s, action: action || 'create', payload: payload, status: 'pending',
    });
    ids.push(id);
  });
  return ids;
}

/** Share a FICA headshot (by Drive file id) with the provisioning worker's service account so the
 *  worker can download it. No-op when WORKER_SA_EMAIL is unset. Never throws (best-effort). */
function _sharePhotoWithWorker_(fileId) {
  var sa = optProp_(PROP.WORKER_SA_EMAIL);
  if (!sa || !fileId) return;
  try { DriveApp.getFileById(fileId).addViewer(sa); }
  catch (err) { logAudit_('worker_photo_share_failed', { fileId: fileId, sa: sa, error: String(err) }); }
}

/** payload_json for a browser row (CONTRACTS section 1, payload_json shapes). */
function _browserPayload_(system, person) {
  if (system === 'propdata') return {
    last_name: person.last_name || '',
    email: person.email || person.quay_email || '',
    designation: _propdataDesignation_(person),   // '-' (candidate) or the full-status title
    ffc_status: person.ffc_status || '',
    role: _propdataRole_(person),                 // agent|specialist (reference / fallback)
    branch: person.team || '',                    // informational; PDMS branch is fixed to Quay 1
    // Full-status agents get a branded profile photo built by the worker from this FICA headshot;
    // candidates have no photo id and fall back to the Quay 1 logo. See worker/photo_pipeline.py.
    photo_file_id: (_propdataDesignation_(person) !== '-' && person.photo_file_id) || '',
  };
  if (system === 'dialfire') return { campaign: person.team || '' };
  return {}; // cma: OTP-gated, no payload
}

/** PDMS "Designation" for a person, from the induction FFC status. A full-FFC holder is a
 *  'Non-Principal Property Practitioner'; anyone else (blank/candidate) keeps the PDMS
 *  default '-'. Mirrors _designation_for() in worker/provisioners/propdata.py. */
function _propdataDesignation_(person) {
  var full = String(person.ffc_status || '').toLowerCase() === 'full' ||
             String(person.propdata_profile_type || '').toLowerCase() === 'agent';
  return full ? 'Non-Principal Property Practitioner' : '-';
}
