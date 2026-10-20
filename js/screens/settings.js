// Settings (#/settings): tuning, voice part, sound, volume & room echo, sound check,
// setup again, reset all progress, credits. Every change is saved immediately.

import { TUNINGS } from '../music/tuning.js';
// Namespace imports: optional features (setReverb, resetAllProgress) are checked with typeof.
import * as engine from '../audio/engine.js';
import * as progress from '../exercise/progress.js';
import { getSettings, updateSettings } from '../storage.js';
import { el } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { helpBox, choiceCards } from '../ui/components.js';
import { confirmAction } from '../ui/exercise.js';
import { voicePicker, soundPicker } from '../ui/sound-picker.js';
import { micSetupPanel, micSetupDone } from '../ui/sing-common.js';

const TUNING_CHOICES = [
  { value: TUNINGS.JUST, label: 'Pure (choir)', detail: 'Just intonation: chords fit together perfectly and sound calm. Thirds are lower than on a piano.' },
  { value: TUNINGS.EQUAL, label: 'Piano', detail: 'Equal temperament: every semitone the same size, like a keyboard.' },
];

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

export default {
  id: 'settings',
  title: 'Settings',

  render(container) {
    const settings = getSettings();
    const sound = soundPicker();

    const tuning = choiceCards({
      legend: 'Tuning',
      help: 'What "in tune" means in the exercises.',
      value: settings.tuning,
      options: TUNING_CHOICES,
      onChange: (v) => updateSettings({ tuning: v }),
    });

    // ---- Volume & room echo
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
    );

    // ---- Sound check + setup again
    const tools = el('div', { class: 'card link-card' },
      el('a', { class: 'link-row', href: '#/settings/sound-check' },
        icon('headphones', { size: 22 }),
        el('span', { class: 'link-row-text' },
          el('strong', {}, 'Sound check'),
          el('span', { class: 'muted small' }, 'Hear pure vs piano chords and how "beating" sounds.'),
        ),
        icon('chevron-right', { size: 20 }),
      ),
      el('a', { class: 'link-row', href: '#/setup' },
        icon('rotate-ccw', { size: 22 }),
        el('span', { class: 'link-row-text' },
          el('strong', {}, 'Run setup again'),
          el('span', { class: 'muted small' }, 'Voice part, sound and a quick listen — in three steps.'),
        ),
        icon('chevron-right', { size: 20 }),
      ),
    );

    // ---- Microphone (for the singing exercises)
    let micPanel = null;
    const micArea = el('div', { class: 'mic-settings-area' });
    const micLine = el('p', { class: 'small muted' }, micSetupDone()
      ? 'Set up. Check it again any time — for example with new headphones or a different microphone.'
      : 'Not set up yet. The singing exercises ask for it the first time.');
    const micBtn = el('button', {
      type: 'button',
      class: 'btn btn-small',
      onclick: () => {
        if (micPanel) { micPanel.destroy(); micPanel = null; micArea.replaceChildren(); return; }
        micPanel = micSetupPanel({
          title: 'Check your microphone',
          onDone: () => {
            micPanel.destroy();
            micPanel = null;
            micArea.replaceChildren(el('p', { class: 'small mic-ok', role: 'status' }, 'Microphone checked — all set.'));
            micLine.textContent = 'Set up. Check it again any time — for example with new headphones or a different microphone.';
          },
        });
        micArea.replaceChildren(micPanel.element);
      },
    }, icon('mic', { size: 16 }), 'Check microphone');
    const micCard = el('div', { class: 'card' },
      el('h2', { class: 'card-title' }, 'Microphone'),
      el('p', { class: 'help muted small' }, 'Used only by "Echo" and "Join the chord". The sound is analysed on this device and never uploaded.'),
      micLine,
      micBtn,
      micArea,
    );

    // ---- Danger zone
    const danger = el('section', { class: 'card danger-zone', 'aria-labelledby': 'danger-title' },
      el('h2', { class: 'card-title', id: 'danger-title' }, 'Reset all progress'),
      confirmAction({
        intro: 'Clears your levels, ranks and history in every chapter on this device. Your settings stay as they are.',
        buttonLabel: 'Reset all progress',
        confirmText: 'Are you sure? All your progress in every chapter will be deleted. This cannot be undone.',
        yesLabel: 'Yes, reset everything',
        doneText: 'All progress has been reset.',
        danger: true,
        onConfirm: resetAll,
      }),
    );

    // ---- About & credits
    const about = helpBox({ summary: 'About & credits' },
      el('p', {}, 'Choir Intonation Trainer — short listening exercises that help choir singers hear and sing in tune.'),
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
          el('p', { class: 'task' }, 'Saved automatically. Everything stays on this device: your settings and progress are stored only in this browser, and your singing is analysed right here. Recordings are kept just long enough to play them back and are never saved or uploaded; only the results (numbers) are kept.'),
        ),
      ),
      tuning,
      voicePicker(),
      sound.element,
      playback,
      tools,
      micCard,
      danger,
      about,
    ));

    return () => { sound.destroy(); if (micPanel) micPanel.destroy(); };
  },
};
