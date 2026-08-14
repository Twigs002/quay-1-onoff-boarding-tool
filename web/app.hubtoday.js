/* Pagan Hub - "Today" command centre (window.HUB.viewHubToday).
 *
 * Your morning view: what needs you, your live request queues, and the status of
 * the automations that run your operation - aggregated in one place. Numbers come
 * from the `hub_signals` table (filled by the laptop hub_collector.py) plus live
 * reads for anything already in Supabase (VA searches). Tiles with no signal yet
 * show a deep link to the source (e.g. the Gmail label) so it's useful on day one.
 */
(() => {
  'use strict';
  const H = window.HUB, VA = window.VA;
  if (!H) return;
  const sb = () => (window.AUTH && window.AUTH.getClient && window.AUTH.getClient());
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const GM = (label) => `https://mail.google.com/mail/u/0/#label/${label.replace(/ /g, '+')}`;

  // The scaffold of Pagan's operation (from the workstream analysis). `live` pulls a
  // real number now; everything else fills in once the collector pushes a signal.
  const NEEDS = [
    { key: 'to_respond', label: 'To respond', href: GM('To respond') },
    { key: 'nb_look', label: 'NB look at me', href: GM('NB LOOK AT ME'), accent: 'bad' },
    { key: 'action_items', label: 'Doc action items' },
    { key: 'approvals', label: 'Approvals pending' },
  ];
  const QUEUES = [
    { key: 'valuations', label: 'Valuation requests', href: GM('Valuation Requests') },
    { key: 'va_searches', label: 'VA searches to run', live: 'va_pending', href: '#vasearches' },
    { key: 'premium_listings', label: 'Premium listings', href: GM('Enquires') },
    { key: 'ppra', label: 'PPRA assistance', href: GM('PPRA Assistance') },
    { key: 'enquiries', label: 'Enquiries', href: GM('Enquires') },
    { key: 'lead_reconv', label: 'Lead reconversion', href: GM('LN Lead Reconversion') },
    { key: 'recruitment', label: 'Recruitment', href: GM('Recruitment/Indeed') },
    { key: 'self_signup', label: 'Self sign-ups', href: GM('Self sign up form') },
  ];
  const PIPELINE = [
    { key: 'data_jobs', label: 'Data jobs open', live: 'data_open', href: '#datatracker', sub: 'KF data queue' },
    { key: 'leads_action', label: 'Leads to action', live: 'leads_action', href: 'https://twigs002.github.io/quay-leads/' },
    { key: 'deals_live', label: 'Live deals', live: 'deals_live', href: 'https://twigs002.github.io/quay-deals-live/' },
    { key: 'deals_stale', label: 'Uncalled deals', live: 'deals_stale', href: 'https://twigs002.github.io/quay-leads/' },
    { key: 'onboarding', label: 'Onboarding in progress', live: 'onboarding', href: 'https://twigs002.github.io/quay-1-onoff-boarding-tool/' },
    { key: 'dealflow', label: 'Dealflow synced' },
  ];
  const SYSTEMS = [
    { key: 'va_bridge', label: 'VA auto-search', live: 'va_rate', sub: 'success rate' },
    { key: 'market_reports', label: 'Market reports' },
    { key: 'dialfire', label: 'Dialfire report' },
    { key: 'intro_emails', label: 'Intro emails today' },
    { key: 'automation_health', label: 'Automations healthy' },
  ];

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  function today() {
    const d = new Date(), DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
  }

  function tile(item, sig, live) {
    const s = sig[`${item.domain}:${item.key}`];
    let val = s && s.value_num != null ? s.value_num : (item.live && live[item.live] != null ? live[item.live] : null);
    const text = s && s.value_text ? s.value_text : (val != null ? fmt(val) : null);
    const stamp = s && s.updated_at ? '' : (item.live ? '' : '<span class="ph-stamp">awaiting sync</span>');
    const sub = item.sub || (s && s.label) || '';
    const inner = `<div class="ph-tile-label">${H.esc(item.label)}</div>
      <div class="ph-tile-num${item.accent === 'bad' && val ? ' bad' : ''}">${text != null ? H.esc(text) : '—'}</div>
      <div class="ph-tile-sub">${H.esc(sub)}${stamp}</div>`;
    return item.href
      ? `<a class="ph-tile" ${item.href.startsWith('#') ? `data-goto="${item.href.slice(1)}"` : `href="${H.esc(item.href)}" target="_blank" rel="noopener"`}>${inner}</a>`
      : `<div class="ph-tile">${inner}</div>`;
  }

  // Onboarding-in-progress count via the boarding tool's status endpoint (reuses the
  // shared config.js LIFECYCLE_ENDPOINT + Pagan's Supabase JWT). Null on any failure.
  async function onboardingCount() {
    const ep = (window.QUAY_CFG || {}).LIFECYCLE_ENDPOINT;
    if (!ep || !window.AUTH || !window.AUTH.getAccessToken) return null;
    try {
      const tok = await window.AUTH.getAccessToken();
      if (!tok) return null;
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ kind: 'status', accessToken: tok }), signal: ctrl.signal });
      clearTimeout(timer);
      const j = await res.json();
      return Array.isArray(j.onboarding) ? j.onboarding.length : null;
    } catch (_) { return null; }
  }

  async function load(wrap) {
    const host = (id) => H.$(id, wrap);
    let rows = [], live = {};
    const client = sb();
    const REASSIGN = ['External Lead', 'Calling Lead', 'Inbound Lead'];
    const cnt = (build) => (client ? build(client).then((r) => r).catch(() => null) : Promise.resolve(null));
    try {
      const [sig, va, dj, la, dl, ds] = await Promise.all([
        client ? client.from('hub_signals').select('*') : Promise.resolve({ data: [] }),
        (VA && VA.counts) ? VA.counts('all').catch(() => null) : Promise.resolve(null),
        cnt((c) => c.from('data_jobs').select('*', { count: 'exact', head: true }).not('status', 'in', '(done,blocked)')),
        cnt((c) => c.from('leads_enriched').select('*', { count: 'exact', head: true }).eq('worked', false)),
        cnt((c) => c.from('hs_deal_state').select('*', { count: 'exact', head: true })),
        cnt((c) => c.from('hs_deal_state').select('*', { count: 'exact', head: true }).in('current_stage', REASSIGN).or('num_calls.eq.0,num_calls.is.null')),
      ]);
      rows = (sig && sig.data) || [];
      if (va) { live.va_pending = va.pending; live.va_rate = `${Math.round((va.successRate || 0) * 100)}%`; }
      const setc = (o, k) => { if (o && !o.error && o.count != null) live[k] = o.count; };
      setc(dj, 'data_open'); setc(la, 'leads_action'); setc(dl, 'deals_live'); setc(ds, 'deals_stale');
    } catch (_) { /* show scaffold with no live values */ }
    const sigMap = {};
    rows.forEach((r) => { sigMap[`${r.domain}:${r.key}`] = r; });
    const render = (arr, domain) => arr.map((i) => tile(Object.assign({ domain }, i), sigMap, live)).join('');
    const paint = () => {
      host('#tNeeds').innerHTML = render(NEEDS, 'inbox');
      host('#tQueues').innerHTML = render(QUEUES, 'requests');
      host('#tPipeline').innerHTML = render(PIPELINE, 'pipeline');
      host('#tSystems').innerHTML = render(SYSTEMS, 'systems');
      wrap.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault();
        const t = document.querySelector(`.tab-btn[data-tab="${a.dataset.goto}"]`); if (t) t.click();
      }));
    };
    paint();
    // Onboarding is live via the boarding status endpoint - fetched in the background
    // (can be a cold Apps Script exec) and painted in when it returns.
    onboardingCount().then((n) => { if (n != null) { live.onboarding = n; paint(); } });
    const synced = rows.length ? `Live · ${rows.length} signals` : 'Scaffold only - run the collector to go live';
    const sc = host('#tSynced'); if (sc) sc.textContent = synced;
  }

  function viewHubToday(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head">
        <div><h2>${greeting()}, Pagan</h2>
          <p class="ph-sub">${today()} — your day, your queues, and what the automations are doing. <span id="tSynced" class="ph-faint"></span></p></div>
      </div>

      <div><div class="ph-label" style="margin:0 2px 10px">Needs you</div>
        <div class="ph-tiles" id="tNeeds"></div></div>

      <div><div class="ph-label" style="margin:8px 2px 10px">Request queues</div>
        <div class="ph-tiles" id="tQueues"></div></div>

      <div><div class="ph-label" style="margin:8px 2px 10px">Data &amp; pipeline</div>
        <div class="ph-tiles" id="tPipeline"></div></div>

      <div><div class="ph-label" style="margin:8px 2px 10px">Systems &amp; automations</div>
        <div class="ph-tiles" id="tSystems"></div></div>

      <div class="ph-ask">
        <div class="ph-label" style="color:rgba(255,255,255,.7)">Ask your hub</div>
        <div class="ph-ask-row">
          <input id="tAsk" type="text" placeholder="e.g. how many valuations are open? what needs me today?" disabled>
          <button class="btn btn-gold" disabled>Ask</button>
        </div>
        <div class="ph-ask-note">Coming next — a question box over all your queues, mail and systems.</div>
      </div>
    </div>`);
    root.appendChild(wrap);
    load(wrap);
  }

  H.viewHubToday = viewHubToday;
})();
