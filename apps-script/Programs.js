/**
 * Programs.js - the Programs page data (who on a team holds CMA + PropData accounts).
 *
 * Owner: backend. Assembles a senior-broker -> team tree from the shared divisions directory
 * (CFG.DIVISIONS_URL) joined, by email, to two PRIVATE roster tabs on the tracker: "CMA Accounts"
 * and "PropData Accounts" (refreshed by pasting the periodic exports; never in the public repo).
 *
 * Matching:
 *   - Email is dot-insensitive in the local part (Google Workspace treats a.b@ == ab@), so
 *     divisions' "liam.stewart@" matches PropData's "liamstewart@". See _normEmail_.
 *   - Agents also get a full-name fallback when the email misses. Numbered specialist profiles
 *     have no personal name (the name field is the slot label) so they match on email only.
 *
 * Role scope:
 *   - super || admin        -> every team, every section.
 *   - a broker on team(s)    -> those team(s) in full, whether they are the senior (the team's
 *                               FIRST-listed broker) OR any listed member. A broker who works
 *                               across several teams (e.g. a second-slot area lead) sees every
 *                               team they appear on, not only the ones they are the senior of.
 *   - any other active staff -> a single "Your account" row (their own CMA/PropData status only).
 *
 * Public surface:
 *   programsData_(ctx)        - { scope:'all'|'senior'|'self', sections:[...], generated } | throws.
 *   ensureAccountsTabs_(ss)   - create the two roster tabs (header row written only when empty).
 */

var CMA_HEADERS = ['First', 'Last', 'Email'];
var PROPDATA_HEADERS = ['First Name', 'Last Name', 'Email', 'Active'];

// The assembled tree is identical for every caller (role scoping happens per-request, AFTER this),
// so it is safe to memoise across requests. The expensive part - one divisions HTTP fetch plus two
// tracker-tab reads plus the tree build - is what made the authed 'programs' read hang; caching it
// makes repeat loads return with zero I/O. Short TTL bounds staleness after an admin pastes a fresh
// roster export. Fully fail-safe: any cache error just falls through to a rebuild.
var PROGRAMS_CACHE_KEY = 'programs_tree_v1';
var PROGRAMS_CACHE_TTL = 120; // seconds

/** Assemble the Programs tree, scoped to the caller's role. Requires an authed ctx. */
function programsData_(ctx) {
  if (!ctx || !ctx.role) throw new Error('unauthorized');
  var full = _programsFull_();
  var isAdmin = !!(ctx.role.is_super || ctx.role.is_admin);
  var stamp = nowIso_();

  if (isAdmin) return { scope: 'all', sections: full, generated: stamp };

  var me = _normEmail_(ctx.email);

  // Every team the caller belongs to - as the senior (the team's RAW first-listed broker slot,
  // computed in _programsTree_) OR as any listed member. This lets a broker who works across
  // several teams (a second-slot area lead like Schaughn) see ALL of those teams in full, not
  // only the ones they are the senior of. Matching is dot-insensitive on email (_normEmail_);
  // the per-person SENIOR star still marks each team's actual first-listed broker. Fails closed:
  // no email match on a team -> that team is not included.
  var mine = [];
  full.forEach(function (s) {
    var teams = (s.teams || []).filter(function (t) {
      if (!me) return false;
      if (t.seniorEmail && t.seniorEmail === me) return true;
      return (t.people || []).some(function (p) { return _normEmail_(p.email) === me; });
    });
    if (teams.length) mine.push({ name: s.name, teams: teams });
  });
  if (mine.length) return { scope: 'senior', sections: mine, generated: stamp };

  // Plain broker / other staff: only their own row.
  var self = null;
  full.forEach(function (s) {
    (s.teams || []).forEach(function (t) {
      (t.people || []).forEach(function (p) {
        if (!self && me && _normEmail_(p.email) === me) self = p;
      });
    });
  });
  var sections = self ? [{ name: 'Your account', teams: [{ name: '', senior: '', people: [self] }] }] : [];
  return { scope: 'self', sections: sections, generated: stamp };
}

