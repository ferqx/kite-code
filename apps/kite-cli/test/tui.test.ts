import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TuiUserInputProvider } from '../src/tui/provider';
import {
  shouldAbortStoppedRun,
  shouldProjectRunExited,
  shouldSetIdleAfterRun,
} from '../src/tui/run-lifecycle';

describe('TuiUserInputProvider', () => {
  test('TUI reducer exposes RuntimeEvent as its only streamed event action', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const actions = readFileSync(join(root, 'apps/kite-cli/src/tui/reducers/actions.ts'), 'utf8');
    const reducer = readFileSync(join(root, 'apps/kite-cli/src/tui/reducers/index.ts'), 'utf8');

    expect(actions).not.toContain("type: 'EVENT'");
    expect(reducer).not.toContain("action.type === 'EVENT'");
  });

  test('does not expose the retired AgentEvent forwarding method', () => {
    const provider = new TuiUserInputProvider();
    expect('onEvent' in provider).toBe(false);
  });

  test('does not let an older cancelled run clear a successor prompt', () => {
    expect(shouldSetIdleAfterRun(true, 1, 2)).toBe(false);
    expect(shouldSetIdleAfterRun(true, 2, 2)).toBe(true);
    expect(shouldSetIdleAfterRun(false, 1, 1)).toBe(false);
  });
  test('does not project terminal exit from a generator closed by cancellation', () => {
    expect(shouldProjectRunExited({ aborted: false, signalAborted: true, foreground: true })).toBe(
      false,
    );
    expect(shouldProjectRunExited({ aborted: true, signalAborted: false, foreground: true })).toBe(
      false,
    );
    expect(
      shouldProjectRunExited({ aborted: false, signalAborted: false, foreground: false }),
    ).toBe(false);
    expect(shouldProjectRunExited({ aborted: false, signalAborted: false, foreground: true })).toBe(
      true,
    );
  });
  test('does not abort a run that already emitted its terminal exit state', () => {
    expect(
      shouldAbortStoppedRun({
        wasRunning: true,
        running: false,
        ctrlCPressed: false,
        exited: true,
      }),
    ).toBe(false);
    expect(
      shouldAbortStoppedRun({
        wasRunning: true,
        running: false,
        ctrlCPressed: false,
        exited: false,
      }),
    ).toBe(true);
    expect(
      shouldAbortStoppedRun({
        wasRunning: false,
        running: false,
        ctrlCPressed: false,
        exited: false,
      }),
    ).toBe(false);
  });

  test('requestAction blocks until submitAction is called', async () => {
    const provider = new TuiUserInputProvider();

    const actionPromise = provider.requestAction({
      kind: 'approval',
      interactionId: 'approval-1',
      sessionRevision: 0,
      generation: 1,
      grants: ['approve_once'],
      title: 'shell_execute',
      summary: 'run echo',
    });

    let resolved = false;
    actionPromise.then(() => {
      resolved = true;
    });
    await Bun.sleep(10);
    expect(resolved).toBe(false);

    provider.submitAction({
      type: 'approve',
      interactionId: 'approval-1',
      generation: 1,
      grant: 'approve_once',
    });
    const result = await actionPromise;
    expect(result.type).toBe('approve');
  });

  test('getPendingInterrupt returns null when no interrupt pending', () => {
    const provider = new TuiUserInputProvider();
    expect(provider.getPendingInterrupt()).toBeNull();
  });

  test('getPendingInterrupt returns the payload during an active request', async () => {
    const provider = new TuiUserInputProvider();
    const payload = {
      kind: 'input' as const,
      interactionId: 'input-1',
      sessionRevision: 0,
      question: 'What?',
      options: [],
      allowFreeText: true,
    };

    const promise = provider.requestAction(payload);
    expect(provider.getPendingInterrupt()).toEqual(payload);

    provider.submitAction({ type: 'input', text: 'answer' });
    await promise;
    expect(provider.getPendingInterrupt()).toBeNull();
  });

  test('teardown resolves pending promise with cancel action', async () => {
    const provider = new TuiUserInputProvider();

    const promise = provider.requestAction({
      kind: 'approval',
      interactionId: 'approval-2',
      sessionRevision: 0,
      generation: 1,
      grants: ['approve_once'],
      title: 'shell_execute',
      summary: 'run echo',
    });

    await provider.teardown();
    const result = await promise;
    expect(result.type).toBe('cancel');
    expect(provider.getPendingInterrupt()).toBeNull();
  });

  test('ignores stale approval generation and de-duplicates the exact pair', async () => {
    const provider = new TuiUserInputProvider();
    const promise = provider.requestAction({
      kind: 'approval',
      interactionId: 'approval-generation-2',
      sessionRevision: 0,
      generation: 2,
      grants: ['approve_once'],
      title: 'shell_execute',
      summary: 'run echo',
    });

    provider.submitAction({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 1,
      grant: 'approve_once',
    });
    await Bun.sleep(5);
    expect(provider.getPendingInterrupt()?.interactionId).toBe('approval-generation-2');

    provider.submitAction({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 2,
      grant: 'approve_once',
    });
    provider.submitAction({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 2,
      grant: 'approve_once',
    });
    await expect(promise).resolves.toMatchObject({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 2,
    });
  });
});
