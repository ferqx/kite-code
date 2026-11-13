import { Button, Input, RightSidebar, Textarea } from '@kite-ai/ui/desktop';
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
import { NativeToast, type NativeToastProps } from './native-message';
import {
  NativeModelSettingsFeedback,
  type NativeModelSettingsState,
} from './native-model-settings';
import {
  type CompatibleProviderPreset,
  compatibleProviderPresets,
} from './native-provider-presets';
import { NativeSettingsSelect } from './native-settings-select';

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
function removalBlockedMessage(code: string) {
  if (code === 'provider_default_model_in_use') return '请先在配置文件中改用其他默认模型。';
  if (code === 'provider_scheduled_model_in_use')
    return '仍有定时任务使用此连接，请先改用其他模型或等待运行结束。';
  if (code === 'configuration_observation_changed') return '配置已更新，请重新确认删除。';
  return undefined;
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
function modelIds(text: string) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
function directoryError(code: string) {
  switch (code) {
    case 'provider_discovery_auth_failed':
      return '服务商拒绝访问模型目录，请检查 API key 和服务地址。';
    case 'provider_discovery_endpoint_mismatch':
      return '服务地址已修改。请填写该地址对应的新 API key，再获取目录。';
    case 'provider_discovery_empty':
      return '服务商返回的模型目录为空，可以手动填写模型 ID。';
    case 'configuration_read_set_conflict':
    case 'configuration_observation_changed':
      return '配置已变化，请重新打开设置后再试。';
    default:
      return `无法获取模型目录（${code}），可重试或手动填写模型 ID。`;
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
  toastHost,
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
  toastHost?: HTMLElement | null;
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
  const [compatiblePreset, setCompatiblePreset] = useState<CompatibleProviderPreset>();
  const [panelMode, setPanelMode] = useState<PanelMode>();
  const confirmingRemoval = useRef(false);
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
  const [directory, setDirectory] = useState<{
    names?: string[];
    error?: string;
    loading?: boolean;
  }>({});
  const directoryRead = useRef<string | undefined>(undefined);
  const [fieldError, setFieldError] = useState<{
    field: 'name' | 'url' | 'key' | 'models';
    message: string;
  }>();
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false),
    [writing, setWriting] = useState(false);
  const [dismissedError, setDismissedError] = useState<string>();
  useEffect(() => {
    if (!error) setDismissedError(undefined);
  }, [error]);
  const [local, setLocal] = useState<NativeProviderSubmission[]>([]);
  const [lookupCompletion, setLookupCompletion] = useState(0);
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
  const pendingWatchers = useRef(new Map<string, NativeProviderSubmission>());
  const handledTerminals = useRef(new Set<string>());
  const recoveryAction = useRef<() => Promise<void>>(async () => {});
  const recoveryContext = useRef<{ originals: NativeProviderSubmission[]; storeId?: string }>({
    originals: [],
  });
  const recoveredCallback = useRef(onRecovered);
  recoveredCallback.current = onRecovered;

  const nameField = useRef<HTMLInputElement>(null),
    presetField = useRef<HTMLButtonElement>(null),
    addButton = useRef<HTMLButtonElement>(null),
    urlField = useRef<HTMLInputElement>(null),
    keyField = useRef<HTMLInputElement>(null),
    modelsField = useRef<HTMLTextAreaElement>(null),
    directoryButton = useRef<HTMLButtonElement>(null),
    directoryList = useRef<HTMLUListElement>(null);
  const directoryVisible = !!directory.names;
  useLayoutEffect(() => {
    if (directoryVisible && directoryButton.current === document.activeElement)
      directoryList.current?.scrollIntoView?.({ block: 'nearest' });
  }, [directoryVisible]);
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
  const requiresCredential = !!compatiblePreset || provider?.requiresCredential;
  const selectedModels = new Set(modelIds(modelNames));
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
  const panelTitle = panelMode === 'edit' ? '编辑提供商' : '新增提供商';
  const editingLabel =
    provider && connection
      ? connectionLabel(provider, connection)
      : provider
        ? (compatiblePreset?.label ?? presetLabel(provider))
        : '选择服务商预设';
  function remember(submission: NativeProviderSubmission) {
    settleSent(submission);
    if (
      current.current === identity &&
      submission.storeId === recoveryContext.current.storeId &&
      ['applied', 'failed'].includes(submission.phase)
    )
      handledTerminals.current.add(JSON.stringify([submission.storeId, submission.commandId]));
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
  function invalidateDirectory() {
    const readId = directoryRead.current;
    directoryRead.current = undefined;
    setDirectory({});
    if (readId)
      void bridge
        .request({ method: 'settings.providers.discover.cancel', generation, readId })
        .catch(() => {});
  }
  async function read(afterSave?: 'upsert' | 'remove', force = false) {
    if (!force && readFlight.current?.request === sequence.current)
      return readFlight.current.promise;
    cancelRecovery();
    invalidateDirectory();
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
    pendingWatchers.current.clear();
    handledTerminals.current.clear();
    setAwaitingOriginalRecord(!!awaitingOriginal.current);
    if (awaitingOriginal.current) requireRecovery('network_outcome_unknown');
    previousRevision.current = revision;
    sequence.current++;
    setFacts(undefined);
    setProviderId(undefined);
    setCompatiblePreset(undefined);
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
      directoryRead.current = undefined;
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
  // A lookup owned by a closed view can settle through Main's watcher after reopening.
  // Reconcile only an exact original observed pending in this view; never replay it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Watcher identity/phase and flight completion drive reconciliation, not refreshed facts or callbacks.
  useEffect(() => {
    const storeId = recoveryContext.current.storeId;
    if (!mounted.current || current.current !== identity || !storeId) return;
    const visible = new Set<string>();
    let settled = false;
    for (const entry of originals) {
      if (entry.storeId !== storeId) continue;
      const key = JSON.stringify([entry.storeId, entry.commandId]);
      visible.add(key);
      if (['submitting', 'unknown'].includes(entry.phase)) {
        pendingWatchers.current.set(key, entry);
        continue;
      }
      const pending = pendingWatchers.current.get(key);
      if (
        !pending ||
        !['applied', 'failed'].includes(entry.phase) ||
        !matchesProviderChange(pending, entry)
      )
        continue;
      // The active request owns its reply. If that reply is lost, reconsider the
      // watcher after its flight ends; a handled reply must not trigger a second GET.
      if (flight.current) continue;
      pendingWatchers.current.delete(key);
      if (handledTerminals.current.has(key)) continue;
      handledTerminals.current.add(key);
      settleSent(entry);
      if (awaitingOriginal.current && matchesProviderChange(awaitingOriginal.current, entry)) {
        awaitingOriginal.current = undefined;
        setAwaitingOriginalRecord(false);
      }
      if (entry.phase === 'applied') {
        notifyApplied(entry);
        recovery.current.pendingSaved = entry;
      }
      requireRecovery();
      settled = true;
    }
    for (const key of pendingWatchers.current.keys())
      if (!visible.has(key)) pendingWatchers.current.delete(key);
    if (settled) {
      setFacts((previous) => (previous ? { ...previous, canWrite: false } : undefined));
      // Do not borrow a GET that began before this terminal receipt.
      void read(undefined, true);
    }
  }, [
    identity,
    recoveryKey,
    writing,
    lookupCompletion,
    facts?.storeId,
    selection?.storeId,
    models?.facts?.storeId,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A single timer reads the latest current-scope originals, never frozen watcher props.
  useEffect(() => {
    scheduleRecovery();
  }, [identity, recoveryKey, reading, writing, facts?.observationId]);
  function choose(
    entry: Provider,
    existing?: Connection,
    mode: PanelMode = 'add',
    button?: HTMLButtonElement,
    preset?: CompatibleProviderPreset,
  ) {
    invalidateDirectory();
    editorVersion.current++;
    if (button) origin.current = button;
    setPanelMode(mode);
    setProviderId(entry.id);
    setCompatiblePreset(preset);
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
    setName(existing ? connectionLabel(entry, existing) : (preset?.label ?? presetLabel(entry)));
    setProtocol(existing?.protocol ?? preset?.protocol ?? 'chat-completions');
    setBaseURL(existing?.baseURL ?? preset?.baseURL ?? entry.defaultBaseURL);
    setModelNames(existing?.modelNames.join('\n') ?? '');
    setSecret('');
    setCredential(
      existing?.hasCredential ? 'keep' : preset || entry.requiresCredential ? 'replace' : 'none',
    );
    setFieldError(undefined);
    setError('');
  }
  function add(button: HTMLButtonElement) {
    if (panelMode === 'add') return;
    const preset = facts?.providers.find((entry) => entry.id !== 'codex');
    if (preset) choose(preset, undefined, 'add', button);
  }
  async function remove(entry: Provider, item: Connection, button: HTMLButtonElement) {
    if (
      !facts?.canWrite ||
      !item.canWrite ||
      confirmingRemoval.current ||
      pending ||
      reading ||
      writing ||
      flight.current ||
      models?.reading ||
      models?.writing ||
      models?.pending
    )
      return;
    choose(entry, item, 'remove', button);
    const editing = editorVersion.current;
    const original = sequence.current;
    const isCurrent = () =>
      mounted.current && current.current === identity && editorVersion.current === editing;
    confirmingRemoval.current = true;
    try {
      const answer = await bridge.request({
        method: 'settings.providers.remove.confirm',
        generation,
        observationId: facts.observationId,
        provider: entry.id,
        connectionId: item.id,
      });
      if (!isCurrent()) return;
      if (!answer || !('kind' in answer) || answer.kind !== 'settings.providers.remove.confirmed') {
        close();
        return;
      }
      if (sequence.current !== original) throw Error('configuration_observation_changed');
    } catch (cause) {
      if (isCurrent()) {
        close();
        setError(removalBlockedMessage(safeError(cause)) ?? '无法打开删除确认，请重试。');
      }
      return;
    } finally {
      confirmingRemoval.current = false;
    }
    await submit({
      kind: 'remove',
      provider: entry.id,
      connectionId: item.id,
      baseURL: item.baseURL,
      ...(supportsResponses(entry.id) ? { protocol: item.protocol ?? 'chat-completions' } : {}),
      modelNames: [],
      credential: 'none',
    });
  }
  function close() {
    invalidateDirectory();
    restoreFocus.current = true;
    editorVersion.current++;
    if (readFlight.current) {
      readFlight.current = undefined;
      requireRecovery();
    }
    sequence.current++;
    setReading(false);
    setProviderId(undefined);
    setCompatiblePreset(undefined);
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
      editorControl.current =
        panelMode === 'add' || panelMode === 'edit'
          ? { close: () => closeCurrent.current() }
          : null;
    if (!panelMode && restoreFocus.current) {
      restoreFocus.current = false;
      (origin.current?.isConnected ? origin.current : addButton.current)?.focus();
    }
    if (panelMode && panelHost) {
      if (panelMode === 'add') presetField.current?.focus();
      else if (panelMode === 'edit') nameField.current?.focus();
    }
    return () => {
      if (editorControl) editorControl.current = null;
    };
  }, [providerId, compatiblePreset, connectionId, panelMode, panelHost, editorControl]);
  function validConnectionDraft() {
    if (!validEndpoint(baseURL.trim())) {
      setFieldError({ field: 'url', message: '请输入有效的 HTTP 或 HTTPS 服务地址。' });
      urlField.current?.focus();
      return false;
    }
    if (
      (credential === 'replace' && !secret.trim()) ||
      (requiresCredential && credential === 'none') ||
      (credential === 'keep' && !connection?.hasCredential)
    ) {
      setFieldError({ field: 'key', message: '请输入 API key。' });
      keyField.current?.focus();
      return false;
    }
    return true;
  }
  async function discover() {
    if (!facts || !provider || !writable || directoryRead.current || flight.current) return;
    if (!validConnectionDraft()) return;
    const readId = crypto.randomUUID();
    const original = identity;
    const currentRead = () =>
      mounted.current && current.current === original && directoryRead.current === readId;
    directoryRead.current = readId;
    setFieldError(undefined);
    setDirectory((previous) => ({ names: previous.names, loading: true }));
    try {
      const response = await bridge.request({
        method: 'settings.providers.discover',
        generation,
        observationId: facts.observationId,
        readId,
        operation: {
          provider: provider.id,
          connectionId,
          baseURL: baseURL.trim(),
          credential,
        },
        ...(credential === 'replace' ? { secret } : {}),
      });
      if (!currentRead()) return;
      if (
        !response ||
        !('modelNames' in response) ||
        response.kind !== 'settings.providers.directory'
      )
        throw Error('provider_discovery_invalid');
      if (!response.modelNames.length) throw Error('provider_discovery_empty');
      setDirectory({ names: response.modelNames });
    } catch (cause) {
      if (currentRead())
        setDirectory((previous) => ({
          names: previous.names,
          error: directoryError(safeError(cause)),
        }));
    } finally {
      if (currentRead()) directoryRead.current = undefined;
    }
  }
  async function save() {
    if (!facts || !provider || !writable || directoryRead.current || flight.current) return;
    if (!name.trim()) {
      setFieldError({ field: 'name', message: '请输入提供商名称。' });
      nameField.current?.focus();
      return;
    }
    if (!validConnectionDraft()) return;
    if ((compatiblePreset?.manualModel || directory.names) && !selectedModels.size) {
      setFieldError({ field: 'models', message: '请输入至少一个模型 ID。' });
      modelsField.current?.focus();
      return;
    }
    const operation: NativeProviderOperation = {
      kind: 'upsert',
      name: name.trim(),
      provider: provider.id,
      connectionId,
      baseURL: baseURL.trim(),
      ...(supportsResponses(provider.id) ? { protocol } : {}),
      modelNames: [...selectedModels],
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
        if (response.error)
          setError(
            (operation.kind === 'remove' && removalBlockedMessage(response.error)) ||
              `${action}失败：${response.error}`,
          );
      }
    } catch (cause) {
      const code = safeError(cause);
      const rejected = rejectedBeforeProviderDispatch(code);
      if (rejected && retained.get(original) === sent) retained.delete(original);
      if (mounted.current && current.current === original) {
        // IPC failure does not prove the Main intent was never created. Keep the
        // exact non-secret request locked until an authoritative original is found.
        if (!rejected) {
          awaitingOriginal.current = sent;
          setAwaitingOriginalRecord(true);
        }
        requireRecovery(code);
        if (editorVersion.current === editing)
          setError(
            rejected && operation.kind === 'remove'
              ? (removalBlockedMessage(code) ?? `删除失败：${code}`)
              : `${action}结果未确认，正在后台核对。`,
          );
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
        if (mounted.current && current.current === original) {
          flight.current = false;
          // Background lookups do not set writing. Revisit a watcher that arrived
          // during their flight even when the lookup's own reply was lost.
          setLookupCompletion((value) => value + 1);
        }
      }
    } else if (recovery.current.needsRead) await read();
  };
  const unresolvedSubmissions = originals.filter((submission) => submission.phase === 'unknown');
  const visibleError = error !== dismissedError ? error : '';
  const configurationReadOnly = facts && !facts.canWrite && !pending && !reading;
  let toast: NativeToastProps['message'];
  if (unresolvedSubmissions.length) {
    const actionName = (submission: NativeProviderSubmission) =>
      submission.operation.kind === 'remove' ? '删除' : '保存';
    const label = (submission: NativeProviderSubmission) =>
      submission.operation.name ||
      facts?.providers.find((entry) => entry.id === submission.operation.provider)?.label ||
      submission.operation.provider;
    const [first] = unresolvedSubmissions;
    const multiple = unresolvedSubmissions.length > 1;
    toast = {
      id: 1,
      text: [
        multiple
          ? '有提供商更改结果待确认。'
          : `${label(first!)}：${actionName(first!)}结果待确认。`,
        !multiple && facts && first!.storeId !== facts.storeId && '此更改来自先前的数据源。',
        visibleError,
      ]
        .filter(Boolean)
        .join('\n'),
      actions: unresolvedSubmissions.map((submission) => ({
        label: multiple ? `查看 ${label(submission)} 的${actionName(submission)}结果` : '查看结果',
        disabled: reading || writing,
        onClick: () => void lookup(submission),
      })),
    };
  } else if (visibleError) {
    toast = { id: 0, role: 'alert', text: visibleError };
  } else if (pending && !writing) {
    toast = { id: 2, text: '有提供商更改尚未确认，暂时无法保存。' };
  } else if (panelMode && configurationReadOnly && !error) {
    toast = { id: 3, text: '当前配置不可写，请检查配置诊断。' };
  }
  return (
    <section
      aria-label={models ? '提供商与模型设置' : '提供商设置'}
      className={`provider-settings${models ? ' provider-model-settings' : ''}`}
      aria-busy={reading || models?.reading || undefined}
    >
      <header className="settings-page-heading">
        <div>
          <h2>{models ? '提供商与模型' : '提供商'}</h2>
          <p>
            {models ? '连接模型服务，管理可用模型。' : '连接你的模型服务，按需配置接口与模型。'}
          </p>
        </div>
        <div className="provider-page-actions">
          {!models && (
            <Button
              className="provider-button provider-refresh"
              type="button"
              aria-label="刷新提供商配置"
              disabled={reading || writing}
              onClick={() => void read()}
            >
              <ProviderIcon name="refresh" />
              <span>刷新配置</span>
            </Button>
          )}
          <Button
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
          </Button>
        </div>
      </header>
      <NativeToast
        key={toast?.id === 0 ? visibleError : undefined}
        container={toastHost ?? undefined}
        message={toast}
        onDismiss={toast?.id === 0 ? () => setDismissedError(error) : undefined}
      />
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
                        <Button
                          className="provider-button"
                          type="button"
                          aria-label={`编辑 ${label}`}
                          aria-expanded={selected && panelMode === 'edit'}
                          aria-controls={selected ? `${fieldId}-editor` : undefined}
                          onClick={(event) => choose(entry, item, 'edit', event.currentTarget)}
                        >
                          编辑
                        </Button>
                        <Button
                          className="provider-button provider-delete-link"
                          type="button"
                          aria-label={`删除 ${label}`}
                          aria-haspopup="dialog"
                          aria-disabled={
                            !facts?.canWrite ||
                            !item.canWrite ||
                            pending ||
                            reading ||
                            writing ||
                            models?.reading ||
                            models?.writing ||
                            models?.pending ||
                            undefined
                          }
                          aria-busy={(selected && panelMode === 'remove' && writing) || undefined}
                          onClick={(event) => void remove(entry, item, event.currentTarget)}
                        >
                          {selected && panelMode === 'remove' && writing ? '正在删除…' : '删除'}
                        </Button>
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
              <Button
                className="provider-button"
                type="button"
                onClick={(event) => add(event.currentTarget)}
              >
                添加第一个提供商
              </Button>
            </div>
          )}
        </div>
        {panelMode &&
          panelMode !== 'remove' &&
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
                  <div className="provider-editor right-sidebar-editor">
                    <div className="provider-editor-body right-sidebar-editor-body">
                      <p className="provider-notice" role="status">
                        此提供商已不在最新配置中，请返回列表重新选择。
                      </p>
                    </div>
                    <footer className="provider-editor-footer right-sidebar-editor-footer">
                      <Button className="provider-button" type="button" onClick={close}>
                        返回列表
                      </Button>
                    </footer>
                  </div>
                ) : (
                  <form
                    className="provider-editor right-sidebar-editor"
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
                    <div className="provider-editor-body right-sidebar-editor-body">
                      {draftStale && (
                        <p className="provider-notice provider-notice-error" role="alert">
                          已重新读取配置，当前草稿已保留。请从列表重新打开此提供商，核对最新配置后再提交。
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
                            <label className="provider-field" htmlFor={`${fieldId}-field-1`}>
                              <span>服务商预设</span>
                              <NativeSettingsSelect
                                id={`${fieldId}-field-1`}
                                ref={presetField}
                                aria-label="服务商预设"
                                value={compatiblePreset?.id ?? provider.id}
                                disabled={writing}
                                onValueChange={(value) => {
                                  const preset = compatibleProviderPresets.find(
                                    (entry) => entry.id === value,
                                  );
                                  const family = facts?.providers.find(
                                    (entry) =>
                                      entry.id !== 'codex' &&
                                      entry.id === (preset ? 'compatible' : value),
                                  );
                                  if (family) choose(family, undefined, 'add', undefined, preset);
                                }}
                                options={
                                  facts?.providers.flatMap((entry) => {
                                    if (entry.id === 'codex') return [];
                                    const option = { value: entry.id, label: presetLabel(entry) };
                                    return entry.id === 'compatible'
                                      ? [
                                          ...compatibleProviderPresets.map(({ id, label }) => ({
                                            value: id,
                                            label,
                                          })),
                                          option,
                                        ]
                                      : [option];
                                  }) ?? []
                                }
                              />
                            </label>
                          )}
                          <label className="provider-field" htmlFor={`${fieldId}-field-2`}>
                            <span>提供商名称</span>
                            <Input
                              id={`${fieldId}-field-2`}
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
                            <label className="provider-field" htmlFor={`${fieldId}-field-3`}>
                              <span>API 协议</span>
                              <NativeSettingsSelect
                                id={`${fieldId}-field-3`}
                                aria-label="API 协议"
                                aria-describedby={`${fieldId}-protocol-help`}
                                value={protocol}
                                disabled={writing}
                                onValueChange={(value) => {
                                  setProtocol(value as Protocol);
                                }}
                                options={[
                                  { value: 'chat-completions', label: 'Chat Completions' },
                                  { value: 'responses', label: 'Responses' },
                                ]}
                              />
                            </label>
                          )}
                        </div>
                        {supportsResponses(provider.id) && (
                          <p className="provider-field-help" id={`${fieldId}-protocol-help`}>
                            按服务商支持的接口选择；现有配置默认使用 Chat Completions。
                          </p>
                        )}
                        <label className="provider-field" htmlFor={`${fieldId}-field-4`}>
                          <span>服务地址</span>
                          <Input
                            id={`${fieldId}-field-4`}
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
                              invalidateDirectory();
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
                        <label className="provider-field" htmlFor={`${fieldId}-field-5`}>
                          <span>凭据</span>
                          <NativeSettingsSelect
                            id={`${fieldId}-field-5`}
                            aria-label="凭据处理"
                            value={credential}
                            disabled={writing}
                            onValueChange={(value) => {
                              invalidateDirectory();
                              setCredential(value as NativeProviderOperation['credential']);
                              setSecret('');
                              setFieldError(undefined);
                            }}
                            options={[
                              ...(connection?.hasCredential
                                ? [{ value: 'keep', label: '保留已保存凭据' }]
                                : []),
                              { value: 'replace', label: '保存新 API key' },
                              ...(!requiresCredential
                                ? [{ value: 'none', label: '不使用凭据' }]
                                : []),
                            ]}
                          />
                        </label>
                        {credential === 'replace' && (
                          <label className="provider-field" htmlFor={`${fieldId}-field-6`}>
                            <span>
                              API key <span className="provider-field-optional">仅用于此连接</span>
                            </span>
                            <Input
                              id={`${fieldId}-field-6`}
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
                                invalidateDirectory();
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
                                : (compatiblePreset?.keyHelp ?? '提交后清空输入，密钥不会回显。')}
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
                        <div className="provider-field">
                          <div className="provider-model-directory-header">
                            <label
                              className="provider-model-directory-label"
                              htmlFor={`${fieldId}-field-7`}
                            >
                              模型名称{' '}
                              {!compatiblePreset?.manualModel && !directory.names && (
                                <span className="provider-field-optional">可选</span>
                              )}
                            </label>
                            <Button
                              className="provider-button"
                              type="button"
                              ref={directoryButton}
                              disabled={!writable}
                              aria-disabled={directory.loading || undefined}
                              aria-busy={directory.loading || undefined}
                              onClick={() => void discover()}
                            >
                              {directory.loading ? '正在获取…' : '获取模型目录'}
                            </Button>
                          </div>
                          <Textarea
                            id={`${fieldId}-field-7`}
                            ref={modelsField}
                            aria-label="模型名称"
                            aria-describedby={
                              fieldError?.field === 'models'
                                ? `${fieldId}-models-error`
                                : `${fieldId}-models-help`
                            }
                            aria-invalid={fieldError?.field === 'models'}
                            rows={3}
                            spellCheck={false}
                            placeholder="每行输入一个模型名称"
                            value={modelNames}
                            disabled={writing}
                            onInput={(event) => {
                              setModelNames(event.currentTarget.value);
                              if (fieldError?.field === 'models') setFieldError(undefined);
                            }}
                          />
                        </div>
                        {fieldError?.field === 'models' ? (
                          <p
                            className="provider-field-error"
                            id={`${fieldId}-models-error`}
                            role="alert"
                          >
                            {fieldError.message}
                          </p>
                        ) : (
                          <p className="provider-field-help" id={`${fieldId}-models-help`}>
                            {directory.names
                              ? '勾选要保存的模型，也可手动填写模型 ID，每行一个。'
                              : compatiblePreset?.manualModel
                                ? '获取目录后勾选模型，或手动填写模型 ID，每行一个。'
                                : '每行一个准确模型名称；留空时保存会查询该连接的模型目录。'}
                          </p>
                        )}
                        {directory.error && (
                          <p className="provider-field-error" role="alert">
                            {directory.error}
                          </p>
                        )}
                        {directory.names && (
                          <>
                            <p className="provider-field-help" role="status">
                              获取到 {directory.names.length} 个模型
                            </p>
                            <ul
                              ref={directoryList}
                              className="provider-model-directory"
                              aria-label="服务商模型目录"
                            >
                              {directory.names.map((model) => (
                                <li key={model}>
                                  <label className="provider-model-directory-row">
                                    <input
                                      type="checkbox"
                                      checked={selectedModels.has(model)}
                                      disabled={writing}
                                      onChange={(event) => {
                                        const checked = event.currentTarget.checked;
                                        setModelNames((previous) => {
                                          const next = new Set(modelIds(previous));
                                          if (checked) next.add(model);
                                          else next.delete(model);
                                          return [...next].join('\n');
                                        });
                                        if (fieldError?.field === 'models')
                                          setFieldError(undefined);
                                      }}
                                    />
                                    <span>{model}</span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </section>
                    </div>
                    <footer className="provider-editor-footer right-sidebar-editor-footer">
                      <Button className="provider-button" type="button" onClick={close}>
                        取消
                      </Button>
                      <Button
                        className="provider-button provider-save"
                        type="submit"
                        disabled={!writable || directory.loading}
                        aria-busy={writing || undefined}
                      >
                        {writing ? '正在保存…' : '保存提供商配置'}
                      </Button>
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
    </section>
  );
}
