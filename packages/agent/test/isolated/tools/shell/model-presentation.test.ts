import { expect, test } from 'bun:test';
import { canonicalJson } from '../../../../src/json';
import { modelCursor } from '../../../../src/model-cursor';
import { modelExecutionId } from '../../../../src/model-identifier';
import { shellOperationKey } from '../../../../src/shell-input';
import { formatShellResult } from '../../../../src/shell-result-presentation';
import type { ExecutionRecord, Json } from '../../../../src/storage/types';

function record(id: string, extra: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id,
    sessionId: 'owner',
    runId: 'current-task',
    originCommandId: `command-${id}`,
    originStoreId: 'store',
    rootWorkCommandId: 'original-work',
    rootWorkSeq: '2',
    parentExecutionId: null,
    cancelWithParent: true,
    stepId: `step-${id}`,
    callId: `call-${id}`,
    attempt: 1,
    kind: 'tool',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    status: 'succeeded',
    input: { command: 'printf original' },
    decisionSource: { private: 'PRIVATE_MODEL_DECISION' },
    result: null,
    ownerGeneration: '1',
    cancelRequestedAt: null,
    resultRevision: '1',
    reference: null,
    delivery: null,
    deliveryReason: null,
    deliveryTargetSessionId: null,
    contextSelectionId: null,
    requirements: [],
    resultAcceptance: null,
    interactionBinding: null,
    childSessionId: null,
    childConfiguration: null,
    ...extra,
  };
}

function fixture(status: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' = 'succeeded') {
  const starter = record('original-start');
  const operation = record('original-command', {
    kind: 'job',
    runId: null,
    definitionId: 'shell.command',
    parentExecutionId: starter.id,
    status,
    result: {
      outcome: status,
      content: status === 'failed' ? 'Shell failed' : `Shell ${status}`,
      details: {
        exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 17 : null,
        processTreeStopped: status !== 'outcome_unknown',
      },
    },
    authorization: { dispatched: true },
  });
  const observed: Record<string, Json> = {
    id: operation.id,
    kind: operation.kind,
    definitionId: operation.definitionId,
    definitionVersion: operation.definitionVersion,
    sessionId: operation.sessionId,
    originStoreId: operation.originStoreId,
    status,
    result: operation.result,
  };
  const ref: Record<string, Json> = {
    extensionId: 'builtin.shell',
    executionId: operation.id,
    commandId: operation.originCommandId,
    sessionId: operation.sessionId,
    originStoreId: operation.originStoreId,
    key: shellOperationKey(undefined, starter.id),
  };
  const details: Record<string, Json> = {
    ref,
    execution: observed,
    timedOut: false,
    stdout: '原始输出🪁\n',
    stderr: '',
    stdoutBytes: String(Buffer.byteLength('原始输出🪁\n')),
    stderrBytes: '0',
    truncated: false,
    droppedBytes: '0',
  };
  const result: Record<string, Json> = {
    outcome: status,
    content: canonicalJson(details),
    details,
  };
  starter.result = result;
  return { execution: starter, starter, operation, result, details, observed, ref };
}
function render(f: ReturnType<typeof fixture>) {
  f.result.content = canonicalJson(f.details);
  f.execution.result = f.result;
  return formatShellResult(f);
}
function lifecycle(
  f: ReturnType<typeof fixture>,
  name: 'shell.read' | 'shell.wait' | 'shell.stop',
) {
  f.execution = record(`observe-${name}`, {
    definitionId: name,
    input: { shellId: f.ref.key! },
    result: f.result,
  });
  f.result.outcome = 'succeeded';
  return f;
}

