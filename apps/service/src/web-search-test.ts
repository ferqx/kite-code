import { createHash } from 'node:crypto';
import { AgentError, type AgentRuntime, webSearchDisplayUrl } from '@kite-ai/agent';
import type { Extension, Json, ToolResult } from '@kite-ai/agent/extensions';
import type { ModelSettingsReadSet, WebSearchSettingsView } from './configuration-management';
import { WebSearchProviderError } from './web-search-providers';

export const webSearchTestExtensionId = 'builtin.web-search-test';
export const webSearchTestActionId = 'web_search.test';
const query = 'Kite web search connectivity test';
const qualificationType = 'web-search-test-qualification';
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const readSetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userEtag', 'workspaceEtag', 'explicitDigest', 'effectiveDigest'],
  properties: {
    userEtag: digest,
    workspaceEtag: { type: 'null' },
    explicitDigest: digest,
    effectiveDigest: digest,
  },
};
const object = (v: unknown): Record<string, Json> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};
type Scope = { expectedStoreId: string; sessionId: string; subjectId: string };
type RouteScope = Scope & {
  rootSessionId: string;
  workspaceId: string;
  expectedReadSet: ModelSettingsReadSet;
};
export interface WebSearchTestRoute {
  route: 'native' | 'provider';
  provider: string;
  bindingDigest: string;
  search(
    query: string,
    signal: AbortSignal,
    executionId: string,
  ): Promise<{
    observed: boolean;
    sources: readonly { url: string; title?: string }[];
  }>;
}

function qualificationKey(
  scope: RouteScope | (Scope & { rootSessionId: string; workspaceId: string }),
  bindingDigest: string,
) {
  return (
    'native/' +
    createHash('sha256')
      .update(
        JSON.stringify([
          scope.expectedStoreId,
          scope.rootSessionId,
          scope.sessionId,
          scope.workspaceId,
          scope.subjectId,
          bindingDigest,
        ]),
      )
      .digest('hex')
  );
}

