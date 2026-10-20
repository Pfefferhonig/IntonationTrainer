// "Higher or lower?" (#/higher-or-lower)
// Two notes: the second is the same note pushed slightly sharp or flat — or, with
// "Include 'same'", sometimes exactly the same.

// Namespace import: round-5 additions (describe, answerDetail, allowSame) are feature-checked.
import * as hl from '../exercise/higher-lower.js';
import { loadStaircase, recordResult, getStats } from '../exercise/progress.js';
import { playSequence } from '../audio/engine.js';
import { getSettings, getPref, setPref } from '../storage.js';
import { el, reveal, setChildren } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { helpBox, installShortcuts, kbd } from '../ui/components.js';
import {
  createPlayButton, answerButton, nextButton, createFeedback, createLevelDisplay, soundedLine,
} from '../ui/exercise.js';
import { createPlayer } from '../ui/player.js';
import { chapterProgressPanel } from '../ui/chapter-progress.js';
import { voiceArg } from '../ui/voices.js';
import { describeFreq } from '../ui/notes.js';

const KEY = 'higher-or-lower';
const NOTE_SECONDS = 1.0;
const GAP_SECONDS = 0.35;
// The "same" answer needs the round-5 logic (it throws on 'same' otherwise).
const SAME_SUPPORTED = typeof hl.describe === 'function';

const LEVEL_NOTE = {
  harder: 'The next difference will be a little smaller.',
  easier: 'The next difference will be a little bigger.',
  same: '',
};

