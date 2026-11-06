// "Your progress" panel: rank, finest difference / closest round, a small per-day history chart,
// and the tucked-away reset control. Used by every exercise.

import { el, setChildren, centsText, fmtCents } from './dom.js';
import { icon } from './icons.js';
import { resetControl } from './exercise.js';

const NS = 'http://www.w3.org/2000/svg';
const MAX_DAYS = 30;

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}

/** 'YYYY-MM-DD' -> "20 Oct" in the reader's own language. */
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch {
    return `${m[3]}.${m[2]}.`;
  }
}

/** Clean axis maximum and tick step for a value range starting at 0. */
function niceScale(max) {
  const raw = Math.max(1, max) / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || 10 * pow;
  return { step, top: Math.ceil(Math.max(1, max) / step) * step };
}

/**
 * Single-series line chart (one value per day). No legend: the caption names the series.
 * points: [{ date, value, note? }] in time order. Returns an element.
 */
function historyChart(points, { caption, unit = 'cents' }) {
  const W = 560;
  const H = 170;
  const padL = 34;
  const padR = 46; // room for the end label
  const padT = 12;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const values = points.map((p) => p.value);
  const { step, top } = niceScale(Math.max(...values));
  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = (v) => padT + plotH - (v / top) * plotH;

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'history-chart', role: 'img', 'aria-label': caption });

  // Recessive hairline grid + clean y ticks.
  for (let v = 0; v <= top + 1e-9; v += step) {
    chart.append(
      svg('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: 'chart-grid' }),
      Object.assign(svg('text', { x: padL - 6, y: y(v) + 4, class: 'chart-tick', 'text-anchor': 'end' }), { textContent: fmtCents(v) }),
    );
  }
  // First / last date labels.
  const dateLabel = (i, anchor) => Object.assign(
    svg('text', { x: x(i), y: H - 6, class: 'chart-tick', 'text-anchor': anchor }),
    { textContent: shortDate(points[i].date) },
  );
  chart.append(dateLabel(0, points.length === 1 ? 'middle' : 'start'));
  if (points.length > 1) chart.append(dateLabel(points.length - 1, 'end'));

  if (points.length > 1) {
    const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const area = `${x(0).toFixed(1)},${y(0).toFixed(1)} ${line} ${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)}`;
    chart.append(
      svg('polygon', { points: area, class: 'chart-area' }),
      svg('polyline', { points: line, class: 'chart-line' }),
    );
  }

  // End dot (with a surface ring) + direct label of the latest value.
  const li = points.length - 1;
  chart.append(
    svg('circle', { cx: x(li), cy: y(points[li].value), r: 4, class: 'chart-dot' }),
    Object.assign(svg('text', { x: x(li) + 9, y: y(points[li].value) + 4, class: 'chart-end-label' }),
      { textContent: `${fmtCents(points[li].value)}` }),
  );

  // Hover layer: one wide hit column per day, a crosshair and a tooltip.
  const wrap = el('div', { class: 'chart-wrap' });
  const tip = el('div', { class: 'chart-tip', role: 'status' });
  tip.hidden = true;
  const cross = svg('line', { y1: padT, y2: padT + plotH, class: 'chart-cross', visibility: 'hidden' });
  const focusDot = svg('circle', { r: 5, class: 'chart-dot chart-focus', visibility: 'hidden' });
  chart.append(cross, focusDot);
  const colW = points.length === 1 ? plotW : plotW / (points.length - 1);
  points.forEach((p, i) => {
    const hit = svg('rect', {
      x: x(i) - colW / 2, y: padT, width: colW, height: plotH, class: 'chart-hit',
    });
    const show = () => {
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      focusDot.setAttribute('cx', x(i)); focusDot.setAttribute('cy', y(p.value));
      focusDot.setAttribute('visibility', 'visible');
      setChildren(tip,
        el('strong', {}, shortDate(p.date)), ' ',
        `${fmtCents(p.value)} ${unit}`,
        p.note ? el('span', { class: 'chart-tip-note' }, p.note) : null);
      tip.hidden = false;
      const pct = (x(i) / W) * 100;
      tip.style.left = `${Math.min(80, Math.max(20, pct))}%`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    chart.append(hit);
  });
  chart.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    focusDot.setAttribute('visibility', 'hidden');
  });

  // Table view (for screen readers and exact numbers).
  const table = el('table', { class: 'cents-table history-table' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Day'), el('th', { scope: 'col' }, `Result (${unit})`), el('th', { scope: 'col' }, 'Details'))),
    el('tbody', {}, points.slice().reverse().map((p) => el('tr', {},
      el('td', {}, shortDate(p.date)), el('td', {}, fmtCents(p.value)), el('td', {}, p.note || '')))),
  );

  wrap.append(chart, tip);
  return el('figure', { class: 'history' },
    el('figcaption', { class: 'history-caption' }, caption),
    wrap,
    el('details', { class: 'license-text' }, el('summary', {}, 'Show as table'), el('div', { class: 'table-wrap' }, table)),
  );
}

