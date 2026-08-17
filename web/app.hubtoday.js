/* Pagan Hub - Overview (window.HUB.viewHubToday).
 *
 * A tight morning digest: one short line per area of the operation, each a live
 * number pulled straight from Supabase where it exists, linking to its tab. No big
 * tile grid - just "here's where everything stands" at a glance.
 */
(() => {
  'use strict';
  const H = window.HUB, VA = window.VA;
  if (!H) return;
  const sb = () => (window.AUTH && window.AUTH.getClient && window.AUTH.getClient());
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const R = (n) => 'R' + Math.round(Number(n) || 0).toLocaleString();
  const GM = 'https://mail.google.com/mail/u/0/#label/To+respond';

  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
  function today() {
    const d = new Date(), DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
  }
  const rowEl = (k, v, goto, ext) => `<a class="ov-row"${ext ? ` href="${ext}" target="_blank" rel="noopener"` : ` data-goto="${goto}"`}>
    <span class="ov-k">${H.esc(k)}</span><span class="ov-v">${v}</span><span class="ov-go">→</span></a>`;

  async function load(wrap) {
    const host = H.$('#ovList', wrap);
    const c = sb();
    const q = (build, fallback) => (c ? build(c).then((r) => (r && !r.error ? r : fallback)).catch(() => fallback) : Promise.resolve(fallback));
    const cnt = (t, f) => q((cl) => { let x = cl.from(t); f && (x = f(x)); return x.select('*', { count: 'exact', head: true }); }, { count: null });

    const [va, djOpen, djAwait, allocs, spend, sig, leads, deals, stale] = await Promise.all([
      (VA && VA.counts) ? VA.counts('all').catch(() => null) : Promise.resolve(null),
      cnt('data_jobs', (x) => x.not('status', 'in', '(done,blocked)')),
      cnt('data_jobs', (x) => x.eq('status', 'awaiting')),
      q((cl) => cl.from('p24_allocations').select('monthly_allocation'), { data: null }),
      q((cl) => cl.from('p24_spend').select('amount').eq('month', new Date().toISOString().slice(0, 7)), { data: null }),
      q((cl) => cl.from('hub_signals').select('domain,key,value_num').eq('domain', 'inbox'), { data: null }),
      cnt('leads_enriched', (x) => x.eq('worked', false)),
      cnt('hs_deal_state'),
      cnt('hs_deal_state', (x) => x.in('current_stage', ['External Lead', 'Calling Lead', 'Inbound Lead']).or('num_calls.eq.0,num_calls.is.null')),
    ]);

    const rows = [];
    rows.push(rowEl('VA Searches', va ? `${fmt(va.pending)} to search · ${Math.round((va.successRate || 0) * 100)}% hit rate` : 'awaiting sync', 'vasearches'));
    rows.push(rowEl('Data jobs', djOpen.count != null ? `${fmt(djOpen.count)} open${djAwait.count ? ` · ${djAwait.count} awaiting return` : ''}` : 'not set up yet', 'datatracker'));
    if (allocs.data) {
      const budget = allocs.data.reduce((a, r) => a + Number(r.monthly_allocation || 0), 0);
      const spent = (spend.data || []).reduce((a, s) => a + Number(s.amount || 0), 0);
      rows.push(rowEl('P24 budget', `${R(budget - spent)} left of ${R(budget)} this month`, 'p24budget'));
    } else {
      rows.push(rowEl('P24 budget', 'not set up yet', 'p24budget'));
    }
    rows.push(rowEl('Leads', leads.count != null ? `${fmt(leads.count)} to action` : '—', null, 'https://twigs002.github.io/quay-leads/'));
    rows.push(rowEl('Deals', deals.count != null ? `${fmt(deals.count)} live · ${fmt(stale.count || 0)} uncalled` : '—', null, 'https://twigs002.github.io/quay-deals-live/'));
    if (sig.data && sig.data.length) {
      const m = {}; sig.data.forEach((r) => { m[r.key] = r.value_num; });
      rows.push(rowEl('Inbox', `${fmt(m.to_respond)} to respond · ${fmt(m.nb_look)} flagged`, null, GM));
    }
    host.innerHTML = rows.join('');
    host.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); const t = document.querySelector(`.tab-btn[data-tab="${a.dataset.goto}"]`); if (t) t.click();
    }));
  }

  function viewHubToday(root) {
    const wrap = H.el(`<div class="stack hub-in">
      <div class="section-head"><div>
        <h2>${greeting()}, Pagan</h2>
        <p class="ph-sub">${today()} — where everything stands, in a line each.</p></div></div>
      <div class="ov-list" id="ovList"><div class="card card-pad"><div class="skeleton"></div></div></div>
    </div>`);
    root.appendChild(wrap);
    load(wrap);
  }

  H.viewHubToday = viewHubToday;
})();
