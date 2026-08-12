/* Quay 1 Boarding Tool - Offboard view (split out of app.js to keep that file
 * under the 500-line cap). Reaches app.js's shared helpers + state via window.HUB.
 *
 * Section 3 of the SPA (super/admin only): a senior-broker -> reports tree (same
 * data as the Programs page, admin scope = every team), with an Offboard action
 * next to each person. It shows the CMA/PropData accounts they currently hold so
 * you can see what will be torn down, then a confirm step fires the teardown
 * +30 min with no cancel window (CONTRACTS 8.5): suspend Google (never delete) +
 * remove groups/Drive, release the HubSpot seat, deactivate the browser portals.
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) throw new Error('app.offboard.js loaded before app.js (window.HUB missing)');
  const { $, esc, el, api, toast, KINDS } = H;
  const DELAY = H.OFFBOARD_DELAY_MIN;

  let offbCache = null;

  // Brokers (not super/admin) get a simple notify-only "Request offboarding" form; the destructive
  // teardown tree below stays super/admin.
  function renderOffboardRequest(root) {
    const wrap = el(`<div class="stack">
      <div class="section-head">
        <h2>Request an offboarding</h2>
        <p>Let us know someone is leaving. This sends a quick notification to the offboarding team (Pagan, Kat, Lieze and Sheldon), who will action it. It does not remove any access itself.</p>
      </div>
      <div class="card card-pad">
        <div class="field"><label for="ob_name">Who is leaving? <span class="req">*</span></label>
          <input id="ob_name" type="text" placeholder="Full name" autocomplete="off"></div>
        <div class="field"><label for="ob_team">Team</label>
          <input id="ob_team" type="text" placeholder="e.g. Vipers" autocomplete="off"></div>
        <div class="field"><label for="ob_reason">Reason or notes</label>
          <textarea id="ob_reason" placeholder="Anything the team should know (optional)"></textarea></div>
        <div class="form-actions"><button type="button" class="btn btn-primary" id="ob_submit">Request offboarding</button></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    $('#ob_submit', wrap).addEventListener('click', async () => {
      const name = $('#ob_name', wrap).value.trim();
      if (!name) { toast('Name needed', 'Please enter who is leaving.', 'err'); return; }
      const btn = $('#ob_submit', wrap); btn.disabled = true; btn.classList.add('loading');
      try {
        await api(KINDS.offboardNotify, { name, team: $('#ob_team', wrap).value.trim(), reason: $('#ob_reason', wrap).value.trim() });
        wrap.innerHTML = `<div class="card card-pad"><div class="state"><div class="state-title">Offboarding requested</div><div>Thanks, the offboarding team has been notified about ${esc(name)}. They will take it from here.</div></div></div>`;
      } catch (err) {
        toast('Could not send request', err.message, 'err');
        btn.disabled = false; btn.classList.remove('loading');
      }
    });
  }

  function viewOffboard(root) {
    const user = H.getUser();
    const canOffboard = user && user.canOffboard;
    if (!canOffboard) { renderOffboardRequest(root); return; }   // brokers: simple notify-only form
    const wrap = el(`<div class="stack">
      <div class="section-head">
        <h2>Offboard a person</h2>
        <p>Pick a broker from their team below. Offboarding suspends the Google account (never deletes it), removes group + Drive access, releases the HubSpot seat and tears down the browser-portal logins. It fires ${DELAY} minutes after you confirm, with no cancel window.</p>
      </div>
      <div class="card card-pad">
        ${canOffboard ? '' : '<div class="notice notice-warn">Only a super or admin can offboard.</div>'}
        <div class="toolbar">
          <div class="muted" id="offbMeta">Loading...</div>
          <div class="toolbar-right"><button type="button" class="btn btn-ghost btn-sm" id="offbRefresh">Refresh</button></div>
        </div>
        <div class="docs">
          <span class="pill pill-done">CMA</span> has a CMA account
          <span class="pill pill-running">Agent</span> full PropData agent
          <span class="pill pill-running">Spec #</span> property-specialist profile
          <span class="pill pill-skipped">inactive</span> account inactive
          <span class="pill pill-skipped">–</span> none held
        </div>
        <div id="offbBody"></div>
      </div>
      <div id="offbConfirm"></div>
    </div>`);
    root.appendChild(wrap);
    if (!canOffboard) { $('#offbMeta', wrap).textContent = ''; $('#offbBody', wrap).innerHTML = ''; return; }
    $('#offbRefresh', wrap).addEventListener('click', () => loadOffboard(wrap, true));
    loadOffboard(wrap, false);
  }

  async function loadOffboard(wrap, force) {
    const body = $('#offbBody', wrap), meta = $('#offbMeta', wrap);
    body.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    meta.textContent = 'Loading...';
    try {
      if (offbCache && !force) { renderTree(wrap, offbCache); return; }
      let r, lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { r = await api(KINDS.programs, {}); lastErr = null; break; }
        catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 600)); }
      }
      if (lastErr) throw lastErr;
      offbCache = r;
      renderTree(wrap, r);
    } catch (err) {
      meta.textContent = '';
      body.innerHTML = `<div class="state"><div class="state-title">Could not load teams</div><div>${esc(err.message)}</div></div>`;
    }
  }

  function accChip(p) {
    const cma = p.cma ? '<span class="pill pill-done">CMA</span>' : '';
    let pd = '';
    if (p.pd) {
      const lbl = p.pd.type === 'agent' ? 'Agent' : `Spec #${esc(p.pd.number)}`;
      pd = `<span class="pill ${p.pd.active ? 'pill-running' : 'pill-skipped'}">${lbl}</span>`;
    }
    return (cma + pd) || '<span class="pill pill-skipped">–</span>';
  }

  // Leading avatar for a person row - reuses the shared HUB.avatar helper (landing alongside
  // the Programs/Progress-report redesign) so initials render identically across views; falls
  // back to a local render if HUB.avatar hasn't loaded yet.
  function avatarHtml(name) {
    if (typeof H.avatar === 'function') return H.avatar(name);
    const initials = String(name || '').trim().split(/\s+/).slice(0, 2)
      .map((w) => w[0] || '').join('').toUpperCase();
    return `<div class="avatar">${esc(initials || '?')}</div>`;
  }

  // Highlights the row of the person currently being confirmed for offboarding; pass null to clear.
  function selectRow(wrap, row) {
    const body = $('#offbBody', wrap);
    if (!body) return;
    body.querySelectorAll('.person-row.is-selected').forEach((x) => x.classList.remove('is-selected'));
    if (row) row.classList.add('is-selected');
  }

  function renderTree(wrap, r) {
    const body = $('#offbBody', wrap), meta = $('#offbMeta', wrap);
    const sections = (r && r.sections) || [];
    const teamCount = sections.reduce((n, s) => n + (s.teams ? s.teams.length : 0), 0);
    meta.textContent = teamCount ? `${teamCount} team(s)` : '';
    if (!teamCount) { body.innerHTML = `<div class="state"><div class="state-title">No teams to show</div></div>`; return; }
    const rowHtml = (p) => `<div class="person-row${p.senior ? ' sr' : ''}">
        ${avatarHtml(p.name)}
        <span class="person-name">${p.senior ? '<span class="star">★</span>' : '<span class="star dim">·</span>'}${esc(p.name)}${p.senior ? ' <span class="senior-tag">SENIOR</span>' : ''}</span>
        <div class="docs">${accChip(p)}</div>
        <button type="button" class="btn btn-danger btn-sm offb-go" data-name="${esc(p.name)}" data-email="${esc(p.email || '')}"${p.email ? '' : ' disabled title="No email on file"'}>Offboard</button>
      </div>`;
    const teamHtml = (t) => `<div class="team-card">
        <div class="card-head"><span class="team-name">${esc(t.name)}</span>${t.senior ? `<span class="team-senior">Senior: ${esc(t.senior)}</span>` : ''}</div>
        ${t.people.map(rowHtml).join('')}</div>`;
    body.innerHTML = `<div class="stack">${sections.map((s) =>
      `<div class="team-section">${esc(s.name)}</div>${s.teams.map(teamHtml).join('')}`).join('')}</div>`;
    body.querySelectorAll('.offb-go').forEach((b) => {
      b.addEventListener('click', () => {
        selectRow(wrap, b.closest('.person-row'));
        confirmOffboard(wrap, { name: b.dataset.name, email: b.dataset.email });
      });
    });
  }

  function confirmOffboard(wrap, who) {
    const user = H.getUser();
    const fireAt = new Date(Date.now() + DELAY * 60 * 1000);
    const hhmm = fireAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const host = $('#offbConfirm', wrap);
    host.innerHTML = '';
    const panel = el(`<div class="card card-pad card-danger stack">
      <h3 class="fs-title">Confirm offboarding</h3>
      <div class="notice notice-info">
        <div><strong>Person:</strong> ${esc(who.name)}</div>
        <div><strong>Quay email:</strong> ${esc(who.email)}</div>
        <div><strong>Requested by:</strong> ${esc(user ? user.name : '')}</div>
      </div>
      <div class="notice notice-danger">
        This fires at <strong>${esc(hhmm)}</strong>, in ${DELAY} minutes. No cancel once confirmed. All linked accounts are torn down; Google is suspended, never deleted.
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-danger-solid" id="ofGo">Confirm offboarding</button>
        <button type="button" class="btn btn-ghost" id="ofCancel">Cancel</button>
      </div>
    </div>`);
    host.appendChild(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#ofGo', panel).focus();
    $('#ofCancel', panel).addEventListener('click', () => { host.innerHTML = ''; selectRow(wrap, null); });
    $('#ofGo', panel).addEventListener('click', () => submitOffboard(panel, who));
  }

  async function submitOffboard(panel, who) {
    const user = H.getUser();
    const btn = $('#ofGo', panel);
    btn.classList.add('loading'); btn.disabled = true;
    try {
      const r = await api(KINDS.offboard, {
        full_name: who.name, quay_email: who.email,
        requested_by: user ? user.email : '', requested_by_name: user ? user.name : '',
      });
      const at = r && r.fire_at ? new Date(r.fire_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date(Date.now() + DELAY * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      panel.innerHTML = `<div class="notice notice-info">
        Offboarding scheduled for <strong>${esc(who.name)}</strong>. Fires at <strong>${esc(at)}</strong>, in ${DELAY} minutes. No cancel. Track it on the Provisioning status tab.
      </div>`;
      toast('Offboarding scheduled', `${who.name} will be deactivated at ${at}.`, 'ok');
    } catch (err) {
      toast('Could not schedule', err.message, 'err');
      btn.classList.remove('loading'); btn.disabled = false;
    }
  }

  H.viewOffboard = viewOffboard;
})();
