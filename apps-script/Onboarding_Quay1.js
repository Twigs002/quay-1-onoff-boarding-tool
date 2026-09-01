/**
 * Onboarding_Quay1.js - Quay 1 broker onboarding. Generates the 2026 v2.1G contract (Sale or
 * Rental template), creates the candidate Drive folder, writes the Onboarding row, emails the
 * candidate, and triggers provisioning for the resolved systems.
 *
 * Owner: backend. Reconstructed from the live Quay1 FRONTEND (RESEARCH 1, Blocker B1: the
 * 1apqpQ... script could not be cloned). Request/response SHAPE is authoritative; the exact
 * server-side field->tracker-column mapping is a TODO to confirm once B1 unblocks. Template +
 * folder ids come from Script Properties, never hardcoded.
 *
 * Fields consumed (live RESEARCH 1.3 names): full_name, id_number, activity, start_date,
 * team, senior_broker, commission, candidate_email, contact_number, senior_email,
 * requester_name, requester_email, programs:[{code,label,note?}], deal_type(sale|rental),
 * files:[{name, mimeType, dataBase64}]. requester_* FORCE-OVERRIDDEN from ctx.
 * _quay1Fields_ ALSO accepts the SPEC-3.1 / UI aliases (name, email, contact, senior_name,
 * designation) so either frontend works (TEST-REPORT drift 1). The chosen provisioning systems
 * arrive as `provision:[...]` (TEST-REPORT drift 3), read via _provisionList_.
 *
 * Placeholders filled (UPPER_CASE per the 2026 v2.1G template):
 *   {{FULL_NAME}} {{ID_NUMBER}} {{START_DATE}} {{SENIOR_BROKER}} {{COMMISSION}} {{BROKER_ACTIVITY}}
 *
 * Public surface:
 *   onboardQuay1_(body, ctx)     - {ok, folderId, folderUrl, pdfUrl}   full flow. requireOnboarder_ (super/admin/broker).
 *   genQuay1Contract_(folder, data) - {docId, url, pdfUrl, pdfFile}  copy template, fill, PDF.
 *   quay1TemplateFor_(dealType, activity) - String templateId  Sale vs Rental. UI deal_type is
 *                                  the explicit override; else activity mentioning "rent".
 */

