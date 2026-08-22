import { describe, expect, test } from 'bun:test';
import {
  assertRuntimeCommand,
  isRuntimeCommand,
  RUNTIME_COMMAND_SCHEMA_V1,
  RUNTIME_CONTRACT_BOUNDARY_V1,
  RUNTIME_CONTRACT_SCHEMA_V1,
  type RuntimeAccess,
  type RuntimeCommand,
} from '@kite/runtime-contract';

describe('runtime contract package boundary', () => {
  test('is a frozen private in-process Contract', () => {
    expect(RUNTIME_CONTRACT_BOUNDARY_V1).toEqual({
      audience: 'kite-app',
      transport: 'in-process',
      revision: 'rmv1-03',
      schema: RUNTIME_CONTRACT_SCHEMA_V1,
    });
    expect(Object.isFrozen(RUNTIME_CONTRACT_BOUNDARY_V1)).toBe(true);
  });

  test('accepts only the RMV1 command envelope', () => {
    const command: RuntimeCommand = {
      schema: RUNTIME_COMMAND_SCHEMA_V1,
      commandId: 'command-1',
      type: 'create_session',
      workspace: '/workspace',
      bootstrapSessionId: 'session-1',
      projectHandle: {
        version: 1,
        installationId: 'install-test',
        keyId: `sha256:${'1'.repeat(64)}`,
        project: {
          projectId: 'project_test',
          revision: 1,
          workspaceDigest: `sha256:${'2'.repeat(64)}`,
        },
        canonicalWorkspaceDigest: `sha256:${'2'.repeat(64)}`,
        bootstrapIdentity: 'session-1',
        issuedAt: '2026-08-22T00:00:00.000Z',
        expiresAt: '2026-08-22T00:05:00.000Z',
        nonce: 'nonce-1',
        authenticator: `hmac-sha256:${'3'.repeat(64)}`,
      },
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
});
