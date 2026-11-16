import { html, useState, useLoad, app, Totals, Entry, Panel, Loading, money, num, compactMoney, fmtDate, dayParts, rel, openItem, openNew, go, GROUP_LABEL, addDays, monthName } from './lib.js';

const baseOf = (list, base) => list?.find((t) => t.currency === base)?.amount || 0;
const others = (lists, base) => [...new Set(lists.flatMap((l) => (l || []).map((t) => t.currency)))].filter((c) => c !== base);

function Tip({ tip }) {
  if (!tip) return null;
  return html`<div class="tip" style=${{ left: `${Math.min(tip.x + 14, innerWidth - 250)}px`, top: `${tip.y + 14}px` }}>${tip.lines.map((l, i) => html`<div style=${i === 0 ? 'font-weight:650;margin-bottom:2px' : ''}>${l}</div>`)}</div>`;
}

/** Grouped bars: money in vs money out per week, base currency only. */
export function WeeklyBars({ weeks, base }) {
  const [tip, setTip] = useState(null);
  const W = 640, H = 230, L = 44, R = 8, T = 10, B = 30;
  const data = weeks.map((w) => ({ w, inc: baseOf(w.incoming, base), out: baseOf(w.outgoing, base) }));
  const max = Math.max(1, ...data.flatMap((d) => [d.inc, d.out]));
  const step = 10 ** Math.floor(Math.log10(max)) / 2;
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const slot = (W - L - R) / data.length;
  const bw = Math.min(22, (slot - 14) / 2);
  const bar = (x, v, fill) => { const h = Math.max(v ? 2 : 0, H - B - y(v)); const r = Math.min(4, h); return html`<path d=${`M${x} ${H - B}v${-(h - r)}q0 ${-r} ${r} ${-r}h${bw - 2 * r}q${r} 0 ${r} ${r}v${h - r}z`} fill=${fill} />`; };
  const ticks = [0, 1, 2, 3, 4].map((i) => (top / 4) * i);
  return html`<div class="chart">
    <div class="legend" style="margin-bottom:8px"><span><i style="background:var(--s-in)"></i>Money in</span><span><i style="background:var(--s-out)"></i>Money out</span><span class="muted">${base}, outstanding amounts by due week</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Incoming and outgoing payments per week">
      ${ticks.map((t) => html`<g><line x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} stroke="#e7e2d6" stroke-width="1" /><text x=${L - 6} y=${y(t) + 4} text-anchor="end">${compactMoney(t, base)}</text></g>`)}
      ${data.map((d, i) => { const cx = L + slot * i + slot / 2; const p = dayParts(d.w.from);
        return html`<g onMouseMove=${(e) => setTip({ x: e.clientX, y: e.clientY, lines: [`Week of ${fmtDate(d.w.from, false)}`, `In: ${money(d.inc, base)} (${d.w.in_count})`, `Out: ${money(d.out, base)} (${d.w.out_count})`, d.w.estimated_count ? `${d.w.estimated_count} not confirmed` : 'All confirmed'] })} onMouseLeave=${() => setTip(null)}>
          <rect x=${L + slot * i} y=${T} width=${slot} height=${H - T - B} fill="transparent" />
          ${bar(cx - bw - 1, d.inc, 'var(--s-in)')}${bar(cx + 1, d.out, 'var(--s-out)')}
          <text x=${cx} y=${H - 12} text-anchor="middle" style=${d.w.current ? 'font-weight:700;fill:#262725' : ''}>${p.day} ${p.mon}</text></g>`; })}
    </svg><${Tip} tip=${tip} /></div>`;
}

function Donut({ parts, base }) {
  const total = parts.reduce((s, p) => s + p.v, 0);
  if (!total) return html`<p class="muted">Nothing to pay in this period.</p>`;
  const r = 52, C = 2 * Math.PI * r;
  let off = 0;
  return html`<div class="donut"><svg viewBox="0 0 132 132" role="img" aria-label="Share of outgoing payments by how firm the amount is">
      <circle cx="66" cy="66" r=${r} fill="none" stroke="#ece8dd" stroke-width="16" />
      ${parts.filter((p) => p.v).map((p) => { const len = (p.v / total) * C; const el = html`<circle cx="66" cy="66" r=${r} fill="none" stroke=${p.color} stroke-width="16" stroke-dasharray=${`${Math.max(len - 2, 1)} ${C}`} stroke-dashoffset=${-off} transform="rotate(-90 66 66)" />`; off += len; return el; })}
      <text class="big" x="66" y="65" text-anchor="middle">${Math.round((parts[0].v / total) * 100)}%</text><text x="66" y="82" text-anchor="middle" style="font-size:11px;fill:#85857b">confirmed</text></svg>
    <ul>${parts.map((p) => html`<li><i style=${`display:inline-block;width:10px;height:10px;border-radius:3px;background:${p.color};margin-right:6px`}></i>${p.label}<div class="num" style="font-weight:650">${money(p.v, base)}</div></li>`)}</ul></div>`;
}

