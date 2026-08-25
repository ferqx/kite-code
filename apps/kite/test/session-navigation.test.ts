import { describe, expect, test } from 'bun:test';
import { SessionNavigationAuthority } from '../src/tui/session-navigation';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('SessionNavigationAuthority', () => {
  test('a registered in-memory switch invalidates a delayed historical load commit', async () => {
    const navigation = new SessionNavigationAuthority();
    const load = deferred<{ turns: string[]; context: string }>();
    const projection = {
      activeSessionId: 'current',
      turns: ['current turn'],
      context: 'current context',
      loadingSessionId: 'historical',
    };
    const token = navigation.beginLoad();
    const historicalOpen = load.promise.then((result) =>
      navigation.commit(token, () => {
        projection.activeSessionId = 'historical';
        projection.turns = result.turns;
        projection.context = result.context;
        projection.loadingSessionId = '';
      }),
    );

    navigation.invalidatePendingLoad();
    projection.activeSessionId = 'registered';
    projection.turns = ['registered turn'];
    projection.context = 'registered context';
    projection.loadingSessionId = '';
    load.resolve({ turns: ['stale historical turn'], context: 'stale historical context' });

    await expect(historicalOpen).resolves.toBe(false);
    expect(projection).toEqual({
      activeSessionId: 'registered',
      turns: ['registered turn'],
      context: 'registered context',
      loadingSessionId: '',
    });
  });

  test('a delayed historical load rejection cannot roll back a newer navigation', async () => {
    const navigation = new SessionNavigationAuthority();
    const load = deferred<string>();
    const transitions: string[] = [];
    const token = navigation.beginLoad();
    const historicalOpen = load.promise.catch(() =>
      navigation.commit(token, () => transitions.push('rollback historical')),
    );

    navigation.invalidatePendingLoad();
    transitions.push('switch registered');
    load.reject(new Error('historical load failed'));

    await expect(historicalOpen).resolves.toBe(false);
    expect(transitions).toEqual(['switch registered']);
  });

  test('a second load for the same target supersedes the first token', () => {
    const navigation = new SessionNavigationAuthority();
    const first = navigation.beginLoad();
    const second = navigation.beginLoad();
    expect(navigation.isCurrent(first)).toBe(false);
    expect(navigation.isCurrent(second)).toBe(true);
  });
});
