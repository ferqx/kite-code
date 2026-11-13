import { expect, test } from '#kite-test';
import type { NativeState } from '../src/native-bridge';
import { nativeExecutionObservation } from '../src/native-execution-observation';

function state(): NativeState {
  return {
    generation: 2,
    historyEpoch: 3,
    selection: {
      storeId: 'store',
      session: { id: 'session', workspaceId: 'workspace' },
      viewSelection: 4,
      viewGeneration: 10,
      permissionUnavailable: true,
      viewLoading: true,
    },
    executionObservation: {
      generation: 2,
      historyEpoch: 3,
      viewSelection: 4,
      storeId: 'store',
      sessionId: 'session',
      workspaceId: 'workspace',
      observedCursor: '20',
      phase: 'fresh',
      session: { id: 'session', workspaceId: 'workspace' },
      runs: [],
      executions: [],
    },
  } as unknown as NativeState;
}

test('readonly execution survives blocked admission without copying its permission or target proof', () => {
  const value = state();
  expect(nativeExecutionObservation(value)).toBe(value.executionObservation);
  expect(nativeExecutionObservation(value)).not.toHaveProperty('permissions');
  expect(nativeExecutionObservation(value)).not.toHaveProperty('activeCommand');
  expect(value.selection?.permissionUnavailable).toBe(true);
});

test('execution display cannot cross generation, Store, Session, Workspace, selection or reconnect epoch', () => {
  for (const patch of [
    { generation: 1 },
    { historyEpoch: 2 },
    { viewSelection: 3 },
    { storeId: 'other' },
    { sessionId: 'other' },
    { workspaceId: 'other' },
  ]) {
    const value = state();
    expect(
      nativeExecutionObservation({
        ...value,
        executionObservation: { ...value.executionObservation!, ...patch },
      }),
    ).toBeUndefined();
  }
  expect(nativeExecutionObservation(undefined)).toBeUndefined();
});
