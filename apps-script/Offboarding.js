/**
 * Offboarding.js - the offboard lifecycle. On request, writes an Offboarding Queue row and
 * schedules a one-shot +30 minute trigger. When the trigger fires, suspends the Google account
 * and tears down the rest. No cancel window (user choice). State machine: CONTRACTS section 4.
 *
 * Owner: backend. Master safety flag OFFBOARD_ARMED (default 0): while unarmed, googleSuspend_
 * records what it WOULD do but does not suspend a real account (enforced in Provisioning.js).
 *
 * Public surface:
 *   offboardRequest_(body, ctx)  - {ok, offb_id, fire_at}   requireAdmin_. Write OQ row
 *                                  scheduled, fire_at=now+30min, create the one-shot trigger,
 *                                  store its id in col K, draft (never send) a notice.
 *   fireOffboarding_()           - void  TRIGGER TARGET. Process every due scheduled row:
 *                                  guard done -> no-op; else firing -> googleSuspend_ +
 *                                  hubspotReleaseSeat_ (flag) + write google_result + enqueue
 *                                  deactivate rows for browser systems; done on success, error
 *                                  on throw. Delete the fired one-shot trigger by id.
 *   hubspotReleaseSeat_(email)   - {ok|skipped}   gated on HUBSPOT_SEAT_ENABLED (paid, default off).
 *   reapOffboarding_()           - void  TIME-DRIVEN SWEEP (installed by setupTriggers). Recovers
 *                                  rows the one-shot path could not finish: a 'scheduled' row past
 *                                  fire_at whose one-shot trigger never fired, and a 'firing' row
 *                                  stuck past OFFBOARD_FIRING_STALE_MIN (interrupted mid-fire) are
 *                                  re-fired idempotently; an 'error' row gets a DRAFT alert once
 *                                  (never auto-sent). Same DRY_RUN / OFFBOARD_ARMED gating as the
 *                                  primary path (googleSuspend_ enforces it).
 *
 * MANUAL RECOVERY: an 'error' row means a partial teardown that needs a human. The reaper drafts
 * an alert to CFG.INTERNAL_NOTIFY (Gmail Drafts, never sent). To recover: read google_result
 * (col I) for what completed, verify the Google account is suspended, confirm the Provisioning
 * Queue has the browser-system deactivate rows, then set the OQ row status to 'done'. The reaper
 * never auto-retries an 'error' row (only 'scheduled'/'firing').
 */

/**
 * Broker-initiated "Request offboarding" (kind:'offboard_notify'). Phase 1: tears NOTHING down - it
 * just emails CFG.OFFBOARD_NOTIFY (Pagan, Kat, Lieze, Sheldon) so a human actions it. Any onboarder
 * (incl. a senior broker) may raise it. Sends unconditionally (this send IS the point of the click,
 * not a CC copy, so it is not gated by ccEnabled_); wrapped so a mail failure returns a clean error.
 */
function requestOffboardNotify_(body, ctx) {
  var f = (body && body.fields) || body || {};
  var name = String(f.name || f.full_name || '').trim();
  if (!name) return { ok: false, error: 'a name is required' };
  var team = String(f.team || '').trim();
  var reason = String(f.reason || '').trim();
  var by = (ctx && (ctx.name || ctx.email)) || 'a team member';
  var to = (CFG.OFFBOARD_NOTIFY || []).filter(function (x) { return x; });
  var subject = 'Offboarding requested: ' + name + (team ? ' (' + team + ')' : '');
  var plain = 'Hi team,\n\n' + by + ' has requested that ' + name +
    (team ? ' from the ' + team + ' team' : '') + ' be offboarded.' +
    (reason ? '\n\nReason: ' + reason : '') +
    '\n\nPlease action the offboarding when you have a moment.\n\nThanks,\nThe Quay 1 On/Offboarding Tool';
  try {
    sendMail_(to.join(','), subject, plain, { name: 'Quay 1' });
    logAudit_('offboard_notify_sent', { name: name, team: team, by: by });
    return { ok: true, to: to };
  } catch (err) {
    logAudit_('offboard_notify_failed', { name: name, error: String(err) });
    return { ok: false, error: 'could not send the offboarding request: ' + String(err) };
  }
}

