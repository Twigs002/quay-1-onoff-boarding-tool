/**
 * Setup.js - one-time provisioning helpers. Every function here has NO trailing underscore so it
 * appears in the Apps Script Run picker. They create the tracker tabs, seed the SAFE flag
 * defaults, install the digest trigger, and store secrets in Script Properties (never in source).
 *
 * Addition to the stub set (flagged to tester + architect). BUILD ONLY: none of these deploy or
 * touch a live external account. Run order after the first `clasp push`:
 *   1. setSupabase(url, anon, service)     2. setWebappUrl(deployedExecUrl)
 *   3. setQuay1Templates(...) / setAquaTemplates(...)   4. setupHub()   5. setupTriggers()
 * Optional: setPropdataCreds, setHubspotToken, setGroupsJson, setDriveTransferTo.
 * hubStatus() prints a non-secret summary of what is configured.
 */

/** Create/repair the tracker tabs and seed the safe flag defaults. Idempotent. Needs no args
 *  once TRACKER_SHEET_ID is set (or it creates a new tracker Spreadsheet and stores its id). */
function setupHub() {
  var id = optProp_(PROP.TRACKER_SHEET_ID);
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Quay 1 Boarding Tool Tracker');
    _setProp_(PROP.TRACKER_SHEET_ID, ss.getId());
  }
  // Onboarding tab (rename the default first sheet if it is the blank one).
  var onb = ss.getSheetByName(CFG.TAB.ONBOARDING);
  if (!onb) {
    var first = ss.getSheets()[0];
    if (first && first.getLastRow() === 0 && first.getLastColumn() === 0) {
      first.setName(CFG.TAB.ONBOARDING); onb = first;
    } else {
      onb = ss.insertSheet(CFG.TAB.ONBOARDING);
    }
  }
  ensureOnboardingTab_(onb);
  ensureQueueTabs_(ss);
  ensureTeamDirectoryTab_(ss); // B.3 team -> groups/division/systems map (seed via setupTeamDirectory)
  ensureAccountsTabs_(ss);     // Programs page rosters: CMA Accounts + PropData Accounts tabs
  ensureCredentialsTab_(ss);   // superuser-readable Google account + temp-password ledger
  _seedFlagDefaults_();
  var msg = 'setupHub complete. Tracker: ' + ss.getId() + '. Tabs: ' +
    ss.getSheets().map(function (s) { return s.getName(); }).join(', ') + '.';
  Logger.log(msg);
  return msg;
}

/** Install the recurring time-driven triggers (idempotent): the Tuesday induction digest (~07:00 and
 *  again ~14:00), the provisioning batch, the FICA/induction sweeps, and the offboarding reaper. */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    // UNION of every handler either side installs, so setupTriggers stays idempotent: each newTrigger
    // below has a matching name here so a re-run never leaves a duplicate schedule behind.
    if (fn === 'tuesdayDigest_' || fn === 'tuesdayDigestAfternoon_' || fn === 'reapOffboarding_' ||
        fn === 'provisionReadyBatch_' || fn === 'ficaFollowUpSweep_' ||
        fn === 'inductionPacketSweep_' || fn === 'workPermitExpirySweep_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tuesdayDigest_').timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(7).create();
  // Second send of the same induction digest at 14:00 (Africa/Johannesburg): after the booking cut-off
  // and one hour before the 15:00 provisioning batch, so the team gets the final post-cutoff picture.
  ScriptApp.newTrigger('tuesdayDigestAfternoon_').timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(14).create();
  ScriptApp.newTrigger('reapOffboarding_').timeBased()
    .everyMinutes(15).create();
  // Deferred provisioning: create accounts once a week for everyone approved (signed contract + FICA
  // in AND an admin has approved). Tuesday 15:00 (Africa/Johannesburg per appsscript.json timeZone) -
  // this is the ONLY time accounts are created; approval just marks a candidate ready for this batch.
  ScriptApp.newTrigger('provisionReadyBatch_').timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(15).create();
  // FICA follow-up: hourly sweep that nudges anyone 12+ hours past their contract email who has not
  // yet uploaded via their secure link (self-limits to daytime hours). See ficaFollowUpSweep_.
  ScriptApp.newTrigger('ficaFollowUpSweep_').timeBased()
    .everyHours(1).create();
  // Induction packet: every morning ~06:00 (Africa/Johannesburg), send the full packet WITH logins to
  // anyone whose induction Wednesday is that day. Booking itself only sends the "confirmed" email now.
  ScriptApp.newTrigger('inductionPacketSweep_').timeBased()
    .everyDays(1).atHour(6).create();
  // Work-permit expiry alert: weekly HR digest of permits expiring soon or already lapsed. Monday
  // ~08:00 (Africa/Johannesburg per appsscript.json timeZone). See workPermitExpirySweep_ in Hr.js.
  ScriptApp.newTrigger('workPermitExpirySweep_').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  return 'Triggers installed: Tuesday induction digest (~07:00 and ~14:00), offboarding reaper ' +
    '(every 15 min), provisioning batch (Tuesday ~15:00), FICA follow-up sweep (hourly, daytime), ' +
    'induction packet sweep (daily ~06:00), work-permit expiry alert (Monday ~08:00).';
}

