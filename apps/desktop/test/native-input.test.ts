import { expect, test } from 'bun:test';
import type { NativeSelection } from '../src/native-bridge';
import {
  nativeInputErrorText,
  nativePlanReviewAwaitingAnswer,
  nativeTextIntent,
} from '../src/native-input';
import { promptTextForSend } from '../src/prompt-text';

test('submitted prompts remove every final LF or CRLF without trimming Markdown whitespace', () => {
  for (const ending of ['', '\n', '\n\n\n', '\r\n', '\r\n\r\n', '\r\n\n\r']) {
    expect(promptTextForSend(`  first  \n\n雪🙂 last  ${ending}`)).toBe('  first  \n\n雪🙂 last  ');
  }
  expect(promptTextForSend('\n\r\n')).toBe('');
  expect(promptTextForSend('text\n \n\n')).toBe('text\n ');
});

test('a root plan gates the main prompt even when the pending page omits its card', () => {
  const selection = {
    storeId: 'store',
    session: { id: 'root' },
    runs: [
      {
        id: 'run',
        isActive: true,
        status: 'waiting_interaction',
        originStoreId: 'store',
        sessionId: 'root',
      },
    ],
    executions: [
      {
        kind: 'tool',
        definitionId: 'planning.review',
        originStoreId: 'store',
        sessionId: 'root',
        runId: 'run',
        status: 'running',
      },
    ],
    interactions: [],
  } as unknown as NativeSelection;
  const parent = {
    id: 'root-card',
    kind: 'plan_review',
    state: 'pending',
    originStoreId: 'store',
    sessionId: 'root',
    presentationSessionId: 'root',
  } as NativeSelection['interactions'][number];
  const child = { ...parent, id: 'child-card', sessionId: 'child' };
  expect(nativePlanReviewAwaitingAnswer(selection)).toBe(true);
  expect(nativePlanReviewAwaitingAnswer({ ...selection, interactions: [parent, child] })).toBe(
    true,
  );
  expect(
    nativePlanReviewAwaitingAnswer({
      ...selection,
      interactions: [parent, { ...parent, id: 'another' }],
    }),
  ).toBe(true);
  expect(
    nativePlanReviewAwaitingAnswer({ ...selection, executions: [], interactions: [child] }),
  ).toBe(false);
});

test('Native ordinary sends always queue during an active Run, including compression/reset', () => {
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
    kind: 'input.follow_up',
    afterRunId: 'original-run',
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

test('Native explicit Plan freezes a new Run or queued follow-up with the closed original planning input', () => {
  const selection = {
    storeId: 'original-store',
    session: { id: 'original-session', contextSelectionId: 'original-selection' },
    runs: [],
  } as unknown as NativeSelection;
  const extensionInputs = [
    { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
  ];
  expect(nativeTextIntent(selection, 'plan-command', '  original plan\n雪🙂 ', true)).toEqual({
    kind: 'run.start',
    expectedStoreId: 'original-store',
    commandId: 'plan-command',
    content: '  original plan\n雪🙂 ',
    extensionInputs,
  });
  const active = {
    ...selection,
    runs: [{ id: 'original-run', isActive: true, originCommandId: 'original-command' }],
    activeCommand: {
      id: 'original-command',
      sessionId: 'original-session',
      originStoreId: 'original-store',
      kind: 'run.start',
    },
  } as unknown as NativeSelection;
  const queued = nativeTextIntent(active, 'queued-plan', 'next plan', true);
  expect(queued).toEqual({
    kind: 'input.follow_up',
    expectedStoreId: 'original-store',
    commandId: 'queued-plan',
    content: 'next plan',
    afterRunId: 'original-run',
    contextSelectionId: 'original-selection',
    extensionInputs,
  });
  selection.session.contextSelectionId = 'later-selection';
  expect(queued.kind === 'input.follow_up' && queued.contextSelectionId).toBe('original-selection');
  expect(nativeTextIntent(active, 'ordinary', 'ordinary text').kind).toBe('input.follow_up');
});

test('Native input freezes next model and temporary effort only for a new root Run; active steering keeps the original route', () => {
  const selection = {
    storeId: 'original-store',
    session: { id: 'original-session', contextSelectionId: 'selection' },
    runs: [],
  } as unknown as NativeSelection;
  const choice = { modelId: 'actual-model-b', reasoningEffort: 'high' as const };
  const first = nativeTextIntent(selection, 'first', 'original', false, choice);
  expect(first).toMatchObject({
    kind: 'run.start',
    modelId: 'actual-model-b',
    reasoningEffort: 'high',
  });
  choice.modelId = 'later-model';
  expect(first.kind === 'run.start' && first.modelId).toBe('actual-model-b');
  const active = {
    ...selection,
    runs: [{ id: 'run', isActive: true, originCommandId: 'origin' }],
    activeCommand: {
      id: 'origin',
      sessionId: 'original-session',
      originStoreId: 'original-store',
      kind: 'run.start',
    },
  } as unknown as NativeSelection;
  const queued = nativeTextIntent(active, 'queued', 'ordinary input', false, choice);
  expect(queued).toMatchObject({
    kind: 'input.follow_up',
    modelId: 'later-model',
    reasoningEffort: 'high',
  });
  expect(nativeTextIntent(active, 'follow-up', 'next plan', true, choice)).toMatchObject({
    kind: 'input.follow_up',
    afterRunId: 'run',
    modelId: 'later-model',
    reasoningEffort: 'high',
  });
});

test('Native unconfirmed ownership freezes queued follow-up identity and next model without changing Plan or the old Run', () => {
  const selection = {
    storeId: 'store',
    session: { id: 'session', contextSelectionId: 'context' },
    runs: [
      {
        id: 'original-run',
        isActive: true,
        originCommandId: 'original-command',
        status: 'running',
      },
    ],
    activeCommand: {
      id: 'original-command',
      sessionId: 'session',
      originStoreId: 'store',
      kind: 'run.start',
    },
  } as unknown as NativeSelection;
  const before = structuredClone(selection);
  const intent = nativeTextIntent(selection, 'new-command', '  precise input 雪🙂 ', false, {
    modelId: 'next-model',
    reasoningEffort: 'high',
  });
  expect(intent).toEqual({
    kind: 'input.follow_up',
    commandId: 'new-command',
    expectedStoreId: 'store',
    content: '  precise input 雪🙂 ',
    afterRunId: 'original-run',
    contextSelectionId: 'context',
    modelId: 'next-model',
    reasoningEffort: 'high',
  });
  expect(selection).toEqual(before);
  expect(nativeTextIntent(selection, 'held-command', 'held input').kind).toBe('input.follow_up');
  expect(() =>
    nativeTextIntent({ ...selection, activeCommand: undefined }, 'x', 'x', false, undefined),
  ).toThrow('active_command_identity_unavailable');
  expect(() =>
    nativeTextIntent({ ...selection, permissionUnavailable: true }, 'x', 'x', false, undefined),
  ).toThrow('session_view_unavailable');
});

test('local draft storage failures explain that no message was sent without blaming the model', () => {
  for (const code of [
    'draft_storage_unavailable',
    'draft_revision_conflict',
    'browser_draft_save_unconfirmed',
    'draft_not_loaded',
    'draft_changed_before_send',
  ]) {
    expect(nativeInputErrorText('failed', code)).toContain('消息没有发送');
    expect(nativeInputErrorText('failed', code)).not.toContain('模型');
    expect(nativeInputErrorText('unknown', code)).toBe('发送结果尚未确认，稍后将自动核对原提交。');
  }
});
