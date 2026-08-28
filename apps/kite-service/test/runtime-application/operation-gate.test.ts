import { describe, expect, test } from 'bun:test';
import {
  createRuntimeOperationGate,
  RuntimeOperationGateError,
} from '../../src/runtime-application/operation-gate';

describe('RuntimeOperationGate', () => {
  test('quiesces admission and reports active work without waiting for it', async () => {
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = createRuntimeOperationGate();
    const running = gate.runMutation(async () => active);
    const quiescing = gate.quiesce();

    expect(gate.phase).toBe('quiescing');
    expect(gate.activeOperations).toBe(true);
    await expect(gate.runMutation(() => undefined)).rejects.toBeInstanceOf(
      RuntimeOperationGateError,
    );

    const lease = await quiescing;
    expect(lease.activeOperations).toBe(true);
    let committed = false;
    const commit = lease.commitDrain().then(() => {
      committed = true;
    });
    await Promise.resolve();
    expect(committed).toBe(false);

    release();
    await running;
    await commit;
    expect(gate.phase).toBe('draining');
    await expect(gate.runMutation(() => undefined)).rejects.toMatchObject({
      code: 'operation_gate_draining',
    });
  });

  test('resume reopens admission only before drain commit', async () => {
    const gate = createRuntimeOperationGate();
    const lease = await gate.quiesce();
    expect(lease.activeOperations).toBe(false);
    lease.resume();
    expect(gate.phase).toBe('open');
    await expect(gate.runMutation(() => 'accepted')).resolves.toBe('accepted');

    const second = await gate.quiesce();
    await second.commitDrain();
    second.resume();
    expect(gate.phase).toBe('draining');
  });
});
