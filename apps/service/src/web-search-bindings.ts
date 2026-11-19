import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import {
  ConfigurationError,
  type JsonObject,
  type ModelConfiguration,
} from '@kite-ai/agent/config';
import {
  createWebSearchExtension,
  type SearchPort,
  type WebSearchUsage,
} from '@kite-ai/agent/tools/web-search';
import { openAIWebSearchModelCapability, runOpenAIWebSearch } from '@kite-ai/ai/sdk';
import { parseModelPreset } from './model-options';
import { modelRequestCompression } from './model-request-compression';
import { resolveModelTransport } from './model-transport';
import { freezeWebSearchProvider, parseWebSearchConfiguration } from './web-search-configuration';
import { createWebSearchProviderPort, type WebSearchProviderOptions } from './web-search-providers';
import {
  inheritedSearchRoute,
  nativeSearchIdentity,
  type SearchRoute,
  selectSearchRoute,
} from './web-search-route';

type Vaults = Omit<Parameters<typeof freezeWebSearchProvider>[1], 'user'>;
type Scope = { expectedStoreId: string; subjectId: string; sessionId: string; workspaceId: string };
type Frozen = ReturnType<typeof freezeWebSearchProvider>;

/** Only the user layer can assign a paid connection. The unchanged resolver owns its credential. */
export function createSearchBindings(
  options: Vaults & {
    runtime(): AgentRuntime;
    fetch?: typeof fetch;
    allowNative(scope: Scope): Promise<boolean>;
    qualified(scope: Scope & { bindingDigest: string }): Promise<boolean>;
  },
) {
  function candidates(user: JsonObject, model: ModelConfiguration | undefined, scope: Scope) {
    const { webSearch: settings, searchProviders } = parseWebSearchConfiguration(user);
    if (settings.mode === 'disabled') return { settings };
    const provider = searchProviders.find((entry) => settings.providerId === entry.id);
    const freeze = (item: Parameters<typeof freezeWebSearchProvider>[0]) => {
      try {
        return freezeWebSearchProvider(item, { ...options, user });
      } catch (error) {
        if (error instanceof ConfigurationError) return undefined;
        throw error;
      }
    };
    const configured = provider && freeze(provider);
    const external =
      configured && provider
        ? {
            kind: 'provider' as const,
            providerId: provider.id,
            adapter: provider.adapter,
            bindingDigest: configured.bindingDigest,
          }
        : undefined;
    const candidate =
      settings.mode === 'auto' &&
      model &&
      openAIWebSearchModelCapability(
        model.model,
        parseModelPreset(model.options).reasoningEffort,
      ) === 'supported'
        ? nativeSearchIdentity(model, options.profileAccessKey, scope.subjectId)
        : undefined;
    // An official URL alone cannot authorize an arbitrary user-model credential reference.
    const owner =
      candidate &&
      model &&
      typeof model.providerName === 'string' &&
      Array.isArray(user.models) &&
      user.models.some(
        (row) =>
          row &&
          typeof row === 'object' &&
          !Array.isArray(row) &&
          row.id === model.id &&
          row.providerName === model.providerName &&
          row.credentialRef === model.credentialRef &&
          row.baseURL === model.baseURL &&
          row.provider === model.provider &&
          row.model === model.model,
      )
        ? freeze({
            id: 'native-test',
            name: 'OpenAI',
            adapter: 'openai-search',
            modelId: model.model,
            connection: { kind: 'provider', providerAlias: model.providerName },
          })
        : undefined;
    return { settings, external, configured, native: owner ? candidate : undefined, owner };
  }
  function port(
    frozen: Frozen,
    openaiSearch: WebSearchProviderOptions['openaiSearch'] = (request) =>
      runOpenAIWebSearch({ ...request, fetch: options.fetch }),
  ): SearchPort {
    return {
      async search(input, context) {
        let usage: WebSearchUsage | undefined;
        const onUsage: NonNullable<WebSearchProviderOptions['onUsage']> = (report) => {
          const tokens = report.searchModelTokens;
          usage = {
            providerRequests: report.requests,
            ...(tokens?.inputTokens != null ? { searchModelInputTokens: tokens.inputTokens } : {}),
            ...(tokens?.outputTokens != null
              ? { searchModelOutputTokens: tokens.outputTokens }
              : {}),
          };
        };
        const client = createWebSearchProviderPort({
          ...frozen,
          fetch: options.fetch,
          onUsage,
          openaiSearch,
        });
        try {
          const answer = await client.search(input, context);
          return { ...answer, ...(usage ? { usage } : {}) };
        } catch (error) {
          if (usage && error instanceof Error) Object.assign(error, { usage });
          throw error;
        }
      },
    };
  }
  return {
    async bind(input: {
      user: JsonObject;
      model: ModelConfiguration;
      scope: Scope;
      enabled: boolean;
      parent?: SearchRoute | null;
      restore?: { route: SearchRoute | null };
      nativeAllowed: boolean;
    }) {
      const c = candidates(input.user, input.model, input.scope);
      // An old manifest had no search permission. A frozen off route persists across restarts.
      if (input.restore && (!input.restore.route || input.restore.route.kind === 'none'))
        return {
          route: input.restore.route ?? { kind: 'none' as const, reason: 'disabled' as const },
        };
      const native =
        c.native &&
        input.enabled &&
        input.nativeAllowed &&
        (await options.allowNative(input.scope)) &&
        (await options.qualified({ ...input.scope, bindingDigest: c.native.bindingDigest }))
          ? c.native
          : undefined;
      const route = selectSearchRoute({
        settings: c.settings,
        enabled: input.enabled,
        parent: input.parent,
        native,
        provider: c.external,
      });
      if (route.kind === 'provider' && c.configured) {
        const extension = createWebSearchExtension({
          provider: route.providerId,
          port: port(c.configured),
          publishEvidence: (block, ctx) =>
            options.runtime().publishWebSearchEvidence(
              {
                expectedStoreId: input.scope.expectedStoreId,
                subjectId: input.scope.subjectId,
                sessionId: ctx.sessionId,
                executionId: ctx.executionId,
              },
              block,
            ),
        });
        return { route, extension };
      }
      if (route.kind === 'native') {
        const runtime = options.runtime();
        const accountDigest = route.accountDigest;
        async function authorizeDescendant(next: {
          sessionId: string;
          runId: string;
          executionId: string;
          modelId: string;
          signal: AbortSignal;
        }) {
          next.signal.throwIfAborted();

          const execution = await runtime.getExecution(next.executionId);
          const run = await runtime.getRun(next.runId);
          const session = await runtime.getSession(next.sessionId);
          const command = execution && (await runtime.getCommand(execution.originCommandId));
          const principal = await runtime.getSession(input.scope.sessionId);
          const stored = inheritedSearchRoute(run?.configuration);
          if (
            !command ||
            !principal ||
            session?.rootSessionId !== principal.rootSessionId ||
            stored?.kind !== 'native' ||
            stored.accountDigest !== accountDigest ||
            !run ||
            !session ||
            !execution ||
            execution.kind !== 'model' ||
            execution.runId !== run.id ||
            run.sessionId !== session.id ||
            execution.sessionId !== session.id ||
            session.workspaceId !== input.scope.workspaceId ||
            execution.originStoreId !== input.scope.expectedStoreId ||
            command.subjectId !== input.scope.subjectId
          )
            return false;
          return options.allowNative({ ...input.scope, sessionId: next.sessionId });
        }
        const nativeWebSearch = {
          accountDigest,
          bindingDigest: route.bindingDigest,
          dialect: 'openai-web-search' as const,
          authorizeDescendant,
          authorize: async (next: Parameters<typeof authorizeDescendant>[0]) =>
            next.modelId === input.model.id && authorizeDescendant(next),
        };
        return { route, nativeWebSearch };
      }
      return { route };
    },
    test(user: JsonObject, model: ModelConfiguration | undefined, scope: Scope) {
      const c = candidates(user, model, scope);
      const choice =
        c.native && c.owner
          ? {
              route: 'native' as const,
              provider: 'openai',
              bindingDigest: c.native.bindingDigest,
              frozen: c.owner,
            }
          : c.external && c.configured
            ? {
                route: 'provider' as const,
                provider: c.external.providerId,
                bindingDigest: c.external.bindingDigest,
                frozen: c.configured,
              }
            : undefined;
      if (!choice) throw new AgentError('web_search_route_unavailable');
      return {
        route: choice.route,
        provider: choice.provider,
        bindingDigest: choice.bindingDigest,
        async search(query: string, signal: AbortSignal, executionId: string) {
          const probe =
            choice.route === 'native' && model
              ? async (request: Parameters<typeof runOpenAIWebSearch>[0]) => {
                  const transport = await resolveModelTransport();
                  try {
                    return await runOpenAIWebSearch({
                      ...request,
                      preset: parseModelPreset(model.options),
                      fetch: modelRequestCompression(
                        { provider: 'openai', protocol: 'responses', baseURL: request.baseURL },
                        options.fetch ?? transport.fetch,
                      ),
                    });
                  } finally {
                    await transport.close();
                  }
                }
              : undefined;
          const result = await port(choice.frozen, probe).search(
            { query },
            { signal, executionId },
          );
          return {
            observed: result.kind === 'results' || result.searchPerformed,
            sources: result.kind === 'results' ? result.items : result.sources,
          };
        },
      };
    },
  };
}
