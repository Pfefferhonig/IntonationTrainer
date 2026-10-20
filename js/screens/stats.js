// "Your stats" (#/stats): a shareable overview card of all progress, a PNG download of it,
// details per exercise, and a tidy backup (export / import as JSON).

// Namespace imports: getOverview / exportAllProgress / importAllProgress are feature-checked.
import * as progress from '../exercise/progress.js';
import * as tuneIt from '../exercise/tune-it.js';
import { el, setChildren, centsText } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { segmented } from '../ui/components.js';
import { chapterProgressPanel, safeRank, safeInsights } from '../ui/chapter-progress.js';
import { createProgressPanel } from '../ui/progress-panel.js';
import { loadSingModules } from '../ui/sing-common.js';
import { shortTaskLabel } from '../ui/task-labels.js';

const APP_NAME = 'Choir Intonation Trainer';

const SHORT_LABEL = {
  'higher-or-lower': 'Higher / lower',
  'odd-one-out': 'Odd one out',
  'odd-or-in-tune': 'Odd one out · all in tune',
  'tune-it': 'Lock it in',
  'sing-match': 'Echo',
  sing: 'Join the chord',
};
/** Chapters measured as an average error in cents (lower = better), not accuracy. */
const ERROR_KEYS = ['tune-it', 'sing', 'sing-match'];
const ROUTE_OF = {
  'higher-or-lower': '#/higher-or-lower',
  'odd-one-out': '#/odd-one-out',
  'odd-or-in-tune': '#/odd-one-out',
  'tune-it': '#/tune',
};

