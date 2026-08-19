/**
 * HubSpotLogins.js - one-off request emailer for team HubSpot login details.
 *
 * NOT part of the automated onboarding pipeline. Reads the "HubSpot Logins" tab on the tracker and
 * emails each team a personalised request for their HubSpot password + who the 2FA code goes to (the
 * username is already filled from the HubSpot export). Run from the Apps Script editor Run menu:
 *   previewHubSpotLoginRequests()  -> creates ONE Gmail DRAFT (to yourself) to eyeball the email.
 *   sendHubSpotLoginRequests()     -> SENDS to every team not yet marked "Details updated?".
 *
 * This is a deliberate, user-triggered bulk send (an explicit exception to the draft-only rule - the
 * user asked for it). Reply-To is the Claude-connected mailbox so replies can be read back and
 * written into the sheet automatically.
 */

var HS_LOGINS_TAB = 'HubSpot Logins';
// Reply-To is helper@quay1.co.za (a professional-looking ALIAS of claude@quay1.co.za). Teams reply
// to helper@, which is delivered into the claude@ mailbox, so replies can be read back into the sheet.
var HS_REPLY_TO = 'helper@quay1.co.za';
// Deadline shown in the SUBJECT + body of the manual initial/reminder sends. Update this per round
// before sending. (The quarterly auto-send ignores it and computes its own date - see below.)
var HS_DEADLINE = 'Tuesday 11 August';
// Where the preview drafts land (the operator runs this from the editor). Hardcoded to avoid the
// Session.getEffectiveUser() userinfo.email scope, which this project does not grant.
var HS_PREVIEW_TO = 'pagan@quay1.co.za';

function _hsLoginsTab_() {
  return SpreadsheetApp.openById(prop_(PROP.TRACKER_SHEET_ID, true)).getSheetByName(HS_LOGINS_TAB);
}

/** Read the tab into [{row, team, division, username, updated}] (skips blank team rows). */
function _hsLoginRows_() {
  var sh = _hsLoginsTab_();
  if (!sh) throw new Error('"' + HS_LOGINS_TAB + '" tab not found');
  var vals = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i];
    var team = String(r[0] || '').trim();
    if (!team) continue;
    out.push({
      row: i + 1, team: team, division: String(r[1] || '').trim(),
      username: String(r[2] || '').trim(), updated: String(r[5] || '').trim(),
    });
  }
  return out;
}

function _hsSubject_(team, deadline) {
  return 'Action needed by ' + (deadline || HS_DEADLINE) + ': confirm your ' + team + "'s HubSpot login details";
}

function _hsBody_(team, username) {
  return 'Hi ' + team + ' team,\n\n' +
    'As part of formalising our onboarding and account processes, we are confirming every team\'s ' +
    'HubSpot login so access is never lost when people join or move teams.\n\n' +
    'We have your HubSpot username on file:\n  ' + (username || '(not on file)') + '\n\n' +
    'Please reply to this email by close of business on ' + HS_DEADLINE + ' with:\n' +
    '  1. Your HubSpot password\n' +
    '  2. Who the login / verification code should go to (name of the person who receives it)\n\n' +
    'If we do not have these by ' + HS_DEADLINE + ', we will update the login details ourselves so ' +
    'that your team\'s HubSpot access is properly accounted for, as this now forms part of our ' +
    'standard onboarding process.\n\n' +
    'Thanks,\nThe Quay 1 Team';
}

/** Quarterly re-verification wording: a light "confirm or update" ask, not a first-time request. */
function _hsRefreshBody_(team, username, deadline) {
  return 'Hi ' + team + ' team,\n\n' +
    'This is our quarterly HubSpot access check, to keep our records current as people join or move ' +
    'teams.\n\n' +
    'We have your HubSpot username on file:\n  ' + (username || '(not on file)') + '\n\n' +
    'Please reply by close of business on ' + (deadline || HS_DEADLINE) + ' to confirm (or update) two things:\n' +
    '  1. Your current HubSpot password\n' +
    '  2. Who the login / verification code should go to (name of the person who receives it)\n\n' +
    'If nothing has changed since last time, a quick "no change" reply is perfect.\n\n' +
    'Thanks,\nThe Quay 1 Team';
}

