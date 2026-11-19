import { randomUUID } from 'node:crypto';
import {
  type AgentClient,
  ClientError,
  type Command,
  type HostMutation,
  type WebSearchEvidence,
  type WebSearchSettingsRequest,
  type WebSearchSettingsView,
} from '@kite-ai/client';
import type {
  WebSearchBlock,
  WebSearchCitation,
  WebSearchDisplay,
  WebSearchSource,
} from '@kite-ai/ui/desktop';
import type { NativeSearchRequest, NativeSearchResult } from '../src/native-web-search-bridge';
import type {
  SearchAdapter,
  SearchDraft,
  SearchProbe,
  SearchService,
  SearchView,
} from '../src/web-search-settings-model';
import type { VisitedSiteIcons } from './visited-site-icons';

const bases: Record<SearchAdapter, string> = {
  'deepseek-search': 'https://api.deepseek.com',
  'perplexity-search': 'https://api.perplexity.ai',
  'openai-search': 'https://api.openai.com/v1',
};
type Settings = WebSearchSettingsView;
type WireProvider = WebSearchSettingsRequest['searchProviders'][number];
type Connection = WireProvider['connection'];
type Scope = {
  generation: number;
  selection: number;
  storeId: string;
  sessionId?: string;
  readOnly?: boolean;
};
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const clean = (v: unknown, n = 256) =>
  typeof v === 'string'
    ? v
        .slice(0, n)
        .replace(/[\uD800-\uDBFF]$/u, '')
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .trim()
    : '';
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const sources = (v: unknown, includeSnippet = false): WebSearchSource[] =>
  Array.isArray(v)
    ? v.slice(0, 64).flatMap((x) => {
        const item = rec(x);
        return item && typeof item.url === 'string' && item.url.length <= 2048
          ? [
              {
                url: item.url,
                title: clean(item.title),
                ...(includeSnippet && typeof item.snippet === 'string'
                  ? { snippet: clean(item.snippet, 320) }
                  : {}),
              },
            ]
          : [];
      })
    : [];