/** The full (unscoped) sections tree, memoised in the script cache for PROGRAMS_CACHE_TTL seconds.
 *  Cache hits skip ALL I/O (no HTTP fetch, no sheet open/read). Any CacheService failure or an
 *  over-limit payload is swallowed and we simply rebuild - the cache is an optimisation, never a
 *  dependency. Returns the same shape _programsTree_ produces: [{ name, teams:[...] }]. */
function _programsFull_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (cache) {
    try {
      var hit = cache.get(PROGRAMS_CACHE_KEY);
      if (hit) return JSON.parse(hit);
    } catch (e) { /* fall through to rebuild */ }
  }
  var full = _programsBuild_();
  if (cache) {
    try { cache.put(PROGRAMS_CACHE_KEY, JSON.stringify(full), PROGRAMS_CACHE_TTL); } catch (e) { /* payload too big / cache down - skip */ }
  }
  return full;
}

/** Build the full tree from source: one divisions fetch + both roster tabs read through a SINGLE
 *  opened Spreadsheet (openById is slow, so we do it once and share it across both tab reads rather
 *  than paying it per tab). Never throws - a failed open yields empty rosters (accounts show "none"). */
function _programsBuild_() {
  var div = _programsDivisions_();
  var ss = null;
  try { ss = sheet_(); } catch (e) { logAudit_('programs_sheet_open_failed', { error: String(e) }); }
  var cma = _cmaSet_(ss);
  var pd = _propdataMaps_(ss);
  var tree = _programsTree_(div, cma, pd);
  _programsMergeOnboarding_(tree, cma, pd);   // add newly-onboarded members onto their team
  return tree;
}

// ---------------------------------------------------------------- tree build

/** Build sections -> teams -> people[{name,email,senior,cma,pd}] from divisions + rosters.
 *  Each team carries seniorEmail = the RAW first-listed broker slot's email (the authority for
 *  senior-scope; '' when slot 0 has no email, so scope fails closed). A person is flagged senior
 *  iff their email matches seniorEmail. */
function _programsTree_(div, cma, pd) {
  var out = [];
  ((div && div.sections) || []).forEach(function (sec) {
    var teams = [];
    (sec.teams || []).forEach(function (t) {
      var brokers = t.brokers || [];
      var seniorEmail = _normEmail_((brokers[0] && brokers[0].email) || '');
      var seniorName = (brokers[0] && brokers[0].name) || '';
      var people = [];
      brokers.forEach(function (b) {
        if (!b || !b.name) return;
        var e = _normEmail_(b.email);
        people.push({
          name: b.name, email: b.email || '', senior: !!e && e === seniorEmail,
          cma: !!e && !!cma[e], pd: _pdLookup_(pd, e),
        });
      });
      if (people.length) teams.push({ name: t.name, seniorEmail: seniorEmail, senior: seniorName, people: people });
    });
    if (teams.length) out.push({ name: sec.name, teams: teams });
  });
  return out;
}

/** PropData record for a person, matched by dot-insensitive email ONLY. A full-name fallback was
 *  removed: two different people sharing a name would be mis-attributed each other's account. When
 *  an email genuinely differs across systems the row fails closed (shows "none") rather than lying. */
function _pdLookup_(pd, normEmail) {
  return (normEmail && pd.byEmail[normEmail]) || null;
}

// ---------------------------------------------------------------- onboarding merge (new starters)

var PROGRAMS_NEW_SECTION = 'New starters (not yet in the directory)';

