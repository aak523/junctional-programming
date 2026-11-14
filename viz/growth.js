/* GPU World — capacity formation.
   The growth half of world.py, re-run in the browser on a mean path, plus the same
   decomposition read off a finished game. Charts are hand-rolled SVG: hairline marks,
   one neutral ramp ordered by stack position, a crosshair on every plot and a table
   under it, so nothing is carried by colour alone. */

// ---------------------------------------------------------------- theme
const THEME = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = THEME;
document.getElementById('theme').addEventListener('click', () => {
  const q = new URLSearchParams(location.search);
  q.set('theme', THEME === 'light' ? 'dark' : 'light');
  location.search = q.toString();
});
const CSS = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------------------------------------------------------------- the model's constants
// Lifted from world.py; if that file moves, these move with it.
const T = 24;
const SITES = ['us', 'eu', 'ap'];
const COMPUTE = { H: 1.0, N: 2.0 };          // kH per thousand GPUs
const POWER_MW = { H: 1.4, N: 1.6 };         // MW per thousand GPUs
const GPU_PRICE = { H: 25.0, N: 40.0 };      // $M per thousand
const POWER_COST = { us: 0.15, eu: 0.20, ap: 0.12 };
const POWER_LEAD = { us: [3, 8], eu: [4, 9], ap: [2, 6] };
const POWER_TERM = 24;
const MIN_LEAD = 3;
const ALLOC = { H: { loose: 6.0, tight: 2.0 }, N: { loose: 4.0, tight: 1.5 } };
const RESERVE_CAP = { loose: { us: 4, eu: 3, ap: 3 }, tight: { us: 1, eu: 1, ap: 1 } };
const SPOT_CAP = { loose: { us: 5, eu: 4, ap: 3 }, tight: { us: 1.5, eu: 1, ap: 0.5 } };
const INF_SHARE = { us: 0.5, eu: 0.3, ap: 0.2 };
const EXPORT_ALLOC = 0.4, EXPORT_MONTHS = 6;
const MILESTONES = [[0, 7, 60], [8, 15, 140], [16, 23, 320]];
const lead = s => Math.round((POWER_LEAD[s][0] + POWER_LEAD[s][1]) / 2);   // the mean wait

