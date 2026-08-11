/**
 * Email.js - shared branded HTML email builders. Ported and generalised from the live Aqua
 * email code (aqua-contracts Code.js:1216-1411), parameterised by the per-entity company info
 * (CFG.COMPANY[entity]) so Quay 1 and Aqua share one navy+gold shell (RESEARCH 2.7 confirmed
 * both live pipelines use the same palette). All inline styles, no external assets (CSP-safe).
 *
 * This file is an addition to the architect's stub set (flagged to tester + architect): the
 * email HTML would otherwise push the onboarding modules over the 500-line limit.
 *
 * Public surface (each returns an HTML string):
 *   emailShell_(company, kicker, innerHtml)     - the navy/gold wrapper.
 *   agreementEmailHtml_(company, first, ficaUrl)- contract welcome + FICA button.
 *   ficaThankYouHtml_(company, first)           - FICA received acknowledgement.
 *   provisionNoticeHtml_(company, name, fields, systems, folderUrl) - human account-setup notice.
 *   inductionDigestHtml_(company, buckets)      - Tuesday induction digest (auto-send scoped ok).
 *   offboardNoticeHtml_(company, oq)            - offboarding scheduled/fired notice (DRAFT only).
 *
 * No em/en dashes in any string this file emits.
 */

/** The navy/gold wrapper used by every email. */
function emailShell_(company, kicker, innerHtml) {
  var B = CFG.BRAND;
  return '' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + B.paper + ';margin:0;padding:0"><tr><td align="center" style="padding:26px 12px">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Montserrat,Arial,Helvetica,sans-serif">' +
        '<tr><td style="background:' + B.navy + ';padding:30px 40px 26px;text-align:center">' +
          '<div style="font-size:27px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:.5px;line-height:1.12">' + htmlEsc_(company.name) + '</div>' +
          '<div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#C7D6F0;margin:8px 0 0">' + htmlEsc_(kicker) + '</div>' +
        '</td></tr>' +
        '<tr><td style="padding:32px 40px 8px">' + innerHtml + '</td></tr>' +
        '<tr><td style="background:' + B.navyDark + ';padding:22px 40px 24px;text-align:center">' +
          '<div style="font-size:13px;color:#ffffff;font-weight:700;text-transform:uppercase;letter-spacing:.4px">' + htmlEsc_(company.full) + '</div>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table>';
}

/** Contract welcome email with the FICA submission button. */
function agreementEmailHtml_(company, first, ficaUrl) {
  var B = CFG.BRAND;
  var ficaBtn = ficaUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 2px"><tr><td style="border-radius:9px;background:' + B.gold + '">' +
        '<a href="' + htmlEsc_(ficaUrl) + '" style="display:inline-block;padding:12px 22px;font-size:14.5px;font-weight:700;color:' + B.goldInk + ';text-decoration:none;border-radius:9px">Submit my FICA documents</a>' +
      '</td></tr></table>'
    : '';
  var inner =
    '<p style="margin:0 0 12px;font-size:17px;font-weight:700;color:' + B.goldInk + '">Hi ' + htmlEsc_(first) + ',</p>' +
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.62;color:' + B.slate + '">Welcome to ' + htmlEsc_(company.name) +
      '. Your ' + htmlEsc_(company.kicker) + ' is attached to this email.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FFF6D6;border:1px solid #F0DFA0;border-radius:10px"><tr>' +
      '<td width="46" valign="middle" style="padding:12px 0 12px 14px"><div style="width:26px;height:26px;border-radius:7px;background:' + B.gold + ';color:' + B.goldInk + ';text-align:center;line-height:26px;font-size:14px">&#128206;</div></td>' +
      '<td valign="middle" style="padding:12px 15px 12px 6px;font-size:13.5px;color:' + B.goldInk + ';font-weight:600">' + htmlEsc_(company.kicker) + ' (PDF attached)</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">Please read it through, sign the cover page, initial every page, and sign where applicable, then return a signed copy to us and keep one for your records.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr>' +
      '<td style="padding:14px 16px">' +
        '<div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:' + B.amber + ';margin:0 0 8px">FICA - required</div>' +
        '<div style="font-size:14px;line-height:1.6;color:' + B.slate + '">To comply with FICA, please submit the following using your personal, secure link below:' +
          '<ol style="margin:8px 0 12px;padding:0 0 0 20px">' +
            '<li style="margin:0 0 4px">A certified copy of your ID or valid passport</li>' +
            '<li style="margin:0 0 4px">Proof of your residential address, not older than 3 months (e.g. a utility bill or bank statement)</li>' +
            '<li style="margin:0 0 4px">A bank confirmation letter or recent bank statement showing your account details</li>' +
            '<li style="margin:0 0 4px">Your income tax number (and SARS proof of it, if you have one)</li>' +
          '</ol>' +
        '</div>' + ficaBtn +
      '</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">If anything is unclear, simply reply to this email and we will gladly help.</p>' +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Warm regards,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, company.kicker, inner);
}

