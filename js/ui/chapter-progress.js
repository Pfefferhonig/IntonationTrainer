// Progress panel wired to js/exercise/progress.js for the staircase chapters.
// getRank is feature-checked so the panel still works before it exists.

import * as progress from '../exercise/progress.js';
import { createProgressPanel } from './progress-panel.js';

/** Rank for a chapter, or null when getRank is not available (yet). */
export function safeRank(chapterKey, stats) {
  if (typeof progress.getRank !== 'function') return null;
  try {
    return stats === undefined ? progress.getRank(chapterKey) : progress.getRank(chapterKey, stats);
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** getInsights(chapterKey), or null when not available (yet). */
export function safeInsights(chapterKey) {
  if (typeof progress.getInsights !== 'function') return null;
  try {
    return progress.getInsights(chapterKey) || null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** "Your progress" for 'higher-or-lower' / 'odd-one-out' / 'odd-or-in-tune'. Returns { element, update() }. */
export function chapterProgressPanel(chapterKey, { onReset, title, open } = {}) {
  return createProgressPanel({
    what: 'this exercise',
    title,
    open,
    // Without onReset (stats page) the panel has no reset control.
    onReset: typeof onReset === 'function' ? () => {
      progress.resetProgress(chapterKey);
      onReset();
    } : undefined,
    read: () => {
      const stats = progress.getStats(chapterKey);
      const best = Number.isFinite(stats.bestThresholdCents) ? stats.bestThresholdCents : null;
      return {
        rank: safeRank(chapterKey, stats),
        noData: !(stats.answered > 0),
        best,
        bestLabel: 'Finest difference',
        bestNote: best == null
          ? 'Appears after a few more rounds.'
          : 'The smallest difference you hear reliably. Smaller is better.',
        caption: 'Difference per day — lower is better',
        unit: 'cents',
        points: (stats.history || [])
          .filter((d) => d && d.levelCents != null)
          .map((d) => ({
            date: d.date,
            value: Number(d.levelCents),
            note: `${d.correct} of ${d.answered} right`,
          })),
        empty: 'Play a few rounds to see your progress here.',
        insights: safeInsights(chapterKey),
      };
    },
  });
}
