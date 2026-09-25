/**
 * Router.js - the only HTTP surface. doGet/doPost live here and nowhere else. Parses the
 * text/plain body (no-preflight pattern), builds the auth context, and dispatches by {kind}.
 *
 * Owner: backend. See docs/SPEC.md section 2 and docs/ARCHITECTURE.md section 3.
 *
 * POST body (Content-Type text/plain to dodge CORS preflight). The JWT field is `accessToken`:
 *   { kind: "...", accessToken: "<supabase jwt>", ...fields }
 *
 * Dispatch table. Candidate kinds are token-less (folderId-gated) and handled BEFORE auth;
 * admin kinds resolve the auth context first (each handler asserts its own role):
 *   fica_upload / candidate_upload -> Fica.ficaUpload_(body)          [token-less]
 *   book_induction                 -> Induction.bookInduction_(body)  [token-less]
 *   onboard_quay1                  -> Onboarding_Quay1.onboardQuay1_(body, ctx)   [onboarder: super/admin/broker]
 *   onboard_aqua                   -> Onboarding_Aqua.onboardAqua_(body, ctx)     [onboarder: super/admin/broker]
 *   approve                        -> approveAndProvision_(folderId, ctx)         [admin]
 *   decline_fica                   -> declineFica_(folderId, {declines,contract_incorrect}, ctx) [admin]
 *   remind                         -> _remindContract_(folderId, ctx)             [onboarder]
 *   resend_packet                  -> resendInductionPacket_(folderId, ctx)       [onboarder]
 *   provision                      -> Provisioning.provisionAll_(folderId, systems, ctx) [admin]
 *   offboard                       -> Offboarding.offboardRequest_(body, ctx)     [admin]
 *   offboard_notify                -> requestOffboardNotify_(body, ctx)           [onboarder]
 *   status                         -> Queue.readForUi_(ctx)           [authed, role-scoped]
 *   programs                       -> Programs.programsData_(ctx)     [authed, role-scoped]
 *   list_completed                 -> listCompletedOnboarding_()      [admin]
 *   remove_onboarding              -> removeOnboarding_(folderId, ctx)[admin]
 *   retry                          -> Queue.retryRow_(queue_id, ctx)  [super]
 *
 * doGet routes: FICA form (?f=<folderId> -> HTML), induction booking page (?i=<folderId> -> HTML),
 * and a health ping (default). Both candidate links are generated server-side, so the query
 * contract (?f= vs ?i=) is owned here. The induction page POSTs book_induction itself.
 *
 * Every handler returns a plain object; Router wraps it with jsonOut_. Errors are caught and
 * returned as { ok:false, error } with a 200 body (the frontend reads the ok flag).
 */

var TOKENLESS_KINDS = { fica_upload: true, candidate_upload: true, book_induction: true };

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    // A Drive folder id is only [A-Za-z0-9_-]; strip anything else so a crafted ?f=/?i= value can
    // never carry markup into the page (defence-in-depth alongside jsInScript_ at the injection site).
    if (p.f) return ficaForm_(_safeFolderId_(p.f));          // candidate FICA upload page (HTML)
    if (p.i) return inductionPageHtml_(_safeFolderId_(p.i)); // candidate induction booking page (HTML)
    if (p.diag) return jsonOut_(_diag_());                    // ops diagnostic (non-secret flags + HR tab rows)
    return textOut_('ok'); // health ping
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/**
 * Unauthenticated read-only ops diagnostic (?diag=1). Returns ONLY non-secret operational metadata so an
 * operator can confirm at a glance which safety flags are armed and that HR mirroring is live: the feature
 * flags (all booleans), the HR destination tab names, and each HR tab's current last row (the next append
 * lands at lastRow+1). Deliberately carries NO secrets, NO sheet ids, and NO candidate/PII - nothing here
 * is sensitive beyond "is this feature turned on", so it needs no auth. HR-sheet reads are wrapped so a
 * missing tab or access issue degrades to a note instead of throwing.
 */