/** FICA received acknowledgement email. */
function ficaThankYouHtml_(company, first) {
  var B = CFG.BRAND;
  var inner =
    '<p style="margin:0 0 12px;font-size:17px;font-weight:700;color:' + B.goldInk + '">Hi ' + htmlEsc_(first) + ',</p>' +
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.62;color:' + B.slate + '">Thank you for submitting your documents to ' +
      htmlEsc_(company.name) + '. Our admin team is now checking them.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FFF6D6;border:1px solid #F0DFA0;border-radius:10px"><tr>' +
      '<td width="46" valign="middle" style="padding:12px 0 12px 14px"><div style="width:26px;height:26px;border-radius:7px;background:' + B.gold + ';color:' + B.goldInk + ';text-align:center;line-height:26px;font-size:15px">&#10003;</div></td>' +
      '<td valign="middle" style="padding:12px 15px 12px 6px;font-size:13.5px;color:' + B.goldInk + ';font-weight:600">FICA documents received</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">There is nothing further you need to do right now. Please look out for another email shortly confirming your induction day.</p>' +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Warm regards,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, 'FICA documents received', inner);
}

/** Human "please set up these accounts" notice (browser systems a person must action). */
function provisionNoticeHtml_(company, name, fields, systems, folderUrl) {
  var B = CFG.BRAND;
  var rows = systems.map(function (s) {
    return '<tr><td style="padding:6px 0;font-size:14.5px;color:' + B.goldInk + '">' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + B.gold + ';margin-right:10px"></span>' +
      htmlEsc_(s) + '</td></tr>';
  }).join('');
  var detail = function (label, value) {
    return '<tr><td style="padding:3px 14px 3px 0;font-size:13px;color:' + B.muted + ';white-space:nowrap">' + htmlEsc_(label) + '</td>' +
      '<td style="padding:3px 0;font-size:14px;color:' + B.goldInk + ';font-weight:600">' + htmlEsc_(value || '-') + '</td></tr>';
  };
  var inner =
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">A new ' + htmlEsc_(company.name) +
      ' record needs these browser-portal accounts set up (the API systems are already handled). ' +
      'Please action them and reply once done.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px">' +
      detail('Name', name) + detail('ID number', fields.id_number || '') +
      detail('Start date', fmtDate_(fields.start_date)) + detail('Email', fields.email || '(none)') +
    '</table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr><td style="padding:14px 16px">' +
      '<div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:' + B.amber + ';margin:0 0 8px">Systems to provision</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0">' + rows + '</table>' +
    '</td></tr></table>' +
    (folderUrl ? '<p style="margin:0 0 6px;font-size:13.5px;color:' + B.slate + '">Folder: <a href="' + htmlEsc_(folderUrl) + '" style="color:' + B.navyDark + '">open in Drive</a></p>' : '') +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Thanks,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, 'Account setup needed', inner);
}

/** CMA access approval-request email (auto-sent to CMA_APPROVERS on admin acceptance of a
 *  CMA-entitled candidate). CMA costs money, so it needs a human yes before the seat is bought. */
/** Generic manual-account request email (CMA + Dialfire): a system that is not auto-created, so we
 *  email whoever creates it with the starter's name + team. `noteTitle`/`noteBody` render an amber
 *  callout when present (e.g. the CMA cost warning). Branded via emailShell_. */
function accountRequestHtml_(company, kicker, accountLabel, name, team, noteTitle, noteBody) {
  var B = CFG.BRAND;
  var detail = function (label, value) {
    return '<tr><td style="padding:3px 14px 3px 0;font-size:13px;color:' + B.muted + ';white-space:nowrap">' + htmlEsc_(label) + '</td>' +
      '<td style="padding:3px 0;font-size:14px;color:' + B.goldInk + ';font-weight:600">' + htmlEsc_(value || '-') + '</td></tr>';
  };
  var note = (noteTitle || noteBody) ?
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr><td style="padding:14px 16px">' +
      (noteTitle ? '<div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:' + B.amber + ';margin:0 0 8px">' + htmlEsc_(noteTitle) + '</div>' : '') +
      '<div style="font-size:14px;line-height:1.6;color:' + B.slate + '">' + htmlEsc_(noteBody || '') + '</div>' +
    '</td></tr></table>' : '';
  var inner =
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">Please create a <strong>' + htmlEsc_(accountLabel) +
      '</strong> account for the following new ' + htmlEsc_(company.name) + ' starter.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px">' +
      detail('Name', name) + detail('Team', team) +
    '</table>' + note +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Thanks,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, kicker, inner);
}