function onboardQuay1_(body, ctx) {
  requireOnboarder_(ctx);
  var f = (body && body.fields) || body || {};
  var c = _quay1Fields_(f);
  if (!c.full_name || !c.id_number) return { ok: false, error: 'full_name and id_number are required' };
  // Guard the ID field against a mis-entered NAME (a surname once landed here, leaving the real ID
  // missing everywhere downstream). A valid entry is a 13-digit SA ID or an alphanumeric passport -
  // both contain at least one digit; a pure word/name does not. Also strip spaces and reject a
  // 13-digit value that fails the SA ID checksum (a likely typo). Passports keep their letters.
  var idClean = c.id_number.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(idClean) || !/\d/.test(idClean)) {
    return { ok: false, error: 'ID/passport number "' + c.id_number + '" looks like a name, not an ID. ' +
      'Enter a 13-digit SA ID or a passport number (letters and digits, no spaces).' };
  }
  if (/^\d{13}$/.test(idClean) && !saIdChecksumOk_(idClean)) {
    return { ok: false, error: 'That 13-digit SA ID fails its checksum - please re-check the number.' };
  }
  c.id_number = idClean;
  if (!isEmail_(c.candidate_email)) return { ok: false, error: 'a valid candidate email is required' };

  var folder = _entityFolder_(prop_(PROP.QUAY1_PARENT_FOLDER, true), c.full_name, c.id_number);
  _saveUploadedFiles_(folder, (body && body.files) || []);

  var requesterEmail = (ctx && ctx.email) || '';
  var requesterName = (ctx && ctx.name) || '';

  // Write the tracker row FIRST so a fresh onboard ALWAYS leaves a visible row, even if contract
  // generation later throws (missing/unreadable template, DocumentApp failure, missing Team Directory).
  // Status starts 'Contract pending' and advances to 'Contract sent' once the PDF is in hand.
  upsertOnboardingRow_({
    folderId: folder.getId(), entity: 'quay1', name: c.full_name, id_number: c.id_number,
    email: c.candidate_email, contact: c.contact_number,
    start_date: fmtDate_(c.start_date), senior_name: c.senior_broker,
    senior_email: c.senior_email, requester_name: requesterName,
    requester_email: requesterEmail, designation: brokerActivityLabel_(c.activity) || c.activity, team: c.team,
    commission: c.commission, programs: c.programs,
    nationality: c.nationality, status: 'Contract pending',
  });

  // Generate the contract + resolve the provisioning systems (deferred to provisionReadyBatch_; nothing
  // is created now). If this throws, the row above still stands - mark it 'Contract error' and return the
  // error so the operator sees it, instead of losing the candidate with no row at all.
  var gen, systems;
  try {
    gen = genQuay1Contract_(folder, c);
    systems = resolveSystems_('quay1', c.programs, _provisionList_(body, f), c.team, c.activity);
  } catch (err) {
    try { setOnboardingStatus_(folder.getId(), 'Contract error'); } catch (e) { /* row still stands */ }
    logAudit_('quay1_contract_gen_failed', { folderId: folder.getId(), error: String(err) });
    return { ok: false, folderId: folder.getId(), folderUrl: folder.getUrl(),
      error: 'contract generation failed: ' + String(err && err.message ? err.message : err) };
  }

  // Contract is in hand: persist the resolved systems + advance the status.
  upsertOnboardingRow_({ folderId: folder.getId(), systems_json: JSON.stringify(systems), status: 'Contract sent' });

  // Mirror the new starter into the HR sheet's "New Starters (Tracking)" tab (non-fatal, DRY_RUN-safe).
  try { hrTrackingUpsert_(folder.getId()); }
  catch (err) { logAudit_('hr_tracking_failed', { folderId: folder.getId(), error: String(err) }); }

  // CC the senior broker + requester on the welcome email, matching the live recruitment pipeline.
  var emailed = _emailContract_('quay1', c.candidate_email, c.full_name, folder.getId(), gen.pdfFile,
    [c.senior_email, requesterEmail]);

  return {
    ok: true, folderId: folder.getId(), folderUrl: folder.getUrl(), pdfUrl: gen.pdfUrl,
    emailed: emailed, provisioning_deferred: true, systems: systems,
  };
}

/**
 * Normalise the onboard payload to a canonical object, accepting BOTH naming schemes so the seam
 * works from either frontend (TEST-REPORT drift 1). The SPEC-3.1 / UI names (name, email,
 * contact, senior_name, designation) are the PRIMARY reads because the live UI + SPEC agree and
 * the live 1apqp script is unverified (Blocker B1); the live 1apqp aliases (full_name,
 * candidate_email, contact_number, senior_broker, activity) are accepted as a fallback, read via
 * bracket notation and clearly labelled, pending reconciliation once clasp login is restored.
 */
function _quay1Fields_(f) {
  return {
    full_name: String(f.name || f['full_name'] || '').trim(),
    id_number: String(f.id_number || '').trim(),
    candidate_email: String(f.email || f['candidate_email'] || '').trim(),
    contact_number: f.contact || f['contact_number'] || '',
    senior_broker: f.senior_name || f['senior_broker'] || '',
    senior_email: f.senior_email || '',
    // `activity` is now the broker-activity CODE (sell_res_sb, rent_res_jb, ...) the picker sends.
    // Fall back to the legacy designation field so an older payload still fills something.
    activity: String(f.activity || f['activity'] || f.designation || '').trim(),
    start_date: f.start_date || '',
    team: f.team || '',
    commission: f.commission || '',
    deal_type: f.deal_type || '',
    programs: f.programs || [],
    // Only meaningful (and asked for on the form) when the ID is not a 13-digit SA ID; Hr.js
    // defaults SA IDs to "South African" so an empty value here is fine for locals.
    nationality: String(f.nationality || '').trim(),
  };
}