/** Reject unknown versions / scopes. Evidence material is external: allowlist fields; never pass bodies or markup. */
export function projectSearchEvidence(
  packet: unknown,
  scope: { storeId: string; sessionId: string; executionId: string },
  icons?: VisitedSiteIcons,
): WebSearchDisplay | undefined {
  const p = rec(packet);
  if (
    p?.schema !== 'kite.web-search' ||
    p.schemaVersion !== 1 ||
    p.storeId !== scope.storeId ||
    p.sessionId !== scope.sessionId ||
    p.executionId !== scope.executionId ||
    !integer(p.revision) ||
    !Array.isArray(p.blocks) ||
    !p.blocks.length
  )
    return;
  const entries = p.blocks.slice(-64).map(rec),
    calls = entries.filter((b) => b && b.sourceScope !== 'response');
  const selected = calls.at(-1) ?? entries.at(-1);
  if (!selected) return;
  const displayStatus: Record<
    WebSearchEvidence['blocks'][number]['status'],
    WebSearchDisplay['status']
  > = {
    searching: 'running',
    completed: 'completed',
    incomplete: 'incomplete',
    failed: 'failed',
    outcome_unknown: 'unknown',
  };
  const states = (calls.length ? calls : entries).map((b) => b?.status);
  if (states.some((value) => typeof value !== 'string' || !Object.hasOwn(displayStatus, value)))
    return;
  const status = states.includes('searching')
    ? 'running'
    : states.includes('outcome_unknown')
      ? 'unknown'
      : states.includes('failed')
        ? 'failed'
        : states.includes('incomplete')
          ? 'incomplete'
          : 'completed';
  const found: WebSearchSource[] = [],
    cites: WebSearchCitation[] = [],
    blocks: WebSearchBlock[] = [];
  let truncated = p.blocks.length > 64;
  for (const b of entries) {
    if (!b) continue;
    if (Array.isArray(b.sources)) {
      truncated ||= b.sources.length > 64 - found.length;
      found.push(...sources(b.sources, true).slice(0, 64 - found.length));
    }
    truncated ||= b.truncated === true;
    if (!Array.isArray(b.citations)) continue;
    truncated ||= b.citations.length > 64 - cites.length;
    for (const v of b.citations.slice(0, 64 - cites.length)) {
      const c = rec(v),
        link = sources([c])[0],
        a = rec(c?.anchor);
      if (!link) continue;
      const citation: WebSearchCitation = { ...link };
      if (
        b.route === 'native' &&
        a?.executionId === scope.executionId &&
        integer(a.blockIndex) &&
        integer(a.blockStartUtf16) &&
        integer(a.blockLengthUtf16) &&
        /^[a-f0-9]{64}$/.test(String(a.textSha256)) &&
        integer(a.startUtf16) &&
        integer(a.endUtf16)
      ) {
        const block = {
          index: a.blockIndex,
          offset: a.blockStartUtf16,
          length: a.blockLengthUtf16,
          sha256: String(a.textSha256),
        };
        const prior = blocks.find((v) => v.index === block.index);
        if (!prior || JSON.stringify(prior) === JSON.stringify(block)) {
          if (!prior) blocks.push(block);
          Object.assign(citation, {
            blockIndex: a.blockIndex,
            start: a.startUtf16,
            end: a.endUtf16,
          });
        }
      }
      cites.push(citation);
    }
  }
  return {
    executionId: scope.executionId,
    revision: p.revision,
    status: truncated && p.blocks.length > 64 && status === 'completed' ? 'unknown' : status,
    route:
      selected.route === 'native' || selected.route === 'provider' ? selected.route : undefined,
    provider: clean(selected.provider),
    query: clean(selected.query),
    sources:
      !icons || selected.route !== 'provider'
        ? found
        : found.map((s) => {
            const siteIconPixels = icons.get(scope, s.url);
            return siteIconPixels ? { ...s, siteIconPixels } : s;
          }),
    citations: cites,
    blocks: blocks.sort((a, b) => a.index - b.index),
    truncated,
  };
}
const unchanged = (a: Scope, b: Scope | undefined) =>
  !!b &&
  a.generation === b.generation &&
  a.selection === b.selection &&
  a.storeId === b.storeId &&
  a.sessionId === b.sessionId &&
  a.readOnly === b.readOnly;
