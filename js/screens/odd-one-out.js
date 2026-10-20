// "Odd one out" (#/odd-one-out)
// A chord with exactly one note slightly sharp or flat — or, with "Include 'all in tune'",
// possibly none: find it, then compare as played / in tune.

// Namespace imports: round-5 additions (describe, answerDetail, allowNone, sevenths) are feature-checked.
import * as ooo from '../exercise/odd-one-out.js';
import { loadStaircase, recordResult, getStats } from '../exercise/progress.js';
import { playChord, playTone } from '../audio/engine.js';
import { TUNINGS, CHORDS, INTERVALS } from '../music/tuning.js';
import { getSettings, onSettingsChange, getPref, setPref } from '../storage.js';
import { el, setChildren, reveal } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { segmented, helpBox, tagLink, installShortcuts, kbd } from '../ui/components.js';
import { createPlayButton, nextButton, createFeedback, createLevelDisplay, soundedLine } from '../ui/exercise.js';
import { createPlayer } from '../ui/player.js';
import { trackHighlights, chordPlan } from '../ui/highlight.js';
import { chapterProgressPanel } from '../ui/chapter-progress.js';
import { voiceArg } from '../ui/voices.js';
import { describeFreq } from '../ui/notes.js';

const MODES = {
  odd: { key: 'odd-one-out', label: 'One note is off' },
  maybe: { key: 'odd-or-in-tune', label: 'Maybe all in tune' },
};
const VARIANT_SUPPORTED = typeof ooo.describe === 'function';

const CHORD_SECONDS = 4.5;    // full-chord part
const ARPEGGIO_SECONDS = 0.6;
const NOTE_SECONDS = 1.6;     // a single note heard alone
// Answer keys per row, counted from the BOTTOM row up (the keyboard's rows mirror the score):
// bottom Z / X, then A / S, Q / W, and 1 / 2 for a fourth (top) note.
const ROW_KEYS_FROM_BOTTOM = [['Z', 'X'], ['A', 'S'], ['Q', 'W'], ['1', '2']];
const NONE_KEY = 'N';

const CHORD_OPTIONS = [
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
  { value: 'dom7', label: 'Dom 7th' },
  { value: 'maj7', label: 'Maj 7th' },
  { value: 'min7', label: 'Min 7th' },
].filter((o) => Object.prototype.hasOwnProperty.call(CHORDS, o.value));
const STYLE_OPTIONS = [
  { value: 'together', label: 'Together' },
  { value: 'arpeggio', label: 'One by one, then together' },
];

const LEVEL_NOTE = {
  harder: 'The next difference will be a little smaller.',
  easier: 'The next difference will be a little bigger.',
  same: '',
};

function tuningTagLabel(tuning) {
  return tuning === TUNINGS.EQUAL ? 'Tuning: piano' : 'Tuning: pure (choir)';
}

// How much lower the barbershop (harmonic) seventh is than the piano's, for the help text.
const SEVENTH_GAP = INTERVALS.h7 ? Math.round(INTERVALS.h7.equalCents - INTERVALS.h7.justCents) : 31;

