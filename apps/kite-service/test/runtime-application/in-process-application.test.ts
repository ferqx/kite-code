import { describe, expect, test } from 'bun:test';
import {
  EXECUTION_STATUS_RESPONSE_SCHEMA_,
  type KiteWorkspaceIdentity,
  MCP_ACTION_RESPONSE_SCHEMA_,
  MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
  SKILL_CATALOG_REQUEST_SCHEMA_,
  SKILL_CATALOG_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeAccess,
  type RuntimeAccessNotification,
  type RuntimeCommand,
} from '@kite-ai/runtime-contract';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import type { KiteAppControlHandlerPorts } from '../../src/app-control';
import { createInProcessKiteRuntimeApplication } from '../../src/runtime-application';

const A = identity('/workspace/a', 'project-a', 'a');
const B = identity('/workspace/b', 'project-b', 'b');
const EXTERNAL_READ_SCOPE = { roots: [], digest: `sha256:${'0'.repeat(64)}` as const };

function identity(path: string, projectId: string, digest: string): KiteWorkspaceIdentity {
  return {
    canonicalPath: path,
    projectId,
    workspaceDigest: `sha256:${digest.repeat(64)}`,
  };
}

function admission(workspace: string): RuntimeServerAdmissionPort {
  return { authorize: async () => ({ allowed: true, workspace }) };
}

function handlers(workspace: KiteWorkspaceIdentity): KiteAppControlHandlerPorts {
  const unavailable = async (): Promise<never> => {
    throw new Error('unused test route');
  };
  return {
    workspaceTrust: {
      query: async () => ({
        schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
        workspace,
        status: 'trusted',
        revision: 'trust-1',
        canDecide: false,
        externalReadScope: EXTERNAL_READ_SCOPE,
      }),
      decide: async () => ({
        schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
        workspace,
        status: 'trusted',
        outcome: 'already_trusted',
        revision: 'trust-1',
        externalReadScope: EXTERNAL_READ_SCOPE,
      }),
    },
    providerModel: {
      snapshot: unavailable,
      select: async () => ({
        schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
        outcome: 'unavailable',
        snapshot: {
          schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
          workspace,
          revision: 'provider-1',
          providers: [],
        },
      }),
    },
    mcp: {
      snapshot: unavailable,
      apply: async () => ({
        schema: MCP_ACTION_RESPONSE_SCHEMA_,
        outcome: 'unavailable',
        snapshot: {
          schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
          workspace,
          revision: 'mcp-1',
          sourceRevisions: { project: 'project-1', user: 'user-1' },
          servers: [],
        },
      }),
    },
    skills: {
      snapshot: async () => ({
        schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
        workspace,
        revision: `skills-${workspace.projectId}`,
        skills: [],
      }),
    },
    execution: {
      snapshot: async () => ({
        schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
        workspace,
        revision: 'execution-1',
        admitted: true,
        sandboxBackend: 'none',
        filesystemScope: 'workspace_write',
        networkMode: 'off',
        controllerWorktreeActive: false,
      }),
    },
    release: {
      snapshot: async () => ({
        schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
        revision: 'release-1',
        active: false,
        production: false,
        capabilities: [],
        execution: { admitted: false },
      }),
    },
  };
}

describe('InProcess Kite Runtime Application composition', () => {
  test('shares one mutation gate and binds connection admission plus App Control by Workspace', async () => {
    const runtime = new FakeRuntime();
    const application = createInProcessKiteRuntimeApplication({
      runtimeOwner: runtime,
      history: {} as never,
      defaultAdmission: admission(A.canonicalPath),
      defaultWorkspace: A,
      server: {
        serverInfo: { version: 'test', instanceId: 'application-test' },
      },
      createAppControlHandlers: handlers,
      cancelAll: async () => undefined,
      dispose: async () => undefined,
    });
    const first = client(() => application.open({ admission: admission(A.canonicalPath) }), 'a');
    const second = client(() => application.open({ admission: admission(B.canonicalPath) }), 'b');
    try {
      await Promise.all([
        first.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'create-a',
          type: 'create_session',
          workspace: '/wire/a',
          bootstrapSessionId: 'session-a',
        }),
        second.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'create-b',
          type: 'create_session',
          workspace: '/wire/b',
          bootstrapSessionId: 'session-b',
        }),
      ]);
      expect(
        runtime.commands.flatMap((command) =>
          command.type === 'create_session' ? [command.workspace] : [],
        ),
      ).toEqual([A.canonicalPath, B.canonicalPath]);

      const [skillsA, skillsB] = await Promise.all([
        application.appControlFor(A).getSkillCatalog({
          schema: SKILL_CATALOG_REQUEST_SCHEMA_,
          workspace: A,
        }),
        application.appControlFor(B).getSkillCatalog({
          schema: SKILL_CATALOG_REQUEST_SCHEMA_,
          workspace: B,
        }),
      ]);
      expect(skillsA.revision).toBe('skills-project-a');
      expect(skillsB.revision).toBe('skills-project-b');
      await expect(
        application.appControlFor(A).getSkillCatalog({
          schema: SKILL_CATALOG_REQUEST_SCHEMA_,
          workspace: B,
        }),
      ).rejects.toMatchObject({ code: 'invalid_app_control_request' });
    } finally {
      await Promise.all([first.close(), second.close()]);
      await application[Symbol.asyncDispose]();
    }
  });
});

class FakeRuntime implements RuntimeAccess {
  readonly commands: RuntimeCommand[] = [];

  async command(command: RuntimeCommand) {
    this.commands.push(command);
    return {
      status: 'applied' as const,
      commandId: command.commandId,
      sessionId:
        command.type === 'create_session'
          ? (command.bootstrapSessionId ?? 'generated-session')
          : 'test-session',
      revision: 1,
    };
  }

  async query(_query: Parameters<RuntimeAccess['query']>[0]) {
    return { status: 'ok' as const, queryType: 'list_sessions' as const, sessions: [] };
  }

  subscribe(): AsyncIterable<RuntimeAccessNotification> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true as const, value: undefined }),
        };
      },
    };
  }
}

function client(
  open: () => ReturnType<ReturnType<typeof createInProcessKiteRuntimeApplication>['open']>,
  instanceId: string,
): RuntimeClient {
  const transport: RuntimeClientTransport = {
    connect: async () => {
      const pair = open();
      return {
        send: (message) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason) => pair.client.close(reason),
      };
    },
  };
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'runtime-application-test', version: '1', instanceId },
  });
}