/** CMA manual account-request email (name + team + a cost callout). */
function cmaRequestHtml_(company, name, team) {
  return accountRequestHtml_(company, 'CMA account request', 'CMA (cmainfo.co.za)', name, team,
    'Approval needed - incurs cost',
    'A CMA seat carries a cost. Reply to confirm whether this starter should be given a CMA account; once approved, the seat can be set up on cmainfo.co.za.');
}

/** Dialfire manual account-request email (name + team). */
function dialfireRequestHtml_(company, name, team) {
  return accountRequestHtml_(company, 'Dialfire account request', 'Dialfire', name, team, '', '');
}

/** Human label for a self-declared FFC (Fidelity Fund Certificate) status. Empty = not yet declared
 *  (the candidate has not completed FICA), which we surface distinctly from an explicit "No status". */
function ffcStatusLabel_(ffc) {
  switch (String(ffc || '').trim().toLowerCase()) {
    case 'full': return 'Full status';
    case 'candidate': return 'Candidate status';
    case 'none': return 'No status';
    default: return 'Not declared yet';
  }
}

/** Tuesday induction digest (auto-send permitted for this scoped pipeline). Each candidate row shows
 *  full name, phone number, team, and FFC status; the booked bucket also shows the induction Wed. */
function inductionDigestHtml_(company, buckets) {
  var B = CFG.BRAND;
  var th = function (t) {
    return '<th style="text-align:left;padding:6px 12px 6px 0;font-size:11px;font-weight:700;letter-spacing:.4px;' +
      'text-transform:uppercase;color:' + B.muted + ';border-bottom:1px solid #DCE8F6">' + htmlEsc_(t) + '</th>';
  };
  var td = function (v, strong) {
    return '<td style="padding:7px 12px 7px 0;font-size:13.5px;color:' + (strong ? B.goldInk : B.slate) + ';' +
      (strong ? 'font-weight:600;' : '') + 'border-bottom:1px solid #DCE8F6">' + htmlEsc_(v || '-') + '</td>';
  };
  var table = function (title, rows, empty, showInduction) {
    var head = '<tr>' + th('Name') + th('Phone') + th('Team') + th('FFC status') +
      (showInduction ? th('Induction') : '') + '</tr>';
    var body = rows.length
      ? rows.map(function (r) {
          return '<tr>' + td(r.name, true) + td(r.contact) + td(r.team) + td(ffcStatusLabel_(r.ffc_status)) +
            (showInduction ? td(r.induction_wed ? 'Wed ' + fmtDate_(r.induction_wed) : '-') : '') + '</tr>';
        }).join('')
      : '<tr><td colspan="' + (showInduction ? 5 : 4) + '" style="padding:8px 0;font-size:13.5px;color:' + B.muted + '">' +
          htmlEsc_(empty) + '</td></tr>';
    return '<div style="margin:0 0 20px"><div style="font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:' +
      B.amber + ';margin:0 0 8px">' + htmlEsc_(title) + ' (' + rows.length + ')</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">' +
      head + body + '</table></div>';
  };
  var inner =
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:' + B.slate + '">Induction status for the week. ' +
      buckets.dueThisWeek.length + ' candidate' + (buckets.dueThisWeek.length === 1 ? '' : 's') + ' booked for induction.</p>' +
    table('Booked this week', buckets.dueThisWeek, 'No inductions booked this week.', true) +
    table('Awaiting booking', buckets.unbooked, 'Everyone due is booked.', false);
  return emailShell_(company, 'Induction digest', inner);
}

/** Offboarding scheduled/fired notice (DRAFT only, never auto-sent). */
function offboardNoticeHtml_(company, oq) {
  var B = CFG.BRAND;
  var detail = function (label, value) {
    return '<tr><td style="padding:3px 14px 3px 0;font-size:13px;color:' + B.muted + ';white-space:nowrap">' + htmlEsc_(label) + '</td>' +
      '<td style="padding:3px 0;font-size:14px;color:' + B.goldInk + ';font-weight:600">' + htmlEsc_(value || '-') + '</td></tr>';
  };
  var inner =
    '<p style="margin:0 0 16px;font-size:16px;font-weight:700;color:' + B.goldInk + '">' + htmlEsc_(oq.full_name || 'A staff member') + ' is scheduled for offboarding.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">' +
      detail('Google account', oq.quay_email) + detail('Requested by', oq.requested_by) +
      detail('Fires at', oq.fire_at) + detail('Systems', (oq.systems || []).join(', ')) +
    '</table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 4px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr><td style="padding:12px 15px;font-size:14px;color:' + B.amber + ';font-weight:600">This is a scheduled offboarding. There is no cancel window once the timer starts.</td></tr></table>';
  return emailShell_(company, 'Offboarding scheduled', inner);
}

