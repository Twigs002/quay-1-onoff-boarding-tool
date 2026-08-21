/**
 * Clock.js - create the shared quay-clock `staff` row for a newly provisioned hire, so they can
 * clock in (and hold designation-derived app access) on day one. Before this, an admin had to
 * hand-enter every new starter into quay-clock's Staff Directory after onboarding.
 *
 * quay-clock exposes an `admin-create-staff` Edge Function, but it authorises the CALLER via their
 * signed-in admin JWT (auth.getUser()). Our provisioning runs server-side from the scheduled batch
 * (and the approve click) with NO user session, so we cannot present that JWT. Instead we do the
 * SAME two writes the Edge Function does, directly, using this project's SUPABASE_SERVICE_KEY:
 *   1. create the auth user  (POST /auth/v1/admin/users, email <id>@quay1.local, password = PIN)
 *   2. insert the staff row  (POST /rest/v1/staff with the returned auth_user_id)
 * Field names + the <id>@quay1.local login convention are copied verbatim from that Edge Function
 * (quay-clock/supabase/functions/admin-create-staff/index.ts) so the two paths stay in lock-step.
 *
 * Owner: backend. Gated by BOTH clockSyncEnabled_() (default OFF) and DRY_RUN_() - until armed it
 * only logs the payload it WOULD send. Idempotent (skips when the staff id already exists) and
 * fully non-fatal: any failure logs an audit row and returns { ok:false }, never throwing, so a
 * clock-write problem can never break the onboarding / provisioning flow.
 *
 * Public surface:
 *   clockStaffCreate_(person)  - { ok, dryRun?, already?, id, pin?, error? }  create the staff row.
 */

/**
 * Create the quay-clock staff row for `person` (the _personFor_ shape from Provisioning.js).
 * Returns a small status object; never throws. A live create also records the temporary clock PIN
 * into the private Credentials ledger (keyed by the <id>@quay1.local login) so ops can hand it over.
 */
