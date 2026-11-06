// First-run setup (#/setup): voice parts -> sound -> a quick listen, then the first exercise.
// Can be run again from Settings.

import { TUNINGS, CHORDS, INTERVALS, buildChord, randomRootFreq } from '../music/tuning.js';
import { playChord } from '../audio/engine.js';
import { getSettings, setPref } from '../storage.js';
import { el, setChildren } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { voicePicker, soundPicker } from '../ui/sound-picker.js';
import { createPlayer } from '../ui/player.js';
import { voiceArg, voiceChosen } from '../ui/voices.js';
import { TABS, GROUPS } from '../ui/nav.js';

const STEPS = [
  { key: 'voice', title: 'Your voice' },
  { key: 'sound', title: 'Your sound' },
  { key: 'listen', title: 'A quick listen' },
];
const CHORD_SECONDS = 3;

export default {
  id: 'setup',
  title: 'Welcome',

  render(container) {
    let step = 0;
    let stepCleanup = null;
    let firstPaint = true;
    const body = el('div', { class: 'setup-body' });
    const stepper = el('ol', { class: 'stepper', 'aria-label': 'Setup steps' });
    // Announced to screen readers (the stepper shows the same visually).
    const stepTitle = el('h2', { class: 'visually-hidden', tabindex: '-1' });
    const nav = el('div', { class: 'setup-nav' });
    const nextHint = el('p', { class: 'setup-next-hint', role: 'status' }, 'Pick at least one part to continue.');
    let syncVoiceNext = () => {};

    function finish(route = 'higher-or-lower') {
      setPref('setupDone', true);
      window.location.hash = `#/${route}`;
    }

    function go(n) {
      if (typeof stepCleanup === 'function') {
        try { stepCleanup(); } catch (err) { console.error(err); }
      }
      stepCleanup = null;
      step = Math.max(0, Math.min(STEPS.length - 1, n));
      renderStep();
    }

    function renderStepper() {
      setChildren(stepper, STEPS.map((s, i) => el('li', {
        class: i === step ? 'is-current' : i < step ? 'is-done' : '',
        'aria-current': i === step ? 'step' : null,
      }, el('span', { class: 'stepper-dot', 'aria-hidden': 'true' }, i < step ? icon('check', { size: 14 }) : String(i + 1)),
        el('span', { class: 'stepper-label' }, s.title))));
    }

    function renderStep() {
      renderStepper();
      stepTitle.textContent = `Step ${step + 1} of ${STEPS.length}: ${STEPS[step].title}`;
      const key = STEPS[step].key;

      if (key === 'voice') {
        setChildren(body,
          el('p', { class: 'task' }, 'Which part do you sing? The exercises will use notes that suit your voice.'),
          voicePicker({
            legend: 'Voice parts',
            help: 'Tick the part(s) you sing — several are fine. You can change this any time in Settings.',
            onChange: () => syncVoiceNext(),
          }),
        );
      } else if (key === 'sound') {
        const picker = soundPicker({ legend: 'Sound', help: 'Press ▶ to hear a sound — that also chooses it. Fuller sounds make tuning easier to hear.' });
        stepCleanup = () => picker.destroy();
        setChildren(body,
          el('p', { class: 'task' }, 'Choose the instrument sound for the exercises. Headphones or good speakers help a lot.'),
          picker.element,
        );
      } else {
        stepCleanup = renderListen();
      }

      const isLast = step === STEPS.length - 1;
      const nextBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => go(step + 1) },
        'Next', icon('chevron-right', { size: 20 }));
      // Step 1: Next stays disabled until a part is picked ("Skip setup" keeps the fallback range).
      syncVoiceNext = () => {
        const needPart = STEPS[step].key === 'voice' && !voiceChosen();
        nextBtn.disabled = needPart;
        nextHint.hidden = !needPart;
      };
      setChildren(nav,
        step > 0
          ? el('button', { type: 'button', class: 'btn', onclick: () => go(step - 1) }, 'Back')
          : el('button', { type: 'button', class: 'btn btn-link', onclick: () => finish() }, 'Skip setup'),
        isLast
          ? el('button', { type: 'button', class: 'btn btn-primary', onclick: () => finish() },
            'Start with Higher / lower', icon('chevron-right', { size: 20 }))
          : nextBtn,
      );
      syncVoiceNext();
      if (!firstPaint) stepTitle.focus({ preventScroll: true });
      firstPaint = false;
      window.scrollTo(0, 0);
    }

    // Step 3: the pure-vs-piano chord, condensed from the sound check.
    function renderListen() {
      const s = getSettings();
      const chord = CHORDS.major;
      const span = Math.max(...chord.intervals.map((k) => INTERVALS[k].semitones));
      const root = randomRootFreq(voiceArg(s), span);
      const thirdGap = Math.round(INTERVALS.M3.equalCents - INTERVALS.M3.justCents);
      // Always in the page with a reserved height, so nothing jumps while it plays.
      const status = el('p', { class: 'stage-status setup-listen-status', role: 'status' });
      const player = createPlayer({
        pauseMs: 600,
        onChange: (st) => {
          status.textContent = st.error || (st.playing || st.loading ? st.label : '');
          status.classList.toggle('is-error', !!st.error);
        },
      });
      const chordStep = (tuning, label) => ({
        label,
        start: () => playChord(buildChord(root, 'major', tuning).map((n) => n.freq),
          { duration: CHORD_SECONDS, timbre: getSettings().timbre }),
      });
      setChildren(body,
        el('p', { class: 'task' },
          `In a choir, a pure major third is about ${thirdGap} cents lower than on a piano (100 cents = one semitone). Listen to the middle note of these chords.`),
        el('div', { class: 'stage' },
          el('div', { class: 'btn-row setup-listen' },
            el('button', {
              type: 'button',
              class: 'btn',
              onclick: () => player.play([chordStep(TUNINGS.JUST, 'Pure chord…'), chordStep(TUNINGS.EQUAL, 'Piano chord…')]),
            }, icon('play', { size: 18 }), 'Pure, then piano'),
            el('button', { type: 'button', class: 'btn btn-pure', onclick: () => player.play([chordStep(TUNINGS.JUST, 'Pure chord…')]) },
              icon('play', { size: 18 }), 'Pure'),
            el('button', { type: 'button', class: 'btn btn-piano', onclick: () => player.play([chordStep(TUNINGS.EQUAL, 'Piano chord…')]) },
              icon('play', { size: 18 }), 'Piano'),
          ),
          status,
          el('p', { class: 'muted small center' }, 'The pure chord sounds calm. The piano chord wobbles a little. These exercises train you to hear that difference.'),
        ),
        el('p', { class: 'muted small' }, 'You can hear this again any time in Settings → Sound check.'),
        exerciseMap(),
      );
      return () => player.destroy();
    }

    // The five exercises, grouped as in the navigation, with their one-liners.
    function exerciseMap() {
      return el('section', { class: 'card exercise-map', 'aria-labelledby': 'map-title' },
        el('h2', { class: 'card-title', id: 'map-title' }, 'Your five exercises'),
        GROUPS.filter((g) => g.key === 'listen' || g.key === 'sing').map((g) => el('div', { class: 'map-group' },
          el('h3', { class: 'map-group-title' }, icon(g.icon, { size: 16 }), g.label),
          el('ul', { class: 'map-list' }, TABS.filter((t) => t.group === g.key).map((t) => el('li', {},
            el('a', {
              href: `#/${t.route}`,
              onclick: (e) => { e.preventDefault(); finish(t.route); },
            }, icon(t.icon, { size: 18 }), el('strong', {}, t.label)),
            el('span', { class: 'muted' }, ` — ${t.blurb}`)))))),
      );
    }

    const screen = el('section', { class: 'screen setup' },
      el('div', { class: 'setup-head' },
        el('span', { class: 'setup-icon', 'aria-hidden': 'true' }, icon('headphones', { size: 26 })),
        el('div', {},
          el('h1', {}, 'Welcome to the Choir Intonation Trainer'),
          el('p', { class: 'muted' }, 'Three quick steps, then your first exercise.'),
        ),
      ),
      stepper,
      stepTitle,
      body,
      nextHint,
      nav,
    );
    container.append(screen);
    renderStep();

    return () => {
      if (typeof stepCleanup === 'function') stepCleanup();
    };
  },
};
