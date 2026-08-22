import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_COMMAND_SCHEMA_V1 } from '@kite/runtime-contract';
import type { RuntimeHostExecutionBridge } from '../src/execution-bridge';
import { translateRuntimeCommandToKernelInput } from '../src/kernel-input';
import { createProjectIdentityStoreV1 } from '../src/project-identity';
import { bindProjectIdentityToRuntimeBridgeV1 } from '../src/project-identity-bridge';

test('Host verifies ProjectHandle before the CreateSession bridge can run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-project-bridge-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const projects = createProjectIdentityStoreV1({
      path: join(root, 'authority', 'projects.json'),
      installationId: 'install_test',
      keyId: `sha256:${'1'.repeat(64)}`,
      authenticatorKey: new Uint8Array(32).fill(1),
    });
    const handle = projects.issueHandleSync({ workspace, bootstrapIdentity: 'session-1' });
    let bridgeCalls = 0;
    const delegate: RuntimeHostExecutionBridge = {
      recoverSession: async () => {},
      prepare: async (input) => {
        bridgeCalls += 1;
        const command = input.events[0]!.command;
        return {
          receipt: {
            status: 'applied',
            commandId: command.commandId,
            sessionId: 'session-1',
            revision: 0,
          },
        };
      },
      query: async (query) => ({ status: 'rejected', queryType: query.type, code: 'unsupported' }),
      shutdownSession: async () => {},
      close: async () => {},
    };
    const bridge = bindProjectIdentityToRuntimeBridgeV1({ projects, bridge: delegate });
    const command = {
      schema: RUNTIME_COMMAND_SCHEMA_V1,
      commandId: 'create-1',
      type: 'create_session' as const,
      workspace,
      bootstrapSessionId: 'session-1',
      projectHandle: handle,
    };
    expect(
      (await bridge.prepare(translateRuntimeCommandToKernelInput(command), () => {})).receipt,
    ).toMatchObject({ status: 'applied' });
    expect(bridgeCalls).toBe(1);

    const forged = {
      ...command,
      commandId: 'create-2',
      projectHandle: { ...handle, authenticator: `hmac-sha256:${'0'.repeat(64)}` as const },
    };
    expect(
      (await bridge.prepare(translateRuntimeCommandToKernelInput(forged), () => {})).receipt,
    ).toMatchObject({ status: 'rejected', code: 'invalid_session' });
    expect(bridgeCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
