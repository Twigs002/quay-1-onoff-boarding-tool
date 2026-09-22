/* Quay 1 Boarding Tool - Candidate detail (click-through) view. Split out of app.js like the offboard
 * + admincheck modules; reaches app.js's shared helpers via window.HUB. Additive + self-contained so
 * the whole detail page can be removed later without touching the rest of the SPA.
 *
 * Opened from a Progress report row (HUB.openCandidateDetail); fetches candidate_detail and renders the
 * journey stepper + grouped detail cards using the tool's own components. Read-mostly: the Stage block
 * offers "Resend induction packet" and, for admins, "Change week" (both reuse the existing endpoints).
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) throw new Error('app.detail.js loaded before app.js (window.HUB missing)');
  const { esc, api, toast, KINDS } = H;
  const isAdmin = () => { const u = H.getUser && H.getUser(); return !!(u && (u.isAdmin || u.isSuper)); };

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Tolerant: format an ISO date, pass a human date ("16 September 2026") through unchanged, '' -> ''.
  function fmtDay(v) {
    const s = String(v == null ? '' : v).trim(); if (!s) return '';
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}` : s;
  }
  const row = (lbl, val) => `<div><p class="f-lbl">${esc(lbl)}</p><p class="f-val">${val ? esc(val) : '—'}</p></div>`;
  const docRow = (name, tag) => `<div class="docrow"><span class="name">${esc(name)}</span>${tag}</div>`;
  const yn = (on) => `<span class="doc ${on ? 'doc-on' : 'doc-off'}">${on ? 'Received' : 'Outstanding'}</span>`;
  // Provisioning status -> a doc chip.
  function acctTag(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'done') return `<span class="doc doc-on">Created</span>`;
    if (s === 'requested') return `<span class="doc doc-req">Requested</span>`;
    if (s === 'error') return `<span class="doc doc-off" style="color:var(--red)">Error</span>`;
    if (s === 'skipped' || s === 'not_required') return `<span class="doc doc-off">Not required</span>`;
    return `<span class="doc doc-off">${esc(status || 'Pending')}</span>`;
  }
  const SYS_LABEL = { google: 'Google Workspace', propdata: 'PropData', cma: 'CMA', dialfire: 'Dialfire', hubspot: 'HubSpot' };

  // The header status pill: declined -> amber; all done -> green; else the current step, in-progress.
  function headerPill(d) {
    if (d.declined_at) return `<span class="pill s-ready">Action needed</span>`;
    const current = (d.steps || []).find((s) => s.state === 'current');
    if (!current) return `<span class="pill s-done">Complete</span>`;
    return `<span class="pill s-inprogress">${esc(current.label)}</span>`;
  }

  function stepperHtml(steps) {
    const cells = (steps || []).map((s) => {
      const node = s.state === 'done' ? '✓' : String((steps.indexOf(s) + 1));
      return `<div class="step ${s.state}"><div class="line"></div>` +
        `<div class="node">${node}</div><div class="lbl">${esc(s.label)}</div>` +
        `<div class="date">${s.date ? esc(fmtDay(s.date)) : '—'}</div></div>`;
    }).join('');
    return `<div class="card steps"><div class="track">${cells}</div></div>`;
  }

  function detailHtml(d) {
    const p = d.personal || {}, o = d.onboarding || {}, f = d.fica || {}, ind = d.induction;
    const subBits = [d.started_at ? `Onboarding started ${fmtDay(d.started_at)}` : '', d.team ? `${d.team} team` : ''].filter(Boolean);

    const accounts = (d.accounts && d.accounts.length)
      ? d.accounts.map((a) => docRow(SYS_LABEL[String(a.system).toLowerCase()] || a.system, acctTag(a.status))).join('')
      : `<p class="f-val muted" style="font-weight:500">No accounts set up yet.</p>`;

    const inductionBlock = ind ? `
      <div class="block">
        <p class="fs-title">Induction</p>
        <div class="grid">
          ${row('Week', [fmtDay(ind.wed), fmtDay(ind.thu)].filter(Boolean).join(' & '))}
          ${row('Time', '09:00 – 12:00')}
          <div style="grid-column:1 / -1"><p class="f-lbl">Venue</p><p class="f-val">${esc(ind.venue || '')}</p></div>
          ${ind.holiday_flag ? `<div style="grid-column:1 / -1"><span class="doc doc-req">Heads-up: ${esc(ind.holiday_flag)}</span></div>` : ''}
        </div>
      </div>` : '';

    // Stage actions. Resend is available to any onboarder; Change week is admin-only (backend re-checks).
    const stageActions = ind ? (
      `<button type="button" class="btn btn-ghost btn-sm" data-cd-resend>Resend induction packet</button>` +
      (isAdmin() ? `<button type="button" class="btn btn-gold btn-sm" data-cd-changeweek>Change week</button>
        <span class="cd-week" hidden>
          <input type="date" class="week-input" data-cd-weekinput value="${esc(ind.wed || '')}" aria-label="New induction week">
          <button type="button" class="btn btn-primary btn-sm" data-cd-weeksave>Save</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cd-weekcancel>Cancel</button>
        </span>` : '')
    ) : '';

    const current = (d.steps || []).find((s) => s.state === 'current');
    return `
      <div class="card card-pad">
        <div class="chead"><div>
          <h2>${esc(d.name || '(no name)')} ${H.entTag(d.entity)} ${headerPill(d)}</h2>
          ${subBits.length ? `<p class="sub">${esc(subBits.join(' · '))}</p>` : ''}
        </div></div>
      </div>
      ${stepperHtml(d.steps)}
      <div class="card card-pad">
        <div class="block">
          <p class="fs-title">Personal details</p>
          <div class="grid">
            ${row('Phone', p.phone)}${row('Personal email', p.email)}
            ${row('ID number', p.id_masked ? p.id_masked + ' (on file)' : '')}${row('Quay 1 email', p.quay_email)}
          </div>
        </div>
        <div class="block">
          <p class="fs-title">Onboarding information</p>
          <div class="grid">
            ${row('Team', d.team)}${row('Senior broker', o.senior_name)}
            ${row('Requested by', o.requester_name)}${row('Designation', o.designation)}
          </div>
        </div>
        <div class="block">
          <p class="fs-title">FICA documents</p>
          ${docRow('Signed agreement', yn(f.contract))}${docRow('ID / passport (certified)', yn(f.id))}
          ${docRow('Proof of address', yn(f.poa))}${docRow('Bank confirmation', yn(f.bank))}
          ${docRow('NDA (internal)', yn(f.nda))}
        </div>
        ${inductionBlock}
        <div class="block">
          <p class="fs-title">Account setup</p>
          ${accounts}
        </div>
        <div class="block">
          <p class="fs-title">Communications sent</p>
          ${(d.comms && d.comms.length)
            ? d.comms.map((m) => `<div class="cd-comm"><span class="cd-comm-label">${esc(m.label || m.type || 'Message')}</span><span class="cd-comm-when muted">${m.at ? esc(fmtDay(m.at)) : ''}</span></div>`).join('')
            : `<p class="f-val muted" style="font-weight:500">No messages have been sent to this candidate yet.</p>`}
        </div>
        ${stageActions ? `<div class="block">
          <p class="fs-title">Stage</p>
          <div class="stage-now">${esc(current ? current.label : 'Complete')}</div>
          <div class="btns">${stageActions}</div>
        </div>` : ''}
      </div>`;
  }

  function wireDetail(host, d, onMutate) {
    const resend = host.querySelector('[data-cd-resend]');
    if (resend) resend.addEventListener('click', async () => {
      resend.classList.add('loading'); resend.disabled = true;
      try { await api(KINDS.resendPacket, { folderId: d.folderId }); toast('Induction packet resent', `Sent to ${esc(d.name || 'the candidate')}.`, 'ok'); }
      catch (err) { toast('Could not resend packet', err.message, 'err'); }
      resend.classList.remove('loading'); resend.disabled = false;
    });

    const changeBtn = host.querySelector('[data-cd-changeweek]');
    const editor = host.querySelector('.cd-week');
    if (changeBtn && editor) {
      changeBtn.addEventListener('click', () => { editor.hidden = !editor.hidden; if (!editor.hidden) { const i = editor.querySelector('input'); if (i) i.focus(); } });
      host.querySelector('[data-cd-weekcancel]').addEventListener('click', () => { editor.hidden = true; });
      host.querySelector('[data-cd-weeksave]').addEventListener('click', async () => {
        const date = editor.querySelector('input').value;
        if (!date) { toast('Pick a date', 'Choose a day in the target week.', 'err'); return; }
        const save = host.querySelector('[data-cd-weeksave]');
        save.classList.add('loading'); save.disabled = true;
        try {
          const r = await api(KINDS.setInductionWeek, { folderId: d.folderId, date });
          if (r && r.unchanged) toast('No change', `${esc(d.name || 'They')} are already in that week.`, 'ok');
          else { toast('Induction week changed', `Moved to ${fmtDay(r.wed)} & ${fmtDay(r.thu)}; calendar + email updated.`, 'ok'); if (onMutate) onMutate(); }
          H.reloadCandidateDetail && H.reloadCandidateDetail();   // refresh this page with the new dates
        } catch (err) { toast('Could not change the week', err.message, 'err'); save.classList.remove('loading'); save.disabled = false; }
      });
    }
  }

  // Open the detail page inside the Progress report `wrap`: hide the list, show the detail; Back
  // restores the list (and refreshes it if anything was changed). Re-openable for a live refresh.
  H.openCandidateDetail = async function (folderId, wrap) {
    if (!wrap) return;
    const kids = Array.from(wrap.children);
    const prevDisplay = kids.map((k) => k.style.display);
    kids.forEach((k) => { k.style.display = 'none'; });
    const host = document.createElement('div');
    host.className = 'stack cd-host';
    wrap.appendChild(host);
    let mutated = false;
    const backBtn = () => `<button class="back" data-cd-back>← Back to Progress report</button>`;
    const restore = () => {
      host.remove();
      kids.forEach((k, i) => { k.style.display = prevDisplay[i]; });
      if (mutated) { const rb = wrap.querySelector('#provRefresh'); if (rb) rb.click(); }
      H.reloadCandidateDetail = null;
    };
    const render = async () => {
      host.innerHTML = backBtn() + `<div class="card card-pad"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
      host.querySelector('[data-cd-back]').addEventListener('click', restore);
      let d;
      try { d = await api(KINDS.candidateDetail, { folderId }); }
      catch (err) {
        host.querySelector('.card').innerHTML = `<div class="state"><div class="state-title">Could not load this candidate</div><div>${esc(err.message)}</div></div>`;
        return;
      }
      host.innerHTML = backBtn() + detailHtml(d);
      host.querySelector('[data-cd-back]').addEventListener('click', restore);
      wireDetail(host, d, () => { mutated = true; });
    };
    H.reloadCandidateDetail = render;   // let an in-page action re-render with fresh data
    await render();
  };
})();
