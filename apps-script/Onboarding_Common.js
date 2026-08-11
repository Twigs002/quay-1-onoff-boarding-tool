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
