/**
 * Auth.js - identity and authorization. Verifies the caller's Supabase JWT and resolves the
 * staff role. Every admin write path calls requireAdmin_ before mutating.
 *
 * Owner: backend. See docs/SPEC.md section 2, docs/RESEARCH.md section 2.3, docs/CONTRACTS.md.
 *
 * This is a faithful lift of the live Aqua _verifyCaller_ (aqua-contracts Code.js:202-234):
 *   GET {SUPABASE_URL}/auth/v1/user with Authorization: Bearer <jwt> + apikey: <anon> -> id,
 *   then GET /rest/v1/staff?auth_user_id=eq.<id>&select=* -> role row. Null if active===false.
 *
 * Rules:
 *   - Writes are Supabase JWT only, delivered in the POST body as `accessToken`. No shared
 *     secret fallback in this consolidated app (SPEC section 2: JWT only).
 *   - Roles: is_super, is_admin, is_senior_broker. Onboarding allows is_super || is_admin ||
 *     is_senior_broker (a senior broker requests only for themselves - requester_email is forced
 *     from ctx). Offboarding and provisioning require is_super || is_admin. Senior brokers see
 *     only their own requested candidates (match on requester_email downstream). The staff row's
 *     is_senior_broker column is the broker gate (matches web/auth.js); a plain broker is denied.
 *   - NEVER write is_super/is_admin from here (staff_admin_write_guard_tg guards that column).
 *   - Candidate kinds (fica_upload, book_induction) are token-less and never reach requireAdmin_.
 *
 * Public surface:
 *   verifyCaller_(accessToken)   - {email, name, isSuper, isAdmin, isBroker} | null.
 *   authContext_(body)           - {email, role:{is_super,is_admin,is_senior_broker}, name} | throws.
 *   requireOnboarder_(ctx)       - void | throws   assert is_super || is_admin || is_senior_broker.
 *   requireAdmin_(ctx)           - void | throws   assert is_super || is_admin.
 *   requireSuper_(ctx)           - void | throws   assert is_super (retry / destructive UI).
 */

/**
 * Verify a Supabase access token and resolve the staff role. Returns null on any failure
 * (invalid token, no staff row, inactive) so callers treat it as unauthenticated.
 */
function verifyCaller_(accessToken) {
  if (!accessToken) return null;
  var supaUrl = prop_(PROP.SUPABASE_URL, true);
  var anon = prop_(PROP.SUPABASE_ANON_KEY, true);
  try {
    var authRes = UrlFetchApp.fetch(supaUrl + '/auth/v1/user', {
      method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + accessToken, apikey: anon },
    });
    if (authRes.getResponseCode() !== 200) return null;
    var uid = (safeJsonParse_(authRes.getContentText(), {}) || {}).id;
    if (!uid) return null;

    var staffRes = UrlFetchApp.fetch(
      supaUrl + '/rest/v1/staff?auth_user_id=eq.' + encodeURIComponent(uid) + '&select=*',
      { method: 'get', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + accessToken, apikey: anon, Accept: 'application/json' } });
    if (staffRes.getResponseCode() !== 200) return null;
    var rows = safeJsonParse_(staffRes.getContentText(), []);
    if (!rows || !rows.length) return null;
    var s = rows[0];
    if (s.active === false) return null;
    return {
      email: String(s.email || '').trim(),
      name: String(s.name || '').trim(),
      isSuper: !!s.is_super,
      isAdmin: !!s.is_admin,
      isBroker: !!s.is_senior_broker,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Build the request auth context from the POST body's accessToken. Throws 'unauthorized' when
 * the token is missing or does not resolve to an active staff row.
 */
function authContext_(body) {
  var caller = verifyCaller_(body && body.accessToken);
  if (!caller) throw new Error('unauthorized');
  return {
    email: caller.email,
    name: caller.name,
    role: { is_super: caller.isSuper, is_admin: caller.isAdmin, is_senior_broker: caller.isBroker },
  };
}

/** Assert the caller may run admin actions (offboard / provision / retry-adjacent). */
function requireAdmin_(ctx) {
  if (!ctx || !ctx.role || !(ctx.role.is_super || ctx.role.is_admin)) {
    throw new Error('forbidden: admin role required');
  }
}

/**
 * Individuals (by staff work email) allowed to use the Admin Check accept/decline actions WITHOUT
 * being a full admin. A tiny, explicit allowlist per the product decision to give Kat - and only Kat
 * - Admin Check access without granting her the rest of the admin surface (offboard/provision/retry
 * stay requireAdmin_/requireSuper_). Mirror on the frontend: web/app.js canAdminCheck (username 'kat').
 */
var ADMIN_CHECK_ALLOW_ = ['kat@quay1.co.za'];

/**
 * Assert the caller may use the Admin Check tab's accept/decline actions: a super/admin, OR an
 * explicitly allowlisted individual (Kat). Everything else about the admin surface stays gated by
 * requireAdmin_ - this relaxes ONLY the accept/decline path.
 */
function requireAdminCheck_(ctx) {
  if (ctx && ctx.role && (ctx.role.is_super || ctx.role.is_admin)) return;
  var email = ctx && ctx.email ? String(ctx.email).trim().toLowerCase() : '';
  if (email && ADMIN_CHECK_ALLOW_.indexOf(email) !== -1) return;
  throw new Error('forbidden: admin role required');
}

/**
 * Assert the caller may submit an ONBOARDING request: super, admin, or broker.
 * A broker requests only for their own hire - requester_email/name are force-set from
 * ctx in the onboard handlers, so a broker can never spoof another requester. Offboarding
 * and provisioning stay admin-only (requireAdmin_); this relaxes onboarding only.
 */
function requireOnboarder_(ctx) {
  if (!ctx || !ctx.role || !(ctx.role.is_super || ctx.role.is_admin || ctx.role.is_senior_broker)) {
    throw new Error('forbidden: onboarding role required');
  }
}

/** Assert the caller is a super (retry an error row, other destructive UI). */
function requireSuper_(ctx) {
  if (!ctx || !ctx.role || !ctx.role.is_super) {
    throw new Error('forbidden: super role required');
  }
}
