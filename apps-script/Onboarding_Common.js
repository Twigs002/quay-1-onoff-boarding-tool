/**
 * Onboarding_Common.js - helpers shared by BOTH onboarding flows (Quay1 + Aqua), so neither
 * flow module reaches sideways into the other. Sits below the flow modules in the call order
 * (Router -> Onboarding_* -> here -> Email/Drive/Util). Addition to the stub set, flagged to
 * tester + architect.
 *
 * Public surface:
 *   _entityFolder_(parentId, name, id)  - Folder  get-or-create "<name> - <id>" under a parent.
 *   _emailContract_(entity, toEmail, name, folderId, pdfFile, extraCc) - Boolean  send the branded
 *                                         contract welcome email (auto-send: scoped pipeline
 *                                         exception per SPEC section 6). CC = CFG.CONTRACT_CC[entity]
 *                                         plus any extraCc (Quay 1 passes senior + requester, to
 *                                         match the live recruitment pipeline). Non-fatal: returns
 *                                         false on send failure, the row + PDF still stand.
 *   _provisionList_(body, fields)       - [system...]|null  the explicit systems the UI chose.
 *                                         Accepts `provision` (UI key), `systems`, on either the
 *                                         body or the fields object (TEST-REPORT drift 3).
 */

/** Explicit systems list from the payload, checking the UI `provision` key and `systems` on both
 *  the top-level body and the nested fields object. Returns null when none is supplied (so the
 *  caller falls back to the entity core set + program mapping). */
function _provisionList_(body, fields) {
  var b = body || {}, f = fields || {};
  var v = b.provision || f.provision || b.systems || f.systems;
  return (Array.isArray(v) && v.length) ? v : null;
}

/** Get-or-create the per-person folder "<name> - <id>" under `parentId`. */
function _entityFolder_(parentId, name, id) {
  var root = DriveApp.getFolderById(parentId);
  var label = ((name || 'Unknown') + ' - ' + (id || '')).trim();
  var it = root.getFoldersByName(label);
  return it.hasNext() ? it.next() : root.createFolder(label);
}

/**
 * Send the contract welcome email (with the FICA self-service link and the PDF attached).
 * entity in {quay1, aqua}. Returns true when sent, false on a caught failure (non-fatal).
 */
function _emailContract_(entity, toEmail, name, folderId, pdfFile, extraCc) {
  if (!isEmail_(toEmail)) return false;
  var company = CFG.COMPANY[entity] || CFG.COMPANY.quay1;
  var first = firstName_(name);
  var ficaUrl = ficaLink_(folderId);
  // A test onboard (a plus-addressed +test / +qa recipient) never CCs the internal contracts
  // inbox - it goes only to the test address, so QA runs cannot spam colleagues.
  var ccList = _isTestRecipient_(toEmail) ? '' : _contractCc_(entity, extraCc);
  var fullName = String(name || '').trim();
  var subject = 'Your ' + company.name + ' Agreement' + (fullName ? ' - ' + fullName : '');
  var plain =
    'Hi ' + first + ',\n\n' +
    'Welcome to ' + company.name + '. Please find your ' + company.kicker + ' attached.\n\n' +
    'Kindly read it through, complete the signature page (sign where indicated and initial each ' +
    'page), and return a signed copy to us. Keep a copy for your own records.\n\n' +
    'FICA (required): please submit the following using your personal, secure link:\n' +
    '  1. A certified copy of your ID or valid passport\n' +
    '  2. Proof of your residential address, not older than 3 months\n' +
    '  3. A bank confirmation letter or recent bank statement\n' +
    '  4. Your income tax number (and SARS proof of it, if you have one)\n\n' +
    'Submit your FICA documents here: ' + ficaUrl + '\n\n' +
    'If anything is unclear, simply reply to this email and we will gladly help.\n\n' +
    'Warm regards,\nThe ' + company.name + ' Team';
  try {
    var opts = {
      name: company.name,
      htmlBody: agreementEmailHtml_(company, first, ficaUrl),
    };
    if (ccList) opts.cc = ccList;
    if (pdfFile) opts.attachments = [pdfFile.getAs('application/pdf')];
    GmailApp.sendEmail(toEmail, subject, plain, opts);
    // Stamp when the welcome email went out so the 12-hour FICA follow-up sweep has a clock to key
    // off. Non-fatal: a stamp failure must never fail the (already sent) contract email.
    try { setOnboardingCell_(folderId, ONB_COL.contract_emailed_at, nowIso_()); }
    catch (e) { logAudit_('contract_emailed_stamp_failed', { folderId: folderId, error: String(e) }); }
    return true;
  } catch (err) {
    logAudit_('email_contract_failed', { entity: entity, to: toEmail, error: String(err) });
    return false;
  }
}

