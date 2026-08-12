/* Quay 1 Boarding Tool - VA Searches tab.
 *
 * A skip-tracing tracker for the VA team: contacts (companies OR natural persons)
 * arrive in "sheets" (submitted batches) and a VA looks up a phone number for each.
 * This tab shows the four headline counts the user asked for, a raw log of every
 * contact, a form to submit a new sheet to search, and a bulk "import results" paste.
 *
 * Backend is a single RLS-gated Supabase table `va_search_records`, read/written
 * DIRECTLY from the browser via the shared auth.js client (no Apps Script kind).
 * See supabase/migrations/0001_va_search_records.sql. Registered as VIEWS.vasearches
 * in app.js (rendered via window.HUB.viewVaSearches) and gated to super/admin.
 *
 * Outcome model (single source of truth, deriveOutcome below):
 *   no number found            -> 'not_found'        ("number we cannot find")
 *   found number == existing   -> 'found_unchanged'  ("can find but haven't changed")
 *   found number != existing   -> 'found_changed'    ("can find and have changed")
 *   not yet worked             -> 'pending'          (NOT counted as searched)
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) return;

  const TABLE = 'va_search_records';

  // Outcome vocabulary: label + pill class (reusing the existing pill palette).
  const OUTCOME = {
    pending:         { label: 'Pending',         pill: 'pill-skipped' },
    not_found:       { label: 'Not found',       pill: 'pill-error' },
    found_unchanged: { label: 'Found · same',    pill: 'pill-running' },
    found_changed:   { label: 'Found · changed', pill: 'pill-done' },
  };
  const ENTITY = { company: 'Company', person: 'Natural person' };

  // ── module state ────────────────────────────────────────────────────────────
  let records = [];                 // every row visible to this user (RLS-scoped)
  const filter = { entity: 'all', sheet: 'all', outcome: 'all', q: '' };

  const sb = () => (window.AUTH && window.AUTH.getClient && window.AUTH.getClient());
  const digits = (s) => String(s == null ? '' : s).replace(/\D+/g, '');
  const who = () => { const u = H.getUser && H.getUser(); return (u && (u.name || u.username)) || 'staff'; };

  // The one rule that maps a (had, found) pair to a bucket. `notFound` forces it.
  function deriveOutcome(existing, found, notFound) {
    if (notFound || !digits(found)) return 'not_found';
    if (digits(found) === digits(existing)) return 'found_unchanged';
    return 'found_changed';
  }

  // Split a pasted/CSV block into [{name, num}] - one contact per line, comma or
  // tab separated, first field the name, second (optional) the number. A leading
  // header line like "name,number" is skipped. Blank lines are ignored.
  function parseLines(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const parts = line.split(/[\t,;]/).map((p) => p.trim());
      const name = parts[0] || '';
      if (i === 0 && /^(name|company|contact)$/i.test(name) && !digits(parts[1] || '')) return;
      if (!name) return;
      out.push({ name, num: parts[1] || '' });
    });
    return out;
  }

  // ── data ────────────────────────────────────────────────────────────────────
  // Page through the table 1000 at a time (Supabase's per-request ceiling) so a
  // large backlog still loads fully rather than being silently truncated at 1000.
  async function loadAll() {
    const client = sb();
    if (!client) throw new Error('Supabase client unavailable - reload the page.');
    const PAGE = 1000;
    let from = 0, all = [];
    for (;;) {
      // Order by created_at with `id` as a unique tiebreaker: a whole bulk sheet
      // insert shares one created_at (the transaction's now()), so without the
      // tiebreaker OFFSET paging could skip/duplicate rows straddling a page
      // boundary - and the headline counts are derived from this load.
      const { data, error } = await client.from(TABLE)
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message || 'Load failed.');
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    records = all;
    return all;
  }

  // ── view ────────────────────────────────────────────────────────────────────
  function viewVaSearches(root) {
    const wrap = H.el(`<div class="stack">
      <div class="section-head">
        <div>
          <h2>VA Searches</h2>
          <p>Contact skip-tracing for the VA team. Submit a sheet of contacts, record the numbers found, and watch the tallies. Companies and natural persons are tracked side by side - use the toggle to scope everything below.</p>
        </div>
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
          <p class="muted" style="font-size:12px;margin:2px 0 12px">One contact per line: <code>name</code> or <code>name, number-on-record</code>. These land as <strong>pending</strong> for the VAs to work.</p>
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
            <option value="all">All outcomes</option>
            <option value="pending">Pending</option>
            <option value="not_found">Not found</option>
            <option value="found_unchanged">Found · same</option>
            <option value="found_changed">Found · changed</option>
          </select>
          <input id="vaLogQ" type="search" placeholder="Search name..." autocomplete="off" style="flex:1;min-width:160px">
        </div>
        <div class="tbl-wrap"><table class="tbl" id="vaLogTbl"></table></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    wire(wrap);
    load(wrap);
  }

  async function load(wrap) {
    const tbl = H.$('#vaLogTbl', wrap);
    tbl.innerHTML = `<tbody><tr><td><div class="skeleton"></div></td></tr></tbody>`;
    try {
      await loadAll();
    } catch (err) {
      const hint = /relation|does not exist|schema cache/i.test(err.message)
        ? ' The va_search_records table may not exist yet - apply supabase/migrations/0001_va_search_records.sql.'
        : '';
      tbl.innerHTML = `<tbody><tr><td><div class="state"><div class="state-title">Could not load VA searches</div><div>${H.esc(err.message)}${H.esc(hint)}</div></div></td></tr></tbody>`;
      H.$('#vaStats', wrap).innerHTML = '';
      H.$('#vaSecondary', wrap).textContent = '';
      return;
    }
    refreshSheetSelects(wrap);
    render(wrap);
  }

  // ── render ──────────────────────────────────────────────────────────────────
  function scoped() {
    return filter.entity === 'all' ? records : records.filter((r) => r.entity_type === filter.entity);
  }

  function render(wrap) {
    renderStats(wrap);
    renderLog(wrap);
  }

  function renderStats(wrap) {
    const rows = scoped();
    const c = { pending: 0, not_found: 0, found_unchanged: 0, found_changed: 0 };
    rows.forEach((r) => { c[r.outcome] = (c[r.outcome] || 0) + 1; });
    const searched = c.not_found + c.found_unchanged + c.found_changed;
    const stat = (label, n, accent) =>
      `<div class="card stat${accent && n ? ' is-error' : ''}"><div class="stat-label">${H.esc(label)}</div><div class="stat-value">${n}</div></div>`;
    H.$('#vaStats', wrap).innerHTML =
      stat('Contacts searched', searched) +
      stat('Number not found', c.not_found, true) +
      stat('Found · unchanged', c.found_unchanged) +
      stat('Found · changed', c.found_changed);
    H.$('#vaSecondary', wrap).innerHTML =
      `<strong>${rows.length}</strong> contacts total &middot; <strong>${c.pending}</strong> still pending (not yet searched)`;
  }

  function pill(outcome) {
    const o = OUTCOME[outcome] || OUTCOME.pending;
    return `<span class="pill ${o.pill}">${H.esc(o.label)}</span>`;
  }

  function visibleLog() {
    return scoped().filter((r) => {
      if (filter.sheet !== 'all' && (r.sheet || '') !== filter.sheet) return false;
      if (filter.outcome !== 'all' && r.outcome !== filter.outcome) return false;
      if (filter.q && !String(r.name || '').toLowerCase().includes(filter.q)) return false;
      return true;
    });
  }

  function renderLog(wrap) {
    const rows = visibleLog();
    const head = `<thead><tr>
      <th>Name</th><th>ID number</th><th>Type</th><th>Area</th><th>Sheet</th><th>On record</th><th>Found</th>
      <th>Outcome</th><th>By</th><th class="actions"></th></tr></thead>`;
    if (!rows.length) {
      H.$('#vaLogTbl', wrap).innerHTML = head +
        `<tbody><tr><td colspan="10"><div class="state"><div class="state-title">Nothing here yet</div><div>Add a sheet above to start tracking searches.</div></div></td></tr></tbody>`;
      return;
    }
    const body = rows.map((r) => `<tr data-id="${H.esc(r.id)}">
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
    const tbl = H.$('#vaLogTbl', wrap);
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
    tbl.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => openEditor(wrap, b.dataset.edit)));
  }

  // Inline per-row editor: swap the row for an editable one (outcome + found number
  // + notes). Saving derives nothing - the operator's explicit outcome choice wins.
  function openEditor(wrap, id) {
    const rec = records.find((r) => String(r.id) === String(id));
    const tr = H.$(`tr[data-id="${cssId(id)}"]`, wrap);
    if (!rec || !tr) return;
    const opts = Object.keys(OUTCOME).map((k) =>
      `<option value="${k}"${k === rec.outcome ? ' selected' : ''}>${H.esc(OUTCOME[k].label)}</option>`).join('');
    tr.innerHTML = `<td class="who">${H.esc(rec.name || '')}</td>
      <td colspan="8">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input class="ed-found" type="text" placeholder="Number found" value="${H.esc(rec.found_number || '')}" style="min-width:150px">
          <select class="ed-outcome">${opts}</select>
          <input class="ed-notes" type="text" placeholder="Notes (optional)" value="${H.esc(rec.notes || '')}" style="flex:1;min-width:140px">
        </div>
      </td>
      <td class="actions" style="white-space:nowrap">
        <button type="button" class="btn btn-primary btn-sm ed-save">Save</button>
        <button type="button" class="btn btn-ghost btn-sm ed-cancel">Cancel</button>
      </td>`;
    const found = H.$('.ed-found', tr), outSel = H.$('.ed-outcome', tr);
    // Typing a number nudges the outcome to the derived value, but the operator can
    // still override it by picking from the select afterwards.
    found.addEventListener('input', () => { outSel.value = deriveOutcome(rec.existing_number, found.value, false); });
    H.$('.ed-cancel', tr).addEventListener('click', () => renderLog(wrap));
    H.$('.ed-save', tr).addEventListener('click', async () => {
      const patch = {
        found_number: found.value.trim() || null,
        outcome: outSel.value,
        notes: H.$('.ed-notes', tr).value.trim() || null,
        searched_by: who(),
        searched_at: new Date().toISOString(),
      };
      const btn = H.$('.ed-save', tr); btn.classList.add('loading'); btn.disabled = true;
      try {
        const { error } = await sb().from(TABLE).update(patch).eq('id', rec.id);
        if (error) throw new Error(error.message);
        Object.assign(rec, patch);
        H.toast('Saved', `${rec.name} marked ${OUTCOME[patch.outcome].label}.`, 'ok');
        render(wrap);
      } catch (err) {
        btn.classList.remove('loading'); btn.disabled = false;
        H.toast('Could not save', err.message, 'err');
      }
    });
  }
  // Escape a value for use inside a CSS attribute selector (ids are uuids, but be safe).
  function cssId(v) { return String(v).replace(/["\\]/g, '\\$&'); }

  // ── actions: add a sheet ─────────────────────────────────────────────────────
  async function addSheet(wrap) {
    const sheet = H.$('#vaAddSheet', wrap).value.trim();
    const type = H.$('#vaAddType', wrap).value;
    const text = H.$('#vaAddRows', wrap).value;
    if (!sheet) { H.toast('Sheet name needed', 'Give the batch a name so you can filter by it later.', 'err'); return; }
    const parsed = parseLines(text);
    if (!parsed.length) { H.toast('No contacts', 'Paste at least one contact (or upload a CSV).', 'err'); return; }
    const rows = parsed.map((p) => ({
      entity_type: type, name: p.name, sheet, existing_number: p.num || null,
      outcome: 'pending', created_by: who(),
    }));
    const btn = H.$('#vaAddBtn', wrap); btn.classList.add('loading'); btn.disabled = true;
    try {
      const { error } = await sb().from(TABLE).insert(rows);
      if (error) throw new Error(error.message);
      H.toast('Sheet added', `${rows.length} ${ENTITY[type].toLowerCase()} contact(s) queued on "${sheet}".`, 'ok');
      H.$('#vaAddRows', wrap).value = ''; H.$('#vaAddCsv', wrap).value = '';
      await load(wrap);
    } catch (err) {
      H.toast('Could not add sheet', err.message, 'err');
    } finally { btn.classList.remove('loading'); btn.disabled = false; }
  }

  // ── actions: import results ──────────────────────────────────────────────────
  async function importResults(wrap) {
    const type = H.$('#vaImpType', wrap).value;
    const onlySheet = H.$('#vaImpSheet', wrap).value;
    const parsed = parseLines(H.$('#vaImpRows', wrap).value);
    if (!parsed.length) { H.toast('No results', 'Paste at least one "name, number" line.', 'err'); return; }

    // Match each pasted result to a record: same type, (optionally) same sheet,
    // name case-insensitive. Prefer a still-pending match so re-imports don't
    // overwrite already-recorded rows. Unmatched lines are reported, not created.
    // Limitation: matching is by name, so two distinct contacts sharing a name in
    // the same scope collapse to one match (pending preferred). Rare for skip-tracing
    // batches; use per-row editing for those. Tighten with an explicit key later.
    const pool = records.filter((r) => r.entity_type === type && (onlySheet === 'all' || (r.sheet || '') === onlySheet));
    const byName = new Map();
    pool.forEach((r) => {
      const k = String(r.name || '').toLowerCase().trim();
      const cur = byName.get(k);
      if (!cur || (cur.outcome !== 'pending' && r.outcome === 'pending')) byName.set(k, r);
    });

    const updates = []; let unmatched = 0;
    parsed.forEach((p) => {
      const rec = byName.get(p.name.toLowerCase().trim());
      if (!rec) { unmatched++; return; }
      updates.push({ rec, found: p.num, outcome: deriveOutcome(rec.existing_number, p.num, false) });
    });
    if (!updates.length) { H.toast('No matches', `None of the ${parsed.length} line(s) matched a ${ENTITY[type].toLowerCase()} contact${onlySheet === 'all' ? '' : ' on "' + onlySheet + '"'}.`, 'err'); return; }

    const stamp = new Date().toISOString(), byWho = who();
    const btn = H.$('#vaImpBtn', wrap); btn.classList.add('loading'); btn.disabled = true;
    let done = 0, failed = 0;
    for (const u of updates) {
      const patch = { found_number: u.found.trim() || null, outcome: u.outcome, searched_by: byWho, searched_at: stamp };
      try {
        const { error } = await sb().from(TABLE).update(patch).eq('id', u.rec.id);
        if (error) throw new Error(error.message);
        Object.assign(u.rec, patch); done++;
      } catch (_) { failed++; }
    }
    btn.classList.remove('loading'); btn.disabled = false;
    H.$('#vaImpRows', wrap).value = ''; H.$('#vaImpCsv', wrap).value = '';
    const bits = [`${done} updated`];
    if (unmatched) bits.push(`${unmatched} unmatched`);
    if (failed) bits.push(`${failed} failed`);
    H.toast(failed ? 'Imported with errors' : 'Results imported', bits.join(' · '), failed ? 'err' : 'ok');
    render(wrap);
  }

  // ── wiring ──────────────────────────────────────────────────────────────────
  function refreshSheetSelects(wrap) {
    const sheets = Array.from(new Set(records.map((r) => r.sheet).filter(Boolean))).sort();
    const opts = (extraAll) => `<option value="all">${extraAll}</option>` +
      sheets.map((s) => `<option value="${H.esc(s)}">${H.esc(s)}</option>`).join('');
    const log = H.$('#vaLogSheet', wrap); log.innerHTML = opts('All sheets'); log.value = filter.sheet;
    H.$('#vaImpSheet', wrap).innerHTML = opts('Any sheet');
  }

  function readCsvInto(fileInput, textarea) {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { textarea.value = String(reader.result || '').trim(); };
    reader.readAsText(f);
  }

  function exportCsv() {
    const rows = visibleLog();
    const head = ['name', 'id_number', 'type', 'division', 'suburb', 'address', 'lead_status',
      'sheet', 'on_record', 'found', 'outcome', 'searched_by', 'searched_at'];
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.join(',')].concat(rows.map((r) => [
      r.name, r.id_number, ENTITY[r.entity_type] || r.entity_type, r.division, r.suburb,
      r.address, r.lead_status, r.sheet, r.existing_number,
      r.found_number, OUTCOME[r.outcome] ? OUTCOME[r.outcome].label : r.outcome,
      r.searched_by, r.searched_at,
    ].map(esc).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `va-searches-${filter.entity}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function wire(wrap) {
    // Entity segmented control - scopes the whole tab.
    H.$('#vaEntity', wrap).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-e]'); if (!b) return;
      filter.entity = b.dataset.e;
      H.$('#vaEntity', wrap).querySelectorAll('button').forEach((x) =>
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      render(wrap);
    });
    // Log filters.
    H.$('#vaLogSheet', wrap).addEventListener('change', (e) => { filter.sheet = e.target.value; renderLog(wrap); });
    H.$('#vaLogOutcome', wrap).addEventListener('change', (e) => { filter.outcome = e.target.value; renderLog(wrap); });
    H.$('#vaLogQ', wrap).addEventListener('input', (e) => { filter.q = e.target.value.toLowerCase().trim(); renderLog(wrap); });
    H.$('#vaExport', wrap).addEventListener('click', exportCsv);
    // CSV uploads populate the matching textarea (parsed on submit).
    H.$('#vaAddCsv', wrap).addEventListener('change', (e) => readCsvInto(e.target, H.$('#vaAddRows', wrap)));
    H.$('#vaImpCsv', wrap).addEventListener('change', (e) => readCsvInto(e.target, H.$('#vaImpRows', wrap)));
    // Actions.
    H.$('#vaAddBtn', wrap).addEventListener('click', () => addSheet(wrap));
    H.$('#vaImpBtn', wrap).addEventListener('click', () => importResults(wrap));
  }

  H.viewVaSearches = viewVaSearches;
})();
