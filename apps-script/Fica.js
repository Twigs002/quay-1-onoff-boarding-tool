/**
 * Fica.js - FICA document intake. Renders the self-service upload form (doGet ?f=<folderId>)
 * and handles uploads, ticking the per-document R..V columns on the Onboarding row as files
 * land. Token-less: the unguessable folderId (which must already exist as an Onboarding row) is
 * the credential, so this path runs BEFORE any auth (matches the live Aqua flow, RESEARCH 2.6).
 *
 * Owner: backend. The R..V tick cells + tickFica_ live in Tracker.js (single owner); this
 * module reads the doc set and calls into it. Column letters per SPEC 3.1.
 *
 * Public surface:
 *   ficaLink_(folderId)          - String   the candidate FICA link (WEBAPP_URL ?f=folderId).
 *   ficaForm_(folderId)          - HtmlOutput   the candidate upload page (branded by entity).
 *   ficaUpload_(body)            - {ok, ticked:[...]}   store files + tick R..V. Token-less.
 *   ficaStatus_(folderId)        - Object   per-doc received/missing map (for progress report).
 *
 * Never auto-emails beyond the scoped onboarding pipeline (the FICA thank-you is that pipeline).
 */

/** Upload label -> Tracker FICA doc key (S..V; R/NDA is manual). Extra labels (e.g. TAX) are
 *  stored as files but tick no column, matching the live Quay1 mapping (RESEARCH 1.5). */
var FICA_LABEL_KEY = { ID: 'id', POA: 'poa', BANK: 'bank', POB: 'bank', CONTRACT: 'contract' };

/** Server-side upload guards for the token-less FICA path (RESEARCH audit MEDIUM). The folderId
 *  is the only credential, so validate every file at the boundary before writing to Drive: accept
 *  PDFs + common phone-camera images only, cap each decoded file, and cap the count per request. */
var FICA_MAX_FILES = 12;
var FICA_MAX_BYTES = 15 * 1024 * 1024;             // 15 MB per file, checked after base64Decode.
var FICA_MIME_ALLOW = { 'application/pdf': 1, 'image/jpeg': 1, 'image/png': 1, 'image/heic': 1 };
var FICA_EXT_ALLOW = { pdf: 1, jpg: 1, jpeg: 1, png: 1, heic: 1 };

/** The candidate FICA link. Empty string when WEBAPP_URL is not yet set (pre-deploy). */
function ficaLink_(folderId) {
  var base = optProp_(PROP.WEBAPP_URL);
  return base ? (base + '?f=' + encodeURIComponent(folderId)) : '';
}

/** Store an uploaded FICA submission and tick the matching R..V columns. Token-less; gated by
 *  the folderId existing as an Onboarding row. body = { folderId, details, files:[{label, ext,
 *  mimeType, dataBase64}] }. */
