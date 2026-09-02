/**
 * Onboarding_Aqua.js - Aqua Promotions contractor onboarding. Generates the Memorandum of
 * Agreement (MOA) via the monthly | fixed | permanent template selector, creates the folder,
 * writes the Onboarding row (entity=aqua), emails the contractor, and triggers provisioning.
 *
 * Owner: backend. MOA engine ported from the live Aqua Apps Script (aqua-contracts Code.js,
 * RESEARCH 2.5). Template + folder ids come from Script Properties (set via setupAqua*), never
 * hardcoded. The reusable clause engine is preserved so the three type templates behave
 * identically whether or not each carries the {{term_clause}} marker.
 *
 * Fields consumed (SPEC 3.1 / RESEARCH 2.5): name, id_number, email, contact, start_date,
 * requester_name, requester_email, designation, agreement_type(monthly|fixed|permanent),
 * work_hours, remuneration, end_date/probation_months/retirement_age (type extras),
 * programs(JSON), systems (optional explicit list). requester_* FORCE-OVERRIDDEN from ctx.
 *
 * Public surface:
 *   onboardAqua_(body, ctx)      - {ok, folderId, folderUrl, pdfUrl}   full flow. requireOnboarder_ (super/admin/broker).
 *   genAquaMoa_(folder, data)    - {docId, url, pdfUrl, pdfFile}  select template, fill, PDF.
 *   aquaTemplateFor_(agreementType) - String templateId  monthly|fixed|permanent (props).
 */

function onboardAqua_(body, ctx) {
  requireOnboarder_(ctx);
  var f = (body && body.fields) || body || {};
  var name = String(f.name || f.full_name || '').trim();
  var id = String(f.id_number || '').trim();
  if (!name || !id) return { ok: false, error: 'name and id_number are required' };
  // Guard the ID field against a mis-entered name (see onboardQuay1_): a 13-digit SA ID or an
  // alphanumeric passport both contain a digit; a pure word does not. Reject a 13-digit bad checksum.
  var idClean = id.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]+$/.test(idClean) || !/\d/.test(idClean)) {
    return { ok: false, error: 'ID/passport number "' + id + '" looks like a name, not an ID. ' +
      'Enter a 13-digit SA ID or a passport number (letters and digits, no spaces).' };
  }
  if (/^\d{13}$/.test(idClean) && !saIdChecksumOk_(idClean)) {
    return { ok: false, error: 'That 13-digit SA ID fails its checksum - please re-check the number.' };
  }
  id = idClean; f.id_number = idClean;   // normalise both: `id` writes the row, f.id_number fills the doc
  if (!isEmail_(f.email)) return { ok: false, error: 'a valid contractor email is required' };
  var typeErr = _aquaValidateType_(f);
  if (typeErr) return { ok: false, error: typeErr };

  var folder = _entityFolder_(prop_(PROP.AQUA_PARENT_FOLDER, true), name, id);

  // Force requester identity from the verified caller (client value is UX only).
  var requesterEmail = (ctx && ctx.email) || '';
  var requesterName = (ctx && ctx.name) || '';

  // Write the tracker row FIRST so a fresh onboard ALWAYS leaves a visible row, even if MOA generation
  // later throws. Status starts 'Contract pending' and advances to 'Contract sent' once the PDF is in hand.
  upsertOnboardingRow_({
    folderId: folder.getId(), entity: 'aqua', name: name, id_number: id,
    email: f.email || '', contact: f.contact || '', start_date: fmtDate_(f.start_date),
    requester_name: requesterName, requester_email: requesterEmail,
    designation: f.designation || '', agreement_type: _aquaTypeLabel_(f),
    work_hours: _workHours_(f.work_hours), remuneration: fmtRemuneration_(f.remuneration),
    programs: f.programs || [],
    nationality: String(f.nationality || '').trim(), status: 'Contract pending',
  });

  // Generate the MOA + resolve provisioning systems (deferred; nothing created now). If this throws,
  // the row above still stands - mark it 'Contract error' and return the error.
  var gen, systems;
  try {
    gen = genAquaMoa_(folder, f);
    systems = resolveSystems_('aqua', f.programs, _provisionList_(body, f), f.team);
  } catch (err) {
    try { setOnboardingStatus_(folder.getId(), 'Contract error'); } catch (e) { /* row still stands */ }
    logAudit_('aqua_contract_gen_failed', { folderId: folder.getId(), error: String(err) });
    return { ok: false, folderId: folder.getId(), folderUrl: folder.getUrl(),
      error: 'contract generation failed: ' + String(err && err.message ? err.message : err) };
  }

  // Contract is in hand: persist the resolved systems + advance the status.
  upsertOnboardingRow_({ folderId: folder.getId(), systems_json: JSON.stringify(systems), status: 'Contract sent' });

  // Mirror the new starter into the HR sheet's "New Starters (Tracking)" tab (non-fatal, DRY_RUN-safe).
  try { hrTrackingUpsert_(folder.getId()); }
  catch (err) { logAudit_('hr_tracking_failed', { folderId: folder.getId(), error: String(err) }); }

  var emailed = _emailContract_('aqua', f.email, name, folder.getId(), gen.pdfFile);

  return {
    ok: true, folderId: folder.getId(), folderUrl: folder.getUrl(), pdfUrl: gen.pdfUrl,
    emailed: emailed, provisioning_deferred: true, systems: systems,
  };
}

