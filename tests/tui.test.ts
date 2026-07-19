import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TuiUserInputProvider } from '../src/app/tui/provider';

describe('TuiUserInputProvider', () => {
  test('TUI reducer exposes RuntimeEvent as its only streamed event action', () => {
    const root = dirname(import.meta.dir);
    const actions = readFileSync(join(root, 'src/app/tui/reducers/actions.ts'), 'utf8');
    const reducer = readFileSync(join(root, 'src/app/tui/reducers/index.ts'), 'utf8');

    expect(actions).not.toContain("type: 'EVENT'");
    expect(reducer).not.toContain("action.type === 'EVENT'");
  });

  test('does not expose the retired AgentEvent forwarding method', () => {
    const provider = new TuiUserInputProvider();
    expect('onEvent' in provider).toBe(false);
  });

  test('requestAction blocks until submitAction is called', async () => {
    const provider = new TuiUserInputProvider();

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
    const provider = new TuiUserInputProvider();
    expect(provider.getPendingInterrupt()).toBeNull();
  });

  test('getPendingInterrupt returns the payload during an active request', async () => {
    const provider = new TuiUserInputProvider();
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
    const provider = new TuiUserInputProvider();

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
});
