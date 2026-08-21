/**
 * Queue.js - the shared bus. All reads/writes of the Provisioning Queue and Offboarding Queue
 * tabs go through here. This module OWNS the column layout and mirrors the exact field order
 * from docs/CONTRACTS.md sections 1-3. Backend and worker must not drift from it.
 *
 * Owner: backend. Frozen schema: docs/CONTRACTS.md.
 *
 * Column maps (0-based index into the row array; letters per CONTRACTS):
 *   PQ_COL  A..N   queue_id folderId full_name first_name id_number quay_email cell system
 *                  action payload_json status result_json attempts updated_at
 *   OQ_COL  A..K   offb_id full_name quay_email requested_by requested_at fire_at systems_json
 *                  status google_result worker_result_json trigger_id
 *
 * Public surface:
 *   PQ_COL / OQ_COL / PQ_HEADERS / OQ_HEADERS   - the frozen maps + header rows.
 *   ensureQueueTabs_(sh)                        - create/repair both queue tab headers.
 *   enqueueProvision_(pq)                       - String queue_id   append one PQ row.
 *   enqueueDeactivate_(email, system, payload)  - String|null   guarded deactivate append.
 *   readQueue_(tabName)                         - Array<Object>  rows as objects.
 *   readForUi_(ctx)                             - Object   status snapshot (broker-scoped).
 *   writeProvisionStatus_(queue_id, status, result) - void  set K/L/N by queue_id.
 *   retryRow_(queue_id, ctx)                    - void   super-only: error -> pending.
 *   writeOffboard_(oq)                          - String offb_id   append one OQ row.
 *   setOffboardStatus_(offb_id, status, googleResult, workerResult) - void  set H/I/J.
 *   setOffboardTrigger_(offb_id, triggerId)     - void   set K after the trigger is created.
 *   readOffboard_()                             - Array<Object>  all OQ rows.
 */

var PQ_COL = {
  queue_id: 0, folderId: 1, full_name: 2, first_name: 3, id_number: 4, quay_email: 5,
  cell: 6, system: 7, action: 8, payload_json: 9, status: 10, result_json: 11,
  attempts: 12, updated_at: 13,
};
var PQ_HEADERS = ['queue_id', 'folderId', 'full_name', 'first_name', 'id_number', 'quay_email',
  'cell', 'system', 'action', 'payload_json', 'status', 'result_json', 'attempts', 'updated_at'];

var OQ_COL = {
  offb_id: 0, full_name: 1, quay_email: 2, requested_by: 3, requested_at: 4, fire_at: 5,
  systems_json: 6, status: 7, google_result: 8, worker_result_json: 9, trigger_id: 10,
};
var OQ_HEADERS = ['offb_id', 'full_name', 'quay_email', 'requested_by', 'requested_at',
  'fire_at', 'systems_json', 'status', 'google_result', 'worker_result_json', 'trigger_id'];

/** Ensure both queue tabs exist with a header row. Called by setupHub. */
function ensureQueueTabs_(sh) {
  _ensureTab_(sh, CFG.TAB.PROVISION_QUEUE, PQ_HEADERS);
  _ensureTab_(sh, CFG.TAB.OFFBOARD_QUEUE, OQ_HEADERS);
}

function _ensureTab_(sh, name, headers) {
  var t = sh.getSheetByName(name) || sh.insertSheet(name);
  t.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  t.setFrozenRows(1);
  return t;
}

function _pqTab_() { return tab_(CFG.TAB.PROVISION_QUEUE); }
function _oqTab_() { return tab_(CFG.TAB.OFFBOARD_QUEUE); }

/** Write an array of cells as text so ids / leading zeros survive. */
function _appendTextRow_(t, values) {
  var row = t.getLastRow() + 1;
  t.getRange(row, 1, 1, values.length).setNumberFormat('@')
    .setValues([values.map(function (v) { return String(v == null ? '' : v); })]);
  return row;
}

// ---------------------------------------------------------------- Provisioning Queue

/**
 * Append one Provisioning Queue row. `pq` fields: folderId, full_name, first_name, id_number,
 * quay_email, cell, system, action, payload (object), status (caller decides: INLINE_SYSTEMS
 * done/error, WORKER_SYSTEMS pending), result (object|optional). Returns the generated queue_id.
 */
