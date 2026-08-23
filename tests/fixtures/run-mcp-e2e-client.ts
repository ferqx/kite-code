#!/usr/bin/env bun

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import {
  createBuiltinCredentialBrokerV1,
  McpConnectionManager,
  MemoryMcpCredentialStore,
} from '@kite/builtin-runtime/mcp';
import { aiMessage } from '@kite/builtin-runtime/model';
import { loadMcpConfig } from '#app/config';
import { decideProjectMcpServer } from '#app/config/mcp-project-approvals';
import { openStateStoreForTestV1 } from '../../scripts/support/runtime-storage';
import { runTestRuntimeAgentV1 } from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

const serverName = process.env.MCP_E2E_SERVER_NAME;
const expectedScope = process.env.MCP_E2E_EXPECTED_SCOPE;
const secret = process.env.MCP_E2E_SECRET;

if (!serverName || !expectedScope) throw new Error('Missing MCP E2E client parameters.');

const workspace = process.cwd();
const runtimeDir = join(workspace, '.kite-code');
const storePath = join(runtimeDir, `mcp-e2e-${serverName}.db`);
mkdirSync(runtimeDir, { recursive: true });

let loaded = loadMcpConfig();
if (process.env.MCP_E2E_APPROVE_PROJECT === '1') {
  const approval = loaded.catalog.projectApprovals.find((view) => view.name === serverName);
  if (!approval) throw new Error(`Project MCP server '${serverName}' has no approval view.`);
  const decision = decideProjectMcpServer({
    workspace,
    serverName: approval.name,
    sourceKind: approval.sourceKind,
    sourcePath: approval.sourcePath,
    expectedConfigDigest: approval.configDigest,
    decision: 'approved',
  });
  if (decision.status !== 'recorded') {
    throw new Error(`Project MCP approval failed: ${decision.status}`);
  }
  loaded = loadMcpConfig();
}
const serverConfig = loaded.servers[serverName];
if (!serverConfig) throw new Error(`MCP server '${serverName}' was not loaded from config.`);

const credentialStore = new MemoryMcpCredentialStore();
const credentialBroker = createBuiltinCredentialBrokerV1({ store: credentialStore });
let connectionConfig = serverConfig;
if (serverConfig.type === 'http' && secret) {
  const key = {
    workspaceKey: workspace,
    source: expectedScope === 'project' ? ('project' as const) : ('user' as const),
    server: serverName,
    profile: 'default',
  };
  await credentialStore.put(key, {
    version: 1,
    kind: 'bearer',
    secret,
    updatedAt: '2026-08-22T00:00:00.000Z',
  });
  const credentialHandle = await credentialBroker.issueForKey(key, { purpose: 'mcp.transport' });
  const { headers: _rawHeaders, ...withoutRawHeaders } = serverConfig;
  connectionConfig = {
    ...withoutRawHeaders,
    auth: {
      type: 'credential',
      header: 'Authorization',
      credentialRef: `${serverName}:default`,
      scheme: 'Bearer',
    },
    credentialHandle,
  };
}

const manager = new McpConnectionManager({ credentialBroker });
try {
  await manager.connect(serverName, connectionConfig);
  const descriptor = manager.findCapability(`mcp:${serverName}/authenticated_echo`);
  if (!descriptor) throw new Error('Authenticated MCP capability was not discovered.');

  const model = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'authenticated-mcp-search',
            name: 'tool_search',
            args: { query: 'authenticated echo' },
          },
        ],
      }),
    },
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          {
            id: 'authenticated-mcp-call',
            name: `mcp__${serverName}__authenticated_echo`,
            args: { message: expectedScope },
          },
        ],
      }),
    },
    { message: aiMessage({ content: `Authenticated ${expectedScope} MCP call completed.` }) },
  ]);
  const events: RuntimeEvent[] = [];
  for await (const event of runTestRuntimeAgentV1(
    {
      task: `Call the authenticated ${expectedScope} MCP server.`,
      threadId: `mcp-e2e-${serverName}`,
      userId: 'e2e',
      workspace,
      openStateSessionStorage: () => openStateStoreForTestV1(storePath),
      model,
      mcpManager: manager,
      config: {
        providerName: 'test',
        providerType: 'openai-compatible',
        apiKey: 'test',
        baseURL: 'http://localhost:1',
        modelName: 'test',
        sandbox: { enabled: true },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          toolSearchV1: true,
          mcpExecutionRecordV1: true,
        },
      },
    },
    {
      requestAction: async (effect) =>
        process.env.MCP_E2E_APPROVE_TOOL === '1'
          ? { type: 'approve', interactionId: effect.interactionId, grant: 'approve_once' }
          : { type: 'cancel', interactionId: effect.interactionId },
    },
  )) {
    events.push(event);
  }

  const store = openStateStoreForTestV1(storePath);
  const persisted = store.loadEventsStrict(`mcp-e2e-${serverName}`).map((entry) => entry.event);
  store.close();
  const serialized = JSON.stringify({ events, persisted });
  if (secret && serialized.includes(secret)) {
    throw new Error('MCP credential leaked into Runtime events.');
  }
  const finished = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'tool.finished' }> =>
      event.type === 'tool.finished' &&
      event.result.stdout.includes(`authenticated:${expectedScope}`),
  );
  if (!finished) {
    const toolOutcomes: Array<Record<string, unknown>> = [];
    for (const event of events) {
      if (event.type === 'tool.finished') {
        toolOutcomes.push({
          type: event.type,
          stdout: event.result.stdout,
          stderr: event.result.stderr,
        });
      } else if (event.type === 'tool.rejected') {
        toolOutcomes.push({ type: event.type, reason: event.reason });
      }
    }
    throw new Error(
      `Authenticated MCP tool did not finish with the expected scope: ${JSON.stringify({ eventTypes: events.map((event) => event.type), toolOutcomes })}`,
    );
  }

  console.log(
    JSON.stringify({
      provenance: descriptor.provider.provenance,
      eventTypes: events.map((event) => event.type),
      toolStdout: finished.result.stdout,
      persistedEventTypes: persisted.map((event) => event.type),
    }),
  );
} finally {
  await manager.disconnectAll();
}