for (const name of [
  'shell.execute',
  'shell.launch',
  'shell.read',
  'shell.wait',
  'shell.stop',
] as const)
  test(`${name} presents the original starter UUID without borrowing its Job or observer identity`, () => {
    const f = fixture();
    if (name === 'shell.launch') f.starter.definitionId = name;
    else if (name !== 'shell.execute') lifecycle(f, name);
    const before = structuredClone(f);
    const body = formatShellResult(f)!;
    expect(body).toContain(`execution_id: ${JSON.stringify(modelExecutionId(f.starter.id))}`);
    expect(body).not.toContain(`execution_id: ${JSON.stringify(modelExecutionId(f.operation.id))}`);
    if (f.execution !== f.starter)
      expect(body).not.toContain(
        `execution_id: ${JSON.stringify(modelExecutionId(f.execution.id))}`,
      );
    expect(body).toContain(`shell_id: ${JSON.stringify(f.ref.key)}`);
    expect(body).toContain(`stdout:\n${f.details.stdout}`);
    expect(f).toEqual(before);
  });

test('a mismatched claimed starter UUID is not formatted as a verified Shell receipt', () => {
  const f = fixture();
  f.details.execution_id = f.operation.id;
  expect(render(f)).toBeUndefined();
});

test('completed command preserves original Unicode streams and usable handle without private records', () => {
  const f = fixture();
  f.details.stdout = '第一行🪁\nJob is a business word\u0000\n';
  f.details.stderr = '程序原文：警告，不等于失败\n';
  f.result.content = canonicalJson(f.details);
  const before = structuredClone(f);
  const body = formatShellResult(f)!;
  expect(body).toContain(`stdout:\n${f.details.stdout}`);
  expect(body).toContain(`stderr:\n${f.details.stderr}`);
  expect(body).toContain(`shell_id: ${JSON.stringify(f.ref.key)}`);
  expect(body).toContain('Exit code: 0');
  expect(body).toContain('supervised processes have stopped');
  for (const secret of ['PRIVATE_MODEL_DECISION', 'originStoreId', 'parentExecutionId'])
    expect(body).not.toContain(secret);
  expect(f).toEqual(before);
});

test('exit17 is a command failure with actionable original diagnostic, not an approval refusal', () => {
  const f = fixture('failed');
  f.details.stderr = 'INPUT_NOT_READY: ready.flag must contain READY.\n';
  const body = render(f)!;
  expect(body).toContain('command failed');
  expect(body).toContain('Exit code: 17');
  expect(body).toContain(f.details.stderr as string);
  expect(body).not.toContain('user denied');
});

test('original command refusal wins over approval of the surrounding tool', () => {
  const f = fixture('failed');
  f.starter.authorization = {
    dispatched: true,
    human: {
      interactionId: 'outer-answer',
      state: 'answered',
      revision: '2',
      acceptedDecisionRevision: '2',
      accepted: true,
      decision: 'approve',
    },
  };
  f.operation.authorization = {
    dispatched: false,
    human: {
      interactionId: 'command-answer',
      state: 'answered',
      revision: '2',
      acceptedDecisionRevision: null,
      accepted: false,
      decision: 'deny',
    },
  };
  f.operation.result = {
    outcome: 'failed',
    content: 'approval_denied',
    details: { adapterAttempted: false, stopConfirmation: null },
  };
  f.observed.result = f.operation.result;
  const body = render(f)!;
  expect(body).toContain('user denied this command');
  expect(body).toContain('It was not executed');
  expect(body).toContain('Do not resubmit');
  expect(body).not.toContain('user approved');
  expect(body).not.toContain('approval_denied');
});

test('approval timeout continuation does not manufacture a review decision', () => {
  const f = fixture();
  f.operation.authorization!.policy = { evidenceId: 'original-policy', reason: 'timeout_continue' };
  f.starter.authorization = {
    dispatched: true,
    check: {
      executionId: 'review',
      status: 'failed',
      decision: 'unavailable',
      reason: 'timeout',
      requireApproval: false,
    },
  };
  const body = render(f)!;
  expect(body).toContain('approval check timed out');
  expect(body).toContain('without a review decision');
  expect(body).not.toContain('risk review allowed');
  expect(body).not.toContain('user approved');
});

test('reused approval is described as reuse rather than a fresh review', () => {
  const f = fixture();
  f.operation.authorization!.policy = {
    evidenceId: 'original-approved-command',
    reason: 'reused_approval',
  };
  const body = render(f)!;
  expect(body).toContain('existing approval was reused');
  expect(body).not.toContain('risk review allowed');
});

