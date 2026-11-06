// "Save a backup file" / "Load a backup file" — the same controls on Your stats and in Settings.

// Namespace import: exportAllProgress / importAllProgress / IMPORT_ERRORS are feature-checked.
import * as progress from '../exercise/progress.js';
import { el, setChildren } from './dom.js';
import { icon } from './icons.js';

const NOT_BACKUP = "This isn't a Choir Intonation Trainer backup file.";

function localDate(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Start a download of `href` as `filename`. */
export function downloadHref(href, filename) {
  const a = el('a', { href, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

/** True when this app version can save and load backups. */
export function backupAvailable() {
  return typeof progress.exportAllProgress === 'function' || typeof progress.importAllProgress === 'function';
}

/**
 * Backup controls: intro line, two buttons, an inline confirmation before loading, and a status line
 * (pre-rendered, filled on change). onImported() runs after a successful load (redraw the screen).
 * Returns { element, setStatus(text, isError) }.
 */
export function createBackupControls({ onImported, intro = 'Keep a copy of your progress and settings, for example to move to another device.' } = {}) {
  const canExport = typeof progress.exportAllProgress === 'function';
  const canImport = typeof progress.importAllProgress === 'function';
  const area = el('div', { class: 'backup-area' });
  const status = el('p', { class: 'small backup-status', role: 'status' });
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const element = el('div', { class: 'backup-controls' }, area, fileInput, status);

  function setStatus(text, isError = false) {
    status.textContent = text || '';
    status.className = `small backup-status ${isError ? 'backup-error' : 'backup-ok'}`;
  }

  let loadBtn = null;
  function showButtons({ focusLoad = false } = {}) {
    loadBtn = canImport ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => fileInput.click() },
      icon('upload', { size: 16 }), 'Load a backup file') : null;
    setChildren(area,
      intro ? el('p', { class: 'small muted' }, intro) : null,
      el('div', { class: 'btn-row' },
        canExport ? el('button', {
          type: 'button',
          class: 'btn btn-small',
          onclick: () => {
            try {
              const json = JSON.stringify(progress.exportAllProgress(), null, 2);
              const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
              downloadHref(url, `choir-intonation-backup-${localDate(new Date())}.json`);
              setTimeout(() => URL.revokeObjectURL(url), 2000);
              setStatus('Backup saved to your downloads.');
            } catch (err) {
              console.error(err);
              setStatus("The backup file couldn't be saved. Try again.", true);
            }
          },
        }, icon('download', { size: 16 }), 'Save a backup file') : null,
        loadBtn,
      ),
    );
    if (focusLoad && loadBtn) loadBtn.focus();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      console.warn('Backup file is not JSON:', err);
      setStatus(NOT_BACKUP, true);
      return;
    }
    setStatus('');
    const yes = el('button', {
      type: 'button',
      class: 'btn btn-small btn-danger',
      onclick: () => {
        let res;
        try { res = progress.importAllProgress(parsed); } catch (err) { console.error(err); res = null; }
        if (res && res.ok) {
          showButtons();
          setStatus('Progress loaded from your backup.');
          try { if (typeof onImported === 'function') onImported(); } catch (err) { console.error(err); }
        } else {
          showButtons({ focusLoad: true });
          const damaged = progress.IMPORT_ERRORS && progress.IMPORT_ERRORS.damaged;
          setStatus((res && res.error) || damaged || 'This backup file is damaged, so nothing was changed.', true);
        }
      },
    }, 'Replace my progress');
    setChildren(area,
      el('p', { class: 'small confirm-text' }, `Replace all your progress with "${file.name}"? This can't be undone.`),
      el('div', { class: 'btn-row' },
        yes,
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => { showButtons({ focusLoad: true }); setStatus('Nothing was changed.'); } }, 'Cancel'),
      ),
    );
    yes.focus();
  });

  showButtons();
  return { element, setStatus };
}
