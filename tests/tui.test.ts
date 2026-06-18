import { describe, expect, test } from 'bun:test';
import { TuiUserInputProvider } from '../src/app/tui/provider';
import type { AgentEvent } from '../src/protocol/events';

describe('TuiUserInputProvider', () => {
  test('onEvent dispatches events to the callback', () => {
    const received: AgentEvent[] = [];
    const provider = new TuiUserInputProvider((e) => received.push(e));

    provider.onEvent({ type: 'text', data: { text: 'hello' } });
    provider.onEvent({ type: 'final', data: 'done' });

    expect(received).toHaveLength(2);
    expect(received[0]!.type).toBe('text');
    expect(received[1]!.type).toBe('final');
  });

  test('requestAction blocks until submitAction is called', async () => {
    const provider = new TuiUserInputProvider(() => {});

    const actionPromise = provider.requestAction({
      kind: 'approval',
      approval: {
        scope: 'once',
        cwd: '/tmp',
        threadId: 't1',
        tool: 'shell_execute',
        command: 'echo hi',
        risk: 'execute_code',
        approvalHash: 'abc',
        summary: 'run echo',
        reason: 'test',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    });

    let resolved = false;
    actionPromise.then(() => {
      resolved = true;
    });
    await Bun.sleep(10);
    expect(resolved).toBe(false);

    provider.submitAction({ type: 'approve', grant: 'approve_once' });
    const result = await actionPromise;
    expect(result.type).toBe('approve');
  });

  test('getPendingInterrupt returns null when no interrupt pending', () => {
    const provider = new TuiUserInputProvider(() => {});
    expect(provider.getPendingInterrupt()).toBeNull();
  });

  test('getPendingInterrupt returns the payload during an active request', async () => {
    const provider = new TuiUserInputProvider(() => {});
    const payload = {
      kind: 'input' as const,
      question: { question: 'What?', options: [], allow_free_text: true },
    };

    const promise = provider.requestAction(payload);
    expect(provider.getPendingInterrupt()).toEqual(payload);

    provider.submitAction({ type: 'input', text: 'answer' });
    await promise;
    expect(provider.getPendingInterrupt()).toBeNull();
  });

  test('teardown resolves pending promise with cancel action', async () => {
    const provider = new TuiUserInputProvider(() => {});

    const promise = provider.requestAction({
      kind: 'approval',
      approval: {
        scope: 'once',
        cwd: '/tmp',
        threadId: 't1',
        tool: 'shell_execute',
        command: 'echo hi',
        risk: 'execute_code',
        approvalHash: 'abc',
        summary: 'run echo',
        reason: 'test',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    });

    await provider.teardown();
    const result = await promise;
    expect(result.type).toBe('cancel');
    expect(provider.getPendingInterrupt()).toBeNull();
  });

  test('file_change event type is correct', () => {
    const event: AgentEvent = {
      type: 'file_change',
      data: { path: '/tmp/test.txt', kind: 'add' },
    };
    expect(event.type).toBe('file_change');
    expect(event.data.path).toBe('/tmp/test.txt');
    expect(event.data.kind).toBe('add');
  });
});
