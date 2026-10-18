import { expect, test } from 'bun:test';
import { pruneReadingState, ReadingStateCache } from '../src/desktop/reading-state';

test('reading cache evicts least recently used sessions without retaining readers', () => {
  const cache = new ReadingStateCache();
  for (let index = 0; index < 32; index++)
    cache.save(String(index), { top: index, follow: false, expanded: {} });
  expect(cache.get('0')?.top).toBe(0);
  cache.save('32', { top: 32, follow: false, expanded: {} });
  expect(cache.get('1')).toBeUndefined();
  expect(cache.get('0')?.top).toBe(0);
  const expanded = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`tool:${i}`, true]));
  cache.save('bounded', { top: 5, follow: true, expanded });
  expect(Object.keys(cache.get('bounded')!.expanded)).toHaveLength(512);
  cache.save('oversized', { top: 0, follow: true, expanded: { ['x'.repeat(140000)]: true } });
  expect(cache.get('oversized')).toBeUndefined();
});

test('reading state drops vanished message, tool step and turn expansion IDs', () => {
  const state = pruneReadingState(
    {
      top: 42,
      follow: false,
      expanded: {
        'activity:tool:a': true,
        'activity-group:tool:a': false,
        'activity-group:exploration-block': true,
        'tool:a': false,
        'turn:t:complete': true,
        'subagent-step:step': true,
        removed: true,
      },
    },
    [
      {
        id: 'tool:a',
        role: 'tool',
        settled: true,
        text: '',
        turnId: 't',
        presentationGroupId: 'exploration-block',
        steps: [{ id: 'step', text: '', toolName: 'read', status: 'completed' }],
      },
    ],
  );
  expect(state).toEqual({
    top: 42,
    follow: false,
    expanded: {
      'activity:tool:a': true,
      'activity-group:tool:a': false,
      'activity-group:exploration-block': true,
      'tool:a': false,
      'turn:t:complete': true,
      'subagent-step:step': true,
    },
  });
});
