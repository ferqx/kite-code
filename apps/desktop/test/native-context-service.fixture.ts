import { appendFileSync } from 'node:fs';
import { AgentError } from '@kite-ai/agent';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

const control = 'CONTROL_URL',
  ledger = 'LEDGER_PATH';
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const fixed = createFixedModel([
  [
    { type: 'tool_call', id: 'launch-call', name: 'fixture.launch', arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  ],
  [{ type: 'text_delta', text: 'NATIVE FIRST COMPLETED' }, finish],
  [
    { type: 'tool_call', id: 'noop-call', name: 'fixture.noop', arguments: '{}' },
    { ...finish, reason: 'tool_calls' },
  ],
  [{ type: 'text_delta', text: 'NATIVE INCLUDED COMPLETED' }, finish],
]);
let requests = 0;
const model: ModelAdapter = {
  async *stream(request, { signal }) {
    requests++;
    await fetch(`${control}/record`, { method: 'POST', body: JSON.stringify(request), signal });
    if (requests === 3) await fetch(`${control}/third-gate`, { signal });
    yield* fixed.stream(request, { signal });
  },
};
await runServiceProcess({
  configure: async () => ({
    model,
    modelId: 'fixed',
    configurationManagement(runtime) {
      const readonly = async (): Promise<never> => {
        throw new AgentError('fixture_configuration_readonly');
      };
      return {
        async readModels(input) {
          if (!runtime) throw new AgentError('data_unavailable');
          const { storeId } = await runtime.getMetadata();
          if (input.expectedStoreId !== storeId) throw new AgentError('store_mismatch');
          if (input.scope === 'workspace') {
            if (!input.workspaceId || !(await runtime.getWorkspace(input.workspaceId)))
              throw new AgentError('workspace_missing');
          } else if (input.workspaceId !== undefined)
            throw new AgentError('invalid_configuration_scope');
          return {
            storeId,
            scope: input.scope,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            readSet: null,
            defaultModelId: 'fixed',
            models: [
              {
                id: 'fixed',
                enabled: true,
                configured: true,
                provider: 'fixture',
                model: 'fixed',
                diagnostics: [],
              },
            ],
            errors: [],
          };
        },
        read: readonly,
        updateModels: readonly,
        readProviders: readonly,
        updateProviders: readonly,
        patch: readonly,
        repair: readonly,
        putCredential: readonly,
        revokeCredential: readonly,
        getMutation: readonly,
      };
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-fixture-only' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.launch',
            version: '1',
            description: 'Launch a harmless detached ledger Job',
            inputSchema: { type: 'object', additionalProperties: false },
            async execute(_input, context) {
              await context.operations.ensure({
                key: 'original-ledger',
                cancellation: 'detached',
                request: {
                  kind: 'job',
                  definitionId: 'fixture.ledger',
                  definitionVersion: '1',
                  input: {},
                },
              });
              return {
                outcome: 'succeeded',
                content: 'original ledger Job started; terminal pending',
              };
            },
          },
          {
            id: 'fixture.noop',
            version: '1',
            description: 'Next safe Model checkpoint',
            inputSchema: { type: 'object', additionalProperties: false },
            async execute() {
              return { outcome: 'succeeded', content: 'no new effect' };
            },
          },
        ],
        jobs: [
          {
            id: 'fixture.ledger',
            version: '1',
            description: 'Harmless physical ledger',
            inputSchema: { type: 'object', additionalProperties: false },
            resources: { slot: 'process' },
            async start() {
              appendFileSync(ledger, 'effect\n');
              return { reference: { key: 'original-ledger' } };
            },
            async *observe() {
              await fetch(`${control}/job-gate`);
              yield {
                type: 'terminal',
                supervision: 'ended',
                result: { outcome: 'succeeded', content: 'NATIVE_JOB_COMPLETE_BODY' },
              };
            },
            async cancel() {
              return { status: 'stopped' };
            },
            async dispose() {},
          },
        ],
      },
    ],
  }),
});