/** Documents-approved congrats + call to action to pick an induction week (gold button). */
function inductionInviteHtml_(company, first, bookUrl) {
  var B = CFG.BRAND;
  var bookBtn = bookUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 2px"><tr><td style="border-radius:9px;background:' + B.gold + '">' +
        '<a href="' + htmlEsc_(bookUrl) + '" style="display:inline-block;padding:12px 22px;font-size:14.5px;font-weight:700;color:' + B.goldInk + ';text-decoration:none;border-radius:9px">Pick my induction week</a>' +
      '</td></tr></table>'
    : '';
  var inner =
    '<p style="margin:0 0 12px;font-size:17px;font-weight:700;color:' + B.goldInk + '">Hi ' + htmlEsc_(first) + ',</p>' +
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.62;color:' + B.slate + '">Great news, your documents have been approved. Everything is in order and you are all set to join ' +
      htmlEsc_(company.name) + '.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FFF6D6;border:1px solid #F0DFA0;border-radius:10px"><tr>' +
      '<td width="46" valign="middle" style="padding:12px 0 12px 14px"><div style="width:26px;height:26px;border-radius:7px;background:' + B.gold + ';color:' + B.goldInk + ';text-align:center;line-height:26px;font-size:15px">&#10003;</div></td>' +
      '<td valign="middle" style="padding:12px 15px 12px 6px;font-size:13.5px;color:' + B.goldInk + ';font-weight:600">Your documents are approved</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">The last step is to choose the induction week that suits you best. Tap the button below to pick your week and we will take it from there.</p>' +
    bookBtn +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Warm regards,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, 'Documents approved', inner);
}