function enqueueProvision_(pq) {
  var lock = _acquireLock_();
  lock.waitLock(20000);
  try {
    var t = _pqTab_();
    var ts = Date.now().toString(36);
    var queueId = 'PQ-' + (pq.folderId || 'x') + '-' + (pq.system || 'x') + '-' + ts;
    var rowArr = [];
    rowArr[PQ_COL.queue_id] = queueId;
    rowArr[PQ_COL.folderId] = pq.folderId || '';
    rowArr[PQ_COL.full_name] = pq.full_name || '';
    rowArr[PQ_COL.first_name] = pq.first_name || '';
    rowArr[PQ_COL.id_number] = pq.id_number || '';
    rowArr[PQ_COL.quay_email] = pq.quay_email || '';
    rowArr[PQ_COL.cell] = pq.cell || '';
    rowArr[PQ_COL.system] = pq.system || '';
    rowArr[PQ_COL.action] = pq.action || 'create';
    rowArr[PQ_COL.payload_json] = JSON.stringify(pq.payload || {});
    rowArr[PQ_COL.status] = pq.status || 'pending';
    rowArr[PQ_COL.result_json] = JSON.stringify(pq.result || {});
    rowArr[PQ_COL.attempts] = '0';
    rowArr[PQ_COL.updated_at] = nowIso_();
    _appendTextRow_(t, rowArr);
    return queueId;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Append a `deactivate` row for a browser system, GUARDED: skip (return null) when an open
 * (pending or in_progress) deactivate row already exists for the same (email, system). Used by
 * offboarding so a re-fire does not double-enqueue.
 */
function enqueueDeactivate_(email, system, payload) {
  // The dup-guard (check) and the append must be ONE critical section, else two overlapping
  // offboarding fires could both pass the check and double-enqueue (TOCTOU). A script lock
  // serialises them; enqueueProvision_'s own document lock still guards the raw append.
  var lock = _acquireLock_();
  lock.waitLock(20000);
  try {
    var rows = readQueue_(CFG.TAB.PROVISION_QUEUE);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.system === system && r.action === 'deactivate' &&
          String(r.quay_email) === String(email) &&
          (r.status === 'pending' || r.status === 'in_progress')) {
        return null; // already queued, idempotent
      }
    }
    return enqueueProvision_({
      quay_email: email, system: system, action: 'deactivate',
      payload: payload || {}, status: 'pending',
    });
  } finally {
    lock.releaseLock();
  }
}

/** All rows of a queue tab as objects keyed by that tab's column map. */
function readQueue_(tabName) {
  var isPq = (tabName === CFG.TAB.PROVISION_QUEUE);
  var map = isPq ? PQ_COL : OQ_COL;
  var t = tab_(tabName);
  var last = t.getLastRow();
  if (last < 2) return [];
  var width = isPq ? PQ_HEADERS.length : OQ_HEADERS.length;
  var vals = t.getRange(2, 1, last - 1, width).getValues();
  return vals.map(function (r, i) {
    var o = { _row: i + 2 };
    Object.keys(map).forEach(function (k) { o[k] = String(r[map[k]] || ''); });
    return o;
  }).filter(function (o) { return o[isPq ? 'queue_id' : 'offb_id']; });
}

/**
 * Status-screen snapshot: provisioning rows + offboarding rows. Brokers (not super/admin) are
 * scoped to their own candidates by matching the Onboarding row's requester_email.
 */
function readForUi_(ctx) {
  var pq = readQueue_(CFG.TAB.PROVISION_QUEUE);
  var oq = readQueue_(CFG.TAB.OFFBOARD_QUEUE);
  var isAdmin = ctx && ctx.role && (ctx.role.is_super || ctx.role.is_admin);
  var email = ctx && ctx.email ? String(ctx.email).toLowerCase() : '';
  // The candidate pipeline: onboarded people not yet set up, so admins can review + Approve & set up.
  // Scoped to a broker's own candidates for non-admins.
  var onboarding = _onboardingPipeline_(isAdmin, email, pq);
  if (!isAdmin && email) {
    // Scope the provisioning queue to ALL of the broker's own candidates (by requester_email), NOT the
    // pipeline - the pipeline excludes already-provisioned rows, but their queue rows must still show.
    var mine = {};
    listOnboarding_().forEach(function (o) {
      if (String(o.requester_email).toLowerCase() === email) mine[o.folderId] = true;
    });
    pq = pq.filter(function (r) { return mine[r.folderId]; });
    oq = []; // offboarding is admin-only visibility
  }
  // Candidates who have BOOKED an induction week - the audience for the "Resend induction packet"
  // action on the Progress report (they are already provisioned, so they are off the pipeline above).
  var booked = _bookedForResend_(isAdmin, email);
  // `rows` is the alias the status UI reads (TEST-REPORT drift 4); provisioning/offboarding are
  // kept as explicit keys for any caller that wants them split. `onboarding` drives the approval UI.
  return { ok: true, rows: pq, provisioning: pq, offboarding: oq, onboarding: onboarding, booked: booked };
}