/** Copy the Sale/Rental template, fill the UPPER_CASE placeholders, export a PDF into `folder`.
 *  `c` is the canonical object from _quay1Fields_ (live-name keys). */
function genQuay1Contract_(folder, c) {
  var company = CFG.COMPANY.quay1;
  var docName = company.name + ' Agreement - ' + (String(c.full_name || 'Candidate').trim());
  var copyId = DriveApp.getFileById(quay1TemplateFor_(c.deal_type, c.activity)).makeCopy(docName, folder).getId();
  var doc = DocumentApp.openById(copyId);
  var b = doc.getBody();

  b.replaceText('\\{\\{FULL_NAME\\}\\}', String(c.full_name || ''));
  b.replaceText('\\{\\{ID_NUMBER\\}\\}', String(c.id_number || ''));
  b.replaceText('\\{\\{START_DATE\\}\\}', fmtDate_(c.start_date));
  b.replaceText('\\{\\{SENIOR_BROKER\\}\\}', String(c.senior_broker || ''));
  b.replaceText('\\{\\{COMMISSION\\}\\}', String(c.commission || ''));
  // {{BROKER_ACTIVITY}} takes the full clause DEFINITION for the chosen activity code, not the
  // code itself. Falls back to the raw value so a free-text/legacy activity still renders.
  b.replaceText('\\{\\{BROKER_ACTIVITY\\}\\}', brokerActivityDef_(c.activity) || String(c.activity || ''));
  doc.saveAndClose();

  var pdfBlob = DriveApp.getFileById(copyId).getAs('application/pdf');
  var pdfFile = folder.createFile(pdfBlob).setName(docName + '.pdf');
  return { docId: copyId, url: DriveApp.getFileById(copyId).getUrl(), pdfUrl: pdfFile.getUrl(), pdfFile: pdfFile };
}

/** Sale vs Rental template id. The UI `deal_type` (sale|rental) is the EXPLICIT override; when it
 *  is absent we derive it from the broker-activity code (rent_res_* -> Rental, sell_res_* -> Sale;
 *  any legacy value mentioning "rent" -> Rental). Everything else defaults to Sale. */
function quay1TemplateFor_(dealType, activity) {
  var dt = String(dealType || '').trim().toLowerCase();
  var isRental = dt ? (dt === 'rental' || dt === 'rent') : /^rent_|(?:^|\W)rent/i.test(String(activity || ''));
  var key = isRental ? PROP.QUAY1_TEMPLATE_RENTAL : PROP.QUAY1_TEMPLATE_SALE;
  return optProp_(key) || prop_(PROP.QUAY1_TEMPLATE_SALE, true);
}

/** Broker-activity clause definition for a code (CFG.BROKER_ACTIVITIES); '' if unknown/empty. */
function brokerActivityDef_(code) {
  var c = String(code || '').trim();
  if (!c) return '';
  var hit = (CFG.BROKER_ACTIVITIES || []).filter(function (a) { return a.code === c; })[0];
  return hit ? hit.def : '';
}

/** Human label for a broker-activity code (for the tracker); '' if unknown/empty. */
function brokerActivityLabel_(code) {
  var c = String(code || '').trim();
  if (!c) return '';
  var hit = (CFG.BROKER_ACTIVITIES || []).filter(function (a) { return a.code === c; })[0];
  return hit ? hit.label : '';
}

/**
 * Editor one-off: turn the two new IGCISA agreement Google Docs (Sale + Rental, in the Contracts
 * folder) into fill-in templates by inserting the merge tokens genQuay1Contract_ expects, then point
 * the Sale/Rental template Script Properties at them. Verifies each token actually landed and reports
 * anything MISSING (a missed token would leave a hardcoded value in every generated contract, so check
 * the log). {{BROKER_ACTIVITY}} is intentionally NOT inserted - the Sale/Rental split already carries
 * the right activity clause; the token just no-ops. Run once, then confirm with a test contract.
 */
