// Icons from Lucide — https://lucide.dev — lucide-static v0.460.0, ISC License.
// Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
// All other copyright (c) for Lucide are held by Lucide Contributors 2022.
// Shape data copied unchanged from https://unpkg.com/lucide-static@0.460.0/icons/<name>.svg
// (full license text: docs/CREDITS.md).

const ICONS = {
  'arrow-down': [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
  'arrow-up': [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
  'arrow-up-down': [
    ['path', { d: 'm21 16-4 4-4-4' }], ['path', { d: 'M17 20V4' }],
    ['path', { d: 'm3 8 4-4 4 4' }], ['path', { d: 'M7 4v16' }],
  ],
  'audio-waveform': [['path', { d: 'M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'circle-check': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  'circle-help': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }], ['path', { d: 'M12 17h.01' }],
  ],
  'circle-arrow-right': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M8 12h8' }], ['path', { d: 'm12 16 4-4-4-4' }]],
  'circle-alert': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line', { x1: '12', x2: '12', y1: '8', y2: '12' }], ['line', { x1: '12', x2: '12.01', y1: '16', y2: '16' }],
  ],
  'circle-dot': [['circle', { cx: '12', cy: '12', r: '10' }], ['circle', { cx: '12', cy: '12', r: '1' }]],
  ear: [['path', { d: 'M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0' }], ['path', { d: 'M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4' }]],
  lightbulb: [
    ['path', { d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5' }],
    ['path', { d: 'M9 18h6' }], ['path', { d: 'M10 22h4' }],
  ],
  'loader-circle': [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
  pause: [['rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }], ['rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' }]],
  'volume-x': [
    ['path', { d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z' }],
    ['line', { x1: '22', x2: '16', y1: '9', y2: '15' }], ['line', { x1: '16', x2: '22', y1: '9', y2: '15' }],
  ],
  'circle-x': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '7 10 12 15 17 10' }], ['line', { x1: '12', x2: '12', y1: '15', y2: '3' }]],
  upload: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '17 8 12 3 7 8' }], ['line', { x1: '12', x2: '12', y1: '3', y2: '15' }]],
  headphones: [['path', { d: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3' }]],
  lock: [['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
  'mic-vocal': [
    ['path', { d: 'm11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12' }],
    ['path', { d: 'M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5' }],
    ['circle', { cx: '16', cy: '7', r: '5' }],
  ],
  'repeat-2': [
    ['path', { d: 'm2 9 3-3 3 3' }], ['path', { d: 'M13 18H7a2 2 0 0 1-2-2V6' }],
    ['path', { d: 'm22 15-3 3-3-3' }], ['path', { d: 'M11 6h6a2 2 0 0 1 2 2v10' }],
  ],
  mic: [
    ['path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }],
    ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }], ['line', { x1: '12', x2: '12', y1: '19', y2: '22' }],
  ],
  music: [['path', { d: 'M9 18V5l12-2v13' }], ['circle', { cx: '6', cy: '18', r: '3' }], ['circle', { cx: '18', cy: '16', r: '3' }]],
  play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
  repeat: [
    ['path', { d: 'm17 2 4 4-4 4' }], ['path', { d: 'M3 11v-1a4 4 0 0 1 4-4h14' }],
    ['path', { d: 'm7 22-4-4 4-4' }], ['path', { d: 'M21 13v1a4 4 0 0 1-4 4H3' }],
  ],
  'rotate-ccw': [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]],
  settings: [
    ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  shuffle: [
    ['path', { d: 'M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22' }],
    ['path', { d: 'm18 2 4 4-4 4' }],
    ['path', { d: 'M2 6h1.9c1.5 0 2.9.9 3.6 2.2' }],
    ['path', { d: 'M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8' }],
    ['path', { d: 'm18 14 4 4-4 4' }],
  ],
  'sliders-horizontal': [
    ['line', { x1: '21', x2: '14', y1: '4', y2: '4' }], ['line', { x1: '10', x2: '3', y1: '4', y2: '4' }],
    ['line', { x1: '21', x2: '12', y1: '12', y2: '12' }], ['line', { x1: '8', x2: '3', y1: '12', y2: '12' }],
    ['line', { x1: '21', x2: '16', y1: '20', y2: '20' }], ['line', { x1: '12', x2: '3', y1: '20', y2: '20' }],
    ['line', { x1: '14', x2: '14', y1: '2', y2: '6' }], ['line', { x1: '8', x2: '8', y1: '10', y2: '14' }],
    ['line', { x1: '16', x2: '16', y1: '18', y2: '22' }],
  ],
  square: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]],
  'trending-up': [['polyline', { points: '22 7 13.5 15.5 8.5 10.5 2 17' }], ['polyline', { points: '16 7 22 7 22 13' }]],
  'volume-2': [
    ['path', { d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z' }],
    ['path', { d: 'M16 9a5 5 0 0 1 0 6' }],
    ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }],
  ],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
};

const NS = 'http://www.w3.org/2000/svg';

/**
 * Inline SVG icon (Lucide). Decorative by default (aria-hidden); pass `label`
 * for a standalone meaningful icon.
 * @param {string} name   key of ICONS
 * @param {{ size?: number, label?: string, class?: string }} [opts]
 */
export function icon(name, { size = 20, label, class: cls } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  const attrs = {
    xmlns: NS, width: String(size), height: String(size), viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    class: `icon icon-${name}${cls ? ` ${cls}` : ''}`,
    focusable: 'false',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const shapes = ICONS[name];
  if (!shapes) {
    console.warn(`Unknown icon "${name}"`);
    return svg;
  }
  for (const [tag, a] of shapes) {
    const child = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) child.setAttribute(k, v);
    svg.append(child);
  }
  return svg;
}

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));
