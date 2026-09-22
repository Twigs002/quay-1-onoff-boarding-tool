/**
 * Comms.js - the per-candidate communications log. A single append-only tab ("Comms Log") that
 * records EVERY message actually sent to a candidate: the contract/welcome email, the automatic
 * 12-hour FICA nudge, the weekly FICA reminder, the FICA-received acknowledgement, the FICA decline,
 * and the induction invite + packet.
 *
 * Why a dedicated store: logAudit_ (Util.js) only writes to the execution log and is not keyed for
 * read-back, so it cannot answer "what have we sent this person?". The Progress report candidate
 * breakdown reads this tab back via readComms_ to show a per-candidate history.
 *
 * Owner: backend. The tab is created on demand (no setupHub re-run needed). Best-effort by design -
 * a logging failure must NEVER break the send it is recording.
 *
 * Public surface:
 *   logComms_(folderId, type, to, detail, name) - void   append one row.
 *   readComms_(folderId)                        - Array  { at, type, label, to, detail } newest-first.
 */

var COMMS_HEADERS = ['At', 'Folder ID', 'Name', 'Type', 'To', 'Detail'];

/** Human label per comms `type`, shown on the breakdown. Unknown types fall back to the raw type. */
var COMMS_TYPE_LABEL = {
  contract: 'Contract + FICA link sent',
  contract_reminder: 'Contract reminder sent',
  fica_nudge: 'FICA link nudge (automatic, 12h)',
  fica_reminder: 'FICA reminder (automatic, weekly)',
  fica_received_ack: 'FICA received - acknowledgement',
  fica_declined: 'FICA declined - re-submit requested',
  induction_invite: 'Induction invite sent',
  induction_packet: 'Induction packet sent',
};

/** The Comms Log tab, created + header-seeded on first use (mirrors the Queue.js create-on-demand
 *  pattern so a missing tab never throws the way tab_() would). */
function _commsTab_() {
  var ss = sheet_();
  var t = ss.getSheetByName(CFG.TAB.COMMS_LOG);
  if (!t) {
    t = ss.insertSheet(CFG.TAB.COMMS_LOG);
    t.getRange(1, 1, 1, COMMS_HEADERS.length).setValues([COMMS_HEADERS]).setFontWeight('bold');
    t.setFrozenRows(1);
  }
  return t;
}

/**
 * Append one communication to the log. `type` is one of the COMMS_TYPE_LABEL keys; `to` is the
 * recipient address; `detail` is a short free-text note; `name` is the candidate's name (passed in
 * so this never has to re-read the Onboarding row on a hot send path). Never throws into a handler.
 */
function logComms_(folderId, type, to, detail, name) {
  try {
    _commsTab_().appendRow([
      nowIso_(), String(folderId == null ? '' : folderId), String(name == null ? '' : name),
      String(type == null ? '' : type), String(to == null ? '' : to),
      String(detail == null ? '' : detail),
    ]);
  } catch (e) {
    logAudit_('comms_log_failed', { folderId: folderId, type: type, error: String(e) });
  }
}

/** All communications for a candidate, newest-first. Returns [] if the tab is absent or empty. */
function readComms_(folderId) {
  var key = String(folderId == null ? '' : folderId);
  if (!key) return [];
  var t;
  try { t = _commsTab_(); } catch (e) { return []; }
  var last = t.getLastRow();
  if (last < 2) return [];
  var vals = t.getRange(2, 1, last - 1, COMMS_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][1]) !== key) continue;
    var at = vals[i][0];
    var iso = (at instanceof Date) ? at.toISOString() : String(at == null ? '' : at);
    var type = String(vals[i][3] || '');
    out.push({
      at: iso, type: type, label: COMMS_TYPE_LABEL[type] || type,
      to: String(vals[i][4] || ''), detail: String(vals[i][5] || ''),
    });
  }
  out.sort(function (a, b) { return (b.at || '').localeCompare(a.at || ''); });
  return out;
}