function ficaUpload_(body) {
  var folderId = String((body && body.folderId) || '');
  if (!folderId) return { ok: false, error: 'missing reference' };
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'link not recognised' };

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (err) { return { ok: false, error: 'link not recognised' }; }

  var name = meta.name || 'Candidate';

  // Professional (FFC) status - self-declared; derives the PropData profile type (agent|specialist).
  var d0 = (body && body.details) || {};
  var ffcStatus = String((body && body.ffc_status) || d0['FFC status'] || '').trim().toLowerCase();
  var ffcNumber = String((body && body.ffc_number) || d0['FFC number'] || '').trim();
  if (CFG.FFC_STATUSES.indexOf(ffcStatus) < 0) return { ok: false, error: 'please select your professional (FFC) status' };
  if ((ffcStatus === 'full' || ffcStatus === 'candidate') && !ffcNumber) {
    return { ok: false, error: 'an FFC number is required for your selected status' };
  }
  var profileType = propdataProfileType_(ffcStatus);

  // Numeric-field integrity (server-side mirror of the FICA page's input filtering, so a direct POST
  // cannot smuggle words past it). Reject BEFORE writing anything. Tax + bank account are digits only;
  // ID/passport keeps letters (passports are alphanumeric) but bars spaces/free-text; NoK contact is a
  // phone. Empty values are left to the required-field checks, not flagged here.
  var num_ = function (key, label) { return String((body && body[key]) || d0[label] || '').trim(); };
  var acctVal_ = num_('account_number', 'Account number');
  var taxVal_ = num_('tax_number', 'Income tax number');
  var idVal_ = String(d0['ID/passport number'] || '').trim();
  var nokVal_ = num_('nok_contact', 'Next of kin contact');
  if (acctVal_ && !/^[0-9]+$/.test(acctVal_.replace(/\s/g, ''))) return { ok: false, error: 'Bank account number must be digits only (no letters or words).' };
  if (taxVal_ && !/^[0-9]+$/.test(taxVal_.replace(/\s/g, ''))) return { ok: false, error: 'Income tax number must be digits only (no letters or words).' };
  if (idVal_ && !/^[A-Za-z0-9]+$/.test(idVal_)) return { ok: false, error: 'ID or passport number must contain only letters and numbers, with no spaces or words.' };
  if (nokVal_ && /[A-Za-z]/.test(nokVal_)) return { ok: false, error: 'Next of kin contact number must be a phone number, not text.' };

  var ficaFolder = _ficaSubfolder_(folder);

  var files = ((body && body.files) || []).filter(function (x) { return x && x.dataBase64; });
  if (!files.length) return { ok: false, error: 'no documents attached' };
  if (files.length > FICA_MAX_FILES) {
    return { ok: false, error: 'too many files attached - please submit at most ' + FICA_MAX_FILES + '.' };
  }

  // Boundary validation pass: allow-list type + cap size BEFORE any write, so a rejected
  // submission stores nothing. The browser sends a generic/empty mimeType for some phone
  // photos (notably iOS HEIC), so the extension is the primary gate and a generic mimeType is
  // tolerated; a mimeType outside the allow-list that is not the generic fallback is rejected.
  var prepared = [];
  for (var i = 0; i < files.length; i++) {
    var fl = files[i];
    var label = String(fl.label || 'DOC').toUpperCase();
    var ext = String(fl.ext || 'dat').toLowerCase();
    var mime = String(fl.mimeType || 'application/octet-stream').toLowerCase();
    var mimeOk = !!FICA_MIME_ALLOW[mime] || mime === 'application/octet-stream' || mime === '';
    if (!FICA_EXT_ALLOW[ext] || !mimeOk) {
      return { ok: false, error: 'unsupported file type for ' + label +
        ' - please upload a PDF or a photo (JPG, PNG or HEIC).' };
    }
    var bytes;
    try { bytes = Utilities.base64Decode(fl.dataBase64); }
    catch (err) { return { ok: false, error: 'could not read the ' + label + ' file - please re-upload it.' }; }
    if (bytes.length > FICA_MAX_BYTES) {
      return { ok: false, error: label + ' is too large (max ' +
        Math.round(FICA_MAX_BYTES / (1024 * 1024)) + ' MB) - please upload a smaller file.' };
    }
    prepared.push({ label: label, ext: ext, mime: mime, bytes: bytes });
  }

  // Right-to-work gate: a candidate whose ID is not a 13-digit SA ID must attach a work permit.
  var hasPermit = prepared.some(function (p) { return p.label === 'PERMIT'; });
  if (!isSaId_(meta.id_number) && !hasPermit) {
    return { ok: false, error: 'a work permit document is required (your ID is not a 13-digit South African ID).' };
  }

  var ticked = [];
  var photoFileId = '';
  prepared.forEach(function (p) {
    try {
      var blob = Utilities.newBlob(p.bytes, p.mime, p.label + ' - ' + name + '.' + p.ext);
      var file = ficaFolder.createFile(blob);
      if (p.label === 'PHOTO') photoFileId = file.getId();   // the branded profile photo source
      var key = FICA_LABEL_KEY[p.label];
      if (key) { tickFica_(folderId, key); ticked.push(key); }
    } catch (err) {
      logAudit_('fica_file_failed', { folderId: folderId, label: p.label, error: String(err) });
    }
  });

  // Persist the typed details alongside the files.
  var d = (body && body.details) || {};
  var lines = Object.keys(d).map(function (k) { return k + ': ' + d[k]; });
  ficaFolder.createFile('FICA details - ' + name + '.txt',
    'FICA submission for ' + name + '\nReceived: ' + nowIso_() + '\n\n' + lines.join('\n'), 'text/plain');

  // HR Information Sheet fields the candidate supplies here. Read the top-level machine key, falling
  // back to the human-readable detail label. Birthday auto-derives from a 13-digit SA ID when blank.
  var pick = function (key, label) { return String((body && body[key]) || d[label] || '').trim(); };
  var birthday = pick('birthday', 'Birthday') || saIdBirthday_(meta.id_number);

  // Persist FFC status/number, the derived PropData profile type, and the HR fields onto the row.
  upsertOnboardingRow_({
    folderId: folderId, ffc_status: ffcStatus, ffc_number: ffcNumber, propdata_profile_type: profileType,
    birthday: birthday,
    bank_name: pick('bank_name', 'Bank'),
    account_number: pick('account_number', 'Account number'),
    account_type: pick('account_type', 'Account type'),
    tax_number: pick('tax_number', 'Income tax number'),
    residential_address: pick('home_address', 'Residential address'),
    work_permit_expiry: pick('work_permit_expiry', 'Work permit expiry'),
    work_permit_received: hasPermit ? ('Received ' + nowIso_()) : '',
    nok_name: pick('nok_name', 'Next of kin name'),
    nok_contact: pick('nok_contact', 'Next of kin contact'),
    nok_relationship: pick('nok_relationship', 'Next of kin relationship'),
    nok_email: pick('nok_email', 'Next of kin email'),
    photo_file_id: photoFileId,
  });

  setOnboardingStatus_(folderId, 'FICA received');

  // Mirror to HR: refresh the tracking row, then promote (append-only, once) into the entity
  // destination tab now that FICA is complete. Non-fatal + DRY_RUN-safe.
  try { hrTrackingUpsert_(folderId); hrPromote_(folderId); }
  catch (err) { logAudit_('hr_sync_failed', { folderId: folderId, error: String(err) }); }

  if (isEmail_(meta.email)) {
    var company = CFG.COMPANY[meta.entity] || CFG.COMPANY.quay1;
    try {
      GmailApp.sendEmail(meta.email, company.name + ' - documents received, we are checking them - ' + name,
        'Hi ' + firstName_(name) + ',\n\nThank you for submitting your documents to ' +
        company.name + '. Our admin team is now checking them. Please look out for another ' +
        'email shortly confirming your induction day.\n\n' +
        'Warm regards,\nThe ' + company.name + ' Team', {
          bcc: ccEnabled_() ? CFG.ALWAYS_CC.filter(function (x) { return x; }).join(',') : undefined,
          name: company.name, htmlBody: ficaThankYouHtml_(company, firstName_(name)),
        });
    } catch (err) { logAudit_('fica_thankyou_failed', { folderId: folderId, error: String(err) }); }
  }

  return { ok: true, ticked: ticked };
}

