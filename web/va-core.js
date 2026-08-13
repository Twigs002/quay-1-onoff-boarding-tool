/* VA Searches - shared data core (window.VA).
 *
 * One place for the constants + all Supabase access, used by both the dashboard
 * (app.vadashboard.js) and the working log (app.vasearches.js). Built for scale:
 * headline numbers come from COUNT queries and the log is server-paginated, so the
 * browser never pulls the whole 36k+ table just to show a screen.
 *
 * All access is the RLS-gated `va_search_records` via the shared auth.js client.
 */
(() => {
  'use strict';
  const TABLE = 'va_search_records';
  const STATS_VIEW = 'va_search_stats';   // optional aggregate view (migration 0003)

  const OUTCOME = {
    pending:         { label: 'Pending',         short: 'Pending',   pill: 'pill-skipped', tone: 'pending' },
    not_found:       { label: 'Not found',       short: 'Not found', pill: 'pill-error',   tone: 'bad' },
    found_unchanged: { label: 'Found · same',    short: 'Same',      pill: 'pill-running', tone: 'good' },
    found_changed:   { label: 'Found · changed', short: 'Changed',   pill: 'pill-done',    tone: 'good' },
  };
  const ENTITY = { company: 'Company', person: 'Natural person' };

  const sb = () => (window.AUTH && window.AUTH.getClient && window.AUTH.getClient());
  const digits = (s) => String(s == null ? '' : s).replace(/\D+/g, '');

  // (had, found) -> bucket. `notFound` forces not_found.
  function deriveOutcome(existing, found, notFound) {
    if (notFound || !digits(found)) return 'not_found';
    if (digits(found) === digits(existing)) return 'found_unchanged';
    return 'found_changed';
  }

  function applyFilters(q, f) {
    if (f.entity && f.entity !== 'all') q = q.eq('entity_type', f.entity);
    if (f.sheet && f.sheet !== 'all') q = q.eq('sheet', f.sheet);
    if (f.outcome && f.outcome !== 'all') q = q.eq('outcome', f.outcome);
    if (f.q) q = q.ilike('name', `%${f.q}%`);
    return q;
  }

  // Five parallel HEAD counts (no rows) for one entity scope. Fast at any size.
  async function counts(entity) {
    const client = sb();
    if (!client) throw new Error('Supabase client unavailable - reload the page.');
    const mk = (outcome) => {
      let q = client.from(TABLE).select('*', { count: 'exact', head: true });
      if (entity && entity !== 'all') q = q.eq('entity_type', entity);
      if (outcome) q = q.eq('outcome', outcome);
      return q;
    };
    const [t, p, nf, fu, fc] = await Promise.all([
      mk(), mk('pending'), mk('not_found'), mk('found_unchanged'), mk('found_changed'),
    ]);
    const anyErr = [t, p, nf, fu, fc].find((r) => r.error);
    if (anyErr) throw new Error(anyErr.error.message || 'Count failed.');
    const c = {
      total: t.count || 0, pending: p.count || 0, not_found: nf.count || 0,
      found_unchanged: fu.count || 0, found_changed: fc.count || 0,
    };
    c.searched = c.not_found + c.found_unchanged + c.found_changed;
    c.successful = c.found_unchanged + c.found_changed;
    c.unsuccessful = c.not_found;
    c.successRate = c.searched ? c.successful / c.searched : 0;
    c.progress = c.total ? c.searched / c.total : 0;
    return c;
  }

  // Per-sheet aggregation via the optional stats view. Returns null if the view is
  // absent (migration 0003 not applied) so callers can hide that panel gracefully.
  async function perSheet(entity) {
    const client = sb();
    let q = client.from(STATS_VIEW).select('*');
    if (entity && entity !== 'all') q = q.eq('entity_type', entity);
    const { data, error } = await q;
    if (error) return null;
    const m = new Map();
    (data || []).forEach((r) => {
      const s = m.get(r.sheet) || { sheet: r.sheet, total: 0, pending: 0, not_found: 0, found_unchanged: 0, found_changed: 0 };
      s[r.outcome] = (s[r.outcome] || 0) + r.n; s.total += r.n; m.set(r.sheet, s);
    });
    return [...m.values()].map((s) => {
      s.searched = s.not_found + s.found_unchanged + s.found_changed;
      s.successful = s.found_unchanged + s.found_changed;
      s.successRate = s.searched ? s.successful / s.searched : 0;
      return s;
    }).sort((a, b) => b.total - a.total);
  }

  // Distinct sheet names: exact via the view, else a sampled fallback.
  async function distinctSheets() {
    const client = sb();
    const v = await client.from(STATS_VIEW).select('sheet');
    if (!v.error && v.data) return [...new Set(v.data.map((r) => r.sheet).filter(Boolean))].sort();
    const s = await client.from(TABLE).select('sheet').limit(1000);
    return s.data ? [...new Set(s.data.map((r) => r.sheet).filter(Boolean))].sort() : [];
  }

  // One page of the log for the given filters, plus the exact total match count.
  async function fetchLogPage(f, offset, limit) {
    let q = sb().from(TABLE).select('*', { count: 'exact' });
    q = applyFilters(q, f);
    q = q.order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + limit - 1);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { rows: data || [], total: count || 0 };
  }

  // All rows matching the filters, paged 1000 at a time (for CSV export). Capped so
  // an accidental "export everything" on 36k+ can't run away unbounded.
  async function fetchAllMatching(f, cap = 100000) {
    const PAGE = 1000; let from = 0, all = [];
    for (;;) {
      let q = sb().from(TABLE).select('*');
      q = applyFilters(q, f);
      q = q.order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(from, from + PAGE - 1);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      all = all.concat(data || []);
      if (!data || data.length < PAGE || all.length >= cap) break;
      from += PAGE;
    }
    return all;
  }

  // Fetch candidate rows for a set of names (bulk import matching). Matching is
  // EXACT on name (`.in` is case/space-sensitive) - fine for results pasted back
  // from the same source sheet. Names are chunked so a big paste never overflows
  // the request URL.
  async function candidatesByNames(names, entity, sheet) {
    const CHUNK = 150, out = [];
    for (let i = 0; i < names.length; i += CHUNK) {
      let q = sb().from(TABLE).select('*').in('name', names.slice(i, i + CHUNK)).eq('entity_type', entity);
      if (sheet && sheet !== 'all') q = q.eq('sheet', sheet);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      out.push(...(data || []));
    }
    return out;
  }

  async function insertRows(rows) {
    const { error } = await sb().from(TABLE).insert(rows);
    if (error) throw new Error(error.message);
  }
  async function updateRow(id, patch) {
    const { error } = await sb().from(TABLE).update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  }
  async function deleteRow(id) {
    const { error } = await sb().from(TABLE).delete().eq('id', id);
    if (error) throw new Error(error.message);
  }
  // Count rows on a sheet (scoped by entity) - shown in the delete confirmation.
  async function countSheet(sheet, entity) {
    let q = sb().from(TABLE).select('*', { count: 'exact', head: true }).eq('sheet', sheet);
    if (entity && entity !== 'all') q = q.eq('entity_type', entity);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count || 0;
  }
  // Delete every row on a sheet (scoped by entity when set). Returns rows deleted.
  async function deleteSheet(sheet, entity) {
    let q = sb().from(TABLE).delete({ count: 'exact' }).eq('sheet', sheet);
    if (entity && entity !== 'all') q = q.eq('entity_type', entity);
    const { error, count } = await q;
    if (error) throw new Error(error.message);
    return count || 0;
  }

  window.VA = {
    TABLE, OUTCOME, ENTITY, sb, digits, deriveOutcome,
    counts, perSheet, distinctSheets, fetchLogPage, fetchAllMatching,
    candidatesByNames, insertRows, updateRow, deleteRow, countSheet, deleteSheet,
  };
})();
