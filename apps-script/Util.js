/**
 * Util.js - pure, dependency-free helpers used everywhere. No business logic; no Sheet or
 * network access beyond what a helper trivially needs. Keep it small.
 *
 * Owner: backend.
 *
 * Public surface:
 *   jsonOut_(obj)                - TextOutput  JSON response with mimeType JSON (for doPost).
 *   textOut_(str)                - TextOutput  text/plain response.
 *   uid_(prefix)                 - String      unique id, e.g. uid_('OFF') => 'OFF-<ts>-<rand>'.
 *   nowIso_()                    - String      ISO-8601 UTC timestamp.
 *   plusMinutesIso_(iso, mins)   - String      iso shifted by mins (for fire_at = +30).
 *   firstName_(fullName)         - String      first token of a name.
 *   lastName_(fullName)          - String      remaining tokens (multi-word surnames kept).
 *   safeJsonParse_(str, fallback)- any         JSON.parse or fallback on error.
 *   htmlEsc_(s)                  - String      escape &<>" for safe HTML interpolation.
 *   fmtDate_(s)                  - String      "5 March 2026" long-form date, or input verbatim.
 *   fmtRemuneration_(v)          - String      normalise a rand amount to "R8,000.00".
 *   isEmail_(s)                  - Boolean     basic email shape check.
 *   logAudit_(kind, detail)      - void        Logger.log a structured audit line.
 *
 * No em/en dashes in any string this file emits.
 */

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function textOut_(str) {
  return ContentService.createTextOutput(String(str == null ? '' : str))
    .setMimeType(ContentService.MimeType.TEXT);
}

/** Unique id: "<prefix>-<base36 ms>-<4 random chars>". Prefix defaults to 'ID'. */
function uid_(prefix) {
  var p = String(prefix || 'ID');
  var t = Date.now().toString(36);
  var r = Math.random().toString(36).slice(2, 6);
  return p + '-' + t + '-' + r;
}

function nowIso_() { return new Date().toISOString(); }

/** Return `iso` (or now if blank/invalid) shifted forward by `mins` minutes, as ISO. */
function plusMinutesIso_(iso, mins) {
  var base = iso ? new Date(iso) : new Date();
  if (isNaN(base.getTime())) base = new Date();
  return new Date(base.getTime() + (Number(mins) || 0) * 60 * 1000).toISOString();
}

/** First token of a full name; 'there' when blank. */
function firstName_(fullName) {
  var parts = String(fullName == null ? '' : fullName).trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : 'there';
}

/** Everything after the first token (multi-word surnames preserved); '' when none. */
function lastName_(fullName) {
  var parts = String(fullName == null ? '' : fullName).trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

function safeJsonParse_(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function htmlEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "5 March 2026" from an ISO/date string; returns the input verbatim if unparseable. */
function fmtDate_(s) {
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

/** Normalise a rand amount to "R8,000.00". Non-numeric input passes through verbatim. */
function fmtRemuneration_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var num = s.replace(/[Rr\s,]/g, '');
  if (num === '' || isNaN(Number(num))) return s;
  var n = Number(num);
  var parts = n.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return 'R' + parts[0] + '.' + parts[1];
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s == null ? '' : s).trim());
}

/** Structured audit line to Stackdriver/Logger. Kept dependency-free (no Sheet write). */
function logAudit_(kind, detail) {
  try {
    Logger.log('[audit] ' + nowIso_() + ' ' + String(kind) + ' ' +
      (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  } catch (e) { /* logging must never throw into a handler */ }
}

// ---------------------------------------------------------------- concurrency lock
// This is a STANDALONE web app (not container-bound), so LockService.getDocumentLock() returns
// null and .waitLock() throws. getScriptLock() is the correct one. _LOCK_DEPTH makes the lock
// reentrant within a single execution: a locked writer (e.g. approveAndProvision_) may call another
// locked writer (enqueueProvision_) without dead-locking on the same non-reentrant script lock.
var _LOCK_DEPTH = 0;

/** Acquire the script lock, reentrant-safe + standalone-safe. Mirrors the Lock API (waitLock /
 *  releaseLock) so call sites read unchanged. A nested acquire in the same execution is a no-op
 *  that still balances on release; the real lock is taken once at the outermost level. */
function _acquireLock_() {
  var reentrant = _LOCK_DEPTH > 0;
  _LOCK_DEPTH++;
  var real = reentrant ? null : LockService.getScriptLock();
  return {
    waitLock: function (ms) { if (real) real.waitLock(ms); },
    releaseLock: function () { _LOCK_DEPTH--; if (real) real.releaseLock(); },
  };
}

// --------------------------------------------------------------------------- outbound mail identity
/**
 * Apply the shared outbound-sender identity to a GmailApp options object. When the OUTBOUND_FROM
 * Script Property is set (a verified "Send mail as" alias on the account that runs this script),
 * ALL app mail goes out as CFG.OUTBOUND_NAME <that address> with a matching Reply-To. Left UNSET,
 * the options are returned unchanged, so mail keeps sending from the executing account (current
 * behaviour) - safe to deploy before the alias exists; arming is a one-line property change.
 * Any Reply-To already on the options (e.g. the HubSpot login reply-to) is preserved.
 */
function mailIdentity_(opts) {
  var o = opts || {};
  var from = optProp_(PROP.OUTBOUND_FROM);
  if (!from) return o;
  o.from = from;
  o.name = CFG.OUTBOUND_NAME || o.name;
  if (!o.replyTo) o.replyTo = from;
  return o;
}

/** GmailApp.sendEmail through the shared sender identity (mailIdentity_). Same signature. */
function sendMail_(to, subject, body, opts) {
  return GmailApp.sendEmail(to, subject, body, mailIdentity_(opts || {}));
}

/** GmailApp.createDraft through the shared sender identity (mailIdentity_). Same signature. */
function draftMail_(to, subject, body, opts) {
  return GmailApp.createDraft(to, subject, body, mailIdentity_(opts || {}));
}
