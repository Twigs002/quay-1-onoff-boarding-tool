/* Quay 1 Boarding Tool - Today landing view (redesign round 2, changelog #15).
 *
 * A single at-a-glance screen built entirely from the existing `status` endpoint
 * (no new backend): four counts + three queues (needs you today / waiting on
 * documents / this week). Registered as VIEWS.today in app.js and rendered via
 * window.HUB.viewToday. Reuses the shared HUB helpers so rows match the Progress
 * report and Admin Check exactly.
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) return;

  // Monday 00:00 to Sunday 23:59 of the current local week - for the "this week" bucket.
  function weekBounds() {
    const now = new Date();
    const day = now.getDay();                 // 0 Sun .. 6 Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 23, 59, 59);
    return { start: mon, end: sun };
  }
  function parseIso(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function fmtNice(iso) {
    const d = parseIso(iso);
    if (!d) return iso || '';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getDate()} ${MON[d.getMonth()]}`;
  }

  // A person pipe-row matching renderPipeline in app.js (avatar + main + side).
  function pipeRow(o, sideHtml, extraMeta) {
    const docs = (o.docs || o.docs === undefined) ? '' : '';   // placeholder; docs added by caller
    return `<div class="pipe-row"><span class="avatar${String(o.entity).toLowerCase() === 'aqua' ? ' avatar-aqua' : ''}">${H.esc(initials(o.name))}</span>
      <div class="pipe-main">
        <div class="pipe-name">${H.esc(o.name || '(no name)')} ${H.entTag(o.entity)}</div>
        <div class="pipe-team">${H.esc(o.team || '')}${extraMeta ? ' · ' + H.esc(extraMeta) : ''}</div>
        ${o.__docs || ''}
      </div>
      <div class="pipe-side">${sideHtml || ''}</div>
    </div>`;
  }
  function initials(name) {
    const p = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '')[0] || '?').toUpperCase() + (p.length > 1 ? (p[p.length - 1][0] || '').toUpperCase() : '');
  }
  function docsHtml(o) {
    const d = o.docs || {};
    return `<div class="docs">${H.docPill(d.contract, 'Contract')}${H.docPill(d.id, 'ID')}${H.docPill(d.poa, 'Address')}${H.docPill(d.bank, 'Bank')}</div>`;
  }

  function viewToday(root) {
    const wrap = H.el(`<div class="stack">
      <div class="section-head"><div>
        <h2>Today</h2>
        <p>Where onboarding stands right now, and who needs you. Everything here is a live view; actions happen on their own tabs.</p>
      </div></div>
      <div class="grid-4" id="todayStats">
        <div class="card stat"><div class="stat-label">In progress</div><div class="stat-value">-</div></div>
        <div class="card stat"><div class="stat-label">Ready to approve</div><div class="stat-value">-</div></div>
        <div class="card stat"><div class="stat-label">Waiting on docs</div><div class="stat-value">-</div></div>
        <div class="card stat"><div class="stat-label">Booked this week</div><div class="stat-value">-</div></div>
      </div>
      <div id="todayNeeds"></div>
      <div id="todayWaiting"></div>
      <div id="todayWeek"></div>
    </div>`);
    root.appendChild(wrap);
    load(wrap);
  }

  async function load(wrap) {
    const needs = H.$('#todayNeeds', wrap);
    needs.innerHTML = `<div class="card card-pad"><div class="skeleton"></div><div class="skeleton"></div></div>`;
    let r = null, lastErr = null;
    // A cold /exec can return non-JSON ("Bad response") on the first hit; retry only that case.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { r = await H.api(H.KINDS.status, {}); lastErr = null; break; }
      catch (err) { lastErr = err; if (!/Bad response/.test(err.message)) break; }
    }
    if (lastErr) {
      needs.innerHTML = `<div class="card card-pad"><div class="state"><div class="state-title">Could not load Today</div><div>${H.esc(lastErr.message)}</div></div></div>`;
      return;
    }
    render(wrap, r);
  }

  function render(wrap, r) {
    const onb = (r.onboarding || []).slice();
    const booked = (r.booked || []).slice();
    const ready = onb.filter((o) => o.docs_ready && !o.approved);
    const waiting = onb.filter((o) => !o.docs_ready);
    const wb = weekBounds();
    const thisWeek = booked.filter((o) => {
      const d = parseIso(o.induction_wed) || parseIso(o.induction_thu);
      return d && d >= wb.start && d <= wb.end;
    });

    // Stat counts.
    const stats = H.$('#todayStats', wrap);
    const stat = (label, n, accent) =>
      `<div class="card stat${accent && n ? ' is-accent' : ''}"><div class="stat-label">${label}</div><div class="stat-value">${n}</div></div>`;
    stats.innerHTML = stat('In progress', onb.length) + stat('Ready to approve', ready.length, true) +
      stat('Waiting on docs', waiting.length) + stat('Booked this week', thisWeek.length);

    const user = H.getUser && H.getUser();
    const canAccept = !!(user && (user.isAdmin || user.isSuper));

    // Needs you today: ready-to-approve. Accept happens on Admin Check, so link there (admins only).
    const needsHost = H.$('#todayNeeds', wrap);
    if (ready.length && canAccept) {
      const rows = ready.map((o) => {
        o.__docs = docsHtml(o);
        const side = `<span class="pill pill-ready">Ready to approve</span>
          <div class="pipe-actions"><button type="button" class="btn btn-blue-solid btn-sm" data-goto="admincheck">Review &amp; accept</button></div>`;
        return pipeRow(o, side);
      }).join('');
      needsHost.innerHTML = `<div class="pipe-subhead">Needs you today</div><div class="pipe-list">${rows}</div>`;
      needsHost.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
        const t = document.querySelector(`.tab-btn[data-tab="${b.dataset.goto}"]`);
        if (t) t.click();
      }));
    } else {
      needsHost.innerHTML = `<div class="pipe-subhead">Needs you today</div><div class="card card-pad"><div class="state"><div class="state-title">Nothing waiting on you</div><div>No one is ready to approve right now.</div></div></div>`;
    }

    // Waiting on documents: still chasing FICA / signed contract. Offer Send reminder.
    const waitHost = H.$('#todayWaiting', wrap);
    if (waiting.length) {
      const rows = waiting.map((o) => {
        o.__docs = docsHtml(o);
        const side = `<span class="pill pill-pending">Waiting on documents</span>
          <div class="pipe-actions"><button type="button" class="btn btn-ghost btn-sm" data-remind="${H.esc(o.folderId)}" data-name="${H.esc(o.name || '')}">Send reminder</button></div>`;
        return pipeRow(o, side);
      }).join('');
      waitHost.innerHTML = `<div class="pipe-subhead">Waiting on documents</div><div class="pipe-list">${rows}</div>`;
      waitHost.querySelectorAll('[data-remind]').forEach((b) => b.addEventListener('click', async () => {
        const name = b.dataset.name || 'this person';
        b.classList.add('loading'); b.disabled = true;
        try {
          const rr = await H.api(H.KINDS.remind, { folderId: b.dataset.remind });
          H.toast('Reminder sent', `A follow-up with the contract was sent to ${H.esc(rr.to || name)}.`, 'ok');
        } catch (err) { H.toast('Could not send reminder', err.message, 'err'); }
        b.classList.remove('loading'); b.disabled = false;
      }));
    } else {
      waitHost.innerHTML = '';
    }

    // This week: inductions booked for the current week.
    const weekHost = H.$('#todayWeek', wrap);
    if (thisWeek.length) {
      const rows = thisWeek.map((o) => {
        const when = [o.induction_wed, o.induction_thu].filter(Boolean).map(fmtNice).join(' & ');
        const side = `<span class="pill pill-done">Induction booked</span>`;
        return pipeRow(o, side, when ? 'induction ' + when : '');
      }).join('');
      weekHost.innerHTML = `<div class="pipe-subhead">This week</div><div class="pipe-list">${rows}</div>`;
    } else {
      weekHost.innerHTML = '';
    }
  }

  H.viewToday = viewToday;
})();