/** Seed the SAFE flag defaults only when a flag is unset (never clobber an armed value). */
function _seedFlagDefaults_() {
  var defaults = {};
  defaults[FLAG.DRY_RUN] = '1';
  defaults[FLAG.OFFBOARD_ARMED] = '0';
  defaults[FLAG.HUBSPOT_SEAT_ENABLED] = '0';
  defaults[FLAG.PROPDATA_LIVE] = '0';
  Object.keys(defaults).forEach(function (k) {
    if (PropertiesService.getScriptProperties().getProperty(k) == null) _setProp_(k, defaults[k]);
  });
}

/**
 * One-shot LIVE bootstrap for everything non-secret. Run this ONCE from the Apps Script editor
 * after the first deploy: it triggers the OAuth consent for all project scopes (incl.
 * admin.directory - click Allow), seeds WEBAPP_URL (only if unset), stores the PUBLIC Supabase
 * url + anon key (same values already served in web/config.js - NOT secrets, every table is
 * RLS-gated), then creates the tracker tabs and installs the triggers. Idempotent.
 *
 * NOTE on WEBAPP_URL: from the editor, ScriptApp.getService().getUrl() returns the /dev HEAD url,
 * which requires a Workspace login and so is useless for the candidate FICA/induction links.
 * This only SEEDS it when unset; set the real versioned /exec url via setWebappUrl(execUrl) or the
 * Script Properties UI. bootstrapLive never overwrites an existing WEBAPP_URL.
 *
 * Still set separately afterwards (real ids / secrets, never in source): the contract template
 * Doc ids + Drive parent folders (setQuay1Templates / setAquaTemplates) and, once chosen, the
 * team->groups source. hubStatus() prints what remains unset.
 */
function bootstrapLive() {
  var out = [];
  // Seed WEBAPP_URL only when unset - never clobber a real /exec url with the editor's /dev url.
  if (!optProp_(PROP.WEBAPP_URL)) {
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
    if (url) { setWebappUrl(url); out.push('WEBAPP_URL <- ' + url + ' (SEEDED /dev - replace with the /exec url)'); }
    else { out.push('WEBAPP_URL still unset (run setWebappUrl(execUrl) by hand)'); }
  } else {
    out.push('WEBAPP_URL already set - left as is');
  }
  // PUBLIC values, identical to web/config.js (anon key is public by design; RLS gates all tables).
  setSupabase('https://dqszbqiimbfvmmnpgpsb.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxc3picWlpbWJmdm1tbnBncHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NDk4OTQsImV4cCI6MjA5NjQyNTg5NH0.M9RQnJEidyIMZAwbELTSPakiSnvuWBdHTjD7nuOdCZY');
  out.push('SUPABASE_URL + SUPABASE_ANON_KEY <- public values');
  out.push(setupHub());
  out.push(setupTeamDirectory()); // seed Team Directory (Team+Division) from divisions.json
  out.push(setupTriggers());
  var msg = 'bootstrapLive done:\n  ' + out.join('\n  ');
  Logger.log(msg);
  return msg;
}

