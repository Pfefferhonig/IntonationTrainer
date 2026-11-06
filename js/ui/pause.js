// Pausing when the page is hidden (another tab, phone locked) or the system interrupts the sound.
// Contract: docs/BUILD-PLAN.md "Shared component contracts".

import { el, reveal } from './dom.js';
import { icon } from './icons.js';
import * as engine from '../audio/engine.js';

/**
 * Be told when the page is hidden or comes back:
 *   onPageHidden({ onHide(info), onShow(info) }) -> unregister
 * onHide({ reason: 'hidden' | 'pagehide' | 'audio' }) — stop sound, close the microphone, discard a take.
 *   'audio' = the system interrupted the sound (phone call, iOS) while the page stayed visible; show the
 *   Paused card right away in that case (recovery needs a button press: Continue -> initAudio()).
 * onShow({ reason: 'visible' | 'pageshow' }) — the page is visible again; show the Paused card if you
 *   paused something. Each is called once per change (hidden twice in a row is reported once).
 */
export function onPageHidden({ onHide, onShow } = {}) {
  let hidden = document.visibilityState === 'hidden';
  const call = (fn, info) => {
    try { if (typeof fn === 'function') fn(info); } catch (err) { console.error(err); }
  };
  const hide = (reason) => {
    if (hidden) return;
    hidden = true;
    call(onHide, { reason });
  };
  const show = (reason) => {
    if (!hidden) return;
    hidden = false;
    call(onShow, { reason });
  };
  const onVis = () => {
    if (document.visibilityState === 'hidden') hide('hidden');
    else show('visible');
  };
  const onPageHide = () => hide('pagehide');
  const onPageShow = (e) => { if (e.persisted || hidden) show('pageshow'); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  let offAudio = () => {};
  if (typeof engine.onAudioInterrupted === 'function') {
    try {
      offAudio = engine.onAudioInterrupted(({ state } = {}) => {
        if ((state === 'interrupted' || state === 'suspended') && document.visibilityState !== 'hidden') {
          call(onHide, { reason: 'audio' });
        }
      }) || (() => {});
    } catch (err) { console.error(err); }
  }

  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    try { offAudio(); } catch { /* ignore */ }
  };
}

/**
 * "Paused while you were away" + primary "Continue" (Enter: it gets focus on show()).
 *   createPausedCard({ onContinue, text? }) -> { element, show(), hide(), isShown }
 * Rendered hidden; Continue hides the card and calls onContinue (call initAudio() there, restore the
 * held note or go back to Armed).
 */
export function createPausedCard({ onContinue, text = 'Paused while you were away.' } = {}) {
  const textEl = el('p', { class: 'paused-card-text' }, text);
  const btn = el('button', { type: 'button', class: 'btn btn-primary paused-card-continue' },
    el('span', {}, 'Continue'), el('kbd', { class: 'kbd', 'aria-hidden': 'true' }, 'Enter'));
  const element = el('div', { class: 'paused-card', role: 'status' },
    icon('pause', { size: 22, class: 'paused-card-icon' }), textEl, btn);
  element.hidden = true;
  let shown = false;
  btn.addEventListener('click', () => {
    hide();
    try { if (typeof onContinue === 'function') onContinue(); } catch (err) { console.error(err); }
  });
  function show(message) {
    if (message) textEl.textContent = message;
    shown = true;
    element.hidden = false;
    element.classList.remove('is-entering');
    void element.offsetWidth;
    element.classList.add('is-entering');
    btn.focus({ preventScroll: true });
    reveal(element);
  }
  function hide() {
    shown = false;
    element.hidden = true;
  }
  return { element, show, hide, get isShown() { return shown; } };
}
