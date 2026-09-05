import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TuiUserInputProvider } from '../src/tui/provider';

describe('TuiUserInputProvider', () => {
  test('TUI reducer exposes accepted presentation envelopes as its streamed event action', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const actions = readFileSync(join(root, 'apps/kite-cli/src/tui/reducers/actions.ts'), 'utf8');
    const reducer = readFileSync(join(root, 'apps/kite-cli/src/tui/reducers/index.ts'), 'utf8');

    expect(actions).not.toContain("type: 'EVENT'");
    expect(reducer).not.toContain("action.type === 'EVENT'");
    expect(actions).toContain("type: 'ACCEPT_PRESENTATION_ENVELOPE'");
    expect(actions).not.toContain("type: 'RUNTIME_EVENT'");
  });

  test('does not expose the retired AgentEvent forwarding method', () => {
    const provider = new TuiUserInputProvider();
    expect('onEvent' in provider).toBe(false);
  });

  test('requestAction blocks until submitAction is called', async () => {
    const provider = new TuiUserInputProvider();

    const actionPromise = provider.requestAction({
      kind: 'approval',
      interactionId: 'approval-1',
      sessionRevision: 0,
      generation: 1,
      grants: ['approve_once'],
      owner: { kind: 'root_tool', toolCallId: 'approval-1' },
      title: 'shell_execute',
      summary: 'run echo',
    });

    let resolved = false;
    actionPromise.then(() => {
      resolved = true;
    });
    await Bun.sleep(10);
    expect(resolved).toBe(false);

    await provider.submitActionAsync({
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

    await provider.submitActionAsync({ type: 'input', text: 'answer' });
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
      owner: { kind: 'root_tool', toolCallId: 'approval-2' },
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
      owner: { kind: 'root_tool', toolCallId: 'approval-generation-2' },
      title: 'shell_execute',
      summary: 'run echo',
    });

    await provider.submitActionAsync({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 1,
      grant: 'approve_once',
    });
    await Bun.sleep(5);
    expect(provider.getPendingInterrupt()?.interactionId).toBe('approval-generation-2');

    const accepted = provider.submitActionAsync({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 2,
      grant: 'approve_once',
    });
    const duplicate = provider.submitActionAsync({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 2,
      grant: 'approve_once',
    });
    expect(await Promise.all([accepted, duplicate])).toEqual([true, false]);
    await expect(promise).resolves.toMatchObject({
      type: 'approve',
      interactionId: 'approval-generation-2',
      generation: 2,
    });
  });

  test('an older action-sink cleanup cannot disconnect the current Runtime owner', async () => {
    const provider = new TuiUserInputProvider();
    const received: string[] = [];
    const releaseOld = provider.setActionSink(() => {
      received.push('old');
    });
    provider.setActionSink(() => {
      received.push('current');
    });

    releaseOld();
    await expect(
      provider.submitActionAsync({
        type: 'approve',
        interactionId: 'approval-current-owner',
        generation: 0,
        grant: 'approve_once',
      }),
    ).resolves.toBe(true);
    expect(received).toEqual(['current']);
  });

  test('a failed Runtime confirmation remains retryable until a receipt is accepted', async () => {
    const provider = new TuiUserInputProvider();
    let attempts = 0;
    provider.setActionSink(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('transport unavailable');
    });
    const action = {
      type: 'approve' as const,
      interactionId: 'approval-retry',
      generation: 0,
      grant: 'approve_once' as const,
    };

    await expect(provider.submitActionAsync(action)).rejects.toThrow('transport unavailable');
    await expect(provider.submitActionAsync(action)).resolves.toBe(true);
    expect(attempts).toBe(2);
  });
});