// ---------------------------------------------------------------- secret setters

function setSupabase(url, anon, service) {
  _reqArg_(url, 'url'); _reqArg_(anon, 'anon');
  _setProp_(PROP.SUPABASE_URL, url);
  _setProp_(PROP.SUPABASE_ANON_KEY, anon);
  if (service) _setProp_(PROP.SUPABASE_SERVICE_KEY, service);
  return 'Supabase properties set.';
}

function setWebappUrl(url) { _reqArg_(url, 'url'); _setProp_(PROP.WEBAPP_URL, url); return 'WEBAPP_URL set.'; }

function setQuay1Templates(saleId, rentalId, parentFolderId) {
  _reqArg_(saleId, 'saleId'); _reqArg_(parentFolderId, 'parentFolderId');
  _setProp_(PROP.QUAY1_TEMPLATE_SALE, saleId);
  if (rentalId) _setProp_(PROP.QUAY1_TEMPLATE_RENTAL, rentalId);
  _setProp_(PROP.QUAY1_PARENT_FOLDER, parentFolderId);
  return 'Quay1 template + folder properties set.';
}

function setAquaTemplates(monthlyId, fixedId, permanentId, parentFolderId) {
  _reqArg_(monthlyId, 'monthlyId'); _reqArg_(parentFolderId, 'parentFolderId');
  _setProp_(PROP.AQUA_TEMPLATE_MONTHLY, monthlyId);
  if (fixedId) _setProp_(PROP.AQUA_TEMPLATE_FIXED, fixedId);
  if (permanentId) _setProp_(PROP.AQUA_TEMPLATE_PERMANENT, permanentId);
  _setProp_(PROP.AQUA_PARENT_FOLDER, parentFolderId);
  return 'Aqua template + folder properties set.';
}

function setPropdataCreds(apiKey, vendorId) {
  _reqArg_(apiKey, 'apiKey'); _reqArg_(vendorId, 'vendorId');
  _setProp_(PROP.PROPDATA_API_KEY, apiKey);
  _setProp_(PROP.PROPDATA_VENDOR_ID, vendorId);
  return 'PropData creds set (still dry-run until PROPDATA_LIVE=1).';
}

function setHubspotToken(token) { _reqArg_(token, 'token'); _setProp_(PROP.HUBSPOT_TOKEN, token); return 'HubSpot token set.'; }

function setGroupsJson(jsonString) {
  _reqArg_(jsonString, 'jsonString');
  if (!safeJsonParse_(jsonString, null)) throw new Error('jsonString is not valid JSON');
  _setProp_(PROP.GROUPS_JSON, jsonString);
  return 'GROUPS_JSON set.';
}

function setDriveTransferTo(email) { _reqArg_(email, 'email'); _setProp_(PROP.DRIVE_TRANSFER_TO, email); return 'DRIVE_TRANSFER_TO set.'; }

/**
 * READ-ONLY live check that Google Workspace provisioning WILL work - the one thing Blocker B0
 * could not verify at build time. Mutates NOTHING (no user is created or changed): it only reads
 * the directory to confirm, in order, that
 *   1. the AdminDirectory advanced service is wired in and callable,
 *   2. the deploying account's own directory record is readable (Users.get),
 *   3. that account is a Workspace super-admin (isAdmin) - REQUIRED for Users.insert to succeed,
 *   4. domain-wide user read works (Users.list) - proves the admin.directory.user scope,
 *   5. group read works (Groups.list) - the read half of the offboard teardown.
 * Run this from the Apps Script editor once, after authorising the scopes. A clean pass means the
 * only thing standing between googleCreate_ and real accounts is flipping DRY_RUN off. Any failure
 * is returned verbatim so the exact gap (scope not granted / not a super-admin) is obvious.
 */
