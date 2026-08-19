/**
 * Induction.js - Quay 1 induction booking, the per-candidate progress report, and the Tuesday
 * digest. Quay 1 only (Aqua has no induction step).
 *
 * Owner: backend. induction_wed / induction_thu columns live on the Onboarding row (Tracker.js).
 *
 * bookInduction_ is TOKEN-LESS (candidate-facing, folderId-gated) per the router dispatch table
 * and the live Quay1 induction.html flow (RESEARCH 1.1). It does not require an admin role; the
 * unguessable folderId is the credential.
 *
 * Public surface:
 *   bookInduction_(body)         - {ok, wed, thu}   set induction dates + email the packet.
 *   inductionLookup_(folderId)   - {ok, firstName, booked, induction}   doGet ?i= support.
 *   inductionLink_(folderId)     - String   the candidate booking link (WEBAPP_URL ?i=folderId).
 *   inductionPageHtml_(folderId) - String   the candidate booking page (branded by entity).
 *   progressReport_(folderId)    - {ok, html}   per-candidate onboarding progress summary.
 *   tuesdayDigest_()             - void   TIME-TRIGGER target. Auto-send permitted (scoped).
 *
 * The temp password from provisioning is included ONLY in the induction email packet (email,
 * never WhatsApp) per SPEC section 4 - surfaced by whoever composes that packet, not here.
 */

/** Book the induction week. body = { folderId, weekMonday:'YYYY-MM-DD' }. Token-less. */
function bookInduction_(body) {
  var folderId = String((body && body.folderId) || '');
  if (!folderId) return { ok: false, error: 'missing reference' };
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'not_found' };

  var monday = _asDate_(body && body.weekMonday);
  if (!monday) return { ok: false, error: 'a valid weekMonday (YYYY-MM-DD) is required' };

  // Enforce the Tuesday 14:00 cut-off server-side (the page hides closed weeks, but the folderId is
  // the only credential, so a stale/replayed week must be rejected here too). Compare by date only.
  var earliest = _earliestBookableMonday_();
  var pickedMon = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  if (pickedMon.getTime() < earliest.getTime()) {
    return { ok: false, error: 'That induction week has closed. Please pick one of the available weeks.' };
  }

  var wed = _isoDate_(_addDays_(monday, 2));
  var thu = _isoDate_(_addDays_(monday, 3));
  setInduction_(folderId, wed, thu);

  // Send the induction packet (dates + logins) to the candidate. Never throws - dates are saved above.
  _sendInductionPacket_(folderId, meta, wed, thu);

  return { ok: true, wed: wed, thu: thu };
}

/**
 * Resend the induction packet for a candidate who has ALREADY booked a week (admin action from the
 * Progress report "Resend induction packet" button). Reads the booked Wed/Thu off the Onboarding row;
 * refuses if no week is booked yet or there is no candidate email.
 */
function resendInductionPacket_(folderId, ctx) {
  folderId = String(folderId || '');
  if (!folderId) return { ok: false, error: 'missing reference' };
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'not_found' };
  var wed = String(meta.induction_wed || '').trim();
  var thu = String(meta.induction_thu || '').trim();
  if (!wed && !thu) return { ok: false, error: 'No induction week is booked yet - the candidate must pick a week before the packet can be resent.' };
  if (!isEmail_(meta.email)) return { ok: false, error: 'No candidate email on file for this row.' };
  _sendInductionPacket_(folderId, meta, wed, thu);
  logAudit_('induction_packet_resent', { folderId: folderId, by: (ctx && ctx.email) || 'admin' });
  return { ok: true, wed: wed, thu: thu, resent: true };
}

/**
 * Build + send the induction packet (booked dates + Google/HubSpot logins) to the candidate, CC the
 * senior broker, and alert the team when no HubSpot login is on record. Shared by bookInduction_ (first
 * send) and resendInductionPacket_. Wrapped so a send failure never propagates to the caller.
 */
