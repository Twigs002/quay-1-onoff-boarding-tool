/* Admin Dashboard - a private workspace for super admins.
 *
 * A standalone page (pagan-hub.html) separate from the shared On/Offboarding tool.
 * It reuses the same Supabase PIN login (auth.js) but then hard-gates on ROLE:
 * only super admins get in; any other valid staff login is signed straight back out.
 *
 * It provides the minimal `window.HUB` surface that feature modules expect
 * ($/esc/el/toast/getUser), then renders them from a small MODULES registry so new
 * admin views are a one-line add. Modules load AFTER this file so they can bind to
 * window.HUB.
 *
 * "Super admins only" is enforced in two places: this client gate (convenience) AND
 * Postgres RLS on va_search_records (the real control - see
 * supabase/migrations/0005_va_search_super_admin.sql). The client gate alone is not
 * security; the RLS policy is.
 */
(() => {
  'use strict';

  // Super admins only. Mirrors the RLS in migration 0005.
  const isAllowed = (u) => !!u && !!u.isSuper;

  // ── minimal HUB surface (mirrors the helpers app.js exposes) ────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function toast(title, body, kind) {
    const host = $('#toastHost');
    const node = el(`<div class="toast ${kind || ''}" role="status">
      <strong>${esc(title)}</strong>${body ? esc(body) : ''}</div>`);
    host.appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 250); }, 5200);
  }

  let USER = null;
  const HUB = (window.HUB = window.HUB || {});
  HUB.$ = $; HUB.esc = esc; HUB.el = el; HUB.toast = toast; HUB.getUser = () => USER;

  // ── modules: add a personal view by appending one entry here ────────────────
  const call = (fn, root) => {
    if (typeof HUB[fn] === 'function') return HUB[fn](root);
    root.appendChild(el('<div class="card card-pad"><div class="notice notice-warn">This view failed to load - try a refresh.</div></div>'));
  };
  const MODULES = [
    { id: 'datatracker', label: 'Data Tracker', render: (root) => call('viewDataTracker', root) },
    { id: 'dashboard', label: 'VA Dashboard', render: (root) => call('viewVaDashboard', root) },
    { id: 'vasearches', label: 'VA Searches', render: (root) => call('viewVaSearches', root) },
    // e.g. { id: 'leads', label: 'My Leads', render: (root) => { ... } },
  ];

  // ── router ──────────────────────────────────────────────────────────────────
  function buildNav() {
    const nav = $('#tabNav');
    nav.hidden = false;
    nav.innerHTML = MODULES.map((m, i) =>
      `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${esc(m.id)}"${i === 0 ? ' aria-current="page"' : ''}>${esc(m.label)}</button>`).join('');
    nav.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => route(b.dataset.tab)));
  }
  function route(id) {
    const mod = MODULES.find((m) => m.id === id) || MODULES[0];
    $('#tabNav').querySelectorAll('.tab-btn').forEach((b) => {
      const on = b.dataset.tab === mod.id;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const main = $('#content');
    main.innerHTML = '';
    mod.render(main);
    main.focus({ preventScroll: true });
  }

  // ── auth boot (PIN gate, ported from app.js, plus the identity check) ───────
  function initLoginGate() {
    const gate = $('#loginGate'), userInput = $('#loginUser'), dots = $('#pinDots'),
          errEl = $('#loginError'), pad = $('#loginKeypad');
    let pin = '';
    const paint = () => dots.querySelectorAll('.pin-dot').forEach((d, i) => d.classList.toggle('filled', i < pin.length));
    const showErr = (m) => { errEl.textContent = m; errEl.hidden = false; gate.classList.add('pin-error'); setTimeout(() => gate.classList.remove('pin-error'), 500); };

    async function attempt() {
      const u = userInput.value.trim();
      if (!u) { showErr('Enter your username.'); return; }
      errEl.hidden = true;
      const r = await window.AUTH.signIn(u, pin);
      pin = ''; paint();
      if (!r.ok) { showErr(r.error || 'Sign-in failed.'); return; }
      if (!isAllowed(r.user)) {           // valid staff, but not a super admin - refuse + sign out
        await window.AUTH.signOut();
        showErr('This dashboard is restricted to super admins.');
        return;
      }
      USER = r.user; onSignedIn();
    }
    pad.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-clear')) { pin = ''; paint(); return; }
      if (b.hasAttribute('data-back')) { pin = pin.slice(0, -1); paint(); return; }
      if (b.dataset.d && pin.length < 6) { pin += b.dataset.d; paint(); if (pin.length === 6) attempt(); }
    });
    document.addEventListener('keydown', (e) => {
      if (document.body.classList.contains('pre-auth') === false) return;
      if (e.key >= '0' && e.key <= '9' && pin.length < 6) { pin += e.key; paint(); if (pin.length === 6) attempt(); }
      else if (e.key === 'Backspace' && document.activeElement !== userInput) { pin = pin.slice(0, -1); paint(); }
      else if (e.key === 'Enter' && pin.length === 6) attempt();
    });
  }

  function onSignedIn() {
    document.body.classList.remove('pre-auth');
    const gate = $('#loginGate'); if (gate) gate.remove();
    if (window.QuayNav) window.QuayNav.mount({ isSuper: !!(USER && USER.isSuper), current: 'pagan-hub' });
    const so = $('#signOutBtn'); so.hidden = false;
    const sync = $('#phSync'); if (sync) sync.hidden = false;
    $('#signOutWho').textContent = USER && USER.name ? USER.name + ' · ' : '';
    so.addEventListener('click', async () => { await window.AUTH.signOut(); location.reload(); }, { once: true });
    buildNav();
    route(MODULES[0].id);
  }

  async function boot() {
    document.body.classList.add('pre-auth');
    initLoginGate();
    try {
      const u = await window.AUTH.getSession();
      if (u && isAllowed(u)) { USER = u; onSignedIn(); }
      else if (u) { await window.AUTH.signOut(); }   // a non-super-admin session must not linger here
    } catch (_) { /* stay on the gate */ }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
