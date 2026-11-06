// "Odd one out" (#/odd-one-out)
// A chord with exactly one note slightly too high or too low — or, with "Sometimes all in tune",
// possibly none: find it, then compare "As played" / "In tune" with a held chord that is
// retuned in place (whole chord or just the off note).
//
// Shared interaction model (docs/BUILD-PLAN.md): Ready -> Presenting (answers locked until the
// chord has sounded 300 ms; one by one: the last note + 300 ms) -> Answering -> Feedback -> Next.

// Namespace imports: newer exports are feature-checked with typeof.
import * as ooo from '../exercise/odd-one-out.js';
import * as progress from '../exercise/progress.js';
import * as engine from '../audio/engine.js';
import {
  helpBox, tagLink, segmented, kbd, installShortcuts, onEscape, createOptionsSummary, keyLegend, createTipCard,
  createCompareSwitch, createSessionSummary, refocusAfterPointerChange, refocusAfterClick,
} from '../ui/components.js';
import {
  createPlayButton, nextButton, createFeedback, createLevelDisplay, createActionBar, playProgress, buttonBusy,
} from '../ui/exercise.js';
import { TUNINGS, CHORDS, INTERVALS, buildChord } from '../music/tuning.js';
import { getSettings, onSettingsChange, getPref, setPref } from '../storage.js';
import { el, setChildren, centsText, uniqueId, reveal } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createPlayer } from '../ui/player.js';
import { trackHighlights, chordPlan } from '../ui/highlight.js';
import { chapterProgressPanel } from '../ui/chapter-progress.js';
import { voiceArg } from '../ui/voices.js';
import {
  lxStopSound, lxLeadSeconds, lxLevelOf, lxMark, lxUnmark, lxLockAnswers, lxLevelNote, lxShouldTip, lxMakeEasier,
  lxUpdateLevel, lxStageReveal, lxCompareSelect, lxPause, lxSingleKeysOn, lxSingleKey, lxWatchSingleKeys,
  lxPrimaryPlacer, lxInlineLevel, lxTaskLine, lxFitsInView, lxCompareNoteSeen,
} from './higher-or-lower.js';

const MODES = {
  odd: { key: 'odd-one-out' },
  maybe: { key: 'odd-or-in-tune' },
};
const VARIANT_SUPPORTED = typeof ooo.describe === 'function';

const CHORD_SECONDS = 4.5;    // full-chord part
const ARPEGGIO_SECONDS = 0.6;
const NOTE_SECONDS = 1.6;     // a single note heard alone
const GATE_AFTER_ONSET_MS = 300;
const COMPARE_MAX_SECONDS = 8;
const RETUNE_SECONDS = 0.025;
// Answer keys per row, counted from the BOTTOM row up (the keyboard's rows mirror the score):
// bottom Z / X, then A / S, Q / W. A fourth (top) note — the seventh — uses 7 / 8, which never
// clash with the compare keys 1 / 2.
const ROW_KEYS_FROM_BOTTOM = [['Z', 'X'], ['A', 'S'], ['Q', 'W'], ['7', '8']];
const NONE_KEY = 'N';

const CHORD_OPTIONS = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
  { value: 'dom7', label: 'Dominant 7th' },
  { value: 'maj7', label: 'Major 7th' },
  { value: 'min7', label: 'Minor 7th' },
].filter((o) => Object.prototype.hasOwnProperty.call(CHORDS, o.value));
const STYLE_OPTIONS = [
  { value: 'together', label: 'Together' },
  { value: 'arpeggio', label: 'One by one, then together' },
];

const tuningWord = (tuning) => (tuning === TUNINGS.EQUAL ? 'Piano tuning' : 'Pure tuning');
// Compare options are tuning keys ('just' | 'equal') besides 'played'.
const tuningShort = (tuning) => (tuning === TUNINGS.EQUAL ? 'Piano' : 'Pure');
const otherTuning = (tuning) => (tuning === TUNINGS.EQUAL ? TUNINGS.JUST : TUNINGS.EQUAL);

// How much lower the barbershop (harmonic) seventh is than the piano's, for the help text.
const SEVENTH_GAP = INTERVALS.h7 ? Math.round(INTERVALS.h7.equalCents - INTERVALS.h7.justCents) : 31;