function offboardRequest_(body, ctx) {
  requireAdmin_(ctx);
  var f = (body && body.fields) || body || {};
  var email = String(f.quay_email || '').trim();
  if (!email) return { ok: false, error: 'quay_email is required (the Google account to suspend)' };
  var systems = Array.isArray(f.systems) && f.systems.length ? f.systems : CFG.SYSTEMS;

  var requestedAt = nowIso_();
  var fireAt = plusMinutesIso_(requestedAt, CFG.OFFBOARD_DELAY_MIN);
  var offbId = writeOffboard_({
    full_name: f.full_name || '', quay_email: email, requested_by: (ctx && ctx.email) || '',
    requested_at: requestedAt, fire_at: fireAt, systems: systems,
  });

  var trigger = ScriptApp.newTrigger('fireOffboarding_').timeBased()
    .after(CFG.OFFBOARD_DELAY_MIN * 60 * 1000).create();
  setOffboardTrigger_(offbId, trigger.getUniqueId());

  _draftOffboardNotice_({ offb_id: offbId, full_name: f.full_name || '', quay_email: email,
    requested_by: (ctx && ctx.email) || '', fire_at: fireAt, systems: systems });

  logAudit_('offboard_scheduled', { offb_id: offbId, email: email, fire_at: fireAt });
  return { ok: true, offb_id: offbId, fire_at: fireAt };
}

/**
 * Trigger target. A time trigger receives no context, so we process EVERY due scheduled row
 * (fire_at <= now), which is naturally idempotent: a re-fire of a done row is a no-op.
 */
function fireOffboarding_() {
  var now = new Date();
  readOffboard_().forEach(function (r) {
    if (r.status !== 'scheduled') return;            // done/firing/error: skip (idempotent)
    var fireAt = new Date(r.fire_at);
    if (isNaN(fireAt.getTime()) || fireAt > now) return; // not due yet
    _fireOne_(r);
    if (r.trigger_id) _deleteTriggerById_(r.trigger_id);
  });
}

/** Tear down one offboarding row. Guarded, best-effort, records partial results on error. */
function _fireOne_(r) {
  setOffboardStatus_(r.offb_id, 'firing');
  var systems = safeJsonParse_(r.systems_json, CFG.SYSTEMS) || CFG.SYSTEMS;
  var googleResult = {};
  try {
    if (systems.indexOf('google') >= 0) {
      googleResult.google = googleSuspend_(r.quay_email);
    }
    if (systems.indexOf('hubspot') >= 0) {
      googleResult.hubspot = hubspotReleaseSeat_(r.quay_email);
    }
    // Enqueue browser-system deactivations for the worker (guarded against duplicates).
    var enqueued = [];
    systems.forEach(function (s) {
      if (CFG.WORKER_SYSTEMS.indexOf(s) < 0) return;
      var id = enqueueDeactivate_(r.quay_email, s, { branch: '', reason: 'offboarding' });
      if (id) enqueued.push({ system: s, queue_id: id });
    });
    googleResult.enqueued = enqueued;
    setOffboardStatus_(r.offb_id, 'done', googleResult);
    logAudit_('offboard_done', { offb_id: r.offb_id, email: r.quay_email });
  } catch (err) {
    googleResult.error = String(err);
    setOffboardStatus_(r.offb_id, 'error', googleResult);
    logAudit_('offboard_error', { offb_id: r.offb_id, email: r.quay_email, error: String(err) });
  }
}

/** Release the HubSpot seat. Gated on HUBSPOT_SEAT_ENABLED (paid); default returns skipped. */
function hubspotReleaseSeat_(email) {
  if (!hubspotSeatEnabled_()) {
    return { ok: true, skipped: true, reason: 'HUBSPOT_SEAT_ENABLED off' };
  }
  if (DRY_RUN_()) {
    logAudit_('hubspot_seat_dryrun', { email: email });
    return { ok: true, dryRun: true, would: 'release seat ' + email };
  }
  // TODO(B5): confirm the HubSpot seats/users endpoint + scope before enabling live.
  var token = prop_(PROP.HUBSPOT_TOKEN, true);
  var res = UrlFetchApp.fetch('https://api.hubapi.com/settings/v3/users/' + encodeURIComponent(email), {
    method: 'delete', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
  });
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true, code: code };
  return { ok: false, code: code, error: res.getContentText() };
}