function _sendInductionPacket_(folderId, o, wed, thu) {
  o = o || {};
  try {
    var company = CFG.COMPANY[o.entity || 'quay1'] || CFG.COMPANY.quay1;
    var cred = _credentialFor_(folderId);
    var hub = _teamHubspotLogin_(o.team);                  // team HubSpot login row (recorded?)
    var teamLogin = (hub && hub.recorded) ? hub : null;    // include in the packet only when on record
    // Visibility net (CC-independent, sends nothing): if the packet will omit the HubSpot login,
    // log WHY - team name not matched in the "HubSpot Logins" tab, or matched but no password on file.
    if (!teamLogin) logAudit_('induction_hubspot_missing', { folderId: folderId, team: o.team, matched: !!hub, recorded: !!(hub && hub.recorded) });
    if (isEmail_(o.email)) {
      var loginText = cred ? ('\n\nYour first-login details:\nEmail: ' + (cred.email || '-') +
        '\nTemporary password: ' + (cred.temp_password || '-') +
        '\n(You will be asked to set your own password when you first sign in.)') : '';
      // Never silently omit the HubSpot line - when it is not on record yet, say so instead of
      // leaving the candidate to wonder why it is missing.
      var hubText = teamLogin ? ('\n\nYour team HubSpot login:\nUsername: ' + (teamLogin.username || '-') +
        '\nPassword: ' + (teamLogin.password || '-') +
        (teamLogin.code_to ? '\nVerification code goes to: ' + teamLogin.code_to : '')) :
        '\n\nYour team HubSpot login: not on file yet - we will send it to you separately once confirmed.';
      var propdataText = '\n\nPropData will send you a SEPARATE email to set up your account - if you ' +
        'do not see it, please check your spam / junk folder.';
      var linksText = '\n\nUseful links:\nQuay 1 Shared Drive: https://drive.google.com/drive/folders/' +
        '0B8WThNzNuhU_LUVBb3BwMzFvN3M?resourcekey=0-RyLU_9UCYYV8yz2PUTLLkg&usp=sharing' +
        '\nFlow (Broker App): https://flow.quay1.co.za/';
      var plain = 'Hi ' + firstName_(o.name) + ',\n\nYour ' + company.name +
        ' induction is booked for ' + fmtDate_(wed) + ' and ' + fmtDate_(thu) + '.' +
        loginText + hubText + propdataText + linksText + '\n\nWarm regards,\nThe ' + company.name + ' Team';
      sendMail_(o.email,
        'Your ' + company.name + ' Induction Packet' + (o.name ? ' - ' + o.name : ''),
        plain, {
          name: company.name,
          htmlBody: inductionPacketHtml_(company, o, { wed: wed, thu: thu }, cred, teamLogin),
          cc: (ccEnabled_() && isEmail_(o.senior_email)) ? o.senior_email : undefined,
        });
    }
    // Team HubSpot login NOT on record -> alert the team (CC Sheldon + Marthinus) so the new hire
    // gets access and no one has to chase it. Suppressed when internal mail is off (ccEnabled_).
    if (hub && !hub.recorded && isEmail_(hub.username) && ccEnabled_()) {
      try {
        sendMail_(hub.username, 'HubSpot login needed - new ' + (o.team || '') + ' team member starting',
          'Hi ' + (o.team || 'team') + ' team,\n\nYour new team member ' + (o.name || 'a new starter') +
          ' is about to start, but we do not have a HubSpot login recorded for your team. Please reply with ' +
          'your team HubSpot password and who the verification code should go to, as soon as possible.\n\n' +
          'Thanks,\nThe ' + company.name + ' Team', { name: company.name, cc: CFG.CMA_APPROVERS.join(',') });
      } catch (e2) { logAudit_('hubspot_team_alert_failed', { folderId: folderId, error: String(e2) }); }
    }
    // Team name not found AT ALL in "HubSpot Logins" (no row to chase a password on) - this is a data
    // mismatch, not a missing password, so it needs an ops fix rather than a team chase. Alert Sheldon
    // + Marthinus directly since there is no team email to send to. Same ccEnabled_() gate as above.
    if (!hub && ccEnabled_()) {
      try {
        sendMail_(CFG.CMA_APPROVERS.join(','), 'HubSpot Logins: team "' + (o.team || '') + '" not found - new starter',
          'Hi,\n\n' + (o.name || 'A new starter') + ' is joining team "' + (o.team || '(none)') +
          '", but that team name was not found in the "HubSpot Logins" tab, so their induction packet ' +
          'could not include a login. Please add or correct the row for this team.\n\n' +
          'Thanks,\nThe ' + company.name + ' Team', { name: company.name });
      } catch (e2) { logAudit_('hubspot_team_alert_failed', { folderId: folderId, error: String(e2) }); }
    }
  } catch (err) {
    logAudit_('induction_packet_failed', { folderId: folderId, error: String(err) });
  }
}