// ---------------------------------------------------------------- the simulation
// One pass of the month loop, with every random draw replaced by its expectation:
// allocation noise 1.0, power lead at the midpoint of its range, demand on its trend.
function sim(p) {
  const owned = { us: { H: 6, N: 0 }, eu: { H: 4, N: 0 }, ap: { H: 0, N: 0 } };
  let queue = [{ gen: 'H', qty: 4, left: 4, placed: -2, site: 'us' }];
  const power = [{ mw: 10, site: 'us', start: -4, end: -4 + POWER_TERM },
                 { mw: 6, site: 'eu', start: -4, end: -4 + POWER_TERM }];
  const contracts = [{ qty: 2, site: 'us', start: -7, end: 5 }];
  const regimeAt = k => (p.regime === 'run' ? (p.regimePath?.[k] || 'loose') : p.regime);
  const exportAt = k => p.exportOn && k >= p.exportStart && k < p.exportStart + EXPORT_MONTHS;
  const rows = [];
  let capex = 0, powerBill = 0;

  for (let k = 0; k < T; k++) {
    const reg = regimeAt(k);

    // --- the policy acts at the top of the month
    if (k >= p.orderFrom && k <= p.orderUntil) {
      const gen = k >= p.launch ? 'N' : 'H';          // gen H is discontinued at launch
      if (p.orderK > 0) {
        queue.push({ gen, qty: p.orderK, left: p.orderK, placed: k, site: p.site });
        capex += p.orderK * GPU_PRICE[gen];
      }
      if (p.powerMW > 0) {
        const start = k + lead(p.site);
        power.push({ mw: p.powerMW, site: p.site, start, end: start + POWER_TERM });
      }
      if (p.reserveK > 0) {
        const q = Math.min(p.reserveK, RESERVE_CAP[reg][p.site]);
        contracts.push({ qty: q, site: p.site, start: k + 1, end: k + 1 + 12 });
      }
    }

    // --- month end: what is live, where
    const site = {};
    let live = 0, fleet = 0, reserved = 0, spot = 0, mwTotal = 0, demand = 0;
    for (const s of SITES) {
      const mw = power.filter(x => x.site === s && x.start <= k && k < x.end)
                      .reduce((a, x) => a + x.mw, 0);
      const n = Math.min(owned[s].N, mw / POWER_MW.N);
      const h = Math.min(owned[s].H, (mw - n * POWER_MW.N) / POWER_MW.H);
      const ownLive = n * COMPUTE.N + h * COMPUTE.H;
      const ownFleet = owned[s].N * COMPUTE.N + owned[s].H * COMPUTE.H;
      const res = contracts.filter(c => c.site === s && c.start <= k && k < c.end)
                           .reduce((a, c) => a + c.qty, 0);
      const sp = s === p.site ? Math.min(p.spotK, SPOT_CAP[reg][s]) : 0;
      const dem = 6 * Math.exp(p.growth * k) * INF_SHARE[s];
      site[s] = { mw, ownLive, ownFleet, res, sp, dem, cap: ownLive + res + sp };
      live += ownLive; fleet += ownFleet; reserved += res; spot += sp; mwTotal += mw; demand += dem;
      powerBill += mw * POWER_COST[s];
    }
    const capacity = live + reserved + spot;
    const training = SITES.reduce((a, s) => a + Math.max(0, site[s].cap - site[s].dem), 0);
    const queued = queue.reduce((a, o) => a + o.left * COMPUTE[o.gen], 0);

    rows.push({
      m: k, regime: reg, live, reserved, spot, capacity, demand, training,
      stranded: Math.max(0, fleet - live), fleet, queued, mw: mwTotal,
    });

    // --- shipments: one FIFO queue per generation, rationed by the month's allocation
    for (const gen of ['H', 'N']) {
      let a = ALLOC[gen][reg] * (gen === 'H' && exportAt(k) ? EXPORT_ALLOC : 1);
      for (const o of queue) {
        if (o.gen !== gen || o.left <= 0 || k < o.placed + MIN_LEAD - 1 || a <= 0) continue;
        const x = Math.min(o.left, a);
        o.left -= x; a -= x;
        owned[o.site][gen] += x;
      }
    }
    queue = queue.filter(o => o.left > 1e-9);
  }

  const windows = MILESTONES.map(([a, d, target]) => {
    const got = rows.slice(a, d + 1).reduce((x, r) => x + r.training, 0);
    return { a, d, target, got, hit: got >= target - 1e-9 };
  });
  const firstNew = rows.find(r => r.live > 10.0001);   // 10 kH is the starting fleet, fully powered
  return { rows, windows, capex, powerBill, firstNew: firstNew ? firstNew.m : null };
}

// ---------------------------------------------------------------- svg plumbing
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent = null) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const STEPS = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250];
const nice = m => { for (const s of STEPS) if (s * 4 >= m) return s * 4; return Math.ceil(m / 100) * 100; };
const fmt = (v, d = 1) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(d));

/* One chart. cfg:
     title, sub, data [{m, ...}], unit
     stacks  [{key,label,fill,hatch}]   drawn as columns, 2px of surface between segments
     lines   [{key,label,stroke,dash,label_}]
     band    {hi,lo,label,hatch}        the gap between two series, filled
     marks   [{m,label}]                vertical annotations
     targets [{y,label}]                horizontal reference rules                        */