test('a saved legacy launch handle remains readable without inventing a new identity', () => {
  const f = fixture();
  f.starter.definitionId = 'shell.launch';
  f.starter.input = { key: 'saved-legacy-shell', command: 'printf original' };
  f.ref.key = 'saved-legacy-shell';
  lifecycle(f, 'shell.read');
  const body = render(f)!;
  expect(body).toContain('shell_id: "saved-legacy-shell"');
  expect(body).toContain('原始输出🪁\n');
});

test('an unaccepted approval answer is not reported as user approval', () => {
  const f = fixture();
  f.starter.authorization = {
    dispatched: true,
    human: {
      interactionId: 'stale-answer',
      state: 'answered',
      revision: '2',
      acceptedDecisionRevision: null,
      accepted: false,
      decision: 'approve',
    },
  };
  expect(render(f)).not.toContain('user approved');
});

test('unknown command effects stay unknown even if an outer observation failed', () => {
  const f = fixture('outcome_unknown');
  f.result.outcome = 'failed';
  f.details.stderr = 'original transport text\n';
  const body = render(f)!;
  expect(body).toContain('may still be running or have produced effects');
  expect(body).toContain('Do not restart');
  expect(body).toContain('original transport text\n');
  expect(body).not.toContain('processes have stopped');
});

test('cancellation receipt alone does not establish process stop or undo earlier changes', () => {
  const f = fixture('cancelled');
  f.operation.result = {
    outcome: 'cancelled',
    content: 'Shell cancelled',
    details: { processTreeStopped: false },
  };
  f.observed.result = f.operation.result;
  const body = render(f)!;
  expect(body).toContain('not rolled back');
  expect(body).not.toContain('processes have stopped');
});

test('foreground execution deadline reports cancellation and only separately proven actual stop', () => {
  const f = fixture('cancelled');
  f.details.timedOut = true;
  f.result.outcome = 'failed';
  const body = render(f)!;
  expect(body).toContain('execution deadline');
  expect(body).toContain('cancellation was requested');
  expect(body).toContain('processes have stopped');
});

for (const name of ['shell.stop', 'shell.wait'] as const)
  test(`${name} retains the original running handle and cannot imply stopped processes`, () => {
    const f = lifecycle(fixture(), name);
    f.operation.status = 'running';
    f.operation.result = null;
    f.observed.status = 'running';
    f.observed.result = null;
    if (name === 'shell.stop') f.details.cancelRequested = true;
    else f.details.timedOut = true;
    const body = render(f)!;
    expect(body).toContain(`shell_id: ${JSON.stringify(f.ref.key)}`);
    expect(body).not.toContain('processes have stopped');
    expect(body).not.toContain('command finished');
    expect(body).toContain(name === 'shell.stop' ? 'does not confirm' : 'wait did not stop');
  });

test('background admission is not command completion', () => {
  const f = fixture();
  f.starter.input = { command: 'printf original', background: true };
  delete f.details.execution;
  f.details.accepted = true;
  const body = render(f)!;
  expect(body).toContain('accepted for background execution');
  expect(body).toContain('Completion has not been confirmed');
  expect(body).not.toContain('command finished');
});

test('paged original output keeps stream order, Unicode, cursor and missing-byte qualification', () => {
  const f = lifecycle(fixture(), 'shell.read');
  delete f.details.stdout;
  delete f.details.stderr;
  const scope = { kind: 'shell_output', ref: f.ref };
  f.execution.input = {
    shellId: f.ref.key!,
    cursor: modelCursor(scope, { afterSeq: '1', upperSeq: '3' }),
  };
  f.details.next_cursor = modelCursor(scope, { afterSeq: '3' });
  f.details.caught_up = true;
  f.details.terminal = true;
  f.details.output = {
    items: [
      {
        executionId: f.operation.id,
        seq: '2',
        throughSeq: '2',
        stream: 'stderr',
        content: '原错误🪁\n',
        droppedBytes: '7',
      },
      {
        executionId: f.operation.id,
        seq: '3',
        throughSeq: '3',
        stream: 'stdout',
        content: '下一行\n',
        droppedBytes: '0',
      },
    ],
    highWaterSeq: '3',
  };
  const body = render(f)!;
  expect(body.indexOf('stderr:\n原错误🪁\n')).toBeLessThan(body.indexOf('stdout:\n下一行\n'));
  expect(body).toContain('Output bytes unavailable: 7');
  expect(body).toContain(JSON.stringify(f.details.next_cursor));
  expect(body).toContain('"caught_up":true');
  expect(body).toContain('"terminal":true');
});

