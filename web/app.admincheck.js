/* Quay 1 Boarding Tool - Admin Check view (split out of app.js to keep that file
 * under the 500-line cap). Reaches app.js's shared helpers + state via window.HUB.
 *
 * Super/admin only. This is the single approval gate: it lists new starters whose
 * signed contract + all FICA documents are in and who are awaiting an admin's
 * acceptance. Accepting a candidate (kind:'approve') is the ONLY thing that
 * releases account setup - and, for a CMA-entitled starter, it also auto-sends a
 * (paid) CMA approval-request email to the CMA approvers (Sheldon + Marthinus),
 * once, on the backend (_maybeRequestCma_). The Progress report is view-only.
 *
 * Data comes from kind:'status' (the same snapshot the Progress report uses); the
 * `onboarding` pipeline carries docs_ready / approved / cma_entitled / cma_requested.
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) throw new Error('app.admincheck.js loaded before app.js (window.HUB missing)');
  const { $, esc, el, api, toast, KINDS } = H;

  const DRIVE_FOLDER = (id) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

  // The most-recently rendered queue, so the Edit form can read a candidate's current values (which
  // ride along in item.edit for admins) and Cancel can restore the row without a re-fetch.
  let _acItems = [];

  function viewAdminCheck(root) {
    const user = H.getUser();
    const canCheck = user && (user.isAdmin || user.isSuper);
    const wrap = el(`<div class="stack">
      <div class="section-head">
        <h2>Admin Check</h2>
        <p>Review each new starter's signed contract and FICA documents, then accept them to set up their accounts. Accepting is the only thing that releases provisioning. If a starter is entitled to CMA, accepting also emails a CMA approval request (a paid seat) to Sheldon and Marthinus.</p>
      </div>
      <div class="card card-pad">
        ${canCheck ? '' : '<div class="notice warn">Only a super or admin can accept starters.</div>'}
        <div class="toolbar">
          <div class="muted" id="acMeta">Loading...</div>
          <div class="toolbar-right"><button type="button" class="btn btn-ghost btn-sm" id="acRefresh">Refresh</button></div>
        </div>
        <div id="acBody"></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    if (!canCheck) { $('#acMeta', wrap).textContent = ''; $('#acBody', wrap).innerHTML = ''; return; }
    $('#acRefresh', wrap).addEventListener('click', () => loadAdminCheck(wrap, true));
    loadAdminCheck(wrap, false);
  }

  async function loadAdminCheck(wrap, force) {
    const body = $('#acBody', wrap), meta = $('#acMeta', wrap);
    body.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    meta.textContent = 'Loading...';
    try {
      let r, lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { r = await api(KINDS.status, {}); lastErr = null; break; }
        catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 600)); }
      }
      if (lastErr) throw lastErr;
      // Awaiting acceptance = documents all in, not yet approved.
      const items = ((r && r.onboarding) || []).filter((o) => o.docs_ready && !o.approved);
      renderAdminCheck(wrap, items);
    } catch (err) {
      meta.textContent = '';
      body.innerHTML = `<div class="state"><div class="state-title">Could not load the queue</div><div>${esc(err.message)}</div></div>`;
    }
  }

  function renderAdminCheck(wrap, items) {
    _acItems = items;
    const body = $('#acBody', wrap), meta = $('#acMeta', wrap);
    meta.textContent = items.length ? `${items.length} awaiting acceptance` : '';
    if (!items.length) {
      body.innerHTML = `<div class="state"><div class="state-title">Nobody awaiting acceptance</div><div>New starters appear here once their signed contract and all FICA documents are in.</div></div>`;
      return;
    }
    const docPill = H.docPill;
    const cards = items.map((o) => {
      const entTag = H.entTag(o.entity);
      const docs = `<div class="docs">
        ${docPill(o.docs && o.docs.contract, 'Contract')}${docPill(o.docs && o.docs.id, 'ID')}
        ${docPill(o.docs && o.docs.poa, 'Address')}${docPill(o.docs && o.docs.bank, 'Bank')}</div>`;
      const cmaNote = o.cma_entitled
        ? (o.cma_requested
            ? '<div class="ac-cma muted">CMA request already sent to the approvers.</div>'
            : '<div class="ac-cma warn-text">Accepting emails a CMA approval request (paid seat) to Sheldon &amp; Marthinus.</div>')
        : '';
      return `<div class="pipe-row">
        <div class="pipe-main">
          <div class="pipe-name">${esc(o.name || '(no name)')} ${entTag}</div>
          <div class="pipe-team muted">${esc(o.team || '')}</div>
          ${docs}
          <div class="ac-links"><a href="${DRIVE_FOLDER(o.folderId)}" target="_blank" rel="noopener">Review documents in Drive</a></div>
          ${cmaNote}
        </div>
        <div class="pipe-side">
          <span class="pill s-ready">Ready to accept</span>
          <div class="pipe-actions">
            <button type="button" class="btn btn-primary btn-sm" data-accept="${esc(o.folderId)}" data-name="${esc(o.name || '')}" data-cma="${o.cma_entitled && !o.cma_requested ? '1' : ''}">Accept &amp; set up</button>
            <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(o.folderId)}">Edit</button>
            <button type="button" class="btn btn-ghost btn-sm btn-danger" data-decline="${esc(o.folderId)}" data-name="${esc(o.name || '')}">Decline</button>
          </div>
        </div>
      </div>`;
    }).join('');
    body.innerHTML = `<div class="pipe-list">${cards}</div>`;
    body.querySelectorAll('[data-accept]').forEach((b) => {
      b.addEventListener('click', () => acceptOne(wrap, b));
    });
    body.querySelectorAll('[data-decline]').forEach((b) => {
      b.addEventListener('click', () => declineOne(wrap, b));
    });
    body.querySelectorAll('[data-edit]').forEach((b) => {
      b.addEventListener('click', () => editOne(wrap, b));
    });
  }

  // One editable field. `value` is HTML-escaped for the attribute; `type` defaults to text.
  function editField(label, name, value, type) {
    return `<div class="field">
      <label for="ed_${name}">${esc(label)}</label>
      <input id="ed_${name}" data-field="${name}" type="${type || 'text'}" value="${esc(value == null ? '' : value)}" autocomplete="off" spellcheck="false">
    </div>`;
  }

  // Swap a candidate's row for an inline edit form pre-filled with their current details. Only a
  // whitelisted set of human-entered fields is editable; the backend re-validates each on save.
  function editOne(wrap, b) {
    const folderId = b.dataset.edit;
    const item = _acItems.find((x) => x.folderId === folderId);
    if (!item) return;
    const e = item.edit || {};
    const row = b.closest('.pipe-row');
    if (!row) return;
    const form = el(`<div class="pipe-row ac-edit">
      <div class="pipe-main">
        <div class="pipe-name">Edit ${esc(item.name || '(no name)')}</div>
        <div class="ac-edit-grid">
          ${editField('Name', 'name', e.name)}
          ${editField('ID / passport number', 'id_number', e.id_number)}
          ${editField('Email', 'email', e.email, 'email')}
          ${editField('Contact number', 'contact', e.contact, 'tel')}
          ${editField('Team', 'team', e.team)}
          ${editField('Senior broker', 'senior_name', e.senior_name)}
          ${editField('Senior broker email', 'senior_email', e.senior_email, 'email')}
        </div>
        <div class="ac-edit-actions">
          <button type="button" class="btn btn-primary btn-sm" data-save="1">Save changes</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cancel="1">Cancel</button>
        </div>
      </div>
    </div>`);
    row.replaceWith(form);
    $('[data-cancel]', form).addEventListener('click', () => renderAdminCheck(wrap, _acItems));
    $('[data-save]', form).addEventListener('click', () => saveEdit(wrap, form, item));
  }

  async function saveEdit(wrap, form, item) {
    const fields = {};
    form.querySelectorAll('[data-field]').forEach((inp) => { fields[inp.dataset.field] = inp.value; });
    const saveBtn = $('[data-save]', form);
    saveBtn.classList.add('loading'); saveBtn.disabled = true;
    try {
      const r = await api(KINDS.editOnboarding || 'edit_onboarding', { folderId: item.folderId, fields });
      toast('Saved', (r && r.message) ? r.message : 'Details updated.', 'ok');
      H.setStatusCache([]);          // the Progress report should refetch the corrected details
      loadAdminCheck(wrap, true);    // re-render the queue with the new values
    } catch (err) {
      toast('Could not save', err.message, 'err');
      saveBtn.classList.remove('loading'); saveBtn.disabled = false;
    }
  }

  async function acceptOne(wrap, b) {
    const name = b.dataset.name || 'this person';
    const cmaLine = b.dataset.cma
      ? ` A CMA approval request (a paid seat) will also be emailed to Sheldon and Marthinus.`
      : '';
    if (!confirm(`Accept ${name} and set up their accounts now? This creates their logins across all systems.${cmaLine}`)) return;
    b.classList.add('loading'); b.disabled = true;
    try {
      const r = await api(KINDS.approve, { folderId: b.dataset.accept });
      toast('Accepted', (r && r.message) ? r.message : `${name}'s accounts are being set up now.`, 'ok');
      H.setStatusCache([]);           // force the Progress report to refetch next open
      loadAdminCheck(wrap, true);     // drop the accepted person off this queue
    } catch (err) {
      toast('Could not accept', err.message, 'err');
      b.classList.remove('loading'); b.disabled = false;
    }
  }

  async function declineOne(wrap, b) {
    const name = b.dataset.name || 'this person';
    const reason = (prompt(`Decline ${name}'s FICA? Enter a short reason for the candidate (they will be asked to re-submit):`) || '').trim();
    if (!reason) return;
    b.classList.add('loading'); b.disabled = true;
    try {
      const r = await api(KINDS.declineFica || 'decline_fica', { folderId: b.dataset.decline, reason });
      toast('Declined', (r && r.message) ? r.message : `${name}'s FICA was declined and they have been notified.`, 'ok');
      H.setStatusCache([]);           // force the Progress report to refetch next open
      loadAdminCheck(wrap, true);     // drop the declined person off this queue
    } catch (err) {
      toast('Could not decline', err.message, 'err');
      b.classList.remove('loading'); b.disabled = false;
    }
  }

  H.viewAdminCheck = viewAdminCheck;
})();