function _diag_() {
  var out = {
    ok: true,
    flags: {
      dryRun: DRY_RUN_(),
      hrSyncEnabled: hrSyncEnabled_(),
      propdataLive: propdataLive_(),
      offboardArmed: offboardArmed_(),
      hubspotSeatEnabled: hubspotSeatEnabled_(),
      ccEnabled: ccEnabled_(),
    },
    hrTabs: HR_TAB,
  };
  try {
    var ss = SpreadsheetApp.openById(hrSheetId_());
    out.hrTabLastRow = {};
    Object.keys(HR_TAB).forEach(function (k) {
      var sh = ss.getSheetByName(HR_TAB[k]);
      out.hrTabLastRow[HR_TAB[k]] = sh ? sh.getLastRow() : null;   // null = tab not found under that name
    });
    // Deep header audit for the two ENTITY destination tabs: using the SAME matching hrPromote_ uses,
    // report whether the ID key + name columns resolve (idKeyCol/nameCol = 0 means hrPromote_ would REFUSE
    // to promote into that tab) and which tool field-keys land vs go unwritten. This is the definitive
    // "will an accepted candidate actually populate this tab" check. Column labels only - no PII, no values.
    out.hrHeaderAudit = {};
    var fieldKeys = Object.keys(_hrFieldMap_({}));   // the static set of headers the tool can write
    ['quay1', 'aqua'].forEach(function (ent) {
      var tabName = HR_TAB[ent];
      try {
        var sh = ss.getSheetByName(tabName);
        if (!sh) { out.hrHeaderAudit[ent] = { tab: tabName, found: false }; return; }
        var headers = _hrReadHeaders_(sh);
        var mapped = [], unmapped = [];
        fieldKeys.forEach(function (fk) { (_hrHeaderIndex_(headers, fk) >= 0 ? mapped : unmapped).push(fk); });
        out.hrHeaderAudit[ent] = {
          tab: tabName,
          found: true,
          idKeyCol: _hrHeaderIndex_(headers, 'Identification Number') + 1,   // 0 => missing => promote refuses
          nameCol: _hrHeaderIndex_(headers, 'Name & Surname') + 1,           // 0 => missing
          nextAppendRow: sh.getLastRow() + 1,
          mappedKeys: mapped,       // tool values that WILL land (a header matched)
          unmappedKeys: unmapped,   // tool values with NO column on this tab (silently not written)
          headers: headers,
        };
      } catch (e2) { out.hrHeaderAudit[ent] = { tab: tabName, error: String(e2) }; }
    });
  } catch (e) {
    out.hrTabLastRowError = String(e);
  }
  return out;
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var kind = String(body.kind || '');

    // Token-less candidate paths run BEFORE any auth (gated by the unguessable folderId).
    if (TOKENLESS_KINDS[kind]) {
      return jsonOut_(dispatchTokenless_(kind, body));
    }

    var ctx = authContext_(body); // throws 'unauthorized' when the JWT is missing/invalid
    return jsonOut_(dispatch_(kind, body, ctx));
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** Parse the text/plain JSON body. Throws on a malformed / empty body. */
function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('empty request body');
  var body = safeJsonParse_(e.postData.contents, null);
  if (!body || typeof body !== 'object') throw new Error('malformed request body');
  return body;
}

/** Token-less candidate handlers (no auth context). */
function dispatchTokenless_(kind, body) {
  if (kind === 'fica_upload' || kind === 'candidate_upload') return ficaUpload_(body);
  if (kind === 'book_induction') return bookInduction_(body);
  return { ok: false, error: 'unknown candidate action: ' + kind };
}

/** Authenticated dispatch. Each handler asserts its own role via requireAdmin_/requireSuper_. */
function dispatch_(kind, body, ctx) {
  switch (kind) {
    case 'onboard_quay1': return onboardQuay1_(body, ctx);
    case 'onboard_aqua': return onboardAqua_(body, ctx);
    case 'approve': return _approveDispatch_(body, ctx);
    case 'decline_fica': return _declineDispatch_(body, ctx);
    case 'remind': return _remindDispatch_(body, ctx);
    case 'resend_packet': return _resendPacketDispatch_(body, ctx);
    case 'set_induction_week': return _setInductionWeekDispatch_(body, ctx);
    case 'candidate_detail': return _candidateDetailDispatch_(body, ctx);
    case 'provision': return _provisionDispatch_(body, ctx);
    case 'offboard': return offboardRequest_(body, ctx);
    case 'offboard_notify': return _offboardNotifyDispatch_(body, ctx);
    case 'status': return readForUi_(ctx);
    case 'programs': return programsData_(ctx);
    case 'list_completed': return _listCompletedDispatch_(body, ctx);
    case 'remove_onboarding': return _removeOnboardingDispatch_(body, ctx);
    case 'retry': return retryRow_(String(body.queue_id || ''), ctx);
    default: return { ok: false, error: 'unknown action: ' + kind };
  }
}

/** Approve & set up (kind:'approve'). The ONLY path that turns a reviewed candidate into real accounts,
 *  on a deliberate admin click. Asserts admin here; the ready/idempotency checks live in the handler. */
