/**
 * Signatures.js - host a new starter's Canva-made email-signature banner on Drive (public, anyone-
 * with-link, exactly like the existing Quay signatures) and draft the "here is your email signature"
 * email to their Quay1 address, in the same format Siya sends.
 *
 * Banner GENERATION is done Claude-in-the-loop via the Canva template (name/title/photo swap); this
 * module does the two things Apps Script is best placed for: HOSTING the exported PNG and DRAFTING
 * the email. Runs as pagan@ (has Drive quota + Gmail), so the draft lands in pagan@'s Drafts to send.
 */

var SIG_BANNER_FOLDER = 'Email Signature Banners';   // Drive folder the hosted banners live in

// Office -> address line (from the live signatures). Extend as needed.
var SIG_OFFICES = {
  greenpoint: 'Head Office: Unit 10, Portside Building, Main Rd, Green Point, Cape Town',
  blouberg:   'Unit 1, Vision House, 55 Blaauwberg Rd, Bloubergstrand, Cape Town',
  bellville:  'Office 203, Edward III, 70 Edward Road, Bellville',
  muizenberg: 'Unit 3, Brockford House, 120 Main Rd, Muizenberg',
};

/**
 * Fetch an image from a public URL (e.g. the Canva PNG export), save it into the banners folder,
 * make it anyone-with-link VIEW, and return the embeddable lh3 URL (same shape the live sigs use).
 */
function hostSignatureBanner_(sourceUrl, filename) {
  var folders = DriveApp.getFoldersByName(SIG_BANNER_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(SIG_BANNER_FOLDER);
  var blob = UrlFetchApp.fetch(sourceUrl, { muteHttpExceptions: true }).getBlob().setName(filename);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

/** Build the signature HTML block (Siya's format). p = {area, cell, email, office, bannerUrl}. */
function signatureHtml_(p) {
  var C = '#0b5394';
  var addr = SIG_OFFICES[p.office] || p.office || '';
  return '' +
    '<div dir="ltr" style="font-family:Arial,sans-serif;font-size:13px;line-height:1.45">' +
      '<div style="color:' + C + '">Kind regards,</div>' +
      '<div style="margin:4px 0"><img src="' + p.bannerUrl + '" width="420" height="120" ' +
        'alt="Quay 1" style="display:block;border:0;outline:0"></div>' +
      '<div><b><span style="color:' + C + '">' + p.area + '</span></b></div>' +
      '<div><span style="color:' + C + '">' + p.cell + '</span> | ' +
        '<a href="mailto:' + p.email + '" style="color:' + C + '">' + p.email + '</a></div>' +
      '<div><span style="color:' + C + '">' + addr + '</span></div>' +
      '<div><span style="color:' + C + '">+27 21 426 4848 | </span>' +
        '<a href="https://www.quay1.co.za/" style="color:' + C + '">www.quay1.co.za</a></div>' +
    '</div>';
}

var SIG_VIDEO_GUIDE = 'https://drive.google.com/file/d/1yDdZh5IEDH5JG0PgePXWjE8nE8MQ8d3n/view?usp=drive_link';
var SIG_BLUE_REF = 'https://i.imgur.com/xtyWRpw.png';

/** The step-by-step "how to set up your signature" instructions (Siya's exact guide). */
function sigSetupStepsHtml_() {
  var steps = [
    'Copy your email signature above [&#8984; / Ctrl - C (or right-click copy)] (between the lines).',
    'Open your Quay 1 Gmail account.',
    'Go to Settings (top right corner of your screen - gear icon).',
    'Click on &quot;See all settings&quot; at the top.',
    'On the \'General\' tab - scroll down to near the bottom.',
    'Stop at the Signature box and click on \'+ Create New\' to make a new signature.',
    'Press the \'Enter\' key on your keyboard twice [Optional].',
    'Now press &#8984; / Ctrl - V (or right-click paste) to paste in your copied email signature.',
    'Make sure the text colour is the correct blue (as seen <a href="' + SIG_BLUE_REF + '">here</a>).',
    'Make sure the photo (click on it) is selected to size &quot;Large&quot;.',
    'Scroll down, under &quot;Signature defaults&quot;, select the email signature name for both ' +
      '&quot;New emails use&quot; &amp; &quot;On reply/forward use&quot;.',
    'Scroll to the bottom, click \'Save changes\', and please reply to me with a confirmation email of ' +
      '&quot;done&quot; so I can check everything is in order!'
  ];
  var li = steps.map(function (s) { return '<li style="margin:5px 0">' + s + '</li>'; }).join('');
  return '<p>Follow these steps to change your email signature; alternatively, you may watch the linked ' +
    '<a href="' + SIG_VIDEO_GUIDE + '">video guide</a>:</p><ol>' + li + '</ol>';
}

/** Draft the "here is your signature" email to the starter (Siya's exact format + setup steps). */
function draftSignatureEmail_(p) {
  var sig = signatureHtml_(p);
  var line = '<div style="border-top:1px solid #cccccc;margin:12px 0"></div>';
  var body = '' +
    '<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.45;color:#222222">' +
      '<p>Hi ' + p.first + '!</p>' +
      '<p>Welcome aboard - please find your new Quay 1 email signature below. Follow the steps beneath ' +
      'it to set it up on your Quay 1 Gmail account.</p>' +
      line + sig + line +
      sigSetupStepsHtml_() +
      '<p>Please let me know if there\'s an error or if you need any assistance!</p>' +
      '<p>Thanks,<br>The Quay 1 Team</p>' +
    '</div>';
  draftMail_(p.email, p.first + ' - Your Quay 1 Email Signature',
    'Please view the HTML version of this email to copy your signature.',
    { htmlBody: body, name: 'Quay 1' });
  return 'Signature draft created for ' + p.email + ' (banner: ' + p.bannerUrl + ')';
}

/** Decode a base64 PNG, save it to the banners folder (anyone-with-link), return the lh3 URL. */
function hostBannerFromBase64_(b64, filename) {
  var folders = DriveApp.getFoldersByName(SIG_BANNER_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(SIG_BANNER_FOLDER);
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/png', filename);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://lh3.googleusercontent.com/d/' + file.getId();
}

/**
 * TRIAL: host Sheldon's banner (built from his real FICA-style headshot, embedded as base64 in
 * SheldonBannerData.js) + draft his signature email. Run once from the editor. Idempotent-ish:
 * trashes any prior Sheldon signature draft first so re-runs don't pile up duplicates.
 */
function draftSheldonSignatureTrial() {
  try {
    GmailApp.search('in:drafts subject:"Your Quay 1 Email Signature" Sheldon')
      .forEach(function (t) { t.moveToTrash(); });
  } catch (e) { /* nothing to clear */ }
  var url = hostBannerFromBase64_(_sheldonBannerB64_(), 'Sheldon Keyser - Email Signature Banner.png');
  return draftSignatureEmail_({
    first: 'Sheldon', area: 'Camps Bay', cell: '+27 82 619 9484',
    email: 'sheldon@quay1.co.za', office: 'greenpoint', bannerUrl: url,
  });
}
