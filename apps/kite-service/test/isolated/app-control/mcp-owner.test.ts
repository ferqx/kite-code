import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  McpControlSnapshot,
  McpRuntimeProvider,
  McpServerControlState,
  McpServerKey,
  McpSupervisor,
} from '@kite-ai/builtin-runtime/mcp';
import {
  type AppMcpActionRequest,
  type AppMcpSnapshotRequest,
  type KiteWorkspaceIdentity,
  MCP_ACTION_REQUEST_SCHEMA_,
  MCP_SNAPSHOT_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
import type { McpConfigCommand } from '#kite-service/config/mcp-config-repository';
import { computeProjectMcpConfigDigest } from '#kite-service/config/mcp-project-approvals';
import { createMcpOwner } from '../../../src/app-control/owners/mcp-owner';

let root: string;
let previousKiteCodeHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kite-mcp-owner-'));
  previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = join(root, 'kite-home');
  mkdirSync(process.env.KITE_CODE_HOME, { recursive: true });
});

afterEach(() => {
  if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
  else process.env.KITE_CODE_HOME = previousKiteCodeHome;
  rmSync(root, { recursive: true, force: true });
});

function identity(path: string): KiteWorkspaceIdentity {
  const project = resolveProjectIdentity(path);
  return {
    canonicalPath: path,
    projectId: project.projectId,
    workspaceDigest: project.workspaceDigest,
  };
}

interface Fixture {
  readonly workspace: KiteWorkspaceIdentity;
  readonly server: McpServerControlState;
  readonly supervisor: FakeSupervisor;
}

function fixture(): Fixture {
  const workspacePath = join(root, 'workspace');
  const sourcePath = join(workspacePath, '.kite-code', 'mcp.json');
  mkdirSync(join(workspacePath, '.kite-code'), { recursive: true });
  const rawConfig = {
    type: 'stdio',
    command: '/usr/bin/node',
    args: ['--token', 'credential-secret'],
  } as const;
  writeFileSync(sourcePath, JSON.stringify({ mcpServers: { docs: rawConfig } }));
  const configDigest = computeProjectMcpConfigDigest({
    serverName: 'docs',
    sourceKind: 'project',
    rawConfig,
  });
  const workspace = identity(workspacePath);
  const server = {
    key: { name: 'docs', source: 'project' },
    effective: true,
    configStatus: 'pending_approval',
    authStatus: 'authorizing',
    credentialPresent: true,
    authFlowId: 'flow-1',
    health: 'ready',
    transport: 'stdio',
    contentEgress: {
      remote: false,
      nonEmptyArgumentsClassification: 'confidential',
      independentPermitRequired: false,
    },
    source: 'project',
    sourcePath,
    configuration: {
      command: '/usr/bin/node --token credential-secret',
      argumentCount: 2,
      endpoint: 'https://mcp.example.test/path?token=credential-secret',
    },
    revision: 'server-revision-1',
    enabled: true,
    required: false,
    capabilityRevision: 'capability-revision-1',
    toolCount: 1,
    availableToolCount: 1,
    resourceCount: 1,
    promptCount: 1,
    tools: [
      {
        name: 'search',
        description: 'Search documentation.',
        parameters: [{ name: 'query', required: true, type: 'string' }],
        discovered: true,
        enabled: true,
        availability: 'available',
        available: true,
        declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
        effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
        annotationProvenance: 'remote',
        policySource: 'default',
        minimumApproval: 'none',
        retry: 'never',
      },
    ],
    resources: [{ uri: 'https://mcp.example.test/private?token=credential-secret', name: 'docs' }],
    prompts: [{ name: 'summarize', description: 'Summarize a document.' }],
    approval: {
      configDigest,
      review: {
        command: '/usr/bin/node --token credential-secret',
        argumentCount: 2,
        endpoint: 'https://mcp.example.test/path?token=credential-secret',
      },
    },
    diagnostic: {
      code: 'auth_required',
      retryable: false,
      message: 'Bearer credential-secret',
    },
  } as McpServerControlState;
  const supervisor = new FakeSupervisor({
    revision: 'control-revision-1',
    generation: 1,
    servers: [server],
    sourceRevisions: { project: 'project-revision-1', user: 'user-revision-1' },
  });
  return { workspace, server, supervisor };
}

