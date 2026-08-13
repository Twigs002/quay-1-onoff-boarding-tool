/* VA Dashboard - the at-a-glance view (window.HUB.viewVaDashboard).
 *
 * Answers: how many contacts searched, how many SUCCESSFUL (a number found) and
 * how many NOT. All figures come from fast COUNT queries (window.VA.counts) + the
 * optional per-sheet view, never a full table pull - instant at 36k+ rows.
 *
 * Visuals follow the approved Quay 1 brand redesign (option 3a): a gold success-
 * rate hero, a CSS conic-gradient donut, outcome bars, a pending call-to-action
 * band, an entity split, and a per-sheet table. Styling lives in pagan-hub.css.
 */
(() => {
  'use strict';
  const H = window.HUB, VA = window.VA;
  if (!H || !VA) return;

  const fmt = (n) => (n || 0).toLocaleString();
  const pctText = (x) => `${Math.round((x || 0) * 100)}%`;
  let entity = 'all';

  // KPI row: gold hero (success rate) + three plain tiles.
  function kpis(c) {
    const note = !c.searched ? '' : c.successRate >= 0.6 ? 'strong run' : c.successRate >= 0.4 ? 'getting there' : 'early days';
    const hero = `<div class="kpi kpi-hero">
      <div class="kpi-label">Success rate</div>
      <div class="hero-row"><span class="hero-num">${pctText(c.successRate)}</span>${note ? `<span class="hero-note">${note}</span>` : ''}</div>
      <div class="kpi-sub">${fmt(c.successful)} of ${fmt(c.searched)} searched contacts got a number.</div></div>`;
    const tile = (cls, label, value, sub) =>
      `<div class="kpi ${cls}"><div class="kpi-label">${H.esc(label)}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
    return hero
      + tile('', 'Contacts total', fmt(c.total), `${fmt(c.pending)} still pending`)
      + tile('searched', 'Searched', fmt(c.searched), `${pctText(c.progress)} of all contacts`)
      + tile('bad', 'Not found', fmt(c.unsuccessful), `${pctText(c.searched ? c.unsuccessful / c.searched : 0)} of searched`);
  }

  // CSS conic-gradient donut: gold (successful) -> red (not found) -> sky (pending).
  function donut(c) {
    const total = c.total || 1;
    const a = (c.successful / total) * 100, b = ((c.successful + c.unsuccessful) / total) * 100;
    const rows = [['var(--q-gold)', 'Successful', c.successful], ['var(--q-red)', 'Not found', c.unsuccessful], ['var(--q-sky)', 'Pending', c.pending]];
    const legend = rows.map(([col, name, v]) => `<div class="legend-row"><span class="legend-dot" style="background:${col}"></span>${name}<b>${fmt(v)}</b></div>`).join('');
    return `<div class="va-donut" style="--seg-a:${a.toFixed(1)}%;--seg-b:${b.toFixed(1)}%">
        <div class="donut-center"><span class="big">${fmt(c.total)}</span><span class="cap">contacts</span></div>
      </div><div class="legend">${legend}</div>`;
  }

  function bars(c) {
    const rows = [
      { name: 'Found · changed', v: c.found_changed, cls: 'changed' },
      { name: 'Found · same', v: c.found_unchanged, cls: 'good' },
      { name: 'Not found', v: c.not_found, cls: 'bad' },
      { name: 'Pending', v: c.pending, cls: 'pending' },
    ];
    const max = c.total || 1;
    return rows.map((r) => {
      const p = Math.round((r.v / max) * 100);
      return `<div class="bar-row"><span class="bar-name">${H.esc(r.name)}</span>
        <span class="bar-track"><span class="bar-fill ${r.cls}" style="width:${p}%"></span></span>
        <span class="bar-meta"><b>${fmt(r.v)}</b> · ${p}%</span></div>`;
    }).join('');
  }

  function cta(c) {
    const p = c.total ? Math.round((c.pending / c.total) * 100) : 0;
    return `<div class="ph-cta"><div>
        <div class="ph-label">Still to work</div>
        <div class="row"><span class="n">${fmt(c.pending)}</span><span class="m">contacts pending · ${p}% of the book</span></div>
      </div><button type="button" class="btn btn-gold" id="dashOpenQueue">Open queue</button></div>`;
  }

  function miniSplit(label, c) {
    return `<div class="mini"><div class="t">${H.esc(label)}</div>
      <div class="mini-num">${fmt(c.total)}</div><div class="mini-sub">${pctText(c.successRate)} found</div></div>`;
  }

  function sheetTable(sheets) {
    const host = document.getElementById('dashSheetsCard'); if (!host) return;
    const wrap = host.querySelector('.tbl-wrap'), meta = document.getElementById('dashSheetMeta');
    if (sheets === null) {
      if (meta) meta.textContent = '';
      wrap.innerHTML = `<div class="card-pad"><div class="notice notice-info">Per-sheet analytics need the <code>va_search_stats</code> view - apply <code>supabase/migrations/0003_va_search_stats_view.sql</code> and refresh. Everything else works without it.</div></div>`;
      return;
    }
    if (!sheets.length) { host.style.display = 'none'; return; }
    host.style.display = '';
    if (meta) meta.textContent = `${sheets.length} sheet${sheets.length > 1 ? 's' : ''} · sorted by contacts`;
    const head = `<thead><tr><th>Sheet</th><th>Contacts</th><th>Searched</th><th>Found</th><th>Success</th><th>Pending</th></tr></thead>`;
    const body = sheets.map((s) => {
      const rate = Math.round((s.successRate || 0) * 100);
      return `<tr><td class="who">${H.esc(s.sheet || '(unnamed)')}</td>
        <td>${fmt(s.total)}</td><td>${fmt(s.searched)}</td><td>${fmt(s.successful)}</td>
        <td><span class="sheet-rate"><span class="mini-track"><span style="width:${rate}%"></span></span>${rate}%</span></td>
        <td class="muted">${fmt(s.pending)}</td></tr>`;
    }).join('');
    wrap.innerHTML = `<table class="tbl">${head}<tbody>${body}</tbody></table>`;
  }

  async function load(wrap) {
    const khost = H.$('#dashKpis', wrap);
    khost.innerHTML = `<div class="kpi"><div class="skeleton"></div></div>`.repeat(4);
    let c, cCo, cPe, sheets;
    try {
      [c, cCo, cPe, sheets] = await Promise.all([
        VA.counts(entity), VA.counts('company'), VA.counts('person'), VA.perSheet(entity),
      ]);
    } catch (err) {
      const hint = /relation|does not exist|schema cache/i.test(err.message)
        ? ' The table may not exist yet - apply supabase/migrations/0001_va_search_records.sql.' : '';
      khost.innerHTML = `<div class="card card-pad" style="grid-column:1/-1"><div class="notice notice-warn">Could not load the dashboard: ${H.esc(err.message)}${H.esc(hint)}</div></div>`;
      return;
    }
    khost.innerHTML = kpis(c);
    H.$('#dashDonut', wrap).innerHTML = donut(c);
    H.$('#dashSplit', wrap).innerHTML = miniSplit('Companies', cCo) + miniSplit('Persons', cPe);
    H.$('#dashBars', wrap).innerHTML = bars(c);
    H.$('#dashCta', wrap).innerHTML = cta(c);
    const oq = H.$('#dashOpenQueue', wrap);
    if (oq) oq.addEventListener('click', () => { const t = document.querySelector('.tab-btn[data-tab="vasearches"]'); if (t) t.click(); });
    sheetTable(sheets);
  }

  function viewVaDashboard(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head">
        <div><h2>Skip-tracing at a glance</h2>
          <p class="ph-sub">How much of the book you have worked, and how much of that actually turned up a number.</p></div>
        <div class="segmented" id="dashEntity" role="group" aria-label="Contact type">
          <button type="button" data-e="all" aria-pressed="true">All</button>
          <button type="button" data-e="company" aria-pressed="false">Companies</button>
          <button type="button" data-e="person" aria-pressed="false">People</button>
        </div>
      </div>
      <div class="kpi-grid" id="dashKpis"></div>
      <div class="chart-grid">
        <div class="card card-pad">
          <div class="ph-label" style="margin-bottom:20px">Successful vs not</div>
          <div class="va-donut-wrap" id="dashDonut"></div>
          <div class="split-2" id="dashSplit"></div>
        </div>
        <div class="stack" style="gap:14px">
          <div class="card card-pad" style="flex:1">
            <div class="ph-label" style="margin-bottom:18px">Outcome breakdown</div>
            <div class="bars" id="dashBars"></div>
          </div>
          <div id="dashCta"></div>
        </div>
      </div>
      <div class="tbl-card" id="dashSheetsCard">
        <div class="tbl-head"><h3>By sheet</h3><span id="dashSheetMeta"></span></div>
        <div class="tbl-wrap"></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    H.$('#dashEntity', wrap).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-e]'); if (!b) return;
      entity = b.dataset.e;
      H.$('#dashEntity', wrap).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      load(wrap);
    });
    load(wrap);
  }

  H.viewVaDashboard = viewVaDashboard;
})();