const BASIS_TEXT = {
  threshold: (c) => `Based on the smallest difference you hear reliably: ${c}.`,
  level: (c) => `Based on the difference you are working at: ${c}.`,
  tuneError: (c) => `Based on your recent rounds: ${c} off on average.`,
};

function rankBlock(rank, noData) {
  if (!rank || !rank.name) return null;
  const tiers = Array.isArray(rank.tiers) ? rank.tiers : [];
  const untried = noData || rank.basis === null;
  let next;
  if (untried) next = 'Try a few rounds to get a rank.';
  else if (rank.nextName && Number.isFinite(rank.nextAtCents)) next = `Next rank: ${rank.nextName}, at ${centsText(rank.nextAtCents)} or less.`;
  else if (!rank.nextName) next = 'You have reached the top rank. Wonderful ears!';
  const basis = !untried && BASIS_TEXT[rank.basis] && Number.isFinite(rank.measureCents)
    ? BASIS_TEXT[rank.basis](centsText(rank.measureCents))
    : null;
  return el('div', { class: 'rank' },
    el('div', { class: 'rank-head' },
      el('span', { class: 'rank-label' }, 'Your rank'),
      untried ? el('span', { class: 'rank-name', 'aria-label': 'no rank yet' }, '—') : el('span', { class: 'rank-name' }, rank.name),
    ),
    !untried && rank.description ? el('p', { class: 'rank-desc' }, rank.description) : null,
    next ? el('p', { class: 'rank-next' }, next) : null,
    basis ? el('p', { class: 'rank-basis' }, basis) : null,
    tiers.length ? el('ol', { class: 'rank-ladder', 'aria-label': 'All ranks, from first to last' },
      tiers.map((t, i) => {
        const current = !untried && i === rank.index;
        return el('li', {
          class: current ? 'is-current' : !untried && i < rank.index ? 'is-done' : '',
          'aria-current': current ? 'step' : null,
          title: Number.isFinite(t.maxCents) ? `${t.name}: ${centsText(t.maxCents)} or less` : `${t.name}: where everyone starts`,
        }, t.name);
      })) : null,
  );
}

const INSIGHT_GROUPS = [
  ['byRegister', 'By range (high or low notes)'],
  ['byTone', 'By note in the chord'],
  ['byDirection', 'By direction'],
  ['byChord', 'By chord'],
  ['byTask', 'By task'],
];

/** Direction keys from the logic -> words for singers. */
const DIRECTION_WORDS = { sharp: 'Too high', flat: 'Too low', same: 'Same', none: 'All in tune' };