/**
 * One-off: add helper@quay1.co.za as an alias of claude@quay1.co.za so team replies to helper@ land
 * in the Claude-connected mailbox (for the auto sheet update). Run once from the editor by a Workspace
 * admin. Idempotent-ish: a duplicate alias just returns the API's "already exists" error, harmlessly.
 */
function addHelperAlias() {
  var user = 'claude@quay1.co.za', alias = 'helper@quay1.co.za';
  var msg;
  try {
    AdminDirectory.Users.Aliases.insert({ alias: alias }, user);
    msg = 'OK: added alias ' + alias + ' -> ' + user + '. Allow a few minutes to propagate.';
  } catch (e) {
    msg = 'NOT ADDED (' + String(e) + '). If this says the alias/entity already exists, it is already set up.';
  }
  Logger.log(msg);   // visible in the execution log
  return msg;
}

/** List the aliases currently on claude@quay1.co.za (verify helper@ is present). */
function listClaudeAliases() {
  var u = AdminDirectory.Users.get('claude@quay1.co.za', { fields: 'aliases,primaryEmail' });
  var msg = 'primary: ' + u.primaryEmail + ' | aliases: ' + JSON.stringify(u.aliases || []);
  Logger.log(msg);
  return msg;
}

/** Preview: create ONE draft (to yourself) using the first team, to check the exact email. No send. */
function previewHubSpotLoginRequests() {
  var rows = _hsLoginRows_();
  if (!rows.length) throw new Error('no teams found in "' + HS_LOGINS_TAB + '"');
  var t = rows[0];
  draftMail_(HS_PREVIEW_TO, _hsSubject_(t.team), _hsBody_(t.team, t.username),
    { name: 'Quay 1', replyTo: HS_REPLY_TO });
  return 'Preview draft created for team "' + t.team + '". Check your Gmail Drafts before running sendHubSpotLoginRequests().';
}

/**
 * SEND a personalised request to every team NOT already marked "Details updated?" (column F).
 * Deliberate, user-triggered bulk send. Idempotent-ish: a team marked updated is skipped, so a
 * re-run only chases the teams still outstanding. Returns a summary string (shown in the editor).
 */
function sendHubSpotLoginRequests() {
  var rows = _hsLoginRows_();
  var sent = 0, skipped = 0, noEmail = 0;
  rows.forEach(function (t) {
    if (t.updated) { skipped++; return; }             // already responded / done
    if (!isEmail_(t.username)) { noEmail++; return; }  // no valid team email to send to
    sendMail_(t.username, _hsSubject_(t.team), _hsBody_(t.team, t.username),
      { name: 'Quay 1', replyTo: HS_REPLY_TO });
    sent++;
  });
  var msg = 'HubSpot login requests: sent ' + sent + ', skipped ' + skipped +
    ' (already updated), no-email ' + noEmail + '.';
  logAudit_('hubspot_login_requests_sent', { sent: sent, skipped: skipped, noEmail: noEmail });
  return msg;
}

/** Friendly-reminder wording for teams that have not yet responded. */
function _hsReminderBody_(team, username) {
  return 'Hi ' + team + ' team,\n\n' +
    'Just a friendly reminder on this one - we have not yet had your HubSpot login details back.\n\n' +
    'We have your HubSpot username on file:\n  ' + (username || '(not on file)') + '\n\n' +
    'When you have a moment, please reply by close of business on ' + HS_DEADLINE + ' with:\n' +
    '  1. Your HubSpot password\n' +
    '  2. Who the login / verification code should go to (name of the person who receives it)\n\n' +
    'This just helps us keep every team\'s HubSpot access properly accounted for. Thank you!\n\n' +
    'Thanks,\nThe Quay 1 Team';
}

/**
 * SEND a friendly reminder to every team NOT yet marked "Details updated?" (column F).
 * Same audience as a re-run of sendHubSpotLoginRequests() but with gentler reminder wording.
 * Deliberate, user-triggered bulk send. Run previewHubSpotLoginReminder() first to eyeball it.
 */