function verifyGoogleLive(adminEmail) {
  var out = { ok: true, checks: [], as: '', dry_run: DRY_RUN_() };
  var note = function (name, ok, detail) {
    out.checks.push({ check: name, ok: ok, detail: detail });
    if (!ok) out.ok = false;
  };

  if (typeof AdminDirectory === 'undefined') {
    note('advanced_service', false, 'AdminDirectory is undefined - enable it in appsscript.json + the Cloud project Admin SDK.');
    Logger.log(JSON.stringify(out, null, 2));
    return out;
  }
  note('advanced_service', true, 'AdminDirectory advanced service is available.');

  // Session.getEffectiveUser().getEmail() is '' when the web app is hit anonymously, so fall back
  // to the known deploying admin (adminEmail arg, else pagan@DOMAIN). We look this account's record
  // up ONLY to read its isAdmin flag - the account whose OAuth token the inserts will run under.
  var me = '';
  try { me = Session.getEffectiveUser().getEmail() || ''; } catch (e) { me = ''; }
  var checkEmail = me || String(adminEmail || '') || ('pagan@' + CFG.DOMAIN);
  out.as = me || ('(anonymous; checking ' + checkEmail + ')');

  var meRec = null;
  try {
    meRec = AdminDirectory.Users.get(checkEmail);
    note('users_get_admin', true, 'Read directory record for ' + checkEmail + '.');
  } catch (e) {
    note('users_get_admin', false, 'Users.get(' + checkEmail + ') failed: ' + String(e));
  }

  if (meRec) {
    var isAdmin = meRec.isAdmin === true || meRec.isDelegatedAdmin === true;
    note('super_admin', isAdmin,
      isAdmin ? checkEmail + ' is a Workspace admin - Users.insert will be authorised.'
              : checkEmail + ' is NOT a Workspace admin - Users.insert will be denied. Grant super-admin or redeploy as one.');
  }

  try {
    var list = AdminDirectory.Users.list({ customer: 'my_customer', maxResults: 1 });
    var n = (list && list.users) ? list.users.length : 0;
    note('users_list', true, 'Domain user read works (sample size ' + n + ').');
  } catch (e) {
    note('users_list', false, 'Users.list failed: ' + String(e));
  }

  try {
    AdminDirectory.Groups.list({ customer: 'my_customer', maxResults: 1 });
    note('groups_list', true, 'Group read works (offboard teardown read half).');
  } catch (e) {
    note('groups_list', false, 'Groups.list failed: ' + String(e));
  }

  out.verdict = out.ok
    ? 'PASS - Google provisioning is live-ready. Remaining step is the arming decision (DRY_RUN=0).'
    : 'FAIL - see the failing check(s) above; fix before arming Google.';
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * LIVE WRITE smoke test for Google provisioning. EDITOR-ONLY (not reachable from the web app) and
 * REFUSES unless Google is already armed (DRY_RUN=0) - so it never bypasses the safety flag, it just
 * proves the armed path on one disposable account before you trust it on real brokers. It creates
 * ONE clearly-marked throwaway account via the REAL googleCreate_, verifies it landed with a
 * credentials-ledger row, suspends it, then DELETES it and removes the ledger row - all in a
 * try/finally so nothing lingers. Run it from the Apps Script editor once, right after arming.
 *
 * Group ADD is exercised for real (throwaway briefly joins its groups, removed when the account is
 * deleted). Returns a per-step PASS/FAIL report; a clean PASS means real onboarding is safe.
 */
function smokeTestGoogleLive(opts) {
  opts = opts || {};
  if (DRY_RUN_()) {
    return { ok: false, refused: true,
      message: 'Arm Google first (set Script Property DRY_RUN=0), then re-run. This test never bypasses DRY_RUN.' };
  }
  var stamp = Utilities.getUuid().slice(0, 8);
  var person = {
    folderId: 'SMOKE-' + stamp, full_name: 'Smoke Test ' + stamp,
    first_name: 'zzsmoke' + stamp, last_name: 'test',
    team: opts.team || 'Wombats', designation: 'SMOKE TEST', quay_email: '',
  };
  var report = { ok: true, steps: [], first_name: person.first_name, team: person.team };
  var step = function (name, ok, detail) { report.steps.push({ step: name, ok: ok, detail: detail }); if (!ok) report.ok = false; };
  var email = '';
  try {
    var groups = _groupsForTeam_(person.team);
    step('groups_computed', groups.indexOf(CFG.COMPANY_GROUP) >= 0 && groups.indexOf('wombats@' + CFG.DOMAIN) >= 0,
      'groups=' + JSON.stringify(groups));

    var created = googleCreate_(person); // real create (DRY_RUN is off - we refused above otherwise)
    email = created.email || '';
    step('user_created', !!email && !created.dryRun, 'email=' + email + ' pw=' + created.tempPw);

    var rec = AdminDirectory.Users.get(email);
    step('user_readback', !!rec && rec.suspended !== true, 'exists; suspended=' + (rec && rec.suspended));

    var cred = _findCredential_(email);
    step('credential_recorded', !!cred && cred.temp_password === created.tempPw,
      cred ? 'ledger row present for ' + email : 'ledger row MISSING for ' + email);

    // A just-created user is not immediately mutable ("User creation is not complete"); wait+retry.
    _withUserReady_(function () { AdminDirectory.Users.update({ suspended: true }, email); });
    // The suspend is accepted but the read is eventually consistent on a seconds-old account, so
    // poll the readback until it reflects suspended=true (a race that cannot happen in real
    // offboarding, where suspend runs long after creation).
    var confirmed = false;
    for (var s = 0; s < 6 && !confirmed; s++) {
      var r2 = AdminDirectory.Users.get(email);
      confirmed = !!(r2 && r2.suspended === true);
      if (!confirmed) Utilities.sleep(5000);
    }
    step('suspend_confirmed', confirmed, 'suspended=' + confirmed);
  } catch (e) {
    step('exception', false, String(e));
  } finally {
    if (email) {
      try { _withUserReady_(function () { AdminDirectory.Users.remove(email); }); step('cleanup_user_deleted', true, 'removed ' + email); }
      catch (e) { step('cleanup_user_deleted', false, 'DELETE FAILED - run cleanupSmokeAccounts() or remove manually: ' + email + ' :: ' + String(e)); }
      try { _removeCredential_(email); step('cleanup_ledger_removed', true, 'ledger row removed'); }
      catch (e2) { step('cleanup_ledger_removed', false, String(e2)); }
    }
  }
  report.verdict = report.ok
    ? 'PASS - live create + ledger + suspend + cleanup all work. Real onboarding is safe.'
    : 'FAIL - see failing step(s). Run cleanupSmokeAccounts() to clear any leftover zzsmoke* account.';
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Retry fn while the Google directory reports a just-created user is not yet mutable/visible.
 *  Google needs a short propagation window after Users.insert before update/delete/suspend work. */
function _withUserReady_(fn, tries) {
  tries = tries || 8;
  var lastErr;
  for (var i = 0; i < tries; i++) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      if (!/not complete|Resource Not Found: userKey/i.test(String(e))) throw e; // a real error, not propagation
      Utilities.sleep(5000); // wait ~5s and try again (up to ~40s total)
    }
  }
  throw lastErr;
}

