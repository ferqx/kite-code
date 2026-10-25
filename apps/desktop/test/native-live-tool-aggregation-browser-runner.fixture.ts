import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type AgentClient,
  ClientError,
  type Execution,
  type HostMutation,
  type ModelSettingsRequest,
  type ModelSettingsView,
  type Message as NativeMessage,
  type ProviderSettingsRequest,
  type ProviderSettingsView,
} from '@kite-ai/client';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { build } from 'vite';
import { NativeConfiguration } from '../electron/configuration';
import {
  type NativeConfigurationData,
  type NativeConfigurationRecord,
  parseConfigurationRecord,
} from '../electron/configuration-journal';
import { NativeProviderSettings } from '../electron/provider-settings';
import { NativeToolMessages } from '../electron/tool-messages';
import type { NativeRequest } from '../src/native-bridge';
import type { NativeToolMessageRequest, NativeToolMessageScope } from '../src/tool-messages-bridge';

type Sample = {
  phase: string;
  cause: 'raf' | 'task' | 'mutation';
  time: number;
  activities: {
    node: number;
    text: string;
    expanded: string | null;
    box: number[];
    titleWidth: number;
    chevronBox: number[] | null;
    titleNode: number | null;
    titleBox: number[] | null;
    statusNode: number | null;
    statusText: string;
    statusBox: number[] | null;
    chevronNode: number | null;
  }[];
  messages: { node: number; role: string; text: string; box: number[] }[];
  shells: {
    node: number;
    expanded: boolean;
    commandLength: number;
    viewportNode: number | null;
    scrollTop: number | null;
    headerBox: number[] | null;
  }[];
  selection: string;
  outsideTools: number;
  footer: number[] | null;
  scrollTop: number | null;
  scrollHeight: number | null;
  width: number;
  overflow: boolean;
  conversationOverflow: boolean;
  raw: boolean;
  steps: number;
  nestedButtons: number;
  summaryExtras: number;
  mutations: number;
  settings: {
    models: { label: string | null; node: number; checked: boolean; disabled: boolean }[];
    default: string;
    defaultControls: number;
    defaultBadges: number;
    headerRefreshControls: number;
    recoveryControls: number;
    errors: number;
    readOnly: boolean;
    busy: boolean;
    navigation: string[];
    focus: { tag: string | null; label: string | null; body: boolean; inPopup: boolean };
  } | null;
};
declare global {
  interface Window {
    liveAggregationSamples: Sample[];
    liveAggregationPhase: string;
  }
}
const directory = import.meta.dir;
const handoff = process.env.KITE_AGGREGATION_SCENARIO === 'model-handoff';
const longGroup = process.env.KITE_AGGREGATION_SCENARIO === 'long-group';
const toolDetails = process.env.KITE_AGGREGATION_SCENARIO === 'tool-details';
const nativeShell = process.env.KITE_AGGREGATION_SCENARIO === 'native-shell';
const settingsNav = process.env.KITE_AGGREGATION_SCENARIO === 'settings-nav';
const settingsModels = process.env.KITE_AGGREGATION_SCENARIO === 'settings-models';
const nativeShellCase = process.env.KITE_NATIVE_SHELL_CASE;
const baseline = process.env.KITE_AGGREGATION_BASELINE === 'pre-empty-model-fix';
let handoffFailures = 0;
const cache = path.resolve(directory, '../../../.cache');
mkdirSync(cache, { recursive: true });
const artifact = mkdtempSync(path.join(cache, 'native-live-tool-aggregation-'));
const output = path.join(artifact, 'dist');
function settingsBackend() {
  let revision = 1;
  let scope = { generation: 1, selection: 2, storeId: 'store', sessionId: 'a' };
  let held = false,
    unknownNext = false;
  let holdModelReads = false,
    holdProviderReads = false,
    failedNext = false,
    failedReadNext = false,
    failedProviderReadNext = false,
    holdLookups = false,
    foreignReadNext = false,
    foreignRevision = 0;
  let concurrentWrites = 0,
    maxConcurrentWrites = 0;
  const releases: (() => void)[] = [];
  const modelReadReleases: (() => void)[] = [],
    providerReadReleases: (() => void)[] = [];
  const lookupReleases: (() => void)[] = [];
  const journal = new Map<string, NativeConfigurationRecord>();
  const receipts = new Map<string, HostMutation>();
  const audit: { method: string; input?: unknown }[] = [];
  const readSet = () => ({
    userEtag: revision.toString(16).padStart(64, '0'),
    workspaceEtag: null,
    explicitDigest: foreignRevision
      ? foreignRevision.toString(16).padStart(64, 'd')
      : 'b'.repeat(64),
    effectiveDigest: revision.toString(16).padStart(64, 'c'),
  });
  const models: ModelSettingsView['models'] = [
    {
      id: 'model-a',
      provider: 'compatible',
      protocol: 'chat-completions',
      model: 'fixture-model-a',
      connectionId: 'e'.repeat(64),
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'unmapped-model',
      provider: 'external',
      model: 'fixture-model-a',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    ...Array.from({ length: 58 }, (_, index) => ({
      id: `primary-${String(index + 3).padStart(3, '0')}`,
      provider: 'compatible',
      protocol: 'chat-completions' as const,
      model: `bulk-model-${String(index + 3).padStart(3, '0')}`,
      connectionId: 'e'.repeat(64),
      enabled: index % 2 === 0,
      configured: true,
      diagnostics: [],
    })),
    {
      id: 'model-b',
      provider: 'compatible',
      protocol: 'chat-completions',
      model: 'fixture-model-b',
      connectionId: 'e'.repeat(64),
      enabled: false,
      configured: true,
      diagnostics: [],
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `secondary-${String(index + 1).padStart(3, '0')}`,
      provider: 'compatible',
      protocol: 'chat-completions' as const,
      model:
        index === 0 ? 'fixture-model-a' : `secondary-model-${String(index + 1).padStart(3, '0')}`,
      connectionId: 'f'.repeat(64),
      enabled: index % 2 === 0,
      configured: true,
      diagnostics: [],
    })),
  ];
  let defaultModelId = 'model-a';
  const connection = {
    id: 'e'.repeat(64),
    name: 'Fixture Connection',
    baseURL: 'https://fixture.invalid/v1',
    protocol: 'chat-completions' as 'chat-completions' | 'responses',
    hasCredential: false,
    modelIds: models
      .filter((model) => model.connectionId === 'e'.repeat(64))
      .map((model) => model.id),
    modelNames: models
      .filter((model) => model.connectionId === 'e'.repeat(64))
      .map((model) => model.model!),
    canWrite: true,
  };
  const secondaryConnection = {
    ...connection,
    id: 'f'.repeat(64),
    name: 'Second Fixture Connection',
    baseURL: 'https://second-fixture.invalid/v1',
    modelIds: models
      .filter((model) => model.connectionId === 'f'.repeat(64))
      .map((model) => model.id),
    modelNames: models
      .filter((model) => model.connectionId === 'f'.repeat(64))
      .map((model) => model.model!),
  };
  const data: NativeConfigurationData = {
    configurations: () => structuredClone([...journal.values()]),
    saveConfiguration(raw) {
      const row = parseConfigurationRecord(raw);
      if (['applied', 'failed'].includes(row.state.phase)) journal.delete(row.input.commandId);
      else journal.set(row.input.commandId, row);
    },
    modelRoute: () => undefined,
    rememberModelRoute() {},
  };
  async function commit(input: ModelSettingsRequest | ProviderSettingsRequest, provider: boolean) {
    audit.push({
      method: provider ? 'updateProviderSettings' : 'updateModelSettings',
      input: structuredClone(input),
    });
    concurrentWrites++;
    maxConcurrentWrites = Math.max(maxConcurrentWrites, concurrentWrites);
    try {
      if (held) await new Promise<void>((resolve) => releases.push(resolve));
      if (JSON.stringify(input.expectedReadSet) !== JSON.stringify(readSet()))
        throw Object.assign(new ClientError('configuration_read_set_changed'), { status: 409 });
      if (failedNext && !provider) {
        failedNext = false;
        const failure: HostMutation = {
          commandId: input.commandId,
          originStoreId: input.expectedStoreId,
          scope: 'user',
          ifMatch: input.expectedReadSet.userEtag,
          kind: 'model_settings.update',
          modelSettings: {
            expectedReadSet: input.expectedReadSet,
            operation: (input as ModelSettingsRequest).operation,
          },
          state: 'failed',
          receipt: { status: 'failed', code: 'fixture_model_write_rejected' },
        };
        receipts.set(input.commandId, structuredClone(failure));
        return failure;
      }
      if (provider) {
        const operation = (input as ProviderSettingsRequest).operation;
        assert.equal(operation.connectionId, connection.id);
        assert.equal(operation.kind ?? 'upsert', 'upsert');
        connection.name = operation.name ?? connection.name;
        connection.baseURL = operation.baseURL;
        connection.protocol = operation.protocol ?? 'chat-completions';
        connection.modelNames = [...operation.modelNames];
        for (const [index, id] of connection.modelIds.entries()) {
          const model = models.find((entry) => entry.id === id)!;
          model.model = connection.modelNames[index] ?? model.model;
        }
      } else {
        const operation = (input as ModelSettingsRequest).operation;
        const model = models.find((entry) => entry.id === operation.modelId)!;
        if (operation.kind === 'default') defaultModelId = model.id;
        else if (operation.kind === 'enabled') model.enabled = operation.enabled;
      }
      revision++;
      const publishedReadSet = structuredClone(readSet());
      const common = {
        commandId: input.commandId,
        originStoreId: input.expectedStoreId,
        scope: 'user' as const,
        ifMatch: input.expectedReadSet.userEtag,
        state: 'applied' as const,
      };
      const receipt: HostMutation = provider
        ? {
            ...common,
            kind: 'provider_settings.update',
            providerSettings: {
              expectedReadSet: input.expectedReadSet,
              operation: (input as ProviderSettingsRequest).operation,
            },
            receipt: {
              status: 'applied',
              etag: publishedReadSet.userEtag,
              credentialState: 'unchanged',
              configurationState: 'published',
            },
          }
        : {
            ...common,
            kind: 'model_settings.update',
            modelSettings: {
              expectedReadSet: input.expectedReadSet,
              operation: (input as ModelSettingsRequest).operation,
            },
            receipt: {
              status: 'applied',
              etag: publishedReadSet.userEtag,
              postReadSet: publishedReadSet,
            },
          };
      receipts.set(input.commandId, structuredClone(receipt));
      if (unknownNext) {
        unknownNext = false;
        return {
          ...receipt,
          state: 'outcome_unknown' as const,
          receipt: { status: 'outcome_unknown' as const, code: 'fixture_response_unknown' },
        };
      }
      return receipt;
    } finally {
      concurrentWrites--;
      audit.push({
        method: 'write.finished',
        input: { commandId: input.commandId, concurrentWrites },
      });
    }
  }
  async function waitRead(kind: 'model' | 'provider', signal?: AbortSignal) {
    const waiting = kind === 'model' ? modelReadReleases : providerReadReleases;
    if (!(kind === 'model' ? holdModelReads : holdProviderReads)) return;
    await new Promise<void>((resolve, reject) => {
      const remove = () => {
        const index = waiting.indexOf(release);
        if (index >= 0) waiting.splice(index, 1);
        signal?.removeEventListener('abort', abort);
      };
      const release = () => {
        remove();
        resolve();
      };
      const abort = () => {
        remove();
        audit.push({ method: `${kind}.read.aborted` });
        reject(new DOMException('Fixture read aborted', 'AbortError'));
      };
      waiting.push(release);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  const client = {
    serverInfo: { capabilities: ['configuration_management'] },
    async getModelSettings(_scope: string, options?: { signal?: AbortSignal }) {
      audit.push({ method: 'getModelSettings' });
      await waitRead('model', options?.signal);
      if (failedReadNext) {
        failedReadNext = false;
        throw new ClientError('fixture_model_read_failed');
      }
      if (foreignReadNext) {
        foreignReadNext = false;
        foreignRevision++;
        holdModelReads = true;
      }
      audit.push({
        method: 'getModelSettings.return',
        input: { revision, readSet: structuredClone(readSet()) },
      });
      return structuredClone({
        storeId: 'store',
        scope: 'user',
        readSet: readSet(),
        defaultModelId,
        models,
        errors: [],
      } satisfies ModelSettingsView);
    },
    async getProviderSettings(options?: { signal?: AbortSignal }) {
      audit.push({ method: 'getProviderSettings' });
      await waitRead('provider', options?.signal);
      if (failedProviderReadNext) {
        failedProviderReadNext = false;
        holdProviderReads = true;
        throw new ClientError('fixture_provider_read_failed');
      }
      audit.push({
        method: 'getProviderSettings.return',
        input: { revision, readSet: structuredClone(readSet()) },
      });
      return structuredClone({
        storeId: 'store',
        readSet: readSet(),
        errors: [],
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            defaultBaseURL: 'https://api.openai.com/v1',
            requiresCredential: true,
            connections: [],
          },
          {
            id: 'compatible',
            label: 'OpenAI-compatible',
            defaultBaseURL: '',
            requiresCredential: false,
            connections: [
              {
                ...connection,
                defaultModelIds: connection.modelIds.includes(defaultModelId)
                  ? [defaultModelId]
                  : [],
              },
              { ...secondaryConnection, defaultModelIds: [] },
            ],
          },
        ],
      } satisfies ProviderSettingsView);
    },
    updateProviderSettings: (input: ProviderSettingsRequest) => commit(input, true),
    updateModelSettings: (_scope: string, input: ModelSettingsRequest) => commit(input, false),
    async getHostMutation(commandId: string) {
      audit.push({ method: 'getHostMutation', input: { commandId } });
      if (holdLookups) await new Promise<void>((resolve) => lookupReleases.push(resolve));
      const receipt = receipts.get(commandId);
      if (!receipt) throw Error('fixture_unknown_command');
      return structuredClone(receipt);
    },
  } as unknown as AgentClient;
  const providers = new NativeProviderSettings(
    client,
    () => scope,
    () => {},
    data,
  );
  const configuration = new NativeConfiguration(
    client,
    () => scope,
    () => {},
    data,
  );
  const generalConfiguration = new NativeConfiguration(
    client,
    () => scope,
    () => {},
    undefined,
    true,
  );
  const snapshot = () => ({
    providerSettingsSubmissions: providers.submissions,
    modelSettingsSubmissions: configuration.submissions,
    audit,
    revision,
    defaultModelId,
    models,
    connection,
    pending: releases.length,
    pendingModelReads: modelReadReleases.length,
    pendingProviderReads: providerReadReleases.length,
    pendingLookups: lookupReleases.length,
    concurrentWrites,
    maxConcurrentWrites,
    receipts: [...receipts.values()],
  });
  return {
    async request(input: NativeRequest | undefined, action?: string, currentScope?: typeof scope) {
      if (currentScope) scope = currentScope;
      let value: unknown = null;
      if (action === 'hold') held = true;
      else if (action === 'release') {
        held = false;
        for (const release of releases.splice(0)) release();
      } else if (action === 'unknown-next') unknownNext = true;
      else if (action === 'hold-model-reads') holdModelReads = true;
      else if (action === 'release-model-reads') {
        holdModelReads = false;
        for (const release of [...modelReadReleases]) release();
      } else if (action === 'hold-provider-reads') holdProviderReads = true;
      else if (action === 'release-provider-reads') {
        holdProviderReads = false;
        for (const release of [...providerReadReleases]) release();
      } else if (action === 'hold-lookups') holdLookups = true;
      else if (action === 'release-lookups') {
        holdLookups = false;
        for (const release of lookupReleases.splice(0)) release();
      } else if (action === 'failed-provider-read-next') failedProviderReadNext = true;
      else if (action === 'failed-next') failedNext = true;
      else if (action === 'failed-read-next') failedReadNext = true;
      else if (action === 'foreign-read-next') foreignReadNext = true;
      try {
        switch (input?.method) {
          case 'settings.providers.read':
            value = await providers.read();
            break;
          case 'settings.providers.save':
            value = await providers.submit(input.observationId, input.operation, input.secret);
            break;
          case 'settings.providers.lookup':
            value = await providers.lookup(input.commandId);
            break;
          case 'settings.providers.close':
            providers.cancelRead();
            break;
          case 'settings.general.models.read':
            audit.push({ method: input.method });
            value = await generalConfiguration.read();
            break;
          case 'settings.general.models.close':
            audit.push({ method: input.method });
            generalConfiguration.release();
            break;
          case 'settings.models.read':
            audit.push({ method: 'settings.models.read', input: structuredClone(input) });
            value = await configuration.read(input.afterCommandId);
            break;
          case 'settings.models.default':
            value = await configuration.submit(input.observationId, {
              kind: 'default',
              modelId: input.modelId,
            });
            break;
          case 'settings.models.enabled':
            value = await configuration.submit(input.observationId, {
              kind: 'enabled',
              modelId: input.modelId,
              enabled: input.enabled,
            });
            break;
          case 'settings.models.lookup':
            value = await configuration.lookup(input.commandId);
            break;
          case 'settings.models.close':
            audit.push({ method: 'settings.models.close' });
            configuration.release();
            break;
        }
        return { value, state: snapshot() };
      } catch (cause) {
        return {
          error: { code: (cause as { code?: string }).code ?? (cause as Error).message },
          state: snapshot(),
        };
      }
    },
  };
}
const settingsBackends = new Map<string, ReturnType<typeof settingsBackend>>();
await build({
  root: path.dirname(directory),
  configFile: false,
  envFile: false,
  plugins: [
    ...(baseline
      ? [
          {
            name: 'isolated-pre-empty-model-fix',
            enforce: 'pre' as const,
            transform(code: string, id: string) {
              if (!id.endsWith('/apps/desktop/src/native-presentation.ts')) return undefined;
              const projection =
                "      ...(toolDeclaration ? { presentation: 'hidden' as const } : {}),";
              if (!code.includes(projection)) throw Error('fixture_baseline_projection_changed');
              return code.replace(projection, '');
            },
          },
        ]
      : []),
    react(),
    tailwindcss(),
  ],
  base: './',
  logLevel: 'error',
  define: {
    __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'false',
    __KITE_FIXTURE_EMPTY_MODEL_CHOICE__: JSON.stringify(settingsModels),
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    outDir: output,
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: path.join(directory, 'native-live-tool-aggregation-browser.fixture.tsx'),
      formats: ['es'],
      fileName: 'fixture',
      cssFileName: 'fixture',
    },
  },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/native-settings' && request.method === 'POST') {
      const body = (await request.json()) as {
        id: string;
        input?: NativeRequest;
        action?: string;
        scope?: { generation: number; selection: number; storeId: string; sessionId: string };
      };
      let fixture = settingsBackends.get(body.id);
      if (!fixture) {
        fixture = settingsBackend();
        settingsBackends.set(body.id, fixture);
      }
      return Response.json(await fixture.request(body.input, body.action, body.scope));
    }
    if (pathname === '/native-shell-metadata' && request.method === 'POST') {
      const fixture = (await request.json()) as {
        messageIds: string[];
        commandOffsets?: Record<string, number>;
        messages: NativeMessage[];
        executions: Execution[];
        observedExecutions: Execution[];
        scope: NativeToolMessageScope;
        input: Extract<NativeToolMessageRequest, { method: 'toolMessages.list' }>;
      };
      const reader = new NativeToolMessages(
        {
          async verifyConnection() {},
          async getExecution(id: string) {
            const execution = fixture.executions.find((value) => value.id === id);
            if (!execution) throw Error('fixture_native_execution_unavailable');
            return execution;
          },
        } as unknown as AgentClient,
        () => fixture.scope,
        () => new Map(fixture.messages.map((message) => [message.id, message])),
        () => fixture.observedExecutions,
      );
      return Response.json((await reader.list(fixture.input)).entries);
    }
    if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (pathname === '/')
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    const file = path.resolve(output, `.${pathname}`);
    return file.startsWith(output + path.sep)
      ? new Response(Bun.file(file))
      : new Response(null, { status: 404 });
  },
});
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, channel: 'chrome' });
const report = {
  browser: browser.version(),
  scenario:
    settingsNav || settingsModels
      ? settingsModels
        ? 'settings-models'
        : 'settings-nav'
      : handoff
        ? 'model-handoff'
        : longGroup
          ? 'long-group'
          : toolDetails
            ? 'tool-details'
            : nativeShell
              ? 'native-shell'
              : 'mixed-tools',
  baseline: baseline
    ? 'current code with only toolDeclaration hidden projection disabled in isolated build'
    : undefined,
  nativeShellCase: nativeShell ? nativeShellCase : undefined,
  cases: [] as {
    theme: string;
    width: number;
    errors: string[];
    screenshotFrames: number;
    samples: Sample[];
    verification?: Record<string, unknown>;
  }[],
};
try {
  for (const { theme, width } of settingsNav || settingsModels
    ? [
        { theme: 'light' as const, width: 1100 },
        { theme: 'dark' as const, width: 1100 },
        { theme: 'light' as const, width: 550 },
        { theme: 'dark' as const, width: 550 },
      ]
    : handoff || longGroup || toolDetails || nativeShell
      ? [
          { theme: 'light' as const, width: 1280 },
          { theme: 'dark' as const, width: 780 },
        ]
      : [
          { theme: 'light' as const, width: 1280 },
          { theme: 'dark' as const, width: 780 },
          { theme: 'dark' as const, width: 390 },
        ]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      colorScheme: theme,
      locale: 'zh-CN',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const label = `${theme}-${width}`;
    const frames = path.join(artifact, `${label}-frames`);
    mkdirSync(frames);
    const cdp = await page.context().newCDPSession(page);
    let screenshotFrames = 0;
    cdp.on('Page.screencastFrame', (event) => {
      writeFileSync(
        path.join(frames, `${String(screenshotFrames++).padStart(4, '0')}.jpg`),
        Buffer.from(event.data, 'base64'),
      );
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, everyNthFrame: 1 });
    await page.addInitScript(() => {
      const identities = new WeakMap<Element, number>();
      let next = 1,
        mutations = 0;
      const id = (node: Element) => {
        let value = identities.get(node);
        if (!value) {
          value = next++;
          identities.set(node, value);
        }
        return value;
      };
      window.liveAggregationSamples = [];
      window.liveAggregationPhase = 'boot';
      const sample = (cause: Sample['cause']) => {
        const conversation = [...document.querySelectorAll('.conversation')].find(
          (node) => node.getBoundingClientRect().height > 0,
        );
        const viewport = conversation?.querySelector<HTMLElement>('.conversation-viewport');
        const footer = [...document.querySelectorAll('.conversation-footer')]
          .find((node) => node.getBoundingClientRect().height > 0)
          ?.getBoundingClientRect();
        const activities = [...(conversation?.querySelectorAll('.tool-activity') ?? [])].filter(
          (node) => !node.parentElement?.closest('.tool-activity'),
        );
        window.liveAggregationSamples.push({
          phase: window.liveAggregationPhase,
          cause,
          time: performance.now(),
          activities: activities.map((node) => {
            const box = node.getBoundingClientRect();
            const title = node.querySelector('.tool-activity-title')?.getBoundingClientRect();
            const chevron = node.querySelector('.tool-activity-chevron')?.getBoundingClientRect();
            const status = node.querySelector(
              ':scope > .tool-activity-summary .tool-activity-state',
            );
            const boxOf = (element: Element | null) => {
              const rect = element?.getBoundingClientRect();
              return rect ? [rect.x, rect.y, rect.width, rect.height] : null;
            };
            const titleElement = node.querySelector('.tool-activity-title');
            const chevronElement = node.querySelector('.tool-activity-chevron');
            return {
              node: id(node),
              text:
                node.querySelector('.tool-activity-title')?.textContent ?? node.textContent ?? '',
              expanded:
                node.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded') ?? null,
              box: [box.x, box.y, box.width, box.height],
              titleWidth: title?.width ?? 0,
              chevronBox: chevron ? [chevron.x, chevron.y, chevron.width, chevron.height] : null,
              titleNode: titleElement ? id(titleElement) : null,
              titleBox: boxOf(titleElement),
              statusNode: status ? id(status) : null,
              statusText: status?.textContent ?? '',
              statusBox: boxOf(status),
              chevronNode: chevronElement ? id(chevronElement) : null,
            };
          }),
          messages: [...(conversation?.querySelectorAll('.message') ?? [])].map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              node: id(node),
              role: node.className,
              text: node.textContent?.slice(0, 240) ?? '',
              box: [rect.x, rect.y, rect.width, rect.height],
            };
          }),
          shells: [...(conversation?.querySelectorAll('.shell-activity') ?? [])].map((node) => {
            const viewport = node.querySelector<HTMLElement>('.shell-output-viewport');
            const header = node.querySelector('.shell-output-header')?.getBoundingClientRect();
            return {
              node: id(node),
              expanded:
                node.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded') ===
                'true',
              commandLength: node.querySelector('.shell-command-text')?.textContent?.length ?? 0,
              viewportNode: viewport ? id(viewport) : null,
              scrollTop: viewport?.scrollTop ?? null,
              headerBox: header ? [header.x, header.y, header.width, header.height] : null,
            };
          }),
          selection: getSelection()?.toString() ?? '',
          outsideTools: [...(conversation?.querySelectorAll('.tool-activity-step') ?? [])].filter(
            (node) => !node.closest('.tool-activity-steps'),
          ).length,
          footer: footer ? [footer.x, footer.y, footer.width, footer.height] : null,
          scrollTop: viewport?.scrollTop ?? null,
          scrollHeight: viewport?.scrollHeight ?? null,
          width: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth,
          conversationOverflow: !!viewport && viewport.scrollWidth > viewport.clientWidth + 1,
          raw: conversation?.textContent?.includes('PRIVATE_RAW_RECEIPT_SENTINEL') ?? false,
          steps: conversation?.querySelectorAll('.tool-activity-steps > *').length ?? 0,
          nestedButtons: conversation?.querySelectorAll('button button').length ?? 0,
          summaryExtras: activities.reduce(
            (count, node) =>
              count +
              node.querySelectorAll(
                ':scope > .tool-activity-summary :is(.tool-activity-state,.tool-activity-count,.tool-approval,.tool-step-status)',
              ).length,
            0,
          ),
          mutations,
          settings: document.querySelector('.desktop-settings-dialog')
            ? {
                models: [
                  ...document.querySelectorAll<HTMLInputElement>(
                    '.desktop-settings-dialog [role="switch"][aria-label^="启用模型 "]',
                  ),
                ].map((node) => ({
                  label: node.getAttribute('aria-label'),
                  node: id(node),
                  checked: node.checked,
                  disabled: node.disabled,
                })),
                default: document.querySelector('[aria-label="默认模型"]')?.textContent ?? '',
                defaultControls: document.querySelectorAll(
                  '.desktop-settings-dialog :is(.settings-model-current,[aria-label="默认模型"],[aria-label="搜索默认模型"])',
                ).length,
                defaultBadges: [...document.querySelectorAll('.settings-model-option *')].filter(
                  (node) => node.textContent?.trim() === '默认',
                ).length,
                headerRefreshControls: [
                  ...document.querySelectorAll(
                    '.provider-model-settings .provider-page-heading button',
                  ),
                ].filter((node) =>
                  /刷新|重新读取/.test(node.getAttribute('aria-label') ?? node.textContent ?? ''),
                ).length,
                recoveryControls: [
                  ...document.querySelectorAll('.desktop-settings-dialog button'),
                ].filter((node) =>
                  /重新读取|查看结果/.test(
                    node.getAttribute('aria-label') ?? node.textContent ?? '',
                  ),
                ).length,
                errors: document.querySelectorAll('.desktop-settings-dialog [role="alert"]').length,
                readOnly:
                  document
                    .querySelector('.desktop-settings-dialog')
                    ?.textContent?.includes('当前配置不可修改') ?? false,
                busy: !!document.querySelector('.desktop-settings-dialog [aria-busy="true"]'),
                navigation: [...document.querySelectorAll('.settings-sidebar nav button')].map(
                  (node) => node.textContent ?? '',
                ),
                focus: {
                  tag: document.activeElement?.tagName ?? null,
                  label: document.activeElement?.getAttribute('aria-label') ?? null,
                  body: document.activeElement === document.body,
                  inPopup: !!document.activeElement?.closest('.connection-models-popover'),
                },
              }
            : null,
        });
      };
      const tick = () => {
        sample('raf');
        setTimeout(() => sample('task'), 0);
        requestAnimationFrame(tick);
      };
      addEventListener('DOMContentLoaded', () =>
        new MutationObserver(() => {
          mutations++;
          sample('mutation');
        }).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        }),
      );
      requestAnimationFrame(tick);
    });
    await page.goto(`${server.url}${toolDetails ? '?island=tool-details' : ''}`);
    if (!toolDetails) await page.getByRole('button', { name: 'Session A', exact: true }).click();
    await page.waitForFunction(
      () =>
        !!document.querySelector('.conversation-viewport') &&
        !document.querySelector('.conversation-loading'),
    );
    const stage = async (name: string, perform?: () => void) => {
      await page.evaluate((phase) => {
        window.liveAggregationPhase = phase;
      }, name);
      if (perform) await page.evaluate(perform);
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(artifact, `${label}-${name}.png`) });
    };
    const iconChecks: unknown[] = [];
    const defaultIcon = async (
      name: string,
      icon: ReturnType<typeof page.locator>,
      control: ReturnType<typeof page.locator>,
      hit: { width?: number; height?: number; minHeight?: number },
    ) => {
      const graphic = await icon.evaluate((node) => ({
        width: getComputedStyle(node).width,
        height: getComputedStyle(node).height,
      }));
      const box = await control.boundingBox();
      assert.equal(graphic.width, '14px', `${name} SVG width differs`);
      assert.equal(graphic.height, '14px', `${name} SVG height differs`);
      assert.ok(box, `${name} control is not visible`);
      if (hit.width !== undefined) assert.equal(box.width, hit.width, `${name} hit width shrank`);
      if (hit.height !== undefined)
        assert.equal(box.height, hit.height, `${name} hit height shrank`);
      if (hit.minHeight !== undefined)
        assert.ok(box.height >= hit.minHeight, `${name} hit height shrank`);
      iconChecks.push({ name, graphic, control: box });
    };
    if (settingsNav || settingsModels) {
      // The fixture uses the Darwin host name; the native CSS contract uses macos.
      await page.evaluate(() => {
        document.documentElement.dataset.platform = 'macos';
      });
      const input = page.getByRole('textbox', { name: '当前会话私有草稿', exact: true });
      const draft = 'unsent settings navigation draft 雪🙂';
      await input.fill(draft);
      let modelChoiceVerification: Record<string, unknown> | undefined;
      if (settingsModels) {
        const picker = page.getByRole('region', { name: '下一轮模型选择', exact: true });
        const trigger = picker.locator('[data-model-trigger]');
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLButtonElement>(
            '[data-model-picker] [data-model-trigger]',
          );
          return node?.textContent === '选择模型' && !node.disabled;
        });
        await stage('settings-input-model-unselected');
        const requestsBeforeChoice = await page.evaluate(
          () => window.liveAggregationFixture.requests.length,
        );
        await trigger.click();
        await page.getByRole('button', { name: '选择模型，当前 未选择', exact: true }).click();
        await page.locator('[aria-label="选择模型 model-b"]').click();
        await page.keyboard.press('Escape');
        await stage('settings-input-model-selected');
        assert.ok((await trigger.textContent())?.includes('Model B'));
        const choiceRequests = await page.evaluate(
          (offset) => window.liveAggregationFixture.requests.slice(offset),
          requestsBeforeChoice,
        );
        assert.deepEqual(choiceRequests, [], 'choosing a model submitted or persisted an intent');
        modelChoiceVerification = {
          initial: '选择模型',
          selected: await trigger.textContent(),
          choiceRequests,
        };
      }
      const originalInput = await input.elementHandle();
      const originalPanels = await page.locator('.client-panels').elementHandle();
      const newConversation = page.locator('.primary-navigation .new-session');
      const navigationStyle = async () =>
        newConversation.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            color: style.color,
            height: node.getBoundingClientRect().height,
            gap: style.gap,
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            background: style.backgroundColor,
          };
        });
      const navigation = await navigationStyle();
      await newConversation.hover();
      const navigationHover = await navigationStyle();
      await page.mouse.move(width - 10, 900, { steps: 8 });
      const conversationReads = () =>
        page.evaluate(() =>
          window.liveAggregationFixture.requests.filter((request) =>
            ['attach', 'select', 'messages', 'draft.read'].includes(request.method),
          ),
        );
      const reads = await conversationReads();
      if (settingsModels)
        await page.evaluate(() => window.liveAggregationFixture.settings('start'));
      const openSettings = async () => {
        await page.getByRole('button', { name: '用户菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page.locator('.desktop-settings-dialog').waitFor();
      };
      const back = page.getByRole('button', { name: '返回应用', exact: true });
      const geometry = async () =>
        back.evaluate((node) => {
          const rect = (element: Element) => {
            const box = element.getBoundingClientRect();
            return [box.x, box.y, box.width, box.height];
          };
          const style = getComputedStyle(node);
          const general = node.parentElement!.querySelector('button:nth-child(2)')!;
          return {
            box: rect(node),
            general: rect(general),
            header: rect(document.querySelector('.desktop-settings-header')!),
            gap: style.gap,
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            color: style.color,
            background: style.backgroundColor,
            outline: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            outlineOffset: style.outlineOffset,
            focusVisible: node.matches(':focus-visible'),
            first: node.parentElement!.firstElementChild === node,
            sameNavigation: node.parentElement === general.parentElement,
            navLabel: node.parentElement!.getAttribute('aria-label'),
            headerButtons: document.querySelectorAll('.desktop-settings-header button').length,
            nestedButtons: document.querySelectorAll('.desktop-settings-dialog button button')
              .length,
            overflow: document.documentElement.scrollWidth > innerWidth,
            platform: document.documentElement.dataset.platform,
          };
        });
      await stage('settings-draft');
      await openSettings();
      await page.mouse.move(width - 10, 900);
      await stage('settings-open');
      const normal = await geometry();
      assert.ok(normal.first && normal.sameNavigation && normal.navLabel === '设置分类');
      assert.equal(normal.headerButtons, 0);
      assert.equal(normal.nestedButtons, 0);
      assert.equal(normal.gap, '10px');
      assert.equal(normal.color, navigation.color, 'return does not use the navigation foreground');
      assert.equal(normal.box[3], navigation.height);
      assert.equal(normal.gap, navigation.gap);
      assert.equal(normal.paddingLeft, navigation.paddingLeft);
      assert.equal(normal.paddingRight, navigation.paddingRight);
      assert.equal(normal.paddingLeft, '10px');
      assert.equal(normal.box[3], 32);
      assert.equal(normal.box[0], normal.general[0]);
      assert.equal(normal.box[2], normal.general[2]);
      assert.ok(normal.box[1]! >= normal.header[1]! + normal.header[3]!);
      assert.equal(normal.box[1]! - normal.header[1]! - normal.header[3]!, 8);
      assert.ok(normal.box[0]! < 80, 'return retained the traffic-light horizontal indent');
      assert.equal(normal.overflow, false);
      const settingsNavigation = page.getByRole('navigation', { name: '设置分类', exact: true });
      const navigationLabels = ['返回应用', '常规', '提供商与模型', 'MCP', 'Skills'];
      assert.equal(await settingsNavigation.getByRole('button').count(), navigationLabels.length);
      for (const label of navigationLabels) {
        const button = settingsNavigation.getByRole('button', { name: label, exact: true });
        await defaultIcon(`settings ${label}`, button.locator(':scope > svg'), button, {
          minHeight: 32,
        });
      }
      const navigationAlignment = await settingsNavigation
        .getByRole('button')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const icon = node.querySelector('svg')!.getBoundingClientRect();
            const label = node.querySelector(':scope > span')!.getBoundingClientRect();
            return {
              name: node.textContent,
              iconLeft: icon.left,
              labelLeft: label.left,
              iconCenter: icon.top + icon.height / 2,
              labelCenter: label.top + label.height / 2,
            };
          }),
        );
      for (const item of navigationAlignment) {
        assert.equal(
          item.iconLeft,
          navigationAlignment[0]!.iconLeft,
          `${item.name} icon is misaligned`,
        );
        assert.equal(
          item.labelLeft,
          navigationAlignment[0]!.labelLeft,
          `${item.name} label is misaligned`,
        );
        assert.ok(
          Math.abs(item.iconCenter - item.labelCenter) <= 1,
          `${item.name} is not vertically aligned`,
        );
      }
      assert.equal(await page.locator('.client-panels').getAttribute('aria-hidden'), 'true');
      assert.equal(
        await page.locator('.client-panels').evaluate((node) => node.hasAttribute('inert')),
        true,
      );
      await back.hover();
      await stage('settings-return-hover');
      const hover = await geometry();
      assert.deepEqual(hover.box, normal.box);
      assert.notEqual(hover.background, normal.background);
      assert.equal(hover.background, navigationHover.background);
      await page.mouse.move(width - 10, 900, { steps: 8 });
      await page.getByRole('button', { name: '常规', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await back.evaluate((node) => node === document.activeElement), true);
      await stage('settings-return-focus');
      const focus = await geometry();
      assert.deepEqual(focus.box, normal.box);
      assert.ok(focus.focusVisible);
      assert.ok(
        focus.box[1]! -
          Number.parseFloat(focus.outlineWidth) -
          Number.parseFloat(focus.outlineOffset) >=
          focus.header[1]! + focus.header[3]!,
        'keyboard focus outline overlaps the native title area',
      );
      let unifiedVerification: unknown;
      if (settingsModels) {
        await settingsNavigation.getByRole('button', { name: '提供商与模型', exact: true }).click();
        const toggle = (id: string) =>
          page.getByRole('switch', { name: `启用模型 ${id}`, exact: true });
        const manager = (label: string) =>
          page.getByRole('button', { name: `管理 ${label} 的模型`, exact: true });
        const popup = (label: string) =>
          page.getByRole('dialog', { name: `${label} 的模型管理`, exact: true });
        const primary = page.getByRole('dialog', {
          name: /^Fixture Connection(?: Updated)? 的模型管理$/,
        });
        const secondary = popup('Second Fixture Connection');
        const cardGeometry = () =>
          page.locator('.provider-instance-list').evaluate((node) => ({
            width: node.getBoundingClientRect().width,
            height: node.getBoundingClientRect().height,
            cards: [...node.querySelectorAll<HTMLElement>(':scope > .provider-instance')].map(
              (card) => ({
                left: card.offsetLeft,
                top: card.offsetTop,
                width: card.getBoundingClientRect().width,
                height: card.getBoundingClientRect().height,
              }),
            ),
          }));
        const popupGeometry = async (label: string) =>
          popup(label).evaluate((node, label) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            const color = document.createElement('canvas');
            color.width = color.height = 1;
            const context = color.getContext('2d')!;
            context.fillStyle = style.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            const trigger = [...document.querySelectorAll('.connection-models-trigger')].find(
              (entry) => entry.getAttribute('aria-label') === `管理 ${label} 的模型`,
            )!;
            const triggerBox = trigger.getBoundingClientRect();
            const triggerFirst = trigger.querySelector(':scope > span')!.getBoundingClientRect();
            const triggerLast = trigger
              .querySelector(':scope > span:last-child')!
              .getBoundingClientRect();
            const row = node.querySelector('.settings-model-option')!;
            const name = row.querySelector('strong')!.getBoundingClientRect();
            const control = row.querySelector('[role="switch"]')!.getBoundingClientRect();
            return {
              box: [box.x, box.y, box.width, box.height],
              width: innerWidth,
              height: innerHeight,
              settingsContainer: !!node.closest('.desktop-settings'),
              cardContainer: !!node.closest('.provider-instance'),
              contentScroller: !!node.closest('.settings-content'),
              hidden: !!node.closest('[aria-hidden="true"],[inert]'),
              horizontal: node.scrollWidth > node.clientWidth + 1,
              visibility: style.visibility,
              background: style.backgroundColor,
              backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3],
              cardBackground: getComputedStyle(document.querySelector('.provider-instance')!)
                .backgroundColor,
              filterControls: node.querySelectorAll('select,[role="combobox"]').length,
              searchControls: node.querySelectorAll('input:not([role="switch"]),[role="searchbox"]')
                .length,
              toolbars: node.querySelectorAll('.connection-models-toolbar').length,
              listCount: node.querySelectorAll('.connection-models-scroll').length,
              extraButtons: node.querySelectorAll('button,[role="button"]').length,
              listInsetTop:
                node.querySelector('.connection-models-viewport')!.getBoundingClientRect().top -
                box.top,
              listBorderTop: getComputedStyle(node.querySelector('.connection-models-scroll')!)
                .borderTopWidth,
              triggerWidth: triggerBox.width,
              triggerTextLeft: triggerFirst.left - triggerBox.left,
              triggerTextRight: triggerBox.right - triggerLast.right,
              modelTextLeft: name.left - box.left,
              modelSwitchRight: box.right - control.right,
              optionsPadding: getComputedStyle(node.querySelector('.settings-model-options')!)
                .padding,
            };
          }, label);
        const assertPopup = async (label: string) => {
          const geometry = await popupGeometry(label);
          assert.ok(
            geometry.settingsContainer &&
              !geometry.cardContainer &&
              !geometry.contentScroller &&
              !geometry.hidden,
            'model popup portal is clipped or hidden by settings modal',
          );
          assert.ok(
            geometry.box[0]! >= 0 &&
              geometry.box[1]! >= 0 &&
              geometry.box[0]! + geometry.box[2]! <= geometry.width + 1 &&
              geometry.box[1]! + geometry.box[3]! <= geometry.height + 1,
            'model popup escaped viewport',
          );
          assert.equal(geometry.horizontal, false);
          assert.equal(geometry.visibility, 'visible');
          assert.equal(geometry.backgroundAlpha, 255, 'model popup background is transparent');
          assert.equal(
            geometry.background,
            geometry.cardBackground,
            'model popup does not use the actual card surface',
          );
          assert.equal(geometry.filterControls, 0, 'removed status filter is still rendered');
          assert.equal(geometry.searchControls, 0, 'removed search is still rendered');
          assert.equal(geometry.toolbars, 0, 'removed toolbar left a reserved container');
          assert.equal(geometry.listCount, 1);
          assert.equal(geometry.extraButtons, 0);
          assert.ok(
            geometry.listInsetTop > 0 && geometry.listInsetTop <= 5.5,
            'removed toolbar left top spacing',
          );
          assert.equal(geometry.listBorderTop, '0px');
          assert.ok(
            Math.abs(geometry.box[2]! - geometry.triggerWidth) < 0.5,
            'model popup width differs from its trigger',
          );
          assert.ok(Math.abs(geometry.triggerTextLeft - 10) < 0.5);
          assert.ok(Math.abs(geometry.triggerTextRight - 10) < 0.5);
          assert.ok(Math.abs(geometry.modelTextLeft - 17) < 0.5, 'model name left inset differs');
          assert.ok(
            Math.abs(geometry.modelSwitchRight - 17) < 0.5,
            'model switch right inset differs',
          );
          assert.equal(geometry.optionsPadding, '0px');
          assert.equal(await page.locator('.connection-models-popover').count(), 1);
          return geometry;
        };
        await manager('Fixture Connection').waitFor();
        assert.equal(
          await page
            .locator('.provider-page-heading')
            .getByRole('button', { name: /刷新|重新读取/ })
            .count(),
          0,
        );
        assert.equal(await page.locator('.desktop-settings-dialog [role="switch"]').count(), 0);
        for (const label of ['Fixture Connection', 'Second Fixture Connection', '其他模型'])
          assert.equal(await manager(label).getAttribute('aria-expanded'), 'false');
        await stage('settings-catalog-collapsed');
        const grid = await page.locator('.provider-instance-list').evaluate((node) => ({
          display: getComputedStyle(node).display,
          columns: getComputedStyle(node).gridTemplateColumns,
          cards: [...node.querySelectorAll(':scope > .provider-instance')].map((card) => {
            const box = card.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          }),
          headingBottom: node
            .closest('.provider-settings')!
            .querySelector('.provider-page-heading')!
            .getBoundingClientRect().bottom,
          directoryTop: node
            .closest('.provider-settings')!
            .querySelector('.provider-directory-heading')!
            .getBoundingClientRect().top,
        }));
        assert.equal(
          await page
            .locator(
              '.desktop-settings-dialog :is(.settings-model-current,[aria-label="默认模型"],[aria-label="搜索默认模型"])',
            )
            .count(),
          0,
        );
        assert.ok(
          grid.directoryTop - grid.headingBottom <= 40,
          'removed default model card left a reserved gap',
        );
        assert.equal(grid.display, 'grid');
        assert.equal(grid.cards.length, 2);
        if (width >= 1100) {
          assert.equal(grid.cards[0]!.y, grid.cards[1]!.y);
          assert.ok(grid.cards[1]!.x >= grid.cards[0]!.x + grid.cards[0]!.width);
        } else {
          assert.equal(grid.cards[0]!.x, grid.cards[1]!.x);
          assert.ok(grid.cards[1]!.y >= grid.cards[0]!.y + grid.cards[0]!.height);
        }
        const closedCards = await cardGeometry();
        await manager('Fixture Connection').click();
        await toggle('model-a').waitFor();
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute('aria-label') === 'Fixture Connection 的模型列表',
        );
        assert.equal(await primary.getByRole('switch').count(), 60);
        const primaryPopup = await assertPopup('Fixture Connection');
        assert.deepEqual(
          await cardGeometry(),
          closedCards,
          'opening model popup changed card/grid geometry',
        );
        const list = page.getByRole('region', {
          name: 'Fixture Connection 的模型列表',
          exact: true,
        });
        const scrollState = async (viewport = list) =>
          viewport.evaluate((node) => {
            const style = getComputedStyle(node);
            const length = (value: string) => {
              const probe = document.createElement('span');
              probe.style.cssText =
                'position:absolute;visibility:hidden;pointer-events:none;width:1px;top:0';
              probe.style.height = value;
              node.append(probe);
              const height = probe.getBoundingClientRect().height;
              probe.remove();
              return height;
            };
            const box = node.getBoundingClientRect();
            const thumb = node
              .closest('.connection-models-scroll')!
              .querySelector('[data-slot="scroll-area-thumb"]')
              ?.getBoundingClientRect();
            const switches = [...node.querySelectorAll('[role="switch"]')]
              .map((entry) => entry.getBoundingClientRect())
              .filter((entry) => entry.bottom > box.top && entry.top < box.bottom);
            return {
              top: node.scrollTop,
              height: node.clientHeight,
              scrollHeight: node.scrollHeight,
              box: [box.x, box.y, box.width, box.height],
              fadeTop: length(style.getPropertyValue('--scroll-fade-t')),
              fadeBottom: length(style.getPropertyValue('--scroll-fade-b')),
              mask: style.maskImage,
              horizontal: node.scrollWidth > node.clientWidth + 1,
              thumbLeft: thumb && thumb.width > 0 ? thumb.left : null,
              switchRight: switches.length
                ? Math.max(...switches.map((entry) => entry.right))
                : null,
            };
          });
        await list.scrollIntoViewIfNeeded();
        await list.focus();
        await page.keyboard.press('Home');
        await stage('settings-sixty-top');
        const listTop = await scrollState();
        assert.ok(listTop.height > 0 && listTop.height <= 320);
        assert.ok(listTop.scrollHeight > listTop.height);
        assert.equal(listTop.fadeTop, 0);
        assert.ok(listTop.fadeBottom > 0 && listTop.mask !== 'none');
        await page.keyboard.press('PageDown');
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLElement>('[aria-label="Fixture Connection 的模型列表"]')!
              .scrollTop > 0,
        );
        await list.hover();
        await stage('settings-sixty-middle');
        const listMiddle = await scrollState();
        assert.deepEqual(
          listMiddle.box,
          listTop.box,
          'model list geometry changed while scrolling',
        );
        assert.ok(listMiddle.fadeTop > 0 && listMiddle.fadeBottom > 0);
        assert.ok(
          listMiddle.thumbLeft !== null &&
            listMiddle.switchRight !== null &&
            listMiddle.thumbLeft > listMiddle.switchRight,
          'model scrollbar thumb covers switches',
        );
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLElement>(
            '[aria-label="Fixture Connection 的模型列表"]',
          )!;
          return Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 2;
        });
        await stage('settings-sixty-bottom');
        const listBottom = await scrollState();
        assert.deepEqual(listBottom.box, listTop.box);
        assert.equal(listBottom.fadeBottom, 0);
        assert.ok(listBottom.fadeTop > 0);
        assert.equal(listBottom.horizontal, false);
        await page.keyboard.press('Escape');
        await primary.waitFor({ state: 'hidden' });
        await stage('settings-popup-escape');
        assert.equal(await page.locator('.desktop-settings-dialog').isVisible(), true);
        assert.equal(
          await manager('Fixture Connection').evaluate((node) => node === document.activeElement),
          true,
        );
        assert.deepEqual(await cardGeometry(), closedCards);
        await page.setViewportSize({ width, height: 480 });
        const shortClosedCards = await cardGeometry();
        await manager('Fixture Connection').click();
        await primary.waitFor();
        await stage('settings-popup-short-viewport');
        const shortPopup = await assertPopup('Fixture Connection');
        const shortList = await scrollState();
        assert.ok(shortList.height > 0 && shortList.height <= 320);
        assert.deepEqual(
          await cardGeometry(),
          shortClosedCards,
          'short viewport popup resized cards',
        );
        assert.equal(await primary.getByRole('switch').count(), 60);
        await page.keyboard.press('Escape');
        await primary.waitFor({ state: 'hidden' });
        await page.setViewportSize({ width, height: 1000 });
        await manager('Fixture Connection').click();
        assert.equal(await primary.getByRole('switch').count(), 60);
        if (width < 800) {
          await page.keyboard.press('Escape');
          await primary.waitFor({ state: 'hidden' });
          await stage('settings-popup-close-before-switch');
          assert.equal(
            await manager('Fixture Connection').evaluate((node) => node === document.activeElement),
            true,
          );
          assert.deepEqual(await cardGeometry(), closedCards);
        }
        await manager('Second Fixture Connection').click();
        assert.equal(await secondary.getByRole('switch').count(), 20);
        assert.equal(await primary.getByRole('switch').count(), 0);
        assert.equal(await toggle('secondary-001').count(), 1);
        const secondPopup = await assertPopup('Second Fixture Connection');
        assert.deepEqual(
          await cardGeometry(),
          closedCards,
          'switching model popup changed grid geometry',
        );
        await stage('settings-second-connection-expanded');
        const secondList = page.getByRole('region', {
          name: 'Second Fixture Connection 的模型列表',
          exact: true,
        });
        await secondList.scrollIntoViewIfNeeded();
        await secondList.focus();
        const secondTop = await scrollState(secondList);
        assert.ok(secondTop.height > 0 && secondTop.height <= 320);
        assert.ok(secondTop.scrollHeight > secondTop.height);
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLElement>(
            '[aria-label="Second Fixture Connection 的模型列表"]',
          )!;
          return Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 2;
        });
        await stage('settings-second-connection-bottom');
        const secondBottom = await scrollState(secondList);
        assert.deepEqual(secondBottom.box, secondTop.box);
        assert.equal(secondBottom.fadeBottom, 0);
        assert.ok(secondBottom.fadeTop > 0);
        assert.equal(secondBottom.horizontal, false);
        await page.keyboard.press('Escape');
        await secondary.waitFor({ state: 'hidden' });
        await stage('settings-second-popup-escape');
        assert.equal(
          await manager('Second Fixture Connection').evaluate(
            (node) => node === document.activeElement,
          ),
          true,
        );
        assert.equal(await secondary.getByRole('switch').count(), 0);
        await manager('其他模型').click();
        await toggle('unmapped-model').waitFor();
        assert.equal(await popup('其他模型').getByRole('switch').count(), 1);
        await assertPopup('其他模型');
        await stage('settings-popup-fallback');
        await page.locator('.provider-page-heading h2').click();
        await popup('其他模型').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.desktop-settings-dialog').isVisible(), true);
        assert.deepEqual(await cardGeometry(), closedCards);
        await stage('settings-popup-outside');
        await manager('Fixture Connection').click();
        const modelLabels = [
          '启用模型 model-a',
          ...Array.from(
            { length: 58 },
            (_, index) => `启用模型 primary-${String(index + 3).padStart(3, '0')}`,
          ),
          '启用模型 model-b',
        ];
        const visibleRows = async () =>
          page
            .locator('.desktop-settings-dialog [role="switch"]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')).sort());
        assert.deepEqual(await visibleRows(), [...modelLabels].sort());
        for (const id of ['model-a', 'model-b']) assert.equal(await toggle(id).count(), 1);
        assert.equal(await page.locator('.provider-instance [role="switch"]').count(), 0);
        assert.equal(await toggle('model-a').isChecked(), true);
        assert.equal(await toggle('model-a').isDisabled(), false);
        assert.equal(await toggle('model-b').isChecked(), false);
        await stage('settings-unified-loaded');
        const beforeSave = await page.evaluate(() =>
          window.liveAggregationFixture.settings('state'),
        );
        assert.equal(
          beforeSave.audit.filter((entry) => entry.method.startsWith('update')).length,
          0,
          'opening or scrolling model lists wrote configuration',
        );
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-edit-opening';
        });
        await page.getByRole('button', { name: '编辑 Fixture Connection', exact: true }).click();
        await primary.waitFor({ state: 'hidden' });
        await page
          .getByRole('textbox', { name: '提供商名称', exact: true })
          .fill('Fixture Connection Updated');
        await page
          .getByRole('textbox', { name: '模型名称', exact: true })
          .fill(
            beforeSave.connection.modelNames
              .map((name, index) => (index === 0 ? 'fixture-model-a-updated' : name))
              .join('\n'),
          );
        await page.evaluate(() => window.liveAggregationFixture.settings('hold'));
        await page.getByRole('button', { name: '保存提供商配置', exact: true }).click();
        await page.waitForFunction(
          async () => (await window.liveAggregationFixture.settings('state')).pending === 1,
        );
        assert.equal(
          await page.getByRole('button', { name: '正在保存…', exact: true }).isDisabled(),
          true,
        );
        await stage('settings-provider-held');
        const held = await page.evaluate(() => window.liveAggregationFixture.settings('state'));
        assert.equal(held.providerSettingsSubmissions.at(-1)?.phase, 'submitting');
        await page.evaluate(() => window.liveAggregationFixture.settings('release'));
        await page
          .getByRole('button', { name: '编辑 Fixture Connection Updated', exact: true })
          .waitFor();
        await manager('Fixture Connection Updated').click();
        await toggle('model-a').waitFor();
        await page.waitForFunction(() =>
          document
            .querySelector('[role="switch"][aria-label="启用模型 model-a"]')
            ?.closest('label')
            ?.textContent?.includes('fixture-model-a-updated'),
        );
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLInputElement>(
              '[role="switch"][aria-label="启用模型 model-b"]',
            )?.disabled,
        );
        await stage('settings-provider-applied');
        const providerApplied = await page.evaluate(() =>
          window.liveAggregationFixture.settings('state'),
        );
        for (const method of ['getProviderSettings', 'getModelSettings'])
          assert.ok(
            providerApplied.audit.filter((entry) => entry.method === method).length >
              beforeSave.audit.filter((entry) => entry.method === method).length,
            `${method} did not refresh after peer save`,
          );
        assert.deepEqual(await visibleRows(), [...modelLabels].sort());
        const cId = 'primary-060';
        const state = () => page.evaluate(() => window.liveAggregationFixture.settings('state'));
        const modelPosts = (snapshot: Awaited<ReturnType<typeof state>>) =>
          snapshot.audit.filter((entry) => entry.method === 'updateModelSettings');
        const ordinaryReads = (snapshot: Awaited<ReturnType<typeof state>>) =>
          snapshot.audit.filter(
            (entry) =>
              entry.method === 'settings.models.read' &&
              !(entry.input as { afterCommandId?: string }).afterCommandId,
          ).length;
        const focusState = () =>
          page.evaluate(() => ({
            tag: document.activeElement?.tagName,
            label: document.activeElement?.getAttribute('aria-label'),
            body: document.activeElement === document.body,
            inPopup: !!document.activeElement?.closest('.connection-models-popover'),
          }));
        const intent = async (id: string, checked: boolean) => {
          assert.equal(
            await toggle(id).isDisabled(),
            false,
            `${id}: normal queue disabled a switch`,
          );
          if (checked) await toggle(id).check();
          else await toggle(id).uncheck();
          assert.equal(
            await toggle(id).isChecked(),
            checked,
            `${id}: UI did not immediately reflect the latest intent`,
          );
          assert.equal(await toggle(id).isDisabled(), false);
        };
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-queue-starting';
        });
        let enableViewport = primary.locator('.connection-models-viewport');
        await enableViewport.focus();
        await page.keyboard.press('End');
        await page.evaluate(() => window.liveAggregationFixture.settings('hold'));
        await page.evaluate(() => window.liveAggregationFixture.settings('hold-model-reads'));
        await intent('model-b', true);
        await page.waitForFunction(
          async () => (await window.liveAggregationFixture.settings('state')).pending === 1,
        );
        await intent('model-b', false);
        await intent('model-b', true);
        await intent('model-b', false);
        await intent(cId, true);
        await stage('settings-queue-head-held');
        const enabledPending = await state();
        assert.equal(modelPosts(enabledPending).length, 1);
        assert.equal(enabledPending.maxConcurrentWrites, 1);
        // Provider fields remain inspectable; a model drain retains the write lease.
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-queue-provider-inspect';
        });
        await page
          .getByRole('button', { name: '编辑 Fixture Connection Updated', exact: true })
          .click();
        await primary.waitFor({ state: 'hidden' });
        assert.equal(
          await page.getByRole('button', { name: '保存提供商配置', exact: true }).isDisabled(),
          true,
        );
        await stage('settings-queue-provider-blocked');
        await page
          .locator('.provider-editor-footer')
          .getByRole('button', { name: '取消', exact: true })
          .click();
        const beforeBusyClose = await state();
        await back.click();
        await page.locator('.desktop-settings-dialog').waitFor({ state: 'hidden' });
        assert.equal(await input.textContent(), draft);
        await stage('settings-queue-detached');
        await page.evaluate(() => window.liveAggregationFixture.settings('release'));
        await page.waitForFunction(
          async () =>
            (await window.liveAggregationFixture.settings('state')).pendingModelReads === 1,
        );
        const detachedRead = await state();
        assert.equal(modelPosts(detachedRead).length, 1);
        await openSettings();
        await manager('Fixture Connection Updated').click();
        await toggle('model-b').waitFor();
        const afterBusyReopen = await state();
        assert.equal(
          ordinaryReads(afterBusyReopen),
          ordinaryReads(beforeBusyClose),
          'active controller reopen performed an ordinary model GET',
        );
        assert.equal(
          afterBusyReopen.audit.filter((entry) => entry.method === 'getProviderSettings').length,
          beforeBusyClose.audit.filter((entry) => entry.method === 'getProviderSettings').length +
            1,
        );
        assert.equal(await toggle('model-b').isChecked(), false);
        assert.equal(await toggle(cId).isChecked(), true);
        enableViewport = primary.locator('.connection-models-viewport');
        await enableViewport.focus();
        await page.keyboard.press('End');
        await toggle('model-b').focus();
        let enableViewportNode = await enableViewport.elementHandle();
        const enableScrollBefore = await enableViewport.evaluate((node) => node.scrollTop);
        const settingsScrollBefore = await page
          .locator('.settings-content')
          .evaluate((node) => node.scrollTop);
        assert.ok(enableScrollBefore > 0);
        const beforeEnableFocus = await focusState();
        await intent('model-b', true);
        await intent('model-b', false);
        await stage('settings-queue-own-read-held');
        const pendingEnableFocus = await focusState();
        assert.equal(pendingEnableFocus.label, '启用模型 model-b');
        assert.equal(pendingEnableFocus.body, false);
        assert.equal(
          await enableViewport.evaluate((node, previous) => node === previous, enableViewportNode),
          true,
        );
        assert.equal(await enableViewport.evaluate((node) => node.scrollTop), enableScrollBefore);
        await page.evaluate(() => window.liveAggregationFixture.settings('hold-provider-reads'));
        await page.evaluate(() => window.liveAggregationFixture.settings('release-model-reads'));
        await page.waitForFunction(
          async () =>
            (await window.liveAggregationFixture.settings('state')).pendingProviderReads === 1,
        );
        const beforeFlushIntents = await state();
        assert.equal(modelPosts(beforeFlushIntents).length, 3);
        assert.equal(await toggle('model-b').isChecked(), false);
        assert.equal(await toggle(cId).isChecked(), true);
        await intent('model-b', true);
        await intent(cId, false);
        await toggle('model-b').focus();
        await stage('settings-queue-flush-held');
        assert.equal(await toggle('model-b').isDisabled(), false);
        assert.equal(await toggle(cId).isDisabled(), false);
        assert.equal((await focusState()).label, '启用模型 model-b');
        assert.equal(
          await enableViewport.evaluate((node, previous) => node === previous, enableViewportNode),
          true,
        );
        assert.equal(await enableViewport.evaluate((node) => node.scrollTop), enableScrollBefore);
        // General owns an independent readonly Main reader. Its read/close must not
        // invalidate the background queue's exact continuation observation.
        // A transient Provider flush error must not reject the model tail.
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-provider-flush-failing';
        });
        await page.evaluate(() => window.liveAggregationFixture.settings('hold'));
        await page.evaluate(() =>
          window.liveAggregationFixture.settings('failed-provider-read-next'),
        );
        await page.evaluate(() => window.liveAggregationFixture.settings('release-provider-reads'));
        await page.waitForFunction(
          () => !!document.querySelector('.provider-model-settings [role="alert"]'),
        );
        await page.waitForFunction(
          async () => (await window.liveAggregationFixture.settings('state')).pending === 1,
        );
        await stage('settings-provider-flush-failed');
        const providerFlushFailed = await state();
        assert.equal(
          modelPosts(providerFlushFailed).length,
          4,
          'Provider GET failure discarded accepted model tail',
        );
        assert.equal(await toggle('model-b').isDisabled(), false);
        assert.equal(await toggle(cId).isDisabled(), false);
        assert.equal(await toggle('model-b').isChecked(), true);
        assert.equal(await toggle(cId).isChecked(), false);
        await page.waitForFunction(
          async () =>
            (await window.liveAggregationFixture.settings('state')).pendingProviderReads > 0,
        );
        await page.evaluate(() => window.liveAggregationFixture.settings('release-provider-reads'));
        await page.waitForFunction(
          () => !document.querySelector('.provider-model-settings [role="alert"]'),
        );
        await stage('settings-provider-flush-auto-recovered');
        const providerFlushRecovered = await state();
        assert.equal(
          modelPosts(providerFlushRecovered).length,
          modelPosts(providerFlushFailed).length,
        );
        assert.equal(
          await enableViewport.evaluate((node, previous) => node === previous, enableViewportNode),
          true,
        );
        assert.equal(await toggle('model-b').isDisabled(), false);
        assert.equal(await toggle(cId).isDisabled(), false);
        const beforeGeneral = await state();
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-provider-general-opening';
        });
        await page.getByRole('button', { name: '常规', exact: true }).click();
        const general = page.getByRole('region', { name: '常规设置', exact: true });
        await page.waitForFunction(
          () =>
            !!document
              .querySelector('[aria-label="常规设置"] .settings-value')
              ?.textContent?.includes('fixture-model-a-updated'),
        );
        await stage('settings-queue-general-read');
        const generalRead = await state();
        assert.equal(
          generalRead.audit.filter((entry) => entry.method === 'settings.general.models.read')
            .length,
          beforeGeneral.audit.filter((entry) => entry.method === 'settings.general.models.read')
            .length + 1,
        );
        assert.equal(await general.getAttribute('aria-busy'), null);
        assert.equal(await general.getByRole('alert').count(), 0);
        await page.evaluate(() => window.liveAggregationFixture.settings('release-provider-reads'));
        await page.getByRole('button', { name: '提供商与模型', exact: true }).click();
        await manager('Fixture Connection Updated').click();
        await toggle('model-b').waitFor();
        const afterGeneral = await state();
        assert.equal(
          ordinaryReads(afterGeneral),
          ordinaryReads(beforeGeneral),
          'General navigation invalidated the retained model controller',
        );
        assert.equal(
          afterGeneral.audit.filter((entry) => entry.method === 'settings.general.models.close')
            .length,
          beforeGeneral.audit.filter((entry) => entry.method === 'settings.general.models.close')
            .length + 1,
        );
        assert.equal(await toggle('model-b').isChecked(), true);
        assert.equal(await toggle(cId).isChecked(), false);
        assert.equal(await toggle('model-b').isDisabled(), false);
        assert.equal(await toggle(cId).isDisabled(), false);
        // Switching categories legitimately remounts this popup; identity and focus
        // remain strict within each mounted reading interval.
        enableViewport = primary.locator('.connection-models-viewport');
        await enableViewport.focus();
        await page.keyboard.press('End');
        await toggle('model-b').focus();
        enableViewportNode = await enableViewport.elementHandle();
        assert.equal(await enableViewport.evaluate((node) => node.scrollTop), enableScrollBefore);
        await stage('settings-queue-general-returned');
        await page.evaluate(() => window.liveAggregationFixture.settings('release'));
        await page.waitForFunction(async () => {
          const snapshot = await window.liveAggregationFixture.settings('state');
          return (
            snapshot.audit.filter((entry) => entry.method === 'updateModelSettings').length === 5 &&
            snapshot.modelSettingsSubmissions.every((entry) => entry.phase === 'applied') &&
            snapshot.pending === 0 &&
            snapshot.pendingModelReads === 0 &&
            snapshot.pendingProviderReads === 0
          );
        });
        await stage('settings-queue-drained');
        const queueDrained = await state();
        assert.equal(queueDrained.maxConcurrentWrites, 1);
        assert.equal(queueDrained.models.find((entry) => entry.id === 'model-b')!.enabled, true);
        assert.equal(queueDrained.models.find((entry) => entry.id === cId)!.enabled, false);
        assert.deepEqual(
          modelPosts(queueDrained).map((entry) => (entry.input as ModelSettingsRequest).operation),
          [
            { kind: 'enabled', modelId: 'model-b', enabled: true },
            { kind: 'enabled', modelId: 'model-b', enabled: false },
            { kind: 'enabled', modelId: cId, enabled: true },
            { kind: 'enabled', modelId: 'model-b', enabled: true },
            { kind: 'enabled', modelId: cId, enabled: false },
          ],
        );
        for (const [index, entry] of modelPosts(queueDrained).entries()) {
          const input = entry.input as ModelSettingsRequest;
          const receipt = queueDrained.receipts.find(
            (value) => value.commandId === input.commandId,
          )!;
          assert.ok(receipt.state === 'applied' && 'postReadSet' in receipt.receipt);
          assert.equal(
            queueDrained.audit.filter(
              (value) =>
                value.method === 'settings.models.read' &&
                (value.input as { afterCommandId?: string }).afterCommandId === input.commandId,
            ).length,
            1,
          );
          const next = modelPosts(queueDrained)[index + 1]?.input as
            | ModelSettingsRequest
            | undefined;
          if (next)
            assert.deepEqual(
              next.expectedReadSet,
              receipt.receipt.postReadSet,
              'next model POST did not use the exact prior publication proof',
            );
        }
        const appliedEnableFocus = await focusState();
        await Bun.write(
          path.join(artifact, `${label}-queue-focus.json`),
          JSON.stringify(
            {
              beforeEnableFocus,
              pendingEnableFocus,
              appliedEnableFocus,
              trace: await page.evaluate(() =>
                window.liveAggregationSamples
                  .filter((sample) =>
                    [
                      'settings-queue-own-read-held',
                      'settings-queue-flush-held',
                      'settings-provider-flush-failing',
                      'settings-provider-flush-failed',
                      'settings-provider-flush-auto-recovered',
                      'settings-queue-general-returned',
                      'settings-queue-drained',
                    ].includes(sample.phase),
                  )
                  .map((sample) => ({
                    phase: sample.phase,
                    cause: sample.cause,
                    time: sample.time,
                    focus: sample.settings?.focus,
                    models: sample.settings?.models.filter((row) =>
                      ['启用模型 model-b', '启用模型 primary-060'].includes(row.label ?? ''),
                    ),
                  })),
              ),
            },
            null,
            2,
          ),
        );
        assert.equal(appliedEnableFocus.label, '启用模型 model-b');
        assert.equal(appliedEnableFocus.body, false);
        assert.equal(
          await enableViewport.evaluate((node, previous) => node === previous, enableViewportNode),
          true,
        );
        const enableScrollAfter = await enableViewport.evaluate((node) => node.scrollTop);
        assert.equal(enableScrollAfter, enableScrollBefore);
        assert.equal(
          await page.locator('.settings-content').evaluate((node) => node.scrollTop),
          settingsScrollBefore,
        );
        console.log(
          JSON.stringify({
            theme,
            width,
            queue: {
              posts: modelPosts(queueDrained).length,
              maxConcurrent: queueDrained.maxConcurrentWrites,
              beforeEnableFocus,
              pendingEnableFocus,
              appliedEnableFocus,
              enableScrollBefore,
              enableScrollAfter,
            },
          }),
        );
        const queueVerification = {
          beforeBusyClose,
          detachedRead,
          afterBusyReopen,
          beforeFlushIntents,
          providerFlushFailed,
          providerFlushRecovered,
          beforeGeneral,
          generalRead,
          afterGeneral,
          queueDrained,
        };
        await stage('settings-model-enabled');
        // Explicit fixture setup through the existing closed Bridge, not an implicit UI write.
        const defaultSetup = await page.evaluate(async () => {
          const facts = await window.kiteNative!.request({
            method: 'settings.models.read',
            generation: 1,
            scope: 'user',
          });
          if (
            !facts ||
            !('kind' in facts) ||
            facts.kind !== 'settings.models' ||
            !('observationId' in facts) ||
            facts.storeId !== 'store' ||
            facts.scope !== 'user'
          )
            throw Error('fixture_settings_setup_scope');
          return window.kiteNative!.request({
            method: 'settings.models.default',
            generation: 1,
            observationId: facts.observationId,
            modelId: 'model-b',
          });
        });
        assert.ok(
          defaultSetup &&
            'kind' in defaultSetup &&
            defaultSetup.kind === 'settings.models.submission' &&
            'phase' in defaultSetup &&
            defaultSetup.phase === 'applied',
        );
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-default-setup';
        });
        const beforeDefaultReopen = await page.evaluate(() =>
          window.liveAggregationFixture.settings('state'),
        );
        await back.click();
        await page.locator('.desktop-settings-dialog').waitFor({ state: 'hidden' });
        assert.equal(await input.textContent(), draft);
        await stage('settings-default-setup-closed');
        await openSettings();
        await manager('Fixture Connection Updated').click();
        await toggle('model-a').waitFor();
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLInputElement>(
              '[role="switch"][aria-label="启用模型 model-a"]',
            )?.disabled,
        );
        assert.equal(await toggle('model-b').isDisabled(), false);
        await stage('settings-default-changed');
        const defaultReopened = await page.evaluate(() =>
          window.liveAggregationFixture.settings('state'),
        );
        for (const method of ['getProviderSettings', 'getModelSettings'])
          assert.equal(
            defaultReopened.audit.filter((entry) => entry.method === method).length,
            beforeDefaultReopen.audit.filter((entry) => entry.method === method).length + 1,
            `${method}: reopening did not perform one lifecycle read`,
          );
        const defaultToggleSnapshots: Awaited<ReturnType<typeof state>>[] = [];
        for (const enabled of [false, true]) {
          const before = await state();
          const row = await toggle('model-b').elementHandle();
          await page.evaluate(() => window.liveAggregationFixture.settings('hold'));
          await intent('model-b', enabled);
          await page.waitForFunction(
            async () => (await window.liveAggregationFixture.settings('state')).pending === 1,
          );
          await stage(enabled ? 'settings-default-reenable-held' : 'settings-default-disable-held');
          assert.equal(await toggle('model-b').isDisabled(), false);
          await page.evaluate(() => window.liveAggregationFixture.settings('release'));
          await page.waitForFunction(async (enabled) => {
            const snapshot = await window.liveAggregationFixture.settings('state');
            const entry = snapshot.modelSettingsSubmissions.at(-1);
            return (
              entry?.phase === 'applied' &&
              snapshot.models.find((model) => model.id === 'model-b')?.enabled === enabled &&
              snapshot.audit.some(
                (event) =>
                  event.method === 'settings.models.read' &&
                  (event.input as { afterCommandId?: string }).afterCommandId === entry.commandId,
              ) &&
              snapshot.pendingModelReads === 0
            );
          }, enabled);
          await stage(enabled ? 'settings-default-reenabled' : 'settings-default-disabled');
          const after = await state();
          assert.equal(
            after.defaultModelId,
            'model-b',
            'toggling the default model silently selected a replacement',
          );
          assert.equal(after.models.find((model) => model.id === 'model-b')!.enabled, enabled);
          assert.equal(modelPosts(after).length, modelPosts(before).length + 1);
          assert.equal(
            await toggle('model-b').evaluate((node, previous) => node === previous, row),
            true,
          );
          const input = modelPosts(after).at(-1)!.input as ModelSettingsRequest;
          const receipt = after.receipts.find((entry) => entry.commandId === input.commandId)!;
          assert.ok(receipt.state === 'applied' && 'postReadSet' in receipt.receipt);
          const fresh = before.audit
            .filter((entry) => entry.method === 'getModelSettings.return')
            .at(-1)!.input as { readSet: ModelSettingsRequest['expectedReadSet'] };
          assert.deepEqual(
            input.expectedReadSet,
            fresh.readSet,
            'default toggle did not use its fresh observation',
          );
          assert.equal(
            after.audit.filter(
              (entry) =>
                entry.method === 'settings.models.read' &&
                (entry.input as { afterCommandId?: string }).afterCommandId === input.commandId,
            ).length,
            1,
          );
          if (defaultToggleSnapshots.length) {
            const previous = defaultToggleSnapshots.at(-1)!;
            const published = previous.receipts.at(-1)!;
            assert.ok(published.state === 'applied' && 'postReadSet' in published.receipt);
            assert.deepEqual(
              input.expectedReadSet,
              published.receipt.postReadSet,
              'reenable did not use the exact disable publication proof',
            );
          }
          defaultToggleSnapshots.push(after);
        }
        const beforeUnknown = await page.evaluate(() =>
          window.liveAggregationFixture.settings('state'),
        );
        await page.evaluate(() => window.liveAggregationFixture.settings('hold-lookups'));
        await page.evaluate(() => window.liveAggregationFixture.settings('unknown-next'));
        await page.evaluate(() => window.liveAggregationFixture.settings('hold'));
        await intent('model-a', false);
        await page.waitForFunction(
          async () => (await window.liveAggregationFixture.settings('state')).pending === 1,
        );
        await intent('model-a', true);
        await intent(cId, true);
        await stage('settings-queue-unknown-tail-held');
        await page.evaluate(() => window.liveAggregationFixture.settings('release'));
        const unresolved = page.getByRole('region', { name: '待确认的模型更改', exact: true });
        await unresolved.getByRole('button', { name: '查看结果', exact: true }).waitFor();
        await stage('settings-model-unknown');
        assert.equal(await toggle('model-a').isDisabled(), true);
        assert.equal(await toggle('model-b').isDisabled(), true);
        assert.equal(
          await toggle(cId).isChecked(),
          false,
          'unknown head retained an unissued tail',
        );
        const unknown = await page.evaluate(() => window.liveAggregationFixture.settings('state'));
        assert.equal(unknown.modelSettingsSubmissions.at(-1)?.phase, 'unknown');
        assert.equal(
          unknown.audit.filter((entry) => entry.method === 'updateModelSettings').length,
          beforeUnknown.audit.filter((entry) => entry.method === 'updateModelSettings').length + 1,
        );
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-unknown-closing';
        });
        await back.click();
        await page.locator('.desktop-settings-dialog').waitFor({ state: 'hidden' });
        assert.equal(await input.textContent(), draft);
        await openSettings();
        await unresolved.getByRole('button', { name: '查看结果', exact: true }).waitFor();
        assert.equal(await page.locator('.desktop-settings-dialog [role="switch"]').count(), 0);
        await stage('settings-unknown-reopened');
        const reopened = await page.evaluate(() => window.liveAggregationFixture.settings('state'));
        assert.equal(
          reopened.audit.filter((entry) => entry.method === 'updateModelSettings').length,
          unknown.audit.filter((entry) => entry.method === 'updateModelSettings').length,
        );
        await page.waitForFunction(
          async () => (await window.liveAggregationFixture.settings('state')).pendingLookups > 0,
        );
        const lookupHeld = await state();
        assert.equal(modelPosts(lookupHeld).length, modelPosts(unknown).length);
        assert.ok(
          lookupHeld.audit
            .filter((entry) => entry.method === 'getHostMutation')
            .every(
              (entry) =>
                (entry.input as { commandId: string }).commandId ===
                unknown.modelSettingsSubmissions.at(-1)!.commandId,
            ),
        );
        await stage('settings-unknown-auto-lookup-held');
        await page.evaluate(() => window.liveAggregationFixture.settings('release-lookups'));
        await unresolved.waitFor({ state: 'hidden' });
        await manager('Fixture Connection Updated').click();
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLInputElement>(
              '[role="switch"][aria-label="启用模型 model-a"]',
            )?.disabled,
        );
        assert.equal(await toggle('model-a').isChecked(), false);
        assert.equal(await toggle('model-b').isChecked(), true);
        assert.equal(await toggle('model-b').isDisabled(), false);
        assert.equal(await toggle(cId).isChecked(), false, 'lookup revived the discarded tail');
        await stage('settings-model-confirmed');
        const confirmed = await page.evaluate(() =>
          window.liveAggregationFixture.settings('state'),
        );
        assert.equal(
          confirmed.audit.filter((entry) => entry.method === 'updateModelSettings').length,
          unknown.audit.filter((entry) => entry.method === 'updateModelSettings').length,
        );
        assert.equal(
          confirmed.audit
            .filter((entry) => entry.method === 'getHostMutation')
            .every(
              (entry) =>
                (entry.input as { commandId: string }).commandId ===
                unknown.modelSettingsSubmissions.at(-1)!.commandId,
            ),
          true,
        );
        assert.equal(
          confirmed.audit.filter((entry) => entry.method === 'updateProviderSettings').length,
          1,
        );
        assert.equal(
          confirmed.audit.filter((entry) => entry.method === 'updateModelSettings').length,
          9,
        );
        assert.deepEqual(
          confirmed.audit
            .filter((entry) => entry.method === 'updateModelSettings')
            .map((entry) => (entry.input as ModelSettingsRequest).operation),
          [
            { kind: 'enabled', modelId: 'model-b', enabled: true },
            { kind: 'enabled', modelId: 'model-b', enabled: false },
            { kind: 'enabled', modelId: cId, enabled: true },
            { kind: 'enabled', modelId: 'model-b', enabled: true },
            { kind: 'enabled', modelId: cId, enabled: false },
            { kind: 'default', modelId: 'model-b' },
            { kind: 'enabled', modelId: 'model-b', enabled: false },
            { kind: 'enabled', modelId: 'model-b', enabled: true },
            { kind: 'enabled', modelId: 'model-a', enabled: false },
          ],
        );
        assert.deepEqual(await visibleRows(), [...modelLabels].sort());
        const recovery = async (phase: string) => {
          assert.equal(await page.locator('.provider-read-recovery').count(), 0);
          await page.evaluate(() => window.liveAggregationFixture.settings('release-model-reads'));
          await page.waitForFunction(
            () =>
              !document.querySelector<HTMLInputElement>(
                '[role="switch"][aria-label="启用模型 primary-060"]',
              )?.disabled,
          );
          await stage(phase);
          assert.equal(await page.locator('.provider-model-settings [role="alert"]').count(), 0);
          assert.equal(await page.locator('.provider-read-recovery').count(), 0);
          return state();
        };
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-known-failure-starting';
        });
        await page.evaluate(() => window.liveAggregationFixture.settings('failed-next'));
        await page.evaluate(() => window.liveAggregationFixture.settings('hold'));
        await intent(cId, true);
        await page.waitForFunction(
          async () => (await window.liveAggregationFixture.settings('state')).pending === 1,
        );
        await intent('model-a', true);
        await page.evaluate(() => window.liveAggregationFixture.settings('hold-model-reads'));
        await page.evaluate(() => window.liveAggregationFixture.settings('release'));
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLInputElement>(
              '[role="switch"][aria-label="启用模型 primary-060"]',
            )?.disabled === true,
        );
        assert.equal(
          await page.getByRole('button', { name: '重新读取提供商与模型配置', exact: true }).count(),
          0,
        );
        await stage('settings-known-failure-stopped');
        const knownFailure = await state();
        assert.equal(modelPosts(knownFailure).length, modelPosts(confirmed).length + 1);
        assert.equal(knownFailure.modelSettingsSubmissions.at(-1)?.phase, 'failed');
        assert.equal(await toggle(cId).isChecked(), false);
        assert.equal(await toggle('model-a').isChecked(), false);
        assert.equal(await toggle(cId).isDisabled(), true);
        const knownRecovered = await recovery('settings-known-failure-recovered');
        assert.equal(modelPosts(knownRecovered).length, modelPosts(knownFailure).length);
        await page.evaluate(() => {
          window.liveAggregationPhase = 'settings-foreign-read-starting';
        });
        await page.evaluate(() => window.liveAggregationFixture.settings('hold'));
        await page.evaluate(() => window.liveAggregationFixture.settings('foreign-read-next'));
        await intent(cId, true);
        await page.waitForFunction(
          async () => (await window.liveAggregationFixture.settings('state')).pending === 1,
        );
        await intent('model-a', true);
        await page.evaluate(() => window.liveAggregationFixture.settings('release'));
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLInputElement>(
              '[role="switch"][aria-label="启用模型 primary-060"]',
            )?.disabled === true,
        );
        assert.equal(
          await page.getByRole('button', { name: '重新读取提供商与模型配置', exact: true }).count(),
          0,
        );
        await stage('settings-foreign-read-stopped');
        const foreignFailure = await state();
        assert.equal(modelPosts(foreignFailure).length, modelPosts(knownRecovered).length + 1);
        assert.equal(
          await toggle(cId).isChecked(),
          true,
          'applied head was rolled back after a failed continuation',
        );
        assert.equal(
          await toggle('model-a').isChecked(),
          false,
          'foreign continuation drained an unissued tail',
        );
        assert.equal(await toggle(cId).isDisabled(), true);
        const published = foreignFailure.receipts.at(-1)!;
        assert.ok(published.state === 'applied' && 'postReadSet' in published.receipt);
        const foreignRead = foreignFailure.audit
          .filter((entry) => entry.method === 'getModelSettings.return')
          .at(-1)!.input as { readSet: ModelSettingsRequest['expectedReadSet'] };
        assert.notDeepEqual(
          foreignRead.readSet,
          published.receipt.postReadSet,
          'foreign read did not differ from frozen publication proof',
        );
        const foreignRecovered = await recovery('settings-foreign-read-recovered');
        assert.equal(modelPosts(foreignRecovered).length, modelPosts(foreignFailure).length);
        assert.equal(foreignRecovered.maxConcurrentWrites, 1);
        assert.equal(await toggle('model-a').isChecked(), false);
        assert.equal(await toggle(cId).isChecked(), true);
        await intent(cId, false);
        await page.waitForFunction(async () => {
          const snapshot = await window.liveAggregationFixture.settings('state');
          return (
            snapshot.modelSettingsSubmissions.at(-1)?.phase === 'applied' &&
            snapshot.models.find((model) => model.id === 'primary-060')?.enabled === false
          );
        });
        await stage('settings-recovered-new-intent');
        const recoveredNewIntent = await state();
        assert.equal(
          modelPosts(recoveredNewIntent).length,
          modelPosts(foreignRecovered).length + 1,
        );
        assert.equal(
          await toggle('model-a').isChecked(),
          false,
          'automatic recovery replayed discarded tail',
        );
        unifiedVerification = {
          beforeSave,
          queueVerification,
          knownFailure,
          knownRecovered,
          foreignFailure,
          foreignRecovered,
          recoveredNewIntent,
          held,
          providerApplied,
          beforeUnknown,
          unknown,
          reopened,
          lookupHeld,
          confirmed,
          defaultSetup,
          defaultReopened,
          defaultToggleSnapshots,
          beforeDefaultReopen,
          listTop,
          listMiddle,
          listBottom,
          grid,
          secondTop,
          secondBottom,
          primaryPopup,
          shortPopup,
          shortList,
          secondPopup,
          closedCards,
          enabledPending,
          enableFocus: {
            before: beforeEnableFocus,
            pending: pendingEnableFocus,
            applied: appliedEnableFocus,
          },
          enableScroll: {
            viewportBefore: enableScrollBefore,
            settingsBefore: settingsScrollBefore,
            viewportAfter: enableScrollAfter,
          },
        };
      }
      const categoryChecks = [];
      for (const category of ['常规', '提供商与模型', 'MCP', 'Skills', '提供商与模型']) {
        const button = settingsNavigation.getByRole('button', { name: category, exact: true });
        if (category === 'Skills') {
          await button.focus();
          await page.keyboard.press('Space');
        } else await button.click();
        await page
          .locator('.settings-content')
          .getByRole('heading', { name: category, exact: true })
          .waitFor();
        const pressed = await settingsNavigation
          .locator('button[aria-pressed="true"]')
          .allTextContents();
        assert.deepEqual(pressed, [category]);
        await stage(`settings-category-${category}`);
        categoryChecks.push({ category, pressed, keyboard: category === 'Skills' });
      }
      await back.click();
      await page.locator('.desktop-settings-dialog').waitFor({ state: 'hidden' });
      await stage('settings-returned');
      assert.equal(await input.textContent(), draft);
      assert.equal(
        await input.evaluate((node, original) => node === original, originalInput),
        true,
      );
      assert.equal(
        await page
          .locator('.client-panels')
          .evaluate((node, original) => node === original, originalPanels),
        true,
      );
      assert.equal(await page.locator('.client-panels').getAttribute('aria-hidden'), null);
      assert.equal(
        await page.locator('.client-panels').evaluate((node) => node.hasAttribute('inert')),
        false,
      );
      assert.deepEqual(
        await conversationReads(),
        reads,
        'settings navigation reread or switched the conversation',
      );
      await openSettings();
      await stage('settings-reopened');
      assert.equal(
        await page
          .getByRole('button', { name: '提供商与模型', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      );
      await page.getByRole('button', { name: '常规', exact: true }).click();
      await back.focus();
      await page.keyboard.press('Enter');
      await page.locator('.desktop-settings-dialog').waitFor({ state: 'hidden' });
      await stage('settings-keyboard-returned');
      assert.equal(await input.textContent(), draft);
      assert.deepEqual(await conversationReads(), reads);
      if (settingsModels) {
        const beforePreparing = await page.evaluate(
          () => window.liveAggregationFixture.requests.length,
        );
        await newConversation.click();
        const newInput = page.getByRole('textbox', { name: '新对话草稿', exact: true });
        await newInput.waitFor();
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLButtonElement>(
            '[data-model-picker] [data-model-trigger]',
          );
          return node?.textContent === '选择模型' && !node.disabled;
        });
        await newInput.fill('new unsent draft requires an explicit model 雪🙂');
        assert.equal(
          await page.getByRole('button', { name: '发送首条消息', exact: true }).isDisabled(),
          true,
        );
        await newInput.press('Enter');
        await stage('settings-new-conversation-model-unselected');
        const preparingRequests = await page.evaluate(
          (offset) => window.liveAggregationFixture.requests.slice(offset),
          beforePreparing,
        );
        assert.equal(
          preparingRequests.filter((request) => request.method === 'conversation.models.read')
            .length,
          1,
        );
        assert.equal(
          preparingRequests.filter((request) => request.method === 'conversation.send').length,
          0,
        );
        assert.equal(
          preparingRequests.filter((request) =>
            [
              'settings.providers.save',
              'settings.models.enabled',
              'settings.models.default',
            ].includes(request.method),
          ).length,
          0,
        );
        assert.deepEqual(
          await conversationReads(),
          reads,
          'preparing created or selected a Session before sending',
        );
        modelChoiceVerification = {
          ...modelChoiceVerification,
          preparing: '选择模型',
          sendDisabled: true,
          preparingRequests,
          originalDraftNotSubmitted: draft,
        };
      }
      const samples = await page.evaluate(() => window.liveAggregationSamples);
      await cdp.send('Page.stopScreencast');
      assert.deepEqual(errors, []);
      if (settingsModels) {
        for (const phases of [
          ['settings-unified-loaded'],
          ['settings-provider-applied'],
          ['settings-queue-head-held'],
          [
            'settings-queue-own-read-held',
            'settings-queue-flush-held',
            'settings-provider-flush-failing',
            'settings-provider-flush-failed',
            'settings-provider-flush-auto-recovered',
          ],
          ['settings-queue-general-returned', 'settings-queue-drained', 'settings-model-enabled'],
          [
            'settings-default-changed',
            'settings-default-disable-held',
            'settings-default-disabled',
            'settings-default-reenable-held',
            'settings-default-reenabled',
            'settings-model-unknown',
          ],
        ]) {
          const workflow = samples.filter((sample) => phases.includes(sample.phase));
          const rows = workflow[0]!.settings!.models;
          assert.equal(rows.length, 60);
          for (const sample of workflow) {
            assert.deepEqual(
              sample.settings?.models.map((row) => [row.label, row.node]),
              rows.map((row) => [row.label, row.node]),
              `${sample.phase}: model rows duplicated or remounted during refresh`,
            );
            assert.equal(sample.overflow, false, `${sample.phase}: page overflow`);
            if (
              ['settings-queue-own-read-held', 'settings-queue-general-returned'].includes(
                phases[0]!,
              )
            ) {
              assert.equal(
                sample.settings?.focus.inPopup,
                true,
                `${sample.phase}: focus escaped popup`,
              );
              assert.ok(
                ['启用模型 model-b', '启用模型 primary-060'].includes(
                  sample.settings?.focus.label ?? '',
                ),
                `${sample.phase}: normal queue lost checkbox focus`,
              );
              for (const row of sample.settings?.models ?? [])
                if (row.label === '启用模型 model-b' || row.label === '启用模型 primary-060')
                  assert.equal(
                    row.disabled,
                    false,
                    `${sample.phase}: normal queue disabled live controls`,
                  );
            }
          }
        }
        for (const sample of samples) {
          if (
            [
              'settings-queue-starting',
              'settings-queue-head-held',
              'settings-queue-provider-inspect',
              'settings-queue-provider-blocked',
              'settings-queue-detached',
              'settings-queue-own-read-held',
              'settings-queue-flush-held',
              'settings-queue-general-opening',
              'settings-queue-general-read',
              'settings-queue-general-returned',
              'settings-queue-drained',
            ].includes(sample.phase)
          ) {
            assert.equal(
              sample.settings?.recoveryControls ?? 0,
              0,
              `${sample.phase}: unexpected recovery control`,
            );
            assert.equal(
              sample.settings?.errors ?? 0,
              0,
              `${sample.phase}: unexpected configuration error`,
            );
            assert.equal(
              sample.settings?.readOnly ?? false,
              false,
              `${sample.phase}: unexpected readonly configuration`,
            );
          }
          const labels = sample.settings?.models.map((row) => row.label) ?? [];
          assert.equal(new Set(labels).size, labels.length, `${sample.phase}: duplicate model ID`);
          assert.equal(
            sample.settings?.defaultControls ?? 0,
            0,
            `${sample.phase}: default model control reappeared`,
          );
          assert.equal(
            sample.settings?.defaultBadges ?? 0,
            0,
            `${sample.phase}: default badge reappeared`,
          );
          assert.equal(
            sample.settings?.headerRefreshControls ?? 0,
            0,
            `${sample.phase}: header refresh control reappeared`,
          );
        }
      }
      report.cases.push({
        theme,
        width,
        errors,
        screenshotFrames,
        samples,
        verification: {
          normal,
          hover,
          focus,
          navigation,
          navigationHover,
          navigationAlignment,
          categoryChecks,
          modelChoiceVerification,
          unifiedVerification,
          iconChecks,
          preservedDraft: draft,
          conversationReads: reads.length,
          settingsDataCoverage: settingsModels
            ? 'Production Native UI and Main managers with shared anonymous in-memory Client views/receipts; no real Service or keychain persistence.'
            : 'Navigation only: existing Bridge has no settings data reader; null replies exercise the real unavailable state.',
        },
      });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({ theme, width, samples: samples.length, screenshotFrames, errors }),
      );
      await page.close();
      continue;
    }
    if (nativeShell) {
      const allCases = [
        { kind: 'launch', title: '已请求运行', footer: /已受理/, success: false },
        { kind: 'read', title: '已读取输出', footer: /执行中/, success: false },
        { kind: 'wait', title: '等待超时', footer: /等待超时.*命令仍在运行/, success: false },
        { kind: 'stop', title: '已请求停止', footer: /已请求停止.*等待结束/, success: false },
        { kind: 'execute', title: '已运行', footer: /^成功$/, success: true },
        { kind: 'execute-large', title: '已运行', footer: /^成功$/, success: true },
        { kind: 'execute-model-late', title: '已运行', footer: /^成功$/, success: true },
        { kind: 'execute-failed', title: '运行失败', footer: /失败.*退出码 7/, success: false },
        { kind: 'execute-unknown', title: '结果未知', footer: /结果未知/, success: false },
        { kind: 'execute-rejected', title: '运行命令', footer: null, success: false },
        { kind: 'execute-live', title: '已运行', footer: /^成功$/, success: true },
      ] as const;
      const cases = allCases.filter((entry) => !nativeShellCase || entry.kind === nativeShellCase);
      assert.ok(cases.length > 0, 'unknown Native Shell case filter');
      const verified = [];
      const priorNativeSamples: Sample[] = [];
      const priorNativeRequests: Extract<
        NativeToolMessageRequest,
        { method: 'toolMessages.list' }
      >[] = [];
      let coldVerification: unknown;
      const commandTail = async (
        item: ReturnType<typeof page.locator>,
        aggregate: ReturnType<typeof page.locator>,
        phase: string,
      ) => {
        const outer = aggregate.locator('.tool-activity-viewport').first();
        await outer.focus();
        await page.keyboard.press('End');
        await stage(phase);
        const geometry = await item.locator('.shell-command-text').evaluate((node) => {
          const text = node.firstChild!;
          const range = document.createRange();
          const length = text.textContent!.length;
          range.setStart(text, Math.max(0, length - 2));
          range.setEnd(text, length);
          const tail = range.getBoundingClientRect();
          const clip = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
          return {
            tailTop: tail.top,
            tailBottom: tail.bottom,
            clipTop: clip.top,
            clipBottom: clip.bottom,
            whiteSpace: getComputedStyle(node).whiteSpace,
            headerHeight: node.closest('.shell-output-header')!.getBoundingClientRect().height,
          };
        });
        assert.equal(geometry.whiteSpace, 'pre-wrap');
        assert.ok(
          geometry.tailTop >= geometry.clipTop - 1 &&
            geometry.tailBottom <= geometry.clipBottom + 1,
          `full command tail inaccessible in aggregate: ${JSON.stringify(geometry)}`,
        );
        return geometry;
      };
      for (const [index, entry] of cases.entries()) {
        const expected = await page.evaluate((kind) => {
          window.liveAggregationPhase = `native-${kind}-live`;
          return window.liveAggregationFixture.startNativeShell(kind);
        }, entry.kind);
        const aggregate = page.locator('.conversation:visible .tool-activity-aggregate').first();
        await aggregate.waitFor();
        if (
          (await aggregate
            .locator(':scope > .tool-activity-summary')
            .getAttribute('aria-expanded')) === 'false'
        )
          await aggregate.locator(':scope > .tool-activity-summary').click();
        const item = aggregate.locator('.tool-activity-steps > .shell-activity').nth(index);
        await item.waitFor();
        await item.locator(':scope > .tool-activity-summary').click();
        await stage(`native-${entry.kind}-live-open`);
        if (index === 0) {
          const process = page.locator('.agent-turn-summary').first();
          const processNode = await process.elementHandle();
          await defaultIcon('turn disclosure', process.locator('.agent-turn-chevron'), process, {
            height: 32,
          });
          await process.focus();
          await page.keyboard.press('Enter');
          await stage('icons-turn-collapsed');
          assert.equal(await process.getAttribute('aria-expanded'), 'false');
          await page.keyboard.press('Enter');
          await stage('icons-turn-reopened');
          assert.equal(await process.getAttribute('aria-expanded'), 'true');
          assert.ok(await process.evaluate((node, original) => node === original, processNode));
          assert.equal(
            await item.locator(':scope > .tool-activity-summary').getAttribute('aria-expanded'),
            'true',
          );
          const profile = await page.locator('.profile-avatar').evaluate((node) => ({
            width: getComputedStyle(node).width,
            height: getComputedStyle(node).height,
          }));
          assert.deepEqual(
            profile,
            { width: '20px', height: '20px' },
            'special profile icon changed',
          );
          iconChecks.push({ name: 'special profile', graphic: profile });
        }
        const liveNode = await item.elementHandle();
        assert.ok(liveNode);
        const livePhases = [];
        let commandReadingOffset: number | undefined;
        let liveCommandGeometry: unknown;
        if (entry.kind === 'execute-live') {
          const viewportBefore = await item.locator('.shell-output-viewport').elementHandle();
          assert.ok(viewportBefore);
          for (const phase of ['queued', 'auto', 'human', 'running'] as const) {
            if (phase !== 'queued')
              await page.evaluate(
                (phase) => window.liveAggregationFixture.phaseNativeShell('execute-live', phase),
                phase,
              );
            await page.waitForFunction(
              (command) => document.querySelector('.shell-command-text')?.textContent === command,
              expected.command,
            );
            await stage(`native-execute-live-${phase}`);
            const state = await item.evaluate(
              (node, { before, viewportBefore }) => ({
                sameNode: node === before,
                sameViewport: node.querySelector('.shell-output-viewport') === viewportBefore,
                expanded: node
                  .querySelector('.tool-activity-summary')
                  ?.getAttribute('aria-expanded'),
                title: node.querySelector('.tool-activity-title')?.textContent,
                approval:
                  node.querySelector('.tool-approval')?.getAttribute('aria-label') ??
                  node.querySelector('.tool-approval')?.textContent ??
                  '',
                approvalText: node.querySelector('.tool-approval')?.textContent ?? '',
                command: node.querySelector('.shell-command-text')?.textContent,
                headerHeight: node.querySelector('.shell-output-header')?.getBoundingClientRect()
                  .height,
                successChecks: node.querySelectorAll('.shell-result-icon').length,
              }),
              { before: liveNode, viewportBefore },
            );
            assert.ok(
              state.sameNode && state.sameViewport && state.expanded === 'true',
              `live Shell ${phase} replaced or collapsed its card`,
            );
            assert.equal(
              state.command,
              expected.command,
              `live Shell ${phase} lost original Unicode/multiline command`,
            );
            assert.ok(
              state.headerHeight! > 100,
              `live Shell ${phase} did not render original command on multiple lines`,
            );
            assert.equal(state.successChecks, 0, `live Shell ${phase} falsely reported success`);
            if (phase === 'auto') assert.equal(state.approval, '正在自动审批');
            if (phase === 'human') assert.match(state.approval, /等待人工/);
            if (phase === 'running') assert.equal(state.approval, '已人工批准');
            if (phase === 'running') {
              assert.equal(state.approvalText, '', 'approved Shell retained permanent status text');
              const marker = item.locator('.tool-approval-approved');
              const summary = item.locator(':scope > .tool-activity-summary');
              const geometry = async () => ({
                summary: await summary.boundingBox(),
                header: await item.locator('.shell-output-header').boundingBox(),
                marker: await marker.boundingBox(),
              });
              const beforeTooltip = await geometry();
              const icon = await marker.locator('svg').boundingBox();
              assert.equal(icon?.width, 14);
              assert.equal(icon?.height, 14);
              const chevron = await summary.locator('.tool-activity-chevron').boundingBox();
              assert.ok(
                beforeTooltip.marker &&
                  chevron &&
                  beforeTooltip.marker.x + beforeTooltip.marker.width <= chevron.x,
                'approved marker is not between command and chevron',
              );
              const tooltip = page.locator('.tool-approval-tooltip:not([data-state="closed"])');
              await marker.hover();
              await tooltip.waitFor({ state: 'visible' });
              assert.match((await tooltip.textContent()) ?? '', /已人工批准/);
              await stage('native-execute-live-approved-hover');
              assert.deepEqual(
                await geometry(),
                beforeTooltip,
                'approval hover tooltip displaced tool geometry',
              );
              await page.mouse.move(5, 5, { steps: 8 });
              await stage('native-execute-live-approved-pointer-exit');
              await Bun.write(
                path.join(artifact, `${label}-approval-pointer-exit.json`),
                JSON.stringify(
                  await summary.evaluate((node) => ({
                    activeClass: document.activeElement?.className,
                    focusVisible: node.matches(':focus-visible'),
                    hovered: node.matches(':hover'),
                    tooltipOpen: !!document.querySelector(
                      '.tool-approval-tooltip:not([data-state="closed"])',
                    ),
                  })),
                  null,
                  2,
                ),
              );
              await tooltip.waitFor({ state: 'hidden' });
              await summary.focus();
              await page.keyboard.press('Shift+Tab');
              await page.keyboard.press('Tab');
              await tooltip.waitFor({ state: 'visible' });
              assert.ok(
                await summary.evaluate((node) => document.activeElement === node),
                'keyboard did not reach approved tool summary',
              );
              await stage('native-execute-live-approved-keyboard');
              assert.deepEqual(
                await geometry(),
                beforeTooltip,
                'approval focus tooltip displaced tool geometry',
              );
              await page.keyboard.press('Escape');
              await tooltip.waitFor({ state: 'hidden' });
              assert.ok(
                await summary.evaluate((node) => document.activeElement === node),
                'Escape moved focus away from tool summary',
              );
              assert.equal(
                await summary.getAttribute('aria-expanded'),
                'true',
                'approval tooltip changed tool disclosure',
              );
              await stage('native-execute-live-approved-tooltip-closed');
              await page.keyboard.press('Tab');
            }
            const { command: _command, ...readingState } = state;
            livePhases.push({ phase, ...readingState, commandLength: state.command?.length });
          }
          liveCommandGeometry = await commandTail(
            item,
            aggregate,
            'native-execute-live-command-tail',
          );
          const outer = aggregate.locator('.tool-activity-viewport').first();
          await outer.focus();
          await page.keyboard.press('Home');
          await stage('native-execute-live-command-start');
          await page.keyboard.press('PageDown');
          await stage('native-execute-live-command-reading');
          commandReadingOffset = await outer.evaluate((node) => node.scrollTop);
        }
        await page.evaluate((kind) => {
          window.liveAggregationPhase = `native-${kind}-receipt`;
          window.liveAggregationFixture.holdNativeShellMetadata();
          window.liveAggregationFixture.settleNativeShell(kind);
        }, entry.kind);
        await page.waitForFunction(
          () => window.liveAggregationFixture.nativeShellMetadataPending() > 0,
        );
        await stage(`native-${entry.kind}-metadata-pending`);
        const pendingRow = aggregate.locator('.tool-activity-steps > .tool-activity').nth(index);
        const pendingNode = await pendingRow.elementHandle();
        assert.ok(pendingNode);
        const pending = await page.evaluate(
          ({ before, current }) => ({
            sameNode: before === current,
            beforeConnected: before.isConnected,
            className: current.className,
            title: current.querySelector('.tool-activity-title')?.textContent,
            expanded: current
              .querySelector('.tool-activity-summary')
              ?.getAttribute('aria-expanded'),
            card: !!current.querySelector('.shell-output'),
            consoleText: current.querySelector('.shell-console-output')?.textContent ?? '',
            cardText: current.querySelector('.shell-output')?.textContent ?? '',
            command: current.querySelector('.shell-command-text')?.textContent ?? null,
            outerScrollTop: current.closest('.tool-activity-viewport')?.scrollTop,
          }),
          { before: liveNode, current: pendingNode },
        );
        await page.evaluate((kind) => {
          window.liveAggregationPhase = `native-${kind}-metadata-released`;
          window.liveAggregationFixture.releaseNativeShellMetadata();
        }, entry.kind);
        if (entry.kind === 'execute-model-late') {
          await page.waitForFunction(() =>
            document.querySelector('.shell-result')?.textContent?.includes('成功'),
          );
          await page.waitForFunction(
            (command) => document.querySelector('.shell-command-text')?.textContent === command,
            expected.command,
          );
          await stage('native-execute-model-late-authoritative-first-read');
          const lateOutput = item.locator('.shell-output-viewport');
          const originalViewport = await lateOutput.elementHandle();
          assert.ok(originalViewport);
          await aggregate.locator('.tool-activity-viewport').first().focus();
          await page.keyboard.press('End');
          await page.waitForFunction(() => {
            const node = document.querySelector('.tool-activity-viewport');
            return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
          });
          await lateOutput.focus();
          await page.keyboard.press('Home');
          await page.waitForFunction(
            () =>
              (document.querySelector<HTMLElement>('.shell-output-viewport')?.scrollTop ?? 1) <= 1,
          );
          await stage('native-execute-model-late-manual-reading');
          const readLateModel = () =>
            item.evaluate(
              (node, { before, originalViewport }) => ({
                sameNode: node === before,
                beforeConnected: before.isConnected,
                sameViewport: node.querySelector('.shell-output-viewport') === originalViewport,
                scrollTop: node.querySelector('.shell-output-viewport')?.scrollTop ?? 0,
                scrollHeight: node.querySelector('.shell-output-viewport')?.scrollHeight ?? 0,
                viewportHeight: node.querySelector('.shell-output-viewport')?.clientHeight ?? 0,
                title: node.querySelector('.tool-activity-title')?.textContent,
                command: node.querySelector('.shell-command-text')?.textContent ?? null,
                footer: node.querySelector('.shell-result')?.textContent,
                rawVisible:
                  node.querySelector('.shell-output')?.textContent?.includes('"execution"') ??
                  false,
                expanded: node
                  .querySelector('.tool-activity-summary')
                  ?.getAttribute('aria-expanded'),
              }),
              { before: liveNode, originalViewport },
            );
          const beforeModel = await readLateModel();
          const readsBeforeModel = (
            await page.evaluate(() => window.liveAggregationFixture.nativeShellMetadataPages())
          ).length;
          assert.equal(
            beforeModel.command,
            expected.command,
            'exact Tool input waited for Model completion',
          );
          assert.equal(beforeModel.rawVisible, false, 'exact Tool input retained original JSON');
          const completedModel = await page.evaluate(() =>
            window.liveAggregationFixture.completeNativeShellModel('execute-model-late'),
          );
          await stage('native-execute-model-late-model-complete');
          await stage('native-execute-model-late-after-complete');
          const afterModel = await readLateModel();
          const readsAfterModel = (
            await page.evaluate(() => window.liveAggregationFixture.nativeShellMetadataPages())
          ).length;
          await Bun.write(
            path.join(artifact, `${label}-native-late-model.json`),
            JSON.stringify(
              {
                beforeModel,
                afterModel,
                completedModel,
                readsBeforeModel,
                readsAfterModel,
                metadataPages: await page.evaluate(() =>
                  window.liveAggregationFixture.nativeShellMetadataPages(),
                ),
                samples: await page.evaluate(() => window.liveAggregationSamples),
              },
              null,
              2,
            ),
          );
          assert.equal(
            afterModel.command,
            expected.command,
            'Native Shell lost its authoritative command after Model history completed',
          );
          assert.equal(
            readsAfterModel,
            readsBeforeModel,
            'completed matching Model history redownloaded authoritative Tool input',
          );
          assert.ok(
            afterModel.sameNode && afterModel.beforeConnected && afterModel.expanded === 'true',
            'Native Shell Model completion replaced or collapsed the opened tool',
          );
          assert.equal(
            afterModel.rawVisible,
            false,
            'Native Shell retained raw JSON after verification',
          );
          assert.ok(
            afterModel.sameViewport && afterModel.scrollHeight > afterModel.viewportHeight,
            'Native Shell Model completion replaced or lost the scroll viewport',
          );
          assert.equal(
            afterModel.scrollTop,
            beforeModel.scrollTop,
            'Native Shell Model completion displaced manual output reading',
          );
          assert.equal(
            await item.getByRole('button', { name: '回到最新输出', exact: true }).count(),
            0,
          );
          await lateOutput.focus();
          await page.keyboard.press('End');
          await aggregate.locator('.tool-activity-viewport').first().focus();
          await page.keyboard.press('End');
          await stage('native-execute-model-late-latest-output');
        }
        await page.waitForFunction(
          ({ index, title }) =>
            document
              .querySelectorAll('.tool-activity-steps > .shell-activity')
              [index]?.querySelector('.tool-activity-title')?.textContent === title,
          { index, title: entry.title },
        );
        const expanded = await item
          .locator(':scope > .tool-activity-summary')
          .getAttribute('aria-expanded');
        await stage(`native-${entry.kind}-receipt`);
        const settledNode = await item.elementHandle();
        assert.ok(settledNode);
        const handoff = await page.evaluate(
          ({ before, current }) => ({
            sameNode: before === current,
            beforeConnected: before.isConnected,
            className: current.className,
            title: current.querySelector('.tool-activity-title')?.textContent,
            expanded: current
              .querySelector('.tool-activity-summary')
              ?.getAttribute('aria-expanded'),
            card: !!current.querySelector('.shell-output'),
            outerScrollTop: current.closest('.tool-activity-viewport')?.scrollTop,
          }),
          { before: liveNode, current: settledNode },
        );
        await Bun.write(
          path.join(artifact, `${label}-native-${entry.kind}-handoff.json`),
          JSON.stringify(
            { pending, handoff, samples: await page.evaluate(() => window.liveAggregationSamples) },
            null,
            2,
          ),
        );
        assert.ok(
          pending.sameNode && pending.expanded === 'true' && pending.card,
          `Native ${entry.kind} replaced live Shell with original tool reader while metadata was pending: ${JSON.stringify(pending)}`,
        );
        assert.ok(
          !/"(?:ref|execution|accepted)"\s*:/.test(pending.cardText),
          `Native ${entry.kind} leaked receipt JSON while metadata was pending`,
        );
        if (entry.kind === 'execute-live')
          assert.equal(
            pending.command,
            expected.command,
            'live Shell lost command while receipt metadata was pending',
          );
        if (entry.kind === 'execute-live') {
          assert.equal(
            pending.outerScrollTop,
            commandReadingOffset,
            'receipt pending displaced command reading',
          );
          assert.equal(
            handoff.outerScrollTop,
            commandReadingOffset,
            'receipt completion displaced command reading',
          );
        }
        assert.equal(
          expanded,
          'true',
          `Native ${entry.kind} lost live Shell disclosure at receipt handoff`,
        );
        const command = item.locator('.shell-command-text');
        if (expected.command) {
          await page.waitForFunction(
            ({ index, text }) =>
              document
                .querySelectorAll('.tool-activity-steps > .shell-activity')
                [index]?.querySelector('.shell-command-text')?.textContent === text,
            { index, text: expected.command },
          );
          assert.equal(
            await command.textContent(),
            expected.command,
            `Native ${entry.kind} command paging lost bytes`,
          );
        } else
          assert.equal(
            await command.count(),
            0,
            `Native ${entry.kind} invented a command from shellId`,
          );
        const result = item.locator('.shell-result');
        const footer = (await result.count()) ? ((await result.textContent()) ?? '') : '';
        if (entry.footer) assert.match(footer, entry.footer, `Native ${entry.kind} result differs`);
        else
          assert.equal(
            footer,
            '',
            `Native ${entry.kind} invented execution result after approval failure`,
          );
        assert.equal(
          await item.locator('.shell-result-icon').count(),
          entry.success ? 1 : 0,
          `Native ${entry.kind} promoted Tool acceptance to Job success`,
        );
        const output = (await item.locator('.shell-console-output').textContent()) ?? '';
        if (entry.kind === 'read')
          assert.equal(
            output,
            'Native read 原输出\n第二行 👩‍💻\nNative stderr\n',
            'Native read output order/content differs',
          );
        if (entry.kind === 'execute-failed')
          assert.ok(
            output.includes('NATIVE_REAL_FAILURE_REASON'),
            'Native actual failure reason hidden',
          );
        if (entry.kind === 'execute-unknown')
          assert.ok(
            output.includes('NATIVE_OUTCOME_UNKNOWN_REASON'),
            'Native unknown reason hidden',
          );
        if (entry.kind === 'execute-rejected')
          assert.equal(
            output.split('NATIVE_APPROVAL_REJECTION_REASON').length - 1,
            1,
            'Native rejection reason must appear exactly once',
          );
        await stage(`native-${entry.kind}-verified`);
        verified.push({
          livePhases,
          liveCommandGeometry,
          kind: entry.kind,
          pending,
          handoff,
          expanded,
          title: entry.title,
          footer,
          output,
          commandLength: expected.command?.length ?? 0,
          commandBytes: new TextEncoder().encode(expected.command ?? '').length,
          commandSource:
            entry.kind === 'execute-large'
              ? 'exact Tool input with omitted Model calls; ordinary parentExecutionId null'
              : expected.command
                ? 'complete original Model tool call'
                : 'no command proof',
        });
        await item.locator(':scope > .tool-activity-summary').click();
        await page.waitForTimeout(280);
        if (entry.kind === 'execute-live') {
          priorNativeSamples.push(...(await page.evaluate(() => window.liveAggregationSamples)));
          priorNativeRequests.push(
            ...(await page.evaluate(() =>
              window.liveAggregationFixture.requests.filter(
                (request) => request.method === 'toolMessages.list',
              ),
            )),
          );
          await page.goto(`${server.url}?cold-shell=execute-live`);
          await page.getByRole('button', { name: 'Session A', exact: true }).click();
          const coldProcess = page.locator('.agent-turn-summary').first();
          await coldProcess.waitFor();
          if ((await coldProcess.getAttribute('aria-expanded')) === 'false')
            await coldProcess.click();
          const coldAggregate = page
            .locator('.conversation:visible .tool-activity-aggregate')
            .first();
          await coldAggregate.waitFor();
          if (
            (await coldAggregate
              .locator(':scope > .tool-activity-summary')
              .getAttribute('aria-expanded')) === 'false'
          )
            await coldAggregate.locator(':scope > .tool-activity-summary').click();
          const coldItem = coldAggregate.locator('.shell-activity').first();
          await coldItem.waitFor();
          if (
            (await coldItem
              .locator(':scope > .tool-activity-summary')
              .getAttribute('aria-expanded')) === 'false'
          )
            await coldItem.locator(':scope > .tool-activity-summary').click();
          await page.waitForFunction(
            (command) => document.querySelector('.shell-command-text')?.textContent === command,
            expected.command,
          );
          await stage('native-execute-live-cold-command-start');
          const coldCommandGeometry = await commandTail(
            coldItem,
            coldAggregate,
            'native-execute-live-cold-command-tail',
          );
          await stage('native-execute-live-cold-reopened');
          const coldState = await coldItem.evaluate((node) => ({
            title: node.querySelector('.tool-activity-title')?.textContent,
            command: node.querySelector('.shell-command-text')?.textContent,
            output: node.querySelector('.shell-console-output')?.textContent,
            footer: node.querySelector('.shell-result')?.textContent,
            successChecks: node.querySelectorAll('.shell-result-icon').length,
            expanded: node.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded'),
          }));
          const coldRequests = await page.evaluate(() =>
            window.liveAggregationFixture.requests.filter(
              (request) => request.method === 'toolMessages.list',
            ),
          );
          assert.equal(
            coldState.command,
            expected.command,
            'cold completed session failed to restore command',
          );
          assert.equal(coldState.title, '已运行');
          assert.match(coldState.footer ?? '', /^成功$/);
          assert.equal(coldState.successChecks, 1);
          assert.ok(
            coldRequests.every((request) => !request.executionIds?.length),
            'cold completed session relied on a live View Tool',
          );
          coldVerification = {
            commandGeometry: coldCommandGeometry,
            state: coldState,
            requests: coldRequests,
            metadataPages: await page.evaluate(() =>
              window.liveAggregationFixture.nativeShellMetadataPages(),
            ),
          };
        }
      }
      const permissionTrigger = page.locator('.composer [data-permission-trigger]');
      await defaultIcon(
        'permission trigger',
        permissionTrigger.locator(':scope > svg[data-icon="inline-start"]'),
        permissionTrigger,
        { height: 28 },
      );
      await defaultIcon(
        'permission disclosure',
        permissionTrigger.locator(':scope > svg[data-icon="inline-end"]'),
        permissionTrigger,
        { height: 28 },
      );
      await permissionTrigger.click();
      const permissionMenu = page.getByRole('menu');
      await permissionMenu.waitFor();
      const modes = permissionMenu.locator('[role="menuitemradio"]');
      assert.equal(await modes.count(), 3);
      for (let index = 0; index < 3; index++)
        await defaultIcon(
          `permission menu ${index}`,
          modes.nth(index).locator(':scope > svg'),
          modes.nth(index),
          { minHeight: 28 },
        );
      await stage('icons-permission-menu');
      await page.keyboard.press('Escape');
      await permissionMenu.waitFor({ state: 'hidden' });
      const requests = [
        ...priorNativeRequests,
        ...(await page.evaluate(() =>
          window.liveAggregationFixture.requests.filter(
            (request) => request.method === 'toolMessages.list',
          ),
        )),
      ];
      if (cases.some((entry) => entry.kind === 'execute-live'))
        assert.ok(
          requests.some(
            (request) =>
              (request.commandOffsets?.['native-execution:native-shell-execute-live'] ?? 0) > 0,
          ),
          'live original command did not cross real Main reader paging boundary',
        );
      if (cases.some((entry) => entry.kind === 'execute'))
        assert.ok(
          requests.some(
            (request) =>
              request.method === 'toolMessages.list' &&
              (request.commandOffsets?.['receipt-native-shell-execute'] ?? 0) > 0,
          ),
          'Native command did not cross actual Main paging boundary',
        );
      if (cases.some((entry) => entry.kind === 'execute-large'))
        assert.ok(
          requests.some(
            (request) =>
              request.method === 'toolMessages.list' &&
              (request.commandOffsets?.['receipt-native-shell-execute-large'] ?? 0) > 0,
          ),
          'large Native command did not page from exact Tool input',
        );
      const samples = [
        ...priorNativeSamples,
        ...(await page.evaluate(() => window.liveAggregationSamples)),
      ];
      await cdp.send('Page.stopScreencast');
      report.cases.push({
        theme,
        width,
        errors,
        screenshotFrames,
        samples,
        verification: { verified, requests, coldVerification, iconChecks },
      });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      assert.deepEqual(errors, [], 'Native Shell page errors');
      assert.ok(
        samples.every(
          (sample) => !sample.overflow && !sample.conversationOverflow && !sample.nestedButtons,
        ),
        'Native Shell overflow or nested button',
      );
      for (const checkedKind of ['execute-live', 'execute-model-late'] as const) {
        if (!cases.some((entry) => entry.kind === checkedKind)) continue;
        const expectedLength: number = verified.find(
          (entry) => entry.kind === checkedKind,
        )!.commandLength;
        for (const sample of samples) {
          if (
            checkedKind === 'execute-model-late' &&
            ![
              'native-execute-model-late-authoritative-first-read',
              'native-execute-model-late-manual-reading',
              'native-execute-model-late-model-complete',
              'native-execute-model-late-after-complete',
              'native-execute-model-late-latest-output',
            ].includes(sample.phase)
          )
            continue;
          if (
            !sample.phase.startsWith(`native-${checkedKind}-`) ||
            ['native-execute-live-live', 'native-execute-live-live-open'].includes(sample.phase)
          )
            continue;
          for (const shell of sample.shells.filter((shell) => shell.expanded)) {
            assert.equal(
              shell.commandLength,
              expectedLength,
              `live command briefly disappeared during ${sample.phase}/${sample.cause}`,
            );
            assert.ok(
              shell.headerBox && shell.headerBox[2]! > 40 && shell.headerBox[3]! > 0,
              `live command Header briefly vanished during ${sample.phase}/${sample.cause}`,
            );
          }
        }
      }
      console.log(
        JSON.stringify({
          nativeShell,
          theme,
          width,
          samples: samples.length,
          screenshotFrames,
          verified: verified.map(({ kind, title, footer, commandLength }) => ({
            kind,
            title,
            footer,
            commandLength,
          })),
          errors,
        }),
      );
      await page.close();
      continue;
    }
    if (toolDetails) {
      const inspectFade = (scroll: ReturnType<typeof page.locator>) =>
        scroll.evaluate((node) => {
          const style = getComputedStyle(node);
          const length = (value: string) => {
            const probe = document.createElement('span');
            probe.style.cssText =
              'position:absolute;visibility:hidden;pointer-events:none;width:1px;top:0';
            probe.style.height = value;
            node.append(probe);
            const pixels = probe.getBoundingClientRect().height;
            probe.remove();
            return pixels;
          };
          return {
            top: length(style.getPropertyValue('--scroll-fade-t')),
            bottom: length(style.getPropertyValue('--scroll-fade-b')),
            mask: style.maskImage,
            slot: node.getAttribute('data-slot'),
          };
        });
      const shell = page.locator('.conversation .shell-activity').first();
      await shell.locator(':scope > .tool-activity-summary').click();
      const output = shell.getByRole('region', { name: 'Shell 执行输出', exact: true });
      await output.waitFor();
      await stage('island-shell-open');
      const shellSummary = shell.locator(':scope > .tool-activity-summary');
      await defaultIcon(
        'tool disclosure',
        shellSummary.locator('.tool-activity-chevron'),
        shellSummary,
        { height: 32 },
      );
      await defaultIcon(
        'tool marker',
        shellSummary.locator('.tool-activity-kind-icon'),
        shellSummary,
        { height: 32 },
      );
      const copyHit = shell.locator('.shell-output-header [data-slot="code-block-copy-button"]');
      await defaultIcon('Shell copy', copyHit.locator('svg'), copyHit, { width: 24, height: 24 });
      const sendHit = page.locator('.composer-action').first();
      await defaultIcon('composer action', sendHit.locator(':scope > svg'), sendHit, {
        width: 32,
        height: 32,
      });
      assert.equal(
        await output.locator('.shell-command-text').count(),
        0,
        'Shell command remained inside the scrolling output',
      );
      const commandHeader = shell.locator('.shell-output-header');
      const headerBorder = await commandHeader.evaluate(
        (node) => getComputedStyle(node).borderBottomWidth,
      );
      assert.equal(headerBorder, '0px', 'Shell Header retained an internal bottom border');
      const headerBeforeScroll = await commandHeader.boundingBox();
      assert.ok(
        headerBeforeScroll && headerBeforeScroll.height > 60,
        'Shell original multiline command was collapsed into a summary',
      );
      const readStandaloneGeometry = () =>
        shell.evaluate((node) => {
          const measure = (element: Element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              tag: element.tagName,
              className: element.className,
              box: [box.x, box.y, box.width, box.height],
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              minWidth: style.minWidth,
              width: style.width,
              overflowX: style.overflowX,
              display: style.display,
              inlineStyle: element.getAttribute('style'),
            };
          };
          const ancestors = [];
          for (let current: Element | null = node; current; current = current.parentElement)
            ancestors.push(measure(current));
          return {
            ancestors,
            row: measure(node.querySelector(':scope > .tool-activity-summary')!),
            card: measure(node.querySelector('.shell-output')!),
            chevron: measure(node.querySelector('.tool-activity-chevron')!),
            clip: measure(node.closest('.conversation-viewport')!),
            viewportWidth: innerWidth,
          };
        });
      const standaloneGeometry = await readStandaloneGeometry();
      assert.equal(
        standaloneGeometry.card.box[2],
        width === 1280 ? 740 : 529,
        'icon change shrank Shell card',
      );
      assert.equal(headerBeforeScroll?.height, 118, 'icon change shrank multiline Header');
      await Bun.write(
        path.join(artifact, `${theme}-${width}-standalone-shell-geometry.json`),
        JSON.stringify(standaloneGeometry, null, 2),
      );
      for (const [name, geometry] of Object.entries({
        row: standaloneGeometry.row,
        card: standaloneGeometry.card,
        chevron: standaloneGeometry.chevron,
      })) {
        const [x, , width] = geometry.box;
        const [clipX, , clipWidth] = standaloneGeometry.clip.box;
        assert.ok(
          x! >= clipX! - 1 && x! + width! <= clipX! + clipWidth! + 1,
          `standalone Shell ${name} clipped by conversation viewport: ${JSON.stringify(standaloneGeometry)}`,
        );
      }
      const readScroll = () =>
        output.evaluate((node) => ({
          top: node.scrollTop,
          height: node.clientHeight,
          total: node.scrollHeight,
          left: node.scrollLeft,
          width: node.clientWidth,
          wide: node.scrollWidth,
          slot: node.getAttribute('data-slot'),
        }));
      const initial = await readScroll();
      const initialFade = await inspectFade(output);
      assert.equal(initial.slot, 'scroll-area-viewport', 'Shell retained the pre as scroll owner');
      assert.ok(
        initial.height <= 256.5 && initial.total > initial.height,
        'Shell viewport cap or scroll range differs',
      );
      assert.ok(
        initial.total - initial.height - initial.top <= 1,
        'Shell did not initially follow latest output',
      );
      assert.ok(
        initialFade.mask !== 'none' && initialFade.top > 0 && initialFade.bottom === 0,
        'Shell initial fade did not match latest position',
      );
      await stage('island-shell-append', () => window.toolScrollIsland.appendShell());
      const appended = await readScroll();
      assert.ok(
        appended.total > initial.total && appended.total - appended.height - appended.top <= 1,
        'Shell appended output did not follow actual viewport',
      );
      await output.focus();
      await page.keyboard.press('PageUp');
      await stage('island-shell-middle');
      const middleFade = await inspectFade(output);
      assert.ok(middleFade.top > 0 && middleFade.bottom > 0, 'Shell middle fade differs');
      await output.focus();
      await page.keyboard.press('Home');
      assert.equal(
        await shell.getByRole('button', { name: '回到最新输出', exact: true }).count(),
        0,
      );
      await page.waitForFunction(
        () => (document.querySelector<HTMLElement>('.shell-output-viewport')?.scrollTop ?? 1) <= 1,
      );
      const paused = await readScroll();
      const pausedFade = await inspectFade(output);
      assert.deepEqual(
        await commandHeader.boundingBox(),
        headerBeforeScroll,
        'Shell output scrolling displaced the fixed command header',
      );
      assert.ok(pausedFade.top === 0 && pausedFade.bottom > 0, 'Shell manual top fade differs');
      await stage('island-shell-paused-append', () => window.toolScrollIsland.appendShell());
      assert.equal(
        (await readScroll()).top,
        paused.top,
        'Shell append displaced manual reading position',
      );
      await output.focus();
      await page.keyboard.press('End');
      await stage('island-shell-latest');
      await stage('island-shell-resumed-append', () => window.toolScrollIsland.appendShell());
      const latest = await readScroll();
      const latestFade = await inspectFade(output);
      assert.deepEqual(
        await commandHeader.boundingBox(),
        headerBeforeScroll,
        'Shell return to latest displaced the fixed command header',
      );
      assert.ok(
        latest.total - latest.height - latest.top <= 1,
        'Shell latest action did not scroll viewport',
      );
      assert.ok(latestFade.top > 0 && latestFade.bottom === 0, 'Shell latest fade state differs');
      assert.equal(
        await output.locator('pre').getAttribute('tabindex'),
        '-1',
        'inner Shell pre remained a separate keyboard scroll stop',
      );
      const expectedShell = await page.evaluate(() => window.toolScrollIsland.shellText());
      assert.equal(
        await output.locator('.shell-console-output').textContent(),
        expectedShell,
        'Shell output lost bytes',
      );
      const expectedCommand = await page.evaluate(() => window.toolScrollIsland.commandText());
      assert.equal(
        await shell.locator('.shell-command-text').textContent(),
        expectedCommand,
        'multiline Shell command changed',
      );
      assert.equal(
        await commandHeader.locator('.shell-command-text').textContent(),
        expectedCommand,
        'fixed Shell header lost the original command',
      );
      const copyCommand = commandHeader.getByRole('button', { name: '复制代码', exact: true });
      assert.equal(await copyCommand.count(), 1, 'full Shell command has no copy action');
      await copyCommand.isEnabled().then((enabled) => assert.ok(enabled));
      await stage('island-standalone-success', () =>
        window.toolScrollIsland.shellScenario('execute-success'),
      );
      await page.evaluate(() => window.toolScrollIsland.shellScenario('execute-running'));
      const diffItem = page
        .locator('.conversation .tool-activity')
        .filter({ has: page.getByText('fixture-diff.ts', { exact: true }) })
        .first();
      await diffItem
        .getByRole('button', { name: '展开 fixture-diff.ts 的差异', exact: true })
        .click();
      const diff = diffItem.getByRole('region', { name: '文件差异', exact: true });
      await diff.waitFor();
      const expectedDiff = await page.evaluate(() => window.toolScrollIsland.diffText());
      assert.equal(
        await diff.locator('pre').textContent(),
        `${expectedDiff}\n`,
        'diff full content changed',
      );
      const diffInitial = await diff.evaluate((node) => ({
        width: node.clientWidth,
        wide: node.scrollWidth,
        height: node.clientHeight,
        total: node.scrollHeight,
        slot: node.getAttribute('data-slot'),
      }));
      assert.equal(diffInitial.slot, 'scroll-area-viewport');
      assert.ok(
        diffInitial.wide > diffInitial.width && diffInitial.total > diffInitial.height,
        'diff did not expose both scroll axes',
      );
      await diff.hover({ position: { x: 30, y: 20 } });
      await page.mouse.wheel(180, 110);
      await page.waitForTimeout(150);
      const diffWheel = await diff.evaluate((node) => ({
        left: node.scrollLeft,
        top: node.scrollTop,
      }));
      assert.ok(diffWheel.left > 0 && diffWheel.top > 0, 'diff wheel did not move both axes');
      await diffItem.locator('.tool-diff-scroll').hover();
      const horizontalThumb = diffItem.locator(
        '.tool-diff-scroll > [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"] [data-slot="scroll-area-thumb"]',
      );
      await horizontalThumb.waitFor({ state: 'visible' });
      const thumb = await horizontalThumb.boundingBox();
      assert.ok(thumb);
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
      await page.mouse.down();
      await page.mouse.move(thumb.x + thumb.width / 2 + 60, thumb.y + thumb.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
      const diffDragged = await diff.evaluate((node) => node.scrollLeft);
      assert.ok(diffDragged > diffWheel.left, 'diff horizontal thumb did not scroll viewport');
      await diff.focus();
      await page.keyboard.press('End');
      await stage('island-diff-end');
      const diffEnd = await diff.evaluate((node) => ({
        top: node.scrollTop,
        height: node.clientHeight,
        total: node.scrollHeight,
      }));
      assert.ok(
        diffEnd.total - diffEnd.height - diffEnd.top <= 1,
        'diff keyboard End did not reach full tail',
      );
      const diffEndFade = await inspectFade(diff);
      assert.ok(diffEndFade.top > 0 && diffEndFade.bottom === 0, 'diff end fade differs');
      await stage('island-grouped', () => window.toolScrollIsland.groupTools());
      const aggregate = page.locator('.conversation .tool-activity-aggregate').first();
      await aggregate.locator(':scope > .tool-activity-summary').click();
      await stage('island-icon-aggregate-open');
      await defaultIcon(
        'aggregate disclosure',
        aggregate.locator(':scope > .tool-activity-summary .tool-activity-chevron'),
        aggregate.locator(':scope > .tool-activity-summary'),
        { height: 32 },
      );
      await defaultIcon(
        'aggregate marker',
        aggregate.locator(':scope > .tool-activity-summary .tool-activity-kind-icon'),
        aggregate.locator(':scope > .tool-activity-summary'),
        { height: 32 },
      );
      const nestedShell = aggregate.locator('.shell-activity').first();
      await nestedShell.locator(':scope > .tool-activity-summary').click();
      const nestedOutput = nestedShell.getByRole('region', { name: 'Shell 执行输出', exact: true });
      await stage('island-group-shell-open');
      const groupViewport = aggregate.locator('.tool-activity-viewport').first();
      await groupViewport.focus();
      await page.keyboard.press('Home');
      await stage('island-group-fade-top');
      const groupTopFade = await inspectFade(groupViewport);
      assert.ok(groupTopFade.top === 0 && groupTopFade.bottom > 0, 'aggregate top fade differs');
      await groupViewport.evaluate((node) => {
        node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
      });
      await stage('island-group-fade-middle');
      const groupMiddleFade = await inspectFade(groupViewport);
      assert.ok(
        groupMiddleFade.top > 0 && groupMiddleFade.bottom > 0,
        'aggregate middle fade differs',
      );
      await aggregate.locator('.tool-activity-viewport').first().focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => {
        const node = document.querySelector('.tool-activity-viewport');
        return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
      });
      await stage('island-group-fade-end');
      const groupEndFade = await inspectFade(groupViewport);
      assert.ok(groupEndFade.top > 0 && groupEndFade.bottom === 0, 'aggregate end fade differs');
      await nestedOutput.focus();
      await page.keyboard.press('End');
      await stage('island-group-shell-inner-end');
      await aggregate.locator('.tool-activity-viewport').first().focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => {
        const node = document.querySelector('.tool-activity-viewport');
        return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
      });
      await stage('island-group-shell-tail');
      const nestedGeometry = await nestedOutput.evaluate((node) => {
        const inner = node.getBoundingClientRect(),
          outer = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
        const pre = node.querySelector('pre')!;
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode()!,
          next = walker.nextNode();
        while (next) {
          if (next.textContent?.trim()) text = next;
          next = walker.nextNode();
        }
        const length = text.textContent?.length ?? 0;
        const range = document.createRange();
        range.setStart(text, Math.max(0, length - 20));
        range.setEnd(text, length);
        const tail = range.getBoundingClientRect();
        return {
          height: inner.height,
          outerHeight: outer.height,
          tailTop: tail.top,
          tailBottom: tail.bottom,
          visibleTop: Math.max(inner.top, outer.top),
          visibleBottom: Math.min(inner.bottom, outer.bottom),
          aggregateHeight: node.closest('.tool-activity-aggregate')!.getBoundingClientRect().height,
        };
      });
      assert.ok(nestedGeometry.aggregateHeight <= 400.5, 'nested Shell exceeded aggregate cap');
      assert.ok(
        nestedGeometry.tailTop >= nestedGeometry.visibleTop - 1 &&
          nestedGeometry.tailBottom <= nestedGeometry.visibleBottom + 1,
        `nested Shell tail clipped ${JSON.stringify(nestedGeometry)}`,
      );
      await nestedShell.locator(':scope > .tool-activity-summary').click();
      const nestedDiffItem = aggregate
        .locator('.tool-activity')
        .filter({ has: page.getByText('fixture-diff.ts', { exact: true }) })
        .first();
      await nestedDiffItem
        .getByRole('button', { name: '展开 fixture-diff.ts 的差异', exact: true })
        .click();
      const nestedDiff = nestedDiffItem.getByRole('region', { name: '文件差异', exact: true });
      await nestedDiff.focus();
      await page.keyboard.press('End');
      await stage('island-group-diff-tail');
      const nestedDiffGeometry = await nestedDiff.evaluate((node) => {
        const box = node.getBoundingClientRect(),
          outer = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && !text.textContent?.includes('DIFF_FULL_END')) text = walker.nextNode();
        if (!text) throw Error('fixture_nested_diff_tail_missing');
        const start = text.textContent!.indexOf('DIFF_FULL_END'),
          range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 'DIFF_FULL_END'.length);
        const tail = range.getBoundingClientRect();
        return {
          height: box.height,
          tailTop: tail.top,
          tailBottom: tail.bottom,
          visibleTop: Math.max(box.top, outer.top),
          visibleBottom: Math.min(box.bottom, outer.bottom),
          aggregateHeight: node.closest('.tool-activity-aggregate')!.getBoundingClientRect().height,
        };
      });
      assert.ok(
        nestedDiffGeometry.aggregateHeight <= 400.5 &&
          nestedDiffGeometry.tailTop >= nestedDiffGeometry.visibleTop - 1 &&
          nestedDiffGeometry.tailBottom <= nestedDiffGeometry.visibleBottom + 1,
        `nested diff tail clipped ${JSON.stringify(nestedDiffGeometry)}`,
      );
      const shellMatrix = [];
      await nestedDiffItem
        .getByRole('button', { name: '收起 fixture-diff.ts 的差异', exact: true })
        .click();
      const cases = [
        { scenario: 'execute-running', title: '运行中', footer: /执行中/, success: false },
        { scenario: 'execute-success', title: '已运行', footer: /^成功$/, success: true },
        { scenario: 'execute-failed', title: '运行失败', footer: /失败.*退出码 7/, success: false },
        { scenario: 'execute-unknown', title: '结果未知', footer: /结果未知/, success: false },
        { scenario: 'execute-rejected', title: '运行命令', footer: null, success: false },
        { scenario: 'launch-accepted', title: '已请求运行', footer: /已受理/, success: false },
        { scenario: 'launch-running', title: '已请求运行', footer: /执行中/, success: false },
        { scenario: 'read-running', title: '已读取输出', footer: /执行中/, success: false },
        {
          scenario: 'wait-timeout',
          title: '等待超时',
          footer: /等待超时.*命令仍在运行/,
          success: false,
        },
        {
          scenario: 'stop-requested',
          title: '已请求停止',
          footer: /已请求停止.*等待结束/,
          success: false,
        },
        { scenario: 'legacy-success', title: '已运行', footer: /^成功$/, success: true },
      ] as const;
      const matrixShell = aggregate.locator('.shell-activity').first();
      await matrixShell.locator(':scope > .tool-activity-summary').click();
      for (const entry of cases) {
        await page.evaluate((scenario) => {
          window.liveAggregationPhase = `island-state-${scenario}`;
          window.toolScrollIsland.shellScenario(scenario);
        }, entry.scenario);
        await page.waitForTimeout(80);
        const title = await matrixShell
          .locator(':scope > .tool-activity-summary .tool-activity-title')
          .textContent();
        assert.equal(title, entry.title, `Shell ${entry.scenario} title differs`);
        const result = matrixShell.locator('.shell-result');
        const footer = (await result.count()) ? ((await result.textContent()) ?? '') : '';
        if (entry.footer)
          assert.match(footer, entry.footer, `Shell ${entry.scenario} result differs`);
        else assert.equal(footer, '', `Shell ${entry.scenario} invented an execution result`);
        assert.equal(
          await matrixShell.locator('.shell-result-icon').count(),
          entry.success ? 1 : 0,
          `Shell ${entry.scenario} used an unqualified success check`,
        );
        await aggregate.locator('.tool-activity-viewport').first().focus();
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
          const node = document.querySelector('.tool-activity-viewport');
          return !!node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        });
        const geometry = await matrixShell.evaluate((node) => {
          const card = node.querySelector('.shell-output')!.getBoundingClientRect();
          const result = node.querySelector('.shell-result');
          const box = result?.getBoundingClientRect();
          const clip = node.closest('.tool-activity-viewport')?.getBoundingClientRect();
          return {
            card: [card.x, card.y, card.width, card.height],
            footer: box ? [box.x, box.y, box.width, box.height] : null,
            fontSize: result ? getComputedStyle(result).fontSize : null,
            clip: clip ? [clip.x, clip.y, clip.width, clip.height] : null,
          };
        });
        if (geometry.footer) {
          const [x, y, w, h] = geometry.footer,
            [cx, cy, cw, ch] = geometry.card;
          assert.ok(
            x! >= cx! + cw! / 2 && y! + h! <= cy! + ch! + 1 && x! + w! <= cx! + cw! + 1,
            `Shell ${entry.scenario} status is not at card bottom right`,
          );
          assert.equal(geometry.fontSize, '13px', 'Shell footer auxiliary text differs');
          if (geometry.clip) {
            const [, clipY, , clipHeight] = geometry.clip;
            assert.ok(
              y! >= clipY! - 1 && y! + h! <= clipY! + clipHeight! + 1,
              `Shell ${entry.scenario} footer clipped by aggregate viewport`,
            );
          }
        }
        assert.equal(
          await matrixShell.locator('.shell-command-text').textContent(),
          expectedCommand,
          `Shell ${entry.scenario} lost command bytes`,
        );
        if (entry.scenario === 'execute-rejected') {
          const summary = matrixShell.locator(':scope > .tool-activity-summary');
          const marker = summary.locator('.tool-approval-rejected');
          const reason = 'SHELL_APPROVAL_REJECTION_REASON';
          await summary.scrollIntoViewIfNeeded();
          await summary.click();
          assert.equal(await summary.getAttribute('aria-expanded'), 'false');
          await matrixShell.locator('.shell-output').waitFor({ state: 'hidden' });
          assert.equal(await marker.textContent(), '', 'rejection kept permanent status text');
          assert.equal(await marker.getAttribute('aria-label'), '自动审批未通过');
          assert.equal(await marker.getAttribute('tabindex'), null, 'nested approval tabstop');
          assert.ok(
            !(await matrixShell.textContent())?.includes(reason),
            'collapsed reason leaked',
          );
          const appearance = await marker.evaluate((node) => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--attention-foreground)';
            node.append(probe);
            const warning = getComputedStyle(probe).color;
            probe.remove();
            const icon = node.querySelector('svg')!.getBoundingClientRect();
            return {
              color: getComputedStyle(node).color,
              warning,
              opacity: getComputedStyle(node).opacity,
              width: icon.width,
              height: icon.height,
            };
          });
          assert.equal(appearance.color, appearance.warning, 'rejection is not warning colored');
          assert.equal(appearance.opacity, '1');
          assert.equal(appearance.width, 14);
          assert.equal(appearance.height, 14);
          const before = await summary.boundingBox();
          const tooltip = page.locator('.tool-approval-tooltip:not([data-state="closed"])');
          await marker.hover();
          await tooltip.waitFor({ state: 'visible' });
          assert.ok((await tooltip.textContent())?.includes('自动审批未通过'));
          assert.ok(!(await tooltip.textContent())?.includes(reason), 'reason leaked into tooltip');
          assert.deepEqual(await summary.boundingBox(), before, 'rejection tooltip shifted row');
          await stage('island-rejection-hover');
          await page.mouse.move(5, 5, { steps: 8 });
          await tooltip.waitFor({ state: 'hidden' });
          await summary.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await tooltip.waitFor({ state: 'visible' });
          await stage('island-rejection-keyboard');
          await page.keyboard.press('Escape');
          await tooltip.waitFor({ state: 'hidden' });
          assert.equal(await summary.getAttribute('aria-expanded'), 'false');
          await summary.click();
          assert.equal(await summary.getAttribute('aria-expanded'), 'true');
          assert.equal(
            await matrixShell.locator('.shell-console-output').textContent(),
            reason,
            'expanded rejection did not retain its complete reason',
          );
        }
        await stage(`island-state-${entry.scenario}`);
        shellMatrix.push({ scenario: entry.scenario, title, footer, geometry });
      }
      const samples = await page.evaluate(() => window.liveAggregationSamples);
      await cdp.send('Page.stopScreencast');
      report.cases.push({
        theme,
        width,
        errors,
        screenshotFrames,
        samples,
        verification: {
          iconChecks,
          standaloneGeometry,
          headerBeforeScroll,
          headerBorder,
          initial,
          initialFade,
          appended,
          middleFade,
          paused,
          pausedFade,
          latest,
          latestFade,
          diffInitial,
          diffWheel,
          diffDragged,
          diffEnd,
          diffEndFade,
          nestedGeometry,
          groupTopFade,
          groupMiddleFade,
          groupEndFade,
          nestedDiffGeometry,
          shellMatrix,
        },
      });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      assert.deepEqual(errors, [], 'tool island page errors');
      for (const sample of samples) {
        assert.equal(sample.overflow, false, 'tool island overflowed page');
        assert.equal(sample.conversationOverflow, false, 'tool island overflowed conversation');
        assert.equal(sample.nestedButtons, 0, 'tool island nested buttons');
      }
      console.log(
        JSON.stringify({
          toolDetails,
          theme,
          width,
          samples: samples.length,
          screenshotFrames,
          nestedGeometry,
          errors,
        }),
      );
      await page.close();
      continue;
    }
    if (longGroup) {
      const detail = await page.evaluate(() => {
        window.liveAggregationPhase = 'long-receipts';
        return window.liveAggregationFixture.longGroup();
      });
      await page.waitForFunction(() => window.liveAggregationFixture.pending() > 0);
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.evaluate(() => window.liveAggregationFixture.flush());
        await page.waitForTimeout(35);
      }
      const aggregate = page.locator('.conversation:visible .tool-activity-aggregate').first();
      const summary = aggregate.locator(':scope > .tool-activity-summary');
      await stage('long-collapsed');
      assert.equal(
        (await summary.textContent())?.trim(),
        (await summary.locator('.tool-activity-title').textContent())?.trim(),
        'aggregate title appended summary text',
      );
      assert.ok(
        !(await aggregate.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'collapsed group leaked failure reason',
      );
      assert.ok(
        !(await aggregate.textContent())?.includes('APPROVAL_REJECTION_START'),
        'collapsed group leaked approval reason',
      );
      await summary.click();
      const viewport = aggregate.locator(
        '.tool-activity-viewport[role="region"][aria-label="工具执行明细"]',
      );
      const steps = viewport.locator('.tool-activity-steps');
      await viewport.waitFor();
      await stage('long-expanded');
      assert.equal(await steps.locator(':scope > *').count(), 36, 'long group omitted tools');
      assert.ok(
        !(await steps.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'expanded aggregate leaked unopened failure reason',
      );
      assert.ok(
        !(await steps.textContent())?.includes('APPROVAL_REJECTION_START'),
        'expanded aggregate leaked unopened approval reason',
      );
      const initial = await aggregate.evaluate((node) => {
        const scroll = node.querySelector<HTMLElement>('.tool-activity-viewport')!;
        const list = node.querySelector<HTMLElement>('.tool-activity-steps')!;
        const header = node.querySelector('.tool-activity-summary')!.getBoundingClientRect();
        return {
          height: node.getBoundingClientRect().height,
          clientHeight: scroll.clientHeight,
          scrollHeight: scroll.scrollHeight,
          rowGap: getComputedStyle(list).rowGap,
          tabIndex: scroll.tabIndex,
          header: [header.x, header.y, header.width, header.height],
          viewportTop: node.closest('.conversation-viewport')?.scrollTop,
          footer: [...document.querySelectorAll('.conversation-footer')]
            .find((item) => item.getBoundingClientRect().height > 0)
            ?.getBoundingClientRect()
            .toJSON(),
        };
      });
      assert.ok(
        initial.height <= 400.5 && initial.height >= 399,
        'expanded aggregate did not respect the 400px cap',
      );
      assert.ok(
        initial.scrollHeight > initial.clientHeight,
        'long details did not overflow internally',
      );
      assert.equal(initial.tabIndex, 0, 'details are not keyboard focusable');
      assert.equal(initial.rowGap, '0px', 'aggregate tool rows did not respect the zero gap');
      const fadeState = (scroll: typeof viewport) =>
        scroll.evaluate((node) => {
          const style = getComputedStyle(node);
          const usedLength = (value: string) => {
            const probe = document.createElement('span');
            probe.style.cssText =
              'position:absolute;visibility:hidden;pointer-events:none;width:1px;top:0';
            probe.style.height = value;
            node.append(probe);
            const pixels = probe.getBoundingClientRect().height;
            probe.remove();
            return pixels;
          };
          return {
            scrollTop: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            top: usedLength(style.getPropertyValue('--scroll-fade-t')),
            bottom: usedLength(style.getPropertyValue('--scroll-fade-b')),
            topRaw: style.getPropertyValue('--scroll-fade-t'),
            bottomRaw: style.getPropertyValue('--scroll-fade-b'),
            mask: style.maskImage,
            timeline: style.getPropertyValue('animation-timeline'),
            slot: node.getAttribute('data-slot'),
            nativeScrollTimeline: CSS.supports('animation-timeline', 'scroll()'),
          };
        });
      const pointerScroll = async (
        scroll: typeof viewport,
        root: typeof aggregate,
        phase: string,
      ) => {
        await scroll.focus();
        await page.keyboard.press('Home');
        await page.waitForTimeout(100);
        const top = await fadeState(scroll);
        assert.equal(top.slot, 'scroll-area-viewport', `${phase}: wrong scrolling node`);
        assert.ok(
          top.nativeScrollTimeline && top.mask !== 'none',
          `${phase}: scroll fade did not load`,
        );
        assert.ok(
          top.top === 0 && top.bottom > 0,
          `${phase}: top fade state differs ${JSON.stringify(top)}`,
        );
        await scroll.hover({ position: { x: 40, y: 25 } });
        await page.mouse.wheel(0, 90);
        await page.waitForTimeout(150);
        const wheel = await fadeState(scroll);
        assert.ok(
          wheel.scrollTop > 0 && wheel.top > 0 && wheel.bottom > 0,
          `${phase}: wheel did not scroll/fade actual viewport`,
        );
        await stage(`${phase}-wheel`);
        await scroll.focus();
        await page.keyboard.press('Home');
        await page.waitForTimeout(100);
        await root.hover();
        const thumb = root.locator(
          ':scope > [data-slot="scroll-area-scrollbar"][data-orientation="vertical"] [data-slot="scroll-area-thumb"]',
        );
        await thumb.waitFor({ state: 'visible' });
        const box = await thumb.boundingBox();
        assert.ok(box && box.height > 0, `${phase}: Radix thumb missing`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(100);
        const dragged = await fadeState(scroll);
        assert.ok(
          dragged.scrollTop > 0 && dragged.top > 0,
          `${phase}: thumb did not scroll actual viewport`,
        );
        await stage(`${phase}-thumb`);
        await scroll.focus();
        await page.keyboard.press('Home');
        await page.waitForTimeout(100);
        return { top, wheel, dragged };
      };
      const aggregatePointer = await pointerScroll(
        viewport,
        aggregate.locator('.tool-activity-scroll').first(),
        'long-aggregate',
      );
      await viewport.focus();
      await page.keyboard.press('PageDown');
      await page.waitForFunction(
        () =>
          (document.querySelector<HTMLElement>('.conversation .tool-activity-viewport')
            ?.scrollTop ?? 0) > 0,
      );
      const pageDownTop = await viewport.evaluate((node) => node.scrollTop);
      await page.keyboard.press('End');
      await page.waitForTimeout(180);
      const endTop = await viewport.evaluate((node) => node.scrollTop);
      assert.ok(endTop > pageDownTop, 'End did not reach later tool rows');
      await stage('long-keyboard-end');
      const aggregateEndFade = await fadeState(viewport);
      assert.ok(
        aggregateEndFade.top > 0 && aggregateEndFade.bottom === 0,
        'aggregate end fade state differs',
      );
      const failed = steps
        .locator('.tool-activity')
        .filter({ has: page.getByText('fixture-target-execution-2', { exact: true }) })
        .first();
      const denied = steps
        .locator('.tool-activity')
        .filter({ has: page.getByText('fixture-target-execution-4', { exact: true }) })
        .first();
      const readReasonTail = async (item: typeof failed, marker: string, phase: string) => {
        const detail = item.getByRole('region', { name: '工具异常详情', exact: true });
        assert.ok(
          await detail.evaluate(
            (node) =>
              node.classList.contains('tool-detail-viewport') &&
              node.classList.contains('scroll-fade-y'),
          ),
        );
        const pointer = await pointerScroll(
          detail,
          item.locator('.tool-detail-scroll').first(),
          phase,
        );
        await detail.focus();
        await page.keyboard.press('End');
        await page.waitForTimeout(180);
        const geometry = await detail.evaluate((node, endMarker) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text: Node | null = walker.nextNode();
          while (text && !text.textContent?.includes(endMarker)) text = walker.nextNode();
          if (!text) throw Error('fixture_detail_tail_missing');
          const start = text.textContent!.indexOf(endMarker);
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + endMarker.length);
          const tail = range.getBoundingClientRect(),
            box = node.getBoundingClientRect();
          const outer = node.closest('.tool-activity-viewport')!.getBoundingClientRect();
          return {
            scrollTop: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            tailTop: tail.top,
            tailBottom: tail.bottom,
            visibleTop: Math.max(box.top, outer.top),
            visibleBottom: Math.min(box.bottom, outer.bottom),
            tabIndex: (node as HTMLElement).tabIndex,
          };
        }, marker);
        assert.equal(geometry.tabIndex, 0, 'error detail cannot receive keyboard focus');
        assert.ok(
          geometry.scrollTop > 0 &&
            geometry.scrollTop >= geometry.scrollHeight - geometry.clientHeight - 1,
          'End did not scroll complete error reason',
        );
        assert.ok(
          geometry.tailTop >= geometry.visibleTop - 1 &&
            geometry.tailBottom <= geometry.visibleBottom + 1,
          'long error tail is outside readable scroll area',
        );
        await stage(phase);
        const endFade = await fadeState(detail);
        assert.ok(endFade.top > 0 && endFade.bottom === 0, `${phase}: end fade state differs`);
        return { ...geometry, pointer, endFade };
      };
      await failed.locator(':scope > .tool-activity-summary').click();
      await stage('long-failed-item-open');
      assert.ok(
        (await failed.textContent())?.includes(detail.error),
        'failed item did not reveal its complete original reason',
      );
      assert.ok(
        !(await steps.textContent())?.includes('APPROVAL_REJECTION_START'),
        'opening failed item revealed another item reason',
      );
      const failureTail = await readReasonTail(
        failed,
        'FAILED_WRITE_DETAIL_END',
        'long-failed-tail',
      );
      await summary.click();
      await stage('long-recollapsed');
      assert.ok(
        !(await aggregate.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'closed group retained visible failure reason',
      );
      await summary.click();
      await stage('long-reopened');
      assert.equal(
        await failed.locator(':scope > .tool-activity-summary').getAttribute('aria-expanded'),
        'true',
        'group reopen lost item disclosure choice',
      );
      assert.ok(
        (await failed.textContent())?.includes(detail.error),
        'group reopen lost complete failure reason',
      );
      await failed.locator(':scope > .tool-activity-summary').click();
      await denied.locator(':scope > .tool-activity-summary').click();
      await stage('long-approval-item-open');
      assert.ok(
        (await denied.textContent())?.includes(detail.approval),
        'approval item did not reveal its complete original reason',
      );
      assert.ok(
        !(await steps.textContent())?.includes('FAILED_WRITE_DETAIL_START'),
        'closing failed item did not hide its reason',
      );
      const approvalTail = await readReasonTail(
        denied,
        'APPROVAL_REJECTION_END',
        'long-approval-tail',
      );
      assert.ok(
        await aggregate.evaluate((node) => node.getBoundingClientRect().height <= 400.5),
        'long error details exceeded aggregate cap',
      );
      await viewport.focus();
      await page.keyboard.press('End');
      await stage('long-approval-keyboard-end');
      await denied.locator(':scope > .tool-activity-summary').click();
      await page.waitForTimeout(280);
      const colors = await aggregate.evaluate((node) => {
        const resolve = (variable: string) => {
          const probe = document.createElement('span');
          probe.style.cssText = `position:absolute;visibility:hidden;color:var(${variable})`;
          node.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return { muted: resolve('--muted-foreground'), destructive: resolve('--destructive') };
      });
      const approvalMatrix = [];
      for (const entry of detail.matrix) {
        const item = steps
          .locator('.tool-activity')
          .filter({ has: page.getByText(`${entry.definitionId} · 1`, { exact: true }) })
          .first();
        const itemSummary = item.locator(':scope > .tool-activity-summary');
        await itemSummary.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        const inspect = () =>
          itemSummary.evaluate((node) =>
            [...node.querySelectorAll('.tool-approval,.tool-step-status,.tool-activity-state')].map(
              (label) => ({
                text: label.getAttribute('aria-label') ?? label.textContent ?? '',
                approval: label.classList.contains('tool-approval'),
                fontSize: getComputedStyle(label).fontSize,
                color: getComputedStyle(label).color,
              }),
            ),
          );
        const normal = await inspect();
        const approvalLabels = normal.filter((label) => label.approval);
        const executionLabels = normal.filter((label) => !label.approval);
        assert.deepEqual(
          approvalLabels.map((label) => label.text),
          [entry.approval],
          `${entry.definitionId}: approval status differs`,
        );
        assert.deepEqual(
          executionLabels.map((label) => label.text),
          entry.status ? [entry.status] : [],
          `${entry.definitionId}: redundant or missing tool status`,
        );
        for (const label of normal) {
          assert.equal(label.fontSize, '13px', `${entry.definitionId}: status font differs`);
          assert.equal(
            label.color,
            !label.approval && entry.issue ? colors.destructive : colors.muted,
            `${entry.definitionId}: status color differs`,
          );
        }
        if (entry.reason)
          assert.ok(
            !(await item.textContent())?.includes(entry.reason),
            `${entry.definitionId}: reason visible before item disclosure`,
          );
        await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}-closed`);
        await itemSummary.hover();
        assert.deepEqual(
          await inspect(),
          normal,
          `${entry.definitionId}: hovering changed status style`,
        );
        await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}-hover`);
        let expanded: typeof normal | undefined;
        if ((await itemSummary.getAttribute('aria-expanded')) !== null) {
          await itemSummary.click();
          expanded = await inspect();
          assert.deepEqual(expanded, normal, `${entry.definitionId}: expanded status brightened`);
          if (entry.reason)
            assert.ok(
              (await item.textContent())?.includes(entry.reason),
              `${entry.definitionId}: original reason missing after disclosure`,
            );
          await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}`);
          await itemSummary.click();
          await page.waitForTimeout(280);
          if (entry.reason)
            assert.ok(
              !(await item.textContent())?.includes(entry.reason),
              `${entry.definitionId}: closing retained visible reason`,
            );
        } else await stage(`matrix-${entry.definitionId.replaceAll('.', '-')}`);
        approvalMatrix.push({
          definitionId: entry.definitionId,
          normal,
          hovered: await inspect(),
          expanded,
        });
      }
      const final = await aggregate.evaluate((node) => {
        const header = node.querySelector('.tool-activity-summary')!.getBoundingClientRect();
        return {
          header: [header.x, header.y, header.width, header.height],
          viewportTop: node.closest('.conversation-viewport')?.scrollTop,
          footer: [...document.querySelectorAll('.conversation-footer')]
            .find((item) => item.getBoundingClientRect().height > 0)
            ?.getBoundingClientRect()
            .toJSON(),
        };
      });
      assert.deepEqual(
        final,
        { header: initial.header, viewportTop: initial.viewportTop, footer: initial.footer },
        'internal scrolling moved aggregate title, outer reading or input',
      );
      const samples = await page.evaluate(() => window.liveAggregationSamples);
      await cdp.send('Page.stopScreencast');
      report.cases.push({
        theme,
        width,
        errors,
        screenshotFrames,
        samples,
        verification: {
          initial,
          final,
          pageDownTop,
          endTop,
          aggregatePointer,
          aggregateEndFade,
          failureTail,
          approvalTail,
          colors,
          approvalMatrix,
        },
      });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      assert.deepEqual(errors, [], 'long group page errors');
      for (const sample of samples.filter((item) => item.activities.length > 0)) {
        assert.equal(
          sample.summaryExtras,
          0,
          'aggregate header retained summary statistics/status',
        );
        assert.equal(sample.nestedButtons, 0, 'nested tool buttons');
        assert.equal(sample.overflow, false, 'long group caused horizontal overflow');
      }
      console.log(
        JSON.stringify({
          longGroup,
          theme,
          width,
          samples: samples.length,
          screenshotFrames,
          initial,
          pageDownTop,
          endTop,
          errors,
        }),
      );
      await page.close();
      continue;
    }
    if (handoff) {
      await stage('handoff-first-tool', () => window.liveAggregationFixture.add(1));
      await stage('handoff-first-receipt', () => window.liveAggregationFixture.settle(1));
      await stage('handoff-first-metadata', () => window.liveAggregationFixture.flush());
      await page.evaluate(() => {
        const text = document.querySelector('.message.user .typeset-chat');
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(text);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
        }
      });
      await page.evaluate(async (withoutBody) => {
        window.liveAggregationPhase = 'handoff-empty-model';
        await window.liveAggregationFixture.model(
          'second-model',
          withoutBody ? 'empty-no-body' : 'empty',
        );
      }, theme === 'dark');
      await page.waitForTimeout(60);
      await page.screenshot({ path: path.join(artifact, `${label}-handoff-empty-model.png`) });
      await page.evaluate(async () => {
        window.liveAggregationPhase = 'handoff-view-before-history';
        window.liveAggregationFixture.holdHistory();
        await window.liveAggregationFixture.model('second-model', 'tool-only');
        window.liveAggregationFixture.add(2);
      });
      await page.waitForFunction(() => window.liveAggregationFixture.historyPending() > 0);
      await page.waitForTimeout(90);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-view-before-history.png`),
      });
      await page.evaluate(() => {
        window.liveAggregationPhase = 'handoff-tool-only-history';
        window.liveAggregationFixture.releaseHistory();
      });
      await page.waitForTimeout(90);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-tool-only-history.png`),
      });
      await page.evaluate(() => {
        window.liveAggregationPhase = 'handoff-second-receipt';
        window.liveAggregationFixture.settle(2);
      });
      await page.waitForFunction(() => window.liveAggregationFixture.pending() > 0);
      await page.evaluate(() => window.liveAggregationFixture.flush());
      await page.evaluate(async () => {
        window.liveAggregationPhase = 'handoff-body-preview-empty';
        await window.liveAggregationFixture.model('third-model', 'body-preview-empty');
      });
      await page.waitForTimeout(90);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-body-preview-empty.png`),
      });
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.message.assistant .typeset-chat')].some((node) =>
          node.textContent?.includes('接着核对下一组工具。'),
        ),
      );
      await page.evaluate(() => {
        window.liveAggregationPhase = 'handoff-body-readable';
      });
      // Observe the final readable state after the existing <=420ms reveal;
      // this test-only wait does not delay any production update or animation.
      await page.waitForTimeout(450);
      await page.screenshot({
        path: path.join(artifact, `${label}-handoff-body-readable.png`),
      });
      const samples = await page.evaluate(() => window.liveAggregationSamples);
      await cdp.send('Page.stopScreencast');
      report.cases.push({ theme, width, errors, screenshotFrames, samples });
      await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
      const affected = samples.filter(
        (sample) =>
          [
            'handoff-empty-model',
            'handoff-view-before-history',
            'handoff-tool-only-history',
          ].includes(sample.phase) && sample.activities.length > 0,
      );
      const original = affected[0]!.activities[0]!.node;
      const failures = affected.filter(
        (sample) => sample.activities.length !== 1 || sample.activities[0]!.node !== original,
      );
      const first = affected[0]!;
      for (const sample of affected) {
        const activity = sample.activities[0]!;
        assert.equal(
          activity.titleNode,
          first.activities[0]!.titleNode,
          'handoff replaced action title node',
        );
        assert.equal(
          activity.chevronNode,
          first.activities[0]!.chevronNode,
          'handoff replaced disclosure arrow node',
        );
        assert.deepEqual(
          [0, 1, 3].map((index) => activity.titleBox?.[index]),
          [0, 1, 3].map((index) => first.activities[0]!.titleBox?.[index]),
          'handoff moved action title',
        );
        assert.equal(
          sample.selection,
          '检查连续混合工具的完整执行过程。',
          'handoff lost reader selection',
        );
        assert.equal(sample.scrollTop, first.scrollTop, 'handoff moved reading position');
        assert.deepEqual(sample.footer, first.footer, 'handoff moved input');
      }
      const bodyFrames = samples.filter((sample) =>
        ['handoff-body-preview-empty', 'handoff-body-readable'].includes(sample.phase),
      );
      assert.ok(
        bodyFrames.some((sample) =>
          sample.messages.some(
            (message) =>
              message.role.includes('assistant') && message.text.includes('接着核对下一组工具。'),
          ),
        ),
        'nonempty original Model body was hidden with its empty preview',
      );
      assert.ok(
        !bodyFrames.some((sample) =>
          sample.messages.some((message) => message.text.includes('完整回复读取失败')),
        ),
        'canonical Model body verification failed',
      );
      console.log(
        JSON.stringify({
          handoff,
          samples: samples.length,
          screenshotFrames,
          failures: failures.slice(0, 6).map((sample) => ({
            phase: sample.phase,
            cause: sample.cause,
            activities: sample.activities.map(({ node, text, box }) => ({ node, text, box })),
          })),
          errors,
        }),
      );
      assert.deepEqual(errors, [], 'model handoff page errors');
      handoffFailures += failures.length;
      await page.close();
      continue;
    }
    await stage('single-read', () => window.liveAggregationFixture.add(1));
    await page.waitForFunction(() => document.querySelectorAll('.tool-activity').length > 0);
    await stage('mixed-write', () => window.liveAggregationFixture.add(2));
    await stage('mixed-shell', () => window.liveAggregationFixture.add(3));
    await stage('mixed-mcp', () => window.liveAggregationFixture.add(4));
    await stage('mixed-agent', () => window.liveAggregationFixture.add(5));
    await stage('mixed-search', () => window.liveAggregationFixture.add(6));
    await stage('mixed-edit', () => window.liveAggregationFixture.add(7));
    await stage('receipt-no-view', () =>
      window.liveAggregationFixture.settle(1, 'succeeded', true),
    );
    await page.waitForFunction(() => window.liveAggregationFixture.pending() > 0);
    await stage('metadata-takeover', () => window.liveAggregationFixture.flush());
    const aggregate = page
      .locator('.conversation .tool-activity')
      .filter({ has: page.locator('.tool-activity-summary') })
      .first();
    await page.evaluate(() => {
      window.liveAggregationPhase = 'reader-expanding';
    });
    await aggregate.locator('.tool-activity-summary').first().click();
    await stage('reader-expanded');
    await stage('failed-receipt', () => window.liveAggregationFixture.settle(2, 'failed', true));
    await stage('failed-metadata', () => window.liveAggregationFixture.flush());
    await stage('cancelled-receipt', () =>
      window.liveAggregationFixture.settle(3, 'cancelled', true),
    );
    await stage('cancelled-metadata', () => window.liveAggregationFixture.flush());
    await stage('unknown-receipt', () =>
      window.liveAggregationFixture.settle(4, 'outcome_unknown', true),
    );
    await stage('unknown-metadata', () => window.liveAggregationFixture.flush());
    await page.evaluate(() => {
      window.liveAggregationPhase = 'reader-collapsing';
    });
    await aggregate.locator('.tool-activity-summary').first().click();
    await stage('reader-collapsed');
    for (const index of [5, 6, 7]) {
      await page.evaluate((index) => {
        window.liveAggregationPhase = `complete-${index}`;
        window.liveAggregationFixture.settle(index, 'succeeded', true);
      }, index);
      await page.waitForTimeout(160);
      await page.evaluate(() => window.liveAggregationFixture.flush());
      await page.waitForTimeout(100);
    }
    await stage('all-settled');
    await stage('run-completed', () => window.liveAggregationFixture.finish());
    const process = page.locator('.agent-turn-summary').first();
    if ((await process.getAttribute('aria-expanded')) === 'false') await process.click();
    await stage('completed-open-process');
    const beforeCache = await page.evaluate(
      () => window.liveAggregationSamples.at(-1)!.activities[0]?.node,
    );
    await page.getByRole('button', { name: 'Session B', exact: true }).click();
    await stage('other-session');
    await page.getByRole('button', { name: 'Session A', exact: true }).click();
    await stage('cached-return');
    const samples = await page.evaluate(() => window.liveAggregationSamples);
    await cdp.send('Page.stopScreencast');
    report.cases.push({ theme, width, errors, screenshotFrames, samples });
    await Bun.write(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(errors, [], `${theme}: page errors`);
    const start = samples.findIndex(
      (sample) => sample.phase === 'single-read' && sample.activities.length > 0,
    );
    assert.ok(start >= 0, `${theme}: first tool never appeared`);
    const initial = samples[start]!;
    const active = samples
      .slice(start)
      .filter(
        (sample) =>
          !['run-completed', 'completed-open-process', 'other-session', 'cached-return'].includes(
            sample.phase,
          ),
      );
    for (const sample of active) {
      assert.equal(
        sample.activities.length,
        1,
        `${theme}/${sample.phase}: a tool escaped the aggregate`,
      );
      assert.equal(
        sample.activities[0]!.node,
        initial.activities[0]!.node,
        `${theme}/${sample.phase}: aggregate DOM replaced`,
      );
      assert.equal(sample.outsideTools, 0, `${theme}/${sample.phase}: standalone tool row`);
      assert.equal(sample.overflow, false, `${theme}/${sample.phase}: horizontal overflow`);
      const [x, , activityWidth] = sample.activities[0]!.box;
      assert.ok(
        activityWidth! > 0 && x! >= 0 && x! + activityWidth! <= sample.width,
        `${theme}/${sample.phase}: aggregate exceeds viewport`,
      );
      assert.ok(
        sample.activities[0]!.titleWidth >= 42,
        `${theme}/${sample.phase}: action caption became unreadable`,
      );
      const chevron = sample.activities[0]!.chevronBox;
      assert.ok(
        chevron &&
          chevron[2]! > 0 &&
          chevron[0]! >= x! &&
          chevron[0]! + chevron[2]! <= x! + activityWidth!,
        `${theme}/${sample.phase}: disclosure arrow was clipped`,
      );
      assert.deepEqual(sample.footer, initial.footer, `${theme}/${sample.phase}: input moved`);
    }
    const collapsedPhases = new Set([
      'mixed-write',
      'mixed-shell',
      'mixed-mcp',
      'mixed-agent',
      'mixed-search',
      'mixed-edit',
      'receipt-no-view',
      'metadata-takeover',
      'reader-collapsed',
      'all-settled',
    ]);
    const collapsedStart = active.find((sample) => sample.phase === 'reader-collapsed')!.time;
    for (const sample of active.filter(
      (sample) =>
        collapsedPhases.has(sample.phase) &&
        (sample.phase !== 'reader-collapsed' || sample.time - collapsedStart > 300),
    )) {
      assert.equal(sample.steps, 0, `${theme}/${sample.phase}: collapsed group displayed items`);
      assert.equal(sample.raw, false, `${theme}/${sample.phase}: collapsed raw record leaked`);
      // New actions may grow the caption; its position and row height stay stable.
      assert.deepEqual(
        [0, 1, 3].map((index) => sample.activities[0]!.box[index]),
        [0, 1, 3].map((index) => initial.activities[0]!.box[index]),
        `${theme}/${sample.phase}: collapsed aggregate moved`,
      );
      assert.equal(
        sample.scrollTop,
        initial.scrollTop,
        `${theme}/${sample.phase}: collapsed scroll moved`,
      );
    }
    const last = samples.at(-1)!;
    assert.equal(last.activities.length, 1, `${theme}: cache return has no aggregate`);
    assert.equal(last.activities[0]!.node, beforeCache, `${theme}: cached aggregate node replaced`);
    assert.ok(
      samples.some((sample) => sample.phase === 'reader-expanded' && sample.steps === 7),
      `${theme}: mixed items not displayed`,
    );
    assert.ok(
      samples.some(
        (sample) => sample.phase === 'unknown-metadata' && sample.activities.length === 1,
      ),
      `${theme}: unknown result not covered`,
    );
    console.log(
      JSON.stringify({
        theme,
        width,
        samples: samples.length,
        activeSamples: active.length,
        screenshotFrames,
        errors,
      }),
    );
    await page.close();
  }
  assert.equal(
    handoffFailures,
    0,
    'empty/tool-only Model split or replaced the original tool aggregate',
  );
} finally {
  console.log(JSON.stringify({ artifact }));
  await browser.close();
  server.stop(true);
}
