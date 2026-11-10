import { expect, test } from 'bun:test';
import type { TrajectorySnapshot } from '@kite-ai/trajectory';
import {
  initialTrajectoryViewState,
  trajectoryViewStateKey,
} from '../src/desktop/trajectory/view-state';

test('trajectory retained state is a private plain value and separates exact source, upper and filter', () => {
  const descriptor: TrajectorySnapshot = {
    storeId: 'store',
    sessionId: 'session',
    upperCursor: '9007199254740993',
    formatVersion: 1,
    historyCoverage: {
      enabledAfterCursor: '0',
      upperCursor: '9007199254740993',
      status: 'retained',
      integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
    },
  };
  const state = initialTrajectoryViewState(descriptor);
  descriptor.sessionId = 'mutated';
  expect(state.descriptor!.sessionId).toBe('session');
  expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  expect(state.cursor).toBe('9007199254740993');
  expect(state.selectedNodeId).toBe('session');
  expect(state.detailTab).toBe('lifecycle'); // Legacy values remain readable but never select a workbench tab.
  expect(state.workbenchTab).toBe('overview');
  expect(state.detailOpen).toBe(false);
  expect(state.detailWidth).toBe(40);
  expect(state.selectedObservationId).toBeNull();
  expect(state.timelineMode).toBe('time');
  expect(state.collapsedNodeIds).toEqual([]);
  expect(state.detailScrollTop).toBe(0);
  const key = trajectoryViewStateKey(state.descriptor!);
  for (const change of [
    { storeId: 'different' },
    { sessionId: 'different' },
    { upperCursor: '9007199254740994' },
    { eventKinds: ['model' as const] },
  ])
    expect(trajectoryViewStateKey({ ...state.descriptor!, ...change })).not.toBe(key);
});