function clockStaffCreate_(person) {
  var id = _clockStaffId_(person);
  if (!id) return { ok: false, error: 'could not derive a clock username (empty name)' };
  var name = String(person.full_name || '').trim();
  var loginEmail = id + '@quay1.local';   // synthetic sign-in address; separate from the real work email
  var payload = {
    id: id,
    name: name,
    team: person.team || '',
    // The broker's REAL work email (their Google account), NOT the synthetic login address.
    email: person.quay_email || person.email || '',
    designation: _clockDesignation_(person),   // best-effort; see helper (broker/senior_broker for Quay 1)
  };

  // Not armed (flag off) or in DRY_RUN: log the intended write and stop. No auth user, no staff row.
  if (!clockSyncEnabled_() || DRY_RUN_()) {
    logAudit_('clock_staff_dryrun', { id: id, armed: clockSyncEnabled_(), dryRun: DRY_RUN_(), would: payload });
    return { ok: true, dryRun: true, id: id, would: payload };
  }

  var base = optProp_(PROP.SUPABASE_URL);
  var service = optProp_(PROP.SUPABASE_SERVICE_KEY);
  if (!base || !service) {
    logAudit_('clock_staff_no_creds', { id: id });
    return { ok: false, id: id, error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' };
  }

  // Idempotent: if a staff row with this id already exists, do nothing (a re-run must not error or
  // double-create). This also covers the common "admin already hand-created it" case cleanly.
  if (_clockStaffExists_(base, service, id)) {
    logAudit_('clock_staff_exists', { id: id });
    return { ok: true, already: true, id: id };
  }

  var pin = _clockTempPin_();
  try {
    var authUserId = _clockCreateAuthUser_(base, service, loginEmail, pin, id, name);
    if (!authUserId) return { ok: false, id: id, error: 'auth user creation returned no id' };
    _clockInsertStaffRow_(base, service, id, authUserId, payload);
    // Record the temp PIN in the private Credentials ledger (keyed by the login address) so ops can
    // hand the hire their first sign-in. Non-fatal - a ledger failure must not fail the create.
    try {
      recordCredential_({ full_name: name, quay_email: loginEmail, temp_password: pin,
        team: person.team, folderId: person.folderId });
    } catch (e) { logAudit_('clock_pin_record_failed', { id: id, error: String(e) }); }
    logAudit_('clock_staff_created', { id: id, email: payload.email, designation: payload.designation });
    return { ok: true, id: id, pin: pin };
  } catch (err) {
    logAudit_('clock_staff_failed', { id: id, error: String(err && err.message ? err.message : err) });
    return { ok: false, id: id, error: String(err && err.message ? err.message : err) };
  }
}

/** Slugify a hire's name into a quay-clock username, matching the Edge Function's slugify():
 *  lower-case, non-alphanumerics -> single '-', trimmed, max 32 chars. '' when nothing usable. */
function _clockStaffId_(person) {
  var raw = String((person && person.full_name) || (person && person.id_number) || '');
  return raw.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * Best-effort quay-clock designation for a hire. Quay 1 brokers map to the broker / senior_broker
 * designations (SB = full broker -> senior_broker; JB = assistant -> broker), which the dashboards
 * use to derive locked app access (broker -> polar; senior_broker -> polar+boarding) and to mark
 * the row Exempt (non-clocking). Anything else (Aqua, unknown) is left blank for an admin to set -
 * we would rather leave it unclassified than guess a clocking designation wrongly. See the PR notes.
 */
function _clockDesignation_(person) {
  if (String((person && person.entity) || 'quay1') !== 'quay1') return '';
  var role = brokerRole_(person && (person.activity || person.designation));
  if (role === 'sb') return 'senior_broker';
  if (role === 'jb') return 'broker';
  return '';
}

/** A random 6-digit clock PIN (the auth-user password). Not derived from any personal detail. The
 *  hire is told to change it on first use; it is stored only in the private Credentials ledger. */
function _clockTempPin_() {
  var pin = '';
  for (var i = 0; i < 6; i++) pin += String(Math.floor(Math.random() * 10));
  return pin;
}

/** True when a staff row with this id already exists (idempotency guard). Best-effort: on a lookup
 *  error we return false so the caller attempts the create (a genuine dup is caught server-side). */
function _clockStaffExists_(base, service, id) {
  try {
    var res = UrlFetchApp.fetch(base + '/rest/v1/staff?id=eq.' + encodeURIComponent(id) + '&select=id', {
      method: 'get', muteHttpExceptions: true,
      headers: { apikey: service, Authorization: 'Bearer ' + service, Accept: 'application/json' },
    });
    if (res.getResponseCode() !== 200) return false;
    var rows = safeJsonParse_(res.getContentText(), []);
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    logAudit_('clock_staff_exists_check_failed', { id: id, error: String(e) });
    return false;
  }
}

/** Create the GoTrue auth user (email_confirm) and return its uuid. Throws on a non-2xx response so
 *  the caller records a failure. loginEmail is <id>@quay1.local; password is the temp PIN. */
function _clockCreateAuthUser_(base, service, loginEmail, pin, id, name) {
  var res = UrlFetchApp.fetch(base + '/auth/v1/admin/users', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: service, Authorization: 'Bearer ' + service },
    payload: JSON.stringify({
      email: loginEmail, password: pin, email_confirm: true,
      user_metadata: { username: id, name: name },
    }),
  });
  var code = res.getResponseCode();
  var body = safeJsonParse_(res.getContentText(), {});
  if (code < 200 || code >= 300) {
    throw new Error('auth user create HTTP ' + code + ': ' + res.getContentText());
  }
  // GoTrue returns the user object directly (id at top level); guard both shapes just in case.
  return (body && (body.id || (body.user && body.user.id))) || '';
}

/** Insert the public.staff row via PostgREST (service key bypasses RLS). Mirrors the Edge Function's
 *  insert exactly (minus salary_type, which the Edge Function also omits - the column defaults). The
 *  hire is a plain, active, non-elevated staff member: no admin / super / broker-login grants. */
function _clockInsertStaffRow_(base, service, id, authUserId, payload) {
  var res = UrlFetchApp.fetch(base + '/rest/v1/staff', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: service, Authorization: 'Bearer ' + service, Prefer: 'return=minimal' },
    payload: JSON.stringify({
      id: id,
      auth_user_id: authUserId,
      name: payload.name,
      role: '',
      team: payload.team || '',
      is_admin: false,
      is_super: false,
      is_broker: false,
      active: true,
      email: payload.email || null,
      designation: payload.designation || null,
      division: null,
      hourly_rate: null,
      weekly_hours: null,
      salary: null,
    }),
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('staff insert HTTP ' + code + ': ' + res.getContentText());
  }
}
