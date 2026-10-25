import { RightSidebar } from '@kite-ai/ui/desktop';
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  NativeBridge,
  NativeProvider,
  NativeProviderOperation,
  NativeProviderSettingsFacts,
  NativeProviderSubmission,
  NativeSelection,
} from './native-bridge';
import { NativeConnectionModels } from './native-connection-models';
import {
  NativeModelSettingsFeedback,
  type NativeModelSettingsState,
} from './native-model-settings';

export type NativeProviderSettingsActivity = {
  busy: boolean;
  writing: boolean;
  pending: boolean;
  storeId?: string;
};

type ProviderIconName = 'refresh' | 'plus' | 'connection' | 'shield' | 'models';
function ProviderIcon({ name }: { name: ProviderIconName }) {
  const paths: Record<ProviderIconName, string> = {
    refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17',
    plus: 'M12 5v14M5 12h14',
    connection:
      'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
    shield: 'M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6l-8-3Zm-4 9 3 3 5-6',
    models: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
const providerPresentation: Record<NativeProvider, { mark: string; description: string }> = {
  openai: { mark: 'O', description: 'OpenAI 官方 API，支持两种接口协议' },
  deepseek: { mark: 'D', description: '连接 DeepSeek 官方模型服务' },
  compatible: { mark: '</>', description: '使用兼容 OpenAI 协议的自定义服务' },
  ollama: { mark: '◉', description: '连接本机或自托管的 Ollama 模型' },
  codex: { mark: 'C', description: '自动复用本机 Codex 的 ChatGPT 登录' },
};
function ProviderMark({ provider }: { provider: NativeProvider }) {
  return (
    <span className={`provider-mark provider-mark-${provider}`} aria-hidden="true">
      {providerPresentation[provider].mark}
    </span>
  );
}

type Protocol = NonNullable<NativeProviderOperation['protocol']>;
function protocolLabel(protocol?: Protocol) {
  return protocol === 'responses' ? 'Responses' : 'Chat Completions';
}
function supportsResponses(provider: NativeProvider) {
  return provider === 'openai' || provider === 'compatible';
}
type Provider = NativeProviderSettingsFacts['providers'][number];
type Connection = Provider['connections'][number];
type PanelMode = 'add' | 'edit' | 'remove';
type SentProviderChange = {
  storeId: string;
  observationId: number;
  operation: NativeProviderOperation;
};
// Closing settings cancels readers and timers, not an already sent intent. Retain
// only its non-secret correlation facts so reopening the same view can query Main.
const sentProviderChanges = new WeakMap<NativeBridge, Map<string, SentProviderChange>>();
function matchesProviderChange(sent: SentProviderChange, entry: NativeProviderSubmission) {
  const operation = (value: NativeProviderOperation) =>
    JSON.stringify([
      value.kind,
      value.provider,
      value.connectionId,
      value.name,
      value.baseURL,
      value.protocol,
      value.modelNames,
      value.credential,
    ]);
  return (
    entry.kind === 'settings.providers.submission' &&
    typeof entry.commandId === 'string' &&
    entry.commandId.length > 0 &&
    ['submitting', 'unknown', 'applied', 'failed'].includes(entry.phase) &&
    entry.storeId === sent.storeId &&
    entry.observationId === sent.observationId &&
    operation(entry.operation) === operation(sent.operation)
  );
}
// These Main errors occur before creating an intent or attempting its mutation.
// An unavailable/invalid response is deliberately not evidence of non-dispatch.
function rejectedBeforeProviderDispatch(code: string) {
  return [
    'configuration_observation_changed',
    'configuration_mutation_pending',
    'configuration_intent_consumed',
    'configuration_intent_limit',
    'provider_settings_override',
    'invalid_request',
    'invalid_provider_name',
    'invalid_provider_endpoint',
    'invalid_model_protocol',
    'model_protocol_unsupported',
    'provider_default_model_in_use',
    'provider_scheduled_model_in_use',
    'provider_credential_required',
  ].includes(code);
}
function connectionLabel(provider: Provider, connection: Connection) {
  return (
    connection.name?.trim() || `${provider.label} ${provider.connections.indexOf(connection) + 1}`
  );
}
function connectionFingerprint(provider: Provider, connection?: Connection) {
  // The observation ID also binds credentials that are intentionally absent from these public facts.
  // This snapshot additionally guards changed facts when an observation ID is reused by a fixture.
  return JSON.stringify({
    provider: provider.id,
    requiresCredential: provider.requiresCredential,
    ...(connection
      ? {
          id: connection.id,
          name: connection.name ?? '',
          baseURL: connection.baseURL,
          protocol: connection.protocol ?? 'chat-completions',
          hasCredential: connection.hasCredential,
          modelNames: connection.modelNames,
          modelIds: connection.modelIds ?? [],
          defaultModelIds: connection.defaultModelIds ?? [],
        }
      : {}),
  });
}
function presetLabel(provider: Provider) {
  return provider.id === 'compatible' ? '自定义服务商' : provider.label;
}
function safeError(cause: unknown) {
  const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
  return /^[a-z][a-z0-9_]{0,80}$/.test(code ?? '') ? code : 'configuration_unavailable';
}
function validEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function NativeProviderSettings({
  bridge,
  generation,
  selection,
  submissions,
  onSaved,
  onRecovered,
  panelHost,
  editorControl,
  refreshControl,
  models,
  revision = 0,
  onActivityChange,
  acquireWrite,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  submissions: readonly NativeProviderSubmission[];
  onSaved?: () => void;
  onRecovered?: () => void;
  panelHost: HTMLElement | null;
  editorControl?: RefObject<{ close: () => void } | null>;
  refreshControl?: RefObject<(() => Promise<boolean>) | null>;
  models?: NativeModelSettingsState;
  revision?: number;
  onActivityChange?: (activity: NativeProviderSettingsActivity) => void;
  acquireWrite?: () => (() => void) | undefined;
}) {
  const fieldId = useId();
  const [facts, setFacts] = useState<NativeProviderSettingsFacts>();
  const [providerId, setProviderId] = useState<NativeProvider>();
  const [panelMode, setPanelMode] = useState<PanelMode>();
  const [name, setName] = useState('');
  const [draftBasis, setDraftBasis] = useState<{
    storeId: string;
    observationId: number;
    fingerprint: string;
  }>();
  const editorVersion = useRef(0);
  const panelCurrent = useRef(providerId);
  panelCurrent.current = providerId;
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<Protocol>('chat-completions');
  const [baseURL, setBaseURL] = useState(''),
    [modelNames, setModelNames] = useState(''),
    [secret, setSecret] = useState('');
  const [credential, setCredential] = useState<NativeProviderOperation['credential']>('replace');
  const [fieldError, setFieldError] = useState<{
    field: 'name' | 'url' | 'key';
    message: string;
  }>();
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false),
    [writing, setWriting] = useState(false);
  const [local, setLocal] = useState<NativeProviderSubmission[]>([]);
  const identity = `${generation}/${selection?.storeId}/${selection?.session.id}/${selection?.viewSelection}`;
  const awaitingOriginal = useRef<SentProviderChange | undefined>(
    sentProviderChanges.get(bridge)?.get(identity),
  );
  const [awaitingOriginalRecord, setAwaitingOriginalRecord] = useState(!!awaitingOriginal.current);
  const mounted = useRef(true);
  const current = useRef(identity);
  current.current = identity;
  const sequence = useRef(0),
    flight = useRef(false);
  const readFlight = useRef<{ request: number; promise: Promise<boolean> } | undefined>(undefined);
  const recovery = useRef({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    attempt: 0,
    needsRead: false,
    notify: false,
    cause: '',
    running: false,
    pendingSaved: undefined as NativeProviderSubmission | undefined,
  });
  const notified = useRef(new Set<string>());
  const recoveryAction = useRef<() => Promise<void>>(async () => {});
  const recoveryContext = useRef<{ originals: NativeProviderSubmission[]; storeId?: string }>({
    originals: [],
  });
  const recoveredCallback = useRef(onRecovered);
  recoveredCallback.current = onRecovered;

  const nameField = useRef<HTMLInputElement>(null),
    presetField = useRef<HTMLSelectElement>(null),
    cancelField = useRef<HTMLButtonElement>(null),
    addButton = useRef<HTMLButtonElement>(null),
    urlField = useRef<HTMLInputElement>(null),
    keyField = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const all = new Map(submissions.map((submission) => [submission.commandId, submission]));
  for (const submission of local) {
    const observed = all.get(submission.commandId);
    if (
      observed &&
      ['applied', 'failed'].includes(observed.phase) &&
      submission.phase === 'unknown'
    )
      continue;
    all.set(submission.commandId, submission);
  }
  const originals = [...all.values()];
  recoveryContext.current = {
    originals,
    storeId: facts?.storeId ?? selection?.storeId ?? models?.facts?.storeId,
  };
  const recoveryKey = JSON.stringify(
    originals.map((entry) => [entry.commandId, entry.storeId, entry.phase]),
  );
  const pending =
    awaitingOriginalRecord ||
    (facts &&
      originals.some(
        (submission) =>
          submission.storeId === facts.storeId &&
          ['submitting', 'unknown'].includes(submission.phase),
      ));
  const provider = facts?.providers.find((entry) => entry.id === providerId);
  const connection = provider?.connections.find((entry) => entry.id === connectionId);
  const entries =
    facts?.providers.flatMap((provider) =>
      provider.connections.map((connection) => ({ provider, connection })),
    ) ?? [];
  const draftStale =
    !!draftBasis &&
    (!facts ||
      !provider ||
      draftBasis.storeId !== facts.storeId ||
      (connectionId !== null && draftBasis.observationId !== facts.observationId) ||
      draftBasis.fingerprint !== connectionFingerprint(provider, connection));
  const blockedRemoval =
    !!connection?.defaultModelIds?.length || !!connection?.scheduledTaskNames?.length;
  const writable =
    facts?.canWrite &&
    provider?.id !== 'codex' &&
    (panelMode === 'add' || !!connection) &&
    (!connection || connection.canWrite) &&
    !pending &&
    !draftStale &&
    !reading &&
    !writing &&
    !models?.reading &&
    !models?.writing &&
    !models?.pending;
  const previousRevision = useRef(revision);
  const activityStoreId = facts?.storeId ?? awaitingOriginal.current?.storeId;
  useEffect(() => {
    onActivityChange?.({
      busy: reading || writing,
      writing,
      pending: !!pending,
      storeId: activityStoreId,
    });
  }, [reading, writing, pending, activityStoreId, onActivityChange]);
  const assignedModelIds = new Set<string>();
  const connectionModels = new Map<string, string[]>();
  for (const { provider: entry, connection: item } of entries) {
    const ids = (item.modelIds ?? []).filter((id) => {
      if (assignedModelIds.has(id)) return false;
      assignedModelIds.add(id);
      return true;
    });
    connectionModels.set(JSON.stringify([entry.id, item.id]), ids);
  }
  // Await the initial connection facts before deciding that a model is unassigned.
  // Retained facts keep existing rows in place during subsequent refreshes.
  const unassignedModels =
    facts || !reading
      ? models?.facts?.models
          .filter((model) => !assignedModelIds.has(model.id))
          .map((model) => model.id)
      : undefined;
  const panelTitle =
    panelMode === 'remove' ? '删除提供商' : panelMode === 'edit' ? '编辑提供商' : '新增提供商';
  const editingLabel =
    provider && connection
      ? connectionLabel(provider, connection)
      : provider
        ? presetLabel(provider)
        : '选择服务商预设';
  function remember(submission: NativeProviderSubmission) {
    settleSent(submission);
    setLocal((values) => [
      ...values.filter((entry) => entry.commandId !== submission.commandId),
      submission,
    ]);
  }
  function settleSent(submission: NativeProviderSubmission) {
    const retained = sentProviderChanges.get(bridge)?.get(identity);
    if (
      retained &&
      ['applied', 'failed'].includes(submission.phase) &&
      matchesProviderChange(retained, submission)
    )
      sentProviderChanges.get(bridge)?.delete(identity);
  }
  function cancelRecovery() {
    clearTimeout(recovery.current.timer);
    recovery.current.timer = undefined;
  }
  function persistentFailure(code: string) {
    return [
      'native_generation_changed',
      'native_selection_changed',
      'store_identity_mismatch',
      'store_mismatch',
      'configuration_scope_mismatch',
      'host_mutation_scope_mismatch',
      'capability_unavailable',
      'required_capability_missing',
      'permission_denied',
      'authorization_denied',
      'connection_not_admitted',
      'connection_identity_mismatch',
      'connection_superseded',
      'configuration_storage_unavailable',
      'configuration_intent_missing',
    ].includes(code);
  }
  function pendingOriginal() {
    const context = recoveryContext.current;
    return context.originals.find(
      (entry) =>
        entry.storeId === context.storeId && ['submitting', 'unknown'].includes(entry.phase),
    );
  }
  function scheduleRecovery() {
    const state = recovery.current;
    if (
      !mounted.current ||
      current.current !== identity ||
      state.running ||
      flight.current ||
      readFlight.current
    )
      return;
    if (!awaitingOriginal.current && !pendingOriginal() && !state.needsRead) {
      cancelRecovery();
      state.attempt = 0;
      return;
    }
    if (state.timer !== undefined || persistentFailure(state.cause)) return;
    const original = identity;
    const delays = [250, 1000, 3000, 10000];
    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        if (
          !mounted.current ||
          current.current !== original ||
          flight.current ||
          readFlight.current
        )
          return;
        state.running = true;
        state.attempt++;
        void recoveryAction.current().finally(() => {
          state.running = false;
          scheduleRecovery();
        });
      },
      delays[Math.min(state.attempt, delays.length - 1)],
    );
  }
  function requireRecovery(cause = '', notify = true) {
    recovery.current.needsRead = true;
    recovery.current.notify ||= notify;
    recovery.current.cause = cause;
  }
  function notifyApplied(submission: NativeProviderSubmission) {
    const key = JSON.stringify([submission.storeId, submission.commandId]);
    if (submission.phase !== 'applied' || notified.current.has(key)) return;
    notified.current.add(key);
    onSaved?.();
  }
  async function read(afterSave?: 'upsert' | 'remove', force = false) {
    if (!force && readFlight.current?.request === sequence.current)
      return readFlight.current.promise;
    cancelRecovery();
    const editing = editorVersion.current;
    const original = identity,
      request = ++sequence.current;
    setReading(true);
    // A recovery observes new facts; it never rebinds the editor's original draft basis.
    setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
    if (!recovery.current.running && !awaitingOriginal.current) setError('');
    const promise = (async () => {
      await Promise.resolve();
      try {
        const response = await bridge.request({ method: 'settings.providers.read', generation });
        if (!mounted.current || current.current !== original || sequence.current !== request)
          return false;
        if (
          !response ||
          !('providers' in response) ||
          !('kind' in response) ||
          response.kind !== 'settings.providers'
        )
          throw Error('configuration_unavailable');
        if (selection && response.storeId !== selection.storeId)
          throw Error('store_identity_mismatch');
        setFacts(response);
        const valid = !response.errors.length;
        if (valid && !awaitingOriginal.current) {
          const state = recovery.current;
          state.needsRead = false;
          state.cause = '';
          state.attempt = 0;
          const applied = state.pendingSaved;
          state.pendingSaved = undefined;
          if (applied) notifyApplied(applied);
          else if (state.notify) recoveredCallback.current?.();
          state.notify = false;
          setError('');
        } else if (!valid) requireRecovery(response.errors[0] ?? 'configuration_unavailable');
        return valid;
      } catch (cause) {
        if (mounted.current && current.current === original && sequence.current === request) {
          requireRecovery(safeError(cause));
          setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
          if (!afterSave || editing === editorVersion.current)
            setError(
              `${persistentFailure(safeError(cause)) ? (afterSave ? '已保存，当前配置不可读：' : '提供商配置不可用：') : afterSave === 'remove' ? '已删除，正在后台同步配置，无需重复删除。' : afterSave ? '已保存，正在后台同步配置，无需重复保存。' : '提供商配置正在后台同步：'}${safeError(cause)}`,
            );
        }
        return false;
      } finally {
        if (readFlight.current?.request === request) readFlight.current = undefined;
        if (mounted.current && current.current === original && sequence.current === request) {
          setReading(false);
          scheduleRecovery();
        }
      }
    })();
    readFlight.current = { request, promise };
    return promise;
  }
  const readCurrent = useRef(read);
  readCurrent.current = read;
  useLayoutEffect(() => {
    if (refreshControl) refreshControl.current = () => readCurrent.current(undefined, true);
    return () => {
      if (refreshControl) refreshControl.current = null;
    };
  }, [refreshControl]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The host selection seals the read identity.
  useEffect(() => {
    mounted.current = true;
    cancelRecovery();
    readFlight.current = undefined;
    recovery.current = {
      timer: undefined,
      attempt: 0,
      needsRead: false,
      notify: false,
      cause: '',
      running: false,
      pendingSaved: undefined,
    };
    awaitingOriginal.current = sentProviderChanges.get(bridge)?.get(identity);
    setAwaitingOriginalRecord(!!awaitingOriginal.current);
    if (awaitingOriginal.current) requireRecovery('network_outcome_unknown');
    previousRevision.current = revision;
    sequence.current++;
    setFacts(undefined);
    setProviderId(undefined);
    setPanelMode(undefined);
    setDraftBasis(undefined);
    setName('');
    setSecret('');
    setBaseURL('');
    setModelNames('');
    setError('');
    setWriting(false);
    flight.current = false;
    void read();
    return () => {
      mounted.current = false;
      cancelRecovery();
      readFlight.current = undefined;
      sequence.current++;
      void bridge.request({ method: 'settings.providers.close', generation }).catch(() => {});
    };
  }, [identity, bridge]);
  // Only a confirmed model mutation invalidates the connection observation.
  // Preserve the editor's original basis; read() never reauthorizes its draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit sibling invalidation signal.
  useEffect(() => {
    if (previousRevision.current === revision) return;
    previousRevision.current = revision;
    void read();
  }, [revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A single timer reads the latest current-scope originals, never frozen watcher props.
  useEffect(() => {
    scheduleRecovery();
  }, [identity, recoveryKey, reading, writing, facts?.observationId]);
  function choose(
    entry: Provider,
    existing?: Connection,
    mode: PanelMode = 'add',
    button?: HTMLButtonElement,
  ) {
    editorVersion.current++;
    if (button) origin.current = button;
    setPanelMode(mode);
    setProviderId(entry.id);
    setConnectionId(existing?.id ?? null);
    setDraftBasis(
      facts
        ? {
            storeId: facts.storeId,
            observationId: facts.observationId,
            fingerprint: connectionFingerprint(entry, existing),
          }
        : undefined,
    );
    setName(existing ? connectionLabel(entry, existing) : presetLabel(entry));
    setProtocol(existing?.protocol ?? 'chat-completions');
    setBaseURL(existing?.baseURL ?? entry.defaultBaseURL);
    setModelNames(existing?.modelNames.join('\n') ?? '');
    setSecret('');
    setCredential(existing?.hasCredential ? 'keep' : entry.requiresCredential ? 'replace' : 'none');
    setFieldError(undefined);
    setError('');
  }
  function add(button: HTMLButtonElement) {
    const preset = facts?.providers.find((entry) => entry.id !== 'codex');
    if (preset) choose(preset, undefined, 'add', button);
  }
  function close() {
    restoreFocus.current = true;
    editorVersion.current++;
    if (readFlight.current) {
      readFlight.current = undefined;
      requireRecovery();
    }
    sequence.current++;
    setReading(false);
    setProviderId(undefined);
    setPanelMode(undefined);
    setDraftBasis(undefined);
    setName('');
    setSecret('');
    setBaseURL('');
    setModelNames('');
    setFieldError(undefined);
    void bridge.request({ method: 'settings.providers.close', generation }).catch(() => {});
  }
  const closeCurrent = useRef(close);
  closeCurrent.current = close;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Switching between instances of one preset must reset field focus.
  useEffect(() => {
    if (editorControl)
      editorControl.current = panelMode ? { close: () => closeCurrent.current() } : null;
    if (!panelMode && restoreFocus.current) {
      restoreFocus.current = false;
      (origin.current?.isConnected ? origin.current : addButton.current)?.focus();
    }
    if (panelMode && panelHost) {
      if (panelMode === 'remove') cancelField.current?.focus();
      else if (panelMode === 'add') presetField.current?.focus();
      else nameField.current?.focus();
    }
    return () => {
      if (editorControl) editorControl.current = null;
    };
  }, [providerId, connectionId, panelMode, panelHost, editorControl]);
  async function save() {
    if (!facts || !provider || !writable || flight.current) return;
    if (panelMode === 'remove') {
      if (!connection || blockedRemoval) return;
      await submit({
        kind: 'remove',
        provider: provider.id,
        connectionId: connection.id,
        baseURL: connection.baseURL,
        ...(supportsResponses(provider.id)
          ? { protocol: connection.protocol ?? 'chat-completions' }
          : {}),
        modelNames: [],
        credential: 'none',
      });
      return;
    }
    if (!name.trim()) {
      setFieldError({ field: 'name', message: '请输入提供商名称。' });
      nameField.current?.focus();
      return;
    }
    if (!validEndpoint(baseURL.trim())) {
      setFieldError({ field: 'url', message: '请输入有效的 HTTP 或 HTTPS 服务地址。' });
      urlField.current?.focus();
      return;
    }
    if (
      (credential === 'replace' && !secret.trim()) ||
      (provider.requiresCredential && credential === 'none') ||
      (credential === 'keep' && !connection?.hasCredential)
    ) {
      setFieldError({ field: 'key', message: '请输入 API key。' });
      keyField.current?.focus();
      return;
    }
    const operation: NativeProviderOperation = {
      kind: 'upsert',
      name: name.trim(),
      provider: provider.id,
      connectionId,
      baseURL: baseURL.trim(),
      ...(supportsResponses(provider.id) ? { protocol } : {}),
      modelNames: [
        ...new Set(
          modelNames
            .split(/\r?\n/)
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      ],
      credential,
    };
    await submit(operation, credential === 'replace' ? secret : undefined);
  }
  async function submit(operation: NativeProviderOperation, key?: string) {
    if (!facts || flight.current || models?.reading || models?.writing || models?.pending) return;
    const release = acquireWrite?.();
    if (acquireWrite && !release) return;
    const original = identity,
      request = ++sequence.current,
      editing = editorVersion.current;
    const action = operation.kind === 'remove' ? '删除' : '保存';
    const sent: SentProviderChange = {
      storeId: facts.storeId,
      observationId: facts.observationId,
      operation: structuredClone(operation),
    };
    let retained = sentProviderChanges.get(bridge);
    if (!retained) {
      retained = new Map();
      sentProviderChanges.set(bridge, retained);
    }
    retained.set(original, sent);
    setSecret('');
    setFieldError(undefined);
    setError('');
    setWriting(true);
    flight.current = true;
    try {
      const response = await bridge.request({
        method: 'settings.providers.save',
        generation,
        observationId: facts.observationId,
        operation,
        ...(key === undefined ? {} : { secret: key }),
      });
      if (
        !response ||
        !('phase' in response) ||
        !('kind' in response) ||
        response.kind !== 'settings.providers.submission'
      )
        throw Error('configuration_unavailable');
      settleSent(response);
      if (!mounted.current) return;
      remember(response);
      if (current.current === original && response.phase === 'applied') notifyApplied(response);
      if (
        current.current !== original ||
        sequence.current !== request ||
        editorVersion.current !== editing
      )
        return;
      if (response.phase === 'applied') {
        if (editorVersion.current !== editing || panelCurrent.current !== operation.provider)
          return;
        await refreshApplied(operation, editing);
      } else if (response.phase !== 'unknown') {
        requireRecovery(response.error ?? 'configuration_unavailable');
        setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
        if (response.error) setError(`${action}失败：${response.error}`);
      }
    } catch (cause) {
      if (rejectedBeforeProviderDispatch(safeError(cause)) && retained.get(original) === sent)
        retained.delete(original);
      if (mounted.current && current.current === original) {
        // IPC failure does not prove the Main intent was never created. Keep the
        // exact non-secret request locked until an authoritative original is found.
        if (!rejectedBeforeProviderDispatch(safeError(cause))) {
          awaitingOriginal.current = sent;
          setAwaitingOriginalRecord(true);
        }
        requireRecovery(safeError(cause));
        if (editorVersion.current === editing) setError(`${action}结果未确认，正在后台核对。`);
      }
    } finally {
      release?.();
      if (mounted.current && current.current === original) {
        flight.current = false;
        setWriting(false);
        scheduleRecovery();
      }
    }
  }
  async function refreshApplied(
    operation: NativeProviderOperation,
    editing: number,
    closeEditor = true,
  ) {
    if (
      (await read(operation.kind ?? 'upsert')) &&
      editorVersion.current === editing &&
      closeEditor
    )
      close();
  }
  async function lookup(submission: NativeProviderSubmission) {
    if (flight.current) return;
    const original = identity,
      editing = editorVersion.current;
    flight.current = true;
    setWriting(true);
    try {
      const response = await bridge.request({
        method: 'settings.providers.lookup',
        generation,
        commandId: submission.commandId,
      });
      if (
        !response ||
        !('phase' in response) ||
        !('kind' in response) ||
        response.kind !== 'settings.providers.submission'
      )
        throw Error('configuration_unavailable');
      if (!mounted.current) return;
      remember(response);
      if (response.phase === 'applied' && current.current === original) notifyApplied(response);
      if (current.current === original && editing === editorVersion.current) {
        setError(
          response.phase === 'failed'
            ? `更改失败：${response.error ?? 'configuration_unavailable'}`
            : '',
        );
        if (response.phase === 'failed') {
          requireRecovery(response.error ?? 'configuration_unavailable');
          setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
        }
        if (response.phase === 'applied')
          await refreshApplied(
            response.operation,
            editing,
            panelCurrent.current === response.operation.provider &&
              connectionId === response.operation.connectionId &&
              (panelMode === 'remove') === (response.operation.kind === 'remove'),
          );
      }
    } catch {
      if (mounted.current && current.current === original && editing === editorVersion.current) {
        recovery.current.cause = 'network_outcome_unknown';
        setError('暂时无法核对结果，正在后台重试。');
      }
    } finally {
      if (mounted.current && current.current === original) {
        flight.current = false;
        setWriting(false);
        scheduleRecovery();
      }
    }
  }
  recoveryAction.current = async () => {
    const original = identity;
    let submission = pendingOriginal();
    const sent = awaitingOriginal.current;
    if (sent) {
      try {
        let candidates = recoveryContext.current.originals.filter((entry) =>
          matchesProviderChange(sent, entry),
        );
        if (candidates.length !== 1) {
          const state = await bridge.request({ method: 'state', generation });
          if (!mounted.current || current.current !== original) return;
          if (!state || !('creationSubmissions' in state)) throw Error('configuration_unavailable');
          if (state.generation !== generation) throw Error('native_generation_changed');
          const store = state.selection?.storeId ?? state.directory?.storeId;
          if (!store) return;
          if (
            (store && store !== sent.storeId) ||
            (state.directory && state.directory.storeId !== sent.storeId)
          )
            throw Error('store_identity_mismatch');
          const entries = state.providerSettingsSubmissions ?? [];
          for (const entry of entries)
            if (entry.storeId === sent.storeId && ['submitting', 'unknown'].includes(entry.phase))
              remember(entry);
          candidates = entries.filter((entry) => matchesProviderChange(sent, entry));
        }
        if (candidates.length !== 1) return;
        submission = candidates[0]!;
        if (submission.phase === 'applied') notifyApplied(submission);
        awaitingOriginal.current = undefined;
        setAwaitingOriginalRecord(false);
        remember(submission);
        if (['applied', 'failed'].includes(submission.phase)) {
          if (submission.phase === 'applied') recovery.current.pendingSaved = submission;
          requireRecovery();
          await read();
          return;
        }
      } catch (cause) {
        if (mounted.current && current.current === original) {
          recovery.current.cause = safeError(cause);
          setError(`提供商更改正在后台核对：${safeError(cause)}`);
        }
        return;
      }
    }
    if (submission) {
      flight.current = true;
      try {
        const response = await bridge.request({
          method: 'settings.providers.lookup',
          generation,
          commandId: submission.commandId,
        });
        if (!mounted.current || current.current !== original) return;
        if (
          !response ||
          !('kind' in response) ||
          response.kind !== 'settings.providers.submission' ||
          !('phase' in response) ||
          response.commandId !== submission.commandId ||
          response.storeId !== submission.storeId
        )
          throw Error('configuration_scope_mismatch');
        if (['applied', 'failed'].includes(response.phase)) {
          // Publish a confirmed mutation before clearing its pending lock. Peer
          // model observations must expire even if this directory GET then fails.
          if (response.phase === 'applied') notifyApplied(response);
          setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
          requireRecovery();
          if (response.phase === 'applied') recovery.current.pendingSaved = response;
        }
        remember(response);
        recovery.current.cause = '';
        if (['applied', 'failed'].includes(response.phase)) await read();
      } catch (cause) {
        if (mounted.current && current.current === original) {
          recovery.current.cause = safeError(cause);
          setError(`提供商更改正在后台核对：${safeError(cause)}`);
        }
      } finally {
        if (mounted.current && current.current === original) flight.current = false;
      }
    } else if (recovery.current.needsRead) await read();
  };
  const unresolvedSubmissions = originals.filter((submission) => submission.phase === 'unknown');
  const unresolvedNotice = unresolvedSubmissions.length > 0 && (
    <section className="provider-pending" aria-label="待确认的提供商更改">
      {unresolvedSubmissions.map((submission) => (
        <div className="provider-notice" key={submission.commandId}>
          <p role="status">
            {submission.operation.name ||
              facts?.providers.find((entry) => entry.id === submission.operation.provider)?.label ||
              submission.operation.provider}
            ：{submission.operation.kind === 'remove' ? '删除' : '保存'}结果待确认。
            {facts && submission.storeId !== facts.storeId && '此更改来自先前的数据源。'}
          </p>
          <button
            className="provider-button"
            type="button"
            disabled={reading || writing}
            onClick={() => void lookup(submission)}
          >
            查看结果
          </button>
        </div>
      ))}
    </section>
  );
  return (
    <section
      aria-label={models ? '提供商与模型设置' : '提供商设置'}
      className={`provider-settings${models ? ' provider-model-settings' : ''}`}
      aria-busy={reading || models?.reading || undefined}
    >
      <header className="provider-page-heading">
        <div>
          <h2>{models ? '提供商与模型' : '提供商'}</h2>
          <p>
            {models ? '连接模型服务，管理可用模型。' : '连接你的模型服务，按需配置接口与模型。'}
          </p>
        </div>
        <div className="provider-page-actions">
          {!models && (
            <button
              className="provider-button provider-refresh"
              type="button"
              aria-label="刷新提供商配置"
              disabled={reading || writing}
              onClick={() => void read()}
            >
              <ProviderIcon name="refresh" />
              <span>刷新配置</span>
            </button>
          )}
          <button
            ref={addButton}
            aria-expanded={panelMode === 'add'}
            aria-controls={panelMode === 'add' ? `${fieldId}-editor` : undefined}
            className="provider-button provider-save"
            type="button"
            disabled={!facts}
            onClick={(event) => add(event.currentTarget)}
          >
            <ProviderIcon name="plus" />
            新增提供商
          </button>
        </div>
      </header>
      {!panelMode && error && (
        <p className="provider-notice provider-notice-error" role="alert">
          {error}
        </p>
      )}
      {models && (
        <div className="settings-models provider-model-feedback">
          <NativeModelSettingsFeedback state={models} />
        </div>
      )}
      <div className="provider-workspace">
        <div className="provider-directory">
          <div className="provider-directory-heading">
            <span>已添加的提供商</span>
            <span>{facts ? entries.length : '—'}</span>
          </div>
          <ul aria-label="提供商列表" className="provider-instance-list">
            {entries.map(({ provider: entry, connection: item }) => {
              const label = connectionLabel(entry, item);
              const selected =
                providerId === entry.id && connectionId === item.id && panelMode !== 'add';
              return (
                <li
                  className="provider-instance"
                  key={`${entry.id}/${item.id}`}
                  data-selected={selected || undefined}
                >
                  <div className="provider-connection-heading">
                    <ProviderMark provider={entry.id} />
                    <div className="provider-instance-info">
                      <strong>{label}</strong>
                      <span>
                        {presetLabel(entry)} · {protocolLabel(item.protocol)}
                        {!models && ` · ${item.modelNames.length} 个模型`}
                      </span>
                      {entry.id === 'codex' && <span>由本机 Codex 登录管理，自动复用认证。</span>}
                    </div>
                    <span className={`provider-badge${item.canWrite ? ' is-configured' : ''}`}>
                      <span className="provider-status-dot" />
                      {entry.id === 'codex' ? '自动接入' : item.canWrite ? '已配置' : '只读'}
                    </span>
                    {entry.id !== 'codex' && (
                      <div className="provider-instance-actions">
                        <button
                          className="provider-button"
                          type="button"
                          aria-label={`编辑 ${label}`}
                          aria-expanded={selected && panelMode === 'edit'}
                          aria-controls={selected ? `${fieldId}-editor` : undefined}
                          onClick={(event) => choose(entry, item, 'edit', event.currentTarget)}
                        >
                          编辑
                        </button>
                        <button
                          className="provider-button provider-delete-link"
                          type="button"
                          aria-label={`删除 ${label}`}
                          aria-expanded={selected && panelMode === 'remove'}
                          aria-controls={selected ? `${fieldId}-editor` : undefined}
                          onClick={(event) => choose(entry, item, 'remove', event.currentTarget)}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                  {models && (
                    <section
                      className="provider-connection-models settings-models"
                      aria-label={`${label} 的模型`}
                    >
                      <NativeConnectionModels
                        state={models}
                        label={label}
                        modelIds={connectionModels.get(JSON.stringify([entry.id, item.id])) ?? []}
                      />
                    </section>
                  )}
                </li>
              );
            })}
          </ul>
          {models && !!unassignedModels?.length && (
            <section className="provider-other-models settings-models" aria-label="其他模型">
              <h3>其他模型</h3>
              <p>尚未关联连接的模型。</p>
              <NativeConnectionModels state={models} label="其他模型" modelIds={unassignedModels} />
            </section>
          )}
          {facts && !entries.length && (
            <div className="provider-empty">
              <ProviderIcon name="connection" />
              <h3>尚未添加提供商</h3>
              <p>添加一个模型服务，开始配置你的模型。</p>
              <button
                className="provider-button"
                type="button"
                onClick={(event) => add(event.currentTarget)}
              >
                添加第一个提供商
              </button>
            </div>
          )}
        </div>
        {panelMode &&
          panelHost &&
          createPortal(
            <RightSidebar
              id={`${fieldId}-editor`}
              label={provider ? `${editingLabel} 配置` : '新增提供商'}
              title={panelTitle}
              onClose={close}
            >
              <div className="provider-settings provider-panel-content">
                {!provider ? (
                  <p className="provider-notice" role="status">
                    正在后台读取提供商配置。
                  </p>
                ) : panelMode !== 'add' && !connection ? (
                  <div className="provider-editor">
                    <div className="provider-editor-body">
                      <p className="provider-notice" role="status">
                        此提供商已不在最新配置中，请返回列表重新选择。
                      </p>
                    </div>
                    <footer className="provider-editor-footer">
                      <button className="provider-button" type="button" onClick={close}>
                        返回列表
                      </button>
                    </footer>
                  </div>
                ) : panelMode === 'remove' && connection ? (
                  <form
                    className="provider-editor"
                    aria-label={`删除 ${editingLabel} 确认`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    <header className="provider-editor-heading">
                      <ProviderMark provider={provider.id} />
                      <div>
                        <h3>{editingLabel}</h3>
                        <p>删除前确认影响范围</p>
                      </div>
                    </header>
                    <div className="provider-editor-body">
                      {draftStale && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {panelMode === 'remove'
                            ? '已重新读取配置。请从列表重新打开此提供商，重新确认删除影响。'
                            : '已重新读取配置，当前草稿已保留。请从列表重新打开此提供商，核对最新配置后再提交。'}
                        </p>
                      )}
                      {error && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {error}
                        </p>
                      )}
                      <section className="provider-removal-impact" aria-label="删除影响">
                        <h4>将删除 {connection.modelNames.length} 个关联模型</h4>
                        {connection.modelNames.length ? (
                          <ul>
                            {connection.modelNames.map((model, index) => (
                              <li key={`${index}/${model}`}>{model}</li>
                            ))}
                          </ul>
                        ) : (
                          <p>此提供商没有关联模型。</p>
                        )}
                        <p>仅删除此连接及其模型配置。系统凭证库中的 API key 会保留。</p>
                        <p>不会自动选择替代模型，也不会修改已经开始的运行。</p>
                        {connection.defaultModelIds?.length ? (
                          <p className="provider-notice provider-notice-error" role="alert">
                            此提供商包含当前全局默认模型，暂时无法删除。
                          </p>
                        ) : (
                          <p>不影响当前全局默认模型。</p>
                        )}
                        {connection.scheduledTaskNames?.length ? (
                          <div className="provider-notice provider-notice-error" role="alert">
                            <p>以下定时任务正在使用此提供商的模型，请先修改或删除这些任务：</p>
                            <ul>
                              {connection.scheduledTaskNames.map((task, index) => (
                                <li key={`${index}/${task}`}>{task}</li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p>没有定时任务引用此提供商的模型。</p>
                        )}
                      </section>
                      {pending && !unresolvedSubmissions.length && (
                        <p className="provider-notice" role="status">
                          有提供商更改尚未确认，暂时无法保存。
                        </p>
                      )}
                      {facts && !facts.canWrite && !pending && !reading && (
                        <p className="provider-notice" role="status">
                          当前配置不可写，请检查配置诊断。
                        </p>
                      )}
                      {unresolvedNotice}
                    </div>
                    <footer className="provider-editor-footer">
                      <button
                        ref={cancelField}
                        className="provider-button"
                        type="button"
                        onClick={close}
                      >
                        取消
                      </button>
                      <button
                        className="provider-button provider-remove"
                        type="submit"
                        disabled={!writable || blockedRemoval}
                      >
                        {writing ? '正在删除…' : '确认删除提供商'}
                      </button>
                    </footer>
                  </form>
                ) : (
                  <form
                    className="provider-editor"
                    aria-label={`${editingLabel} 配置`}
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    <header className="provider-editor-heading">
                      <ProviderMark provider={provider.id} />
                      <div>
                        <h3>{editingLabel}</h3>
                        <p>{connection ? presetLabel(provider) : '添加新的模型连接'}</p>
                      </div>
                    </header>
                    <div className="provider-editor-body">
                      {draftStale && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {panelMode === 'remove'
                            ? '已重新读取配置。请从列表重新打开此提供商，重新确认删除影响。'
                            : '已重新读取配置，当前草稿已保留。请从列表重新打开此提供商，核对最新配置后再提交。'}
                        </p>
                      )}
                      {error && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          {error}
                        </p>
                      )}
                      <section
                        className="provider-form-section"
                        aria-labelledby={`${fieldId}-connection-heading`}
                      >
                        <h4 id={`${fieldId}-connection-heading`}>
                          <ProviderIcon name="connection" />
                          连接设置
                        </h4>
                        <div className="provider-form-grid">
                          {panelMode === 'add' && (
                            <label className="provider-field">
                              <span>服务商预设</span>
                              <select
                                ref={presetField}
                                aria-label="服务商预设"
                                value={provider.id}
                                disabled={writing}
                                onChange={(event) => {
                                  const preset = facts?.providers.find(
                                    (entry) =>
                                      entry.id !== 'codex' &&
                                      entry.id === event.currentTarget.value,
                                  );
                                  if (preset) choose(preset);
                                }}
                              >
                                {facts?.providers
                                  .filter((entry) => entry.id !== 'codex')
                                  .map((entry) => (
                                    <option key={entry.id} value={entry.id}>
                                      {presetLabel(entry)}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          )}
                          <label className="provider-field">
                            <span>提供商名称</span>
                            <input
                              ref={nameField}
                              aria-label="提供商名称"
                              aria-describedby={
                                fieldError?.field === 'name' ? `${fieldId}-name-error` : undefined
                              }
                              maxLength={80}
                              value={name}
                              disabled={writing}
                              aria-invalid={fieldError?.field === 'name'}
                              onInput={(event) => {
                                setName(event.currentTarget.value);
                                setFieldError(undefined);
                              }}
                            />
                          </label>
                          {fieldError?.field === 'name' && (
                            <p
                              className="provider-field-error"
                              id={`${fieldId}-name-error`}
                              role="alert"
                            >
                              {fieldError.message}
                            </p>
                          )}
                          {supportsResponses(provider.id) && (
                            <label className="provider-field">
                              <span>API 协议</span>
                              <select
                                aria-label="API 协议"
                                aria-describedby={`${fieldId}-protocol-help`}
                                value={protocol}
                                disabled={writing}
                                onChange={(event) => {
                                  setProtocol(event.currentTarget.value as Protocol);
                                }}
                              >
                                <option value="chat-completions">Chat Completions</option>
                                <option value="responses">Responses</option>
                              </select>
                            </label>
                          )}
                        </div>
                        {supportsResponses(provider.id) && (
                          <p className="provider-field-help" id={`${fieldId}-protocol-help`}>
                            按服务商支持的接口选择；现有配置默认使用 Chat Completions。
                          </p>
                        )}
                        <label className="provider-field">
                          <span>服务地址</span>
                          <input
                            ref={urlField}
                            aria-label="服务地址"
                            aria-describedby={
                              fieldError?.field === 'url'
                                ? `${fieldId}-url-error`
                                : `${fieldId}-url-help`
                            }
                            type="text"
                            spellCheck={false}
                            placeholder="https://api.example.com/v1"
                            value={baseURL}
                            disabled={writing}
                            aria-invalid={fieldError?.field === 'url'}
                            onInput={(event) => {
                              setBaseURL(event.currentTarget.value);
                              setFieldError(undefined);
                            }}
                          />
                        </label>
                        {fieldError?.field === 'url' ? (
                          <p
                            className="provider-field-error"
                            id={`${fieldId}-url-error`}
                            role="alert"
                          >
                            {fieldError.message}
                          </p>
                        ) : (
                          <p className="provider-field-help" id={`${fieldId}-url-help`}>
                            填写 API 基础地址，无需追加 /chat/completions 或 /responses。
                          </p>
                        )}
                      </section>
                      <section
                        className="provider-form-section"
                        aria-labelledby={`${fieldId}-credential-heading`}
                      >
                        <h4 id={`${fieldId}-credential-heading`}>
                          <ProviderIcon name="shield" />
                          访问凭据
                        </h4>
                        <label className="provider-field">
                          <span>凭据</span>
                          <select
                            aria-label="凭据处理"
                            value={credential}
                            disabled={writing}
                            onChange={(event) => {
                              setCredential(
                                event.currentTarget.value as NativeProviderOperation['credential'],
                              );
                              setSecret('');
                              setFieldError(undefined);
                            }}
                          >
                            {connection?.hasCredential && (
                              <option value="keep">保留已保存凭据</option>
                            )}
                            <option value="replace">保存新 API key</option>
                            {!provider.requiresCredential && (
                              <option value="none">不使用凭据</option>
                            )}
                          </select>
                        </label>
                        {credential === 'replace' && (
                          <label className="provider-field">
                            <span>
                              API key <span className="provider-field-optional">仅用于此连接</span>
                            </span>
                            <input
                              ref={keyField}
                              aria-label="API key"
                              aria-describedby={
                                fieldError?.field === 'key'
                                  ? `${fieldId}-key-error`
                                  : `${fieldId}-key-help`
                              }
                              autoComplete="off"
                              spellCheck={false}
                              type="password"
                              placeholder="输入 API key"
                              value={secret}
                              disabled={writing}
                              aria-invalid={fieldError?.field === 'key'}
                              onInput={(event) => {
                                setSecret(event.currentTarget.value);
                                setFieldError(undefined);
                              }}
                            />
                          </label>
                        )}
                        {fieldError?.field === 'key' ? (
                          <p
                            className="provider-field-error"
                            id={`${fieldId}-key-error`}
                            role="alert"
                          >
                            {fieldError.message}
                          </p>
                        ) : (
                          <p className="provider-field-help" id={`${fieldId}-key-help`}>
                            {credential === 'keep'
                              ? '继续使用已保存的凭据，无需重新输入。'
                              : credential === 'none'
                                ? '此连接不会附带 API key。'
                                : '提交后清空输入，密钥不会回显。'}
                          </p>
                        )}
                      </section>
                      <section
                        className="provider-form-section"
                        aria-labelledby={`${fieldId}-models-heading`}
                      >
                        <h4 id={`${fieldId}-models-heading`}>
                          <ProviderIcon name="models" />
                          连接模型目录
                        </h4>
                        <label className="provider-field">
                          <span>
                            模型名称 <span className="provider-field-optional">可选</span>
                          </span>
                          <textarea
                            aria-label="模型名称"
                            aria-describedby={`${fieldId}-models-help`}
                            rows={3}
                            spellCheck={false}
                            placeholder="每行输入一个模型名称"
                            value={modelNames}
                            disabled={writing}
                            onInput={(event) => setModelNames(event.currentTarget.value)}
                          />
                        </label>
                        <p className="provider-field-help" id={`${fieldId}-models-help`}>
                          每行一个准确模型名称；留空时保存会查询该连接的模型目录。
                        </p>
                      </section>
                      {pending && !unresolvedSubmissions.length && (
                        <p className="provider-notice" role="status">
                          有提供商更改尚未确认，暂时无法保存。
                        </p>
                      )}
                      {facts && !facts.canWrite && !pending && !reading && (
                        <p className="provider-notice" role="status">
                          当前配置不可写，请检查配置诊断。
                        </p>
                      )}
                      {unresolvedNotice}
                    </div>
                    <footer className="provider-editor-footer">
                      <button className="provider-button" type="button" onClick={close}>
                        取消
                      </button>
                      <button
                        className="provider-button provider-save"
                        type="submit"
                        disabled={!writable}
                      >
                        {writing ? '正在保存…' : '保存提供商配置'}
                      </button>
                    </footer>
                  </form>
                )}
              </div>
            </RightSidebar>,
            panelHost,
          )}
      </div>
      {facts?.errors.map((code) => (
        <p className="provider-notice provider-notice-error" role="alert" key={code}>
          {code}
        </p>
      ))}
      {!panelMode && unresolvedNotice}
    </section>
  );
}