function chart(host, cfg) {
  host.innerHTML = '';
  const hd = document.createElement('div');
  hd.className = 'chart-hd';
  hd.innerHTML = `<div><h3>${cfg.title}</h3><p>${cfg.sub}</p></div>`;
  host.appendChild(hd);

  const legend = document.createElement('div');
  legend.className = 'legend';
  const keys = [...(cfg.stacks || []), ...(cfg.band ? [{ label: cfg.band.label, fill: cfg.band.fill, hatch: true }] : []),
                ...(cfg.lines || [])];
  if (keys.length > 1) {
    legend.innerHTML = keys.map(s => `<span><b class="${s.stroke ? 'line' : ''}" style="background:${s.fill || s.stroke}${s.hatch ? ';opacity:.55' : ''}"></b>${s.label}</span>`).join('');
    host.appendChild(legend);
  }

  const plot = document.createElement('div');
  plot.className = 'plot';
  host.appendChild(plot);
  const tip = document.createElement('div');
  tip.className = 'tip';
  plot.appendChild(tip);

  const draw = () => {
    const W = Math.max(520, plot.clientWidth), H = cfg.height || 236;
    const L = 46, R = 14, Tp = 16, B = 28;
    const iw = W - L - R, ih = H - Tp - B;
    const data = cfg.data;
    const band = iw / data.length;
    const bw = Math.min(26, band * 0.66);

    let max = 0;
    for (const d of data) {
      let s = 0;
      for (const st of cfg.stacks || []) s += d[st.key] || 0;
      max = Math.max(max, s);
      for (const ln of cfg.lines || []) max = Math.max(max, d[ln.key] || 0);
      if (cfg.band) max = Math.max(max, d[cfg.band.hi] || 0);
    }
    for (const t of cfg.targets || []) max = Math.max(max, t.y);
    max = nice(max <= 0 ? 1 : max * 1.1);

    const x = i => L + band * (i + 0.5);
    const y = v => Tp + ih - (v / max) * ih;

    plot.querySelector('svg')?.remove();
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': cfg.title });
    plot.appendChild(svg);

    const defs = el('defs', {}, svg);
    const hatch = el('pattern', { id: `h-${cfg.id}`, width: 5, height: 5, patternUnits: 'userSpaceOnUse',
                                  patternTransform: 'rotate(45)' }, defs);
    el('rect', { width: 5, height: 5, fill: 'transparent' }, hatch);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: CSS('--s5'), 'stroke-width': 2 }, hatch);

    // y rules
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (max / steps) * i;
      el('line', { x1: L, y1: y(v), x2: W - R, y2: y(v), class: i ? 'ax-rule' : 'ax-base' }, svg);
      const t = el('text', { x: L - 8, y: y(v) + 3, class: 'ax', 'text-anchor': 'end' }, svg);
      t.textContent = fmt(v, max / steps >= 2 ? 0 : 1);
    }
    const yl = el('text', { x: 0, y: Tp - 6, class: 'ax' }, svg);
    yl.textContent = cfg.unit;

    // x ticks every 4 months
    for (let i = 0; i < data.length; i++) {
      if (i % 4) continue;
      const t = el('text', { x: x(i), y: H - 10, class: 'ax', 'text-anchor': 'middle' }, svg);
      t.textContent = 'M' + data[i].m;
    }

    // horizontal reference rules
    for (const t of cfg.targets || []) {
      el('line', { x1: L, y1: y(t.y), x2: W - R, y2: y(t.y), stroke: CSS('--axis'), 'stroke-width': 1,
                   'stroke-dasharray': '2 3' }, svg);
      const lab = el('text', { x: W - R, y: y(t.y) - 5, class: 'mark-lab', 'text-anchor': 'end' }, svg);
      lab.textContent = t.label;
    }

    // vertical annotations
    for (const m of cfg.marks || []) {
      const i = data.findIndex(d => d.m === m.m);
      if (i < 0) continue;
      el('line', { x1: x(i), y1: Tp, x2: x(i), y2: Tp + ih, stroke: CSS('--axis'), 'stroke-width': 1,
                   'stroke-dasharray': '1 4' }, svg);
      const lab = el('text', { x: x(i) + 4, y: Tp + 9, class: 'mark-lab' }, svg);
      lab.textContent = m.label;
    }

    // the band between two series
    if (cfg.band) {
      const up = data.map((d, i) => `${x(i)},${y(d[cfg.band.hi])}`);
      const dn = data.map((d, i) => `${x(i)},${y(d[cfg.band.lo])}`).reverse();
      el('polygon', { points: [...up, ...dn].join(' '), fill: `url(#h-${cfg.id})`, opacity: .85 }, svg);
    }

    // stacked columns, with 2px of surface between segments
    for (let i = 0; i < data.length; i++) {
      let acc = 0;
      for (const st of cfg.stacks || []) {
        const v = data[i][st.key] || 0;
        if (v <= 0) { acc += v; continue; }
        const y0 = y(acc), y1 = y(acc + v);
        const h = Math.max(0.6, y0 - y1 - 2);
        el('rect', { x: x(i) - bw / 2, y: y1, width: bw, height: h, fill: st.fill, rx: 0 }, svg);
        acc += v;
      }
    }

    // lines
    for (const ln of cfg.lines || []) {
      const pts = data.map((d, i) => `${x(i)},${y(d[ln.key] || 0)}`).join(' ');
      el('polyline', { points: pts, fill: 'none', stroke: CSS('--plane'), 'stroke-width': 5,
                       'stroke-dasharray': ln.dash ? '5 3' : null, 'stroke-linejoin': 'round', opacity: .8 }, svg);
      el('polyline', { points: pts, fill: 'none', stroke: ln.stroke, 'stroke-width': 2,
                       'stroke-dasharray': ln.dash || null, 'stroke-linejoin': 'round' }, svg);
      const last = data[data.length - 1];
      const lab = el('text', { x: x(data.length - 1) + 6, y: y(last[ln.key] || 0) + 3, class: 'mark-lab',
                               'text-anchor': 'end', stroke: CSS('--plane'), 'stroke-width': 3,
                               'paint-order': 'stroke' }, svg);
      lab.setAttribute('x', W - R - 2);
      lab.setAttribute('y', y(last[ln.key] || 0) - 6);
      lab.textContent = ln.tag ? `${ln.tag} ${fmt(last[ln.key] || 0, 0)}` : '';
    }

    // hover layer
    const cross = el('line', { class: 'crosshair', y1: Tp, y2: Tp + ih, opacity: 0 }, svg);
    const hit = el('rect', { x: L, y: Tp, width: iw, height: ih, fill: 'transparent' }, svg);
    const series = [...(cfg.stacks || []), ...(cfg.lines || []),
                    ...(cfg.band ? [{ key: cfg.band.gapKey, label: cfg.band.label, fill: CSS('--s5') }] : [])];
    hit.addEventListener('mousemove', e => {
      const r = plot.getBoundingClientRect();
      const i = Math.max(0, Math.min(data.length - 1, Math.floor(((e.clientX - r.left) * (W / r.width) - L) / band)));
      const d = data[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1);
      tip.innerHTML = `<b>Month ${d.m}${d.regime ? ' · ' + d.regime : ''}</b>` + series.map(s =>
        `<div class="r"><i><b style="background:${s.fill || s.stroke}"></b>${s.label}</i><u>${fmt(d[s.key] || 0)}</u></div>`).join('');
      tip.style.opacity = 1;
      const px = (x(i) / W) * r.width;
      tip.style.left = Math.min(r.width - 190, Math.max(0, px + 14)) + 'px';
      tip.style.top = '6px';
    });
    hit.addEventListener('mouseleave', () => { tip.style.opacity = 0; cross.setAttribute('opacity', 0); });
  };

  draw();
  new ResizeObserver(draw).observe(plot);

  // the table under every plot: identity never rests on colour alone
  const cols = [...(cfg.stacks || []), ...(cfg.lines || [])];
  const det = document.createElement('details');
  det.innerHTML = `<summary>Table</summary><table><thead><tr><th>Month</th>` +
    cols.map(c => `<th>${c.label}</th>`).join('') + `</tr></thead><tbody>` +
    cfg.data.map(d => `<tr><td class="n">M${d.m}</td>` +
      cols.map(c => `<td class="n">${fmt(d[c.key] || 0)}</td>`).join('') + `</tr>`).join('') +
    `</tbody></table>`;
  host.appendChild(det);
  return draw;
}

