import { describe, expect, test } from 'bun:test';
import {
  BuiltinMechanismAuthorityError,
  mergeBuiltinMechanismBundle,
} from '@kite-ai/builtin-runtime';

describe('Builtin mechanism authority', () => {
  test('accepts one exact frozen mechanism and freezes the merged bundle', () => {
    const filesystem = Object.freeze({
      allowExternalPaths: false,
      dispatch: async () => Object.freeze({ ok: true }),
    });
    const merged = mergeBuiltinMechanismBundle({
      executionMechanism: 'filesystem',
      prepared: Object.freeze({ filesystem }),
    });

    expect(merged).toEqual({ filesystem });
    expect(Object.isFrozen(merged)).toBe(true);
  });

  test('accepts only typed managed Shell control ports', () => {
    const shell = Object.freeze({
      read: async () => Object.freeze({ status: 'running' }),
      stop: async () => Object.freeze({ status: 'stopping' }),
    });
    expect(
      mergeBuiltinMechanismBundle({
        executionMechanism: 'shell',
        prepared: Object.freeze({ shell }),
      }),
    ).toEqual({ shell });
    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'shell',
        prepared: Object.freeze({ shell: Object.freeze({ read: true }) }),
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
  });

  test('accepts one Agent mailbox authority for task control and rejects mixed owners', () => {
    const agentMailbox = Object.freeze({
      caller: Object.freeze({ sessionId: 'source' }),
      listAgents: async () => ({ ok: false }),
      waitAgent: async () => ({ ok: false }),
      submitMessage: async () => ({ ok: true }),
      interruptAgent: async () => ({ ok: false }),
    });
    const taskControl = Object.freeze({
      cancelTask: async () => ({}),
      readTask: async () => ({}),
      waitTasks: async () => ({}),
    });
    expect(
      mergeBuiltinMechanismBundle({
        executionMechanism: 'task_control',
        prepared: Object.freeze({ agentMailbox }),
      }),
    ).toEqual({ agentMailbox });
    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'task_control',
        prepared: Object.freeze({ agentMailbox, taskControl }),
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
  });

  test('rejects duplicate or mismatched mechanism owners fail closed', () => {
    const mcp = Object.freeze({
      runtime: Object.freeze({ callCapability: async () => Object.freeze({}) }),
    });

    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'mcp',
        prepared: Object.freeze({ mcp }),
        runner: Object.freeze({ mcp }),
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'filesystem',
        prepared: Object.freeze({ mcp }),
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
  });

  test('rejects mutable maps before any mechanism can be selected', () => {
    expect(() =>
      mergeBuiltinMechanismBundle({
        executionMechanism: 'mcp',
        prepared: { mcp: Object.freeze({ runtime: Object.freeze({}) }) },
      }),
    ).toThrow(BuiltinMechanismAuthorityError);
  });
});
