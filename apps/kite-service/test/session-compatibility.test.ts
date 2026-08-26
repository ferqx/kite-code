import { describe, expect, test } from 'bun:test';
import {
  listSessions,
  type OpenStateRuntimeStorage,
} from '../src/bootstrap/runtime/session-persistence';

describe('session compatibility boundaries', () => {
  test('ignores an unknown store while discovering persisted sessions', async () => {
    const openStateRuntimeStorage: OpenStateRuntimeStorage = () => {
      throw new Error('unknown runtime format');
    };

    await expect(listSessions(openStateRuntimeStorage)).resolves.toEqual([]);
  });
});
