// Bootstrap + hash router + tab bar.
// Routes: #/setup, #/higher-or-lower, #/odd-one-out, #/tune, #/sing-back, #/sing, #/stats,
//         #/settings, #/settings/sound-check.
// '#/' (or anything unknown) opens the setup on the very first visit, later the last
// used tab (or Higher / lower).

import * as engine from './audio/engine.js';
import { getSettings, onSettingsChange, getPref, setPref } from './storage.js';
import { renderTabBar } from './ui/nav.js';
import setup from './screens/setup.js';
import soundCheck from './screens/sound-check.js';
import higherOrLower from './screens/higher-or-lower.js';
import oddOneOut from './screens/odd-one-out.js';
import tune from './screens/tune.js';
import settings from './screens/settings.js';
import singBack from './screens/sing-back.js';
import sing from './screens/sing.js';
import stats from './screens/stats.js';

const APP_NAME = 'Choir Intonation Trainer';
const FIRST_VISIT_ROUTE = 'setup';
const DEFAULT_ROUTE = 'higher-or-lower';

// route -> { screen, params }
const ROUTES = {
  setup: { screen: setup },
  'higher-or-lower': { screen: higherOrLower },
  'odd-one-out': { screen: oddOneOut },
  tune: { screen: tune },
  'sing-back': { screen: singBack },
  sing: { screen: sing },
  stats: { screen: stats },
  settings: { screen: settings },
  'settings/sound-check': { screen: soundCheck },
};

// Routes never remembered as "last used tab".
const NOT_A_TAB = new Set(['setup', 'settings', 'settings/sound-check']);

// Older addresses keep working.
const ALIASES = {
  'sound-check': 'settings/sound-check',
  'chapter/higher-or-lower': 'higher-or-lower',
  'chapter/odd-one-out': 'odd-one-out',
  'chapter/tune-it-yourself': 'tune',
  'chapter/sing-the-missing-note': 'sing',
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

let tabBar = null;
let activeCleanup = null;
let firstRender = true;

function routeFromHash(hash) {
  let path = (hash || '').replace(/^#\/?/, '').replace(/\/+$/, '');
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  if (has(ALIASES, path)) return ALIASES[path];
  return has(ROUTES, path) ? path : null;
}

function fallbackRoute() {
  const last = getPref('lastTab', null);
  if (typeof last === 'string' && has(ROUTES, last) && !NOT_A_TAB.has(last)) return last;
  // Very first visit (never finished setup, never opened a tab): the setup.
  if (!getPref('setupDone', false) && last == null) return FIRST_VISIT_ROUTE;
  return DEFAULT_ROUTE;
}

function leaveCurrent() {
  if (typeof activeCleanup === 'function') {
    try { activeCleanup(); } catch (err) { console.error('Screen cleanup failed:', err); }
  }
  activeCleanup = null;
  try { engine.stopAll(); } catch (err) { console.error('stopAll failed:', err); }
}

function render() {
  const route = routeFromHash(window.location.hash) || fallbackRoute();
  if (window.location.hash !== `#/${route}`) {
    // Rewrite the address (no extra history entry, no extra hashchange event).
    try { history.replaceState(null, '', `#/${route}`); } catch { /* ignore */ }
  }

  leaveCurrent();

  const { screen, params = {} } = ROUTES[route];
  const container = document.getElementById('app');
  container.replaceChildren();

  const title = typeof screen.title === 'function' ? screen.title(params) : screen.title;
  document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  if (tabBar) tabBar.setActive(route);
  if (!NOT_A_TAB.has(route)) setPref('lastTab', route);

  // Was the navigation started from the tab bar? Then keep focus there.
  const fromTabs = document.activeElement && document.activeElement.closest
    && document.activeElement.closest('#tabbar');

  try {
    const cleanup = screen.render(container, params);
    activeCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    console.error(`Rendering "${screen.id}" failed:`, err);
    container.replaceChildren();
    const box = document.createElement('section');
    box.className = 'screen';
    box.innerHTML = '<h1>Something went wrong</h1><p class="task">This page could not be shown. Try reloading the page.</p>';
    container.append(box);
  }

  if (!firstRender) {
    window.scrollTo(0, 0);
    if (!fromTabs) {
      const heading = container.querySelector('h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }
  }
  firstRender = false;
}

// Apply sound settings to the engine (at startup and whenever they change).
// setReverb is optional so the app still runs with an older engine.
function applySound(s) {
  try { engine.setMasterVolume(s.volume); } catch (err) { console.error('setMasterVolume failed:', err); }
  if (typeof engine.setReverb === 'function') {
    try { engine.setReverb(s.reverb); } catch (err) { console.error('setReverb failed:', err); }
  }
}

function start() {
  tabBar = renderTabBar(document.getElementById('tabbar'));
  applySound(getSettings());
  onSettingsChange(applySound);
  window.addEventListener('hashchange', render);
  render();
  document.documentElement.setAttribute('data-booted', '');
}

start();