function snapshotRequest(workspace: KiteWorkspaceIdentity): AppMcpSnapshotRequest {
  return { schema: MCP_SNAPSHOT_REQUEST_SCHEMA_, workspace };
}

function actionRequest(
  workspace: KiteWorkspaceIdentity,
  action: AppMcpActionRequest['action'],
): AppMcpActionRequest {
  return { schema: MCP_ACTION_REQUEST_SCHEMA_, workspace, action };
}

class FakeSupervisor implements McpSupervisor {
  readonly starts: string[] = [];
  readonly mutations: McpConfigCommand[] = [];
  readonly retries: McpServerKey[] = [];
  readonly logins: McpServerKey[] = [];
  readonly cancelledFlows: string[] = [];
  readonly removed: Array<{ key: McpServerKey; expectedRevision: string }> = [];
  readonly provider = {} as McpRuntimeProvider;
  reloads = 0;
  stopCalls = 0;
  retryError: unknown;
  mutateError: unknown;
  private readonly control: McpControlSnapshot;

  constructor(control: McpControlSnapshot) {
    this.control = control;
  }

  async start(workspace: string): Promise<void> {
    this.starts.push(workspace);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  async retry(key: McpServerKey): Promise<void> {
    this.retries.push(key);
    if (this.retryError) throw this.retryError;
  }

  async mutate(command: McpConfigCommand): Promise<void> {
    this.mutations.push(command);
    if (this.mutateError) throw this.mutateError;
  }

  async remove(key: McpServerKey, expectedRevision: string) {
    this.removed.push({ key, expectedRevision });
    return { credentialCleanup: 'completed' as const };
  }

  async login(key: McpServerKey) {
    this.logins.push(key);
    return {
      status: 'authorization_required' as const,
      flowId: 'flow-1',
      authorizationUrl: 'https://mcp.example.test/oauth?token=credential-secret',
    };
  }

  async cancelAuth(flowId: string) {
    this.cancelledFlows.push(flowId);
    return { status: 'cancelled' as const };
  }

  async logout() {
    return { status: 'logged_out' as const };
  }

  getSnapshot(): McpControlSnapshot {
    return this.control;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  getRuntimeProvider(): McpRuntimeProvider {
    return this.provider;
  }
}

describe('MCP App Control owner', () => {
  test('projects a stable safe snapshot and retains the injected runtime provider', async () => {
    const value = fixture();
    const owner = createMcpOwner({ workspace: value.workspace, supervisor: value.supervisor });
    await owner.start();
    const first = await owner.snapshot(snapshotRequest(value.workspace));
    const second = await owner.snapshot(snapshotRequest(value.workspace));
    const server = first.servers[0]!;

    expect(value.supervisor.starts).toEqual([value.workspace.canonicalPath]);
    expect(second.revision).toBe(first.revision);
    expect(server).toMatchObject({
      key: { name: 'docs', source: 'project' },
      configStatus: 'pending_approval',
      authStatus: 'authorizing',
      authFlowId: 'flow-1',
      configuration: {
        command: '/usr/bin/node',
        argumentCount: 2,
        endpoint: 'https://mcp.example.test',
      },
      approval: {
        status: 'pending',
        configDigest: `sha256:${value.server.approval!.configDigest}`,
        review: {
          command: '/usr/bin/node',
          argumentCount: 2,
          endpoint: 'https://mcp.example.test',
        },
      },
      tools: [
        {
          name: 'search',
          description: 'Search documentation.',
          parameters: [{ name: 'query', type: 'string', required: true }],
          discovered: true,
        },
      ],
      prompts: [{ name: 'summarize', description: 'Summarize a document.' }],
    });
    expect(JSON.stringify(first)).not.toContain('credential-secret');
    expect(JSON.stringify(first)).not.toContain('/private?token=');
    expect(JSON.stringify(first)).not.toContain('credentialPresent');
    expect(server).not.toHaveProperty('contentEgress');
    expect(server).not.toHaveProperty('resources');
    expect(owner.getRuntimeProvider()).toBe(value.supervisor.getRuntimeProvider());
    await owner.stop();
    expect(value.supervisor.stopCalls).toBe(1);
  });

  test('enforces full Workspace identity and server/source CAS before mutation', async () => {
    const value = fixture();
    const owner = createMcpOwner({ workspace: value.workspace, supervisor: value.supervisor });
    await owner.start();
    const otherPath = join(root, 'other');
    mkdirSync(otherPath, { recursive: true });
    const other = identity(otherPath);

    await expect(owner.snapshot(snapshotRequest(other))).rejects.toMatchObject({
      code: 'invalid_app_control_request',
    });
    const stale = await owner.apply(
      actionRequest(value.workspace, {
        type: 'retry',
        key: value.server.key,
        expectedRevision: 'stale-revision',
      }),
    );
    expect(stale.outcome).toBe('conflict');
    expect(value.supervisor.retries).toHaveLength(0);
    const wrongWorkspace = await expect(
      owner.apply(
        actionRequest(other, {
          type: 'retry',
          key: value.server.key,
          expectedRevision: value.server.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_app_control_request' });
    expect(wrongWorkspace).toBeUndefined();
    const staleAdd = await owner.apply(
      actionRequest(value.workspace, {
        type: 'add',
        source: 'user',
        name: 'new-server',
        transport: 'http',
        value: 'https://mcp.example.test/private?token=credential-secret',
        expectedRevision: 'stale-source-revision',
      }),
    );
    expect(staleAdd.outcome).toBe('conflict');
    expect(value.supervisor.mutations).toHaveLength(0);
  });

  test('maps each action to one Supervisor operation and preserves unknown outcomes', async () => {
    const value = fixture();
    const owner = createMcpOwner({ workspace: value.workspace, supervisor: value.supervisor });
    await owner.start();
    const key = value.server.key;
    const expectedRevision = value.server.revision;

    expect(
      (
        await owner.apply(
          actionRequest(value.workspace, { type: 'approve', key, expectedRevision }),
        )
      ).outcome,
    ).toBe('applied');
    expect(
      (await owner.apply(actionRequest(value.workspace, { type: 'reject', key, expectedRevision })))
        .outcome,
    ).toBe('applied');
    expect(
      (await owner.apply(actionRequest(value.workspace, { type: 'login', key, expectedRevision })))
        .outcome,
    ).toBe('applied');
    expect(
      (
        await owner.apply(
          actionRequest(value.workspace, { type: 'cancel_auth', key, expectedRevision }),
        )
      ).outcome,
    ).toBe('applied');
    expect(
      (await owner.apply(actionRequest(value.workspace, { type: 'retry', key, expectedRevision })))
        .outcome,
    ).toBe('applied');
    expect(
      (
        await owner.apply(
          actionRequest(value.workspace, { type: 'reconnect', key, expectedRevision }),
        )
      ).outcome,
    ).toBe('applied');
    expect(
      (
        await owner.apply(
          actionRequest(value.workspace, {
            type: 'set_enabled',
            key,
            enabled: false,
            expectedRevision,
          }),
        )
      ).outcome,
    ).toBe('applied');
    expect(
      (
        await owner.apply(
          actionRequest(value.workspace, {
            type: 'add',
            source: 'user',
            name: 'new-server',
            transport: 'stdio',
            value: '/usr/bin/node --secret credential-secret',
            expectedRevision: value.supervisor.getSnapshot().sourceRevisions.user,
          }),
        )
      ).outcome,
    ).toBe('applied');
    expect(
      (await owner.apply(actionRequest(value.workspace, { type: 'remove', key, expectedRevision })))
        .outcome,
    ).toBe('applied');

    expect(value.supervisor.reloads).toBe(2);
    expect(value.supervisor.logins).toHaveLength(1);
    expect(value.supervisor.cancelledFlows).toEqual(['flow-1']);
    expect(value.supervisor.retries).toHaveLength(2);
    expect(value.supervisor.mutations).toHaveLength(2);
    expect(value.supervisor.removed).toHaveLength(1);
    expect(value.supervisor.mutations[0]).toMatchObject({
      type: 'set_enabled',
      enabled: false,
      expectedRevision,
    });
    expect(value.supervisor.mutations[1]).toMatchObject({
      type: 'add',
      scope: 'user',
      name: 'new-server',
      config: { type: 'stdio', command: '/usr/bin/node --secret credential-secret' },
    });

    value.supervisor.retryError = { code: 'outcome_unknown' };
    const unknown = await owner.apply(
      actionRequest(value.workspace, { type: 'retry', key, expectedRevision }),
    );
    expect(unknown.outcome).toBe('outcome_unknown');
    expect(value.supervisor.retries).toHaveLength(3);
  });
});