/** Induction packet: welcome + induction dates + new Google login + what to bring. */
function inductionPacketHtml_(company, o, induction, cred, hubspot) {
  o = o || {};
  induction = induction || {};
  var first = firstName_(o.name || '') || 'there';
  var fullName = o.name || first;
  var team = o.team || '-';
  var senior = o.senior_name || '-';
  var start = o.start_date ? fmtDate_(o.start_date) : '-';
  var DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONF = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // A single induction morning card (calendar badge + agenda), styled to match the hand-built packet.
  var dayCard = function (iso, header, bullets) {
    var mm = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    var badgeDow = '', badgeDay = '-', badgeMon = '', fullLine = '';
    if (mm) {
      var y = +mm[1], mo = +mm[2], d = +mm[3];
      var dt = new Date(y, mo - 1, d);
      badgeDow = DOW[dt.getDay()].slice(0, 3).toUpperCase();
      badgeDay = String(d); badgeMon = MON[mo - 1];
      fullLine = DOW[dt.getDay()] + ', ' + d + ' ' + MONF[mo - 1] + ' ' + y;
    }
    var lis = bullets.map(function (b) {
      return '<li style="position:relative;padding-left:16px;font-size:13px;line-height:1.45;color:#33415A;margin:0 0 5px;list-style:none"><span style="position:absolute;left:0;color:#3D5BA6;font-weight:700">&bull;</span>' + htmlEsc_(b) + '</li>';
    }).join('');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid #DCE8F6;border-radius:12px;overflow:hidden;background:#EAF2FB"><tr>' +
      '<td width="6" style="width:6px;background:#FDC503;font-size:0;line-height:0">&nbsp;</td>' +
      '<td width="92" valign="middle" style="width:92px;padding:14px 6px;text-align:center;border-right:1px solid #D4E2F3">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#3D5BA6">' + badgeDow + '</div>' +
        '<div style="font-size:24px;font-weight:800;color:#1B2536;line-height:1.15">' + badgeDay + '</div>' +
        '<div style="font-size:11px;font-weight:600;color:#5A6B85;text-transform:uppercase">' + badgeMon + '</div></td>' +
      '<td valign="top" style="padding:14px 18px">' +
        '<div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#3D5BA6;margin:0 0 3px">' + htmlEsc_(header) + '</div>' +
        '<div style="font-size:13px;color:#5A6B85;margin:0 0 9px">' + htmlEsc_(fullLine) + ' &nbsp;|&nbsp; <b style="color:#1B2536">09:00 - 12:00</b></div>' +
        '<ul style="margin:0;padding:0">' + lis + '</ul>' +
      '</td></tr></table>';
  };

  var sec = function (t) { return '<div style="font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#3D5BA6;margin:22px 0 12px">' + htmlEsc_(t) + '</div>'; };

  // Google login card + the (rewritten) yellow note: password + how to switch on 2-step verification.
  // Property24 line removed - Property24 is no longer provisioned by this tool.
  var loginPanel = cred
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #DCE8F6;border-left:4px solid #3D5BA6;border-radius:12px;background:#F3F7FC"><tr><td style="padding:18px 20px">' +
        '<div style="font-size:12px;color:#5A6B85">Email &amp; Google Workspace</div>' +
        '<div style="font-size:16px;font-weight:700;color:#17223D;padding:2px 0 12px;font-family:\'SF Mono\',Menlo,Consolas,monospace">' + htmlEsc_(cred.email || '-') + '</div>' +
        '<div style="font-size:12px;color:#5A6B85">Temporary password</div>' +
        '<div style="font-size:16px;font-weight:700;color:#17223D;padding:2px 0 12px;font-family:\'SF Mono\',Menlo,Consolas,monospace">' + htmlEsc_(cred.temp_password || '-') + '</div>' +
        '<div style="margin-top:4px;background:#FFF6D6;border:1px solid #F2DC8E;border-radius:9px;padding:12px 14px;font-size:13px;line-height:1.55;color:#6B5A16">' +
          '<b>On first sign-in</b> you will be asked to set your own password and switch on 2-step verification (2FA).<br><br>' +
          '<b>To switch on 2-step verification:</b> sign in at <a href="https://mail.google.com" style="color:#3D5BA6">mail.google.com</a> with the details above, open <b>myaccount.google.com/security</b>, choose <b>2-Step Verification &rarr; Get started</b>, then follow the prompts to confirm a code sent to your phone. It takes about a minute and keeps your account secure.' +
        '</div>' +
      '</td></tr></table>'
    : '';

  // Team HubSpot login card. When not on record yet, say so instead of silently dropping the section -
  // the candidate should never be left wondering why a HubSpot login was not included.
  var hubPanel = hubspot
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 0;border:1px solid #DCE8F6;border-left:4px solid #FDC503;border-radius:12px;background:#FFFBEF"><tr><td style="padding:18px 20px">' +
        '<div style="font-size:12px;color:#5A6B85">Your team HubSpot login</div>' +
        '<div style="font-size:12px;color:#5A6B85;padding-top:10px">Username</div>' +
        '<div style="font-size:16px;font-weight:700;color:#17223D;padding:2px 0 8px;font-family:\'SF Mono\',Menlo,Consolas,monospace">' + htmlEsc_(hubspot.username || '-') + '</div>' +
        '<div style="font-size:12px;color:#5A6B85">Password</div>' +
        '<div style="font-size:16px;font-weight:700;color:#17223D;padding:2px 0 8px;font-family:\'SF Mono\',Menlo,Consolas,monospace">' + htmlEsc_(hubspot.password || '-') + '</div>' +
        (hubspot.code_to ? '<div style="font-size:12px;color:#5A6B85">Verification code goes to</div><div style="font-size:15px;font-weight:700;color:#17223D;padding:2px 0 0">' + htmlEsc_(hubspot.code_to) + '</div>' : '') +
      '</td></tr></table>'
    : '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 0;border:1px solid #DCE8F6;border-left:4px solid #FDC503;border-radius:12px;background:#FFFBEF"><tr><td style="padding:18px 20px">' +
        '<div style="font-size:12px;color:#5A6B85">Your team HubSpot login</div>' +
        '<div style="font-size:14px;font-weight:600;color:#17223D;padding-top:6px">Not on file yet - we will send it to you separately once confirmed.</div>' +
      '</td></tr></table>';

  // PropData note - the account is created separately and PropData emails the broker directly.
  var propdataNote =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 0;border:1px solid #DCE8F6;border-radius:12px;background:#F5F8FD"><tr><td style="padding:14px 18px">' +
      '<div style="font-size:14px;font-weight:700;color:#17223D;margin:0 0 3px">Your PropData account</div>' +
      '<div style="font-size:13.5px;line-height:1.6;color:#46536E"><b>PropData will send you a separate email</b> to set up your account. If you do not see it in your inbox, please <b>check your spam / junk folder</b> - it sometimes lands there.</div>' +
    '</td></tr></table>';

  var day1 = dayCard(induction.wed, 'Day 1 - Getting Started (with Kat)', [
    'An introduction to Quay 1: our culture, values, and how we operate',
    'An introduction to Flow (our Broker App) and how you will use it day-to-day',
    'An overview of our marketing resources, document systems, and training materials',
    'Who to contact across the business, so you always know where to go for support',
  ]);
  var day2 = dayCard(induction.thu, 'Day 2 - Programs (with Pagan)', ['HubSpot', 'PropData', 'Flow', 'CMA']);

  var contactRow = function (what, who, email, last) {
    var bb = last ? '' : 'border-bottom:1px solid #ECF1F8;';
    return '<tr><td style="padding:9px 0;' + bb + 'font-size:13.5px;color:#5A6B85;vertical-align:top">' + htmlEsc_(what) + '</td>' +
      '<td style="padding:9px 0;' + bb + 'text-align:right"><span style="font-size:13.5px;font-weight:700;color:#17223D">' + htmlEsc_(who) + '</span><br><span style="font-size:12px;color:#8A96AE">' + htmlEsc_(email) + '</span></td></tr>';
  };

  var body =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#DCE7F5;margin:0;padding:0"><tr><td align="center" style="padding:26px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Montserrat,Arial,Helvetica,sans-serif">' +
    // Header
    '<tr><td style="background:#3D5BA6;padding:30px 40px 26px;text-align:center">' +
      '<img src="https://twigs002.github.io/quay-hubspot/assets/quay1-logo-white.png" width="180" alt="' + htmlEsc_(company.name) + '" style="display:block;margin:0 auto 20px;width:180px;max-width:60%;height:auto">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#98C5ED;margin:0 0 8px">Your induction packet</div>' +
      '<div style="font-size:27px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:.5px;line-height:1.12">Welcome aboard,<br>' + htmlEsc_(first) + '</div></td></tr>' +
    '<tr><td style="padding:32px 40px 8px">' +
      '<p style="margin:0 0 20px;font-size:15px;line-height:1.62;color:#5A6B85">We are genuinely thrilled to have you with us. Everything you need for a confident first two weeks is right here in this one email. Have a read before your first morning and you will walk in ready.</p>' +
      // Crew manifest
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 0;border-radius:12px;overflow:hidden;background:#2C4682"><tr><td style="padding:16px 18px">' +
        '<div style="font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#FDC503;margin:0 0 11px">Crew Manifest &#9875;</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
          '<td width="50%" valign="top" style="padding-right:10px">' +
            '<div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;color:#A9BEE6">Broker</div><div style="font-size:15px;font-weight:700;color:#ffffff;padding:1px 0 10px">' + htmlEsc_(fullName) + '</div>' +
            '<div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;color:#A9BEE6">Team</div><div style="font-size:15px;font-weight:700;color:#ffffff;padding:1px 0 10px">' + htmlEsc_(team) + '</div></td>' +
          '<td width="50%" valign="top" style="padding-left:10px;border-left:1px solid #46608F">' +
            '<div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;color:#A9BEE6">Senior broker</div><div style="font-size:15px;font-weight:700;color:#ffffff;padding:1px 0 10px">' + htmlEsc_(senior) + '</div>' +
            '<div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;color:#A9BEE6">Start date</div><div style="font-size:15px;font-weight:700;color:#ffffff;padding:1px 0 10px">' + htmlEsc_(start) + '</div></td>' +
        '</tr></table></td></tr></table>' +
      // Logins
      sec('Your Quay 1 logins') + loginPanel + hubPanel + propdataNote +
      // Induction
      sec('Your induction · two mornings, 09:00 - 12:00') + day1 + day2 +
      // Where
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0;border:1px solid #DCE8F6;border-radius:12px;background:#F5F8FD"><tr>' +
        '<td valign="middle" style="padding:15px 8px 15px 18px"><div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8A96AE">Where</div>' +
        '<div style="font-size:15px;font-weight:700;color:#17223D;padding-top:3px">&#128205; 277 Lower Main Road, Observatory, Cape Town</div></td>' +
        '<td valign="middle" align="right" style="padding:15px 18px 15px 6px;white-space:nowrap"><a href="https://www.google.com/maps/dir/?api=1&destination=277+Lower+Main+Road,+Observatory,+Cape+Town" style="display:inline-block;text-decoration:none;background:#3D5BA6;color:#ffffff;font-size:13px;font-weight:700;padding:11px 16px;border-radius:9px">Get directions &nbsp;&rarr;</a></td></tr></table>' +
      // Holy grail
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0;border:1px solid #E1E9F5;border-radius:12px;background:#FBFCFF"><tr><td style="padding:15px 18px">' +
        '<div style="font-size:15px;font-weight:800;color:#17223D;margin:0 0 4px">Your first two weeks: the Holy Grail &#9875;</div>' +
        '<div style="font-size:14px;line-height:1.6;color:#46536E">Every new broker completes our 19-step training (the &ldquo;Holy Grail&rdquo;) and a short test within two weeks. Rentals brokers do the rentals version. The videos and the test link are in your Training folder.</div>' +
      '</td></tr></table>' +
      // Links: Shared Drive + Flow (My documents removed)
      sec('Everything in one place') +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td width="50%" style="padding:0 8px 8px 0"><a href="https://drive.google.com/drive/folders/0B8WThNzNuhU_LUVBb3BwMzFvN3M?resourcekey=0-RyLU_9UCYYV8yz2PUTLLkg&usp=sharing" style="display:block;text-decoration:none;background:#F5F8FD;border:1px solid #D9E3F3;border-left:3px solid #FDC503;border-radius:10px;padding:13px 15px;color:#17223D;font-size:14px;font-weight:700">Quay 1 Shared Drive</a></td>' +
        '<td width="50%" style="padding:0 0 8px 6px"><a href="https://flow.quay1.co.za/" style="display:block;text-decoration:none;background:#F5F8FD;border:1px solid #D9E3F3;border-left:3px solid #FDC503;border-radius:10px;padding:13px 15px;color:#17223D;font-size:14px;font-weight:700">Flow (Broker App)</a></td>' +
      '</tr></table>' +
      // Before first day
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;background:#EAF2FB;border:1px solid #DCE8F6;border-radius:14px"><tr><td style="padding:18px 20px">' +
        '<div style="font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#3D5BA6;margin:0 0 14px">Before your first day</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
          '<tr><td width="28" valign="top" style="padding:2px 0 0"><div style="width:20px;height:20px;border-radius:50%;background:#3D5BA6;color:#ffffff;text-align:center;line-height:20px;font-size:12px;font-weight:700">&#10003;</div></td><td style="padding:1px 0 0 10px;font-size:14px;line-height:1.5;color:#1B2536">Come with a charged laptop</td></tr>' +
          '<tr><td colspan="2" style="height:10px;font-size:0;line-height:0">&nbsp;</td></tr>' +
          '<tr><td width="28" valign="top" style="padding:2px 0 0"><div style="width:20px;height:20px;border-radius:50%;background:#3D5BA6;color:#ffffff;text-align:center;line-height:20px;font-size:12px;font-weight:700">&#10003;</div></td><td style="padding:1px 0 0 10px;font-size:14px;line-height:1.5;color:#1B2536">Say hi to your senior broker, ' + htmlEsc_(senior) + '</td></tr>' +
          '<tr><td colspan="2" style="height:10px;font-size:0;line-height:0">&nbsp;</td></tr>' +
          '<tr><td width="28" valign="top" style="padding:2px 0 0"><div style="width:20px;height:20px;border-radius:50%;background:#3D5BA6;color:#ffffff;text-align:center;line-height:20px;font-size:12px;font-weight:700">&#10003;</div></td><td style="padding:1px 0 0 10px;font-size:14px;line-height:1.5;color:#1B2536">Know your team: ' + htmlEsc_(team) + '</td></tr>' +
          '<tr><td colspan="2" style="height:10px;font-size:0;line-height:0">&nbsp;</td></tr>' +
          '<tr><td width="28" valign="top" style="padding:2px 0 0"><div style="width:20px;height:20px;border-radius:50%;background:#3D5BA6;color:#ffffff;text-align:center;line-height:20px;font-size:12px;font-weight:700">&#10003;</div></td><td style="padding:1px 0 0 10px;font-size:14px;line-height:1.5;color:#1B2536">Bring a copy of your ID</td></tr>' +
          '<tr><td colspan="2" style="height:10px;font-size:0;line-height:0">&nbsp;</td></tr>' +
          '<tr><td width="28" valign="top" style="padding:2px 0 0"><div style="width:20px;height:20px;border-radius:50%;background:#3D5BA6;color:#ffffff;text-align:center;line-height:20px;font-size:12px;font-weight:700">&#10003;</div></td><td style="padding:1px 0 0 10px;font-size:14px;line-height:1.5;color:#1B2536">A clear self-portrait for your email signature</td></tr>' +
        '</table></td></tr></table>' +
      // Systems chips (Property24 removed)
      sec("The systems you'll use") +
      '<div style="font-size:0;line-height:0">' +
        ['HubSpot', 'PropData', 'Flow', 'CMA', 'Dialfire'].map(function (s) {
          return '<span style="display:inline-block;background:#EDF3FB;color:#2C4682;font-size:13px;font-weight:700;padding:8px 15px;border-radius:999px;margin:0 8px 8px 0">' + htmlEsc_(s) + '</span>';
        }).join('') +
      '</div>' +
      // Who to go to
      sec('Who to go to for what') +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
        contactRow('HR, contracts & accounts', 'Lieze Joubert', 'lieze@quay1.co.za') +
        contactRow('Induction & FFC / PPRA', 'Kat Sharman', 'kat@quay1.co.za') +
        contactRow('Systems: HubSpot, logins', 'Pagan van Niekerk', 'pagan@quay1.co.za') +
        contactRow('Green Point office, keys & IT', 'Nazreen Jonathan', 'office@quay1.co.za') +
        contactRow('Observatory office, keys & IT', 'Diego Roman', 'officeadmin@quay1.co.za') +
        contactRow('Sales strategy & deals', 'Sheldon Keyser', 'sheldon@quay1.co.za') +
        contactRow('Residential rentals', 'Daniel Wentzel', 'daniel@quay1.co.za') +
        contactRow('Commercial', 'Kurt Dreyer', 'kurt@quay1.co.za') +
        contactRow('Marketing, signatures & boards', 'Siya Sidiki', 'siya@quay1.co.za') +
        contactRow('Engine Room (your leads)', 'Allan Tonkin', 'allan@clienthub.co.za') +
        contactRow('Legal', 'Daniel Fyfer', 'daniel@flinc.co.za', true) +
      '</table>' +
      // Office wifi ONLY (marketing kit line removed)
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0;border-radius:12px;background:#2C4682"><tr><td style="padding:16px 20px;color:#DCE6F8;font-size:14px;line-height:1.75">' +
        '<b style="color:#ffffff">Office wifi</b> &nbsp;&middot;&nbsp; <span style="font-family:\'SF Mono\',Menlo,monospace;color:#FDC503">Strat0spheric</span>' +
      '</td></tr></table>' +
      '<p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:#5A6B85;border-top:1px solid #E3E9F2;padding-top:20px">Any question at all, big or small, just reply to this email. We cannot wait to see you thrive with us.</p>' +
      '<p style="margin:22px 0 0;font-size:15px;color:#1B2536">Warmly,</p>' +
      '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:#3D5BA6">The ' + htmlEsc_(company.name) + ' Team</p>' +
    '</td></tr>' +
    '<tr><td style="background:#2E4680;padding:24px 40px 26px;text-align:center">' +
      '<div style="font-size:13px;color:#ffffff;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin:0 0 3px">' + htmlEsc_(company.name) + '</div>' +
      '<div style="font-size:12px;color:#98C5ED;font-style:italic">Navigating Success</div></td></tr>' +
    '</table></td></tr></table>';
  return body;
}