/** Candidate-page lookup for the induction booking status (doGet ?i=<folderId>). */
function inductionLookup_(folderId) {
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'not_found' };
  var booked = !!(meta.induction_wed || meta.induction_thu);
  return {
    ok: true, firstName: firstName_(meta.name), booked: booked,
    induction: { wed: meta.induction_wed || '', thu: meta.induction_thu || '' },
  };
}

/** The candidate induction-booking link. Empty string when WEBAPP_URL is not yet set (pre-deploy).
 *  Mirrors ficaLink_ exactly, but with the ?i= (induction) query in place of ?f= (FICA). */
function inductionLink_(folderId) {
  var base = prop_(PROP.WEBAPP_URL, false);
  return base ? base + '?i=' + encodeURIComponent(folderId) : '';
}

/** Look up a team's HubSpot login in the 'HubSpot Logins' tab. Returns { team, username, password,
 *  code_to, recorded } (recorded = a password is on file) or null when the team is not listed.
 *  Columns: Team | Division | HubSpot Username | HubSpot Password | Code goes to (name) | ... */
function _teamHubspotLogin_(team) {
  var name = String(team || '').trim().toLowerCase();
  if (!name) return null;
  var t = sheet_().getSheetByName('HubSpot Logins');
  if (!t || t.getLastRow() < 2) return null;
  var v = t.getRange(2, 1, t.getLastRow() - 1, 5).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0] || '').trim().toLowerCase() === name) {
      var pw = String(v[i][3] || '').trim();
      return { team: v[i][0], username: String(v[i][2] || '').trim(), password: pw,
        code_to: String(v[i][4] || '').trim(), recorded: !!pw };
    }
  }
  return null;
}

/** Find the Google-account credential for a folderId in the private Credentials tab. Returns
 *  { email, temp_password } or null. Header-name keyed (created_at, full_name, quay_email,
 *  temp_password, team, folderId) so it survives column reordering. */
function _credentialFor_(folderId) {
  var t = sheet_().getSheetByName(CFG.TAB.CREDENTIALS);
  if (!t || t.getLastRow() < 2) return null;
  var values = t.getRange(1, 1, t.getLastRow(), t.getLastColumn()).getValues();
  var headers = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var fIx = headers.indexOf('folderId');
  var eIx = headers.indexOf('quay_email');
  var pIx = headers.indexOf('temp_password');
  if (fIx < 0) return null;
  var key = String(folderId || '').trim();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][fIx] || '').trim() === key) {
      return {
        email: eIx >= 0 ? String(values[i][eIx] || '') : '',
        temp_password: pIx >= 0 ? String(values[i][pIx] || '') : '',
      };
    }
  }
  return null;
}

/** Per-candidate progress summary (contract, FICA ticks, induction, provisioning states). */
function progressReport_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'not_found' };
  var fica = ficaStatus_(folderId);
  var prov = readQueue_(CFG.TAB.PROVISION_QUEUE).filter(function (r) { return r.folderId === folderId; });
  var provBySystem = {};
  prov.forEach(function (r) { provBySystem[r.system] = r.status; });

  var row = function (label, val) {
    return '<tr><td style="padding:4px 14px 4px 0;color:#7A7358;font-size:13px">' + htmlEsc_(label) +
      '</td><td style="padding:4px 0;font-size:14px;font-weight:600">' + htmlEsc_(val) + '</td></tr>';
  };
  var yn = function (b) { return b ? 'Received' : 'Outstanding'; };
  var html =
    '<table role="presentation" cellpadding="0" cellspacing="0" style="font-family:Montserrat,Arial,sans-serif">' +
      row('Name', o.name) + row('Status', o.status) +
      row('FICA ID', yn(fica.id)) + row('FICA POA', yn(fica.poa)) + row('FICA bank', yn(fica.bank)) +
      row('FICA contract', yn(fica.contract)) + row('FICA NDA', yn(fica.nda)) +
      row('Induction', (o.induction_wed || '') + (o.induction_thu ? ' / ' + o.induction_thu : '')) +
      Object.keys(provBySystem).map(function (s) { return row('Provision ' + s, provBySystem[s]); }).join('') +
    '</table>';
  return { ok: true, html: html };
}