export default {
  id: KEY,
  title: 'Higher or lower?',

  render(container) {
    let staircase = loadStaircase(KEY);
    let question = null;
    let state = 'ready'; // 'ready' (not heard yet) | 'heard' | 'answered'
    let allowSame = SAME_SUPPORTED && getPref('higherLower.allowSame', true) !== false;

    // ---------- Pieces ----------
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
        playBtn.setPlaying(s.playing && s.tag === 'question');
        hearAgainBtn.classList.toggle('is-playing', s.playing && s.tag === 'question');
        inTuneBtn.classList.toggle('is-playing', s.playing && s.tag === 'in-tune');
        if (s.playing && state === 'ready') {
          state = 'heard';
          playBtn.setLabel('Play again');
          syncAnswers();
        }
      },
    });

    const timbre = () => getSettings().timbre;
    const playQuestion = () => player.play([{
      tag: 'question',
      start: () => playSequence([question.firstFreq, question.secondFreq],
        { noteDuration: NOTE_SECONDS, gap: GAP_SECONDS, timbre: timbre() }),
    }]);
    const playInTune = () => player.play([{
      tag: 'in-tune',
      start: () => playSequence([question.firstFreq, question.firstFreq],
        { noteDuration: NOTE_SECONDS, gap: GAP_SECONDS, timbre: timbre() }),
    }]);

    const playBtn = createPlayButton({ onClick: playQuestion, label: 'Play', shortcut: 'Space' });

    const higherBtn = answerButton({
      label: 'Higher', iconName: 'arrow-up', keyHint: '↑', keyTitle: 'Arrow up key',
      className: 'answer-higher', onClick: () => answer('sharp'),
    });
    const sameBtn = answerButton({
      label: 'Same', keyHint: '=', keyTitle: 'Key = or S',
      className: 'answer-same', onClick: () => answer('same'),
    });
    sameBtn.prepend(el('span', { class: 'same-sign', 'aria-hidden': 'true' }, '='));
    const lowerBtn = answerButton({
      label: 'Lower', iconName: 'arrow-down', keyHint: '↓', keyTitle: 'Arrow down key',
      className: 'answer-lower', onClick: () => answer('flat'),
    });
    const answerBtns = { sharp: higherBtn, same: sameBtn, flat: lowerBtn };

    const hearAgainBtn = el('button', { type: 'button', class: 'btn', onclick: playQuestion },
      icon('repeat', { size: 18 }), 'Hear again', kbd('R'));
    const inTuneBtn = el('button', { type: 'button', class: 'btn btn-in-tune', onclick: playInTune },
      icon('check', { size: 18 }), 'Hear it in tune', kbd('T'));
    const next = nextButton({ onClick: () => nextQuestion(true) });

    const after = el('div', { class: 'after-answer' },
      el('div', { class: 'btn-row compare-row' }, hearAgainBtn, inTuneBtn),
      next,
    );

    // "Include 'same'" switch (remembered).
    const sameToggle = el('input', { type: 'checkbox', role: 'switch', id: 'hl-same' });
    sameToggle.checked = allowSame;
    sameToggle.addEventListener('change', () => {
      allowSame = sameToggle.checked;
      setPref('higherLower.allowSame', allowSame);
      if (state === 'ready') newQuestion(); // otherwise from the next question on
      syncAnswers();
    });
    const sameSwitch = SAME_SUPPORTED
      ? el('label', { class: 'switch', for: 'hl-same' }, sameToggle, el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        el('span', {}, 'Include "same"'))
      : null;

    const hint = el('p', { class: 'stage-hint' }, 'Press Play first, then answer.');

    function syncAnswers() {
      const canAnswer = state === 'heard';
      for (const b of Object.values(answerBtns)) b.disabled = !canAnswer;
      // "Same" shows while it is part of the game (or was the right answer just now).
      sameBtn.hidden = !(allowSame || (question && question.direction === 'same'));
      after.hidden = state !== 'answered';
      hint.hidden = state !== 'ready';
      playBtn.element.hidden = state === 'answered'; // "Hear again" takes over
    }

    // ---------- Flow ----------
    function newQuestion() {
      const opts = { cents: staircase.level(), voicePart: voiceArg() };
      if (SAME_SUPPORTED) opts.allowSame = allowSame;
      question = hl.makeQuestion(opts);
      state = 'ready';
      playBtn.setLabel('Play');
      for (const b of Object.values(answerBtns)) b.classList.remove('is-chosen', 'is-right', 'is-wrong');
      feedback.clear();
      sounded.replaceChildren();
      level.update(question.cents, safeStats());
      syncAnswers();
    }

    function nextQuestion(autoplay) {
      newQuestion();
      // Bring the question (title, level, Play) back into view.
      reveal(screen, playBtn.element);
      if (autoplay) {
        playQuestion();
        playBtn.element.focus({ preventScroll: true });
      }
    }

    function detailFor(answerKey) {
      if (typeof hl.answerDetail === 'function') {
        try { return hl.answerDetail(question, answerKey); } catch (err) { console.error(err); }
      }
      const d = describeFreq(question.firstFreq);
      return { midi: d ? d.midi : null, direction: question.direction, answer: answerKey, cents: question.cents };
    }

    function answer(direction) {
      if (state !== 'heard') return;
      if (direction === 'same' && sameBtn.hidden) return;
      state = 'answered';
      const result = hl.checkAnswer(question, direction);
      const rec = recordResult(KEY, staircase, { correct: result.correct, detail: detailFor(direction) });

      const chosen = answerBtns[direction];
      const right = answerBtns[question.direction];
      chosen.classList.add('is-chosen');
      if (right) right.classList.add('is-right');
      if (chosen !== right) chosen.classList.add('is-wrong');

      const note = rec && LEVEL_NOTE[rec.direction];
      feedback.show({
        correct: result.correct,
        message: result.message,
        details: note ? el('p', { class: 'feedback-note' }, note) : null,
      });
      if (typeof hl.describe === 'function') {
        try { setChildren(sounded, soundedLine(hl.describe(question))); } catch (err) { console.error(err); }
      }
      level.update(rec ? rec.level : staircase.level(), rec ? rec.stats : safeStats());
      progressPanel.update();
      syncAnswers();
      next.focus(); // also scrolls it into view
    }

    function safeStats() {
      try { return getStats(KEY); } catch (err) { console.error(err); return null; }
    }

    const progressPanel = chapterProgressPanel(KEY, {
      onReset: () => {
        player.stop();
        staircase = loadStaircase(KEY);
        newQuestion();
      },
    });

    // ---------- Keyboard ----------
    const removeShortcuts = installShortcuts((e) => {
      switch (e.key) {
        case 'ArrowUp':
          if (state === 'heard') { answer('sharp'); return true; }
          return false;
        case 'ArrowDown':
          if (state === 'heard') { answer('flat'); return true; }
          return false;
        case '=':
        case 's':
        case 'S':
          if (state === 'heard' && !sameBtn.hidden) { answer('same'); return true; }
          return false;
        case ' ':
        case 'Enter':
          if (state === 'answered') nextQuestion(true);
          else playQuestion();
          return true;
        case 'r':
        case 'R':
          playQuestion();
          return true;
        case 't':
        case 'T':
          if (state === 'answered') { playInTune(); return true; }
          return false;
        default:
          return false;
      }
    });

    // ---------- Layout ----------
    const screen = el('section', { class: 'screen exercise' },
      el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Higher or lower?'),
          el('p', { class: 'task' }, SAME_SUPPORTED
            ? 'Two notes. Is the second one higher, lower — or exactly the same?'
            : 'Two notes. Is the second one higher or lower than the first?'),
        ),
        level.element,
      ),
      sameSwitch ? el('div', { class: 'options-row' }, sameSwitch) : null,
      el('div', { class: 'stage' },
        playBtn.element,
        loadLine,
        hint,
        el('div', { class: 'answers answers-stack', role: 'group', 'aria-label': 'Your answer' }, higherBtn, sameBtn, lowerBtn),
        feedback.element,
        sounded,
        after,
      ),
      helpBox({ summary: 'How it works' },
        el('p', {}, 'You hear one note, then the same note again, pushed up or down by a tiny amount. Decide whether the second note was higher or lower.'),
        SAME_SUPPORTED ? el('p', {}, 'With "Include same" on, sometimes the two notes are exactly the same — then the right answer is "Same". It trains you not to hear differences that are not there.') : null,
        el('p', {}, 'The difference is measured in cents: 100 cents is one piano semitone, so 10 cents is a tenth of a semitone. When you answer correctly, the next difference gets smaller; when you miss, it gets bigger. That keeps you practising right at the edge of what you can hear.'),
        el('p', {}, 'Starting notes are random, so you cannot lean on a remembered pitch. After answering you see which notes sounded, and "Hear it in tune" plays the first note twice so you can compare.'),
        el('p', { class: 'muted small' }, `Keys: Space = play / next, ↑ = higher, ↓ = lower${SAME_SUPPORTED ? ', = or S = same' : ''}, R = hear again, T = hear it in tune.`),
      ),
      progressPanel.element,
    );

    newQuestion();
    container.append(screen);

    return () => {
      removeShortcuts();
      player.destroy();
    };
  },
};