/**
 * Time-driven recovery sweep (installed by setupTriggers). Belt-and-braces for the one-shot
 * path: if a trigger was lost, throttled, or interrupted, an offboarding must not silently stall
 * with an ex-employee still holding access. Idempotent by construction (googleSuspend_ is
 * idempotent, enqueueDeactivate_ dedups). Same DRY_RUN / OFFBOARD_ARMED gating as fireOffboarding_.
 */
function reapOffboarding_() {
  var now = new Date();
  var staleMs = CFG.OFFBOARD_FIRING_STALE_MIN * 60 * 1000;
  readOffboard_().forEach(function (r) {
    var fireAt = new Date(r.fire_at);
    var fireAtValid = !isNaN(fireAt.getTime());
    if (r.status === 'scheduled') {
      // Due but never fired (trigger lost / errored before setting firing): fire it now.
      if (fireAtValid && fireAt <= now) {
        logAudit_('offboard_reap_scheduled', { offb_id: r.offb_id });
        _fireOne_(r);
        if (r.trigger_id) _deleteTriggerById_(r.trigger_id);
      }
    } else if (r.status === 'firing') {
      // Stuck mid-fire (interrupted). A fire completes in seconds, so past the stale window it is
      // hung; re-fire idempotently. fire_at is the proxy for when 'firing' began (trigger time).
      if (fireAtValid && (now.getTime() - fireAt.getTime()) > staleMs) {
        logAudit_('offboard_reap_stuck_firing', { offb_id: r.offb_id });
        _fireOne_(r);
        if (r.trigger_id) _deleteTriggerById_(r.trigger_id);
      }
    } else if (r.status === 'error') {
      _alertOffboardError_(r); // DRAFT once; never auto-retried
    }
  });
}

/** Draft (never send) a one-time alert for an offboarding row stuck in 'error'. The "alerted"
 *  flag is stored on worker_result_json (col J) so repeated sweeps do not re-draft. */
function _alertOffboardError_(r) {
  var prior = safeJsonParse_(r.worker_result_json, {}) || {};
  if (prior.alerted) return;
  try {
    var company = CFG.COMPANY.quay1;
    var to = CFG.INTERNAL_NOTIFY.filter(function (x) { return x; }).join(',');
    draftMail_(to, company.name + ' - offboarding FAILED (manual completion needed): ' +
      (r.full_name || r.quay_email),
      'Offboarding for ' + (r.full_name || r.quay_email) + ' (' + r.quay_email + ') ended in ERROR ' +
      'and needs manual completion.\n\n' +
      'offb_id: ' + r.offb_id + '\nrequested by: ' + r.requested_by + '\n' +
      'google_result: ' + r.google_result + '\n\n' +
      'Recover: verify the Google account is suspended, confirm ' +
      'the Provisioning Queue has the browser-system deactivate rows, then set this row status to ' +
      'done. See Offboarding.js MANUAL RECOVERY.',
      { name: company.name });
    prior.alerted = true;
    prior.alerted_at = nowIso_();
    setOffboardStatus_(r.offb_id, 'error', undefined, prior);
    logAudit_('offboard_error_alert_drafted', { offb_id: r.offb_id });
  } catch (e) {
    logAudit_('offboard_error_alert_failed', { offb_id: r.offb_id, error: String(e) });
  }
}

// ---------------------------------------------------------------- helpers

/** Delete the one-shot trigger whose unique id matches (post-fire cleanup). */
function _deleteTriggerById_(triggerId) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'fireOffboarding_' && t.getUniqueId() === triggerId) {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* already gone */ }
    }
  });
}

/** Create (never send) a Gmail draft notifying the team of the scheduled offboarding. */
function _draftOffboardNotice_(oq) {
  try {
    var company = CFG.COMPANY.quay1;
    var to = CFG.INTERNAL_NOTIFY.filter(function (x) { return x; }).join(',');
    draftMail_(to, company.name + ' - offboarding scheduled: ' + (oq.full_name || oq.quay_email),
      'Offboarding scheduled for ' + (oq.full_name || oq.quay_email) + ' (' + oq.quay_email + ').\n' +
      'Fires at ' + oq.fire_at + '. Requested by ' + oq.requested_by + '.\n' +
      'Systems: ' + (oq.systems || []).join(', ') + '.\nThere is no cancel window.',
      { name: company.name, htmlBody: offboardNoticeHtml_(company, oq) });
  } catch (err) {
    logAudit_('offboard_notice_failed', { offb_id: oq.offb_id, error: String(err) });
  }
}