/** Loose team key: lowercase, alphanumerics only (for a tolerant second-pass team-name match). */
function _looseTeam_(t) { return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/** Locate a team in the assembled Programs tree by name, case/space-insensitively. Exact normalised
 *  pass first (via _normTeam_), then a loose pass (alphanumerics only). Returns
 *  { sectionIndex, teamIndex, section, team } or null. */
function findTeamInTree_(tree, teamName) {
  var want = _normTeam_(teamName);
  if (!want) return null;
  var wantLoose = _looseTeam_(teamName);
  var loose = null;
  for (var si = 0; si < (tree || []).length; si++) {
    var teams = tree[si].teams || [];
    for (var ti = 0; ti < teams.length; ti++) {
      var n = teams[ti].name;
      if (_normTeam_(n) === want) return { sectionIndex: si, teamIndex: ti, section: tree[si], team: teams[ti] };
      if (!loose && _looseTeam_(n) === wantLoose) loose = { sectionIndex: si, teamIndex: ti, section: tree[si], team: teams[ti] };
    }
  }
  return loose;
}

/** Return the tree team named `teamName`, or synthesise it under a trailing "New starters" section so
 *  a brand-new / not-yet-in-directory team still shows the member. A matched EXISTING team is returned
 *  untouched (its seniorEmail preserved). A synthetic team's seniorEmail is the member's own
 *  senior_email (normalised) if present, else '' so senior-scope fails closed. Mutates `tree`. */
function ensureTeamForOnboard_(tree, teamName, seniorEmail) {
  var found = findTeamInTree_(tree, teamName);
  if (found) return { section: found.section, team: found.team };
  var sec = null;
  for (var i = 0; i < tree.length; i++) { if (tree[i].name === PROGRAMS_NEW_SECTION) { sec = tree[i]; break; } }
  if (!sec) { sec = { name: PROGRAMS_NEW_SECTION, teams: [] }; tree.push(sec); }
  var name = String(teamName || '').trim() || 'Unassigned';
  var norm = _normTeam_(name);
  var team = null;
  for (var j = 0; j < sec.teams.length; j++) { if (_normTeam_(sec.teams[j].name) === norm) { team = sec.teams[j]; break; } }
  if (!team) { team = { name: name, seniorEmail: _normEmail_(seniorEmail), senior: '', people: [] }; sec.teams.push(team); }
  return { section: sec, team: team };
}

/** Merge newly-onboarded members (Onboarding tab) into the Programs tree, in place, so a new hire
 *  shows under their team immediately - before divisions.json is regenerated. Placed on their team
 *  (existing, or a synthesised "New starters" one). NEVER the senior: seniorEmail/senior star are left
 *  untouched, so senior-scope still resolves to the real first-listed broker AND the hire still sees
 *  their own team via the membership path in programsData_ (they match people[].email). CMA/PropData
 *  flags use the SAME email join as divisions people. Deduped by normalised email (name fallback when
 *  the email is blank). Marked isNew for the "NEW" pill. Never throws - a bad row is skipped. */
function _programsMergeOnboarding_(tree, cma, pd) {
  var rows;
  try { rows = listOnboarding_(); } catch (e) { logAudit_('programs_onboarding_read_failed', { error: String(e) }); return; }
  rows.forEach(function (o) {
    if (!o || !o.name || !o.team) return;             // need a name + a team to place them
    if (/declined/i.test(o.status || '')) return;     // dropped/rejected candidates are not on a roster
    var found;
    try { found = ensureTeamForOnboard_(tree, o.team, o.senior_email); } catch (e) { found = null; }
    if (!found || !found.team) return;
    var people = found.team.people || (found.team.people = []);
    var ne = _normEmail_(o.email);
    var nm = String(o.name).trim().toLowerCase();
    var dup = people.some(function (p) {
      if (ne) return _normEmail_(p.email) === ne;                       // primary: dot-insensitive email
      return nm && String(p.name || '').trim().toLowerCase() === nm;    // fallback when no email
    });
    if (dup) return;
    people.push({
      name: o.name, email: o.email || '', senior: false, isNew: true,
      cma: !!ne && !!cma[ne], pd: _pdLookup_(pd, ne),
    });
  });
}

// ---------------------------------------------------------------- roster readers

/** CMA holders as a set-like object keyed by normalised email. Reads the "Email" column by header
 *  so a stray address in another column (e.g. an "added by") is NOT counted as a holder. Falls back
 *  to scanning every @-bearing cell only when the tab has no Email header (a headerless paste). */
function _cmaSet_(ss) {
  var set = {};
  var rows = _tabRows_(CFG.TAB.CMA_ACCOUNTS, ss);
  if (!rows.length) return set;
  var head = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var ei = head.indexOf('email');
  if (ei >= 0) {
    for (var r = 1; r < rows.length; r++) { var e = _normEmail_(rows[r][ei]); if (e) set[e] = true; }
  } else {
    logAudit_('programs_cma_no_email_header', { head: head });
    rows.forEach(function (row) {
      row.forEach(function (cell) {
        var v = String(cell == null ? '' : cell);
        if (v.indexOf('@') >= 0) { var e = _normEmail_(v); if (e) set[e] = true; }
      });
    });
  }
  return set;
}

/** Active flag from a roster cell - tolerant of "Yes"/"No" strings, booleans, checkboxes, "1". */
function _isActive_(v) {
  if (v === true) return true;
  if (v === false) return false;
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === 'y' || s === 'active' || s === '1';
}

/** PropData rosters keyed by normalised email: { byEmail: {email:{type,number,active}} }. Reads by
 *  header name so the raw agents export (with all its stat columns) pastes in as-is. A "Quay 1
 *  Property Specialist" First Name marks a numbered specialist profile (number = Last Name). Logs
 *  and returns empty (fail loud, not silent) if no Email header is found on a populated tab. */
function _propdataMaps_(ss) {
  var rows = _tabRows_(CFG.TAB.PROPDATA_ACCOUNTS, ss);
  var maps = { byEmail: {} };
  if (!rows.length) return maps;
  var head = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var ci = {
    first: head.indexOf('first name'), last: head.indexOf('last name'),
    email: head.indexOf('email'), active: head.indexOf('active'),
  };
  if (ci.email < 0) { logAudit_('programs_propdata_no_email_header', { head: head }); return maps; }
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    var email = _normEmail_(row[ci.email]);
    if (!email) continue;
    var first = ci.first >= 0 ? String(row[ci.first] || '') : '';
    var last = ci.last >= 0 ? String(row[ci.last] || '') : '';
    var active = ci.active >= 0 ? _isActive_(row[ci.active]) : true;
    var isSpec = /specialist/i.test(first);
    var rec = isSpec
      ? { type: 'specialist', number: String(last).trim(), active: active }
      : { type: 'agent', number: '', active: active };
    // Prefer an active profile if the same email appears twice.
    if (!maps.byEmail[email] || (active && !maps.byEmail[email].active)) maps.byEmail[email] = rec;
  }
  return maps;
}