function sendHubSpotLoginReminders() {
  var rows = _hsLoginRows_();
  var sent = 0, skipped = 0, noEmail = 0;
  rows.forEach(function (t) {
    if (t.updated) { skipped++; return; }
    if (!isEmail_(t.username)) { noEmail++; return; }
    sendMail_(t.username, 'Reminder: ' + _hsSubject_(t.team), _hsReminderBody_(t.team, t.username),
      { name: 'Quay 1', replyTo: HS_REPLY_TO });
    sent++;
  });
  var msg = 'HubSpot login reminders: sent ' + sent + ', skipped ' + skipped +
    ' (already updated), no-email ' + noEmail + '.';
  logAudit_('hubspot_login_reminders_sent', { sent: sent, skipped: skipped, noEmail: noEmail });
  return msg;
}

/** Preview the reminder: one draft to yourself using the first outstanding team. No send. */
function previewHubSpotLoginReminder() {
  var rows = _hsLoginRows_();
  var t = null;
  for (var i = 0; i < rows.length; i++) { if (!rows[i].updated && isEmail_(rows[i].username)) { t = rows[i]; break; } }
  if (!t) throw new Error('no outstanding teams to remind');
  draftMail_(HS_PREVIEW_TO, 'Reminder: ' + _hsSubject_(t.team),
    _hsReminderBody_(t.team, t.username), { name: 'Quay 1', replyTo: HS_REPLY_TO });
  return 'Reminder preview draft created for team "' + t.team + '". Check Gmail Drafts, then run sendHubSpotLoginReminders().';
}

// ---------------------------------------------------------------- quarterly re-verification (every 3 months)
// Reply CAPTURE stays MANUAL (operator reads the helper@ replies each cycle and updates the sheet).
// This half only automates the SEND, so records get re-confirmed every quarter.

/**
 * Trigger target. Installed as a monthly trigger but only acts in Feb/May/Aug/Nov (quarterly,
 * anchored to the Aug-2026 first round). Sends the "confirm or update" ask to EVERY team, ignoring
 * the Details-updated flag, so login records are re-verified each quarter. Does not mutate the sheet.
 */
function quarterlyHubSpotLoginRefresh() {
  var m = new Date().getMonth() + 1;              // 1..12, in the script's timezone
  if ([2, 5, 8, 11].indexOf(m) < 0) return;       // monthly trigger; act only on quarter boundaries
  // Dynamic deadline ~7 days out, so this recurring send never ships a stale hardcoded date.
  var dl = Utilities.formatDate(new Date(new Date().getTime() + 7 * 24 * 3600 * 1000),
    Session.getScriptTimeZone(), 'EEEE d MMMM');
  var rows = _hsLoginRows_();
  var sent = 0, noEmail = 0;
  rows.forEach(function (t) {
    if (!isEmail_(t.username)) { noEmail++; return; }
    sendMail_(t.username, _hsSubject_(t.team, dl), _hsRefreshBody_(t.team, t.username, dl),
      { name: 'Quay 1', replyTo: HS_REPLY_TO });
    sent++;
  });
  var msg = 'Quarterly HubSpot login refresh (month ' + m + '): sent ' + sent + ', no-email ' + noEmail + '.';
  logAudit_('hubspot_login_quarterly_refresh', { sent: sent, noEmail: noEmail, month: m });
  return msg;
}

/**
 * Run ONCE from the editor to install the quarterly trigger. Fires on the 1st of every month ~08:00
 * (Africa/Johannesburg); quarterlyHubSpotLoginRefresh() no-ops except in Feb/May/Aug/Nov. Idempotent:
 * removes any prior copy of this trigger first.
 */
function installHubSpotQuarterlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'quarterlyHubSpotLoginRefresh') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('quarterlyHubSpotLoginRefresh').timeBased().onMonthDay(1).atHour(8).create();
  return 'Installed quarterly HubSpot login trigger (1st of month ~08:00; sends only in Feb/May/Aug/Nov).';
}
