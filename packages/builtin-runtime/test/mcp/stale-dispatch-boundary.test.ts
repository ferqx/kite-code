import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpConnectionManager } from '../../src/mcp/manager';

for (const change of ['schema', 'removed', 'unchanged'] as const) {
  test(`MCP dispatch rechecks same-generation ${change} after durable write admission`, async () => {
    let toolsChanged = false;
    let providerCalls = 0;
    const outcomes: string[] = [];
    let notifyToolsChanged: (() => Promise<void>) | undefined;
    let releaseGuard!: () => void;
    let observeGuard!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      observeGuard = resolve;
    });
    const client = {
      connect: async () => {},
      close: async () => {},
      listTools: async () => ({
        tools:
          toolsChanged && change === 'removed'
            ? []
            : [
                {
                  name: 'write_fixture',
                  annotations: { readOnlyHint: false },
                  inputSchema:
                    toolsChanged && change === 'schema'
                      ? {
                          type: 'object',
                          properties: { newValue: { type: 'string' } },
                          required: ['newValue'],
                        }
                      : {
                          type: 'object',
                          properties: { value: { type: 'string' } },
                          required: ['value'],
                        },
                },
              ],
      }),
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      setNotificationHandler: (
        schema: { safeParse: (value: unknown) => { success: boolean } },
        handler: () => Promise<void>,
      ) => {
        if (schema.safeParse({ method: 'notifications/tools/list_changed' }).success)
          notifyToolsChanged = handler;
      },
      callTool: async () => {
        providerCalls += 1;
        return { content: [] };
      },
    } as unknown as Client;
    const manager = new McpConnectionManager({
      createClient: () => client,
      createTransport: () => ({}) as never,
      protectedPathEvaluator: {
        workspaceRoot: process.cwd(),
        evaluate: ({ path }) => ({
          outcome: 'allow',
          reason: 'fixture',
          canonicalPath: resolve(path),
        }),
      },
      mcpWriteGovernanceRequired: true,
      mcpWriteDispatchGuard: {
        beforeDispatch: async () => {
          observeGuard();
          await blocked;
          return {
            admitted: true,
            invocationId: 'fixture',
            routeDigest: 'route',
            intentDigest: 'intent',
          };
        },
        recordOutcome: async ({ outcome }) => {
          outcomes.push(outcome);
        },
      },
    });
    try {
      await manager.connect('fixture', {
        type: 'stdio',
        command: 'fixture',
        tools: {
          write_fixture: {
            effects: { filesystem: 'none', network: 'write', externalState: 'write' },
            minimumApproval: 'user',
          },
        },
      });
      const descriptor = manager.findCapability('mcp:fixture/write_fixture')!;
      const attempt = manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: { value: 'old schema' },
        writeGovernance: { userApprovalReceiptDigest: 'sha256:fixture' },
      });
      // Attach rejection observation before releasing the dispatch gate.
      const completed = attempt.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await observed;
      toolsChanged = true;
      expect(notifyToolsChanged).toBeDefined();
      await notifyToolsChanged!();
      const current = manager.findCapability(descriptor.capabilityId);
      if (change === 'schema') expect(current?.revision).not.toBe(descriptor.revision);
      if (change === 'removed') expect(current).toBeUndefined();
      releaseGuard();
      const result = await completed;
      if (change === 'unchanged') {
        expect(result.ok).toBe(true);
        expect(providerCalls).toBe(1);
        expect(outcomes).toEqual(['succeeded']);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error).toMatchObject({
            kind: 'provider_capability_changed',
            retryable: false,
          });
        expect(providerCalls).toBe(0);
        expect(outcomes).toEqual([]);
      }
    } finally {
      releaseGuard();
      await manager.disconnectAll();
    }
  });
}