export default {
  id: 'odd-one-out',
  title: 'Odd one out',

  render(container) {
    // "Include 'all in tune'": ON by default; a saved choice wins (also the older mode switch).
    let savedNone = getPref('oddOneOut.allowNone', null);
    if (typeof savedNone !== 'boolean') {
      const oldMode = getPref('oddOneOut.mode', null);
      savedNone = oldMode ? oldMode === 'maybe' : true;
    }
    let mode = VARIANT_SUPPORTED && savedNone ? 'maybe' : 'odd';
    const modeKey = () => MODES[mode].key;
    let staircase = loadStaircase(modeKey());
    let chordKey = getPref('oddOneOut.chord', 'major');
    if (!CHORD_OPTIONS.some((o) => o.value === chordKey)) chordKey = 'major';
    let playStyle = getPref('oddOneOut.playStyle', 'together');
    if (!STYLE_OPTIONS.some((o) => o.value === playStyle)) playStyle = 'together';

    let question = null;
    let state = 'ready'; // 'ready' | 'heard' | 'answered'
    let rows = [];        // [{ index, flatBtn, sharpBtn, headBtn, row, verdict, keys }] top row first

    const level = createLevelDisplay({ label: 'Difference' });
    const feedback = createFeedback();
    const sounded = el('div', { class: 'sounded' });

    // Shows 'Loading sound…' (recorded sounds) or a playback problem under the Play button.
    const loadLine = el('p', { class: 'stage-status', role: 'status' });
    loadLine.hidden = true;

    const player = createPlayer({
      onChange: (s) => {
        loadLine.textContent = s.error || (s.loading ? 'Loading sound…' : '');
        loadLine.hidden = !loadLine.textContent;
        loadLine.classList.toggle('is-error', !!s.error);
        const tag = s.playing ? s.tag : null;
        playBtn.setPlaying(tag === 'played' && state !== 'answered');
        playedBtn.classList.toggle('is-playing', tag === 'played');
        inTuneBtn.classList.toggle('is-playing', tag === 'in-tune');
        notePlayedBtn.classList.toggle('is-playing', tag === 'note-played');
        noteInTuneBtn.classList.toggle('is-playing', tag === 'note-in-tune');
        score.classList.toggle('is-in-tune', tag === 'in-tune' || tag === 'note-in-tune');
        if (s.playing && state === 'ready') {
          state = 'heard';
          playBtn.setLabel('Play again');
          sync();
        }
      },
    });

    // Light up the note heads that are sounding right now.
    function lightUp(keys) {
      for (const r of rows) r.row.classList.toggle('is-sounding', keys.has(r.index));
    }

    const freqsOf = (which) => question.tones.map((t) => (which === 'correct' ? t.correctFreq : t.freq));
    const hasOdd = () => question && question.oddIndex >= 0;

    const chordStep = (tag, which) => ({
      tag,
      start: () => {
        const arpeggio = playStyle === 'arpeggio' ? ARPEGGIO_SECONDS : 0;
        const h = playChord(freqsOf(which), { duration: CHORD_SECONDS, arpeggio, timbre: getSettings().timbre });
        trackHighlights(h, chordPlan(question.tones.length, CHORD_SECONDS, arpeggio), lightUp);
        return h;
      },
    });
    const noteStep = (tag, index, which) => ({
      tag,
      start: () => {
        const t = question.tones[index];
        const h = playTone(which === 'correct' ? t.correctFreq : t.freq, { duration: NOTE_SECONDS, timbre: getSettings().timbre });
        trackHighlights(h, [{ key: index, start: 0, end: NOTE_SECONDS }], lightUp);
        return h;
      },
    });

    const playAsPlayed = () => player.play([chordStep('played', 'played')]);
    const playInTune = () => player.play([chordStep('in-tune', 'correct')]);
    const playNote = (index, which = 'played') => {
      const odd = state === 'answered' && index === question.oddIndex;
      const tag = odd ? (which === 'correct' ? 'note-in-tune' : 'note-played') : 'note';
      return player.play([noteStep(tag, index, which)]);
    };

    // ---------- Controls ----------
    const playBtn = createPlayButton({ onClick: playAsPlayed, label: 'Play', shortcut: 'Space' });
    const hint = el('p', { class: 'stage-hint' }, 'Press Play, then pick the note that is off. Tap a note head to hear that note alone.');
    const score = el('div', { class: 'score', role: 'group', 'aria-label': 'Which note was out of tune?' });
    const noneBtn = el('button', {
      type: 'button',
      class: 'btn btn-answer btn-none',
      'aria-label': 'Answer: all notes were in tune',
      onclick: () => answer(-1, 'none'),
    }, icon('check', { size: 20 }), el('span', { class: 'btn-answer-label' }, 'All in tune'), kbd(NONE_KEY));

    const playedBtn = el('button', { type: 'button', class: 'btn btn-compare', onclick: playAsPlayed },
      icon('play', { size: 18 }), 'As played', kbd('1'));
    const inTuneBtn = el('button', { type: 'button', class: 'btn btn-compare btn-in-tune', onclick: playInTune },
      icon('check', { size: 18 }), 'In tune', kbd('2'));
    const notePlayedBtn = el('button', { type: 'button', class: 'btn btn-compare', onclick: () => playNote(question.oddIndex, 'played') },
      icon('play', { size: 18 }), 'As played', kbd('3'));
    const noteInTuneBtn = el('button', { type: 'button', class: 'btn btn-compare btn-in-tune', onclick: () => playNote(question.oddIndex, 'correct') },
      icon('check', { size: 18 }), 'In tune', kbd('4'));
    const chordCompareLabel = el('span', { class: 'compare-label' }, 'Whole chord');
    const noteCompareLabel = el('span', { class: 'compare-label' });
    const compareNote = el('p', { class: 'compare-note' });
    const next = nextButton({ onClick: () => nextQuestion(true) });
    const after = el('div', { class: 'after-answer' },
      compareNote,
      el('div', { class: 'compare-grid', role: 'group', 'aria-label': 'Compare as played and in tune' },
        chordCompareLabel, playedBtn, inTuneBtn,
        noteCompareLabel, notePlayedBtn, noteInTuneBtn,
      ),
      next,
    );

    let tuningTag = tagLink({ href: '#/settings', label: tuningTagLabel(getSettings().tuning), title: 'Change tuning in Settings' });
    const tagHolder = el('span', { class: 'tag-holder' }, tuningTag);

    // "Include 'all in tune'" switch (remembered), like Higher / lower's "Include 'same'".
    const noneToggle = el('input', { type: 'checkbox', role: 'switch', id: 'ooo-none' });
    noneToggle.checked = mode === 'maybe';
    noneToggle.addEventListener('change', () => switchMode(noneToggle.checked ? 'maybe' : 'odd'));
    const noneSwitch = VARIANT_SUPPORTED
      ? el('label', { class: 'switch', for: 'ooo-none' }, noneToggle, el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        el('span', {}, 'Include "all in tune"'))
      : null;
    const chordSeg = segmented({
      name: 'ooo-chord',
      legend: 'Chord',
      options: CHORD_OPTIONS,
      value: chordKey,
      compact: true,
      onChange: (v) => {
        chordKey = v;
        setPref('oddOneOut.chord', v);
        player.stop();
        newQuestion();
      },
    });
    const styleSeg = segmented({
      name: 'ooo-style',
      legend: 'Playback',
      options: STYLE_OPTIONS,
      value: playStyle,
      compact: true,
      onChange: (v) => {
        playStyle = v;
        setPref('oddOneOut.playStyle', v);
      },
    });

    // ---------- Score (answer grid, highest note on top) ----------
    function buildScore() {
      rows = [];
      const n = question.tones.length;
      const order = question.tones.map((t, i) => i).reverse(); // high -> low
      const rowEls = order.map((index, r) => {
        const tone = question.tones[index];
        const keys = ROW_KEYS_FROM_BOTTOM[n - 1 - r] || [null, null];
        const name = tone.label;
        const flatBtn = el('button', {
          type: 'button',
          class: 'btn btn-accidental btn-flat',
          'aria-label': `Answer: the ${name.toLowerCase()} was flat (too low)`,
          onclick: () => answer(index, 'flat'),
        }, el('span', { class: 'acc', 'aria-hidden': 'true' }, '♭'), el('span', {}, 'flat'), keys[0] ? kbd(keys[0]) : null);
        const sharpBtn = el('button', {
          type: 'button',
          class: 'btn btn-accidental btn-sharp',
          'aria-label': `Answer: the ${name.toLowerCase()} was sharp (too high)`,
          onclick: () => answer(index, 'sharp'),
        }, el('span', { class: 'acc', 'aria-hidden': 'true' }, '♯'), el('span', {}, 'sharp'), keys[1] ? kbd(keys[1]) : null);
        // Listening only — never answers.
        const headBtn = el('button', {
          type: 'button',
          class: 'score-head-btn',
          'aria-label': `Listen: hear the ${name.toLowerCase()} alone`,
          title: `Hear the ${name.toLowerCase()} alone`,
          onclick: () => playNote(index, 'played'),
        }, el('span', { class: 'score-head', 'aria-hidden': 'true' }), icon('volume-2', { size: 12, class: 'score-head-icon' }));
        const verdict = el('span', { class: 'score-verdict' });
        const row = el('div', { class: 'score-row' },
          flatBtn,
          el('div', { class: 'score-note' },
            verdict,
            headBtn,
            el('span', { class: 'score-label' }, name),
          ),
          sharpBtn,
        );
        rows.push({ index, flatBtn, sharpBtn, headBtn, row, verdict, keys });
        return row;
      });
      setChildren(score, rowEls);
      score.classList.toggle('has-four', n >= 4);
    }

    function sync() {
      const canAnswer = state === 'heard';
      for (const r of rows) {
        r.flatBtn.disabled = !canAnswer;
        r.sharpBtn.disabled = !canAnswer;
      }
      noneBtn.hidden = mode !== 'maybe';
      noneBtn.disabled = !canAnswer;
      after.hidden = state !== 'answered';
      hint.hidden = state !== 'ready';
      hint.textContent = mode === 'maybe'
        ? 'Press Play. Is one note off — or is everything in tune? Tap a note head to hear that note alone.'
        : 'Press Play, then pick the note that is off. Tap a note head to hear that note alone.';
      playBtn.element.hidden = state === 'answered';
    }

    // ---------- Flow ----------
    function newQuestion() {
      const s = getSettings();
      const opts = { cents: staircase.level(), chordKey, tuning: s.tuning, voicePart: voiceArg(s) };
      if (VARIANT_SUPPORTED) opts.allowNone = mode === 'maybe';
      question = ooo.makeQuestion(opts);
      state = 'ready';
      playBtn.setLabel('Play');
      feedback.clear();
      sounded.replaceChildren();
      score.classList.remove('is-answered');
      noneBtn.classList.remove('is-chosen', 'is-right', 'is-wrong');
      buildScore();
      level.update(question.cents, safeStats());
      updateTag(s.tuning);
      sync();
    }

    function nextQuestion(autoplay) {
      newQuestion();
      // Bring the question (title, level, Play) back into view.
      reveal(screen, playBtn.element);
      if (autoplay) {
        playAsPlayed();
        playBtn.element.focus({ preventScroll: true });
      }
    }

    function detailFor(index, direction) {
      if (typeof ooo.answerDetail === 'function') {
        try { return ooo.answerDetail(question, { index, direction }); } catch (err) { console.error(err); }
      }
      const root = question.tones[0];
      const odd = hasOdd() ? question.tones[question.oddIndex] : null;
      const picked = index >= 0 ? question.tones[index] : null;
      const d = describeFreq(root.correctFreq);
      return {
        midi: d ? d.midi : null,
        toneLabel: odd ? odd.label : null,
        direction: question.direction,
        answer: picked && direction !== 'none' ? `${picked.label} ${direction}` : 'none',
        chordKey: question.chordKey,
        cents: question.cents,
      };
    }

    function answer(index, direction) {
      if (state !== 'heard') return;
      if (direction === 'none' && mode !== 'maybe') return;
      state = 'answered';
      const result = ooo.checkAnswer(question, { index, direction });
      const rec = recordResult(modeKey(), staircase, { correct: result.correct, detail: detailFor(index, direction) });

      score.classList.add('is-answered');
      for (const r of rows) {
        if (r.index === question.oddIndex) {
          r.row.classList.add('is-odd');
          r.verdict.textContent = question.direction === 'sharp' ? '♯ too high' : '♭ too low';
          (question.direction === 'sharp' ? r.sharpBtn : r.flatBtn).classList.add('is-right');
        }
        if (r.index === index) {
          const chosen = direction === 'sharp' ? r.sharpBtn : r.flatBtn;
          chosen.classList.add('is-chosen');
          if (!result.correct) chosen.classList.add('is-wrong');
        }
      }
      if (!hasOdd()) noneBtn.classList.add('is-right');
      if (direction === 'none') {
        noneBtn.classList.add('is-chosen');
        if (!result.correct) noneBtn.classList.add('is-wrong');
      }

      const note = rec && LEVEL_NOTE[rec.direction];
      feedback.show({
        correct: result.correct,
        message: result.message,
        details: note ? el('p', { class: 'feedback-note' }, note) : null,
      });
      if (typeof ooo.describe === 'function') {
        try {
          const desc = ooo.describe(question);
          const heading = String(desc.title || '').replace(/\s*\(root[^)]*\)\s*$/i, '');
          setChildren(sounded, soundedLine(desc, { heading }));
        } catch (err) { console.error(err); }
      }

      // Compare section: with nothing off, as played = in tune, so just offer a replay.
      const odd = hasOdd() ? question.tones[question.oddIndex] : null;
      inTuneBtn.hidden = !odd;
      noteCompareLabel.hidden = !odd;
      notePlayedBtn.hidden = !odd;
      noteInTuneBtn.hidden = !odd;
      setChildren(playedBtn, icon('play', { size: 18 }), odd ? 'As played' : 'Hear it again', kbd('1'));
      if (odd) {
        const oddName = odd.label.toLowerCase();
        noteCompareLabel.textContent = `The ${oddName} alone`;
        compareNote.textContent = `Flip between "as played" and "in tune" and listen to the ${oddName}: hear how it settles into the chord.`;
      } else {
        compareNote.textContent = 'Every note was in tune — listen again to how calm a well-tuned chord sounds.';
      }
      level.update(rec ? rec.level : staircase.level(), rec ? rec.stats : safeStats());
      progressPanel.update();
      sync();
      next.focus(); // Enter/Space = Next; also scrolls it into view
    }

    function safeStats() {
      try { return getStats(modeKey()); } catch (err) { console.error(err); return null; }
    }

    function updateTag(tuning) {
      const fresh = tagLink({ href: '#/settings', label: tuningTagLabel(tuning), title: 'Change tuning in Settings' });
      tuningTag.replaceWith(fresh);
      tuningTag = fresh;
    }

    const unsubscribe = onSettingsChange((s) => {
      // A tuning change applies from the next question on; show it right away.
      updateTag(s.tuning);
    });

    const taskLine = el('p', { class: 'task' });
    function renderTask() {
      taskLine.textContent = mode === 'maybe'
        ? 'Is one note of the chord out of tune — and which way? Or is everything in tune?'
        : 'One note of the chord is out of tune. Which one — and is it too low (♭ flat) or too high (♯ sharp)?';
    }
    renderTask();

    // Each mode has its own progress (staircase, rank, insights).
    const panelHolder = el('div', { class: 'panel-holder' });
    let progressPanel = null;
    function buildPanel() {
      progressPanel = chapterProgressPanel(modeKey(), {
        onReset: () => {
          player.stop();
          staircase = loadStaircase(modeKey());
          newQuestion();
        },
      });
      panelHolder.replaceChildren(progressPanel.element);
    }
    buildPanel();

    function switchMode(v) {
      if (v === mode) return;
      mode = v;
      renderTask();
      setPref('oddOneOut.allowNone', v === 'maybe');
      player.stop();
      staircase = loadStaircase(modeKey());
      buildPanel();
      newQuestion();
    }

    // ---------- Keyboard ----------
    const removeShortcuts = installShortcuts((e) => {
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (k === ' ' || k === 'Enter') {
        if (state === 'answered') nextQuestion(true);
        else playAsPlayed();
        return true;
      }
      if (state === 'heard') {
        for (const r of rows) {
          if (k === r.keys[0]) { answer(r.index, 'flat'); return true; }
          if (k === r.keys[1]) { answer(r.index, 'sharp'); return true; }
        }
        if (k === NONE_KEY && mode === 'maybe') { answer(-1, 'none'); return true; }
      }
      if (state === 'answered') {
        if (k === '1') { playAsPlayed(); return true; }
        if (k === '2' && hasOdd()) { playInTune(); return true; }
        if (k === '3' && hasOdd()) { playNote(question.oddIndex, 'played'); return true; }
        if (k === '4' && hasOdd()) { playNote(question.oddIndex, 'correct'); return true; }
      }
      if (k === 'R') { playAsPlayed(); return true; }
      return false;
    });

    // ---------- Layout ----------
    const screen = el('section', { class: 'screen exercise' },
      el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Odd one out'),
          taskLine,
        ),
        level.element,
      ),
      noneSwitch ? el('div', { class: 'options-row' }, noneSwitch) : null,
      el('div', { class: 'options-row' }, chordSeg.element, styleSeg.element, tagHolder),
      el('div', { class: 'stage' },
        playBtn.element,
        loadLine,
        hint,
        score,
        noneBtn,
        feedback.element,
        sounded,
        after,
      ),
      helpBox({ summary: 'How it works' },
        el('p', {}, 'You hear a chord. One note is pushed slightly up (sharp) or down (flat); the others are perfectly in tune with each other. The buttons are laid out like a little score: the highest note is on top.'),
        VARIANT_SUPPORTED ? el('p', {}, 'With "Include all in tune" on, sometimes nothing is off — then the right answer is "All in tune". On and off each keep their own level, rank and progress.') : null,
        el('p', {}, 'Tap a note head (the round note in the middle) to hear just that note — it never counts as an answer. Notes light up while they sound.'),
        el('p', {}, 'Tip: listen for the note that makes the chord "wobble" or sound restless. "One by one, then together" plays the notes separately first, which makes it easier to follow each one.'),
        CHORD_OPTIONS.some((o) => o.value === 'dom7')
          ? el('p', {}, `Seventh chords have a fourth note on top, the seventh. In a dominant 7th ("Dom 7th") a choir — and especially a barbershop quartet — sings the seventh much lower than a piano plays it: about ${SEVENTH_GAP} cents lower. That low "barbershop seventh" makes the chord ring without any wobble. In pure tuning you hear that low seventh here.`)
          : null,
        el('p', {}, 'After answering you see which notes sounded. Flip between "as played" and "in tune" — for the whole chord and for the odd note alone. That before/after comparison is where the real learning happens.'),
        el('p', { class: 'muted small' }, `Keys: Space = play / next. Flat / sharp per note, from the bottom note up: Z / X, A / S, Q / W, and 1 / 2 for a fourth note${VARIANT_SUPPORTED ? '; N = all in tune' : ''}. After answering: 1 / 2 = chord as played / in tune, 3 / 4 = odd note as played / in tune.`),
      ),
      panelHolder,
    );

    newQuestion();
    container.append(screen);

    return () => {
      unsubscribe();
      removeShortcuts();
      player.destroy();
    };
  },
};