export function createWebSearchTest(options: {
  runtime: () => AgentRuntime;
  readSettings: (expectedStoreId: string) => Promise<WebSearchSettingsView>;
  resolveRoute: (input: RouteScope) => Promise<WebSearchTestRoute>;
}) {
  async function scope(input: Scope) {
    const runtime = options.runtime();
    if ((await runtime.getMetadata()).storeId !== input.expectedStoreId)
      throw new AgentError('store_identity_mismatch');
    // The session control read verifies the original root creator against the authenticated subject.
    await runtime.readHostControl({
      expectedStoreId: input.expectedStoreId,
      subjectId: input.subjectId,
      kind: 'permission.mode',
      scope: `session:${input.sessionId}`,
    });
    const session = await runtime.getSession(input.sessionId);
    if (!session || session.deletedAt !== null) throw new AgentError('session_missing');
    return {
      expectedStoreId: input.expectedStoreId,
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      rootSessionId: session.rootSessionId,
      workspaceId: session.workspaceId,
    };
  }
  async function verifyReadSet(expectedStoreId: string, expected: ModelSettingsReadSet) {
    const view = await options.readSettings(expectedStoreId);
    const actual = view.readSet;
    if (
      !actual ||
      !expected ||
      expected.workspaceEtag !== null ||
      actual.workspaceEtag !== null ||
      actual.userEtag !== expected.userEtag ||
      actual.explicitDigest !== expected.explicitDigest ||
      actual.effectiveDigest !== expected.effectiveDigest
    )
      throw new AgentError('configuration_read_set_conflict');
    if (view.errors.length || view.webSearch.mode === 'disabled')
      throw new AgentError('web_search_unavailable');
  }
  async function origin(sessionId: string, executionId: string) {
    const runtime = options.runtime();
    const execution = await runtime.getExecution(executionId);
    const command = execution?.originCommandId
      ? await runtime.getCommand(execution.originCommandId)
      : null;
    if (
      !command ||
      !execution ||
      execution.sessionId !== sessionId ||
      command.sessionId !== sessionId ||
      execution.originStoreId !== command.originStoreId ||
      execution.kind !== 'job' ||
      execution.definitionId !== `${webSearchTestExtensionId}/${webSearchTestActionId}` ||
      command.kind !== 'extension.invoke' ||
      object(command.request).extensionId !== webSearchTestExtensionId ||
      object(command.request).actionId !== webSearchTestActionId ||
      object(command.receipt).executionId !== execution.id
    )
      throw new AgentError('web_search_test_scope_invalid');
    return {
      execution,
      command,
      scope: await scope({
        sessionId,
        expectedStoreId: command.originStoreId,
        subjectId: command.subjectId,
      }),
    };
  }
  const extension: Extension = {
    id: webSearchTestExtensionId,
    version: '1',
    apiMajor: 1,
    records: [
      {
        contentType: qualificationType,
        contentVersion: 1,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['executionId'],
          properties: { executionId: { type: 'string', minLength: 1, maxLength: 256 } },
        },
      },
    ],
    actions: [
      {
        id: webSearchTestActionId,
        version: '1',
        description:
          'Run one connectivity search with the selected account and check whether search was observed.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedReadSet', 'bindingDigest'],
          properties: { expectedReadSet: readSetSchema, bindingDigest: digest },
        },
        async prepare(input) {
          await verifyReadSet(
            (await options.runtime().getMetadata()).storeId,
            object(input).expectedReadSet as unknown as ModelSettingsReadSet,
          );
          return structuredClone(input);
        },
        async execute(input, context): Promise<ToolResult> {
          let sent = false;
          let routeSummary: { route: 'provider' | 'native'; provider: string } | undefined;
          try {
            const original = await origin(context.sessionId, context.executionId);
            const expected = object(input).expectedReadSet as unknown as ModelSettingsReadSet;
            await verifyReadSet(original.scope.expectedStoreId, expected);
            const route = await options.resolveRoute({
              ...original.scope,
              expectedReadSet: expected,
            });
            if (
              route.bindingDigest !== object(input).bindingDigest ||
              !['native', 'provider'].includes(route.route) ||
              !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(route.provider)
            )
              throw new AgentError('web_search_binding_changed');
            await verifyReadSet(original.scope.expectedStoreId, expected);
            context.signal.throwIfAborted();
            routeSummary = { route: route.route, provider: route.provider };
            sent = true;
            const response = await route.search(query, context.signal, context.executionId);
            context.signal.throwIfAborted();
            const sources = response.sources
              .slice(0, 10)
              .filter((source) => webSearchDisplayUrl(source.url))
              .map(({ url, title }) => ({
                url,
                ...(title ? { title: Array.from(title).slice(0, 256).join('') } : {}),
              }));
            const details = { ...routeSummary, observed: response.observed === true, sources };
            if (route.route === 'native' && !details.observed)
              return {
                outcome: 'failed',
                content: 'search_not_performed',
                details: { ...details, code: 'search_not_performed' },
              };
            if (route.route === 'native') {
              const key = qualificationKey(original.scope, route.bindingDigest);
              const prior = await context.records.get(key);
              context.signal.throwIfAborted();
              await context.records.write({
                key,
                expectedRevision: prior?.revision ?? null,
                executable: true,
                contentType: qualificationType,
                contentVersion: 1,
                value: { executionId: context.executionId },
              });
            }
            return { outcome: 'succeeded', content: 'web_search_test_completed', details };
          } catch (error) {
            const code =
              error instanceof WebSearchProviderError
                ? error.code
                : error instanceof AgentError &&
                    [
                      'configuration_read_set_conflict',
                      'web_search_unavailable',
                      'web_search_binding_changed',
                      'web_search_test_scope_invalid',
                    ].includes(error.code)
                  ? error.code
                  : context.signal.aborted
                    ? 'search_cancelled'
                    : 'web_search_test_failed';
            const unknown =
              sent &&
              (context.signal.aborted ||
                !(error instanceof WebSearchProviderError) ||
                error.retrySafety !== 'safe');
            return {
              outcome: unknown
                ? 'outcome_unknown'
                : context.signal.aborted
                  ? 'cancelled'
                  : 'failed',
              content: code,
              details: { ...routeSummary, observed: false, sources: [], code },
            };
          }
        },
      },
    ],
    queries: [
      {
        id: 'web_search.test.qualification',
        version: '1',
        description: 'Check original successful search evidence for a scoped binding.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: { key: { type: 'string', pattern: '^native/[a-f0-9]{64}$' } },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          const key = String(object(input).key);
          const record = await context.records.get(key);
          let qualified = false;
          const id = object(record?.value).executionId;
          if (record && !record.forkProvenance && typeof id === 'string') {
            const original = await origin(context.sessionId, id);
            const details = object(object(original.execution.result).details);
            const bound = object(object(original.command.request).input).bindingDigest;
            qualified =
              original.execution.status === 'succeeded' &&
              details.route === 'native' &&
              details.observed === true &&
              typeof bound === 'string' &&
              record.originStoreId === original.scope.expectedStoreId &&
              qualificationKey(original.scope, bound) === key;
          }
          return [
            {
              extensionId: webSearchTestExtensionId,
              contentType: qualificationType,
              contentVersion: 1,
              summary: 'Native search test',
              payload: { qualified },
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  };
  return {
    extension,
    async isNativeQualified(input: Scope & { bindingDigest: string }) {
      let current: Awaited<ReturnType<typeof scope>>;
      try {
        current = await scope(input);
      } catch (error) {
        if (error instanceof AgentError && error.code === 'host_control_scope_denied') return false;
        throw error;
      }
      const rows = await options.runtime().queryExtension({
        sessionId: input.sessionId,
        subjectId: input.subjectId,
        expectedStoreId: input.expectedStoreId,
        extensionId: webSearchTestExtensionId,
        queryId: 'web_search.test.qualification',
        input: { key: qualificationKey(current, input.bindingDigest) },
      });
      return object(rows[0]?.payload).qualified === true;
    },
    async run(
      input: Scope & {
        commandId: string;
        expectedReadSet: ModelSettingsReadSet;
        signal: AbortSignal;
      },
    ) {
      input.signal.throwIfAborted();
      const runtime = options.runtime();
      const existing = await runtime.getCommand(input.commandId);
      let bindingDigest: Json;
      if (existing) {
        // The runtime verifies original Store, subject, session and request digest before returning a prior Command.
        bindingDigest = object(object(existing.request).input).bindingDigest ?? null;
      } else {
        const current = await scope(input);
        await verifyReadSet(input.expectedStoreId, input.expectedReadSet);
        bindingDigest = (
          await options.resolveRoute({ ...current, expectedReadSet: input.expectedReadSet })
        ).bindingDigest;
        if (!/^[0-9a-f]{64}$/.test(bindingDigest))
          throw new AgentError('web_search_binding_changed');
      }
      input.signal.throwIfAborted();
      return runtime.submitCommand({
        expectedStoreId: input.expectedStoreId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        subjectId: input.subjectId,
        request: {
          kind: 'extension.invoke',
          extensionId: webSearchTestExtensionId,
          actionId: webSearchTestActionId,
          definitionVersion: '1',
          input: { expectedReadSet: input.expectedReadSet as unknown as Json, bindingDigest },
        },
      });
    },
  };
}
