// Settings (#/settings): tuning, voice parts, sound, volume & room echo, sound quality, keyboard,
// microphone (incl. hands-free singing), sound check, setup again, backup, reset all progress, credits.
// Every change is saved immediately.

import { TUNINGS } from '../music/tuning.js';
// Namespace imports: optional features (setReverb, setAudioQuality, resetAllProgress) are checked with typeof.
import * as engine from '../audio/engine.js';
import * as progress from '../exercise/progress.js';
import { getSettings, updateSettings } from '../storage.js';
import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { helpBox, choiceCards, switchControl, segmented } from '../ui/components.js';
import { confirmAction } from '../ui/exercise.js';
import { voicePicker, soundPicker } from '../ui/sound-picker.js';
import { createBackupControls, backupAvailable } from '../ui/backup.js';
import { micSetupPanel, micSetupDone } from '../ui/sing-common.js';

const TUNING_CHOICES = [
  { value: TUNINGS.JUST, label: 'Pure (choir tuning)', detail: 'Chords sound calm because the notes fit perfectly. Thirds are lower than on a piano. (Also called just intonation.)' },
  { value: TUNINGS.EQUAL, label: 'Piano (equal steps)', detail: 'Like a keyboard: every semitone is the same size, so chords wobble slightly. (Also called equal temperament.)' },
];

const QUALITY_CHOICES = [
  { value: 'auto', label: 'Auto' },
  { value: 'high', label: 'High' },
  { value: 'light', label: 'Light (for phones)' },
];

const PRIVACY_MIC = 'Your singing is analysed on this device. The recording is deleted when you leave the page; only your results are saved.';
const MIC_SET = 'Set up. Check it again any time, for example with new headphones or another microphone.';
const MIC_NOT_SET = 'Not set up yet. The singing exercises ask for it the first time.';

const CHAPTER_KEYS = ['higher-or-lower', 'odd-one-out', 'tune-it'];

const LUCIDE_LICENSE = `ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or
without fee is hereby granted, provided that the above copyright notice and this permission
notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
OF THIS SOFTWARE.`;

function slider({ id, value, onInput }) {
  const pct = Math.round(value * 100);
  const output = el('output', { class: 'volume-value', for: id }, `${pct}%`);
  const input = el('input', { type: 'range', id, min: '0', max: '100', step: '1', value: String(pct) });
  input.addEventListener('input', () => {
    output.textContent = `${input.value}%`;
    onInput(Number(input.value) / 100);
  });
  return { input, output };
}

const ext = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

function resetAll() {
  if (typeof progress.resetAllProgress === 'function') {
    progress.resetAllProgress();
    return;
  }
  for (const key of CHAPTER_KEYS) progress.resetProgress(key); // older logic module
}

/** "Now: light — this device is a phone" (what the engine actually uses). */
function qualityNow() {
  if (typeof engine.getAudioQualityInfo !== 'function') return '';
  try {
    const info = engine.getAudioQualityInfo();
    if (!info || !info.effective) return '';
    return `In use now: ${info.effective === 'light' ? 'light' : 'high'}.`;
  } catch {
    return '';
  }
}

