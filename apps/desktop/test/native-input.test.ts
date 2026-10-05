import { expect, test } from 'bun:test';
import type { NativeSelection } from '../src/native-bridge';
import { nativeTextIntent } from '../src/native-input';

test('Native text during compression/reset binds follow-up to the original Run and selection; ordinary active work steers', () => {
  const selection = {
    storeId: 'original-store',
    session: { id: 'original-session', contextSelectionId: 'original-selection' },
    runs: [{ id: 'original-run', isActive: true, originCommandId: 'origin' }],
    activeCommand: {
      id: 'origin',
      sessionId: 'original-session',
      originStoreId: 'original-store',
      kind: 'context.compress',
    },
  } as unknown as NativeSelection;
  for (const kind of ['context.compress', 'context.compression.reset'] as const) {
    selection.activeCommand!.kind = kind;
    const intent = nativeTextIntent(selection, 'new-command', 'complete follow-up');
    expect(intent).toEqual({
      kind: 'input.follow_up',
      commandId: 'new-command',
      expectedStoreId: 'original-store',
      afterRunId: 'original-run',
      contextSelectionId: 'original-selection',
      content: 'complete follow-up',
    });
    selection.session.contextSelectionId = 'later-selection';
    expect(intent.kind === 'input.follow_up' && intent.contextSelectionId).toBe(
      'original-selection',
    );
    selection.session.contextSelectionId = 'original-selection';
  }
  selection.activeCommand!.kind = 'run.start';
  expect(nativeTextIntent(selection, 'new-command', 'steer')).toMatchObject({
    kind: 'input.steer',
    targetRunId: 'original-run',
    contextSelectionId: 'original-selection',
  });
  expect(nativeTextIntent({ ...selection, runs: [] }, 'new-command', 'new')).toMatchObject({
    kind: 'run.start',
  });
  expect(() =>
    nativeTextIntent({ ...selection, activeCommand: undefined }, 'new-command', 'unknown'),
  ).toThrow('active_command_identity_unavailable');
  expect(() =>
    nativeTextIntent({ ...selection, permissionUnavailable: true }, 'new-command', 'stale'),
  ).toThrow('session_view_unavailable');
});
