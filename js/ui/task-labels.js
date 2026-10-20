// Short, singer-friendly labels and light grouping for the Tune / Sing tasks, plus the
// shared compact task picker (chips with rank badges).

import { INTERVALS } from '../music/tuning.js';
import { el, setChildren } from './dom.js';

const SHORT = {
  'minor-second': 'Min 2nd', 'major-second': 'Maj 2nd', 'minor-third': 'Min 3rd', 'major-third': 'Maj 3rd',
  fourth: '4th', tritone: 'Tritone', fifth: '5th', 'minor-sixth': 'Min 6th', 'major-sixth': 'Maj 6th',
  'minor-seventh': 'Min 7th', 'major-seventh': 'Maj 7th', octave: 'Octave',
  'third-in-major': 'Third (major)', 'fifth-in-major': 'Fifth (major)', 'third-in-minor': 'Third (minor)',
  'fifth-in-minor': 'Fifth (minor)', 'seventh-in-dom7': 'Seventh (dom 7th)', 'seventh-in-maj7': 'Seventh (maj 7th)',
};
const ORDINALS = { second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th' };

/** 'interval' | 'chord' — from the logic's `group`, else one fixed note = interval. */
export const groupOf = (t) => (t.group === 'interval' || t.group === 'chord' ? t.group : t.fixed.length === 1 ? 'interval' : 'chord');

/** Short label by key, with a pattern fallback for tasks added later. */
export function shortTaskLabel(t) {
  if (SHORT[t.key]) return SHORT[t.key];
  let s = String(t.label || t.key);
  s = s.replace(/ in an? (major|minor) chord$/i, ' ($1)')
    .replace(/ in an? dominant (7th|seventh) chord$/i, ' (dom 7th)')
    .replace(/ in an? major (7th|seventh) chord$/i, ' (maj 7th)')
    .replace(/ in an? minor (7th|seventh) chord$/i, ' (min 7th)');
  s = s.replace(/^Minor (\w+)$/i, (m, w) => `Min ${ORDINALS[w.toLowerCase()] || w}`)
    .replace(/^Major (\w+)$/i, (m, w) => `Maj ${ORDINALS[w.toLowerCase()] || w}`);
  return s;
}

/** Interval tasks in light groups by size (seconds & thirds, 4th/tritone/5th, sixths & sevenths, octave). */
const INTERVAL_GROUPS = [
  { label: 'Seconds & thirds', max: 4 },
  { label: 'Fourth, tritone & fifth', max: 7 },
  { label: 'Sixths & sevenths', max: 11 },
  { label: 'Octave', max: Infinity },
];
const semitonesOf = (t) => (INTERVALS[t.target] ? INTERVALS[t.target].semitones : 0);

export function groupIntervalTasks(tasks) {
  const sorted = tasks.slice().sort((a, b) => semitonesOf(a) - semitonesOf(b));
  const groups = INTERVAL_GROUPS.map((g) => ({ label: g.label, tasks: [] }));
  for (const t of sorted) {
    const s = semitonesOf(t);
    const i = INTERVAL_GROUPS.findIndex((g) => s <= g.max);
    groups[i < 0 ? groups.length - 1 : i].tasks.push(t);
  }
  return groups.filter((g) => g.tasks.length);
}

let pickerCount = 0;

/**
 * Compact chip picker for one mode's tasks, each with a rank badge.
 * Interval tasks (more than 6) are shown in light groups by size.
 * Returns { element, inputs, badges: Map(key -> badge element), setValue(key) }.
 */
export function taskChips({ tasks, mode, value, legend, onChoose }) {
  pickerCount += 1;
  const name = `task-chips-${pickerCount}`;
  const inputs = [];
  const badges = new Map();
  const chip = (t) => {
    const id = `${name}-${t.key}`;
    const input = el('input', { type: 'radio', name, id, value: t.key });
    input.checked = t.key === value;
    input.addEventListener('change', () => { if (input.checked) onChoose(t.key); });
    inputs.push(input);
    const badge = el('span', { class: 'task-rank is-none' }, '–');
    badges.set(t.key, badge);
    return [input, el('label', { for: id, title: `${t.label}: ${t.description || ''}` }, shortTaskLabel(t), badge)];
  };
  const body = el('div', { class: 'task-chips' });
  if (mode === 'interval' && tasks.length > 6) {
    for (const g of groupIntervalTasks(tasks)) {
      body.append(el('div', { class: 'task-chip-group' },
        el('span', { class: 'task-group-label' }, g.label),
        el('div', { class: 'segmented' }, g.tasks.map(chip))));
    }
  } else {
    body.append(el('div', { class: 'segmented' }, tasks.map(chip)));
  }
  const element = el('fieldset', { class: 'segmented-group is-compact task-fieldset' }, el('legend', {}, legend), body);
  return {
    element,
    inputs,
    badges,
    setValue(key) { for (const i of inputs) i.checked = i.value === key; },
  };
}

/** Helper for screens: rebuild a holder with chips. */
export function renderTaskChips(holder, opts) {
  const picker = taskChips(opts);
  setChildren(holder, picker.element);
  return picker;
}