/** Copy the type-appropriate MOA template, fill markers, export a PDF into `folder`. */
function genAquaMoa_(folder, f) {
  var company = CFG.COMPANY.aqua;
  var docName = company.name + ' Agreement - ' + (String(f.name || f.full_name || 'Contractor').trim());
  var copyId = DriveApp.getFileById(aquaTemplateFor_(f.agreement_type)).makeCopy(docName, folder).getId();
  var doc = DocumentApp.openById(copyId);
  var b = doc.getBody();

  b.replaceText('\\{\\{full_name\\}\\}', String(f.name || f.full_name || ''));
  b.replaceText('\\{\\{id\\}\\}', String(f.id_number || ''));
  b.replaceText('\\{\\{start_date\\}\\}', fmtDate_(f.start_date));
  b.replaceText('\\{\\{remuneration\\}\\}', fmtRemuneration_(f.remuneration));
  b.replaceText('\\{\\{work_hours\\}\\}', _workHours_(f.work_hours));
  _aquaApplyTermClause_(b, f);
  doc.saveAndClose();

  var pdfBlob = DriveApp.getFileById(copyId).getAs('application/pdf');
  var pdfFile = folder.createFile(pdfBlob).setName(docName + '.pdf');
  return { docId: copyId, url: DriveApp.getFileById(copyId).getUrl(), pdfUrl: pdfFile.getUrl(), pdfFile: pdfFile };
}

/** Template id for the agreement type; falls back to the monthly template when a type-specific
 *  one is not configured, so a single-template deployment still works. */
function aquaTemplateFor_(agreementType) {
  var t = _aquaAgreementType_({ agreement_type: agreementType });
  var key = t === 'fixed' ? PROP.AQUA_TEMPLATE_FIXED
    : t === 'permanent' ? PROP.AQUA_TEMPLATE_PERMANENT : PROP.AQUA_TEMPLATE_MONTHLY;
  return optProp_(key) || prop_(PROP.AQUA_TEMPLATE_MONTHLY, true);
}

// ---------------------------------------------------------------- agreement type engine

function _aquaAgreementType_(f) {
  var t = String((f && f.agreement_type) || 'monthly').toLowerCase();
  return (t === 'fixed' || t === 'permanent') ? t : 'monthly';
}

function _aquaTypeLabel_(f) {
  var t = _aquaAgreementType_(f);
  return t === 'fixed' ? 'Fixed-term' : t === 'permanent' ? 'Permanent' : 'Month-to-month';
}

function _workHours_(v) {
  var s = String(v == null ? '' : v).trim();
  return s || CFG.DEFAULT_WORK_HOURS;
}

/** Clause 1.1 body (+ permanent extras) for the chosen type. First element replaces the
 *  {{term_clause}} marker; further elements become new paragraphs after it. */
function _aquaTermClauseParts_(f) {
  var type = _aquaAgreementType_(f);
  var start = fmtDate_(f.start_date);

  if (type === 'fixed') {
    var end = fmtDate_(f.end_date);
    var mo = _monthsBetween_(f.start_date, f.end_date);
    var moTxt = mo > 0 ? ' (' + mo + ' month' + (mo === 1 ? '' : 's') + ')' : '';
    return ['This is a fixed-term agreement. It will commence on ' + start + ' and, unless ' +
      'renewed in writing by agreement of both parties, will terminate automatically on ' + end + moTxt +
      ' without further notice. In line with Company policy the total fixed term, including any ' +
      'renewal, shall not exceed 6 (six) months. This agreement may ordinarily be renewed only once; ' +
      'a second renewal may apply only where the original term is 3 (three) months or shorter.'];
  }

  if (type === 'permanent') {
    var prob = _intOr_(f.probation_months, 3);
    var ret = _intOr_(f.retirement_age, 65);
    var probUnit = prob === 1 ? 'month' : 'months';
    return [
      'This is a permanent agreement. It will commence on ' + start + ' and will continue until ' +
        'terminated in accordance with this agreement.',
      '1.2. PROBATION: The first ' + prob + ' ' + probUnit + ' of the engagement shall ' +
        'constitute a probationary period, during which the Company will assess the Independent ' +
        "Contractor's suitability and conduct. During the probationary period either party may " +
        'terminate this agreement on shorter written notice, and the Company may extend the ' +
        'probationary period where a fair assessment reasonably requires it.',
      '1.3. RETIREMENT: The normal retirement age is ' + ret + ' years. The engagement ' +
        'will ordinarily terminate at the end of the month in which the Independent Contractor attains ' +
        'that age, unless the parties agree in writing to continue on mutually acceptable terms.',
    ];
  }

  return ['The agreement will commence on ' + start + ' and will endure for a period of 1 (one) month. ' +
    'Should the Company be satisfied with performance, this period will be extended on a month to month ' +
    'basis. No formal notice of extensions are required, however, failure of notice to extend will not ' +
    'automatically constitute an extension.'];
}

