/* Pagan Hub - Data Tracker (window.HUB.viewDataTracker).
 *
 * The Knowledge Factory data work queue: audits, new-team data, suburbs owed back,
 * new-suburb adds and the companies set - each with type, team, area, status and
 * timeline. Backed by the `data_jobs` table (migration 0006), read/written directly
 * from the browser as Pagan (RLS). A "Load my current jobs" seed populates the real
 * work in flight so it's useful on first open.
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) return;
  const sb = () => (window.AUTH && window.AUTH.getClient && window.AUTH.getClient());
  const who = () => { const u = H.getUser && H.getUser(); return (u && (u.name || u.username)) || 'Pagan'; };
  const fmt = (n) => (n == null ? '' : Number(n).toLocaleString());

  const STATUS = {
    to_do:       { l: 'To do',        p: 'pill-skipped' },
    requested:   { l: 'Requested',    p: 'pill-running' },
    awaiting:    { l: 'Awaiting back', p: 'pill-pending' },
    in_progress: { l: 'In progress',  p: 'pill-running' },
    received:    { l: 'Received',     p: 'pill-ready' },
    done:        { l: 'Done',         p: 'pill-done' },
    blocked:     { l: 'Blocked',      p: 'pill-error' },
  };
  const TYPE = { audit: 'Audit', new_team: 'New team data', new_suburb: 'New suburb',
    awaiting_return: 'Awaiting return', companies: 'Companies data', other: 'Other' };
  const OPEN = (s) => s !== 'done' && s !== 'blocked';

  // Pagan's current work in flight (from 14 Aug) - one-click seed.
  const SEED = [
    { title: 'Audit Warriors data',   job_type: 'audit', team: 'Warriors',   status: 'in_progress' },
    { title: 'Audit Jaguars data',    job_type: 'audit', team: 'Jaguars',    status: 'in_progress' },
    { title: 'Audit Spartans data',   job_type: 'audit', team: 'Spartans',   status: 'in_progress' },
    { title: 'Audit Conquerors data', job_type: 'audit', team: 'Conquerors', status: 'in_progress' },
    { title: 'New data for the new Paarl team', job_type: 'new_team', team: 'Paarl (new)', area: 'Paarl', status: 'requested', priority: 'high' },
    { title: '4 suburbs owed back', job_type: 'awaiting_return', team: 'Bergscape & Retrievers', suburbs_count: 4, status: 'awaiting' },
    { title: '2 new suburbs for Gunslingers', job_type: 'new_suburb', team: 'Gunslingers', suburbs_count: 2, status: 'requested' },
    { title: 'Companies data', job_type: 'companies', team: 'All teams', status: 'in_progress' },
  ];

  let rows = [];
  const filter = { status: 'all', type: 'all', q: '' };

  const statusOpts = (sel) => Object.keys(STATUS).map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${STATUS[k].l}</option>`).join('');
  const typeOpts = (sel) => Object.keys(TYPE).map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${TYPE[k]}</option>`).join('');
  const pill = (s) => { const o = STATUS[s] || STATUS.to_do; return `<span class="pill ${o.p}">${H.esc(o.l)}</span>`; };

  function viewDataTracker(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head">
        <div><h2>Data Tracker</h2>
          <p class="ph-sub">Every Knowledge Factory data job - audits, new team data, suburbs owed back, new suburbs and the companies set - in one queue.</p></div>
      </div>
      <div class="kpi-grid" id="djStats"></div>

      <div class="card card-pad">
        <div class="card-head"><h3>Add a data job</h3></div>
        <div class="field-grid">
          <div class="field wide"><label for="djTitle">What needs doing <span class="req">*</span></label>
            <input id="djTitle" type="text" autocomplete="off" placeholder="e.g. Audit Warriors data / 3 new suburbs for Falcons"></div>
          <div class="field"><label for="djType">Type</label><select id="djType">${typeOpts('audit')}</select></div>
          <div class="field"><label for="djTeam">Team</label><input id="djTeam" type="text" placeholder="Warriors"></div>
          <div class="field"><label for="djArea">Area / suburbs</label><input id="djArea" type="text" placeholder="Paarl"></div>
          <div class="field"><label for="djCount">No. of suburbs</label><input id="djCount" type="number" min="0" placeholder="e.g. 4"></div>
          <div class="field"><label for="djStatus">Status</label><select id="djStatus">${statusOpts('to_do')}</select></div>
          <div class="field"><label for="djExpected">Expected back</label><input id="djExpected" type="text" placeholder="e.g. end July"></div>
        </div>
        <button type="button" class="btn btn-primary" id="djAdd">Add job</button>
      </div>

      <div class="card">
        <div class="card-head" style="padding:16px 18px 0"><h3>Jobs</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="djExport">Export CSV</button></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding:12px 18px">
          <select id="djfStatus" aria-label="Filter status"><option value="all">All statuses</option>${statusOpts('')}</select>
          <select id="djfType" aria-label="Filter type"><option value="all">All types</option>${typeOpts('')}</select>
          <input id="djfQ" type="search" placeholder="Search team or job..." style="flex:1;min-width:160px">
        </div>
        <div class="tbl-wrap"><table class="tbl" id="djTbl"></table></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    wire(wrap);
    load(wrap);
  }

  async function load(wrap) {
    const tbl = H.$('#djTbl', wrap);
    tbl.innerHTML = `<tbody><tr><td><div class="skeleton"></div></td></tr></tbody>`;
    try {
      const client = sb();
      const { data, error } = await client.from('data_jobs').select('*').order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      rows = data || [];
    } catch (err) {
      const hint = /relation|does not exist|schema cache/i.test(err.message)
        ? ' Apply supabase/migrations/0006_data_jobs.sql first.' : '';
      tbl.innerHTML = `<tbody><tr><td><div class="state"><div class="state-title">Could not load data jobs</div><div>${H.esc(err.message)}${H.esc(hint)}</div></div></td></tr></tbody>`;
      H.$('#djStats', wrap).innerHTML = ''; return;
    }
    render(wrap);
  }

  function render(wrap) {
    renderStats(wrap);
    renderTable(wrap);
  }

  function renderStats(wrap) {
    const open = rows.filter((r) => OPEN(r.status)).length;
    const awaiting = rows.filter((r) => r.status === 'awaiting').length;
    const active = rows.filter((r) => r.status === 'in_progress').length;
    const done = rows.filter((r) => r.status === 'done').length;
    const t = (cls, label, n) => `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${n}</div><div class="kpi-sub">&nbsp;</div></div>`;
    H.$('#djStats', wrap).innerHTML =
      `<div class="kpi kpi-hero"><div class="kpi-label">Open jobs</div><div class="hero-row"><span class="hero-num">${open}</span></div><div class="kpi-sub">${rows.length} total tracked</div></div>`
      + t('', 'Awaiting back', awaiting) + t('searched', 'In progress', active) + t('', 'Done', done);
  }

  function visible() {
    return rows.filter((r) => {
      if (filter.status !== 'all' && r.status !== filter.status) return false;
      if (filter.type !== 'all' && r.job_type !== filter.type) return false;
      if (filter.q) { const h = `${r.title} ${r.team} ${r.area}`.toLowerCase(); if (!h.includes(filter.q)) return false; }
      return true;
    });
  }

  function renderTable(wrap) {
    const head = `<thead><tr><th>Job</th><th>Type</th><th>Team</th><th>Area / suburbs</th><th>Status</th><th>Expected</th><th class="actions"></th></tr></thead>`;
    const list = visible();
    if (!rows.length) {
      H.$('#djTbl', wrap).innerHTML = head + `<tbody><tr><td colspan="7"><div class="state"><div class="state-title">No data jobs yet</div>
        <div style="margin-top:10px"><button type="button" class="btn btn-gold btn-sm" id="djSeed">Load my current jobs</button></div></div></td></tr></tbody>`;
      const s = H.$('#djSeed', wrap); if (s) s.addEventListener('click', () => seed(wrap, s));
      return;
    }
    if (!list.length) { H.$('#djTbl', wrap).innerHTML = head + `<tbody><tr><td colspan="7"><div class="state"><div class="state-title">Nothing matches these filters</div></div></td></tr></tbody>`; return; }
    const body = list.map((r) => {
      const area = [r.area, r.suburbs_count ? `${r.suburbs_count} suburb${r.suburbs_count > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
      return `<tr data-id="${H.esc(r.id)}">
        <td class="who">${H.esc(r.title)}${r.priority === 'high' ? ' <span class="pill pill-error" style="font-size:9px">High</span>' : ''}</td>
        <td>${H.esc(TYPE[r.job_type] || r.job_type)}</td>
        <td>${H.esc(r.team || '')}</td>
        <td class="muted">${H.esc(area)}</td>
        <td>${pill(r.status)}</td>
        <td class="muted">${H.esc(r.expected || '')}</td>
        <td class="actions"><button type="button" class="btn btn-ghost btn-sm" data-edit="${H.esc(r.id)}">Update</button></td>
      </tr>`;
    }).join('');
    H.$('#djTbl', wrap).innerHTML = head + `<tbody>${body}</tbody>`;
    H.$('#djTbl', wrap).querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editor(wrap, b.dataset.edit)));
  }

  function editor(wrap, id) {
    const rec = rows.find((r) => String(r.id) === String(id));
    const tr = H.$(`tr[data-id="${String(id).replace(/["\\]/g, '\\$&')}"]`, wrap);
    if (!rec || !tr) return;
    tr.innerHTML = `<td class="who">${H.esc(rec.title)}</td>
      <td colspan="5"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select class="e-status">${statusOpts(rec.status)}</select>
        <input class="e-count" type="number" min="0" placeholder="suburbs" value="${rec.suburbs_count != null ? rec.suburbs_count : ''}" style="width:90px">
        <input class="e-exp" type="text" placeholder="expected back" value="${H.esc(rec.expected || '')}" style="min-width:120px">
        <input class="e-notes" type="text" placeholder="notes" value="${H.esc(rec.notes || '')}" style="flex:1;min-width:140px">
      </div></td>
      <td class="actions" style="white-space:nowrap">
        <button type="button" class="btn btn-primary btn-sm e-save">Save</button>
        <button type="button" class="btn btn-ghost btn-sm e-del">Delete</button>
        <button type="button" class="btn btn-ghost btn-sm e-cancel">Cancel</button></td>`;
    H.$('.e-cancel', tr).addEventListener('click', () => renderTable(wrap));
    H.$('.e-save', tr).addEventListener('click', async () => {
      const patch = {
        status: H.$('.e-status', tr).value,
        suburbs_count: H.$('.e-count', tr).value === '' ? null : parseInt(H.$('.e-count', tr).value, 10),
        expected: H.$('.e-exp', tr).value.trim() || null,
        notes: H.$('.e-notes', tr).value.trim() || null,
      };
      const btn = H.$('.e-save', tr); btn.classList.add('loading'); btn.disabled = true;
      try {
        const { error } = await sb().from('data_jobs').update(patch).eq('id', rec.id);
        if (error) throw new Error(error.message);
        Object.assign(rec, patch);
        H.toast('Saved', `${rec.title} → ${STATUS[patch.status].l}.`, 'ok');
        render(wrap);
      } catch (err) { btn.classList.remove('loading'); btn.disabled = false; H.toast('Could not save', err.message, 'err'); }
    });
    let armed = false;
    const del = H.$('.e-del', tr);
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = 'Confirm'; del.classList.add('btn-danger'); del.classList.remove('btn-ghost'); setTimeout(() => { if (armed && del.isConnected) { armed = false; del.textContent = 'Delete'; del.classList.remove('btn-danger'); del.classList.add('btn-ghost'); } }, 3000); return; }
      del.classList.add('loading'); del.disabled = true;
      try {
        const { error } = await sb().from('data_jobs').delete().eq('id', rec.id);
        if (error) throw new Error(error.message);
        rows = rows.filter((r) => r.id !== rec.id);
        H.toast('Deleted', `${rec.title} removed.`, 'ok'); render(wrap);
      } catch (err) { del.classList.remove('loading'); del.disabled = false; H.toast('Could not delete', err.message, 'err'); }
    });
  }

  async function add(wrap) {
    const title = H.$('#djTitle', wrap).value.trim();
    if (!title) { H.toast('Needs a title', 'Say what the job is.', 'err'); return; }
    const cnt = H.$('#djCount', wrap).value;
    const row = {
      title, job_type: H.$('#djType', wrap).value, team: H.$('#djTeam', wrap).value.trim() || null,
      area: H.$('#djArea', wrap).value.trim() || null, suburbs_count: cnt === '' ? null : parseInt(cnt, 10),
      status: H.$('#djStatus', wrap).value, expected: H.$('#djExpected', wrap).value.trim() || null, created_by: who(),
    };
    const btn = H.$('#djAdd', wrap); btn.classList.add('loading'); btn.disabled = true;
    try {
      const { error } = await sb().from('data_jobs').insert(row);
      if (error) throw new Error(error.message);
      H.toast('Job added', title, 'ok');
      ['#djTitle', '#djTeam', '#djArea', '#djCount', '#djExpected'].forEach((s) => { H.$(s, wrap).value = ''; });
      await load(wrap);
    } catch (err) { H.toast('Could not add', err.message, 'err'); }
    finally { btn.classList.remove('loading'); btn.disabled = false; }
  }

  async function seed(wrap, btn) {
    btn.classList.add('loading'); btn.disabled = true;
    try {
      const list = SEED.map((s) => Object.assign({ created_by: who(), supplier: 'Knowledge Factory' }, s));
      const { error } = await sb().from('data_jobs').insert(list);
      if (error) throw new Error(error.message);
      H.toast('Loaded your current jobs', `${list.length} jobs added.`, 'ok');
      await load(wrap);
    } catch (err) { btn.classList.remove('loading'); btn.disabled = false; H.toast('Could not seed', err.message, 'err'); }
  }

  function exportCsv() {
    const head = ['title', 'type', 'team', 'area', 'suburbs', 'status', 'expected', 'notes'];
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.join(',')].concat(visible().map((r) => [r.title, TYPE[r.job_type] || r.job_type, r.team, r.area, r.suburbs_count, STATUS[r.status] ? STATUS[r.status].l : r.status, r.expected, r.notes].map(q).join(',')));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'data-jobs.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wire(wrap) {
    H.$('#djAdd', wrap).addEventListener('click', () => add(wrap));
    H.$('#djExport', wrap).addEventListener('click', exportCsv);
    H.$('#djfStatus', wrap).addEventListener('change', (e) => { filter.status = e.target.value; renderTable(wrap); });
    H.$('#djfType', wrap).addEventListener('change', (e) => { filter.type = e.target.value; renderTable(wrap); });
    H.$('#djfQ', wrap).addEventListener('input', (e) => { filter.q = e.target.value.toLowerCase().trim(); renderTable(wrap); });
  }

  H.viewDataTracker = viewDataTracker;
})();