export default {
  id: 'settings',
  title: 'Settings',

  render(container) {
    const settings = getSettings();
    const sound = soundPicker({ heading: true });

    const tuning = choiceCards({
      legend: 'Tuning',
      heading: true,
      help: 'What "in tune" means in the exercises.',
      value: settings.tuning,
      options: TUNING_CHOICES,
      onChange: (v) => updateSettings({ tuning: v }),
    });

    // ---- Volume, room echo, sound quality
    const vol = slider({
      id: 'set-volume',
      value: settings.volume,
      onInput: (v) => {
        try { engine.setMasterVolume(v); } catch (err) { console.error(err); }
        updateSettings({ volume: v });
      },
    });
    const echo = typeof engine.setReverb === 'function' ? slider({
      id: 'set-reverb',
      value: settings.reverb,
      onInput: (v) => {
        try { engine.setReverb(v); } catch (err) { console.error(err); }
        updateSettings({ reverb: v });
      },
    }) : null;

    let qualityBlock = null;
    if (typeof engine.setAudioQuality === 'function') {
      const qualityNote = el('p', { class: 'small muted', role: 'status' }, qualityNow());
      const seg = segmented({
        name: 'quality',
        legend: 'Sound quality',
        hideLegend: true,
        options: QUALITY_CHOICES,
        value: settings.audioQuality || 'auto',
        onChange: (v) => {
          updateSettings({ audioQuality: v }); // main.js passes it to the engine
          setTimeout(() => { qualityNote.textContent = `${qualityNow()} It takes effect at the next sound.`; }, 0);
        },
      });
      qualityBlock = el('div', { class: 'setting-block' },
        el('h2', { class: 'card-title' }, 'Sound quality'),
        el('p', { class: 'help muted small' }, 'Light uses less computing power. Choose it if notes crackle or stutter, for example on a phone. Tuning is exact in all three.'),
        seg.element,
        qualityNote);
    }

    const playback = el('div', { class: 'card' },
      el('h2', { class: 'card-title' }, el('label', { for: 'set-volume' }, 'Volume')),
      el('div', { class: 'volume-row' },
        icon('volume-2', { size: 22, class: 'muted' }),
        vol.input,
        vol.output,
        el('button', {
          type: 'button',
          class: 'btn btn-small',
          onclick: () => sound.preview(getSettings().timbre),
        }, icon('play', { size: 18 }), 'Test'),
      ),
      echo ? el('div', { class: 'setting-block' },
        el('h2', { class: 'card-title' }, el('label', { for: 'set-reverb' }, 'Room echo')),
        el('p', { class: 'help muted small' }, 'A little echo sounds more natural, like a room. None (0%) is the clearest for hearing tuning.'),
        el('div', { class: 'volume-row' },
          icon('audio-waveform', { size: 22, class: 'muted' }),
          echo.input,
          echo.output,
        ),
      ) : null,
      qualityBlock,
    );

    // ---- Keyboard
    const keysSwitch = switchControl({
      label: 'Single-key shortcuts',
      checked: settings.keyShortcuts !== false,
      description: 'Letters and numbers as shortcuts (for example R to play again). Turn this off if you use voice control or speech input. Arrows, Space, Enter and Esc always work.',
      onChange: (on) => updateSettings({ keyShortcuts: on }),
    });
    const keysCard = el('div', { class: 'card' },
      el('h2', { class: 'card-title' }, 'Keyboard'),
      keysSwitch.element);

    // ---- Sound check + setup again
    const tools = el('div', { class: 'card link-card' },
      el('a', { class: 'link-row', href: '#/settings/sound-check' },
        icon('headphones', { size: 22 }),
        el('span', { class: 'link-row-text' },
          el('strong', {}, 'Sound check'),
          el('span', { class: 'muted small' }, 'Hear pure and piano chords side by side, and what the wobble sounds like.'),
        ),
        icon('chevron-right', { size: 20 }),
      ),
      el('a', { class: 'link-row', href: '#/setup' },
        icon('rotate-ccw', { size: 22 }),
        el('span', { class: 'link-row-text' },
          el('strong', {}, 'Run setup again'),
          el('span', { class: 'muted small' }, 'Voice part, sound and a quick listen, in three steps.'),
        ),
        icon('chevron-right', { size: 20 }),
      ),
    );

    // ---- Microphone (for the singing exercises)
    let micPanel = null;
    const micArea = el('div', { class: 'mic-settings-area' });
    const micStatus = el('p', { class: 'small mic-ok', role: 'status' });
    const micLine = el('p', { class: 'small muted' }, micSetupDone() ? MIC_SET : MIC_NOT_SET);
    const micBtnLabel = el('span', { class: 'btn-label' }, 'Check microphone');
    const micBtnIcon = el('span', { class: 'btn-icon' }, icon('mic', { size: 16 }));
    const micBtn = el('button', { type: 'button', class: 'btn btn-small', 'aria-expanded': 'false' }, micBtnIcon, micBtnLabel);
    function closeMic({ focus = false } = {}) {
      if (micPanel) { micPanel.destroy(); micPanel = null; }
      micArea.replaceChildren();
      micBtnLabel.textContent = 'Check microphone';
      micBtnIcon.replaceChildren(icon('mic', { size: 16 }));
      micBtn.setAttribute('aria-expanded', 'false');
      if (focus) micBtn.focus();
    }
    micBtn.addEventListener('click', () => {
      if (micPanel) { closeMic(); return; }
      micStatus.textContent = '';
      micPanel = micSetupPanel({
        title: 'Check your microphone',
        onDone: () => {
          closeMic({ focus: true });
          micStatus.textContent = 'Microphone ready.';
          micLine.textContent = MIC_SET;
        },
      });
      micArea.replaceChildren(micPanel.element);
      micBtnLabel.textContent = 'Close';
      micBtnIcon.replaceChildren(icon('x', { size: 16 }));
      micBtn.setAttribute('aria-expanded', 'true');
      if (typeof micPanel.focusTitle === 'function') {
        try { micPanel.focusTitle(); } catch (err) { console.error(err); }
      }
    });
    const handsFree = switchControl({
      label: 'Hands-free singing',
      checked: !!settings.handsFree,
      description: 'Tap once to start; it stops by itself when you stop singing. (A 3-2-1 count-in comes first; tap again to stop early.)',
      onChange: (on) => updateSettings({ handsFree: on }),
    });
    const micCard = el('div', { class: 'card' },
      el('h2', { class: 'card-title' }, 'Microphone'),
      el('p', { class: 'help muted small' }, `Used only by Echo and Join the chord. ${PRIVACY_MIC}`),
      micLine,
      el('div', { class: 'btn-row mic-row' }, micBtn),
      micStatus,
      micArea,
      el('div', { class: 'setting-block' }, handsFree.element),
    );

    // ---- Your progress: backup + reset
    const backup = backupAvailable() ? createBackupControls({
      onImported: () => {
        // Settings may have come from the backup too: draw this page again.
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      },
    }) : null;
    const danger = el('section', { class: 'card progress-card', 'aria-labelledby': 'progress-title' },
      el('h2', { class: 'card-title', id: 'progress-title' }, 'Your progress'),
      backup ? el('div', { class: 'progress-backup' },
        el('h3', { class: 'settings-h3' }, 'Backup'),
        backup.element) : null,
      el('div', { class: `danger-block${backup ? ' setting-block' : ''}` },
        el('h3', { class: 'settings-h3' }, 'Reset all progress'),
        confirmAction({
          intro: 'Clears your levels, ranks and history in every exercise on this device. Your settings stay as they are.',
          buttonLabel: 'Reset all progress',
          confirmText: "Reset all progress in every exercise? This can't be undone.",
          yesLabel: 'Reset everything',
          doneText: 'All progress reset.',
          danger: true,
          onConfirm: resetAll,
        })),
    );

    // ---- About & credits
    const about = helpBox({ summary: 'About & credits' },
      el('p', {}, 'Choir Intonation Trainer: short exercises that help choir singers hear and sing in tune.'),
      el('h3', { class: 'credits-title' }, 'Created by'),
      el('p', {}, 'Michelle Scharte · ',
        ext('https://github.com/Pfefferhonig/IntonationTrainer', 'Project on GitHub')),
      el('h3', { class: 'credits-title' }, 'Clarinet recordings'),
      el('p', {},
        'Versilian Studios (Sam Gossner) — VSCO 2 Community Edition, released under CC0 1.0 (public domain). ',
        ext('http://vis.versilstudios.net/vsco-community.html', 'VSCO: Community Edition homepage'),
        '. The recordings were trimmed, looped and steadied in pitch for this app.'),
      el('h3', { class: 'credits-title' }, 'Icons'),
      el('p', {},
        ext('https://lucide.dev', 'Lucide'), ' icons (lucide-static 0.460.0), ISC License. ',
        'Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). ',
        'All other copyright (c) for Lucide are held by Lucide Contributors 2022.'),
      el('details', { class: 'license-text' },
        el('summary', {}, 'Show the ISC license text'),
        el('pre', {}, LUCIDE_LICENSE),
      ),
    );

    container.append(el('section', { class: 'screen' },
      el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Settings'),
          el('p', { class: 'task' }, 'Saved automatically on this device. Everything stays here: your progress, and your singing, which is analysed on this device and never uploaded or saved.'),
        ),
      ),
      tuning,
      voicePicker({ heading: true }),
      sound.element,
      playback,
      tools,
      micCard,
      keysCard,
      danger,
      about,
    ));

    return () => { sound.destroy(); if (micPanel) micPanel.destroy(); };
  },
};