/**
 * Delete any leftover throwaway smoke-test accounts (primaryEmail starting 'zzsmoke') and their
 * ledger rows. Run this if a smokeTestGoogleLive() left an account behind (propagation timeout).
 * Blast radius is limited to the zzsmoke* test prefix. Returns what it removed.
 */
function cleanupSmokeAccounts() {
  var out = { deleted: [], failed: [] };
  var resp;
  try {
    resp = AdminDirectory.Users.list({ customer: 'my_customer', maxResults: 200, query: 'email:zzsmoke*' });
  } catch (e) {
    out.error = 'Users.list failed: ' + String(e);
    Logger.log(JSON.stringify(out, null, 2));
    return out;
  }
  (resp.users || []).forEach(function (u) {
    var email = u.primaryEmail;
    try {
      _withUserReady_(function () { AdminDirectory.Users.remove(email); });
      out.deleted.push(email);
      try { _removeCredential_(email); } catch (e2) { /* ledger row optional */ }
    } catch (e) {
      out.failed.push({ email: email, error: String(e) });
    }
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Print a non-secret summary of what is configured (which keys are set + the flag values). */
function hubStatus() {
  var isSet = function (k) { return optProp_(k) ? 'set' : '(unset)'; };
  var s = {
    tracker: isSet(PROP.TRACKER_SHEET_ID),
    webapp_url: isSet(PROP.WEBAPP_URL),
    supabase: isSet(PROP.SUPABASE_URL),
    quay1_templates: isSet(PROP.QUAY1_TEMPLATE_SALE) + '/' + isSet(PROP.QUAY1_TEMPLATE_RENTAL),
    quay1_parent_folder: isSet(PROP.QUAY1_PARENT_FOLDER),
    // Aqua must have ALL of these set or onboardAqua_ throws (no folder / no template) and no Aqua
    // row is ever written - the usual reason "Aqua contractors have no HR row / no sheet to update".
    aqua_templates: isSet(PROP.AQUA_TEMPLATE_MONTHLY) + '/' + isSet(PROP.AQUA_TEMPLATE_FIXED) + '/' + isSet(PROP.AQUA_TEMPLATE_PERMANENT),
    aqua_parent_folder: isSet(PROP.AQUA_PARENT_FOLDER),
    hr_sheet: isSet(PROP.HR_SHEET_ID),
    propdata_creds: isSet(PROP.PROPDATA_API_KEY) + '/' + isSet(PROP.PROPDATA_VENDOR_ID),
    hubspot_token: isSet(PROP.HUBSPOT_TOKEN),
    groups_json: isSet(PROP.GROUPS_JSON),
    flags: {
      DRY_RUN: DRY_RUN_(), OFFBOARD_ARMED: offboardArmed_(),
      HUBSPOT_SEAT_ENABLED: hubspotSeatEnabled_(), PROPDATA_LIVE: propdataLive_(),
      HR_SYNC_ENABLED: hrSyncEnabled_(), CC_ENABLED: ccEnabled_(),
    },
  };
  Logger.log(JSON.stringify(s, null, 2));
  return s;
}

/**
 * READ-ONLY diagnostic (editor Run): the single call that explains the HR + Aqua questions -
 * "where do Aqua employees go on the HR sheet" and "why don't their contracts sit for approval".
 * Reports, per entity, how many onboarding rows exist and how many are docs-complete/approved, plus
 * which HR destination tabs actually exist in the live HR sheet. If aqua.total is 0, no Aqua person
 * has ever been onboarded through the tool (so there is nothing to promote and no Aqua tab yet);
 * if the Aqua tab is absent it is created automatically on the first Aqua promotion. Sends nothing.
 */
function diagnoseHrAqua() {
  var counts = {};
  listOnboarding_().forEach(function (o) {
    var e = String(o.entity || '(blank)');
    counts[e] = counts[e] || { total: 0, docs_ready: 0, approved: 0, provisioned: 0, promoted_to_hr: 0 };
    counts[e].total++;
    if (_docsReady_(o)) counts[e].docs_ready++;
    if (o.approved_at) counts[e].approved++;
    if (o.provisioned_at) counts[e].provisioned++;
    if (o.hr_promoted_at) counts[e].promoted_to_hr++;
  });
  var tabs = {};
  try {
    var ss = SpreadsheetApp.openById(hrSheetId_());
    Object.keys(HR_TAB).forEach(function (k) { tabs[HR_TAB[k]] = !!ss.getSheetByName(HR_TAB[k]); });
  } catch (e) { tabs = { error: String(e) }; }
  var out = {
    hr_sync_enabled: hrSyncEnabled_(),
    hr_sheet_set: !!optProp_(PROP.HR_SHEET_ID),
    aqua_configured: !!optProp_(PROP.AQUA_PARENT_FOLDER) && !!optProp_(PROP.AQUA_TEMPLATE_MONTHLY),
    onboarding_rows_by_entity: counts,
    hr_destination_tabs_present: tabs,
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

// ---------------------------------------------------------------- helpers

function _setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, String(v)); }
function _reqArg_(v, name) { if (!v || !String(v).trim()) throw new Error('argument "' + name + '" is required'); }

// ---------------------------------------------------------------- arm / disarm onboarding
// One-click, reversible arming of the LIVE onboarding path, run from the editor. These only ever touch
// the two flags onboarding needs; offboarding (which suspends real accounts with no cancel window),
// PropData-live and HubSpot seats are left untouched and must be armed separately and explicitly.

/**
 * ARM onboarding for live operation. Turns OFF dry-run so provisioning creates real Google accounts and
 * the onboarding emails actually send (the Google-only welcome pack, the Aqua acceptance + Dialfire
 * request to Alan and Kat, the CMA request), and turns ON HR sync so the HR sheet is written for real.
 * Leaves OFFBOARD_ARMED, PROPDATA_LIVE and HUBSPOT_SEAT_ENABLED as they are. Reversible via
 * disarmOnboarding(). Logs + returns the resulting flag snapshot so running it self-verifies.
 */
function armOnboarding() {
  _setProp_(FLAG.DRY_RUN, '0');
  _setProp_(FLAG.HR_SYNC_ENABLED, '1');
  var state = _armingSnapshot_();
  Logger.log('armOnboarding -> ' + JSON.stringify(state, null, 2));
  return state;
}

/**
 * REVERT armOnboarding(): dry-run back ON and HR sync back OFF. Offboarding / PropData-live /
 * HubSpot-seat flags are left as they are. Logs + returns the resulting flag snapshot.
 */
function disarmOnboarding() {
  _setProp_(FLAG.DRY_RUN, '1');
  _setProp_(FLAG.HR_SYNC_ENABLED, '0');
  var state = _armingSnapshot_();
  Logger.log('disarmOnboarding -> ' + JSON.stringify(state, null, 2));
  return state;
}

/** Read-only: log + return the current arming flags. Changes nothing. Run from the editor to check. */
function flagStatus() {
  var state = _armingSnapshot_();
  Logger.log('flagStatus -> ' + JSON.stringify(state, null, 2));
  return state;
}

/** The arming-flag snapshot used by arm/disarm/flagStatus for self-verification. */
function _armingSnapshot_() {
  return {
    DRY_RUN: DRY_RUN_(),
    HR_SYNC_ENABLED: hrSyncEnabled_(),
    OFFBOARD_ARMED: offboardArmed_(),
    PROPDATA_LIVE: propdataLive_(),
    HUBSPOT_SEAT_ENABLED: hubspotSeatEnabled_(),
    CC_ENABLED: ccEnabled_(),
  };
}

// ---------------------------------------------------------------- Quay 1 contract templates (v2.1G)
// The two new "Blank" v2.1G agreement docs are manual-fill (underscores + hardcoded example values),
// NOT merge templates. These one-offs turn them into merge templates the contract generator can fill
// ({{FULL_NAME}} {{ID_NUMBER}} {{START_DATE}} {{SENIOR_BROKER}} {{COMMISSION}} {{BROKER_ACTIVITY}}),
// then (separately, after you review) repoint the live templates at the prepared copies.

/** The two new v2.1G source docs the user added to the Quay 1 parent folder. */
var NEW_QUAY1_DOCS = {
  sale: '1LZKvEnt35d47RerUTkJPzvhaxSCv9nIK0rMSYN89wmg',   // IGCISA Broker Agreement Residential - 2026v2.1G
  rental: '1cugIhl1t2Q3C8zlyjz9ptfrPNynRuKorXMDr7nAveDU', // IGCISA Residential Rental Broker Agreement - v2.1G
};

/**
 * STEP 1 (run from the editor). Copy each new v2.1G doc into the Quay 1 parent folder and insert the
 * merge tokens genQuay1Contract_ fills. Does NOT touch the live templates. Returns + logs the new copy
 * ids and a REVIEW checklist. The unambiguous tokens are inserted automatically; {{BROKER_ACTIVITY}}
 * is left for you to place by hand (the "Broker Activities shall mean" clause is legal wording I will
 * not rewrite blindly), and the {{COMMISSION}} placement is flagged for you to confirm.
 */
function prepareQuay1MergeTemplates() {
  var parentId = optProp_(PROP.QUAY1_PARENT_FOLDER);
  var parent = parentId ? DriveApp.getFolderById(parentId) : DriveApp.getRootFolder();
  var out = {};
  Object.keys(NEW_QUAY1_DOCS).forEach(function (kind) {
    var copy = DriveApp.getFileById(NEW_QUAY1_DOCS[kind])
      .makeCopy('Quay 1 ' + kind + ' agreement v2.1G (MERGE TEMPLATE)', parent);
    var doc = DocumentApp.openById(copy.getId());
    var b = doc.getBody();
    // Unambiguous: the personal fields and the hardcoded example values.
    b.replaceText('(Name:)\\s*_{2,}', '$1 {{FULL_NAME}}');
    b.replaceText('(\\bID)\\s+_{2,}', '$1 {{ID_NUMBER}}');
    b.replaceText('With effect from 21 March 2026', 'With effect from {{START_DATE}}');
    b.replaceText('Justin Nortier', '{{SENIOR_BROKER}}');
    // Best-effort, FLAGGED: the broker commission split in clause 5.1 ("50%"). The 25% partnership
    // split in 4.3.1 is deliberately left alone - confirm which the system should fill.
    b.replaceText('commission equal to 50%', 'commission equal to {{COMMISSION}}%');
    doc.saveAndClose();
    out[kind] = copy.getId();
  });
  var report = 'prepareQuay1MergeTemplates -> ' + JSON.stringify(out, null, 2) +
    '\n\nREVIEW each copy before repointing:' +
    '\n 1. {{FULL_NAME}} / {{ID_NUMBER}} landed on the Name / ID lines.' +
    '\n 2. {{START_DATE}} replaced "21 March 2026"; {{SENIOR_BROKER}} replaced "Justin Nortier".' +
    '\n 3. {{COMMISSION}} was placed at clause 5.1 (the broker "50%" split). The 25% in 4.3.1 was left as-is - fix if wrong.' +
    '\n 4. PLACE {{BROKER_ACTIVITY}} BY HAND: replace the "Broker Activities shall mean" definition clause' +
    '\n    (the one ending "(*delete inapplicable definition)") with {{BROKER_ACTIVITY}} so the system' +
    '\n    injects the correct clause per activity. Until you do, generated contracts keep the combined clause.' +
    '\n\nThen run: useNewQuay1Templates("' + (out.sale || '') + '", "' + (out.rental || '') + '")';
  Logger.log(report);
  return { ids: out, report: report };
}

/**
 * STEP 2 (run from the editor AFTER reviewing the prepared copies). Repoint the LIVE Quay 1 Sale +
 * Rental templates at the prepared merge copies. Pass the ids logged by prepareQuay1MergeTemplates.
 * This changes what real generated contracts are built from, so only run it once the copies are correct.
 */
function useNewQuay1Templates(saleId, rentalId) {
  if (saleId) _setProp_(PROP.QUAY1_TEMPLATE_SALE, String(saleId).trim());
  if (rentalId) _setProp_(PROP.QUAY1_TEMPLATE_RENTAL, String(rentalId).trim());
  var msg = 'Quay 1 templates repointed. SALE=' + optProp_(PROP.QUAY1_TEMPLATE_SALE) +
    ' RENTAL=' + optProp_(PROP.QUAY1_TEMPLATE_RENTAL);
  Logger.log(msg);
  return msg;
}