/** All rows of a tracker tab as a 2D array; [] when the tab is absent/empty. Never throws.
 *  Pass a pre-opened Spreadsheet (`ss`) to avoid a fresh SpreadsheetApp.openById per tab -
 *  programsData_ reads two tabs and would otherwise pay the (slow) open twice. */
function _tabRows_(tabName, ss) {
  try {
    var book = ss || sheet_();
    var sh = book.getSheetByName(tabName);
    if (!sh || sh.getLastRow() < 1) return [];
    return sh.getDataRange().getValues();
  } catch (err) {
    logAudit_('programs_tab_read_failed', { tab: tabName, error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------- divisions + helpers

/** The divisions directory (CFG.DIVISIONS_URL). {sections:[]} on any failure (never throws). */
function _programsDivisions_() {
  try {
    var res = UrlFetchApp.fetch(CFG.DIVISIONS_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { logAudit_('programs_divisions_failed', { code: res.getResponseCode() }); return { sections: [] }; }
    return safeJsonParse_(res.getContentText(), { sections: [] }) || { sections: [] };
  } catch (err) {
    logAudit_('programs_divisions_failed', { error: String(err) });
    return { sections: [] };
  }
}

/** Dot-insensitive, lower-cased email (Google Workspace ignores dots in the local part). '' if invalid. */
function _normEmail_(e) {
  var s = String(e == null ? '' : e).trim().toLowerCase();
  var at = s.indexOf('@');
  if (at <= 0) return '';
  return s.slice(0, at).replace(/\./g, '') + s.slice(at);
}

/** Ensure the two roster tabs EXIST, writing the header row only when a tab is brand-new/empty.
 *  It deliberately does NOT rewrite headers on a populated tab (that would mislabel a raw-export
 *  paste whose columns sit in a different order); the readers instead locate columns by header
 *  name and log if the Email header is missing. Idempotent. */
function ensureAccountsTabs_(ss) {
  _ensureHeaderTab_(ss, CFG.TAB.CMA_ACCOUNTS, CMA_HEADERS);
  _ensureHeaderTab_(ss, CFG.TAB.PROPDATA_ACCOUNTS, PROPDATA_HEADERS);
}

function _ensureHeaderTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