export default {
  id: 'odd-one-out',
  title: 'Odd one out',

  render(container) {
    // "Sometimes all in tune": ON by default; a saved choice wins (also the older mode switch).
    let savedNone = getPref('oddOneOut.allowNone', null);
    if (typeof savedNone !== 'boolean') {
      const oldMode = getPref('oddOneOut.mode', null);
      savedNone = oldMode ? oldMode === 'maybe' : true;
    }
    let mode = VARIANT_SUPPORTED && savedNone ? 'maybe' : 'odd';
    const modeKey = () => MODES[mode].key;
    let activeKey = modeKey();
    let staircase = progress.loadStaircase(activeKey);
    let chordKey = getPref('oddOneOut.chord', 'major');
    if (!CHORD_OPTIONS.some((o) => o.value === chordKey)) chordKey = 'major';
    let playStyle = getPref('oddOneOut.playStyle', 'together');
    if (!STYLE_OPTIONS.some((o) => o.value === playStyle)) playStyle = 'together';

    let question = null;
    // 'ready' | 'presenting' (answers locked) | 'answering' | 'feedback'
    let state = 'ready';
    let gatePassed = false;
    let gateTimer = 0;
    let stopProgress = null;
    let cancelLevelAnim = null;
    let missStreak = 0;
    let rows = [];        // [{ index, flatBtn, sharpBtn, headBtn, row, keys, nameEl, devText, devEl }] top row first
    let compare = null;
    let otherFreqs = null; // the chord in the other tuning (same root), for the compare switch
    let placer = null;
    let sustain = null;   // held compare sound (engine.startSustain handle)
    let compareStarting = false;
    let compareValue = 'played';
    let compareScope = 'chord';
    let resolveBusy = null;
    const timbre = () => getSettings().timbre;
    const hasOdd = () => question && question.oddIndex >= 0;

    const level = createLevelDisplay({ label: 'Difference' });
    const headLevel = el('span', { class: 'lx-head-level' });
    const feedback = createFeedback();
    const legend = keyLegend();
    const actionBar = createActionBar();
    const summary = createSessionSummary({ every: 10, levelLabel: 'difference' });
    const summarySlot = el('div', { class: 'lx-slot' });
    const status = el('p', { class: 'stage-hint lx-status', role: 'status' });
    const flashLine = el('p', { class: 'lx-flash', role: 'status' });
    const tip = createTipCard({ text: 'Finding this hard? Make the difference a little bigger for a while.', actions: [] });

    const player = createPlayer({
      onChange: (s) => {
        const loading = !!s.loading;
        status.classList.toggle('is-error', !!s.error);
        if (s.error) status.textContent = s.error;
        else if (loading) status.textContent = 'Loading sound…';
        else syncStatus();
        if (loading && !resolveBusy) {
          buttonBusy(state === 'feedback' ? compare && compare.element : playBtn.element,
            new Promise((resolve) => { resolveBusy = resolve; }));
        } else if (!loading && resolveBusy) {
          resolveBusy();
          resolveBusy = null;
        }
        playBtn.setPlaying(s.playing && s.tag === 'played');
        if (s.playing || s.error) compareStarting = false;
        if (!s.playing) {
          if (stopProgress) { stopProgress(); stopProgress = null; }
          if (!compareStarting) {
            sustain = null;
            if (compare) compare.setPlaying(false);
            paintCompare();
          }
        }
      },
    });

    // Light up the note heads that are sounding right now.
    function lightUp(keys) {
      for (const r of rows) r.row.classList.toggle('is-sounding', keys.has(r.index));
    }

    const chordStep = () => ({
      tag: 'played',
      start: () => {
        const arpeggio = playStyle === 'arpeggio' ? ARPEGGIO_SECONDS : 0;
        const n = question.tones.length;
        const h = engine.playChord(question.tones.map((t) => t.freq), { duration: CHORD_SECONDS, arpeggio, timbre: timbre() });
        trackHighlights(h, chordPlan(n, CHORD_SECONDS, arpeggio), lightUp);
        const lead = lxLeadSeconds(h);
        if (stopProgress) stopProgress();
        stopProgress = playProgress(playBtn.element, ((n - 1) * arpeggio + CHORD_SECONDS + lead) * 1000);
        if (!gatePassed) {
          clearTimeout(gateTimer);
          gateTimer = setTimeout(openGate, (lead + (n - 1) * arpeggio) * 1000 + GATE_AFTER_ONSET_MS);
        }
        return h;
      },
    });
    const noteStep = (index) => ({
      tag: 'note',
      start: () => {
        const h = engine.playTone(question.tones[index].freq, { duration: NOTE_SECONDS, timbre: timbre() });
        trackHighlights(h, [{ key: index, start: 0, end: NOTE_SECONDS }], lightUp);
        return h;
      },
    });

    function playChordAsPlayed() {
      if (state === 'feedback') { lxCompareSelect(compare, 'played'); return; }
      if (!gatePassed) state = 'presenting';
      sync();
      player.play([chordStep()]);
      // The whole answer grid (+ "All in tune") in view, so answering never needs scrolling.
      reveal(scoreHeading, score, noneBtn.hidden ? null : noneBtn);
    }
    const playNote = (index) => player.play([noteStep(index)]);

    function openGate() {
      if (state !== 'presenting') return;
      gatePassed = true;
      state = 'answering';
      sync();
    }

    // ---------- Compare: one held chord, retuned in place ----------
    // 'played' = as played; the chosen tuning = in tune (what the answer was judged against);
    // the other tuning = the same chord, same root, tuned the other way.
    const freqsFor = (value) => question.tones.map((t, i) => {
      if (value === question.tuning) return t.correctFreq;
      if (value === otherTuning(question.tuning) && otherFreqs && Number.isFinite(otherFreqs[i])) return otherFreqs[i];
      return t.freq;
    });
    const othersOf = () => question.tones.map((_, i) => i).filter((i) => i !== question.oddIndex);
    const sustainAlive = () => !!sustain && (typeof sustain.isPlaying === 'function' ? sustain.isPlaying() : player.playing);

    function playCompare(value, scope) {
      compareValue = value || 'played';
      compareScope = scope === 'note' && hasOdd() ? 'note' : 'chord';
      if (sustainAlive()) {
        const freqs = freqsFor(compareValue);
        if (typeof sustain.setFreqs === 'function') sustain.setFreqs(freqs, RETUNE_SECONDS);
        else if (hasOdd()) sustain.setFreq(question.oddIndex, freqs[question.oddIndex], RETUNE_SECONDS);
        if (hasOdd() && typeof sustain.setMuted === 'function') {
          for (const i of othersOf()) sustain.setMuted(i, compareScope === 'note');
        }
        paintCompare();
        return;
      }
      compareStarting = true;
      player.play([{
        tag: 'compare',
        start: () => {
          const muted = compareScope === 'note' ? othersOf() : [];
          sustain = engine.startSustain(freqsFor(compareValue), { timbre: timbre(), maxDuration: COMPARE_MAX_SECONDS, muted });
          paintCompare();
          return sustain;
        },
      }]);
      paintCompare();
    }

    // While the comparison sounds, the off note lights up and its label follows the sound.
    function paintCompare() {
      const on = sustainAlive() || (compareStarting && !!compare);
      const inTune = on && (compareValue === question.tuning || (!hasOdd() && compareValue === 'played'));
      const other = on && compareValue === otherTuning(question.tuning);
      score.classList.toggle('is-compare-in-tune', inTune);
      score.classList.toggle('is-compare-other', other);
      for (const r of rows) {
        const lit = on && (r.index === question.oddIndex || (!hasOdd() || compareScope === 'chord'));
        r.row.classList.toggle('is-compare', lit);
        if (r.index === question.oddIndex && r.devEl) {
          // "E4 · 49 cents too high" -> "E4 · now in tune" -> "E4 · piano"
          setChildren(r.devEl, inTune ? 'now in tune' : other ? tuningShort(compareValue).toLowerCase() : r.devText);
          r.devEl.classList.toggle('is-in-tune', inTune);
          r.devEl.classList.toggle('is-other', other);
        }
      }
    }

    // ---------- Controls ----------
    const playBtn = createPlayButton({ onClick: () => playChordAsPlayed(), label: 'Play', shortcut: 'Space' });
    // One line above the grid: chord name · "Tap a note to hear it alone".
    const chordNameEl = el('span', { class: 'lx-chord-name' });
    const scoreHeading = el('p', { class: 'lx-score-heading' }, chordNameEl,
      el('span', { class: 'lx-score-caption' }, el('span', { class: 'lx-sep', 'aria-hidden': 'true' }, ' · '),
        icon('volume-2', { size: 15 }), ' Tap a note to hear it',
        el('span', { class: 'lx-caption-long' }, ' alone')));
    const score = el('div', { class: 'score lx-score', role: 'group', 'aria-label': 'Which note was out of tune?' });
    const noneBtn = el('button', {
      type: 'button',
      class: 'btn btn-answer btn-none',
      onclick: () => answer(-1, 'none'),
    }, icon('check', { size: 20 }), el('span', { class: 'btn-answer-label' }, 'All in tune'),
    el('span', { class: 'visually-hidden' }, ' (no note was off)'), lxSingleKey(kbd(NONE_KEY)));

    const next = nextButton(() => onNext());

    const compareHolder = el('div', { class: 'lx-compare-holder' });
    const compareNote = el('p', { class: 'compare-note' });
    const compareArea = el('div', { class: 'lx-compare' }, compareHolder, compareNote);

    // ---------- Options (folded into one line with "Change") ----------
    let tuningTag = tagLink({ href: '#/settings', label: tuningWord(getSettings().tuning), title: 'Change in Settings' });
    const tagHolder = el('span', { class: 'tag-holder' }, tuningTag);
    const modeNote = el('p', { class: 'small lx-option-help', role: 'status' });
    const noneToggle = el('input', { type: 'checkbox', role: 'switch', id: uniqueId('ooo-none') });
    noneToggle.checked = mode === 'maybe';
    noneToggle.addEventListener('change', () => {
      mode = noneToggle.checked ? 'maybe' : 'odd';
      setPref('oddOneOut.allowNone', mode === 'maybe');
      let lvl = null;
      try { lvl = progress.loadStaircase(modeKey()).level(); } catch (err) { console.error(err); }
      const amount = lvl != null ? ` — difference now ${centsText(lvl)}` : '';
      modeNote.textContent = mode === 'maybe'
        ? `Separate progress with this switch on${amount}.`
        : `Back to your usual progress${amount}.`;
      optionsChanged();
    });
    const chordSeg = segmented({
      name: 'ooo-chord', legend: 'Chord', options: CHORD_OPTIONS, value: chordKey, compact: true,
      onChange: (v) => { chordKey = v; setPref('oddOneOut.chord', v); optionsChanged(); },
    });
    const styleSeg = segmented({
      name: 'ooo-style', legend: 'Playback', options: STYLE_OPTIONS, value: playStyle, compact: true,
      onChange: (v) => { playStyle = v; setPref('oddOneOut.playStyle', v); if (options) options.update(); },
    });
    const options = createOptionsSummary({
      title: 'Options',
      getSummary: () => [
        (CHORD_OPTIONS.find((o) => o.value === chordKey) || CHORD_OPTIONS[0]).label,
        playStyle === 'arpeggio' ? 'one by one' : 'together',
        VARIANT_SUPPORTED ? (mode === 'maybe' ? 'sometimes all in tune' : 'one note always off') : null,
        tuningWord(getSettings().tuning).toLowerCase(),
      ].filter(Boolean).join(' · '),
      buildPanel: (panel) => {
        panel.append(
          VARIANT_SUPPORTED ? el('div', { class: 'lx-option' },
            el('label', { class: 'switch', for: noneToggle.id }, noneToggle,
              el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
              el('span', {}, 'Sometimes all in tune')),
            modeNote) : null,
          el('div', { class: 'options-row lx-options-row' }, chordSeg.element, styleSeg.element),
          el('div', { class: 'lx-option' }, tagHolder),
        );
      },
      onOpen: () => stopSound(),
      returnFocus: () => primary(),
    });

    function optionsChanged() {
      options.update();
      if (state === 'ready' || state === 'presenting') {
        stopSound();
        newQuestion();
      } else if (state === 'answering') {
        stopSound();
        newQuestion();
        flash('New question with your new settings');
      } else {
        options.setPending(true);
      }
    }

    // ---------- Score (answer grid, highest note on top) ----------
    function buildScore() {
      rows = [];
      const n = question.tones.length;
      const order = question.tones.map((t, i) => i).reverse(); // high -> low
      const rowEls = order.map((index, r) => {
        const tone = question.tones[index];
        const keys = ROW_KEYS_FROM_BOTTOM[n - 1 - r] || [null, null];
        const name = tone.label;
        const lower = name.toLowerCase();
        const flatBtn = el('button', {
          type: 'button', class: 'btn btn-accidental btn-flat', onclick: () => answer(index, 'flat'),
        }, el('span', { class: 'visually-hidden' }, `${name} `),
        el('span', { class: 'acc', 'aria-hidden': 'true' }, '♭'), el('span', {}, 'flat'),
        el('span', { class: 'visually-hidden' }, ' (too low)'), keys[0] ? lxSingleKey(kbd(keys[0])) : null);
        const sharpBtn = el('button', {
          type: 'button', class: 'btn btn-accidental btn-sharp', onclick: () => answer(index, 'sharp'),
        }, el('span', { class: 'visually-hidden' }, `${name} `),
        el('span', { class: 'acc', 'aria-hidden': 'true' }, '♯'), el('span', {}, 'sharp'),
        el('span', { class: 'visually-hidden' }, ' (too high)'), keys[1] ? lxSingleKey(kbd(keys[1])) : null);
        // Listening only — never answers.
        const headBtn = el('button', {
          type: 'button',
          class: 'score-head-btn',
          'aria-label': `Hear the ${lower} alone`,
          title: `Hear the ${lower} alone`,
          onclick: () => playNote(index),
        }, el('span', { class: 'score-head', 'aria-hidden': 'true' }), icon('volume-2', { size: 14, class: 'score-head-icon' }));
        // Note name, filled in only after answering (space reserved, so nothing jumps).
        // Phones show the label in this line too ("Third E4 · too high"); wider screens show it above.
        const nameEl = el('span', { class: 'score-name' }, el('span', { class: 'lx-name-label' }, name));
        const row = el('div', { class: 'score-row' },
          flatBtn,
          el('div', { class: 'score-note' },
            headBtn,
            el('span', { class: 'score-label' }, name),
            nameEl,
          ),
          sharpBtn,
        );
        rows.push({ index, label: name, flatBtn, sharpBtn, headBtn, row, keys, nameEl, devText: null, devEl: null });
        return row;
      });
      setChildren(score, rowEls);
      score.classList.toggle('has-four', n >= 4);
    }

    // ---------- State ----------
    let flashTimer = 0;
    function flash(text) {
      flashLine.textContent = text;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashLine.textContent = ''; }, 3000);
    }
    function syncStatus() {
      status.classList.remove('is-error');
      if (state === 'ready') {
        status.textContent = mode === 'maybe'
          ? 'Press Play. Is one note off, or all in tune?'
          : 'Press Play, then pick the note that is off.';
      } else if (state === 'presenting') status.textContent = 'Listen to the end…';
      else if (state === 'answering') {
        status.textContent = mode === 'maybe' ? 'Which note is off — or is it all in tune?' : 'Which note is off, and which way?';
      } else status.textContent = '';
    }

    function legendText() {
      const single = lxSingleKeysOn();
      if (state === 'ready') return 'Space or Enter: play';
      if (state === 'presenting') return 'Listen to the end… · Esc: stop';
      if (state === 'answering') {
        if (!single) return 'Tab to a note’s ♭ / ♯ button · Space or Enter: play again';
        const n = question.tones.length;
        const pairs = ROW_KEYS_FROM_BOTTOM.slice(0, n).map((k) => k.join('/')).join(', ');
        return [`♭/♯ from the bottom note up: ${pairs}`, mode === 'maybe' ? 'N all in tune' : null, 'R play again']
          .filter(Boolean).join(' · ');
      }
      const compareKeys = hasOdd() ? '1 / 2 / 3: as played / pure / piano' : '1 / 2: pure / piano';
      return ['Enter: next', single ? compareKeys : null, 'Space: play / stop', 'Esc: stop'].filter(Boolean).join(' · ');
    }

    function sync() {
      lxLockAnswers([...rows.flatMap((r) => [r.flatBtn, r.sharpBtn]), noneBtn], state);
      score.classList.toggle('is-locked', state === 'presenting');
      noneBtn.classList.toggle('is-locked', state === 'presenting');
      // After answering, "All in tune" only stays when it was picked or was the answer (saves room).
      const noneUsed = noneBtn.classList.contains('is-chosen') || (question && question.oddIndex < 0);
      noneBtn.hidden = state === 'feedback' ? !noneUsed : (mode !== 'maybe' && !(question && question.oddIndex < 0));
      compareArea.hidden = state !== 'feedback';
      if (!stopProgress) playBtn.setLabel(gatePassed || state === 'presenting' ? 'Play again' : 'Play');
      if (placer) placer.place(state === 'feedback' ? next.element : playBtn.element, { atTop: state !== 'feedback' });
      legend.set(legendText());
      syncStatus();
    }

    function stopSound() {
      lxStopSound(player);
      sustain = null;
      if (compare && compare.playing) compare.setPlaying(false);
      paintCompare();
      if (state === 'presenting' && !gatePassed) {
        clearTimeout(gateTimer);
        state = 'ready';
        sync();
      }
    }

    function primary() { return state === 'feedback' ? next.element : playBtn.element; }
    function focusPrimary() {
      const p = primary();
      if (p && p.isConnected && !p.disabled) p.focus({ preventScroll: true });
    }

    // ---------- Flow ----------
    function newQuestion() {
      clearTimeout(gateTimer);
      if (cancelLevelAnim) { cancelLevelAnim(); cancelLevelAnim = null; }
      if (activeKey !== modeKey()) {
        // "Sometimes all in tune" has its own progress (level, rank, insights).
        activeKey = modeKey();
        staircase = progress.loadStaircase(activeKey);
        missStreak = 0;
        buildPanel();
      }
      const s = getSettings();
      const opts = { cents: staircase.level(), chordKey, tuning: s.tuning, voicePart: voiceArg(s) };
      if (VARIANT_SUPPORTED) opts.allowNone = mode === 'maybe';
      question = ooo.makeQuestion(opts);
      state = 'ready';
      gatePassed = false;
      sustain = null;
      options.setPending(false);
      feedback.clear();
      lxStageReveal(stage, false);
      score.classList.remove('is-answered', 'is-compare-in-tune', 'is-compare-other');
      lxUnmark(noneBtn);
      if (compare) { const c = compare; compare = null; c.destroy(); }
      otherFreqs = null;
      compareHolder.replaceChildren();
      tip.hide();
      buildScore();
      chordNameEl.textContent = `${(CHORD_OPTIONS.find((o) => o.value === chordKey) || CHORD_OPTIONS[0]).label} chord`;
      level.update(question.cents, safeStats());
      updateTag(s.tuning);
      sync();
    }

    function nextQuestion(autoplay) {
      newQuestion();
      if (autoplay) {
        playChordAsPlayed();
        playBtn.element.focus({ preventScroll: true });
      }
      reveal(screen.querySelector('.screen-head'), score, actionBar.element);
    }

    function onNext() {
      const shown = summary.maybeShow(summarySlot, {
        onKeepGoing: () => nextQuestion(true),
        onDone: () => { window.location.hash = '#/stats'; },
      });
      if (!shown) nextQuestion(true);
    }

    function detailFor(index, direction) {
      if (typeof ooo.answerDetail === 'function') {
        try { return ooo.answerDetail(question, { index, direction }); } catch (err) { console.error(err); }
      }
      return { midi: null, direction: question.direction, answer: direction, chordKey: question.chordKey, cents: question.cents };
    }

    function answer(index, direction) {
      if (state === 'presenting') { flash('Listen to the end…'); return; }
      if (state !== 'answering') return;
      if (direction === 'none' && noneBtn.hidden) return;
      state = 'feedback';
      clearTimeout(gateTimer);
      const result = ooo.checkAnswer(question, { index, direction });
      const lvl = lxLevelOf(result);
      const fromLevel = staircase.level();
      const rec = progress.recordResult(activeKey, staircase, { correct: result.correct, detail: detailFor(index, direction) });

      // 0 ms: button states (✓ on the right answer, neutral ✗ on a miss — never red).
      score.classList.add('is-answered');
      for (const r of rows) {
        const isOdd = r.index === question.oddIndex;
        r.row.classList.toggle('is-odd', isOdd);
        const rightBtn = isOdd ? (question.direction === 'sharp' ? r.sharpBtn : r.flatBtn) : null;
        const chosenBtn = r.index === index ? (direction === 'sharp' ? r.sharpBtn : r.flatBtn) : null;
        for (const b of [r.flatBtn, r.sharpBtn]) {
          lxMark(b, { right: b === rightBtn, chosen: b === chosenBtn, level: lvl });
        }
      }
      // "All in tune" already shows a check mark of its own.
      lxMark(noneBtn, { right: !hasOdd(), chosen: direction === 'none', level: lvl, iconWhenRight: false });

      // Note names spelled for the chord; deviation only on the off note.
      if (typeof ooo.describe === 'function') {
        try {
          const d = ooo.describe(question);
          if (d && d.heading) chordNameEl.textContent = d.heading;
          showNoteNames(d);
        } catch (err) { console.error(err); }
      }

      const note = rec ? lxLevelNote(activeKey, rec.direction) : '';
      feedback.show({
        level: lvl,
        message: result.message,
        detail: note ? el('p', { class: 'feedback-note' }, note) : null,
      });

      buildCompare();
      const levelNow = rec ? rec.level : staircase.level();
      summary.record({ correct: result.correct, levelCents: levelNow });
      cancelLevelAnim = lxUpdateLevel(level, {
        from: fromLevel, to: levelNow, stats: rec ? rec.stats : safeStats(),
        direction: rec && rec.moved !== false ? rec.direction : null,
      });
      progressPanel.update();
      const streak = rec && rec.stats && Number.isFinite(rec.stats.missStreak) ? rec.stats.missStreak : null;
      missStreak = streak != null ? streak : (result.correct ? 0 : missStreak + 1);
      maybeTip();
      sync();
      lxStageReveal(stage);
      const oddRow = rows.find((r) => r.index === question.oddIndex);
      const keepRow = oddRow && lxFitsInView(oddRow.row, compareArea) ? oddRow.row : null;
      next.focusAfterFeedback(feedback.id, keepRow, compareArea);
    }

    // Name line under each label: "D4"; the off note "A4 · 49 cents too high" (phones: "A4 · too high";
    // the amount is in the feedback message). While "In tune" sounds it reads "A4 · now in tune".
    function showNoteNames(desc) {
      const tones = desc && Array.isArray(desc.tones) ? desc.tones : null;
      for (const r of rows) {
        const t = tones && tones[r.index];
        r.devText = null;
        r.devEl = null;
        const label = el('span', { class: 'lx-name-label' }, `${r.label} `);
        if (!t) { setChildren(r.nameEl, label); continue; }
        const name = el('span', { class: 'lx-note-name' }, t.name || '');
        if (t.isOff && t.deviation) {
          const c = Math.abs(Number(t.deviation.cents));
          const way = t.deviation.cents > 0 ? 'too high' : 'too low';
          r.devText = Number.isFinite(c) ? [el('span', { class: 'lx-dev-amount' }, `${centsText(c)} `), way] : [t.deviation.text];
          r.devEl = el('span', { class: 'lx-dev' }, r.devText);
          setChildren(r.nameEl, label, name, el('span', { class: 'lx-sep', 'aria-hidden': 'true' }, ' · '), r.devEl);
        } else {
          setChildren(r.nameEl, label, name);
        }
      }
    }

    function buildCompare() {
      const odd = hasOdd() ? question.tones[question.oddIndex] : null;
      const oddName = odd ? odd.label.toLowerCase() : '';
      compareValue = 'played';
      compareScope = 'chord';
      // The same chord in the other tuning: same root, buildChord in the other tuning (low -> high,
      // like question.tones).
      const mine = question.tuning === TUNINGS.EQUAL ? TUNINGS.EQUAL : TUNINGS.JUST;
      const theirs = otherTuning(mine);
      try {
        const root = question.tones.find((t) => t.intervalKey === 'P1') || question.tones[0];
        const chord = buildChord(root.correctFreq, question.chordKey, theirs);
        otherFreqs = chord.length === question.tones.length ? chord.map((t) => t.freq) : null;
      } catch (err) {
        console.error(err);
        otherFreqs = null;
      }
      // Fixed order Pure | Piano (as in Lock it in); the chosen tuning is marked as the in-tune one.
      const tuningOption = (t, key) => ({
        value: t,
        label: t === mine ? `${tuningShort(t)} (${odd ? 'in tune' : 'as played'})` : tuningShort(t),
        key,
      });
      const tuningOptions = otherFreqs ? [TUNINGS.JUST, TUNINGS.EQUAL] : [mine];
      const options = odd
        ? [{ value: 'played', label: 'As played', key: '1' }, ...tuningOptions.map((t, i) => tuningOption(t, String(i + 2)))]
        : tuningOptions.map((t, i) => tuningOption(t, String(i + 1)));
      compare = createCompareSwitch({
        label: odd ? `Compare the ${oddName} as played, pure and piano` : 'Compare pure and piano',
        options,
        scopes: odd ? [{ value: 'chord', label: 'Whole chord' }, { value: 'note', label: `Just the ${oddName}` }] : undefined,
        onChange: (value, scope) => playCompare(value, scope),
        onStop: () => { lxStopSound(player); sustain = null; paintCompare(); },
      });
      // "(in tune)" / "(as played)" as a small tag, so it can sit on its own line on phones.
      const mineInput = Array.from(compare.element.querySelectorAll('input[type="radio"]')).find((i) => i.value === mine);
      const mineText = mineInput && mineInput.nextElementSibling && mineInput.nextElementSibling.querySelector('span');
      if (mineText) {
        setChildren(mineText, tuningShort(mine), ' ',
          el('span', { class: 'lx-tune-tag' }, odd ? '(in tune)' : '(as played)'));
      }
      compareHolder.replaceChildren(compare.element);
      compareNote.textContent = odd
        ? `Switch versions and listen to the ${oddName} settle into the chord. Pure is how a choir tunes; piano has equal steps.`
        : 'Every note was in tune. Compare: pure is how a choir tunes; piano has equal steps.';
      lxCompareNoteSeen('odd-one-out', compareNote);
    }

    function maybeTip() {
      if (!lxShouldTip(activeKey, missStreak)) return;
      const key = activeKey;
      tip.set({
        actions: [
          {
            label: 'Make it easier',
            onClick: () => {
              const st = lxMakeEasier(key);
              if (st && key === activeKey) {
                staircase = st;
                missStreak = 0;
                if (cancelLevelAnim) { cancelLevelAnim(); cancelLevelAnim = null; }
                level.update(staircase.level(), safeStats());
                flash('Next difference: a little bigger.');
              }
              next.element.focus({ preventScroll: true });
            },
          },
          { label: 'Not now', onClick: () => { next.element.focus({ preventScroll: true }); } },
        ],
      });
      tip.show();
    }

    function safeStats() {
      try { return progress.getStats(activeKey); } catch (err) { console.error(err); return null; }
    }

    function updateTag(tuning) {
      const fresh = tagLink({ href: '#/settings', label: tuningWord(tuning), title: 'Change in Settings' });
      tuningTag.replaceWith(fresh);
      tuningTag = fresh;
    }

    const unsubscribe = onSettingsChange((s) => {
      // A tuning change applies from the next question on; show it right away.
      updateTag(s.tuning);
      options.update();
    });

    const taskLine = lxTaskLine('One note is out of tune. Which one — and is it too high or too low?',
      'Which note is off — too high or too low?');

    // Each mode has its own progress (staircase, rank, insights).
    const panelHolder = el('div', { class: 'panel-holder' });
    let progressPanel = null;
    function buildPanel() {
      progressPanel = chapterProgressPanel(activeKey, {
        onReset: () => {
          stopSound();
          staircase = progress.loadStaircase(activeKey);
          newQuestion();
        },
      });
      panelHolder.replaceChildren(progressPanel.element);
    }
    buildPanel();

    // ---------- Keyboard (the compare switch handles 1 / 2 and Space itself in Feedback) ----------
    const answerKey = (k) => {
      if (state !== 'answering' && state !== 'presenting') return false;
      const key = k.toUpperCase();
      for (const r of rows) {
        if (key === r.keys[0]) { answer(r.index, 'flat'); return true; }
        if (key === r.keys[1]) { answer(r.index, 'sharp'); return true; }
      }
      if (key === NONE_KEY && !noneBtn.hidden) { answer(-1, 'none'); return true; }
      return false;
    };
    const shortcutMap = {
      ' ': () => {
        if (state === 'feedback' || pause.isShown) return false;
        playChordAsPlayed();
        return true;
      },
      Enter: () => {
        if (pause.isShown) return false;
        if (state === 'feedback') next.trigger();
        else playChordAsPlayed();
        return true;
      },
      r: () => {
        if (pause.isShown) return false;
        playChordAsPlayed();
        return true;
      },
    };
    for (const k of [...ROW_KEYS_FROM_BOTTOM.flat(), NONE_KEY]) shortcutMap[k.toLowerCase()] = () => answerKey(k);
    const removeShortcuts = installShortcuts(shortcutMap, {});
    // Esc: stop the sound (the options panel and the compare switch handle their own Esc first).
    const removeEscape = onEscape(() => {
      if (!player.playing && state !== 'presenting') return false;
      stopSound();
      return true;
    });

    // ---------- Paused ----------
    const pause = lxPause({
      isBusy: () => player.playing || state === 'presenting',
      onHide: () => stopSound(),
      onContinue: () => focusPrimary(),
    });

    // ---------- Layout ----------
    const stage = el('div', { class: 'stage lx-stage' },
      pause.element,
      status,
      scoreHeading,
      score,
      noneBtn,
      flashLine,
      feedback.element,
      compareArea,
      tip.element,
      summarySlot,
      actionBar.element,
      legend.element,
    );
    const screen = el('section', { class: 'screen exercise lx-screen lx-ooo' },
      el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Odd one out', headLevel),
          taskLine,
        ),
        level.element,
      ),
      options.element,
      stage,
      helpBox({ summary: 'How it works' },
        el('p', {}, 'You hear a chord. One note is a little too high (♯ sharp) or too low (♭ flat); the others are perfectly in tune. The highest note is on top, like a score.'),
        VARIANT_SUPPORTED ? el('p', {}, 'With "Sometimes all in tune" on, sometimes nothing is off. Then the answer is "All in tune". With this switch on, you have separate progress and a separate rank.') : null,
        el('p', {}, 'Tap a note head to hear that note alone. It never counts as an answer. Notes light up while they sound.'),
        el('p', {}, 'Tip: listen for the note that makes the chord wobble. "One by one, then together" plays the notes separately first.'),
        CHORD_OPTIONS.some((o) => o.value === 'dom7')
          ? el('p', {}, `Seventh chords add a fourth note on top: the seventh. In a dominant 7th, choirs (and barbershop quartets) sing it about ${SEVENTH_GAP} cents lower than the piano. That low seventh makes the chord ring.`)
          : null,
        el('p', {}, 'After answering, switch between "As played", "Pure" and "Piano" — for the whole chord or just the off note. Pure is how a choir tunes; piano has equal steps. Your tuning setting is the one marked "in tune". 100 cents = one semitone.'),
        el('p', { class: 'muted small' }, `Keys: Space or Enter = play. Flat / sharp per note, from the bottom note up: Z / X, A / S, Q / W, and 7 / 8 for a seventh${VARIANT_SUPPORTED ? '; N = all in tune' : ''}; R = play again. After answering: Enter = next, 1 / 2 / 3 = as played / pure / piano, Space = play / stop, Esc = stop.`),
      ),
      panelHolder,
    );

    placer = lxPrimaryPlacer(actionBar, { top: status, bottom: legend.element, onChange: () => sync() });
    const unwatchKeys = lxWatchSingleKeys(screen, () => legend.set(legendText()));
    const unmirrorLevel = lxInlineLevel(level, headLevel);
    newQuestion();
    container.append(screen);
    // Keyboard: after a mouse change of an option go back to Play / Next; after comparing
    // (or a note head once answered), to Next.
    const removeRefocus = refocusAfterPointerChange(screen, primary);
    refocusAfterClick(compareArea, () => next.element);
    refocusAfterClick(score, () => (state === 'feedback' ? next.element : null));

    return () => {
      clearTimeout(gateTimer);
      clearTimeout(flashTimer);
      if (cancelLevelAnim) cancelLevelAnim();
      if (compare) { const c = compare; compare = null; c.destroy(); }
      if (resolveBusy) resolveBusy();
      removeRefocus();
      unsubscribe();
      removeShortcuts();
      removeEscape();
      pause.destroy();
      placer.destroy();
      unwatchKeys();
      unmirrorLevel();
      player.destroy();
    };
  },
};