// ---------------------------------------------------------------- controls
const P = {
  regime: 'loose', site: 'us', orderK: 3, orderFrom: 0, orderUntil: 11, powerMW: 5,
  launch: 13, exportOn: false, exportStart: 8, reserveK: 0, spotK: 0, growth: 0.03,
  regimePath: null,
};

const CONTROLS = [
  { k: 'regime', label: 'Supply regime', seg: [['loose', 'Loose'], ['tight', 'Tight']],
    read: () => P.regime === 'loose' ? 'allocation ~6 kH/mo' : 'allocation ~2 kH/mo' },
  { k: 'site', label: 'Site', seg: [['us', 'US'], ['eu', 'EU'], ['ap', 'AP']],
    read: () => `${lead(P.site)} mo to power` },
  { k: 'orderK', label: 'Order', min: 0, max: 8, step: 0.5, unit: 'k/mo',
    read: () => `${fmt(P.orderK)}k GPUs a month` },
  { k: 'orderUntil', label: 'Order through', min: 0, max: 23, step: 1, unit: '',
    read: () => `M0 – M${P.orderUntil}` },
  { k: 'powerMW', label: 'Power signed', min: 0, max: 14, step: 0.5, unit: 'MW/mo',
    read: () => `${fmt(P.powerMW)} MW a month` },
  { k: 'launch', label: 'Gen N launch', min: 11, max: 18, step: 1, unit: '',
    read: () => `month ${P.launch}` },
  { k: 'reserveK', label: 'Reserve', min: 0, max: 4, step: 0.5, unit: 'kH/mo',
    read: () => `${fmt(P.reserveK)} kH a month, 12-mo term` },
  { k: 'spotK', label: 'Spot standing', min: 0, max: 6, step: 0.5, unit: 'kH',
    read: () => `${fmt(P.spotK)} kH requested` },
  { k: 'growth', label: 'Inference growth', seg: [[0.03, '3%'], [0.07, '7%']],
    read: () => `demand ×${Math.exp(P.growth * 23).toFixed(1)} by M23` },
  { k: 'exportOn', label: 'Export controls', seg: [[false, 'Off'], [true, 'On M8']],
    read: () => P.exportOn ? 'gen H allocation ×0.4 for 6 mo' : 'allocation unrestricted' },
];