/** A QA/test recipient: plus-addressed +test or +qa (e.g. name+test@quay1.co.za). Used to suppress
 *  the internal CC on test onboards so a QA run never emails real colleagues. */
function _isTestRecipient_(email) {
  return /\+(test|qa)\b/i.test(String(email || ''));
}

/** Build the contract-email CC string for an entity: the fixed CONTRACT_CC[entity] set plus any
 *  extraCc (Quay 1 adds the senior broker + requester). De-duplicated (case-insensitive), only
 *  valid addresses, excluding the recipient is left to Gmail. Returns '' when nothing to CC. */
function _contractCc_(entity, extraCc) {
  if (!ccEnabled_()) return '';
  var base = (CFG.CONTRACT_CC && CFG.CONTRACT_CC[entity]) || CFG.ALWAYS_CC || [];
  var all = base.concat(Array.isArray(extraCc) ? extraCc : (extraCc ? [extraCc] : []));
  var seen = {}, out = [];
  all.forEach(function (e) {
    var v = String(e || '').trim();
    if (!isEmail_(v)) return;
    var k = v.toLowerCase();
    if (seen[k]) return;
    seen[k] = true; out.push(v);
  });
  return out.join(',');
}

/** The generated agreement PDF sits directly in the candidate's folder (FICA uploads go to a
 *  subfolder), so the first root-level PDF is the contract. null if none / on error. */
function _folderContractPdf_(folderId) {
  try {
    var it = DriveApp.getFolderById(folderId).getFilesByType(MimeType.PDF);
    return it.hasNext() ? it.next() : null;
  } catch (e) { return null; }
}

/**
 * Send a follow-up reminder to a candidate who has not finished onboarding: re-sends the original
 * contract welcome email (branded HTML + FICA link) with the agreement PDF re-attached, framed as a
 * gentle nudge to sign and submit FICA. Admin/onboarder-initiated (never automatic). No internal CC -
 * a reminder should not re-spam the contracts inbox on every nudge. Returns { ok, sent, to }.
 */