function installNewContractTemplates() {
  var SALE = '1_zlJd5RvrihhjjXLv7imcS6cI-l4DLNH9BYhjMezZEc';
  var RENTAL = '18NnUzMO2btImBcUpcTKW9_Hmb4gLeNSrD8VPV-7K1Nc';
  var report = [];
  var esc = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var tokenize = function (label, docId, seniorName, effectiveDate, commissionPct) {
    var doc = DocumentApp.openById(docId);
    var b = doc.getBody();
    b.replaceText('Name:\\s*_+', 'Name:  {{FULL_NAME}}');
    b.replaceText('ID\\s+_{5,}', 'ID {{ID_NUMBER}}');
    b.replaceText(esc(effectiveDate), '{{START_DATE}}');
    b.replaceText('account of ' + esc(seniorName), 'account of {{SENIOR_BROKER}}');
    b.replaceText('entitled to ' + esc(commissionPct) + '%', 'entitled to {{COMMISSION}}%');
    var missing = ['FULL_NAME', 'ID_NUMBER', 'START_DATE', 'SENIOR_BROKER', 'COMMISSION'].filter(function (t) {
      return !b.findText('\\{\\{' + t + '\\}\\}');
    });
    doc.saveAndClose();
    report.push(label + ': ' + (missing.length ? 'MISSING -> ' + missing.join(', ') : 'all 5 tokens placed'));
  };
  tokenize('Sale', SALE, 'Justin Nortier', '21 March 2026', '25');
  tokenize('Rental', RENTAL, 'Daniel Wentzel', '18 February 2026', '80');
  _scriptProps_().setProperty(PROP.QUAY1_TEMPLATE_SALE, SALE);
  _scriptProps_().setProperty(PROP.QUAY1_TEMPLATE_RENTAL, RENTAL);
  report.push('QUAY1_TEMPLATE_SALE -> ' + SALE, 'QUAY1_TEMPLATE_RENTAL -> ' + RENTAL);
  Logger.log(report.join('\n'));
  return report.join(' | ');
}

/**
 * Editor one-off: generate a Sale AND a Rental sample contract from the new templates into a throwaway
 * Drive folder, so you can eyeball the merged result before it goes live. Logs the folder + both doc
 * URLs. Delete the "Contract token test" folder afterwards. Run after installNewContractTemplates().
 */
function testGenerateNewContracts() {
  var folder = DriveApp.createFolder('Contract token test');
  var sale = genQuay1Contract_(folder, {
    full_name: 'Test Candidate', id_number: '9001015800089', start_date: '2026-04-01',
    senior_broker: 'Jane Senior', commission: '30', deal_type: 'sale', activity: 'sell_res_broker'
  });
  var rental = genQuay1Contract_(folder, {
    full_name: 'Test Candidate', id_number: '9001015800089', start_date: '2026-04-01',
    senior_broker: 'Jane Senior', commission: '75', deal_type: 'rental', activity: 'rent_res_broker'
  });
  var out = 'Test folder: ' + folder.getUrl() + '\nSale doc: ' + sale.url + '\nRental doc: ' + rental.url;
  Logger.log(out);
  return out;
}

/** Save any base64 files the candidate submitted at contract-gen time into the folder. */
function _saveUploadedFiles_(folder, files) {
  (files || []).forEach(function (fl) {
    if (!fl || !fl.dataBase64) return;
    try {
      var blob = Utilities.newBlob(
        Utilities.base64Decode(fl.dataBase64),
        fl.mimeType || 'application/octet-stream',
        fl.name || ('upload-' + nowIso_()));
      folder.createFile(blob);
    } catch (err) {
      logAudit_('quay1_file_save_failed', { name: fl && fl.name, error: String(err) });
    }
  });
}