function buildControls() {
  const host = document.getElementById('controls');
  host.innerHTML = '';
  for (const c of CONTROLS) {
    const d = document.createElement('div');
    d.className = 'ctl';
    if (c.seg) {
      d.innerHTML = `<div class="k"><span>${c.label}</span><u>${c.read()}</u></div>
        <div class="seg">${c.seg.map(([v, t]) =>
          `<button type="button" data-v="${v}" aria-pressed="${String(P[c.k]) === String(v)}">${t}</button>`).join('')}</div>`;
      d.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        const raw = b.dataset.v;
        P[c.k] = raw === 'true' ? true : raw === 'false' ? false : isNaN(+raw) ? raw : +raw;
        buildControls(); run();
      }));
    } else {
      d.innerHTML = `<div class="k"><span>${c.label}</span><u>${c.read()}</u></div>
        <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${P[c.k]}"
               aria-label="${c.label}">`;
      const inp = d.querySelector('input');
      inp.addEventListener('input', () => {
        P[c.k] = +inp.value;
        d.querySelector('u').textContent = c.read();
        run();
      });
    }
    host.appendChild(d);
  }
}

// ---------------------------------------------------------------- the live model
const S1 = () => CSS('--s1'), S3 = () => CSS('--s3'), S5 = () => CSS('--s5');

function run() {
  const r = sim(P);
  const rows = r.rows;

  const tiles = [
    { k: 'Capacity at M23', v: fmt(rows[T - 1].capacity, 1), s: 'kH live' },
    { k: 'Peak stranded', v: fmt(Math.max(...rows.map(d => d.stranded)), 1),
      s: 'kH delivered, dark' },
    { k: 'First new kH', v: r.firstNew === null ? '—' : 'M' + r.firstNew, s: 'above the start fleet' },
    ...r.windows.map((w, i) => ({
      k: `Run ${i + 1} · M${w.a}–${w.d}`, v: fmt(w.got, 0) + ' / ' + w.target,
      s: w.hit ? 'met' : fmt(w.target - w.got, 0) + ' kH-mo short', cls: w.hit ? 'hit' : 'miss',
    })),
    { k: 'GPU outlay', v: '$' + fmt(r.capex, 0) + 'M', s: 'at order' },
    { k: 'Power bill', v: '$' + fmt(r.powerBill, 0) + 'M', s: 'over 24 months' },
  ];
  document.getElementById('tiles').innerHTML = tiles.map(t =>
    `<div class="tile"><div class="k">${t.k}</div><div class="v ${t.cls || ''}">${t.v}</div>
     <div class="s">${t.s}</div></div>`).join('');

  const marks = [{ m: P.launch, label: 'gen N' }, { m: 8, label: 'run 2' }, { m: 16, label: 'run 3' }];

  chart(document.getElementById('c-stack'), {
    id: 'stack', data: rows, unit: 'kH', marks,
    title: 'Capacity formation',
    sub: 'What is live each month, by where it comes from — against the inference demand that must be served locally before any of it counts as training.',
    stacks: [{ key: 'live', label: 'Owned, powered', fill: S1() },
             { key: 'reserved', label: 'Reserved', fill: S3() },
             { key: 'spot', label: 'Spot', fill: S5() }],
    lines: [{ key: 'demand', label: 'Inference demand', stroke: CSS('--ink-2'), dash: '5 3', tag: 'demand' }],
  });

  chart(document.getElementById('c-gate'), {
    id: 'gate', data: rows, unit: 'kH', marks,
    title: 'The power gate',
    sub: 'The fleet you own against the part of it the megawatts can carry. The hatched gap is silicon you have paid for and cannot switch on.',
    band: { hi: 'fleet', lo: 'live', label: 'Stranded', fill: S5(), gapKey: 'stranded' },
    lines: [{ key: 'fleet', label: 'Fleet owned', stroke: S3(), dash: '4 3', tag: 'owned' },
            { key: 'live', label: 'Powered', stroke: S1(), tag: 'live' }],
  });

  chart(document.getElementById('c-queue'), {
    id: 'queue', data: rows, unit: 'kH', marks, height: 180,
    title: 'The order book',
    sub: 'Compute ordered and paid for but still in the vendor queue, waiting on the monthly allocation.',
    stacks: [{ key: 'queued', label: 'In the queue', fill: S3() }],
    lines: [{ key: 'stranded', label: 'Delivered, unpowered', stroke: S1(), tag: 'dark' }],
  });

  document.getElementById('assume').innerHTML =
    `<b>Assumptions.</b> Allocation noise is held at its mean (the real draw is ×0.7–1.3 each month) and
     power energises at the midpoint of its range (<code>${P.site}</code>: ${POWER_LEAD[P.site][0]}–${POWER_LEAD[P.site][1]} months, here ${lead(P.site)}).
     Demand follows its trend with no noise and no mid-game switch. Orders, power and reservations all go to
     one site; the other two run on their starting fleet. Brokers, options, moves and resales are left out —
     they change the latency, not the shape.`;
}