/** Onboarded people who have BOOKED an induction week (induction_wed/thu set), so an admin can resend
 *  their induction packet from the Progress report. Non-admins see only candidates they onboarded. */
function _bookedForResend_(isAdmin, email) {
  var out = [];
  listOnboarding_().forEach(function (o) {
    if (!o.induction_wed && !o.induction_thu) return;   // only once a week is booked
    if (!isAdmin && email && String(o.requester_email).toLowerCase() !== email) return;
    out.push({
      folderId: o.folderId, name: o.name, team: o.team, entity: o.entity || 'quay1',
      induction_wed: o.induction_wed || '', induction_thu: o.induction_thu || '', status: o.status || '',
    });
  });
  return out;
}

/**
 * The actionable onboarding pipeline for the status screen: every onboarded person not yet provisioned,
 * with their document + approval state so the UI can show a "Waiting on docs" / "Ready to approve" /
 * "Approve & set up" affordance. Non-admins see only candidates they onboarded. Provisioned rows drop
 * off (their created systems already show in the Provisioning Queue list).
 */
function _onboardingPipeline_(isAdmin, email, pq) {
  var out = [];
  // Per-folder provisioning progress, from the create rows on the Provisioning Queue. A candidate is
  // only "fully set up" (and so drops off the pipeline) when every create row is done/skipped. A row
  // still pending/in-progress -> incomplete; an errored row -> incomplete + error, so a PropData/worker
  // failure keeps the new hire VISIBLY unfinished in the pipeline instead of vanishing once Google (the
  // inline system) succeeds and stamps provisioned_at.
  var setup = {};
  (pq || []).forEach(function (r) {
    if (String(r.action) !== 'create') return;
    var st = String(r.status || '').toLowerCase();
    var s = setup[r.folderId] || { incomplete: false, error: false };
    if (st === 'error') { s.error = true; s.incomplete = true; }
    else if (st !== 'done' && st !== 'skipped') { s.incomplete = true; }
    setup[r.folderId] = s;
  });
  listOnboarding_().forEach(function (o) {
    // Existing staff imported from the old tracker are already onboarded; keep them out of the
    // active pipeline so they never appear in the tracker or surface as "ready to approve".
    if (_isMigratedLegacy_(o)) return;
    var s = setup[o.folderId] || { incomplete: false, error: false };
    // Drop only when fully set up: provisioned AND no create row is still pending or errored.
    if (o.provisioned_at && !s.incomplete) return;
    if (!isAdmin && email && String(o.requester_email).toLowerCase() !== email) return;
    var sys = safeJsonParse_(o.systems_json, null);
    if (!Array.isArray(sys)) {
      sys = resolveSystems_(o.entity || 'quay1', o.programs, null, o.team, o.activity || o.designation);
    }
    out.push({
      folderId: o.folderId, name: o.name, team: o.team, entity: o.entity || 'quay1',
      status: o.status || '',
      docs: { contract: !!o.fica_contract, id: !!o.fica_id, poa: !!o.fica_poa, bank: !!o.fica_bank },
      docs_ready: _docsReady_(o),
      approved: !!o.approved_at, approved_at: o.approved_at || '', approved_by: o.approved_by || '',
      reminded_at: o.reminded_at || '',
      // Provisioning progress so the UI can keep a hire visible until every system succeeds.
      provisioned: !!o.provisioned_at, setup_incomplete: !!s.incomplete, setup_error: !!s.error,
      // CMA is not auto-provisioned; accepting a CMA-entitled candidate emails the approvers. Surface
      // it so the Admin Check tab can warn the reviewer that accepting will send a (paid) CMA request.
      cma_entitled: sys.indexOf('cma') >= 0, cma_requested: !!o.cma_requested_at,
    });
  });
  return out;
}

