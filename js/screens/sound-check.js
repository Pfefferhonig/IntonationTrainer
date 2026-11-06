// Sound check (#/sound-check): pure (just) vs piano (equal) chord, and beating.

import {
  TUNINGS, INTERVALS, CHORDS,
  intervalCents, buildChord, randomRootFreq, shiftByCents, freqToMidi, noteName,
} from '../music/tuning.js';
import { TIMBRES, playChord } from '../audio/engine.js';
import { getSettings, updateSettings, onSettingsChange } from '../storage.js';
import { el, signedCents } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { segmented, helpBox, tagLink, onEscape } from '../ui/components.js';
import { createPlayer } from '../ui/player.js';
import { voiceArg, partsLabel, chosenVoiceParts, voiceChosen } from '../ui/voices.js';

const CHORD_SECONDS = 3;
const BEAT_SECONDS = 5;
const DETUNE_OPTIONS = [0, 5, 10, 20, 40];

function playButton(label, onClick, cls = '') {
  return el('button', { type: 'button', class: `btn ${cls}`.trim(), onclick: onClick }, icon('play', { size: 18 }), label);
}

export default {
  id: 'sound-check',
  title: 'Sound check',

  render(container) {
    let settings = getSettings();
    const chord = CHORDS.major;
    const span = Math.max(...chord.intervals.map((k) => INTERVALS[k].semitones));
    const pickRoot = () => randomRootFreq(voiceArg(settings), span);
    let rootFreq = pickRoot();
    let detune = 10;
    const thirdGap = Math.round(INTERVALS.M3.equalCents - INTERVALS.M3.justCents);

    // ---------- Player bar ----------
    const statusEl = el('p', { class: 'player-status', role: 'status', 'aria-live': 'polite' }, 'Not playing');
    const stopBtn = el('button', { type: 'button', class: 'btn btn-small', disabled: true, onclick: () => player.stop() },
      icon('square', { size: 16 }), 'Stop');
    const player = createPlayer({
      pauseMs: 600,
      onChange: (s) => {
        statusEl.textContent = s.error || (s.playing || s.loading ? s.label : 'Not playing');
        statusEl.className = `player-status${s.playing ? ' is-playing' : ''}${s.error ? ' is-error' : ''}`;
        // Stop only does something while a sound plays (or loads).
        const active = !!(s.playing || s.loading);
        if (!active && document.activeElement === stopBtn) stopBtn.blur();
        stopBtn.disabled = !active;
      },
    });
    const offEsc = onEscape(() => {
      if (!player.playing) return false;
      player.stop();
      return true;
    });
    const rootLine = el('div', { class: 'root-line' });
    const partTag = el('span', { class: 'tag-holder' });

    function renderRoot() {
      rootLine.textContent = `Starting note ≈ ${noteName(freqToMidi(rootFreq))}`;
      partTag.replaceChildren(tagLink({ href: '#/settings', label: voiceChosen(settings) ? partsLabel(chosenVoiceParts(settings)) : 'Voice part not chosen yet', title: 'Voice parts — change in Settings' }));
    }
    function newPitch() {
      player.stop();
      rootFreq = pickRoot();
      renderRoot();
    }

    const playerBar = el('div', { class: 'player-bar', 'data-inset-top': '' },
      el('div', { class: 'player-info' }, el('div', { class: 'root-row' }, rootLine, partTag), statusEl),
      el('div', { class: 'player-actions' },
        el('button', { type: 'button', class: 'btn btn-small', onclick: newPitch }, icon('shuffle', { size: 18 }), 'New starting note'),
        stopBtn,
      ),
    );

    // ---------- Sound ----------
    // These switches change the setting for ALL exercises (same as Settings): say so, and
    // confirm briefly after a change.
    const GLOBAL_TUNING = 'This also changes the tuning for all exercises — same as Settings.';
    const GLOBAL_SOUND = 'This also changes the sound for all exercises — same as Settings.';
    const tuningNote = el('p', { class: 'global-note', role: 'status' }, GLOBAL_TUNING);
    const soundNote = el('p', { class: 'global-note', role: 'status' }, GLOBAL_SOUND);
    function confirmChange(node, text) {
      node.textContent = `✓ ${text}`;
      node.classList.add('is-confirm');
      clearTimeout(node._t);
      node._t = setTimeout(() => {
        node.textContent = node === tuningNote ? GLOBAL_TUNING : GLOBAL_SOUND;
        node.classList.remove('is-confirm');
      }, 3500);
    }
    const timbreDesc = el('p', { class: 'muted small seg-desc' });
    const renderTimbreDesc = () => {
      const t = TIMBRES[settings.timbre];
      timbreDesc.textContent = t ? t.description : '';
    };
    const timbreSeg = segmented({
      name: 'sc-timbre',
      legend: 'Sound',
      compact: true,
      options: Object.values(TIMBRES).map((t) => ({ value: t.key, label: t.label })),
      value: settings.timbre,
      onChange: (v) => {
        updateSettings({ timbre: v });
        const t = TIMBRES[v];
        confirmChange(soundNote, `Exercises now use: ${t ? t.label : v}`);
      },
    });

    // ---------- Pure vs piano ----------
    const chordFreqs = (tuning) => buildChord(rootFreq, 'major', tuning).map((n) => n.freq);
    const chordStep = (tuning, label) => ({
      label,
      start: () => playChord(chordFreqs(tuning), { duration: CHORD_SECONDS, timbre: settings.timbre }),
    });

    const table = el('table', { class: 'cents-table' },
      el('caption', {}, 'Cents above the root (100 cents = one piano semitone)'),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Note'),
        el('th', { scope: 'col' }, 'Pure'),
        el('th', { scope: 'col' }, 'Piano'),
        el('th', { scope: 'col' }, 'Difference'),
      )),
      el('tbody', {}, chord.intervals.map((key, i) => {
        const iv = INTERVALS[key];
        const diff = iv.justCents - iv.equalCents;
        return el('tr', {},
          el('td', {}, chord.degreeLabels[i]),
          el('td', { class: 'col-pure' }, String(Math.round(iv.justCents))),
          el('td', { class: 'col-piano' }, String(Math.round(iv.equalCents))),
          el('td', { class: Math.abs(diff) >= 5 ? 'diff-strong' : null }, signedCents(diff)),
        );
      })),
    );

    const chordCard = el('div', { class: 'card' },
      el('h2', {}, 'Pure vs piano chord'),
      el('p', { class: 'muted' }, 'The same major chord, tuned two ways. Listen to the middle note.'),
      el('div', { class: 'btn-row' },
        playButton('Pure', () => player.play([chordStep(TUNINGS.JUST, 'Pure chord (choir tuning)')]), 'btn-pure'),
        playButton('Piano', () => player.play([chordStep(TUNINGS.EQUAL, 'Piano chord (equal steps)')]), 'btn-piano'),
        playButton('Pure, then piano', () => player.play([
          chordStep(TUNINGS.JUST, '1 of 2: pure chord'),
          chordStep(TUNINGS.EQUAL, '2 of 2: piano chord'),
        ]), 'btn-primary'),
      ),
      helpBox({ summary: 'Show the numbers' },
        el('div', { class: 'table-wrap' }, table),
        el('p', { class: 'small muted' }, `The pure third is about ${thirdGap} cents lower than the piano third; the fifth is almost the same.`),
      ),
    );

    // ---------- Beating ----------
    const targetLine = el('p', { class: 'muted small' });
    const renderTarget = () => {
      const name = settings.tuning === TUNINGS.EQUAL ? 'piano' : 'pure';
      targetLine.textContent = `In-tune third (${name}): ${Math.round(intervalCents('M3', settings.tuning))} cents above the root.`;
    };
    const thirdStep = (cents, label) => ({
      label,
      start: () => {
        const third = shiftByCents(rootFreq, intervalCents('M3', settings.tuning) + cents);
        return playChord([rootFreq, third], { duration: BEAT_SECONDS, timbre: settings.timbre });
      },
    });
    const describe = (c) => (c === 0 ? 'in tune' : `${c} cents too high`);
    const tuningSeg = segmented({
      name: 'sc-tuning',
      legend: 'In tune means',
      compact: true,
      options: [{ value: TUNINGS.JUST, label: 'Pure (choir)' }, { value: TUNINGS.EQUAL, label: 'Piano' }],
      value: settings.tuning,
      onChange: (v) => {
        updateSettings({ tuning: v });
        confirmChange(tuningNote, `Exercises now use: ${v === TUNINGS.EQUAL ? 'Piano' : 'Pure (choir)'} tuning`);
      },
    });
    const detuneSeg = segmented({
      name: 'sc-detune',
      legend: 'Push the third up by',
      compact: true,
      options: DETUNE_OPTIONS.map((c) => ({ value: c, label: c === 0 ? '0 (in tune)' : `+${c} cents` })),
      value: detune,
      onChange: (v) => { detune = v; },
    });

    const beatCard = el('div', { class: 'card' },
      el('h2', {}, 'Hear the wobble'),
      el('p', { class: 'muted' }, 'Two notes slightly out of tune make the sound wobble (also called beating). The further out, the faster the wobble.'),
      tuningSeg.element,
      tuningNote,
      targetLine,
      detuneSeg.element,
      el('div', { class: 'btn-row' },
        playButton('Play the third', () => player.play([thirdStep(detune, `Root + third, ${describe(detune)}`)]), 'btn-primary'),
        playButton('In tune, then out', () => player.play([
          thirdStep(0, '1 of 2: in tune'),
          thirdStep(detune, `2 of 2: ${describe(detune)}`),
        ])),
      ),
      helpBox({ summary: 'What to listen for' },
        el('ul', { class: 'listen-guide' },
          el('li', {}, el('strong', {}, '0: '), 'smooth and still'),
          el('li', {}, el('strong', {}, '+5 to +10 cents: '), 'a slow, gentle wobble'),
          el('li', {}, el('strong', {}, '+20 cents: '), 'a clear, faster wobble'),
          el('li', {}, el('strong', {}, '+40 cents: '), 'rough and sour'),
        ),
        el('p', { class: 'small muted' }, `Choirs tune by ear exactly like this: when the wobble disappears, the chord is in tune. Try "Piano" at 0 — even the piano third wobbles a little, because it is about ${thirdGap} cents higher than pure.`),
      ),
    );

    const screen = el('section', { class: 'screen' },
      el('a', { class: 'back-link', href: '#/settings' }, icon('chevron-right', { size: 18, class: 'flip' }), 'Settings'),
      el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Sound check'),
          el('p', { class: 'task' }, `In a choir, a pure major third is about ${thirdGap} cents lower than on a piano. Hear the difference here.`),
        ),
      ),
      el('div', { class: 'options-row' }, timbreSeg.element),
      soundNote,
      timbreDesc,
      playerBar,
      chordCard,
      beatCard,
      helpBox({ summary: 'What are cents?' },
        el('p', {}, 'A cent is a tiny step of pitch: 100 cents make one piano semitone. A few cents is a very small shift, but a choir can clearly hear it.'),
        el('p', {}, 'Pure tuning (also called just intonation) is how a good a cappella choir tunes chords: the notes fit so cleanly that the chord sounds calm. Piano tuning (also called equal temperament) makes every semitone the same size, so chords wobble slightly.'),
      ),
    );

    renderRoot();
    renderTimbreDesc();
    renderTarget();
    container.append(screen);

    const unsubscribe = onSettingsChange((next) => {
      const partChanged = next.voiceParts.join() !== settings.voiceParts.join();
      settings = next;
      if (partChanged) {
        player.stop();
        rootFreq = pickRoot();
      }
      timbreSeg.setValue(settings.timbre);
      tuningSeg.setValue(settings.tuning);
      renderRoot();
      renderTimbreDesc();
      renderTarget();
    });

    return () => {
      offEsc();
      unsubscribe();
      player.destroy();
    };
  },
};
