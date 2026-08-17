/* Pagan Hub - KF Allocations reference (window.HUB.viewKfAllocations).
 *
 * The "MASTER KF Team Allocations" master, imported into `kf_allocations`
 * (scripts/import_kf_allocations.py): which suburb's CMA data (FT vs ST) is
 * allocated to which team, its status, and the request/transfer timeline. A
 * searchable reference alongside the active Data Tracker; status/team editable
 * inline so it stays current as suburbs transfer or go on ice. Pagan-only (RLS).
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) return;
  const sb = () => (window.AUTH && window.AUTH.getClient && window.AUTH.getClient());
  const fmt = (n) => (n == null ? '0' : Number(n).toLocaleString());
  const CAP = 400;

  const STATUS = {
    active:      { l: 'Active',      p: 'pill-done' },
    on_ice:      { l: 'On ice',      p: 'pill-pending' },
    requested:   { l: 'Requested',   p: 'pill-running' },
    transferred: { l: 'Transferred', p: 'pill-skipped' },
    inactive:    { l: 'Inactive',    p: 'pill-error' },
    cancelled:   { l: 'Cancelled',   p: 'pill-error' },
  };
  const pill = (s) => { const o = STATUS[s] || STATUS.active; return `<span class="pill ${o.p}">${H.esc(o.l)}</span>`; };
  const statusOpts = (sel) => Object.keys(STATUS).map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${STATUS[k].l}</option>`).join('');

  let rows = [];
  const filter = { type: 'all', status: 'all', team: 'all', q: '' };

  function viewKfAllocations(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head">
        <div><h2>KF Allocations</h2>
          <p class="ph-sub">The master reference: which suburb’s CMA data (FT full-title / ST sectional-title) belongs to which team. Edit status or team inline as they move.</p></div>
        <div class="segmented" id="kaType" role="group" aria-label="Title type">
          <button type="button" data-t="all" aria-pressed="true">All</button>
          <button type="button" data-t="FT" aria-pressed="false">FT</button>
          <button type="button" data-t="ST" aria-pressed="false">ST</button>
        </div>
      </div>
      <div class="kpi-grid" id="kaStats"></div>
      <div class="card">
        <div class="card-head" style="padding:16px 18px 0"><h3>Allocations</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="kaExport">Export CSV</button></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding:12px 18px">
          <select id="kaTeam" aria-label="Team"><option value="all">All teams</option></select>
          <select id="kaStatus" aria-label="Status"><option value="all">All statuses</option>${statusOpts('')}</select>
          <input id="kaQ" type="search" placeholder="Search suburb / CMA..." style="flex:1;min-width:170px">
        </div>
        <div class="tbl-wrap"><table class="tbl" id="kaTbl"></table></div>
        <div class="log-foot" id="kaFoot"></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    wire(wrap);
    load(wrap);
  }

  async function load(wrap) {
    const tbl = H.$('#kaTbl', wrap);
    tbl.innerHTML = `<tbody><tr><td><div class="skeleton"></div></td></tr></tbody>`;
    try {
      // Page through so all ~1.7k rows load fully.
      const client = sb(); let from = 0, all = [];
      for (;;) {
        const { data, error } = await client.from('kf_allocations').select('*')
          .order('team', { ascending: true }).order('suburb', { ascending: true }).range(from, from + 999);
        if (error) throw new Error(error.message);
        all = all.concat(data || []);
        if (!data || data.length < 1000) break;
        from += 1000;
      }
      rows = all;
    } catch (err) {
      const hint = /relation|does not exist|schema cache/i.test(err.message)
        ? ' Apply 0007_kf_allocations.sql and run scripts/import_kf_allocations.py.' : '';
      tbl.innerHTML = `<tbody><tr><td><div class="state"><div class="state-title">Could not load allocations</div><div>${H.esc(err.message)}${H.esc(hint)}</div></div></td></tr></tbody>`;
      H.$('#kaStats', wrap).innerHTML = ''; H.$('#kaFoot', wrap).innerHTML = ''; return;
    }
    const teams = Array.from(new Set(rows.map((r) => r.team).filter(Boolean))).sort();
    H.$('#kaTeam', wrap).innerHTML = '<option value="all">All teams</option>' + teams.map((t) => `<option value="${H.esc(t)}">${H.esc(t)}</option>`).join('');
    render(wrap);
  }

  function render(wrap) {
    const scoped = filter.type === 'all' ? rows : rows.filter((r) => r.title_type === filter.type);
    const c = { active: 0, on_ice: 0, requested: 0 };
    scoped.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    const teams = new Set(scoped.map((r) => r.team).filter(Boolean)).size;
    const t = (cls, label, n) => `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${fmt(n)}</div><div class="kpi-sub">&nbsp;</div></div>`;
    H.$('#kaStats', wrap).innerHTML =
      `<div class="kpi kpi-hero"><div class="kpi-label">Allocations</div><div class="hero-row"><span class="hero-num">${fmt(scoped.length)}</span></div><div class="kpi-sub">${teams} teams</div></div>`
      + t('searched', 'Active', c.active) + t('', 'On ice', c.on_ice) + t('', 'Requests', c.requested);
    renderTable(wrap);
  }

  function visible() {
    return rows.filter((r) => {
      if (filter.type !== 'all' && r.title_type !== filter.type) return false;
      if (filter.status !== 'all' && r.status !== filter.status) return false;
      if (filter.team !== 'all' && r.team !== filter.team) return false;
      if (filter.q) { const h = `${r.suburb || ''} ${r.cma_suburb || ''} ${r.extension_name || ''}`.toLowerCase(); if (!h.includes(filter.q)) return false; }
      return true;
    });
  }

  function renderTable(wrap) {
    const head = `<thead><tr><th>Suburb</th><th>Type</th><th>Team</th><th>CMA suburb</th><th>Status</th><th>Latest period</th><th class="actions"></th></tr></thead>`;
    const list = visible();
    if (!list.length) {
      H.$('#kaTbl', wrap).innerHTML = head + `<tbody><tr><td colspan="7"><div class="state"><div class="state-title">${rows.length ? 'Nothing matches these filters' : 'No allocations imported yet'}</div><div>${rows.length ? '' : 'Run scripts/import_kf_allocations.py --live.'}</div></div></td></tr></tbody>`;
      H.$('#kaFoot', wrap).innerHTML = ''; return;
    }
    const shown = list.slice(0, CAP);
    const body = shown.map((r) => `<tr data-id="${H.esc(r.id)}">
      <td class="who">${H.esc(r.suburb || '')}</td>
      <td>${H.esc(r.title_type || '—')}</td>
      <td>${H.esc(r.team || '')}</td>
      <td class="muted">${H.esc((r.cma_suburb || '').trim())}</td>
      <td>${pill(r.status)}</td>
      <td class="muted">${H.esc(r.rt_period || r.request_period || '')}</td>
      <td class="actions"><button type="button" class="btn btn-ghost btn-sm" data-edit="${H.esc(r.id)}">Edit</button></td>
    </tr>`).join('');
    H.$('#kaTbl', wrap).innerHTML = head + `<tbody>${body}</tbody>`;
    H.$('#kaTbl', wrap).querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editor(wrap, b.dataset.edit)));
    H.$('#kaFoot', wrap).innerHTML = `<span class="log-count">Showing ${fmt(shown.length)} of ${fmt(list.length)}${list.length > CAP ? ' — refine filters to see the rest' : ''}</span>`;
  }

  function editor(wrap, id) {
    const rec = rows.find((r) => String(r.id) === String(id));
    const tr = H.$(`tr[data-id="${String(id).replace(/["\\]/g, '\\$&')}"]`, wrap);
    if (!rec || !tr) return;
    tr.innerHTML = `<td class="who">${H.esc(rec.suburb || '')}</td>
      <td colspan="5"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select class="e-status">${statusOpts(rec.status)}</select>
        <input class="e-team" type="text" placeholder="team" value="${H.esc(rec.team || '')}" style="min-width:130px">
        <input class="e-notes" type="text" placeholder="notes" value="${H.esc(rec.notes || '')}" style="flex:1;min-width:140px">
      </div></td>
      <td class="actions" style="white-space:nowrap">
        <button type="button" class="btn btn-primary btn-sm e-save">Save</button>
        <button type="button" class="btn btn-ghost btn-sm e-cancel">Cancel</button></td>`;
    H.$('.e-cancel', tr).addEventListener('click', () => renderTable(wrap));
    H.$('.e-save', tr).addEventListener('click', async () => {
      const patch = { status: H.$('.e-status', tr).value, team: H.$('.e-team', tr).value.trim() || null, notes: H.$('.e-notes', tr).value.trim() || null };
      const btn = H.$('.e-save', tr); btn.classList.add('loading'); btn.disabled = true;
      try {
        const { error } = await sb().from('kf_allocations').update(patch).eq('id', rec.id);
        if (error) throw new Error(error.message);
        Object.assign(rec, patch);
        H.toast('Saved', `${rec.suburb} → ${STATUS[patch.status].l}.`, 'ok');
        render(wrap);
      } catch (err) { btn.classList.remove('loading'); btn.disabled = false; H.toast('Could not save', err.message, 'err'); }
    });
  }

  function exportCsv() {
    const head = ['suburb', 'type', 'team', 'owner_id', 'cma_suburb', 'status', 'rt_period', 'request_period'];
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.join(',')].concat(visible().map((r) => [r.suburb, r.title_type, r.team, r.owner_id, (r.cma_suburb || '').trim(), STATUS[r.status] ? STATUS[r.status].l : r.status, r.rt_period, r.request_period].map(q).join(',')));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'kf-allocations.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wire(wrap) {
    H.$('#kaType', wrap).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]'); if (!b) return;
      filter.type = b.dataset.t;
      H.$('#kaType', wrap).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      render(wrap);
    });
    H.$('#kaTeam', wrap).addEventListener('change', (e) => { filter.team = e.target.value; renderTable(wrap); });
    H.$('#kaStatus', wrap).addEventListener('change', (e) => { filter.status = e.target.value; renderTable(wrap); });
    H.$('#kaQ', wrap).addEventListener('input', (e) => { filter.q = e.target.value.toLowerCase().trim(); renderTable(wrap); });
    H.$('#kaExport', wrap).addEventListener('click', exportCsv);
  }

  H.viewKfAllocations = viewKfAllocations;
})();
