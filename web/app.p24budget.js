/* Pagan Hub - P24 Budget (window.HUB.viewP24Budget).
 *
 * Property24 marketing budget: per-team monthly allocation vs actual listing spend,
 * left-to-spend and % used, with a monthly rollup - mirroring the budget sheet.
 * Backed by p24_allocations (the per-team budget) + p24_spend (logged spends),
 * migration 0008. Pagan-only (RLS). Read/written directly from the browser.
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) return;
  const sb = () => (window.AUTH && window.AUTH.getClient && window.AUTH.getClient());
  const who = () => { const u = H.getUser && H.getUser(); return (u && (u.name || u.username)) || 'Pagan'; };
  const R = (n) => 'R' + Math.round(Number(n) || 0).toLocaleString();
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const monthLabel = (k) => { const [y, m] = k.split('-'); return `${MON[+m - 1]} ${y}`; };

  // Team allocations from the budget sheet (monthly R, weekly R, listings/week).
  const SEED = [
    ['Christine', 'christine@quay1.co.za', 16000, 3200, 6], ['Justin', 'justin@quay1.co.za', 16000, 3200, 6],
    ['Trent', 'trent@quay1.co.za', 16000, 3200, 6], ['Nic', 'nic@quay1.co.za', 10750, 2150, 4],
    ['Russell', 'russell@quay1.co.za', 8000, 1600, 3], ['Cyndy', 'cyndy@quay1.co.za', 5500, 1100, 2],
    ['Dino', 'dino@quay1.co.za', 5500, 1100, 2], ['Nelio', 'nelio@quay1.co.za', 8000, 1600, 3],
    ['Storm', 'storm@quay1.co.za', 5500, 1100, 2], ['Jono', 'jonathan@quay1.co.za', 7250, 1450, 3],
    ['Gaelle', 'gaelle@quay1.co.za', 5500, 1100, 2],
  ];

  let allocs = [], spend = [], month = monthKey(new Date());

  function viewP24Budget(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head">
        <div><h2>P24 Budget</h2>
          <p class="ph-sub">Property24 spend against each team's monthly allocation - what's spent, what's left, and where it's going.</p></div>
        <div class="segmented" id="pbMonth" role="group" aria-label="Month">
          <button type="button" id="pbPrev">◀</button>
          <button type="button" aria-pressed="true" id="pbLabel" style="min-width:110px">${monthLabel(month)}</button>
          <button type="button" id="pbNext">▶</button>
        </div>
      </div>
      <div class="kpi-grid" id="pbStats"></div>

      <div class="card card-pad">
        <div class="card-head"><h3>Log a P24 spend</h3></div>
        <div class="field-grid">
          <div class="field"><label for="pbTeam">Team</label><select id="pbTeam"></select></div>
          <div class="field"><label for="pbAmount">Amount (R) <span class="req">*</span></label><input id="pbAmount" type="number" min="0" step="0.01" placeholder="e.g. 828"></div>
          <div class="field"><label for="pbDate">Date</label><input id="pbDate" type="date"></div>
          <div class="field"><label for="pbRef">Listing / suburb</label><input id="pbRef" type="text" placeholder="e.g. Zonnebloem boost"></div>
        </div>
        <button type="button" class="btn btn-primary" id="pbAdd">Log spend</button>
      </div>

      <div class="card">
        <div class="card-head" style="padding:16px 18px 0"><h3>By team — ${monthLabel(month)}</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="pbExport">Export CSV</button></div>
        <div class="tbl-wrap"><table class="tbl" id="pbTeams"></table></div>
      </div>

      <div class="card">
        <div class="card-head" style="padding:16px 18px 0"><h3>Spends this month</h3></div>
        <div class="tbl-wrap"><table class="tbl" id="pbSpend"></table></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    H.$('#pbDate', wrap).value = new Date().toISOString().slice(0, 10);
    wire(wrap);
    load(wrap);
  }

  async function load(wrap) {
    const teams = H.$('#pbTeams', wrap);
    teams.innerHTML = `<tbody><tr><td><div class="skeleton"></div></td></tr></tbody>`;
    try {
      const c = sb();
      const [a, s] = await Promise.all([
        c.from('p24_allocations').select('*').order('monthly_allocation', { ascending: false }),
        c.from('p24_spend').select('*').eq('month', month).order('spent_on', { ascending: false }),
      ]);
      if (a.error) throw new Error(a.error.message);
      if (s.error) throw new Error(s.error.message);
      allocs = a.data || []; spend = s.data || [];
    } catch (err) {
      const hint = /relation|does not exist|schema cache/i.test(err.message) ? ' Apply 0008_p24_budget.sql first.' : '';
      teams.innerHTML = `<tbody><tr><td><div class="state"><div class="state-title">Could not load P24 budget</div><div>${H.esc(err.message)}${H.esc(hint)}</div></div></td></tr></tbody>`;
      H.$('#pbStats', wrap).innerHTML = ''; return;
    }
    fillTeamSelect(wrap);
    render(wrap);
  }

  const spentByTeam = () => { const m = {}; spend.forEach((s) => { m[s.team] = (m[s.team] || 0) + Number(s.amount || 0); }); return m; };

  function render(wrap) {
    const byTeam = spentByTeam();
    const totalAlloc = allocs.reduce((a, r) => a + Number(r.monthly_allocation || 0), 0);
    const totalSpent = spend.reduce((a, s) => a + Number(s.amount || 0), 0);
    const left = totalAlloc - totalSpent;
    const pct = totalAlloc ? Math.round((totalSpent / totalAlloc) * 100) : 0;
    const over = allocs.filter((r) => (byTeam[r.team] || 0) > Number(r.monthly_allocation || 0)).length;
    H.$('#pbStats', wrap).innerHTML =
      `<div class="kpi kpi-hero"><div class="kpi-label">Budget left</div><div class="hero-row"><span class="hero-num">${R(left)}</span></div><div class="kpi-sub">${R(totalSpent)} of ${R(totalAlloc)} spent · ${pct}%</div></div>`
      + `<div class="kpi"><div class="kpi-label">Monthly budget</div><div class="kpi-value">${R(totalAlloc)}</div><div class="kpi-sub">${allocs.length} teams</div></div>`
      + `<div class="kpi searched"><div class="kpi-label">Spent</div><div class="kpi-value">${R(totalSpent)}</div><div class="kpi-sub">${spend.length} spends logged</div></div>`
      + `<div class="kpi ${over ? 'bad' : ''}"><div class="kpi-label">Over budget</div><div class="kpi-value">${over}</div><div class="kpi-sub">teams past allocation</div></div>`;
    renderTeams(wrap, byTeam);
    renderSpend(wrap);
  }

  function renderTeams(wrap, byTeam) {
    const head = `<thead><tr><th>Team</th><th>Allocation</th><th>Spent</th><th>Left</th><th>Used</th></tr></thead>`;
    if (!allocs.length) {
      H.$('#pbTeams', wrap).innerHTML = head + `<tbody><tr><td colspan="5"><div class="state"><div class="state-title">No team allocations yet</div><div style="margin-top:10px"><button type="button" class="btn btn-gold btn-sm" id="pbSeed">Load teams from the sheet</button></div></div></td></tr></tbody>`;
      const s = H.$('#pbSeed', wrap); if (s) s.addEventListener('click', () => seed(wrap, s));
      return;
    }
    const body = allocs.map((r) => {
      const sp = byTeam[r.team] || 0, alloc = Number(r.monthly_allocation || 0), left = alloc - sp;
      const p = alloc ? Math.round((sp / alloc) * 100) : 0, o = sp > alloc;
      return `<tr><td class="who">${H.esc(r.team)}</td><td>${R(alloc)}</td><td>${R(sp)}</td>
        <td class="${o ? '' : 'muted'}" style="${o ? 'color:var(--q-red);font-weight:700' : ''}">${R(left)}</td>
        <td><span class="sheet-rate"><span class="mini-track"><span style="width:${Math.min(100, p)}%;${o ? 'background:var(--q-red)' : ''}"></span></span>${p}%</span></td></tr>`;
    }).join('');
    H.$('#pbTeams', wrap).innerHTML = head + `<tbody>${body}</tbody>`;
  }

  function renderSpend(wrap) {
    const head = `<thead><tr><th>Date</th><th>Team</th><th>Amount</th><th>Listing / suburb</th><th class="actions"></th></tr></thead>`;
    if (!spend.length) { H.$('#pbSpend', wrap).innerHTML = head + `<tbody><tr><td colspan="5"><div class="state"><div class="state-title">No spends logged for ${monthLabel(month)}</div></div></td></tr></tbody>`; return; }
    const body = spend.map((s) => `<tr data-id="${H.esc(s.id)}">
      <td class="muted">${H.esc(s.spent_on || '')}</td><td>${H.esc(s.team)}</td><td class="who">${R(s.amount)}</td>
      <td class="muted">${H.esc(s.listing_ref || '')}</td>
      <td class="actions"><button type="button" class="btn btn-ghost btn-sm" data-del="${H.esc(s.id)}">Delete</button></td></tr>`).join('');
    H.$('#pbSpend', wrap).innerHTML = head + `<tbody>${body}</tbody>`;
    H.$('#pbSpend', wrap).querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delSpend(wrap, b)));
  }

  function fillTeamSelect(wrap) {
    const names = allocs.map((a) => a.team).concat(['Admin', 'Pagan']);
    H.$('#pbTeam', wrap).innerHTML = names.map((n) => `<option value="${H.esc(n)}">${H.esc(n)}</option>`).join('');
  }

  async function addSpend(wrap) {
    const amount = parseFloat(H.$('#pbAmount', wrap).value);
    if (!(amount > 0)) { H.toast('Amount needed', 'Enter the spend amount.', 'err'); return; }
    const d = H.$('#pbDate', wrap).value || new Date().toISOString().slice(0, 10);
    const row = { team: H.$('#pbTeam', wrap).value, amount, spent_on: d, month: d.slice(0, 7),
      listing_ref: H.$('#pbRef', wrap).value.trim() || null, created_by: who() };
    const btn = H.$('#pbAdd', wrap); btn.classList.add('loading'); btn.disabled = true;
    try {
      const { error } = await sb().from('p24_spend').insert(row);
      if (error) throw new Error(error.message);
      H.toast('Spend logged', `${R(amount)} · ${row.team}`, 'ok');
      H.$('#pbAmount', wrap).value = ''; H.$('#pbRef', wrap).value = '';
      if (row.month !== month) { month = row.month; H.$('#pbLabel', wrap).textContent = monthLabel(month); }
      await load(wrap);
    } catch (err) { H.toast('Could not log', err.message, 'err'); }
    finally { btn.classList.remove('loading'); btn.disabled = false; }
  }

  async function delSpend(wrap, b) {
    if (b.textContent !== 'Confirm') { b.textContent = 'Confirm'; b.classList.add('btn-danger'); b.classList.remove('btn-ghost'); setTimeout(() => { if (b.isConnected && b.textContent === 'Confirm') { b.textContent = 'Delete'; b.classList.remove('btn-danger'); b.classList.add('btn-ghost'); } }, 3000); return; }
    b.classList.add('loading'); b.disabled = true;
    try { const { error } = await sb().from('p24_spend').delete().eq('id', b.dataset.del); if (error) throw new Error(error.message); H.toast('Deleted', '', 'ok'); await load(wrap); }
    catch (err) { b.classList.remove('loading'); b.disabled = false; H.toast('Could not delete', err.message, 'err'); }
  }

  async function seed(wrap, btn) {
    btn.classList.add('loading'); btn.disabled = true;
    try {
      const rows = SEED.map(([team, email, ma, ws, lpw]) => ({ team, email, monthly_allocation: ma, weekly_spend: ws, listings_per_week: lpw }));
      const { error } = await sb().from('p24_allocations').upsert(rows, { onConflict: 'team', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      H.toast('Teams loaded', `${rows.length} allocations · R104,000/mo.`, 'ok');
      await load(wrap);
    } catch (err) { btn.classList.remove('loading'); btn.disabled = false; H.toast('Could not seed', err.message, 'err'); }
  }

  function exportCsv(wrap) {
    const byTeam = spentByTeam();
    const head = ['team', 'allocation', 'spent', 'left', 'pct'];
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.join(',')].concat(allocs.map((r) => { const sp = byTeam[r.team] || 0, al = Number(r.monthly_allocation || 0); return [r.team, al, sp, al - sp, al ? Math.round(sp / al * 100) : 0].map(q).join(','); }));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `p24-budget-${month}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function shiftMonth(wrap, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1); month = monthKey(d);
    H.$('#pbLabel', wrap).textContent = monthLabel(month);
    load(wrap);
  }

  function wire(wrap) {
    H.$('#pbAdd', wrap).addEventListener('click', () => addSpend(wrap));
    H.$('#pbExport', wrap).addEventListener('click', () => exportCsv(wrap));
    H.$('#pbPrev', wrap).addEventListener('click', () => shiftMonth(wrap, -1));
    H.$('#pbNext', wrap).addEventListener('click', () => shiftMonth(wrap, 1));
  }

  H.viewP24Budget = viewP24Budget;
})();
