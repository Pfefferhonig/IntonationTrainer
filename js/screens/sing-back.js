// "Echo" (#/sing-back): a note plays, you sing it back and hold it.

import { renderSingExercise } from '../ui/sing-exercise.js';

export default {
  id: 'sing-back',
  title: 'Echo',

  render(container) {
    return renderSingExercise(container, {
      kind: 'match',
      title: 'Echo',
      task: 'Listen to the note, then sing it back and hold it steady.',
    });
  },
};