function _approveDispatch_(body, ctx) {
  requireAdminCheck_(ctx);   // super/admin OR the allowlisted Admin Check individual (Kat)
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  // contract_verified is the admin's explicit "I opened the signed contract and it is correctly signed"
  // confirmation from the Admin Check tick. approveAndProvision_ enforces it as a hard gate + audits it.
  return approveAndProvision_(folderId, ctx, { contractVerified: body.contract_verified === true });
}

/** List completed onboardings (kind:'list_completed'). Admin-only. Powers the "Completed onboardings"
 *  cleanup panel: terminal-status rows an admin may clear from the tracker. Read-only. */
function _listCompletedDispatch_(body, ctx) {
  requireAdmin_(ctx);
  return { ok: true, rows: listCompletedOnboarding_() };
}

/** Remove a completed onboarding row (kind:'remove_onboarding'). Admin-only, guarded to terminal
 *  status inside removeOnboarding_. Only clears the tracker row; accounts and HR records are untouched. */
function _removeOnboardingDispatch_(body, ctx) {
  requireAdmin_(ctx);
  return removeOnboarding_(String(body.folderId || ''), ctx);
}

/** Decline a candidate's FICA (kind:'decline_fica'). Admin-only, deliberate reject: records a reason
 *  PER declined document (id/poa/bank) and/or flags the contract as incorrect, then notifies the
 *  candidate to re-submit only what was declined. Never provisions.
 *    body = { folderId, declines:{ id?, poa?, bank? -> reason }, contract_incorrect: reason|'',
 *             reason?: legacy single string (back-compat) }  */
function _declineDispatch_(body, ctx) {
  requireAdminCheck_(ctx);   // super/admin OR the allowlisted Admin Check individual (Kat)
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  return declineFica_(folderId, {
    declines: (body.declines && typeof body.declines === 'object') ? body.declines : null,
    contract_incorrect: String(body.contract_incorrect || ''),
    reason: String(body.reason || ''),   // legacy back-compat: single whole-candidate reason
  }, ctx);
}

/** Send a candidate a reminder to sign + submit FICA (re-sends the contract email). Any onboarder
 *  (super/admin/senior broker) may nudge; the handler re-sends only to the candidate on file. */
function _remindDispatch_(body, ctx) {
  requireOnboarder_(ctx);
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  return _remindContract_(folderId, ctx);
}

/** Broker "Request offboarding" (kind:'offboard_notify'). Phase-1 notify-only: any onboarder
 *  (super/admin/senior broker) may raise it; it emails the offboarding team, tears nothing down. */
function _offboardNotifyDispatch_(body, ctx) {
  requireOnboarder_(ctx);
  return requestOffboardNotify_(body, ctx);
}

/** Resend the induction packet (kind:'resend_packet') for a candidate who has already booked a week.
 *  Any onboarder (super/admin/senior broker) may resend; the handler reads the booked dates + candidate
 *  email off the row and refuses if no week is booked yet. */
function _resendPacketDispatch_(body, ctx) {
  requireOnboarder_(ctx);
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  return resendInductionPacket_(folderId, ctx);
}

/** Admin override of a candidate's induction week (Progress report "Change week"). Admin-only: it moves
 *  calendar invites and re-emails the candidate, so it rides the same requireAdmin_ gate as approve. */
function _setInductionWeekDispatch_(body, ctx) {
  requireAdmin_(ctx);
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  return setInductionWeekManual_(folderId, String(body.date || ''), ctx);
}

/** Structured per-candidate detail for the Progress report click-through page. Onboarder+ (a broker
 *  sees only their own candidates; candidateDetail_ enforces the per-row ownership scope). Read-only. */
function _candidateDetailDispatch_(body, ctx) {
  requireOnboarder_(ctx);
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  return candidateDetail_(folderId, ctx);
}

/** Manual (re)provision: an explicit systems list wins; else resolve from the Onboarding row. Guarded
 *  by the SAME approval gate as everything else - a row must be Approved before any (re)provision. */
function _provisionDispatch_(body, ctx) {
  requireAdmin_(ctx);  // standalone re-provision is admin-only
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  // Guard the gate, but allow a retry for anyone already approved OR already provisioned (legacy rows
  // predate the approved_at column - a provisioned row was implicitly approved when it went live).
  if (!o.approved_at && !o.provisioned_at) {
    return { ok: false, error: 'not approved: an admin must Approve & set up this candidate before (re)provisioning' };
  }
  var systems = _provisionList_(body, body);
  if (!systems) {
    // o.designation holds the broker-activity label ("... (JB)"/"(SB)"), which brokerRole_ reads for
    // the entitlements matrix on a standalone re-provision (the code isn't a separate row column).
    systems = resolveSystems_(o.entity || 'quay1', o.programs, null, o.team, o.activity || o.designation);
  }
  return provisionAll_(folderId, systems, ctx);
}