/**
 * Tuesday digest of Quay1 candidates and their induction status. Auto-send is permitted for this
 * scoped onboarding-pipeline digest (SPEC section 6). Installed via setupTriggers() (Setup.js).
 */
function tuesdayDigest_() {
  var weekStart = _mondayOfThisWeek_();
  var weekEnd = _addDays_(weekStart, 6);
  var buckets = { dueThisWeek: [], unbooked: [] };
  listOnboarding_(function (o) { return o.entity === 'quay1'; }).forEach(function (o) {
    var wed = _asDate_(o.induction_wed);
    if (wed && wed >= weekStart && wed <= weekEnd) buckets.dueThisWeek.push(o);
    else if (!o.induction_wed && !o.induction_thu) buckets.unbooked.push(o);
  });
  var company = CFG.COMPANY.quay1;
  var to = CFG.INTERNAL_NOTIFY.filter(function (x) { return x; }).join(',');
  var subject = company.name + ' - induction digest (' + buckets.dueThisWeek.length +
    ' booked, ' + buckets.unbooked.length + ' awaiting)';
  sendMail_(to, subject,
    'Induction status. Booked this week: ' + buckets.dueThisWeek.length +
    '. Awaiting booking: ' + buckets.unbooked.length + '.',
    { name: company.name, htmlBody: inductionDigestHtml_(company, buckets) });
}

// ---------------------------------------------------------------- candidate booking page

/** Serve the branded candidate induction-booking page (doGet ?i=<folderId>). Token-less: the
 *  unguessable folderId is the credential. Mirrors the FICA page's structure + POST pattern.
 *  Offers a pick-your-week control (the next ~4 upcoming Mondays); induction runs Wed + Thu. */