// Explicit colours for the downloaded image (mirrors the app's light / dark palettes).
const PALETTES = {
  light: {
    bg: '#f5f4ef', card: '#ffffff', soft: '#efede6', text: '#1e2330', muted: '#545b69', border: '#dcd8cd',
    accent: '#2c5f8d', accentText: '#ffffff', accentSoft: '#e2ebf4', ok: '#2b7a57', warm: '#8b5a2b',
  },
  dark: {
    bg: '#14171c', card: '#1c2027', soft: '#252a33', text: '#e8e6e1', muted: '#a4a9b4', border: '#323843',
    accent: '#7fb0e0', accentText: '#0e1824', accentSoft: '#1e2e40', ok: '#6fcf9f', warm: '#e2aa76',
  },
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function localDate(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Fallback when progress.getOverview is missing: compose from the older functions. */
function composeOverview() {
  const keys = ['higher-or-lower', 'odd-one-out', 'odd-or-in-tune'];
  const dates = new Set();
  const chapters = [];
  const rankOf = (key, stats, opts) => {
    try { return typeof progress.getRank === 'function' ? progress.getRank(key, stats, opts) : null; } catch { return null; }
  };
  const summary = (r) => (r ? { name: r.name, index: r.index, tierCount: r.tiers.length, basis: r.basis } : { name: '', index: 0, tierCount: 6, basis: null });
  for (const key of keys) {
    let s;
    try { s = progress.getStats(key); } catch { continue; }
    s.history.filter((h) => h.answered > 0).forEach((h) => dates.add(h.date));
    chapters.push({ key, label: SHORT_LABEL[key], rank: summary(rankOf(key, s)), bestCents: s.bestThresholdCents, answered: s.answered });
  }
  const t = tuneIt.getTuneStats();
  t.history.filter((h) => h.attempts > 0).forEach((h) => dates.add(h.date));
  const days = t.history.map((h) => h.avgAbsError).filter(Number.isFinite);
  chapters.push({
    key: 'tune-it',
    label: SHORT_LABEL['tune-it'],
    rank: summary(rankOf('tune-it', t)),
    bestCents: days.length ? Math.min(...days) : null,
    answered: t.attempts,
    tasks: tuneIt.TUNE_TASKS.map((x) => ({
      key: x.key, label: x.label, group: x.group || (x.fixed.length === 1 ? 'interval' : 'chord'),
      attempts: t.perTask[x.key] ? t.perTask[x.key].attempts : 0,
      rank: summary(rankOf('tune-it', t, { taskKey: x.key })),
    })),
  });
  const sorted = [...dates].sort();
  let streak = 0;
  const d = new Date();
  if (!dates.has(localDate(d))) d.setDate(d.getDate() - 1);
  while (dates.has(localDate(d))) { streak += 1; d.setDate(d.getDate() - 1); }
  return {
    date: localDate(new Date()),
    chapters,
    totals: { answered: chapters.reduce((a, c) => a + (c.answered || 0), 0), daysPractised: sorted.length, currentDailyStreak: streak },
    strengths: [],
    blindSpots: [],
  };
}

function loadOverview() {
  if (typeof progress.getOverview === 'function') {
    try { return progress.getOverview(); } catch (err) { console.error(err); }
  }
  return composeOverview();
}

function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  try {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

/** Everything the card (HTML and PNG) shows, in one plain object. */
function cardData(ov) {
  const chapters = ov.chapters.map((c) => {
    const ranked = !!(c.rank && c.rank.basis);
    return {
      key: c.key,
      label: SHORT_LABEL[c.key] || c.label,
      started: (c.answered || 0) > 0,
      rankName: ranked ? c.rank.name : null,
      step: ranked ? c.rank.index + 1 : 0,
      of: (c.rank && c.rank.tierCount) || 6,
      best: Number.isFinite(c.bestCents) ? c.bestCents : null,
      bestLabel: ERROR_KEYS.includes(c.key) ? 'best day' : 'best',
      answered: c.answered || 0,
      unit: c.key === 'tune-it' ? 'tries' : ERROR_KEYS.includes(c.key) ? 'takes' : 'answers',
      countText: (() => {
        const n = c.answered || 0;
        const [one, many] = c.key === 'tune-it' ? ['try', 'tries'] : ERROR_KEYS.includes(c.key) ? ['take', 'takes'] : ['answer', 'answers'];
        return `${n} ${n === 1 ? one : many}`;
      })(),
    };
  });
  const tune = ov.chapters.find((c) => c.key === 'tune-it');
  // Only the tasks that have been tried (18 tasks would crowd the card); ranked ones first.
  const tasks = tune && Array.isArray(tune.tasks) ? tune.tasks.map((t) => ({
    key: t.key,
    label: shortTaskLabel(t),
    group: t.group,
    rankName: t.rank && t.rank.basis ? t.rank.name : null,
    tried: (t.attempts || 0) > 0,
  })).filter((t) => t.tried).sort((a, b) => (b.rankName ? 1 : 0) - (a.rankName ? 1 : 0)) : [];
  const days = ov.totals.daysPractised || 0;
  const strength = ov.strengths && ov.strengths[0] ? ov.strengths[0].text
    : days > 0 ? `Showing up to practise: ${days} ${days === 1 ? 'day' : 'days'} so far.` : '';
  const working = ov.blindSpots && ov.blindSpots[0] ? ov.blindSpots[0].text
    : 'More insights appear after a few more rounds.';
  return {
    date: longDate(ov.date),
    chapters,
    totals: ov.totals,
    tasks,
    strength,
    working,
  };
}

// ---------------------------------------------------------------------------
// The card as HTML
// ---------------------------------------------------------------------------

function tierBar(step, of) {
  return el('span', { class: 'tier-bar', 'aria-hidden': 'true' },
    Array.from({ length: of }, (_, i) => el('span', { class: i < step ? 'is-on' : '' })));
}

function shareCardHtml(d) {
  return el('section', { class: 'share-card', 'aria-label': 'Your stats summary' },
    el('header', { class: 'share-head' },
      el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('audio-waveform', { size: 18 })),
      el('span', { class: 'share-app' }, APP_NAME),
      el('span', { class: 'share-date' }, d.date),
    ),
    el('div', { class: 'share-chapters' }, d.chapters.map((c) => el('div', { class: `share-tile${c.started ? '' : ' is-new'}` },
      el('span', { class: 'share-tile-label' }, c.label),
      c.rankName
        ? [el('span', { class: 'share-rank' }, c.rankName),
          el('span', { class: 'share-tier' }, tierBar(c.step, c.of), `${c.step} of ${c.of}`)]
        : el('span', { class: 'share-rank is-none' }, c.started ? 'Rank soon' : 'Not started'),
      el('span', { class: 'share-best' },
        c.best != null ? [el('strong', {}, centsText(c.best)), ` ${c.bestLabel}`] : ' '),
      el('span', { class: 'share-count' }, c.started ? c.countText :' '),
    ))),
    el('div', { class: 'share-totals' },
      el('div', {}, el('strong', {}, String(d.totals.answered || 0)), el('span', {}, 'answers & tries')),
      el('div', {}, el('strong', {}, String(d.totals.daysPractised || 0)), el('span', {}, 'days practised')),
      el('div', {}, el('strong', {}, String(d.totals.currentDailyStreak || 0)), el('span', {}, 'day streak')),
    ),
    d.tasks.some((t) => t.tried) ? el('div', { class: 'share-tasks' },
      el('p', { class: 'share-sub' }, 'Lock it in — your tasks'),
      el('ul', {}, d.tasks.map((t) => el('li', { class: t.rankName ? '' : 'is-none' },
        el('span', {}, t.label), el('strong', {}, t.rankName || '–')))),
    ) : null,
    el('ul', { class: 'share-lines' },
      d.strength ? el('li', {}, icon('circle-check', { size: 16 }), el('span', {}, el('strong', {}, 'Strength: '), d.strength)) : null,
      d.working ? el('li', {}, icon('trending-up', { size: 16 }), el('span', {}, el('strong', {}, 'Working on: '), d.working)) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// The card as SVG -> PNG (no libraries; system fonts; explicit colours)
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Greedy word wrap by an approximate character width. */
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line ? `${line} ${w}` : w).length > maxChars && line) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

function shareCardSvg(d, c) {
  const W = 800;
  const pad = 32;
  const font = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  const parts = [];
  let y = pad;
  const text = (x, yy, s, { size = 14, weight = 400, fill = c.text, anchor = 'start' } = {}) =>
    parts.push(`<text x="${x}" y="${yy}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`);
  const rect = (x, yy, w, h, fill, { r = 10, stroke = null } = {}) =>
    parts.push(`<rect x="${x}" y="${yy}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`);

  // Header
  rect(pad, y, 30, 30, c.accent, { r: 8 });
  parts.push(`<path transform="translate(${pad + 5} ${y + 5}) scale(0.83)" d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2" fill="none" stroke="${c.accentText}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
  text(pad + 42, y + 21, APP_NAME, { size: 20, weight: 700 });
  text(W - pad, y + 21, d.date, { size: 14, fill: c.muted, anchor: 'end' });
  y += 52;

  // Chapter tiles (up to 3 per row when there are many)
  const n = d.chapters.length;
  const cols = n > 4 ? 3 : n;
  const gap = 12;
  const tw = (W - 2 * pad - gap * (cols - 1)) / cols;
  const th = 128;
  const y0 = y;
  d.chapters.forEach((ch, i) => {
    const x = pad + (i % cols) * (tw + gap);
    y = y0 + Math.floor(i / cols) * (th + gap);
    rect(x, y, tw, th, c.soft);
    wrap(ch.label, Math.floor(tw / 7.2)).slice(0, 2).forEach((ln, k) => text(x + 12, y + 22 + k * 15, ln, { size: 12, fill: c.muted, weight: 600 }));
    if (ch.rankName) {
      text(x + 12, y + 62, ch.rankName, { size: 19, weight: 700, fill: c.accent });
      const segW = Math.min(16, (tw - 70) / ch.of - 3);
      for (let s = 0; s < ch.of; s += 1) rect(x + 12 + s * (segW + 3), y + 72, segW, 6, s < ch.step ? c.accent : c.border, { r: 3 });
      text(x + 12 + ch.of * (segW + 3) + 4, y + 79, `${ch.step} of ${ch.of}`, { size: 11, fill: c.muted });
    } else {
      text(x + 12, y + 62, ch.started ? 'Rank soon' : 'Not started', { size: 16, weight: 600, fill: c.muted });
    }
    if (ch.best != null) text(x + 12, y + 102, `${centsText(ch.best)} ${ch.bestLabel}`, { size: 13, weight: 600 });
    if (ch.started) text(x + 12, y + 118, ch.countText, { size: 11, fill: c.muted });
  });
  y = y0 + Math.ceil(n / cols) * (th + gap) + 4;

  // Totals
  const totals = [
    [d.totals.answered || 0, 'answers & tries'],
    [d.totals.daysPractised || 0, 'days practised'],
    [d.totals.currentDailyStreak || 0, 'day streak'],
  ];
  const cw = (W - 2 * pad) / 3;
  totals.forEach(([v, label], i) => {
    text(pad + i * cw, y + 26, String(v), { size: 26, weight: 700 });
    text(pad + i * cw, y + 46, label, { size: 12, fill: c.muted });
  });
  y += 62;

  // Tune it yourself per-task grid
  if (d.tasks.some((t) => t.tried)) {
    text(pad, y + 14, 'Lock it in — your tasks', { size: 12, weight: 600, fill: c.muted });
    y += 24;
    const cols = 4;
    const cellW = (W - 2 * pad - (cols - 1) * 8) / cols;
    d.tasks.forEach((t, i) => {
      const cx = pad + (i % cols) * (cellW + 8);
      const cy = y + Math.floor(i / cols) * 30;
      rect(cx, cy, cellW, 24, c.card, { r: 12, stroke: c.border });
      text(cx + 10, cy + 16, t.label, { size: 11, fill: c.muted });
      text(cx + cellW - 10, cy + 16, t.rankName || '–', { size: 11, weight: 700, fill: t.rankName ? c.accent : c.muted, anchor: 'end' });
    });
    y += Math.ceil(d.tasks.length / cols) * 30 + 6;
  }

  // Strength / working on
  const lineMax = 96;
  for (const [label, s, col] of [['Strength: ', d.strength, c.ok], ['Working on: ', d.working, c.warm]]) {
    if (!s) continue;
    const lines = wrap(label + s, lineMax);
    parts.push(`<circle cx="${pad + 5}" cy="${y + 10}" r="4" fill="${col}"/>`);
    lines.forEach((ln, k) => text(pad + 16, y + 14 + k * 18, ln, { size: 13, weight: k === 0 ? 500 : 400 }));
    y += lines.length * 18 + 6;
  }
  y += 10;
  text(W - pad, y + 4, 'Practised with the Choir Intonation Trainer', { size: 11, fill: c.muted, anchor: 'end' });
  const H = y + pad;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="${c.bg}"/>`
    + `<rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="18" fill="${c.card}" stroke="${c.border}"/>`
    + parts.join('') + '</svg>';
  return { svg, width: W, height: H };
}

/** Render an SVG string to a PNG data URL (2x for sharpness). */
function svgToPng({ svg, width, height }, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The image could not be drawn.')); };
    img.src = url;
  });
}

function downloadHref(href, filename) {
  const a = el('a', { href, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// Details per exercise
// ---------------------------------------------------------------------------

/** Error-based panel (Tune it yourself, the singing tabs): average error per day, ranks, insights. */
function errorPanel(key, title, getStatsFn) {
  return createProgressPanel({
    title,
    read: () => {
      const stats = getStatsFn();
      const bests = Object.values(stats.perTask || {}).map((t) => t.bestAbsError).filter(Number.isFinite);
      return {
        rank: safeRank(key, stats),
        noData: !(stats.attempts > 0),
        best: bests.length ? Math.min(...bests) : null,
        bestLabel: 'Closest tuning',
        bestNote: bests.length ? 'Your most accurate try, in any task.' : 'Appears after your first try.',
        caption: 'Average distance from in tune, per day (lower = better)',
        unit: 'cents',
        points: (stats.history || [])
          .filter((h) => h && h.avgAbsError != null)
          .map((h) => ({ date: h.date, value: Number(h.avgAbsError), note: `${h.attempts} ${h.attempts === 1 ? 'try' : 'tries'}` })),
        empty: 'Play a few rounds to see your progress here.',
        insights: safeInsights(key),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default {
  id: 'stats',
  title: 'Your stats',

  render(container) {
    let imageTheme = (() => {
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
    })();

    function build() {
      const ov = loadOverview();
      const data = cardData(ov);
      const hasData = (ov.totals.answered || 0) > 0;

      // ---- Image download (main action)
      const imageStatus = el('p', { class: 'small muted', role: 'status' });
      const themeSeg = segmented({
        name: 'stats-theme',
        legend: 'Image colours',
        compact: true,
        options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
        value: imageTheme,
        onChange: (v) => { imageTheme = v; },
      });
      const downloadBtn = el('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: async () => {
          imageStatus.textContent = 'Drawing the image…';
          try {
            const png = await svgToPng(shareCardSvg(data, PALETTES[imageTheme]));
            downloadHref(png, `choir-intonation-stats-${ov.date || localDate(new Date())}.png`);
            imageStatus.textContent = 'Image saved to your downloads.';
          } catch (err) {
            console.error(err);
            imageStatus.textContent = 'Sorry — the image could not be made in this browser. A screenshot works too.';
          }
        },
      }, icon('download', { size: 18 }), 'Download as image');

      // ---- Backup: export / import (secondary)
      const backupArea = el('div', { class: 'backup-area' });
      const backupStatus = el('p', { class: 'small', role: 'status' });
      const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', id: 'stats-import' });
      const canExport = typeof progress.exportAllProgress === 'function';
      const canImport = typeof progress.importAllProgress === 'function';

      function showBackupButtons() {
        setChildren(backupArea,
          el('p', { class: 'small muted' }, 'Save all your progress and settings in a file — for example to move to another device — and load it again later.'),
          el('div', { class: 'btn-row' },
            canExport ? el('button', {
              type: 'button',
              class: 'btn btn-small',
              onclick: () => {
                try {
                  const json = JSON.stringify(progress.exportAllProgress(), null, 2);
                  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
                  downloadHref(url, `choir-intonation-progress-${localDate(new Date())}.json`);
                  setTimeout(() => URL.revokeObjectURL(url), 2000);
                  setStatus('Progress file saved to your downloads.', false);
                } catch (err) {
                  console.error(err);
                  setStatus('Sorry — the file could not be saved.', true);
                }
              },
            }, icon('download', { size: 16 }), 'Export data (JSON)') : null,
            canImport ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => fileInput.click() },
              icon('upload', { size: 16 }), 'Import data') : null,
          ),
          fileInput,
          backupStatus,
        );
      }
      function setStatus(msg, isError) {
        backupStatus.textContent = msg;
        backupStatus.className = `small ${isError ? 'backup-error' : 'backup-ok'}`;
      }
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          setStatus('This file could not be read. Please choose a progress file exported from this app.', true);
          return;
        }
        setChildren(backupArea,
          el('p', { class: 'small confirm-text' }, `This will replace your current progress with "${file.name}" — continue?`),
          el('div', { class: 'btn-row' },
            el('button', {
              type: 'button',
              class: 'btn btn-small btn-danger',
              onclick: () => {
                const res = progress.importAllProgress(parsed);
                if (res && res.ok) {
                  build(); // redraw everything with the imported progress
                  const s = container.querySelector('.backup-status-slot');
                  if (s) s.textContent = 'Your progress has been imported.';
                } else {
                  showBackupButtons();
                  setStatus((res && res.error) || 'This file could not be imported.', true);
                }
              },
            }, 'Yes, replace'),
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => { showBackupButtons(); setStatus('Import cancelled.', false); } }, 'Cancel'),
          ),
        );
      });
      showBackupButtons();
      const backup = (canExport || canImport) ? el('details', { class: 'help-box backup' },
        el('summary', {}, icon('download', { size: 18 }), el('span', {}, 'Back up or move your progress'), icon('chevron-down', { size: 18, class: 'help-chevron' })),
        el('div', { class: 'help-body' }, backupArea),
      ) : null;

      // ---- Details per exercise
      const details = el('div', { class: 'stats-details' },
        el('h2', { class: 'stats-h2' }, 'Details per exercise'),
        ov.chapters.map((c) => {
          const title = SHORT_LABEL[c.key] || c.label;
          if (c.key === 'tune-it') return errorPanel(c.key, title, () => tuneIt.getTuneStats()).element;
          if (c.key === 'sing' || c.key === 'sing-match') {
            return singMod && typeof singMod.getSingStats === 'function'
              ? errorPanel(c.key, title, () => singMod.getSingStats(c.key)).element : null;
          }
          return chapterProgressPanel(c.key, { title }).element;
        }),
      );

      const head = el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Your stats'),
          el('p', { class: 'task' }, hasData ? 'A snapshot of your progress — ready to share with your choir.' : 'Your progress will show up here.'),
        ),
      );

      const slot = el('p', { class: 'small backup-ok backup-status-slot', role: 'status' });

      const body = hasData
        ? [
          shareCardHtml(data),
          el('div', { class: 'share-actions' }, downloadBtn, themeSeg.element),
          imageStatus,
          slot,
          details,
          backup,
        ]
        : [
          el('div', { class: 'card empty-stats' },
            el('h2', {}, 'Play a few rounds to fill this page'),
            el('p', { class: 'muted' }, 'Your ranks, best results and practice days appear here as soon as you have answered a few questions.'),
            el('div', { class: 'btn-row' },
              el('a', { class: 'btn btn-primary', href: ROUTE_OF['higher-or-lower'] }, 'Higher / lower'),
              el('a', { class: 'btn', href: ROUTE_OF['odd-one-out'] }, 'Odd one out'),
              el('a', { class: 'btn', href: ROUTE_OF['tune-it'] }, 'Lock it in'),
            ),
          ),
          slot,
          backup,
        ];

      setChildren(container, el('section', { class: 'screen stats' }, head, body));
    }

    // The singing module is optional (loaded on demand); details for those tabs need it.
    let singMod = null;
    loadSingModules().then(({ sing }) => { singMod = sing; build(); });
    setChildren(container, el('section', { class: 'screen stats' }, el('p', { class: 'muted' }, 'Loading…')));
    return undefined;
  },
};