/** "Strengths and things to work on": small accuracy bars per group + the logic's sentences. */
function insightsBlock(ins) {
  const head = el('h3', { class: 'insights-title' }, 'Strengths and things to work on');
  if (!ins) return null;
  const count = (g) => (Number.isFinite(g.answered) ? g.answered : Number.isFinite(g.attempts) ? g.attempts : 0);
  const groups = INSIGHT_GROUPS
    .map(([key, title]) => [title, Array.isArray(ins[key]) ? ins[key].filter((g) => g && count(g) > 0) : []])
    .filter(([, rows]) => rows.length);
  const strengths = Array.isArray(ins.strengths) ? ins.strengths : [];
  const blind = Array.isArray(ins.toWorkOn) ? ins.toWorkOn : Array.isArray(ins.blindSpots) ? ins.blindSpots : [];
  if (!groups.length && !strengths.length && !blind.length) {
    return el('div', { class: 'insights' }, head,
      el('p', { class: 'muted small' }, "After a few more rounds, you'll see what you hear well and what to work on."));
  }
  return el('div', { class: 'insights' }, head,
    strengths.length || blind.length ? el('ul', { class: 'insight-notes' },
      strengths.map((s) => el('li', { class: 'is-strength' }, icon('circle-check', { size: 16 }), el('span', {}, s))),
      blind.map((s) => el('li', { class: 'is-blind' }, icon('circle-arrow-right', { size: 16 }), el('span', {}, s))),
    ) : null,
    el('div', { class: 'insight-groups' },
      groups.map(([title, rows]) => {
        // Three shapes: accuracy (listening), average error in cents (tuning), or plain counts.
        const isError = rows.some((g) => Number.isFinite(g.avgAbsError));
        const isAccuracy = !isError && rows.some((g) => Number.isFinite(g.accuracy) || Number.isFinite(g.correct));
        const maxError = isError ? Math.max(1, ...rows.map((g) => g.avgAbsError || 0)) : 1;
        const maxCount = Math.max(1, ...rows.map(count));
        return el('div', { class: 'insight-group' },
          el('p', { class: 'insight-group-title' }, title,
            isError ? el('span', { class: 'insight-hint' }, ' · cents off on average — shorter is better') : null),
          el('ul', { class: 'acc-bars' }, rows.map((g) => {
            const label = DIRECTION_WORDS[g.label] || g.label;
            const n = count(g);
            let width;
            let value;
            let tip;
            if (isError) {
              const e = Number.isFinite(g.avgAbsError) ? g.avgAbsError : 0;
              width = Math.round((e / maxError) * 100);
              value = [centsText(e), el('span', { class: 'acc-count' }, ` · ${n} ${n === 1 ? 'round' : 'rounds'}`)];
              tip = `${label}: ${centsText(e)} off on average (${n} ${n === 1 ? 'round' : 'rounds'})`;
            } else if (isAccuracy) {
              const acc = Number.isFinite(g.accuracy) ? g.accuracy : n ? g.correct / n : 0;
              width = Math.round(Math.max(0, Math.min(1, acc)) * 100);
              value = [`${width}%`, el('span', { class: 'acc-count' }, ` ${g.correct}/${n}`)];
              tip = `${label}: ${g.correct} of ${n} right`;
            } else {
              width = Math.round((n / maxCount) * 100);
              value = [`${n}×`];
              tip = `${label}: ${n} times`;
            }
            return el('li', { class: `acc-row${isError ? ' is-error' : ''}`, title: tip },
              el('span', { class: 'acc-label' }, label),
              el('span', { class: 'acc-track', 'aria-hidden': 'true' }, el('span', { class: 'acc-fill', style: `width:${width}%` })),
              el('span', { class: 'acc-value' }, value),
            );
          })),
        );
      }),
    ),
  );
}

/**
 * read() -> { rank, noData?, best, bestLabel?, bestNote?, points: [{date, value, note?}], caption, unit?, empty,
 *             insights? (getInsights result, or null to hide the section) }
 * Returns { element, update() }.
 */
export function createProgressPanel({ read, what = 'this exercise', onReset, title = 'Your progress', open = false }) {
  const summaryRank = el('span', { class: 'progress-summary-rank' });
  const body = el('div', { class: 'progress-body' });
  const element = el('details', { class: 'help-box progress-panel', open: open || null },
    el('summary', {},
      icon('trending-up', { size: 18 }),
      el('span', {}, title),
      summaryRank,
      icon('chevron-down', { size: 18, class: 'help-chevron' }),
    ),
    body,
  );
  // No onReset -> no reset control (e.g. on the stats page).
  const reset = typeof onReset === 'function' ? resetControl({
    what,
    onConfirm: () => {
      try { onReset(); } catch (err) { console.error(err); }
      update();
    },
  }) : null;

  function update() {
    let data = null;
    try { data = read(); } catch (err) { console.error(err); }
    data = data || {};
    const untried = data.noData || !data.rank || data.rank.basis === null;
    summaryRank.textContent = !untried && data.rank.name ? data.rank.name : '';
    const points = (data.points || [])
      .filter((p) => p && Number.isFinite(p.value))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-MAX_DAYS);
    setChildren(body,
      el('div', { class: 'progress-grid' },
        rankBlock(data.rank, data.noData),
        el('div', { class: 'best' },
          el('span', { class: 'rank-label' }, data.bestLabel || 'Finest difference'),
          el('span', { class: 'best-value' }, data.best != null && Number.isFinite(data.best) ? centsText(data.best) : '–'),
          data.bestNote ? el('span', { class: 'best-note' }, data.bestNote) : null,
        ),
      ),
      data.extra || null,
      points.length
        ? historyChart(points, { caption: data.caption || 'Per day', unit: data.unit || 'cents' })
        : el('p', { class: 'muted small' }, data.empty || 'Your daily results will appear here.'),
      data.insights !== undefined ? insightsBlock(data.insights) : null,
      reset,
    );
  }

  update();
  return { element, update };
}