/** Polite "we need a quick correction to your FICA documents" email (reason panel + re-submit button). */
function ficaDeclineHtml_(company, first, reason, ficaUrl) {
  var B = CFG.BRAND;
  var ficaBtn = ficaUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 2px"><tr><td style="border-radius:9px;background:' + B.gold + '">' +
        '<a href="' + htmlEsc_(ficaUrl) + '" style="display:inline-block;padding:12px 22px;font-size:14.5px;font-weight:700;color:' + B.goldInk + ';text-decoration:none;border-radius:9px">Re-submit my FICA documents</a>' +
      '</td></tr></table>'
    : '';
  var inner =
    '<p style="margin:0 0 12px;font-size:17px;font-weight:700;color:' + B.goldInk + '">Hi ' + htmlEsc_(first) + ',</p>' +
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.62;color:' + B.slate + '">Thank you for submitting your FICA documents to ' +
      htmlEsc_(company.name) + '. We just need a quick correction before we can finalise everything. Please do not worry, this is a common step and is easy to sort out.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr><td style="padding:14px 16px">' +
      '<div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:' + B.amber + ';margin:0 0 8px">What needs correcting</div>' +
      '<div style="font-size:14px;line-height:1.6;color:' + B.slate + '">' + htmlEsc_(reason || '') + '</div>' +
    '</td></tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">Once you have made the correction, please re-submit using your personal, secure link below.</p>' +
    ficaBtn +
    '<p style="margin:16px 0 0;font-size:15px;line-height:1.62;color:' + B.slate + '">If anything is unclear, simply reply to this email and we will gladly help.</p>' +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Warm regards,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, 'FICA correction needed', inner);
}
