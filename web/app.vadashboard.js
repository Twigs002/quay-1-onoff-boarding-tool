/* VA Dashboard - the at-a-glance view (window.HUB.viewVaDashboard).
 *
 * Answers the core question: how many contacts have we searched, how many were
 * SUCCESSFUL (a number found) and how many were NOT. All figures come from fast
 * COUNT queries (window.VA.counts) + the optional per-sheet view, never a full
 * table pull - so it stays instant at 36k+ rows. Rendered on the Pagan Hub.
 */
(() => {
  'use strict';
  const H = window.HUB, VA = window.VA;
  if (!H || !VA) return;

  const fmt = (n) => (n || 0).toLocaleString();
  const pctText = (x) => `${Math.round((x || 0) * 100)}%`;
  let entity = 'all';

  const C_GOOD = '#1E7A4B', C_BAD = '#D20A03', C_WAIT = '#8A93A5';

  function donut(segments, bigText, capText) {
    const R = 74, CIRC = 2 * Math.PI * R, cx = 84, total = segments.reduce((a, s) => a + s.v, 0) || 1;
    let off = 0;
    const arcs = segments.filter((s) => s.v > 0).map((s) => {
      const frac = s.v / total, dash = frac * CIRC;
      const c = `<circle cx="${cx}" cy="${cx}" r="${R}" fill="none" stroke="${s.color}" stroke-width="20"
        stroke-dasharray="${dash.toFixed(2)} ${(CIRC - dash).toFixed(2)}" stroke-dashoffset="${(-off * CIRC).toFixed(2)}"/>`;
      off += frac; return c;
    }).join('');
    const legend = segments.map((s) => {
      const p = total ? Math.round((s.v / total) * 100) : 0;
      return `<div class="legend-row"><span class="legend-dot" style="background:${s.color}"></span>
        <span class="lg-name">${H.esc(s.name)}</span><b>${fmt(s.v)}</b><span class="lg-pct">${p}%</span></div>`;
    }).join('');
    return `<div class="va-donut-wrap">
      <div class="va-donut"><svg viewBox="0 0 168 168" width="168" height="168">
        <circle cx="${cx}" cy="${cx}" r="${R}" fill="none" stroke="var(--line-soft)" stroke-width="20"/>${arcs}
      </svg><div class="donut-center"><span class="big">${bigText}</span><span class="cap">${H.esc(capText)}</span></div></div>
      <div class="legend">${legend}</div></div>`;
  }

  function ring(frac, label) {
    const R = 50, CIRC = 2 * Math.PI * R, cx = 58, dash = (frac || 0) * CIRC;
    return `<div class="rate-hero">
      <div class="rate-ring"><svg viewBox="0 0 116 116" width="116" height="116">
        <circle cx="${cx}" cy="${cx}" r="${R}" fill="none" stroke="var(--line-soft)" stroke-width="12"/>
        <circle cx="${cx}" cy="${cx}" r="${R}" fill="none" stroke="${C_GOOD}" stroke-width="12" stroke-linecap="round"
          stroke-dasharray="${dash.toFixed(2)} ${(CIRC - dash).toFixed(2)}"/>
      </svg><div class="rr-num">${pctText(frac)}</div></div>
      <div><div class="kpi-label">Success rate</div>
        <div class="kpi-sub" style="margin-top:8px;max-width:34ch">${H.esc(label)}</div></div></div>`;
  }

  function bars(c) {
    const rows = [
      { name: 'Found · changed', v: c.found_changed, cls: 'changed' },
      { name: 'Found · same', v: c.found_unchanged, cls: 'good' },
      { name: 'Not found', v: c.not_found, cls: 'bad' },
      { name: 'Pending', v: c.pending, cls: 'pending' },
    ];
    const max = c.total || 1;
    return `<div class="bars">${rows.map((r) => {
      const p = Math.round((r.v / max) * 100);
      return `<div class="bar-row"><span class="bar-name">${H.esc(r.name)}</span>
        <span class="bar-track"><span class="bar-fill ${r.cls}" style="width:${p}%"></span></span>
        <span class="bar-meta"><b>${fmt(r.v)}</b> · ${p}%</span></div>`;
    }).join('')}</div>`;
  }

  function kpis(c) {
    const tile = (cls, label, value, sub) =>
      `<div class="kpi ${cls}"><div class="kpi-label">${H.esc(label)}</div>
        <div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
    return tile('', 'Contacts total', fmt(c.total), `${fmt(c.pending)} still pending`)
      + tile('gold', 'Searched', fmt(c.searched), `${pctText(c.progress)} of all contacts`)
      + tile('good', 'Successful', fmt(c.successful), `number found · ${pctText(c.successRate)} hit rate`)
      + tile('bad', 'Not found', fmt(c.unsuccessful), `${pctText(c.searched ? c.unsuccessful / c.searched : 0)} of searched`);
  }

  function miniSplit(label, c) {
    const rate = Math.round((c.successRate || 0) * 100);
    return `<div class="mini"><div class="mini-top"><span class="t">${H.esc(label)}</span>
      <span class="kpi-sub" style="margin:0">${pctText(c.successRate)} success</span></div>
      <div class="mini-num">${fmt(c.total)}</div>
      <div class="kpi-sub" style="margin-top:2px">${fmt(c.searched)} searched · ${fmt(c.successful)} found</div>
      <div class="mini-bar"><span style="width:${rate}%"></span></div></div>`;
  }

  function sheetTable(sheets) {
    const host = document.getElementById('dashSheetsCard');
    if (!host) return;
    if (sheets === null) {
      host.querySelector('.tbl-wrap').innerHTML =
        `<div class="card-pad"><div class="notice notice-info">Per-sheet analytics need the <code>va_search_stats</code> view - apply <code>supabase/migrations/0003_va_search_stats_view.sql</code> and refresh. Everything else on this dashboard works without it.</div></div>`;
      return;
    }
    if (!sheets.length) { host.style.display = 'none'; return; }
    const head = `<thead><tr><th>Sheet</th><th>Contacts</th><th>Searched</th><th>Found</th><th>Success</th><th>Pending</th></tr></thead>`;
    const body = sheets.map((s) => {
      const rate = Math.round((s.successRate || 0) * 100);
      return `<tr><td class="who">${H.esc(s.sheet || '(unnamed)')}</td>
        <td>${fmt(s.total)}</td><td>${fmt(s.searched)}</td><td>${fmt(s.successful)}</td>
        <td><span class="sheet-rate"><span class="mini-track"><span style="width:${rate}%"></span></span>${rate}%</span></td>
        <td class="muted">${fmt(s.pending)}</td></tr>`;
    }).join('');
    host.querySelector('.tbl-wrap').innerHTML = `<table class="tbl">${head}<tbody>${body}</tbody></table>`;
  }

  async function load(wrap) {
    const khost = H.$('#dashKpis', wrap);
    khost.innerHTML = `<div class="card stat"><div class="skeleton"></div></div>`.repeat(4);
    let c, cCo, cPe, sheets;
    try {
      [c, cCo, cPe, sheets] = await Promise.all([
        VA.counts(entity), VA.counts('company'), VA.counts('person'), VA.perSheet(entity),
      ]);
    } catch (err) {
      const hint = /relation|does not exist|schema cache/i.test(err.message)
        ? ' The table may not exist yet - apply supabase/migrations/0001_va_search_records.sql.' : '';
      khost.innerHTML = `<div class="card card-pad" style="grid-column:1/-1"><div class="state"><div class="state-title">Could not load the dashboard</div><div>${H.esc(err.message)}${H.esc(hint)}</div></div></div>`;
      return;
    }
    khost.innerHTML = kpis(c);
    H.$('#dashDonut', wrap).innerHTML = donut([
      { name: 'Successful', v: c.successful, color: C_GOOD },
      { name: 'Not found', v: c.unsuccessful, color: C_BAD },
      { name: 'Pending', v: c.pending, color: C_WAIT },
    ], fmt(c.total), 'contacts');
    H.$('#dashBars', wrap).innerHTML = bars(c);
    H.$('#dashRate', wrap).innerHTML = ring(c.successRate,
      `${fmt(c.successful)} of ${fmt(c.searched)} searched contacts got a number.`);
    H.$('#dashSplit', wrap).innerHTML = miniSplit('Companies', cCo) + miniSplit('Natural persons', cPe);
    sheetTable(sheets);
  }

  function viewVaDashboard(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head">
        <div><h2>VA Dashboard</h2>
          <p>Skip-tracing at a glance: how much of the book you've worked, and how much of that actually turned up a number. Use the toggle to focus on companies or people.</p></div>
        <div class="segmented" id="dashEntity" role="group" aria-label="Contact type">
          <button type="button" data-e="all" aria-pressed="true">All</button>
          <button type="button" data-e="company" aria-pressed="false">Companies</button>
          <button type="button" data-e="person" aria-pressed="false">People</button>
        </div>
      </div>
      <div class="kpi-grid" id="dashKpis"></div>
      <div class="chart-grid">
        <div class="card card-pad"><div class="card-head"><h3>Successful vs not</h3></div><div id="dashDonut"></div></div>
        <div class="card card-pad"><div class="card-head"><h3>Outcome breakdown</h3></div>
          <div id="dashBars"></div><div id="dashRate" style="margin-top:20px"></div></div>
      </div>
      <div class="card card-pad"><div class="card-head"><h3>By contact type</h3></div><div class="split-2" id="dashSplit"></div></div>
      <div class="card" id="dashSheetsCard"><div class="card-head" style="padding:16px 18px 0"><h3>By sheet</h3></div>
        <div class="tbl-wrap"></div></div>
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