test('a bounded output preview remains explicitly incomplete and recovers the same shell', () => {
  const f = fixture();
  f.details.truncated = true;
  const body = render(f)!;
  expect(body).toContain('This output is incomplete');
  expect(body).toContain('shell_read with the original shell_id');
  expect(body).toContain('do not rerun');
  expect(body).toContain(f.details.stdout as string);
});

test('the default model preview preserves both ends within the approximate 10000-token budget', () => {
  const f = fixture();
  f.details.stdout = `start 🪁${'你'.repeat(15000)}end`;
  const body = render(f)!;
  expect(body).toContain('start 🪁');
  expect(body).toContain('end');
  expect(body).toContain('Model output preview omitted');
  expect(body).not.toContain('\uFFFD');
  expect(Buffer.byteLength(body)).toBeLessThan(40500);
  expect(f.details.stdout).toEndWith(`${'你'.repeat(15000)}end`);
});

for (const damage of [
  'reference',
  'reference-store',
  'handle',
  'parent',
  'owner',
  'store',
  'starter-owner',
  'command',
  'permission',
  'output-owner',
] as const)
  test(`${damage} mismatch cannot borrow an original command receipt or approval`, () => {
    const f = fixture();
    if (damage === 'reference') f.ref.executionId = 'another-command';
    if (damage === 'reference-store') f.ref.originStoreId = 'another-store';
    if (damage === 'handle') f.ref.key = 'another-shell';
    if (damage === 'parent') f.operation.parentExecutionId = 'another-start';
    if (damage === 'owner') f.operation.sessionId = 'another-agent';
    if (damage === 'store') f.operation.originStoreId = 'another-store';
    if (damage === 'starter-owner') f.starter.sessionId = 'another-agent';
    if (damage === 'command') f.operation.input = { command: 'different effect' };
    if (damage === 'permission')
      f.operation.input = {
        command: 'printf original',
        permissions: { filesystem: 'full_access', network: 'internet' },
      };
    if (damage === 'output-owner')
      f.details.output = {
        highWaterSeq: '1',
        items: [{ executionId: 'foreign', stream: 'stdout', content: 'FOREIGN_OUTPUT' }],
      };
    expect(render(f)).toBeUndefined();
  });

test('unmatched saved payload cannot be shortened into a trusted command result', () => {
  const f = fixture();
  f.result.content = '{"unrelated":"FOREIGN_OUTPUT"}';
  expect(formatShellResult(f)).toBeUndefined();
});

test('an original command rejection preserves its verified review reason without leaking the execution envelope', () => {
  const f = fixture('failed');
  const reason = 'The command deletes protected source data.';
  f.operation.authorization = {
    dispatched: false,
    check: {
      executionId: 'original-check',
      status: 'succeeded',
      decision: 'reject',
      reason,
      requireApproval: false,
    },
  };
  f.operation.result = {
    outcome: 'failed',
    content: 'Permission denied; this job was not executed. Reason: hidden-wrapper',
    details: { code: 'permission_denied', reason, adapterAttempted: false },
  };
  f.observed.result = f.operation.result;
  const body = render(f)!;
  expect(body).toContain('Automatic approval rejected this request.');
  expect(body).toContain(reason);
  expect(body).toContain('It was not executed.');
  expect(body).not.toContain('hidden-wrapper');
  expect(body).not.toContain('permission_denied');
  expect(body).not.toMatch(/\bjob\b/i);
  expect(f.operation.result).toMatchObject({ content: expect.stringContaining('this job') });
});