function assertStore(client: AgentClient, scope: Scope, capability: string) {
  if (
    client.serverInfo?.storeId !== scope.storeId ||
    !client.serverInfo.capabilities.includes(capability)
  )
    throw new ClientError('web_search_unavailable');
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export class NativeWebSearch {
  private observation?: { scope: Scope; revision: string; settings: Settings; facts: SearchView };
  private submit = false;
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly icons?: VisitedSiteIcons;
  constructor(client: AgentClient, current: () => Scope | undefined, icons?: VisitedSiteIcons) {
    this.client = client;
    this.current = current;
    this.icons = icons;
  }
  private checked(scope: Scope) {
    if (!unchanged(scope, this.current())) throw new ClientError('native_selection_changed');
  }
  private async read(scope: Scope): Promise<SearchView> {
    assertStore(this.client, scope, 'web_search_settings');
    const settings = await this.client.getWebSearchSettings({ storeId: scope.storeId });
    this.checked(scope);
    if (settings.storeId !== scope.storeId) throw new ClientError('native_selection_changed');
    const revision = randomUUID(),
      saved = settings.webSearch;
    const draft: SearchDraft = {
      ...saved,
      providers: settings.searchProviders.map((p) => ({
        id: p.id,
        name: p.name,
        adapter: p.adapter,
        account:
          p.connection.kind === 'provider'
            ? { kind: 'provider', alias: p.connection.providerAlias }
            : { kind: 'dedicated', hasCredential: !!p.connection.credentialRef },
        ...(p.adapter === 'openai-search'
          ? { modelId: p.modelId }
          : { maxResults: p.maxResults ?? 5 }),
      })),
    };
    // The Service proves each alias and its credential owner. Connection IDs are hashes, never provider aliases.
    const accounts = (settings.eligibleConnections ?? []).map((a) => ({
      alias: a.providerAlias,
      name: a.name,
      adapter: a.adapter,
    }));
    const selected = draft.providers.find((p) => p.id === draft.providerId);
    const routeLabel =
      saved.mode === 'disabled'
        ? '已关闭'
        : saved.mode === 'provider'
          ? selected
            ? `${selected.name}（待核实）`
            : '所选服务不可用'
          : '自动（待核实）';
    const facts: SearchView = {
      revision,
      draft,
      accounts,
      canWrite: !!settings.readSet && !settings.errors.length && !scope.readOnly,
      route: {
        available:
          !scope.readOnly &&
          !!scope.sessionId &&
          !!settings.readSet &&
          !settings.errors.length &&
          saved.mode !== 'disabled' &&
          this.client.serverInfo!.capabilities.includes('web_search_test'),
        label: routeLabel,
      },
    };
    this.observation = { scope, revision, settings, facts };
    return facts;
  }
  async invoke(req: NativeSearchRequest): Promise<NativeSearchResult> {
    const scope = this.current();
    if (!scope || req.generation !== scope.generation || req.expectedStoreId !== scope.storeId)
      throw new ClientError('native_selection_changed');
    if (req.method === 'webSearch.evidence') {
      assertStore(this.client, scope, 'web_search_evidence');
      if (req.viewSelection !== scope.selection || req.sessionId !== scope.sessionId)
        throw new ClientError('native_selection_changed');
      const value = await this.client.getWebSearchEvidence(req.executionId, {
        sessionId: req.sessionId,
        storeId: scope.storeId,
      });
      this.checked(scope);
      return {
        kind: 'webSearch.evidence',
        evidence:
          projectSearchEvidence(
            value,
            {
              storeId: scope.storeId,
              sessionId: req.sessionId,
              executionId: req.executionId,
            },
            this.icons,
          ) ?? null,
      };
    }
    if (req.method === 'webSearch.settings.read')
      return { kind: 'webSearch.settings', view: await this.read(scope) };
    const o = this.observation;
    if (
      !o ||
      req.revision !== o.revision ||
      !unchanged(scope, o.scope) ||
      !o.settings.readSet ||
      scope.readOnly
    )
      throw new ClientError('configuration_changed');
    if (this.submit) throw new ClientError('configuration_mutation_pending');
    this.submit = true;
    const commandId = randomUUID(),
      id = { expectedStoreId: scope.storeId, expectedReadSet: o.settings.readSet, commandId };
    try {
      if (req.method === 'webSearch.settings.save') {
        assertStore(this.client, scope, 'web_search_settings');
        if (!o.facts.canWrite) throw new ClientError('configuration_unavailable');
        const material = (p: SearchService): WireProvider => {
          const prior = o.settings.searchProviders.find(
            (x) => x.id === p.id && x.adapter === p.adapter,
          );
          if (
            p.account.kind === 'provider' &&
            !o.facts.accounts.some(
              (a) => a.alias === (p.account as { alias: string }).alias && a.adapter === p.adapter,
            )
          )
            throw new ClientError('search_credential_unavailable');
          const connection: Connection =
            p.account.kind === 'provider'
              ? { kind: 'provider', providerAlias: p.account.alias }
              : prior?.connection.kind === 'dedicated'
                ? prior.connection
                : { kind: 'dedicated', baseURL: bases[p.adapter] };
          if (
            connection.kind === 'dedicated' &&
            !('credentialRef' in connection) &&
            req.credential?.providerId !== p.id
          )
            throw new ClientError('search_credential_unavailable');
          const base = { id: p.id, name: p.name, connection };
          if (p.adapter === 'openai-search') {
            if (!p.modelId) throw new ClientError('invalid_request');
            return { ...base, adapter: p.adapter, modelId: p.modelId };
          }
          return { ...base, adapter: p.adapter, maxResults: p.maxResults ?? 5 };
        };
        let r: HostMutation;
        const searchProviders = req.draft.providers.map(material);
        if (req.draft.mode === 'provider' && !req.draft.providerId)
          throw new ClientError('invalid_request');
        const input: WebSearchSettingsRequest = {
          ...id,
          webSearch:
            req.draft.mode === 'disabled'
              ? { mode: 'disabled' }
              : req.draft.mode === 'provider'
                ? { mode: 'provider', providerId: req.draft.providerId! }
                : {
                    mode: 'auto',
                    ...(req.draft.providerId ? { providerId: req.draft.providerId } : {}),
                  },
          searchProviders,
          ...(req.credential ? { credential: req.credential } : {}),
        };
        try {
          r = await this.client.saveWebSearchSettings(input);
        } catch (error) {
          if (!(error instanceof ClientError) || error.code !== 'network_outcome_unknown')
            throw error;
          this.checked(scope);
          r = await this.client.getHostMutation(commandId, { storeId: scope.storeId });
        }
        this.checked(scope);
        if (
          r.commandId !== commandId ||
          r.kind !== 'config.patch' ||
          r.originStoreId !== scope.storeId ||
          r.state !== 'applied'
        )
          throw new ClientError('configuration_outcome_unknown');
        return { kind: 'webSearch.settings', view: await this.read(scope) };
      }
      assertStore(this.client, scope, 'web_search_test');
      if (req.sessionId !== scope.sessionId || !o.facts.route.available)
        throw new ClientError('web_search_unavailable');
      let command: Command;
      try {
        command = await this.client.testWebSearch({ ...id, sessionId: req.sessionId });
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== 'network_outcome_unknown')
          throw error;
        // Lost submission: read only the original command. No second POST, retry or provider switch.
        this.checked(scope);
        command = await this.client.getCommand(commandId);
      }
      const deadline = Date.now() + 65_000;
      for (;;) {
        this.checked(scope);
        if (
          command.id !== commandId ||
          command.kind !== 'extension.invoke' ||
          command.originStoreId !== scope.storeId ||
          command.sessionId !== req.sessionId
        )
          throw new ClientError('native_selection_changed');
        if (command.status !== 'accepted') break;
        if (Date.now() >= deadline) throw new ClientError('search_timeout');
        await wait(600);
        this.checked(scope);
        command = await this.client.getCommand(commandId);
      }
      const receipt = rec(command.receipt);
      if (command.status !== 'applied' || typeof receipt?.executionId !== 'string')
        throw new ClientError(clean(receipt?.code, 80) || 'search_failed');
      const executionId = receipt.executionId;
      let execution = await this.client.getExecution(executionId);
      for (;;) {
        this.checked(scope);
        if (
          execution.id !== executionId ||
          execution.sessionId !== req.sessionId ||
          execution.originStoreId !== scope.storeId
        )
          throw new ClientError('native_selection_changed');
        if (!['planned', 'dispatching', 'running'].includes(execution.status)) break;
        if (Date.now() >= deadline) throw new ClientError('search_timeout');
        await wait(600);
        this.checked(scope);
        execution = await this.client.getExecution(executionId);
      }
      const result = rec(rec(execution.result)?.details),
        label = [clean(result?.route), clean(result?.provider)].filter(Boolean).join(' · ');
      const probe: SearchProbe = {
        route: label || '待核实',
        observed: execution.status === 'succeeded' && result?.observed === true,
        sources: sources(result?.sources),
        ...(execution.status !== 'succeeded' || result?.code
          ? { errorCode: clean(result?.code, 80) || 'search_failed' }
          : {}),
      };
      return { kind: 'webSearch.test', probe };
    } finally {
      this.submit = false;
    }
  }
}
