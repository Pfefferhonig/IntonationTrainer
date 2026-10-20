// General UI building blocks: segmented choice, collapsible help, small tag link,
// keyboard shortcuts.

import { el } from './dom.js';
import { icon } from './icons.js';

let groupCount = 0;

/**
 * Row of pill-shaped radio buttons.
 * options: [{ value, label, title? }]
 * Returns { element, setValue(v) }.
 */
export function segmented({ name, legend, options, value, onChange, hideLegend = false, compact = false }) {
  groupCount += 1;
  const group = `seg-${name}-${groupCount}`;
  const inputs = [];
  const wrap = el('div', { class: 'segmented' });
  options.forEach((o, i) => {
    const id = `${group}-${i}`;
    const input = el('input', { type: 'radio', name: group, id, value: String(o.value) });
    input.checked = o.value === value;
    input.addEventListener('change', () => {
      if (input.checked) onChange(o.value);
    });
    inputs.push([input, o.value]);
    wrap.append(input, el('label', { for: id, title: o.title || null }, o.label));
  });
  const element = el('fieldset', { class: `segmented-group${compact ? ' is-compact' : ''}` },
    el('legend', { class: hideLegend ? 'visually-hidden' : null }, legend),
    wrap,
  );
  return {
    element,
    setValue(v) {
      for (const [input, val] of inputs) input.checked = val === v;
    },
  };
}

/** Collapsible "How it works" box (closed by default). */
export function helpBox({ summary = 'How it works', open = false }, ...content) {
  return el('details', { class: 'help-box', open: open || null },
    el('summary', {},
      icon('circle-help', { size: 18 }),
      el('span', {}, summary),
      icon('chevron-down', { size: 18, class: 'help-chevron' }),
    ),
    el('div', { class: 'help-body' }, ...content),
  );
}

/** Small pill link, e.g. the current tuning linking to Settings. */
export function tagLink({ href, label, title }) {
  return el('a', { class: 'tag', href, title: title || null }, label, icon('chevron-right', { size: 14 }));
}

/**
 * Global keyboard shortcuts for a screen. handler(event) returns true when it used the key.
 * Ignored while typing in a field, with Ctrl/Alt/Cmd held, and for Enter/Space on a focused
 * button or link (those already activate the focused control).
 * Returns an uninstall function.
 */
export function installShortcuts(handler) {
  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      if ((e.key === 'Enter' || e.key === ' ') && t.closest('button, a, summary, [role="button"]')) return;
    }
    let used = false;
    try { used = handler(e) === true; } catch (err) { console.error(err); }
    if (used) e.preventDefault();
  }
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

/**
 * A card with a group of large radio "cards".
 * options: [{ value, label, detail?, aside?, extra?, more? }]
 *   aside: small text after the label; extra: a node at the right (e.g. a preview button);
 *   more: extra nodes under the detail (status / hint lines).
 * Returns the card element.
 */
export function choiceCards({ legend, help, options, value, onChange, plain = false }) {
  groupCount += 1;
  const group = `choice-${groupCount}`;
  const list = el('div', { class: 'choice-list' });
  options.forEach((o, i) => {
    const id = `${group}-${i}`;
    const detailId = o.detail ? `${id}-d` : null;
    const input = el('input', { type: 'radio', name: group, id, value: String(o.value), 'aria-describedby': detailId });
    input.checked = o.value === value;
    input.addEventListener('change', () => { if (input.checked) onChange(o.value); });
    list.append(el('div', { class: 'choice' },
      input,
      el('label', { for: id, class: 'choice-text' },
        el('span', { class: 'choice-label' }, o.label, o.aside ? el('span', { class: 'choice-range' }, o.aside) : null),
        o.detail ? el('span', { class: 'choice-detail', id: detailId }, o.detail) : null,
        o.more || null,
      ),
      o.extra || null,
    ));
  });
  const fieldset = el('fieldset', { class: 'choice-group' },
    el('legend', {}, legend),
    help ? el('p', { class: 'help' }, help) : null,
    list,
  );
  return plain ? fieldset : el('div', { class: 'card' }, fieldset);
}

/**
 * A card with large checkbox "cards" (several can be chosen; at least `min`).
 * options: [{ value, label, detail?, aside? }]; values: array of chosen values.
 * onChange(values) is called with the new array. `footer` nodes go under the list.
 * Returns the card element.
 */
export function checkCards({ legend, help, options, values, onChange, min = 1, minMessage, footer, plain = false }) {
  groupCount += 1;
  const group = `check-${groupCount}`;
  const list = el('div', { class: 'choice-list' });
  const note = el('p', { class: 'choice-min-note', role: 'status' });
  note.hidden = true;
  const inputs = [];
  options.forEach((o, i) => {
    const id = `${group}-${i}`;
    const input = el('input', { type: 'checkbox', id, value: String(o.value) });
    input.checked = values.includes(o.value);
    input.addEventListener('change', () => {
      const chosen = inputs.filter(([inp]) => inp.checked).map(([, v]) => v);
      if (chosen.length < min) {
        input.checked = true; // keep at least `min`
        note.textContent = minMessage || `Choose at least ${min}.`;
        note.hidden = false;
        return;
      }
      note.hidden = true;
      onChange(chosen);
    });
    inputs.push([input, o.value]);
    list.append(el('div', { class: 'choice is-check' },
      input,
      el('label', { for: id, class: 'choice-text' },
        el('span', { class: 'choice-label' }, o.label, o.aside ? el('span', { class: 'choice-range' }, o.aside) : null),
        o.detail ? el('span', { class: 'choice-detail' }, o.detail) : null,
      ),
    ));
  });
  const fieldset = el('fieldset', { class: 'choice-group' },
    el('legend', {}, legend),
    help ? el('p', { class: 'help' }, help) : null,
    list,
    note,
    footer || null,
  );
  return plain ? fieldset : el('div', { class: 'card' }, fieldset);
}

/** <kbd> hint shown inside buttons. */
export function kbd(text, title) {
  return el('kbd', { class: 'kbd', title: title || null, 'aria-hidden': 'true' }, text);
}