/** Per-doc received/missing map for the progress report (mirrors the live `progress` flags:
 *  bank=bankConf, poa, id=idRcv, contract=agreement, plus the manual nda). */
function ficaStatus_(folderId) {
  var o = readOnboardingByFolder_(folderId) || {};
  return {
    nda: !!o.fica_nda, bank: !!o.fica_bank, poa: !!o.fica_poa,
    id: !!o.fica_id, contract: !!o.fica_contract,
  };
}

function _ficaSubfolder_(folder) {
  var it = folder.getFoldersByName('FICA documents');
  return it.hasNext() ? it.next() : folder.createFolder('FICA documents');
}

// ---------------------------------------------------------------- candidate form page

/** Serve the branded FICA upload page. folderId + this /exec are baked in server-side. */
function ficaForm_(folderId) {
  var meta = readOnboardingByFolder_(folderId);
  var name = meta ? htmlEsc_(meta.name) : '';
  var known = !!meta;
  var company = CFG.COMPANY[(meta && meta.entity)] || CFG.COMPANY.quay1;
  var companyName = htmlEsc_(company.name);
  var endpoint = optProp_(PROP.WEBAPP_URL);
  var B = CFG.BRAND;

  var badLink = known ? '' :
    '<div class="note err show">This link is not recognised. Please use the personal link from your ' +
    companyName + ' agreement email, or reply to that email for help.</div>';

  var html =
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>' + companyName + ' FICA documents</title><style>' +
':root{--navy:' + B.navy + ';--navy-d:' + B.navyDark + ';--ink:' + B.ink + ';--slate:' + B.slate + ';--muted:#7A8296;' +
'--paper:' + B.paper + ';--card:#fff;--card2:#F4F7FC;--line:#D5E0F2;--r:12px;--r-sm:8px;' +
'--sans:Montserrat,system-ui,-apple-system,Arial,sans-serif;--gold:' + B.gold + ';--gold-ink:' + B.goldInk + ';' +
'--green:' + B.green + ';--green-t:' + B.greenT + ';--green-b:' + B.greenB + ';--red:' + B.red + ';--red-t:#FDECEA;--amber:' + B.amber + ';--amber-t:' + B.amberT + ';}' +
'*{box-sizing:border-box}body{margin:0;font-family:var(--sans);background:var(--paper);color:var(--ink);line-height:1.55}' +
'.wrap{max-width:640px;margin:0 auto;padding:26px 18px 60px}' +
'.hero{background:var(--navy);color:#fff;border-radius:var(--r);padding:26px 24px;margin:14px 0 20px}' +
'.hero h1{margin:0 0 6px;font-size:21px;font-weight:800;text-transform:uppercase;letter-spacing:.4px}' +
'.hero p{margin:0;font-size:14.5px;color:#D9E4F5}' +
'.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;margin-bottom:16px}' +
'.sec{font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--navy);margin:0 0 12px}' +
'label{display:block;font-size:13px;font-weight:600;color:var(--slate);margin:0 0 5px}.req{color:var(--red)}' +
'input[type=text],input[type=date],textarea,select{width:100%;font-family:inherit;font-size:15px;color:var(--ink);background:var(--card2);' +
'border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 13px;outline:none}' +
'input:focus,textarea:focus,select:focus{border-color:var(--navy);box-shadow:0 0 0 3px rgba(61,91,166,.22);background:#fff}' +
'textarea{resize:vertical;min-height:70px}.row{margin-bottom:14px}.filewrap{margin-top:10px}' +
'input[type=file]{width:100%;font-size:13px;color:var(--slate);background:#EAF0FB;' +
'border:1px dashed var(--navy);border-radius:var(--r-sm);padding:12px;cursor:pointer}' +
'input[type=file]::file-selector-button{font-family:inherit;font-weight:600;font-size:12.5px;color:#fff;' +
'background:var(--navy);border:0;border-radius:6px;padding:7px 13px;margin-right:12px;cursor:pointer}' +
'.hint{font-size:12px;color:var(--muted);margin-top:5px}' +
'.radios{display:flex;flex-direction:column;gap:9px;margin-top:2px}' +
'.radio{display:flex;align-items:flex-start;gap:10px;font-size:14px;font-weight:500;color:var(--ink);cursor:pointer;' +
'background:var(--card2);border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 13px}' +
'.radio input{width:auto;margin:2px 0 0;accent-color:var(--navy);flex:none}' +
'.radio:hover{border-color:var(--navy)}' +
'.btn{width:100%;font-family:inherit;font-size:15px;font-weight:700;color:var(--gold-ink);background:var(--gold);' +
'border:0;border-radius:var(--r-sm);padding:14px 18px;cursor:pointer}.btn:disabled{opacity:.6;cursor:not-allowed}' +
'.note{margin-top:14px;font-size:14px;padding:12px 14px;border-radius:var(--r-sm);display:none}' +
'.note.show{display:block}.note.ok{background:var(--green-t);color:var(--green);border:1px solid var(--green-b)}' +
'.note.err{background:var(--red-t);color:var(--red);border:1px solid #F5C6C0}' +
'.note.info{background:var(--amber-t);color:var(--amber);border:1px solid #F5E3B3}' +
'.foot{text-align:center;font-size:12px;color:var(--muted);margin-top:24px}' +
// Desktop keeps the comfortable centred column; phones get tighter padding + larger tap targets.
'@media (max-width:520px){.wrap{padding:16px 12px 44px}.hero{padding:20px 17px}.hero h1{font-size:18px}' +
'.card{padding:16px 15px}.btn{padding:15px 18px}.radio{padding:12px 13px}' +
'input[type=text],textarea{font-size:16px}}' + // 16px avoids iOS zoom-on-focus
'@media (min-width:900px){.wrap{max-width:680px}}' +
'</style></head><body><div class="wrap">' +
'<div class="hero"><h1>' + companyName + '</h1>' +
'<p>' + (name ? ('Hi ' + name + '. ') : '') + 'Please submit your FICA documents below. It only takes a minute.</p></div>' +
badLink +
'<form id="ficaForm" novalidate>' +
'<div class="card"><p class="sec">1 - Signed agreement</p>' +
'<div class="filewrap"><label for="f_contract">Your signed ' + companyName + ' agreement <span class="req">*</span></label>' +
'<input type="file" id="f_contract" accept="image/*,application/pdf" required>' +
'<p class="hint">Upload the agreement you received by email, signed. We create your accounts once this and your FICA documents are in.</p></div></div>' +
'<div class="card"><p class="sec">2 - Identity</p>' +
'<div class="row"><label for="id_number">ID or passport number <span class="req">*</span></label>' +
'<input type="text" id="id_number" inputmode="text" autocomplete="off" required>' +
'<p class="hint">South African ID: 13 digits. Passport: letters and numbers only, no spaces.</p></div>' +
'<div class="filewrap"><label for="f_id">Certified copy of your ID or passport <span class="req">*</span></label>' +
'<input type="file" id="f_id" accept="image/*,application/pdf" required></div>' +
// Work permit block - revealed only when the ID entered is not a 13-digit South African ID.
'<div id="permitBlock" style="display:none">' +
'<div class="row" style="margin-top:14px"><label for="work_permit_expiry">Work permit expiry date <span class="req">*</span></label>' +
'<input type="date" id="work_permit_expiry"></div>' +
'<div class="filewrap"><label for="f_permit">Work permit / right-to-work document <span class="req">*</span></label>' +
'<input type="file" id="f_permit" accept="image/*,application/pdf">' +
'<p class="hint">Required because your ID is not a 13-digit South African ID. This confirms you are legally allowed to work with us.</p></div></div></div>' +
// Date of birth - hidden for a 13-digit SA ID (derived from the ID server-side, saIdBirthday_);
// shown + required only for a non-SA ID (passport). Toggled by permitState() with the permit block.
'<div class="card" id="dobBlock" style="display:none"><p class="sec">3 - Date of birth</p>' +
'<div class="row"><label for="birthday">Date of birth <span class="req">*</span></label>' +
'<input type="date" id="birthday">' +
'<p class="hint">Required because your ID is not a 13-digit South African ID. For South African IDs we read your date of birth from the ID automatically.</p></div></div>' +
'<div class="card"><p class="sec">4 - Proof of address</p>' +
'<div class="row"><label for="home_address">Residential address <span class="req">*</span></label>' +
'<textarea id="home_address" placeholder="Street, suburb, city, postal code" required></textarea></div>' +
'<div class="filewrap"><label for="f_addr">Proof of address <span class="req">*</span></label>' +
'<input type="file" id="f_addr" accept="image/*,application/pdf" required>' +
'<p class="hint">A utility bill, bank statement or lease dated within the last 3 months.</p></div></div>' +
'<div class="card"><p class="sec">5 - Bank details</p>' +
'<div class="row"><label for="bank_name">Bank <span class="req">*</span></label>' +
'<input type="text" id="bank_name" autocomplete="off" required></div>' +
'<div class="row"><label for="account_number">Account number <span class="req">*</span></label>' +
'<input type="text" id="account_number" inputmode="numeric" autocomplete="off" required>' +
'<p class="hint">Digits only.</p></div>' +
'<div class="row"><label for="account_type">Type of account <span class="req">*</span></label>' +
'<select id="account_type" required><option value="">Select...</option>' +
'<option value="Cheque">Cheque</option><option value="Savings">Savings</option>' +
'<option value="Transmission">Transmission</option><option value="Other">Other</option></select></div>' +
'<div class="filewrap"><label for="f_bank">Bank confirmation letter or statement <span class="req">*</span></label>' +
'<input type="file" id="f_bank" accept="image/*,application/pdf" required></div></div>' +
'<div class="card"><p class="sec">6 - Tax</p>' +
'<div class="row"><label for="tax_number">Income tax number <span class="req">*</span></label>' +
'<input type="text" id="tax_number" inputmode="numeric" autocomplete="off" required>' +
'<p class="hint">Digits only.</p></div>' +
'<div class="filewrap"><label for="f_tax">SARS / tax number proof (optional)</label>' +
'<input type="file" id="f_tax" accept="image/*,application/pdf"></div></div>' +
'<div class="card"><p class="sec">7 - Professional status</p>' +
'<div class="row"><label>Your FFC (Fidelity Fund Certificate) status <span class="req">*</span></label>' +
'<div class="radios">' +
'<label class="radio"><input type="radio" name="ffc_status" value="full" required><span>Full status &ndash; I hold a valid FFC</span></label>' +
'<label class="radio"><input type="radio" name="ffc_status" value="candidate"><span>Candidate practitioner &ndash; working towards my FFC</span></label>' +
'<label class="radio"><input type="radio" name="ffc_status" value="none"><span>No status &ndash; I do not hold an FFC</span></label>' +
'</div></div>' +
'<div class="row" id="ffcNumRow"><label for="ffc_number">FFC number <span class="req" id="ffcNumReq">*</span></label>' +
'<input type="text" id="ffc_number" autocomplete="off">' +
'<p class="hint">Your Fidelity Fund Certificate number from the PPRA.</p></div>' +
'<div class="filewrap" id="photoRow"><label for="f_photo">Headshot photo (optional)</label>' +
'<input type="file" id="f_photo" accept="image/*">' +
'<p class="hint">Submit a clear head-and-shoulders headshot to receive your email signature and get your online profile up faster. Optional, but recommended.</p></div></div>' +
'<div class="card"><p class="sec">8 - Next of kin</p>' +
'<div class="row"><label for="nok_name">Next of kin name <span class="req">*</span></label>' +
'<input type="text" id="nok_name" autocomplete="off" required></div>' +
'<div class="row"><label for="nok_contact">Next of kin contact number <span class="req">*</span></label>' +
'<input type="text" id="nok_contact" inputmode="tel" autocomplete="off" required></div>' +
'<div class="row"><label for="nok_relationship">Relationship <span class="req">*</span></label>' +
'<input type="text" id="nok_relationship" autocomplete="off" required></div>' +
'<div class="row"><label for="nok_email">Next of kin email</label>' +
'<input type="text" id="nok_email" inputmode="email" autocomplete="off"></div></div>' +
'<button type="submit" class="btn" id="submitBtn">Submit my FICA documents</button>' +
'<div id="note" class="note"></div></form>' +
'<p class="foot">' + companyName + ' - your documents are stored securely and used only for FICA compliance.</p>' +
'</div><script>' +
'var ENDPOINT=' + JSON.stringify(endpoint) + ';var FOLDER_ID=' + JSON.stringify(folderId) + ';' +
'var KNOWN=' + (known ? 'true' : 'false') + ';' +
'var form=document.getElementById("ficaForm"),note=document.getElementById("note"),btn=document.getElementById("submitBtn");' +
'if(!KNOWN&&btn){btn.disabled=true;}' +
'function showNote(c,m){note.className="note show "+c;note.textContent=m;}' +
'function val(id){var e=document.getElementById(id);return e?e.value.trim():"";}' +
'function b64(file){return new Promise(function(res,rej){var r=new FileReader();' +
'r.onload=function(){res(String(r.result).split(",")[1]);};r.onerror=rej;r.readAsDataURL(file);});}' +
'var MAP=[["f_contract","CONTRACT"],["f_id","ID"],["f_addr","POA"],["f_bank","BANK"],["f_tax","TAX"],["f_photo","PHOTO"],["f_permit","PERMIT"]];' +
'var ffcRadios=document.getElementsByName("ffc_status");' +
'var ffcNumEl=document.getElementById("ffc_number"),ffcNumReq=document.getElementById("ffcNumReq");' +
'function ffcVal(){for(var k=0;k<ffcRadios.length;k++){if(ffcRadios[k].checked)return ffcRadios[k].value;}return "";}' +
'function ffcState(){var v=ffcVal();var needNum=(v==="full"||v==="candidate");' +
'ffcNumEl.required=needNum;if(ffcNumReq)ffcNumReq.style.display=needNum?"":"none";}' +
'for(var k=0;k<ffcRadios.length;k++){ffcRadios[k].addEventListener("change",ffcState);}ffcState();' +
// Reveal + require the work-permit block only when the ID entered is not a 13-digit SA ID.
'var idEl=document.getElementById("id_number");' +
'var permitBlock=document.getElementById("permitBlock");' +
'var permitFile=document.getElementById("f_permit"),permitExp=document.getElementById("work_permit_expiry");' +
'var dobBlock=document.getElementById("dobBlock"),dobEl=document.getElementById("birthday");' +
'function isSaId(v){return /^\\d{13}$/.test(String(v||"").trim());}' +
'function permitState(){var need=!isSaId(val("id_number"));if(permitBlock)permitBlock.style.display=need?"":"none";' +
'if(permitFile)permitFile.required=need;if(permitExp)permitExp.required=need;' +
'if(dobBlock)dobBlock.style.display=need?"":"none";if(dobEl){dobEl.required=need;if(!need)dobEl.value="";}}' +
'if(idEl){idEl.addEventListener("input",permitState);}permitState();' +
// Numeric-field integrity: fields that must be numbers reject words/letters as the user types, so a
// value like "Dont have" or "Will revert" can never be submitted. ID/passport keeps letters (passports
// are alphanumeric) but drops spaces/punctuation; NoK contact stays a phone (digits + phone symbols).
'function keepRe(el,re){if(!el)return;el.addEventListener("input",function(){var s=el.value.replace(re,"");if(s!==el.value)el.value=s;});}' +
'keepRe(document.getElementById("tax_number"),/[^0-9]/g);' +
'keepRe(document.getElementById("account_number"),/[^0-9]/g);' +
'keepRe(document.getElementById("id_number"),/[^A-Za-z0-9]/g);' +
'keepRe(document.getElementById("nok_contact"),/[^0-9+()\\s-]/g);' +
'form.addEventListener("submit",function(e){e.preventDefault();if(!KNOWN)return;' +
'if(!form.checkValidity()){form.reportValidity();return;}' +
'btn.disabled=true;showNote("info","Uploading your documents, please hold on...");' +
'var details={"ID/passport number":val("id_number"),"Birthday":val("birthday"),"Residential address":val("home_address"),"Bank":val("bank_name"),"Account number":val("account_number"),"Account type":val("account_type"),"Income tax number":val("tax_number"),"Work permit expiry":val("work_permit_expiry"),"FFC status":ffcVal(),"FFC number":val("ffc_number"),"Next of kin name":val("nok_name"),"Next of kin contact":val("nok_contact"),"Next of kin relationship":val("nok_relationship"),"Next of kin email":val("nok_email")};' +
'var jobs=MAP.map(function(m){var i=document.getElementById(m[0]);var f=i&&i.files&&i.files[0];' +
'if(!f)return Promise.resolve(null);return b64(f).then(function(x){' +
'var ext=(f.name.split(".").pop()||"dat").toLowerCase();' +
'return{label:m[1],ext:ext,mimeType:f.type||"application/octet-stream",dataBase64:x};});});' +
'Promise.all(jobs).then(function(files){files=files.filter(Boolean);' +
'return fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},' +
'body:JSON.stringify({kind:"fica_upload",folderId:FOLDER_ID,details:details,ffc_status:ffcVal(),ffc_number:val("ffc_number"),' +
'birthday:val("birthday"),bank_name:val("bank_name"),account_number:val("account_number"),account_type:val("account_type"),' +
'tax_number:val("tax_number"),home_address:val("home_address"),work_permit_expiry:val("work_permit_expiry"),' +
'nok_name:val("nok_name"),nok_contact:val("nok_contact"),nok_relationship:val("nok_relationship"),nok_email:val("nok_email"),' +
'files:files})});})' +
'.then(function(r){return r.json();}).then(function(d){' +
'if(d&&d.ok){form.style.display="none";showNote("ok","Thank you! Your FICA documents have been received.");}' +
'else{showNote("err","Something went wrong: "+((d&&d.error)||"unknown")+".");btn.disabled=false;}})' +
'.catch(function(err){showNote("err","Upload failed: "+err+".");btn.disabled=false;});' +
'});' +
'<\/script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle(company.name + ' FICA documents')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