function _remindContract_(folderId, ctx) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  if (o.provisioned_at) return { ok: false, error: 'this person is already set up - no reminder needed' };
  if (!isEmail_(o.email)) return { ok: false, error: 'no valid candidate email on file for this person' };
  var entity = o.entity || 'quay1';
  var company = CFG.COMPANY[entity] || CFG.COMPANY.quay1;
  var first = firstName_(o.name);
  var ficaUrl = ficaLink_(folderId);
  var pdf = _folderContractPdf_(folderId);
  var subject = 'Reminder: submit your ' + company.name + ' FICA documents' + (o.name ? ' - ' + o.name : '');
  var plain =
    'Hi ' + first + ',\n\n' +
    'Just a friendly reminder to submit your FICA documents using your personal, secure link:\n' +
    ficaUrl + '\n\n' +
    'If you have already taken care of this, thank you - please ignore this note. Reply to this email ' +
    'if you need any help.\n\nWarm regards,\nThe ' + company.name + ' Team';
  try {
    var opts = { name: company.name, htmlBody: agreementEmailHtml_(company, first, ficaUrl) };
    if (ccEnabled_() && isEmail_(o.senior_email)) opts.cc = o.senior_email;
    if (pdf) opts.attachments = [pdf.getAs('application/pdf')];
    GmailApp.sendEmail(o.email, subject, plain, opts);
    setOnboardingCell_(folderId, ONB_COL.reminded_at, nowIso_());
    logAudit_('contract_reminder_sent', { folderId: folderId, to: o.email, by: (ctx && ctx.email) || '' });
    return { ok: true, sent: true, to: o.email, reminded_at: nowIso_() };
  } catch (err) {
    logAudit_('contract_reminder_failed', { folderId: folderId, error: String(err) });
    return { ok: false, error: 'could not send the reminder: ' + String(err && err.message ? err.message : err) };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Automatic 12-hour FICA follow-up
 *
 * Some new starters reply to the contract email with their FICA documents attached instead of using
 * their personal secure upload link, which leaves the tracker showing FICA incomplete and stalls
 * their induction. ficaFollowUpSweep_() is a time-driven sweep (installed hourly in Setup.js) that,
 * 12 hours after the contract welcome email went out, sends ONE nudge whose whole job is to point
 * the person back to the secure link (and ask them not to reply with attachments). This is part of
 * the scoped onboarding auto-send pipeline (SPEC section 6), so it sends without DRY_RUN gating,
 * exactly like the contract welcome email itself.
 * ---------------------------------------------------------------------------------------------- */

/** Delay from the contract email to the FICA follow-up nudge: 12 hours. */
var FICA_FOLLOWUP_DELAY_MS = 12 * 60 * 60 * 1000;

/** Only send follow-ups during daytime (07:00-20:00 in the script timezone) so a contract emailed in
 *  the afternoon never triggers a 3am nudge - a due row simply waits for the next daytime sweep. */
function _inFollowUpWindow_() {
  var tz = Session.getScriptTimeZone() || 'Africa/Johannesburg';
  var h = parseInt(Utilities.formatDate(new Date(), tz, 'H'), 10);
  return h >= 7 && h < 20;
}

/** True once the person has engaged with the secure FICA link: status advanced to "FICA received"
 *  (Fica.js) or any FICA doc tick (R..V) is present. Such rows never get the "use the link" nudge. */
function _ficaSubmitted_(o) {
  if (/fica received/i.test(String(o.status || ''))) return true;
  return !!(o.fica_nda || o.fica_bank || o.fica_poa || o.fica_id || o.fica_contract);
}

/** Whether an onboarding row is due the automatic FICA follow-up at time `now` (ms). */
function _ficaFollowUpDue_(o, now) {
  if (!o.contract_emailed_at) return false;         // welcome email never sent (or pre-dates this feature)
  if (o.fica_followup_at) return false;             // already nudged once
  if (o.provisioned_at || o.approved_at) return false;  // already set up / signed off
  if (_ficaSubmitted_(o)) return false;             // already used the link - nothing to nudge
  if (_isTestRecipient_(o.email)) return false;     // QA onboards do not get chased
  if (!isEmail_(o.email)) return false;
  var t = Date.parse(o.contract_emailed_at);
  if (!t) return false;
  return (now - t) >= FICA_FOLLOWUP_DELAY_MS;
}

/** Send the single "please use your secure FICA link" follow-up for one onboarding row. */
function _sendFicaFollowUp_(o) {
  var entity = o.entity || 'quay1';
  var company = CFG.COMPANY[entity] || CFG.COMPANY.quay1;
  var first = firstName_(o.name);
  var ficaUrl = ficaLink_(o.folderId);
  var subject = 'Please submit your ' + company.name + ' FICA documents via your secure link' +
    (o.name ? ' - ' + o.name : '');
  var plain =
    'Hi ' + first + ',\n\n' +
    'A quick follow-up on your FICA documents. To keep your information secure and to move your ' +
    'setup along, please upload your documents using your personal, secure link rather than ' +
    'replying to this email with attachments:\n\n' +
    ficaUrl + '\n\n' +
    'Uploading through the link is the only way your documents reach our system, so anything sent ' +
    'as an email reply will not be picked up. If you have already uploaded via the link, thank you ' +
    'and please ignore this note.\n\n' +
    'If you need a hand, simply reply and we will gladly help.\n\n' +
    'Warm regards,\nThe ' + company.name + ' Team';
  var opts = { name: company.name, htmlBody: ficaFollowUpHtml_(company, first, ficaUrl) };
  // Stamp the once-only marker BEFORE sending. If the marker write fails we would rather miss this
  // optional courtesy nudge than risk re-sending it on the next hourly sweep: a send failure after a
  // successful stamp costs one un-sent email (still logged), never a duplicate to the candidate.
  setOnboardingCell_(o.folderId, ONB_COL.fica_followup_at, nowIso_());
  GmailApp.sendEmail(o.email, subject, plain, opts);
  logAudit_('fica_followup_sent', { folderId: o.folderId, to: o.email });
}

/**
 * Time-driven sweep (installed hourly by setupTriggers): send the one-time FICA follow-up to every
 * onboarding row that is 12+ hours past its contract email and has not yet used the secure link.
 * Idempotent per row via the fica_followup_at marker; quiet outside daytime hours. Non-fatal per row.
 */
function ficaFollowUpSweep_() {
  if (!_inFollowUpWindow_()) return;
  var now = new Date().getTime();
  var due = listOnboarding_(function (o) { return _ficaFollowUpDue_(o, now); });
  due.forEach(function (o) {
    try { _sendFicaFollowUp_(o); }
    catch (e) { logAudit_('fica_followup_failed', { folderId: o.folderId, error: String(e) }); }
  });
  if (due.length) logAudit_('fica_followup_sweep', { sent: due.length });
}