function inductionPageHtml_(folderId) {
  var meta = readOnboardingByFolder_(folderId);
  var known = !!meta;
  var company = CFG.COMPANY[(meta && meta.entity)] || CFG.COMPANY.quay1;
  var companyName = htmlEsc_(company.name);
  var first = known ? htmlEsc_(firstName_(meta.name)) : '';
  var endpoint = optProp_(PROP.WEBAPP_URL);
  var B = CFG.BRAND;

  var booked = known && !!(meta.induction_wed || meta.induction_thu);
  var bookedMsg = booked ?
    '<div class="note info show">You are currently booked for induction on ' +
      htmlEsc_(fmtDate_(meta.induction_wed)) +
      (meta.induction_thu ? ' and ' + htmlEsc_(fmtDate_(meta.induction_thu)) : '') +
      '. You can pick a different week below if you need to change it.</div>' : '';

  var badLink = known ? '' :
    '<div class="note err show">This link is not recognised. Please use the personal link from your ' +
    companyName + ' email, or reply to that email for help.</div>';

  // Next ~4 bookable Mondays. The first is the current week until this week's Tuesday 14:00, then
  // next week once that cut-off passes (_earliestBookableMonday_). Each option shows its Wed + Thu.
  var options = '';
  var start = _earliestBookableMonday_();
  for (var i = 0; i < 4; i++) {
    var m = _addDays_(start, i * 7);
    var iso = _isoDate_(m);
    var lbl = 'Wed ' + fmtDate_(_isoDate_(_addDays_(m, 2))) + ' and Thu ' + fmtDate_(_isoDate_(_addDays_(m, 3)));
    options += '<option value="' + iso + '">' + htmlEsc_(lbl) + '</option>';
  }

  var html =
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>' + companyName + ' induction booking</title><style>' +
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
'label{display:block;font-size:13px;font-weight:600;color:var(--slate);margin:0 0 5px}' +
'select,input[type=week]{width:100%;font-family:inherit;font-size:15px;color:var(--ink);background:var(--card2);' +
'border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 13px;outline:none}' +
'select:focus,input:focus{border-color:var(--navy);box-shadow:0 0 0 3px rgba(61,91,166,.22);background:#fff}' +
'.hint{font-size:12px;color:var(--muted);margin-top:5px}' +
'.btn{width:100%;font-family:inherit;font-size:15px;font-weight:700;color:var(--gold-ink);background:var(--gold);' +
'border:0;border-radius:var(--r-sm);padding:14px 18px;cursor:pointer}.btn:disabled{opacity:.6;cursor:not-allowed}' +
'.note{margin-top:14px;font-size:14px;padding:12px 14px;border-radius:var(--r-sm);display:none}' +
'.note.show{display:block}.note.ok{background:var(--green-t);color:var(--green);border:1px solid var(--green-b)}' +
'.note.err{background:var(--red-t);color:var(--red);border:1px solid #F5C6C0}' +
'.note.info{background:var(--amber-t);color:var(--amber);border:1px solid #F5E3B3}' +
'.foot{text-align:center;font-size:12px;color:var(--muted);margin-top:24px}' +
'@media (max-width:520px){.wrap{padding:16px 12px 44px}.hero{padding:20px 17px}.hero h1{font-size:18px}' +
'.card{padding:16px 15px}.btn{padding:15px 18px}select,input[type=week]{font-size:16px}}' +
'@media (min-width:900px){.wrap{max-width:680px}}' +
'</style></head><body><div class="wrap">' +
'<div class="hero"><h1>' + companyName + '</h1>' +
'<p>' + (first ? ('Hi ' + first + '. ') : '') + 'Please book your induction week below. Induction runs on the Wednesday and Thursday of the week you choose.</p></div>' +
badLink + bookedMsg +
'<form id="indForm" novalidate>' +
'<div class="card"><p class="sec">Choose your induction week</p>' +
'<div class="row"><label for="week">Induction week</label>' +
'<select id="week" required>' + options + '</select>' +
'<p class="hint">Your induction takes place on the Wednesday and Thursday of the week you select.</p></div></div>' +
'<button type="submit" class="btn" id="submitBtn">Confirm my induction booking</button>' +
'<div id="note" class="note"></div></form>' +
'<p class="foot">' + companyName + ' - we look forward to welcoming you.</p>' +
'</div><script>' +
'var ENDPOINT=' + JSON.stringify(endpoint) + ';var FOLDER_ID=' + JSON.stringify(folderId) + ';' +
'var KNOWN=' + (known ? 'true' : 'false') + ';' +
'var form=document.getElementById("indForm"),note=document.getElementById("note"),btn=document.getElementById("submitBtn");' +
'if(!KNOWN&&btn){btn.disabled=true;}' +
'function showNote(c,m){note.className="note show "+c;note.textContent=m;}' +
'form.addEventListener("submit",function(e){e.preventDefault();if(!KNOWN)return;' +
'if(!form.checkValidity()){form.reportValidity();return;}' +
'var week=document.getElementById("week").value;' +
'btn.disabled=true;showNote("info","Booking your induction, please hold on...");' +
'fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},' +
'body:JSON.stringify({kind:"book_induction",folderId:FOLDER_ID,weekMonday:week})})' +
'.then(function(r){return r.json();}).then(function(d){' +
'if(d&&d.ok){form.style.display="none";showNote("ok","Thank you! Your induction is booked. Check your email for the details.");}' +
'else{showNote("err","Something went wrong: "+((d&&d.error)||"unknown")+".");btn.disabled=false;}})' +
'.catch(function(err){showNote("err","Booking failed: "+err+".");btn.disabled=false;});' +
'});' +
'<\/script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('Quay 1 Induction')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------- date helpers

function _addDays_(d, n) { return new Date(d.getTime() + n * 24 * 60 * 60 * 1000); }

function _isoDate_(d) {
  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
  var dd = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + mm + '-' + dd;
}

function _mondayOfThisWeek_() {
  var now = new Date();
  var day = now.getDay(); // 0 Sun .. 6 Sat
  var diff = (day === 0 ? -6 : 1 - day); // back to Monday
  var mon = _addDays_(now, diff);
  return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
}

/**
 * The earliest induction week a candidate may book, as that week's Monday. Induction runs on the
 * Wednesday + Thursday of a week; the cut-off to join a given week is that week's Tuesday 14:00
 * (SA time - see appsscript.json). Before this week's Tuesday 14:00 the current week is still open;
 * from Tuesday 14:00 onward the current week is closed and the earliest becomes next week. This is
 * what stops a last-minute finisher joining tomorrow's induction (they roll to next week instead).
 */
function _earliestBookableMonday_() {
  var monday = _mondayOfThisWeek_();
  var cutoff = new Date(monday.getTime() + (24 + 14) * 60 * 60 * 1000); // Tuesday 14:00 this week
  var now = new Date();
  return now.getTime() < cutoff.getTime() ? monday : _addDays_(monday, 7);
}
