// "Join the chord" (#/sing): the fixed notes sound, you sing the missing one.

import { renderSingExercise } from '../ui/sing-exercise.js';

export default {
  id: 'sing',
  title: 'Join the chord',

  render(container) {
    return renderSingExercise(container, {
      kind: 'missing',
      title: 'Join the chord',
      task: 'Some notes are fixed. Sing the missing note and hold it until it sounds calm.',
    });
  },
};
