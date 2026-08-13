/* VA Searches - the working view (window.HUB.viewVaSearches).
 *
 * The hands-on page: a compact stat strip, "add a sheet to search", bulk "import
 * results", and the raw log with inline per-row editing + CSV export. The heavy
 * lifting (counts, paging, queries) lives in window.VA (va-core.js) so this file
 * stays a thin UI over it and the log NEVER pulls the whole 36k+ table - it pages
 * 100 rows at a time, filtered server-side, with "load more".
 */
(() => {
  'use strict';
  const H = window.HUB, VA = window.VA;
  if (!H || !VA) return;
  const { OUTCOME, ENTITY, deriveOutcome } = VA;

  const PAGE = 100;
  const filter = { entity: 'all', sheet: 'all', outcome: 'all', q: '' };
  let logRows = [], logTotal = 0, logOffset = 0, searchTimer = null;

  const who = () => { const u = H.getUser && H.getUser(); return (u && (u.name || u.username)) || 'staff'; };
  const fmt = (n) => (n || 0).toLocaleString();

  function parseLines(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim(); if (!line) return;
      const parts = line.split(/[\t,;]/).map((p) => p.trim());
      const name = parts[0] || '';
      if (i === 0 && /^(name|company|contact)$/i.test(name) && !VA.digits(parts[1] || '')) return;
      if (!name) return;
      out.push({ name, num: parts[1] || '' });
    });
    return out;
  }
  function pill(outcome) { const o = OUTCOME[outcome] || OUTCOME.pending; return `<span class="pill ${o.pill}">${H.esc(o.label)}</span>`; }
  function cssId(v) { return String(v).replace(/["\\]/g, '\\$&'); }

  // ── view ────────────────────────────────────────────────────────────────────
  function viewVaSearches(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head">
        <div><h2>VA Searches</h2>
          <p>Queue contacts, record the numbers found, and work the log. Everything is scoped by the toggle - companies, people, or both.</p></div>
        <div class="segmented" id="vaEntity" role="group" aria-label="Contact type">
          <button type="button" data-e="all" aria-pressed="true">All</button>
          <button type="button" data-e="company" aria-pressed="false">Companies</button>
          <button type="button" data-e="person" aria-pressed="false">People</button>
        </div>
      </div>

      <div class="grid-4" id="vaStats"></div>
      <div class="notice notice-info" id="vaSecondary"></div>

      <div class="grid-2">
        <div class="card card-pad">
          <div class="card-head"><h3>Add a sheet to search</h3></div>
          <p class="muted" style="font-size:12px;margin:2px 0 12px">One contact per line: <code>name</code> or <code>name, number-on-record</code>. Or upload a CSV. These land as <strong>pending</strong> to be worked.</p>
          <div class="field-grid">
            <div class="field"><label for="vaAddSheet">Sheet name <span class="req">*</span></label>
              <input id="vaAddSheet" type="text" autocomplete="off" placeholder="e.g. Aug batch 3"></div>
            <div class="field"><label for="vaAddType">Contact type</label>
              <select id="vaAddType"><option value="company">Company</option><option value="person">Natural person</option></select></div>
          </div>
          <div class="field wide"><label for="vaAddRows">Contacts</label>
            <textarea id="vaAddRows" placeholder="Acme Holdings, 021 555 0100&#10;Blue Sky Trading&#10;..."></textarea></div>
          <div class="field wide"><label for="vaAddCsv" class="hint">...or upload a CSV</label>
            <input id="vaAddCsv" type="file" accept=".csv,text/csv"></div>
          <button type="button" class="btn btn-primary" id="vaAddBtn">Add to search list</button>
        </div>

        <div class="card card-pad">
          <div class="card-head"><h3>Import results</h3></div>
          <p class="muted" style="font-size:12px;margin:2px 0 12px">Paste completed lookups: <code>name, number-found</code> (blank number = not found). Matched to pending contacts; the outcome is worked out for you.</p>
          <div class="field-grid">
            <div class="field"><label for="vaImpSheet">Limit to sheet</label>
              <select id="vaImpSheet"><option value="all">Any sheet</option></select></div>
            <div class="field"><label for="vaImpType">Contact type</label>
              <select id="vaImpType"><option value="company">Company</option><option value="person">Natural person</option></select></div>
          </div>
          <div class="field wide"><label for="vaImpRows">Results</label>
            <textarea id="vaImpRows" placeholder="Acme Holdings, 021 555 0199&#10;Blue Sky Trading,&#10;..."></textarea></div>
          <div class="field wide"><label for="vaImpCsv" class="hint">...or upload a CSV</label>
            <input id="vaImpCsv" type="file" accept=".csv,text/csv"></div>
          <button type="button" class="btn btn-primary" id="vaImpBtn">Import results</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head" style="padding:16px 18px 0">
          <h3>Raw log</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="vaExport">Export CSV</button>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding:12px 18px">
          <select id="vaLogSheet" aria-label="Filter by sheet"><option value="all">All sheets</option></select>
          <select id="vaLogOutcome" aria-label="Filter by outcome">
            <option value="all">All outcomes</option><option value="pending">Pending</option>
            <option value="not_found">Not found</option><option value="found_unchanged">Found · same</option>
            <option value="found_changed">Found · changed</option>
          </select>
          <input id="vaLogQ" type="search" placeholder="Search name..." autocomplete="off" style="flex:1;min-width:160px">
        </div>
        <div class="tbl-wrap"><table class="tbl" id="vaLogTbl"></table></div>
        <div class="log-foot" id="vaLogFoot"></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    wire(wrap);
    load(wrap);
  }

  async function load(wrap) {
    await Promise.all([refreshSheetSelects(wrap), refreshStats(wrap), fetchFirstPage(wrap)]);
  }

  async function refreshStats(wrap) {
    const host = H.$('#vaStats', wrap), sec = H.$('#vaSecondary', wrap);
    host.innerHTML = `<div class="card stat"><div class="skeleton"></div></div>`.repeat(4);
    let c;
    try { c = await VA.counts(filter.entity); }
    catch (err) {
      const hint = /relation|does not exist|schema cache/i.test(err.message)
        ? ' Apply supabase/migrations/0001_va_search_records.sql.' : '';
      host.innerHTML = `<div class="card card-pad" style="grid-column:1/-1"><div class="state"><div class="state-title">Could not load stats</div><div>${H.esc(err.message)}${H.esc(hint)}</div></div></div>`;
      sec.textContent = ''; return;
    }
    const stat = (label, n, cls) => `<div class="card stat${cls ? ' ' + cls : ''}"><div class="stat-label">${label}</div><div class="stat-value">${fmt(n)}</div></div>`;
    host.innerHTML = stat('Searched', c.searched) + stat('Not found', c.not_found, c.not_found ? 'is-error' : '')
      + stat('Found · same', c.found_unchanged) + stat('Found · changed', c.found_changed);
    sec.innerHTML = `<strong>${fmt(c.total)}</strong> contacts total &middot; <strong>${fmt(c.pending)}</strong> still pending &middot; <strong>${Math.round((c.successRate || 0) * 100)}%</strong> hit rate on searched`;
  }

  async function fetchFirstPage(wrap) {
    logOffset = 0;
    const tbl = H.$('#vaLogTbl', wrap);
    tbl.innerHTML = `<tbody><tr><td><div class="skeleton"></div></td></tr></tbody>`;
    try {
      const { rows, total } = await VA.fetchLogPage(filter, 0, PAGE);
      logRows = rows; logTotal = total;
    } catch (err) {
      tbl.innerHTML = `<tbody><tr><td><div class="state"><div class="state-title">Could not load the log</div><div>${H.esc(err.message)}</div></div></td></tr></tbody>`;
      H.$('#vaLogFoot', wrap).innerHTML = ''; return;
    }
    renderLog(wrap);
  }

  async function loadMore(wrap) {
    logOffset += PAGE;
    const btn = H.$('#vaLoadMore', wrap); if (btn) { btn.classList.add('loading'); btn.disabled = true; }
    try {
      const { rows, total } = await VA.fetchLogPage(filter, logOffset, PAGE);
      logRows = logRows.concat(rows); logTotal = total;
    } catch (err) { H.toast('Could not load more', err.message, 'err'); }
    renderLog(wrap);
  }

  function renderLog(wrap) {
    const head = `<thead><tr>
      <th>Name</th><th>ID number</th><th>Type</th><th>Area</th><th>Sheet</th><th>On record</th><th>Found</th>
      <th>Outcome</th><th>By</th><th class="actions"></th></tr></thead>`;
    const foot = H.$('#vaLogFoot', wrap);
    if (!logRows.length) {
      H.$('#vaLogTbl', wrap).innerHTML = head + `<tbody><tr><td colspan="10"><div class="state"><div class="state-title">Nothing here</div><div>No contacts match these filters.</div></div></td></tr></tbody>`;
      foot.innerHTML = ''; return;
    }
    const body = logRows.map((r) => `<tr data-id="${H.esc(r.id)}">
      <td class="who">${H.esc(r.name || '')}</td>
      <td class="muted">${H.esc(r.id_number || '')}</td>
      <td>${H.esc(ENTITY[r.entity_type] || r.entity_type || '')}</td>
      <td class="muted">${H.esc(r.suburb || r.division || '')}</td>
      <td>${H.esc(r.sheet || '')}</td>
      <td class="muted">${H.esc(r.existing_number || '')}</td>
      <td>${H.esc(r.found_number || '')}</td>
      <td>${pill(r.outcome)}</td>
      <td class="muted">${H.esc(r.searched_by || '')}</td>
      <td class="actions"><button type="button" class="btn btn-ghost btn-sm" data-edit="${H.esc(r.id)}">Update</button></td>
    </tr>`).join('');
    H.$('#vaLogTbl', wrap).innerHTML = head + `<tbody>${body}</tbody>`;
    H.$('#vaLogTbl', wrap).querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditor(wrap, b.dataset.edit)));
    const more = logRows.length < logTotal;
    foot.innerHTML = `<span class="log-count">Showing ${fmt(logRows.length)} of ${fmt(logTotal)}</span>`
      + (more ? `<button type="button" class="btn btn-ghost btn-sm" id="vaLoadMore">Load ${Math.min(PAGE, logTotal - logRows.length)} more</button>` : '');
    if (more) H.$('#vaLoadMore', wrap).addEventListener('click', () => loadMore(wrap));
  }

  function openEditor(wrap, id) {
    const rec = logRows.find((r) => String(r.id) === String(id));
    const tr = H.$(`tr[data-id="${cssId(id)}"]`, wrap);
    if (!rec || !tr) return;
    const opts = Object.keys(OUTCOME).map((k) => `<option value="${k}"${k === rec.outcome ? ' selected' : ''}>${H.esc(OUTCOME[k].label)}</option>`).join('');
    tr.innerHTML = `<td class="who">${H.esc(rec.name || '')}</td>
      <td colspan="8"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input class="ed-found" type="text" placeholder="Number found" value="${H.esc(rec.found_number || '')}" style="min-width:150px">
        <select class="ed-outcome">${opts}</select>
        <input class="ed-notes" type="text" placeholder="Notes (optional)" value="${H.esc(rec.notes || '')}" style="flex:1;min-width:140px">
      </div></td>
      <td class="actions" style="white-space:nowrap">
        <button type="button" class="btn btn-primary btn-sm ed-save">Save</button>
        <button type="button" class="btn btn-ghost btn-sm ed-cancel">Cancel</button></td>`;
    const found = H.$('.ed-found', tr), outSel = H.$('.ed-outcome', tr);
    found.addEventListener('input', () => { outSel.value = deriveOutcome(rec.existing_number, found.value, false); });
    H.$('.ed-cancel', tr).addEventListener('click', () => renderLog(wrap));
    H.$('.ed-save', tr).addEventListener('click', async () => {
      const patch = {
        found_number: found.value.trim() || null, outcome: outSel.value,
        notes: H.$('.ed-notes', tr).value.trim() || null, searched_by: who(), searched_at: new Date().toISOString(),
      };
      const btn = H.$('.ed-save', tr); btn.classList.add('loading'); btn.disabled = true;
      try {
        await VA.updateRow(rec.id, patch);
        Object.assign(rec, patch);
        H.toast('Saved', `${rec.name} marked ${OUTCOME[patch.outcome].label}.`, 'ok');
        renderLog(wrap); refreshStats(wrap);
      } catch (err) { btn.classList.remove('loading'); btn.disabled = false; H.toast('Could not save', err.message, 'err'); }
    });
  }

  // ── actions ──────────────────────────────────────────────────────────────────
  async function addSheet(wrap) {
    const sheet = H.$('#vaAddSheet', wrap).value.trim();
    const type = H.$('#vaAddType', wrap).value;
    if (!sheet) { H.toast('Sheet name needed', 'Name the batch so you can filter by it later.', 'err'); return; }
    const parsed = parseLines(H.$('#vaAddRows', wrap).value);
    if (!parsed.length) { H.toast('No contacts', 'Paste at least one contact (or upload a CSV).', 'err'); return; }
    const rows = parsed.map((p) => ({ entity_type: type, name: p.name, sheet, existing_number: p.num || null, outcome: 'pending', created_by: who() }));
    const btn = H.$('#vaAddBtn', wrap); btn.classList.add('loading'); btn.disabled = true;
    try {
      await VA.insertRows(rows);
      H.toast('Sheet added', `${fmt(rows.length)} ${ENTITY[type].toLowerCase()} contact(s) queued on "${sheet}".`, 'ok');
      H.$('#vaAddSheet', wrap).value = ''; H.$('#vaAddRows', wrap).value = ''; H.$('#vaAddCsv', wrap).value = '';
      await load(wrap);
    } catch (err) { H.toast('Could not add sheet', err.message, 'err'); }
    finally { btn.classList.remove('loading'); btn.disabled = false; }
  }

  async function importResults(wrap) {
    const type = H.$('#vaImpType', wrap).value;
    const onlySheet = H.$('#vaImpSheet', wrap).value;
    const parsed = parseLines(H.$('#vaImpRows', wrap).value);
    if (!parsed.length) { H.toast('No results', 'Paste at least one "name, number" line.', 'err'); return; }
    const btn = H.$('#vaImpBtn', wrap); btn.classList.add('loading'); btn.disabled = true;
    try {
      // Fetch candidate rows for exactly the pasted names in one query, then match
      // locally (case-insensitive, prefer a still-pending row).
      const names = [...new Set(parsed.map((p) => p.name))];
      const cands = await VA.candidatesByNames(names, type, onlySheet);
      const byName = new Map();
      cands.forEach((r) => {
        const k = String(r.name || '').toLowerCase().trim(), cur = byName.get(k);
        if (!cur || (cur.outcome !== 'pending' && r.outcome === 'pending')) byName.set(k, r);
      });
      const stamp = new Date().toISOString(), byWho = who();
      let done = 0, failed = 0, unmatched = 0;
      for (const p of parsed) {
        const rec = byName.get(p.name.toLowerCase().trim());
        if (!rec) { unmatched++; continue; }
        try {
          await VA.updateRow(rec.id, { found_number: p.num.trim() || null, outcome: deriveOutcome(rec.existing_number, p.num, false), searched_by: byWho, searched_at: stamp });
          done++;
        } catch (_) { failed++; }
      }
      if (!done && !failed) { H.toast('No matches', `None of the ${parsed.length} line(s) matched a ${ENTITY[type].toLowerCase()} contact.`, 'err'); return; }
      const bits = [`${done} updated`]; if (unmatched) bits.push(`${unmatched} unmatched`); if (failed) bits.push(`${failed} failed`);
      H.toast(failed ? 'Imported with errors' : 'Results imported', bits.join(' · '), failed ? 'err' : 'ok');
      H.$('#vaImpRows', wrap).value = ''; H.$('#vaImpCsv', wrap).value = '';
      await Promise.all([refreshStats(wrap), fetchFirstPage(wrap)]);
    } catch (err) { H.toast('Import failed', err.message, 'err'); }
    finally { btn.classList.remove('loading'); btn.disabled = false; }
  }

  async function refreshSheetSelects(wrap) {
    let sheets = [];
    try { sheets = await VA.distinctSheets(); } catch (_) { sheets = []; }
    const opts = (extraAll) => `<option value="all">${extraAll}</option>` + sheets.map((s) => `<option value="${H.esc(s)}">${H.esc(s)}</option>`).join('');
    const log = H.$('#vaLogSheet', wrap); log.innerHTML = opts('All sheets'); log.value = filter.sheet;
    H.$('#vaImpSheet', wrap).innerHTML = opts('Any sheet');
  }

  function readCsvInto(fileInput, textarea) {
    const f = fileInput.files && fileInput.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { textarea.value = String(reader.result || '').trim(); };
    reader.readAsText(f);
  }

  async function exportCsv(wrap) {
    const btn = H.$('#vaExport', wrap); btn.classList.add('loading'); btn.disabled = true;
    try {
      const rows = await VA.fetchAllMatching(filter);
      const head = ['name', 'id_number', 'type', 'division', 'suburb', 'address', 'lead_status', 'sheet', 'on_record', 'found', 'outcome', 'searched_by', 'searched_at'];
      const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const lines = [head.join(',')].concat(rows.map((r) => [
        r.name, r.id_number, ENTITY[r.entity_type] || r.entity_type, r.division, r.suburb, r.address, r.lead_status,
        r.sheet, r.existing_number, r.found_number, OUTCOME[r.outcome] ? OUTCOME[r.outcome].label : r.outcome, r.searched_by, r.searched_at,
      ].map(q).join(',')));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `va-searches-${filter.entity}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      H.toast('Exported', `${fmt(rows.length)} row(s) downloaded.`, 'ok');
    } catch (err) { H.toast('Export failed', err.message, 'err'); }
    finally { btn.classList.remove('loading'); btn.disabled = false; }
  }

  function wire(wrap) {
    H.$('#vaEntity', wrap).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-e]'); if (!b) return;
      filter.entity = b.dataset.e;
      H.$('#vaEntity', wrap).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      refreshStats(wrap); fetchFirstPage(wrap);
    });
    H.$('#vaLogSheet', wrap).addEventListener('change', (e) => { filter.sheet = e.target.value; fetchFirstPage(wrap); });
    H.$('#vaLogOutcome', wrap).addEventListener('change', (e) => { filter.outcome = e.target.value; fetchFirstPage(wrap); });
    H.$('#vaLogQ', wrap).addEventListener('input', (e) => {
      filter.q = e.target.value.trim();
      clearTimeout(searchTimer); searchTimer = setTimeout(() => fetchFirstPage(wrap), 300);
    });
    H.$('#vaExport', wrap).addEventListener('click', () => exportCsv(wrap));
    H.$('#vaAddCsv', wrap).addEventListener('change', (e) => readCsvInto(e.target, H.$('#vaAddRows', wrap)));
    H.$('#vaImpCsv', wrap).addEventListener('change', (e) => readCsvInto(e.target, H.$('#vaImpRows', wrap)));
    H.$('#vaAddBtn', wrap).addEventListener('click', () => addSheet(wrap));
    H.$('#vaImpBtn', wrap).addEventListener('click', () => importResults(wrap));
  }

  H.viewVaSearches = viewVaSearches;
})();