function MiniCal({ today, items }) {
  const ym = today.slice(0, 7);
  const first = new Date(`${ym}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const by = {};
  for (const i of items) if (i.due_date?.startsWith(ym)) (by[i.due_date] ||= []).push(i);
  return html`<div><div class="row" style="margin-bottom:8px"><b>${monthName(ym)}</b><span class="spacer"></span><a href="#/calendar">Open calendar</a></div>
    <div class="mini">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => html`<b>${d}</b>`)}
      ${Array.from({ length: lead }, () => html`<span class="off">.</span>`)}
      ${Array.from({ length: days }, (_, n) => { const d = `${ym}-${String(n + 1).padStart(2, '0')}`; const list = by[d] || [];
        const cls = [list.length ? 'has' : '', list.some((i) => i.overdue) ? 'over' : list.length && list.every((i) => i.direction === 'in') ? 'in' : '', d === today ? 'today' : ''].join(' ');
        return html`<span class=${cls} title=${list.map((i) => `${i.title} — ${money(i.outstanding, i.currency)}`).join('\n')} onClick=${() => list.length && (list.length === 1 ? openItem(list[0].id) : go('#/calendar'))}>${n + 1}</span>`; })}</div></div>`;
}

export function Dashboard() {
  const [days, setDays] = useState(30);
  const [side, setSide] = useState('out');
  const [groupBy, setGroupBy] = useState('date');
  const st = useLoad(`/api/dashboard?days=${days}`);
  const wk = useLoad('/api/weekly?weeks=8');
  const d = st.data;
  if (!d) return html`<${Loading} state=${st} />`;
  const base = app.boot.settings.base_currency;
  const k = d.kpi;
  const np = d.next_payment;
  const list = d.upcoming.filter((i) => i.direction === side);
  const overdue = d.overdue.filter((i) => i.direction === side);
  const sum = (items) => { const m = {}; for (const i of items) m[i.currency] = (m[i.currency] || 0) + i.outstanding; return Object.entries(m).map(([c, v]) => money(v, c)).join(' + '); };
  const groups = groupBy === 'group'
    ? Object.keys(GROUP_LABEL).map((g) => [GROUP_LABEL[g], list.filter((i) => i.grp === g)]).filter(([, l]) => l.length)
    : [...new Set(list.map((i) => i.due_date))].map((dt) => [`${dayParts(dt).dow} ${fmtDate(dt, false)}${dt === d.today ? ' · today' : ''}`, list.filter((i) => i.due_date === dt)]);
  const s = k.outgoing_by_status;
  const parts = [{ label: 'Confirmed', v: baseOf(s.confirmed, base), color: 'var(--s-in)' }, { label: 'Estimated / projected', v: baseOf(s.estimated, base), color: 'var(--s-est)' }, { label: 'Needs review', v: baseOf(s.needs_review, base), color: 'var(--red)' }];
  const tot = parts.reduce((a, p) => a + p.v, 0) || 1;
  const byGroup = Object.keys(GROUP_LABEL).map((g) => ({ g, v: d.upcoming.filter((i) => i.direction === 'out' && i.grp === g && i.currency === base).reduce((a, i) => a + i.outstanding, 0) })).filter((x) => x.v);
  const gmax = Math.max(1, ...byGroup.map((x) => x.v));
  const extra = others([k.outgoing, k.incoming], base);

  return html`
    <div class="top"><h1>Next ${days} days</h1>
      <div class="seg" role="group" aria-label="Period">${[7, 30, 90].map((n) => html`<button class=${days === n ? 'on' : ''} onClick=${() => setDays(n)}>${n} days</button>`)}</div>
      <button class="btn primary" onClick=${() => openNew()}>+ New entry</button>
      <div class="sub">${fmtDate(d.today)} to ${fmtDate(d.end)} · ${app.boot.settings.timezone} · totals in ${base}${extra.length ? `, ${extra.join(', ')} kept separate until you enter an exchange rate` : ''}</div></div>

    <div class="tiles">
      <div class="tile hero"><button class="link" onClick=${() => np && openItem(np.id)}>
        <div class="k">What do I pay next?</div>
        ${np ? html`<div class="v"><small>${np.currency}</small>${num(np.outstanding, np.currency)}</div><div class="d">${np.title} · ${rel(np.days_until)} (${fmtDate(np.due_date, false)})${np.amount_status !== 'confirmed' || np.projected ? ' · not confirmed' : ''}</div>` : html`<div class="v">Nothing due</div><div class="d">No payments in the next ${days} days</div>`}</button></div>
      <div class="tile"><div class="k">To pay · next ${days} days</div><div class="v"><${Totals} list=${k.outgoing} zero="0.00" /></div>
        <div class="meter" title="Confirmed / estimated / needs review">${parts.map((p, i) => p.v ? html`<i class=${['c', 'e', 'r'][i]} style=${`width:${(p.v / tot) * 100}%`}></i>` : '')}</div>
        <div class="d">${Math.round((parts[0].v / tot) * 100)}% confirmed · ${k.unbilled_count} not billed yet</div></div>
      <div class="tile"><div class="k">Expected in · next ${days} days</div><div class="v green"><${Totals} list=${k.incoming} zero="0.00" /></div><div class="d">${d.upcoming.filter((i) => i.direction === 'in').length} payment(s) due to you</div></div>
      <div class="tile"><div class="k">Projected difference</div><div class="v"><${Totals} list=${k.net} zero="0.00" sign=${true} /></div><div class="d">Incoming minus outgoing, overdue not included</div></div>
    </div>
    <div class="tiles">
      <div class="tile ${k.overdue_out_count ? 'alert' : ''}"><div class="k">Overdue to pay<span>${k.overdue_out_count}</span></div><div class="v"><${Totals} list=${k.overdue_out} zero="None" /></div></div>
      <div class="tile ${k.overdue_in_count ? 'alert' : ''}"><div class="k">Overdue to collect<span>${k.overdue_in_count}</span></div><div class="v"><${Totals} list=${k.overdue_in} zero="None" /></div></div>
      <div class="tile"><div class="k">How much do I still owe?</div><div class="v"><${Totals} list=${k.owed_total} zero="0.00" /></div><div class="d">Every open bill, loan and installment · <a href="#/records?direction=out&state=open">see all</a></div></div>
      <div class="tile"><div class="k">Owed to me</div><div class="v green"><${Totals} list=${k.receivable_total} zero="0.00" /></div><div class="d"><a href="#/records?direction=in&state=open">Open receivables</a></div></div>
    </div>

    <div class="cols">
      <${Panel} title="Money in vs money out, next 8 weeks">${wk.data ? html`<${WeeklyBars} weeks=${wk.data.weeks} base=${base} />` : html`<${Loading} state=${wk} />`}<//>
      <${Panel} title="How firm is what I owe?"><${Donut} parts=${parts} base=${base} />
        ${byGroup.length ? html`<div style="margin-top:14px"><h3 class="muted" style="margin-bottom:4px">To pay by group (${base})</h3>${byGroup.map((x) => html`<div class="hbar"><span>${GROUP_LABEL[x.g]}</span><div class="track"><i style=${`width:${(x.v / gmax) * 100}%`}></i></div><span class="num">${num(x.v, base)}</span></div>`)}</div>` : ''}<//>
    </div>

    <div class="cols">
      <${Panel} pad=${false} title="Timeline" actions=${html`
          <div class="seg"><button class=${side === 'out' ? 'on' : ''} onClick=${() => setSide('out')}>To pay (${d.upcoming.filter((i) => i.direction === 'out').length})</button><button class=${side === 'in' ? 'on' : ''} onClick=${() => setSide('in')}>To receive (${d.upcoming.filter((i) => i.direction === 'in').length})</button></div>
          <div class="seg"><button class=${groupBy === 'date' ? 'on' : ''} onClick=${() => setGroupBy('date')}>By date</button><button class=${groupBy === 'group' ? 'on' : ''} onClick=${() => setGroupBy('group')}>By group</button></div>`}>
        ${overdue.length ? html`<div class="group-h" style="color:var(--red)"><span>Overdue</span><span class="num">${sum(overdue)}</span></div>${overdue.map((i) => html`<${Entry} item=${i} />`)}` : ''}
        ${groups.map(([label, items]) => html`<div class="group-h"><span>${label}</span><span class="num">${sum(items)}</span></div>${items.map((i) => html`<${Entry} item=${i} showGroup=${groupBy !== 'group'} />`)}`)}
        ${!groups.length && !overdue.length ? html`<div class="empty">Nothing ${side === 'out' ? 'to pay' : 'to receive'} in the next ${days} days.</div>` : ''}<//>
      <div class="stack">
        <${Panel} title="This month"><${MiniCal} today=${d.today} items=${[...d.upcoming, ...d.overdue]} /><//>
        <${Panel} pad=${false} title="Coming up, not billed yet" actions=${html`<span class="num muted"><${Totals} list=${k.unbilled} /></span>`}>
          ${d.upcoming.filter((i) => i.direction === 'out' && !i.billed).slice(0, 6).map((i) => html`<${Entry} item=${i} showGroup=${false} />`)}
          ${k.unbilled_count === 0 ? html`<div class="empty">Every upcoming payment has a bill or agreed schedule.</div>` : ''}<//>
        ${d.needs_review.length ? html`<${Panel} pad=${false} title="Needs review (${d.needs_review.length})" actions=${html`<a href="#/inbox/review">Open</a>`}>${d.needs_review.slice(0, 4).map((i) => html`<${Entry} item=${i} showGroup=${false} />`)}<//>` : ''}
      </div>
    </div>`;
}