// ---------------------------------------------------------------- measured
async function loadRuns() {
  const index = await (await fetch('./data/index.json')).json();
  const sel = document.getElementById('run');
  sel.innerHTML = index.map(r => `<option value="${r.key}">${r.title} — ${r.subtitle}</option>`).join('');
  sel.addEventListener('change', () => showRun(sel.value));
  showRun(index[0].key);
}

async function showRun(key) {
  const d = await (await fetch(`./data/${key}.json`)).json();
  const rows = d.frames.map(f => {
    let fleet = 0;
    for (const s of SITES) fleet += (f.owned[s]?.H || 0) * COMPUTE.H + (f.owned[s]?.N || 0) * COMPUTE.N;
    const live = SITES.reduce((a, s) => a + (f.sites[s]?.own_compute || 0), 0);
    return {
      m: f.month, regime: f.regime, live,
      reserved: SITES.reduce((a, s) => a + (f.sites[s]?.reserved || 0), 0),
      spot: SITES.reduce((a, s) => a + (f.sites[s]?.spot_filled || 0), 0),
      demand: f.demand, capacity: f.capacity, fleet, stranded: Math.max(0, fleet - live),
      queued: (f.queue || []).reduce((a, o) => a + (o.left ?? o.qty) * COMPUTE[o.gen], 0),
    };
  });
  const marks = [{ m: d.truth?.launch ?? 13, label: 'gen N' }];

  chart(document.getElementById('m-stack'), {
    id: 'mstack', data: rows, unit: 'kH', marks,
    title: `Capacity formation — ${d.title}`,
    sub: `${d.subtitle}. Read from the ledger, not the model: owned-and-powered, reserved and spot, against served demand.`,
    stacks: [{ key: 'live', label: 'Owned, powered', fill: S1() },
             { key: 'reserved', label: 'Reserved', fill: S3() },
             { key: 'spot', label: 'Spot', fill: S5() }],
    lines: [{ key: 'demand', label: 'Inference demand', stroke: CSS('--ink-2'), dash: '5 3', tag: 'demand' }],
  });

  chart(document.getElementById('m-gate'), {
    id: 'mgate', data: rows, unit: 'kH', marks,
    title: 'The power gate, as played',
    sub: 'Where this game left silicon dark — the gap between the fleet on the books and the fleet under power.',
    band: { hi: 'fleet', lo: 'live', label: 'Stranded', fill: S5(), gapKey: 'stranded' },
    lines: [{ key: 'fleet', label: 'Fleet owned', stroke: S3(), dash: '4 3', tag: 'owned' },
            { key: 'live', label: 'Powered', stroke: S1(), tag: 'live' }],
  });
}

// ---------------------------------------------------------------- go
buildControls();
run();
loadRuns().catch(e => console.warn('run data unavailable', e));