function _aquaApplyTermClause_(b, f) {
  var parts = _aquaTermClauseParts_(f);
  var range = b.findText('\\{\\{term_clause\\}\\}');
  if (!range) {
    // Type-specific template with the clause baked in: nothing to swap.
    b.replaceText('\\{\\{term_clause\\}\\}', parts[0]);
    return;
  }
  var para = range.getElement().getParent();
  var idx = b.getChildIndex(para);
  b.replaceText('\\{\\{term_clause\\}\\}', parts[0]);
  for (var i = 1; i < parts.length; i++) b.insertParagraph(idx + i, parts[i]);
}

/** Guardrails per agreement type. '' when valid, else an error message. */
function _aquaValidateType_(f) {
  var type = _aquaAgreementType_(f);
  if (type === 'fixed') {
    if (!f.end_date) return 'Fixed-term contracts need an end date.';
    var d1 = _asDate_(f.start_date), d2 = _asDate_(f.end_date);
    if (!d1 || !d2) return 'A valid start and end date are required for a fixed-term contract.';
    if (d2 <= d1) return 'The end date must be after the start date.';
    var cap = new Date(d1.getTime());
    cap.setMonth(cap.getMonth() + 6);
    if (d2 > cap) return 'A fixed-term contract may not exceed 6 months (Company policy).';
  }
  return '';
}

// ---------------------------------------------------------------- small date/number helpers

function _asDate_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s);
  return isNaN(d.getTime()) ? null : d;
}

function _monthsBetween_(a, b) {
  var d1 = _asDate_(a), d2 = _asDate_(b);
  if (!d1 || !d2) return 0;
  var m = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
  if (d2.getDate() < d1.getDate()) m -= 1;
  return m;
}

function _intOr_(v, dflt) {
  var n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
  return (isNaN(n) || n <= 0) ? dflt : n;
}

// ---------------------------------------------------------------- one-off: import legacy Aqua contractors

/**
 * EDITOR ONE-OFF (Run once): bring the three Aqua Promotions contractors who were onboarded through
 * the OLD standalone aqua-contracts script - and therefore never landed in this tool - into the
 * tracker and onto the HR sheet's "New Aqua (Automated)" tab. Data + folder ids come from their
 * existing signed MOAs (read from Drive), so folderId points at their REAL folder and the HR
 * name-link resolves to the contract on file. Idempotent: upsert is keyed on folderId and hrPromote_
 * self-guards via hr_promoted_at, so re-running is safe and never duplicates a row.
 *
 * Deliberately does NOT queue them for provisioning: they are already contracted (and may already
 * have accounts), so no approved_at is stamped and no Google account is created. Their contract is
 * marked received so the HR row shows "Agreement Received"; the other FICA ticks are left blank for
 * HR to complete. If any of them still needs a Quay/Aqua login, run them through the normal
 * approve -> provision path afterwards.
 */
function importLegacyAquaContractors() {
  var people = [
    { folderId: '16cIpM6e1gL6H4rSTH5XB9asua9Mbs6it', name: 'Zeak Klein',
      id_number: '0402130106089', start_date: '7 September 2026', remuneration: 'R11,000.00', work_hours: '08:00 to 17:00' },
    { folderId: '1kYGsDi1LwryycYcE7Qi0wLWPU7exHZ4W', name: 'Clint Philander',
      id_number: '0010175042083', start_date: '2 September 2026', remuneration: 'R8,000.00', work_hours: '08:00 to 17:00' },
    { folderId: '18rYDa4AN-f9OU-XbtHxQc5FWVpNlt857', name: 'Onchene Nnako Moila',
      id_number: '0003240073084', start_date: '27 July 2026', remuneration: 'R12,000.00', work_hours: '09:00 to 17:00' },
  ];
  var out = { hr_sync_enabled: hrSyncEnabled_(), imported: [] };
  people.forEach(function (p) {
    var res = { name: p.name };
    try {
      upsertOnboardingRow_({
        folderId: p.folderId, entity: 'aqua', name: p.name, id_number: p.id_number,
        start_date: p.start_date, agreement_type: 'Month-to-month', work_hours: p.work_hours,
        remuneration: p.remuneration, designation: 'Independent Contractor',
        // Signed MOA is on file (generated by the old Aqua script) - reflect that so the HR row
        // shows "Agreement Received". Other FICA ticks stay blank; _docsReady_ stays false, so the
        // provisioning batch will not pick these up and create accounts.
        fica_contract: 'Received (imported from Aqua script)',
        status: 'Active - imported from Aqua script',
      });
      res.tracking = hrTrackingUpsert_(p.folderId);
      res.promote = hrPromote_(p.folderId);
      res.ok = true;
    } catch (err) {
      res.ok = false; res.error = String(err && err.message ? err.message : err);
      logAudit_('aqua_import_failed', { name: p.name, folderId: p.folderId, error: res.error });
    }
    out.imported.push(res);
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