/** Set K/L/N on the Provisioning Queue row matching queue_id. */
function writeProvisionStatus_(queueId, status, result) {
  var t = _pqTab_();
  var last = t.getLastRow();
  if (last < 2) return;
  var ids = t.getRange(2, PQ_COL.queue_id + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(queueId)) {
      var row = i + 2;
      t.getRange(row, PQ_COL.status + 1).setNumberFormat('@').setValue(status);
      if (result !== undefined) {
        t.getRange(row, PQ_COL.result_json + 1).setNumberFormat('@')
          .setValue(JSON.stringify(result || {}));
      }
      t.getRange(row, PQ_COL.updated_at + 1).setNumberFormat('@').setValue(nowIso_());
      return;
    }
  }
}

/** Super-only: flip an `error` Provisioning row back to `pending` so the worker retries it. */
function retryRow_(queueId, ctx) {
  requireSuper_(ctx);
  var t = _pqTab_();
  var last = t.getLastRow();
  if (last < 2) return { ok: false, error: 'not_found' };
  var vals = t.getRange(2, 1, last - 1, PQ_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][PQ_COL.queue_id]) === String(queueId)) {
      if (String(vals[i][PQ_COL.status]) !== 'error') {
        return { ok: false, error: 'not_in_error_state' };
      }
      var row = i + 2;
      t.getRange(row, PQ_COL.status + 1).setNumberFormat('@').setValue('pending');
      t.getRange(row, PQ_COL.updated_at + 1).setNumberFormat('@').setValue(nowIso_());
      return { ok: true };
    }
  }
  return { ok: false, error: 'not_found' };
}

// ---------------------------------------------------------------- Offboarding Queue

/**
 * Append one Offboarding Queue row (status scheduled). `oq` fields: full_name, quay_email,
 * requested_by, requested_at, fire_at, systems (array). Returns the generated offb_id.
 */
function writeOffboard_(oq) {
  var lock = _acquireLock_();
  lock.waitLock(20000);
  try {
    var t = _oqTab_();
    var offbId = uid_('OFF');
    var rowArr = [];
    rowArr[OQ_COL.offb_id] = offbId;
    rowArr[OQ_COL.full_name] = oq.full_name || '';
    rowArr[OQ_COL.quay_email] = oq.quay_email || '';
    rowArr[OQ_COL.requested_by] = oq.requested_by || '';
    rowArr[OQ_COL.requested_at] = oq.requested_at || nowIso_();
    rowArr[OQ_COL.fire_at] = oq.fire_at || '';
    rowArr[OQ_COL.systems_json] = JSON.stringify(oq.systems || CFG.SYSTEMS);
    rowArr[OQ_COL.status] = 'scheduled';
    rowArr[OQ_COL.google_result] = '';
    rowArr[OQ_COL.worker_result_json] = '';
    rowArr[OQ_COL.trigger_id] = '';
    _appendTextRow_(t, rowArr);
    return offbId;
  } finally {
    lock.releaseLock();
  }
}

function _findOffbRow_(t, offbId) {
  var last = t.getLastRow();
  if (last < 2) return 0;
  var ids = t.getRange(2, OQ_COL.offb_id + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(offbId)) return i + 2;
  }
  return 0;
}

/** Set status (H) and optionally google_result (I) / worker_result_json (J) on an OQ row. */
function setOffboardStatus_(offbId, status, googleResult, workerResult) {
  var t = _oqTab_();
  var row = _findOffbRow_(t, offbId);
  if (!row) return;
  if (status != null) t.getRange(row, OQ_COL.status + 1).setNumberFormat('@').setValue(status);
  if (googleResult !== undefined) {
    t.getRange(row, OQ_COL.google_result + 1).setNumberFormat('@')
      .setValue(JSON.stringify(googleResult || {}));
  }
  if (workerResult !== undefined) {
    t.getRange(row, OQ_COL.worker_result_json + 1).setNumberFormat('@')
      .setValue(JSON.stringify(workerResult || {}));
  }
}

/** Record the one-shot trigger id (K) for an OQ row. */
function setOffboardTrigger_(offbId, triggerId) {
  var t = _oqTab_();
  var row = _findOffbRow_(t, offbId);
  if (row) t.getRange(row, OQ_COL.trigger_id + 1).setNumberFormat('@').setValue(triggerId || '');
}

/** All Offboarding Queue rows as objects. */
function readOffboard_() { return readQueue_(CFG.TAB.OFFBOARD_QUEUE); }
