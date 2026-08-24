import { describe, expect, test } from 'bun:test';
import {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  assertRuntimeCommand,
  isRuntimeCommand,
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_CONTRACT_BOUNDARY_,
  RUNTIME_CONTRACT_SCHEMA_,
  type RuntimeAccess,
  type RuntimeCommand,
} from '@kite/runtime-contract';

describe('runtime contract package boundary', () => {
  test('is a frozen private in-process Contract', () => {
    expect(RUNTIME_CONTRACT_BOUNDARY_).toEqual({
      audience: 'kite-app',
      transport: 'in-process',
      revision: 'runtime-contract-current',
      schema: RUNTIME_CONTRACT_SCHEMA_,
    });
    expect(Object.isFrozen(RUNTIME_CONTRACT_BOUNDARY_)).toBe(true);
  });

  test('accepts only the RM command envelope', () => {
    const command: RuntimeCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'command-1',
      type: 'create_session',
      workspace: '/workspace',
      bootstrapSessionId: 'session-1',
    };
    expect(isRuntimeCommand(command)).toBe(true);
    expect(isRuntimeCommand({ ...command, schema: 'future' })).toBe(false);
    expect(() => assertRuntimeCommand({ ...command, commandId: '' })).toThrow(
      'Invalid RuntimeCommand',
    );
  });

  test('describes command/query/subscription without internal authority', () => {
    const access: RuntimeAccess = {
      command: async (command) => ({
        status: 'rejected',
        commandId: command.commandId,
        code: 'unsupported',
      }),
      query: async (query) => ({
        status: 'rejected',
        queryType: query.type,
        code: 'unsupported',
      }),
      subscribe: async function* () {},
    };
    expect(access).toBeDefined();
  });

  test('validates bounded opaque log cursors without SQLite or HTTP types', () => {
    expect(() =>
      assertListRuntimeLogSessionsRequest({
        limit: 2,
        cursor: { updatedAt: 10, sessionId: 'session-1' },
      }),
    ).not.toThrow();
    expect(() =>
      assertListRuntimeLogEventsRequest({
        sessionId: 'session-1',
        direction: 'forward',
        limit: 2,
        afterSequence: 1,
        beforeSequence: 2,
      }),
    ).toThrow('mutually exclusive');
    expect(() =>
      assertListRuntimeLogEventsRequest({
        sessionId: 'session-1',
        direction: 'forward',
        limit: 201,
      }),
    ).toThrow('1 to 200');
  });
});
