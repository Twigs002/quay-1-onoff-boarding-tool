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
 * `onboarding` pipeline carries docs_ready / approved / cma_entitled / cma_requested,
 * plus per-document decline state (declined / declined_at / declines). Declines are
 * per-FICA-document with a separate "contract incorrect" flag, sent via decline_fica.
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) throw new Error('app.admincheck.js loaded before app.js (window.HUB missing)');
  const { $, esc, el, api, toast, KINDS } = H;

  const DRIVE_FOLDER = (id) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

  // The three FICA documents an admin can decline, plus the contract as a separate
  // control. Keys match the decline_fica payload; labels are the human names shown
  // in the panel, in validation errors, and in the declined-state summary line.
  const FICA_DOCS = [
    { key: 'id', label: 'ID document' },
    { key: 'poa', label: 'Proof of address' },
    { key: 'bank', label: 'Bank confirmation' },
  ];
  const DECLINE_LABELS = { id: 'ID document', poa: 'Proof of address', bank: 'Bank confirmation', contract: 'Contract' };

  // Persist the selected entity across Refresh + re-renders. Default: Quay 1.
  let selectedEntity = 'quay1';
  // The full loaded queue (all entities). Toggling filters this without a refetch.
  let allItems = [];

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
        <div class="ac-ent-toggle" id="acEntToggle">
          <button type="button" class="btn btn-sm" data-ent="quay1">Quay 1 Admin Checks</button>
          <button type="button" class="btn btn-sm" data-ent="aqua">Aqua Admin Checks</button>
        </div>
        <div class="toolbar">
          <div class="muted" id="acMeta">Loading...</div>
          <div class="toolbar-right"><button type="button" class="btn btn-ghost btn-sm" id="acRefresh">Refresh</button></div>
        </div>
        <div id="acBody"></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    if (!canCheck) {
      $('#acMeta', wrap).textContent = '';
      $('#acBody', wrap).innerHTML = '';
      $('#acEntToggle', wrap).style.display = 'none';
      return;
    }
    $('#acEntToggle', wrap).querySelectorAll('[data-ent]').forEach((b) => {
      b.addEventListener('click', () => {
        if (selectedEntity === b.dataset.ent) return;
        selectedEntity = b.dataset.ent;
        applyFilter(wrap);          // re-render from already-loaded items, no refetch
      });
    });
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
      // Awaiting acceptance = documents all in, not yet approved. The snapshot
      // carries every entity; we keep them all and filter client-side on toggle.
      allItems = ((r && r.onboarding) || []).filter((o) => o.docs_ready && !o.approved);
      applyFilter(wrap);
    } catch (err) {
      meta.textContent = '';
      body.innerHTML = `<div class="state"><div class="state-title">Could not load the queue</div><div>${esc(err.message)}</div></div>`;
    }
  }

  // Filter the loaded queue to the selected entity and render. Keeps the toggle
  // buttons + meta count in sync. No refetch - drives entirely off allItems.
  function applyFilter(wrap) {
    $('#acEntToggle', wrap).querySelectorAll('[data-ent]').forEach((b) => {
      const on = b.dataset.ent === selectedEntity;
      b.classList.toggle('btn-primary', on);
      b.classList.toggle('btn-ghost', !on);
    });
    const items = allItems.filter((o) => String(o.entity || '').toLowerCase() === selectedEntity);
    renderAdminCheck(wrap, items);
  }

  function renderAdminCheck(wrap, items) {
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
      const statusPill = o.declined
        ? '<span class="pill s-declined">Declined - awaiting re-submission</span>'
        : '<span class="pill s-ready">Ready to accept</span>';
      const declinedLine = o.declined ? declinedDetail(o.declines) : '';
      return `<div class="ac-item" data-item="${esc(o.folderId)}">
        <div class="pipe-row">
        <div class="pipe-main">
          <div class="pipe-name">${esc(o.name || '(no name)')} ${entTag}</div>
          <div class="pipe-team muted">${esc(o.team || '')}</div>
          ${docs}
          <div class="ac-links"><a href="${DRIVE_FOLDER(o.folderId)}" target="_blank" rel="noopener">Review documents in Drive</a></div>
          ${declinedLine}
          ${cmaNote}
        </div>
        <div class="pipe-side">
          ${statusPill}
          <div class="pipe-actions">
            <button type="button" class="btn btn-primary btn-sm" data-accept="${esc(o.folderId)}" data-name="${esc(o.name || '')}" data-cma="${o.cma_entitled && !o.cma_requested ? '1' : ''}">Accept &amp; set up</button>
            <button type="button" class="btn btn-ghost btn-sm btn-danger" data-decline="${esc(o.folderId)}" data-name="${esc(o.name || '')}">Decline</button>
          </div>
        </div>
        </div>
      </div>`;
    }).join('');
    body.innerHTML = `<div class="pipe-list">${cards}</div>`;
    body.querySelectorAll('[data-accept]').forEach((b) => {
      b.addEventListener('click', () => acceptOne(wrap, b));
    });
    body.querySelectorAll('[data-decline]').forEach((b) => {
      b.addEventListener('click', () => openDecline(wrap, b.closest('.ac-item'), b.dataset.decline, b.dataset.name));
    });
  }

  // Full declined detail shown inline on the row: for each declined document (and the contract) its
  // reason and who declined it, and when - so a later question about a candidate is answered on the
  // screen in front of the admin, without opening anything else (SPEC section 3).
  function declinedDetail(declines) {
    if (!declines) return '';
    const rows = [];
    const dd = declines.docs || {};
    FICA_DOCS.forEach((d) => { if (dd[d.key]) rows.push(declinedRow(DECLINE_LABELS[d.key], dd[d.key])); });
    if (dd.general) rows.push(declinedRow('FICA documents', dd.general));
    if (declines.contract_incorrect) rows.push(declinedRow(DECLINE_LABELS.contract, declines.contract_incorrect));
    if (!rows.length) return '';
    return `<div class="ac-declined"><div class="ac-declined-title">What was declined</div>${rows.join('')}</div>`;
  }

  // One declined item: the document/contract name, the reason recorded, and who declined it and when.
  function declinedRow(label, info) {
    info = info || {};
    const meta = [];
    if (info.by) meta.push(`by ${esc(info.by)}`);
    if (info.at) meta.push(`on ${esc(fmtWhen(info.at))}`);
    const metaLine = meta.length ? `<div class="ac-dl-meta muted">Declined ${meta.join(' ')}</div>` : '';
    return `<div class="ac-dl"><div class="ac-dl-doc">${esc(label)}</div><div class="ac-dl-reason">${esc(info.reason || '')}</div>${metaLine}</div>`;
  }

  // Render an ISO timestamp as a short, readable local date and time; fall back to the raw string.
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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

  // One inline control (checkbox + hidden reason textarea) for a document/contract.
  function declineControl(key, label, placeholder) {
    return `<div class="ac-dc">
      <label class="check"><input type="checkbox" data-tick="${key}"><span class="ck-label">${esc(label)}</span></label>
      <div class="field" data-reason="${key}" hidden>
        <label>Reason <span class="req">*</span></label>
        <textarea rows="2" placeholder="${esc(placeholder)}"></textarea>
      </div>
    </div>`;
  }

  // Open (or toggle shut) the per-document decline panel below a row.
  function openDecline(wrap, itemEl, folderId, name) {
    if (!itemEl) return;
    const existing = itemEl.querySelector('.ac-decline');
    if (existing) { existing.remove(); return; }   // clicking Decline again closes it
    const panel = el(`<div class="ac-decline card card-pad">
      <div class="muted ac-decline-head">Decline ${esc(name || 'this starter')}'s submission. Tick each item that is wrong and give its reason. They are asked to re-submit only what you decline.</div>
      ${FICA_DOCS.map((d) => declineControl(d.key, d.label, `Why is the ${d.label.toLowerCase()} being declined?`)).join('')}
      ${declineControl('contract', 'Contract incorrect', 'Explain what is wrong with the signed contract, e.g. because X, Y and Z.')}
      <div class="field-err" data-decline-err></div>
      <div class="pipe-actions">
        <button type="button" class="btn btn-primary btn-sm" data-decline-send>Send decline</button>
        <button type="button" class="btn btn-ghost btn-sm" data-decline-cancel>Cancel</button>
      </div>
    </div>`);
    panel.querySelectorAll('[data-tick]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const field = panel.querySelector(`[data-reason="${cb.getAttribute('data-tick')}"]`);
        if (!field) return;
        field.hidden = !cb.checked;
        if (cb.checked) { const t = field.querySelector('textarea'); if (t) t.focus(); }
      });
    });
    panel.querySelector('[data-decline-cancel]').addEventListener('click', () => panel.remove());
    panel.querySelector('[data-decline-send]').addEventListener('click', () => submitDecline(wrap, panel, folderId, name));
    itemEl.appendChild(panel);
  }

  async function submitDecline(wrap, panel, folderId, name) {
    const errBox = panel.querySelector('[data-decline-err]');
    const ticked = [];
    const missing = [];
    const declines = {};
    let contractReason = '';
    ['id', 'poa', 'bank', 'contract'].forEach((key) => {
      const cb = panel.querySelector(`[data-tick="${key}"]`);
      if (!cb || !cb.checked) return;
      ticked.push(key);
      const field = panel.querySelector(`[data-reason="${key}"]`);
      const reason = ((field && field.querySelector('textarea').value) || '').trim();
      if (!reason) { missing.push(DECLINE_LABELS[key]); return; }
      if (key === 'contract') contractReason = reason;
      else declines[key] = reason;
    });
    if (!ticked.length) {
      errBox.textContent = 'Tick at least one document or the contract to decline.';
      toast('Nothing to decline', 'Tick at least one document or the contract, then add a reason.', 'err');
      return;
    }
    if (missing.length) {
      errBox.textContent = `Add a reason for: ${missing.join(', ')}.`;
      toast('Reason needed', `Add a reason for: ${missing.join(', ')}.`, 'err');
      return;
    }
    errBox.textContent = '';
    const payload = { folderId, declines, contract_incorrect: contractReason };
    const sendBtn = panel.querySelector('[data-decline-send]');
    const cancelBtn = panel.querySelector('[data-decline-cancel]');
    sendBtn.classList.add('loading'); sendBtn.disabled = true; cancelBtn.disabled = true;
    panel.querySelectorAll('input, textarea').forEach((f) => { f.disabled = true; });
    try {
      const r = await api(KINDS.declineFica || 'decline_fica', payload);
      toast('Declined', (r && r.message) ? r.message : `${name || 'The starter'} was notified to re-submit the declined items.`, 'ok');
      H.setStatusCache([]);           // force the Progress report to refetch next open
      loadAdminCheck(wrap, true);     // reload the queue with fresh decline state
    } catch (err) {
      toast('Could not decline', err.message, 'err');
      sendBtn.classList.remove('loading'); sendBtn.disabled = false; cancelBtn.disabled = false;
      panel.querySelectorAll('input, textarea').forEach((f) => { f.disabled = false; });
    }
  }

  H.viewAdminCheck = viewAdminCheck;
})();
