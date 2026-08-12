/* Quay 1 Boarding Tool - shared Supabase auth gate.
 *
 * Mirrors quay-hubspot / quay-clock / quay-leads: same Supabase project, same
 * PIN login via a synthetic `<username>@quay1.local` email, so staff sign in
 * with the exact same credentials they use on the other Quay 1 systems.
 *
 * Access:
 *   - super / admin  -> full hub: Onboard, Provisioning status, Offboard.
 *   - broker         -> Onboard (submits their OWN hire requests, same as
 *                       quay-hubspot) + Provisioning status scoped to their own
 *                       requests. No Offboard tab; offboarding is super/admin only.
 * The is_super / is_admin / is_broker flags come straight off the staff row.
 *
 * NOTE: this is a client-side UI gate. The real enforcement is in the Apps
 * Script backend, which re-verifies the Supabase JWT and re-checks the role on
 * every write. The frontend gate is convenience only.
 */
window.AUTH = (() => {
  const cfg = window.QUAY_CFG || {};
  let _client = null;

  function client() {
    if (!_client) {
      _client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    }
    return _client;
  }

  const emailFor = (u) => `${(u || '').toLowerCase().trim()}@${cfg.AUTH_EMAIL_DOMAIN}`;

  // Active super / admin / broker staff may sign in. Supers and admins get the
  // full hub with submit rights; brokers get a read-only view of their own
  // requests. Anyone else is turned away.
  function _gate(staff) {
    if (!staff) return { ok: false, error: 'No staff record for this login.' };
    if (staff.active === false) return { ok: false, error: 'This account is disabled.' };
    const isSuper = !!staff.is_super, isAdmin = !!staff.is_admin,
          isBroker = !!staff.is_senior_broker;
    if (!isSuper && !isAdmin && !isBroker) {
      return { ok: false, error: 'This login has no lifecycle-hub access.' };
    }
    return { ok: true, user: {
      username: staff.id,
      name: staff.name,
      // Real work email if the staff row carries one, else null. Used as
      // requester_email on onboard/offboard requests; a broker with no real
      // email matches none of their own candidates server-side (safe default).
      email: staff.email || null,
      isSuper, isAdmin, isBroker,
      // Coarse role marker app.js uses to choose what to show + enable.
      role: isSuper ? 'super' : isAdmin ? 'admin' : 'broker',
      // Submit rights, split by action:
      //  - Onboard: super, admin OR broker may submit. A broker requests only
      //    for their own hire; requester_email is force-set from the JWT
      //    server-side, matching quay-hubspot's broker-requests-contracts model.
      //  - Offboard: super or admin only (a broker can never tear down access).
      canOnboard: isSuper || isAdmin || isBroker,
      canOffboard: isSuper || isAdmin,
    } };
  }

  async function signIn(username, pin) {
    const sb = client();
    const { data, error } = await sb.auth.signInWithPassword({
      email: emailFor(username), password: pin,
    });
    if (error || !data || !data.user) {
      return { ok: false, error: 'Username or PIN not recognised.' };
    }
    const { data: staff } = await sb.from('staff').select('*')
      .eq('auth_user_id', data.user.id).maybeSingle();
    const g = _gate(staff);
    if (!g.ok) await sb.auth.signOut();  // don't leave a half-authed session
    return g;
  }

  async function getSession() {
    const sb = client();
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) return null;
    const { data: staff } = await sb.from('staff').select('*')
      .eq('auth_user_id', data.session.user.id).maybeSingle();
    const g = _gate(staff);
    return g.ok ? g.user : null;
  }

  async function signOut() {
    try { await client().auth.signOut(); } catch (_) { /* ignore */ }
  }

  // Fresh Supabase JWT for authenticated POST bodies. Call this at REQUEST
  // time (never cache the result) so Supabase's auto-refreshed token is used;
  // access tokens expire roughly hourly.
  async function getAccessToken() {
    const sb = client();
    const { data } = await sb.auth.getSession();
    return (data && data.session) ? data.session.access_token : null;
  }

  // The shared supabase-js client, so feature modules (e.g. app.vasearches.js)
  // that read/write their own RLS-gated tables reuse ONE GoTrue instance and the
  // signed-in session, instead of spawning a second client (which warns and can
  // desync the session). Returns null only if the supabase UMD failed to load.
  function getClient() {
    return (window.supabase && cfg.SUPABASE_URL) ? client() : null;
  }

  return { signIn, getSession, signOut, getAccessToken, getClient };
})();
