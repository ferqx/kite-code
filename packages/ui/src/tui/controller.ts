import type { ModelSettingsRequest, ModelSettingsView } from '@kite-ai/client';
import {
  type AnswerInteractionRequest,
  type CancelCommandRequest,
  ClientError,
  type Command,
  decodeJobReportResumeCommand,
  decodeRunResumeCommand,
  decodeSessionRecoveryCommand,
  type ExecutionOutputPage,
  type FollowUpCommandRequest,
  type Interaction,
  interactionAttachment,
  type Message,
  type ModelOutputSnapshot,
  requiresInteractionAttachment,
  type SessionView,
  type StartCommandRequest,
  type SteerCommandRequest,
} from '@kite-ai/client';
import {
  callerKey,
  type TuiCallerIntent,
  type TuiCallerOutcome,
  type TuiCallerPort,
  type TuiCallerRequest,
} from './caller';
import { interactionKey } from './cards';
import { parseTuiCommand } from './commands';
import type { TuiDraftPort, TuiDraftScope } from './drafts';
import {
  jobStopReceipt,
  originalJob,
  readChildLog,
  readJobOutput,
  type TuiChildLog,
  type TuiExecutionPort,
  type TuiJobStop,
  type TuiJobTarget,
} from './executions';
import type { TuiExportPort, TuiLoadedTextExport } from './export';
import type { FileToken, TuiFileCandidatesPort, TuiFileScope } from './file-candidates';
import type {
  TuiFileRecoveryPort,
  TuiManagementIntent,
  TuiManagementOutcome,
  TuiManagementPort,
} from './management';
import type { TuiMcpIntent, TuiMcpOutcome, TuiMcpPort, TuiMcpSnapshot } from './mcp';
import {
  mcpAuthRequest,
  type TuiMcpAuthAction,
  type TuiMcpAuthOutcome,
  type TuiMcpAuthPort,
  type TuiMcpAuthStatus,
} from './mcp-auth';
import type { TuiMcpConnectionIntent, TuiMcpConnectionOutcome } from './mcp-connection';
import type { TuiMcpReconnectionObservation, TuiMcpReconnectionOutcome } from './mcp-reconnection';
import {
  parseReconnectionIntent,
  reconnectionCarrier,
  sameReconnectionValue,
} from './mcp-reconnection-state';
import type {
  TuiMcpSourceSnapshot as MutationSnapshot,
  TuiMcpSourceApprovalIntent,
  TuiMcpSourceApprovalOutcome,
  TuiMcpSourceSnapshot,
} from './mcp-source';
import type {
  TuiMcpSourceEntryPreview,
  TuiMcpSourceMutationInput,
  TuiMcpSourceMutationIntent,
  TuiMcpSourceMutationOutcome,
} from './mcp-source-mutation';
import { reviewableMcpSource } from './mcp-source-question';
import { sameMcpToolsOrigin, type TuiMcpToolsState } from './mcp-tools';
import type { TuiModelIntent, TuiModelOutcome, TuiModelPort } from './models';
import type {
  TuiPermissionIntent,
  TuiPermissionOutcome,
  TuiPermissionPort,
  TuiPermissionSnapshot,
} from './permissions';
import {
  defaultTuiPreferences,
  type TuiPreferenceEdit,
  type TuiPreferencePort,
  type TuiPreferences,
  verifyTuiPreferences,
} from './preferences';
import {
  parseTuiRecoveryIntent,
  type TuiRecoveryIntent,
  type TuiRecoveryOutcome,
  type TuiRecoveryPort,
} from './recovery';
import { manualWorkflow, type TuiSkillsPort, type TuiSkillsSnapshot } from './skills';
import type { TuiStatusPort, TuiStatusSnapshot } from './status';

export * from './caller';
export * from './commands';
export * from './drafts';
export * from './export';
export * from './file-candidates';
export * from './management';
export * from './mcp';
export * from './mcp-auth';
export * from './models';
export * from './permissions';
export * from './preferences';
export * from './recovery';
export * from './skills';
export * from './status';

export interface TuiSnapshot {
  readonly storeId: string;
  readonly view: SessionView;
  /** Complete fixed-water history, not the first page from getView. */
  readonly messages: readonly Message[];
  readonly interactions: readonly Interaction[];
  /** Actual active Run origin, read and identity-checked by the admitted host. */
  readonly activeCommand?: Command;
}
function freezeIntent<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const part of Object.values(value)) freezeIntent(part);
    Object.freeze(value);
  }
  return value;
}
export interface TuiPort {
  preferences?: TuiPreferencePort;
  models?: TuiModelPort;
  mcp?: TuiMcpPort;
  mcpAuth?: TuiMcpAuthPort;
  drafts?: TuiDraftPort;
  fileCandidates?: TuiFileCandidatesPort;
  callers?: TuiCallerPort;
  exportLoadedText?: TuiExportPort;
  management?: TuiManagementPort;
  fileRecovery?: TuiFileRecoveryPort;
  recovery?: TuiRecoveryPort;
  executions?: TuiExecutionPort;
  permissions?: TuiPermissionPort;
  status?: TuiStatusPort;
  skills?: TuiSkillsPort;
  readonly storeId: string;
  nextCommandId(): string;
  listSessions(signal: AbortSignal): Promise<readonly { id: string; title: string }[]>;
  readSession(sessionId: string, signal: AbortSignal): Promise<TuiSnapshot>;
  readModelOutput?(
    sessionId: string,
    executionId: string,
    signal: AbortSignal,
  ): Promise<ModelOutputSnapshot>;
  /** Host must use the public full attachment/hash/UTF-8 reader. */
  readAttachment?(interaction: Interaction, signal: AbortSignal): Promise<string>;
  submit(
    sessionId: string,
    intent: StartCommandRequest | SteerCommandRequest | FollowUpCommandRequest,
  ): Promise<Command>;
  answer(
    sessionId: string,
    interactionId: string,
    intent: AnswerInteractionRequest,
  ): Promise<Command>;
  cancel(sessionId: string, intent: CancelCommandRequest): Promise<Command>;
  getCommand(commandId: string, sessionId: string): Promise<Command>;
}
export interface TuiIntent {
  readonly sessionId: string;
  readonly commandId: string;
  readonly kind: string;
  readonly phase: 'submitting' | 'accepted' | 'applied' | 'unknown' | 'rejected';
}
export interface TuiState {
  readonly callers: ReadonlyMap<string, TuiCallerOutcome>;
  readonly callerUnavailable?: string;
  readonly callerReading?: string;
  readonly fileCandidates?: {
    key: string;
    scope: TuiFileScope;
    phase: 'reading' | 'ready' | 'failed';
    paths: readonly string[];
    unavailable: readonly { path: string; reason: string }[];
    error?: string;
  };
  preferences: TuiPreferences;
  preferenceStatus: 'loading' | 'confirmed' | 'saving' | 'failed';
  preferenceError?: string;
  preferenceSaved?: boolean;
  management?: TuiManagementOutcome;
  recovery?: TuiRecoveryOutcome;
  context?: import('@kite-ai/client').SelectedContextPage;
  fileRecovery?: {
    points?: import('@kite-ai/client').FileCheckpointPage;
    detail?: Awaited<ReturnType<TuiFileRecoveryPort['readPoint']>>;
    intent?: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent;
    phase: 'reading' | 'ready' | 'submitting' | 'failed';
    scopeChoice?: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent['scope'];
    saved?: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent[];
  };
  panel?:
    | 'context'
    | 'rewind'
    | 'permissions'
    | 'models'
    | 'mcp'
    | 'effort'
    | 'status'
    | 'skills'
    | 'theme'
    | 'language'
    | 'recovery'
    | 'executions';
  readonly jobStops: ReadonlyMap<string, TuiJobStop>;
  readonly executionReading?: {
    target: TuiJobTarget;
    phase: 'reading' | 'ready' | 'failed' | 'cancelled';
    output?: ExecutionOutputPage;
    child?: TuiChildLog;
    error?: string;
  };
  status?: TuiStatusSnapshot;
  skills?: TuiSkillsSnapshot;
  models?: ModelSettingsView;
  modelOutcome?: TuiModelOutcome;
  mcp?: { facts?: TuiMcpSnapshot; read: 'reading' | 'ready' | 'failed' };
  mcpOutcome?: TuiMcpOutcome;
  mcpSaved?: readonly TuiMcpOutcome[];
  mcpUnavailable?: string;
  mcpTools?: TuiMcpToolsState;
  mcpConnection?: TuiMcpConnectionOutcome;
  mcpConnections?: readonly TuiMcpConnectionOutcome[];
  mcpConnectionUnavailable?: string;
  mcpConnectionReading?: boolean;
  mcpReconnectionOpen?: boolean;
  mcpReconnection?: TuiMcpReconnectionOutcome;
  mcpReconnections?: readonly TuiMcpReconnectionOutcome[];
  mcpReconnectionObservation?: TuiMcpReconnectionObservation;
  mcpReconnectionReading?: boolean;
  mcpReconnectionObserving?: boolean;
  mcpReconnectionUnavailable?: string;
  mcpMutationOpen?: boolean;
  mcpMutationFacts?: MutationSnapshot;
  mcpMutationSaved?: readonly TuiMcpSourceMutationOutcome[];
  mcpMutationOutcome?: TuiMcpSourceMutationOutcome;
  mcpMutationError?: string;
  mcpMutationFactsReading?: boolean;
  mcpMutationReading?: boolean;
  mcpAuthOpen?: boolean;
  mcpAuthServerId?: string;
  mcpAuthStatus?: TuiMcpAuthStatus;
  mcpAuthOutcome?: TuiMcpAuthOutcome;
  mcpAuthReading?: boolean;
  mcpAuthError?: string;
  mcpSourceOpen?: boolean;
  mcpSource?: { facts?: TuiMcpSourceSnapshot; read: 'reading' | 'ready' | 'failed' };
  mcpSourceOutcome?: TuiMcpSourceApprovalOutcome;
  mcpSourceSaved?: readonly TuiMcpSourceApprovalOutcome[];
  mcpSourceUnavailable?: string;
  mcpSourceReading?: boolean;
  permissions?: TuiPermissionSnapshot;
  permissionOutcome?: TuiPermissionOutcome;
  chooserRequested?: boolean;
  notice?: string;
  noticeFragments?: readonly { text: string; label?: boolean }[];
  readonly sessionId?: string;
  readonly snapshot?: TuiSnapshot;
  readonly sessions: readonly { id: string; title: string }[];
  readonly draft: string;
  readonly planning: boolean;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly snapshotStale: boolean;
  readonly observationError?: string;
  readonly observationState: 'connecting' | 'ready' | 'unknown';
  readonly error?: string;
  readonly intent?: TuiIntent;
  readonly fullOutputs: ReadonlyMap<string, string>;
  readonly loadedOutputBodies: ReadonlyMap<string, ModelOutputSnapshot['output']>;
  readonly attachment?: { interactionId: string; revision: string; content: string };
  readonly attachments: ReadonlyMap<string, string>;
}
/** Escape terminal protocols while retaining every original character as readable text. */
export function terminalText(value: string): string {
  return value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: render protocol bytes as visible escapes.
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function interactionAnswer(
  card: Interaction,
  text: string,
): NonNullable<Interaction['answer']> | undefined {
  if (card.state !== 'pending') return undefined;
  if (card.kind === 'approval') {
    if (text === 'deny') return { kind: 'approval', decision: 'deny' };
    if (text === 'approve') return { kind: 'approval', decision: 'approve', grant: 'approve_once' };
    if (
      text === 'approve same_command' &&
      record(card.request) &&
      Array.isArray(card.request.grants) &&
      card.request.grants.includes('same_command')
    )
      return { kind: 'approval', decision: 'approve', grant: 'same_command' };
    return undefined;
  }
  if (card.kind === 'question') {
    if (!record(card.request) || !record(card.request.schema)) return undefined;
    try {
      return { kind: 'question', answers: JSON.parse(text) };
    } catch {
      return undefined;
    }
  }
  if (!record(card.request) || !Array.isArray(card.request.allowedModes)) return undefined;
  if (text === 'deny') return { kind: 'plan_review', decision: 'deny' };
  if (text.startsWith('revise ') && text.slice(7).length <= 8192)
    return { kind: 'plan_review', decision: 'revise', feedback: text.slice(7) };
  const mode = text.startsWith('approve ') ? text.slice(8) : undefined;
  if ((mode === 'auto' || mode === 'accept_edits') && card.request.allowedModes.includes(mode))
    return { kind: 'plan_review', decision: 'approve', mode };
  return undefined;
}
export function activity(snapshot?: TuiSnapshot): string {
  if (!snapshot) return 'Unavailable';
  if (
    snapshot.view.executions.some((e) => e.status === 'outcome_unknown') ||
    snapshot.view.runs.some((r) => r.status === 'interrupted')
  )
    return 'Unknown — verify original work';
  const run = snapshot.view.runs.find((r) => r.isActive);
  if (
    run?.status === 'cancelling' ||
    snapshot.view.executions.some(
      (e) =>
        e.cancelRequestedAt !== null && ['planned', 'dispatching', 'running'].includes(e.status),
    )
  )
    return 'Cancelling';
  if (run?.status === 'waiting_interaction') return 'Waiting for answer';
  if (run?.status === 'waiting_execution') return 'Waiting for required result';
  return run ? 'Working' : 'Idle';
}

export class TuiController {
  private value: TuiState = {
    preferences: defaultTuiPreferences,
    preferenceStatus: 'loading',
    sessions: [],
    draft: '',
    planning: false,
    loading: false,
    stale: false,
    snapshotStale: false,
    observationState: 'connecting',
    fullOutputs: new Map(),
    loadedOutputBodies: new Map(),
    attachments: new Map(),
    jobStops: new Map(),
    callers: new Map(),
  };
  private listeners = new Set<() => void>();
  private clearedDisplay?: {
    sessionId: string;
    messages: Map<
      string,
      {
        seq: string;
        role: Message['role'];
        status: Message['status'];
        content: string;
        contentFormat: Message['contentFormat'];
        outputBody: string | undefined;
        fullOutput: string | undefined;
      }
    >;
    executions: Map<string, { status: string; resultRevision: string | null }>;
  };
  private reads = new Set<AbortController>();
  private fileRead?: AbortController;
  private generation = 0;
  private historyGeneration = 0;
  private historyRead?: AbortController;
  private contextRead?: AbortController;
  private modelRead?: AbortController;
  private modelIntents = new Map<string, TuiModelOutcome>();
  private mcpRead?: AbortController;
  private mcpToolsRead?: AbortController;
  private mcpIntents = new Map<string, TuiMcpOutcome>();
  private mcpBusy = false;
  private mcpConnectionRead?: AbortController;
  private mcpConnectionIntents = new Map<string, TuiMcpConnectionOutcome>();
  private mcpConnectionBusy = false;
  private mcpReconnectionRead?: AbortController;
  private mcpReconnectionIntents = new Map<string, TuiMcpReconnectionOutcome>();
  private mcpReconnectionBusy = false;
  private mcpMutationRead?: AbortController;
  private mcpMutationFactsRead?: AbortController;
  private mcpMutationBusy = false;
  private mcpMutationIntents = new Map<string, TuiMcpSourceMutationOutcome>();
  private mcpAuthRead?: AbortController;
  private mcpAuthBusy = false;
  private mcpAuthView = 0;
  private mcpAuthOutcomes = new Map<string, TuiMcpAuthOutcome>();
  private mcpSourceRead?: AbortController;
  private mcpSourceLookupRead?: AbortController;
  private mcpSourceBusy = false;
  private mcpSourceIntents = new Map<string, TuiMcpSourceApprovalOutcome>();
  private permissionRead?: AbortController;
  private statusRead?: AbortController;
  private skillsRead?: AbortController;
  private permissionIntents = new Map<string, TuiPermissionOutcome>();
  private disposed = false;
  get statusHost() {
    return this.port.status
      ? { mode: this.port.status.mode, profile: this.port.status.profile }
      : undefined;
  }
  private busy = false;
  private jobStopBusy = false;
  private callerRead?: AbortController;
  private callerRestoring = false;
  private executionRead?: AbortController;
  private answerIntent?: {
    readonly sessionId: string;
    readonly interactionId: string;
    readonly request: AnswerInteractionRequest;
    phase: TuiIntent['phase'];
  };
  private hasUnknownAnswer() {
    return this.answerIntent?.phase === 'unknown';
  }
  private answered = new Set<string>();
  private attachmentProofs = new Map<string, string>();
  private unknownIntents = new Map<string, TuiIntent>();
  private cancelled = new Set<string>();
  private managementIntents = new Map<string, TuiManagementOutcome>();
  private recoveryRestoring = false;
  private recoveryRestoreFailed = false;
  private recoveryIntents = new Map<string, TuiRecoveryOutcome>();
  private recoveryRead?: AbortController;
  private drafts = new Map<string, string>();
  private draftVersions = new Map<string, number>();
  private planningDrafts = new Map<string, { enabled: boolean; version: number }>();
  private planningKey(scope: TuiDraftScope) {
    return JSON.stringify([scope.storeId, scope.workspaceId, scope.sessionId]);
  }
  togglePlanning() {
    const scope = this.draftScope();
    if (!scope || this.disposed) return;
    const key = this.planningKey(scope),
      old = this.planningDrafts.get(key);
    const next = { enabled: !old?.enabled, version: (old?.version ?? 0) + 1 };
    this.planningDrafts.set(key, next);
    this.publish({ planning: next.enabled });
  }
  private submittedDrafts = new Map<
    string,
    {
      scope: TuiDraftScope;
      localRevision: number;
      storedRevision?: number;
      request?: StartCommandRequest | FollowUpCommandRequest | SteerCommandRequest;
      planningVersion?: number;
    }
  >();
  private settleDraft(commandId: string) {
    const original = this.submittedDrafts.get(commandId);
    if (
      !original ||
      this.value.intent?.commandId !== commandId ||
      !['accepted', 'applied'].includes(this.value.intent.phase)
    )
      return;
    const sessionId = original.scope.sessionId;
    if (original.planningVersion !== undefined) {
      const key = this.planningKey(original.scope),
        current = this.planningDrafts.get(key);
      if ((current?.version ?? 0) === original.planningVersion) {
        this.planningDrafts.set(key, { enabled: false, version: original.planningVersion + 1 });
        const selected = this.draftScope();
        if (selected && this.planningKey(selected) === key) this.publish({ planning: false });
      }
    }
    if ((this.draftVersions.get(sessionId) ?? 0) !== original.localRevision) {
      this.submittedDrafts.delete(commandId);
      return;
    }
    if (this.port.drafts) {
      try {
        if (
          original.storedRevision === undefined ||
          !this.port.drafts.accepted(original.scope, original.storedRevision)
        )
          return;
      } catch {
        this.draftUnavailable('tui_draft_storage_unavailable');
        return;
      }
    }
    this.submittedDrafts.delete(commandId);
    this.drafts.set(sessionId, '');
    if (this.value.sessionId === sessionId) this.publish({ draft: '' });
  }
  private draftScope(snapshot = this.value.snapshot): TuiDraftScope | undefined {
    return snapshot && snapshot.view.session.id === this.value.sessionId
      ? {
          storeId: this.port.storeId,
          workspaceId: snapshot.view.session.workspaceId,
          sessionId: snapshot.view.session.id,
        }
      : undefined;
  }
  draftUnavailable(code: string) {
    this.publish({ error: code });
  }
  readonly port: TuiPort;
  constructor(port: TuiPort) {
    this.port = port;
    if (port.preferences) void this.refreshPreferences();
    else
      this.value = {
        ...this.value,
        preferenceStatus: 'failed',
        preferenceError: 'tui_preferences_unavailable',
      };
  }
  private preferenceGeneration = 0;
  private preferenceSaving = false;
  async refreshPreferences() {
    if (this.preferenceSaving || this.disposed) return;
    const generation = ++this.preferenceGeneration;
    this.publish({
      preferenceStatus: 'loading',
      preferenceError: undefined,
      preferenceSaved: false,
    });
    try {
      if (!this.port.preferences) throw Error('tui_preferences_unavailable');
      const preferences = verifyTuiPreferences(await this.port.preferences.read());
      if (generation === this.preferenceGeneration)
        this.publish({ preferences, preferenceStatus: 'confirmed', preferenceError: undefined });
    } catch (error) {
      if (generation === this.preferenceGeneration)
        this.publish({
          preferenceStatus: 'failed',
          preferenceError: error instanceof Error ? error.message : 'tui_preferences_read_failed',
        });
    }
  }
  openPreferences(panel: 'theme' | 'language') {
    this.closePanel();
    this.publish({ panel });
  }
  async savePreference(edit: TuiPreferenceEdit) {
    if (
      this.preferenceSaving ||
      this.disposed ||
      this.value.preferenceStatus !== 'confirmed' ||
      edit.expectedRevision !== this.value.preferences.revision ||
      edit.value === this.value.preferences[edit.key]
    )
      return;
    this.preferenceSaving = true;
    ++this.preferenceGeneration;
    this.publish({
      preferenceStatus: 'saving',
      preferenceError: undefined,
      preferenceSaved: false,
    });
    try {
      if (!this.port.preferences) throw Error('tui_preferences_unavailable');
      const preferences = verifyTuiPreferences(await this.port.preferences.save(edit));
      if (preferences[edit.key] !== edit.value) throw Error('tui_preferences_identity_mismatch');
      this.publish({
        preferences,
        preferenceStatus: 'confirmed',
        preferenceError: undefined,
        preferenceSaved: true,
      });
    } catch (error) {
      this.publish({
        preferenceStatus: 'failed',
        preferenceError: error instanceof Error ? error.message : 'tui_preferences_save_failed',
      });
    } finally {
      this.preferenceSaving = false;
    }
  }
  get state() {
    return this.value;
  }
  /** Hide only the exact observed display; the complete history remains available to readers. */
  clearDisplay(): void {
    const snapshot = this.value.snapshot;
    if (this.disposed || !snapshot || snapshot.view.session.id !== this.value.sessionId) return;
    this.clearedDisplay = {
      sessionId: snapshot.view.session.id,
      messages: new Map(
        snapshot.messages.map((message) => [
          message.id,
          {
            seq: message.seq,
            role: message.role,
            status: message.status,
            content: message.content,
            contentFormat: message.contentFormat,
            outputBody: JSON.stringify(message.outputBody),
            fullOutput: this.value.fullOutputs.get(message.id),
          },
        ]),
      ),
      executions: new Map(
        snapshot.view.executions
          .filter((execution) => ['succeeded', 'failed', 'cancelled'].includes(execution.status))
          .map((execution) => [
            execution.id,
            { status: execution.status, resultRevision: execution.resultRevision },
          ]),
      ),
    };
    this.publish({});
  }
  get visibleMessages(): readonly Message[] {
    const snapshot = this.value.snapshot,
      cleared = this.clearedDisplay;
    if (!snapshot || cleared?.sessionId !== snapshot.view.session.id)
      return snapshot?.messages ?? [];
    return snapshot.messages.filter((message) => {
      const previous = cleared.messages.get(message.id);
      return (
        !previous ||
        previous.seq !== message.seq ||
        previous.role !== message.role ||
        previous.status !== message.status ||
        previous.content !== message.content ||
        previous.contentFormat !== message.contentFormat ||
        previous.outputBody !== JSON.stringify(message.outputBody) ||
        previous.fullOutput !== this.value.fullOutputs.get(message.id)
      );
    });
  }
  get visibleExecutions(): readonly SessionView['executions'][number][] {
    const snapshot = this.value.snapshot,
      cleared = this.clearedDisplay;
    if (!snapshot || cleared?.sessionId !== snapshot.view.session.id)
      return snapshot?.view.executions ?? [];
    return snapshot.view.executions.filter((execution) => {
      const previous = cleared.executions.get(execution.id);
      return (
        !previous ||
        previous.status !== execution.status ||
        previous.resultRevision !== execution.resultRevision
      );
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<TuiState>) {
    if (this.disposed) return;
    const next = { ...this.value, ...patch };
    if ('notice' in patch && !('noticeFragments' in patch)) next.noticeFragments = undefined;
    this.value = {
      ...next,
      stale: next.snapshotStale || next.observationError !== undefined,
      error: next.error ?? next.observationError,
    };
    for (const listener of this.listeners) listener();
  }
  private reading() {
    const read = new AbortController();
    this.reads.add(read);
    return read;
  }
  async list() {
    if (this.disposed) return;
    const read = this.reading();
    try {
      const sessions = await this.port.listSessions(read.signal);
      if (!read.signal.aborted) this.publish({ sessions });
    } catch (error) {
      if (!read.signal.aborted)
        this.publish({ error: error instanceof Error ? error.message : 'directory_failed' });
    } finally {
      this.reads.delete(read);
    }
  }
  observationUnavailable(code: string) {
    const error = `observation_unavailable:${code}`;
    this.mcpReconnectionRead?.abort();
    this.publish({
      observationState: 'unknown',
      observationError: error,
      mcpReconnectionObservation: undefined,
      mcpReconnectionReading: false,
      mcpReconnectionObserving: false,
      error,
      ...(this.value.status
        ? { status: { ...this.value.status, connection: 'unknown' as const } }
        : {}),
    });
  }
  /** Only the host's validated original-Store SSE ready establishes observation again. */
  observationReady(storeId: string) {
    if (storeId !== this.port.storeId) {
      this.observationUnavailable('store_changed');
      return;
    }
    this.publish({
      observationState: 'ready',
      observationError: undefined,
      error: this.value.error === this.value.observationError ? undefined : this.value.error,
    });
  }
  async readFileCandidates(token?: FileToken) {
    this.fileRead?.abort();
    this.fileRead = undefined;
    if (!token || !this.port.fileCandidates || this.value.loading || this.value.snapshotStale) {
      this.publish({ fileCandidates: undefined });
      return;
    }
    const scope = this.draftScope();
    if (!scope) return;
    const read = this.reading();
    this.fileRead = read;
    const generation = this.generation;
    const revision = this.draftVersions.get(scope.sessionId) ?? 0;
    const current = () =>
      !read.signal.aborted &&
      this.fileRead === read &&
      generation === this.generation &&
      revision === (this.draftVersions.get(scope.sessionId) ?? 0) &&
      this.value.sessionId === scope.sessionId;
    this.publish({
      fileCandidates: { key: token.key, scope, phase: 'reading', paths: [], unavailable: [] },
    });
    try {
      const paths: string[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>();
      let cursor: string | undefined, snapshot: string | undefined;
      let unavailable: readonly { path: string; reason: string }[] = [];
      do {
        const page = await this.port.fileCandidates.read(
          scope,
          { query: token.query, ...(cursor ? { cursor } : {}) },
          read.signal,
        );
        if (!current()) return;
        if (
          page.scope.storeId !== scope.storeId ||
          page.scope.sessionId !== scope.sessionId ||
          page.scope.workspaceId !== scope.workspaceId ||
          page.query !== token.query ||
          !page.snapshotId ||
          (snapshot && snapshot !== page.snapshotId)
        )
          throw new Error('file_candidate_page_identity_mismatch');
        snapshot = page.snapshotId;
        for (const path of page.paths) {
          if (
            !path ||
            path.startsWith('/') ||
            path.split('/').some((part) => !part || part === '.' || part === '..') ||
            path.includes('\0') ||
            seen.has(path)
          )
            throw new Error('file_candidate_path_invalid');
          seen.add(path);
          paths.push(path);
        }
        unavailable = page.unavailable;
        cursor = page.nextCursor ?? undefined;
        if (cursor) {
          if (!page.paths.length || cursors.has(cursor))
            throw new Error('file_candidate_cursor_invalid');
          cursors.add(cursor);
        }
      } while (cursor);
      if (current())
        this.publish({
          fileCandidates: { key: token.key, scope, phase: 'ready', paths, unavailable },
        });
    } catch (error) {
      if (current())
        this.publish({
          fileCandidates: {
            key: token.key,
            scope,
            phase: 'failed',
            paths: [],
            unavailable: [],
            error: error instanceof Error ? error.message : 'file_candidates_unavailable',
          },
        });
    } finally {
      this.reads.delete(read);
    }
  }
  setDraft(draft: string) {
    if (draft !== this.value.draft) this.fileRecoveryRead?.abort();
    this.fileRead?.abort();
    this.publish({ draft, fileCandidates: undefined });
    if (this.value.sessionId) {
      this.drafts.set(this.value.sessionId, draft);
      this.draftVersions.set(
        this.value.sessionId,
        (this.draftVersions.get(this.value.sessionId) ?? 0) + 1,
      );
    }
    const scope = this.draftScope();
    if (scope)
      try {
        this.port.drafts?.edit(scope, draft);
      } catch {
        this.draftUnavailable('tui_draft_storage_unavailable');
      }
  }
  async select(sessionId: string, options: { preserveReconnectionReview?: boolean } = {}) {
    if (this.disposed) return;
    this.fileRead?.abort();
    this.publish({ fileCandidates: undefined });
    const same = this.value.sessionId === sessionId;
    const preserveReconnectionReview =
      same && options.preserveReconnectionReview && !this.value.stale;
    if (!preserveReconnectionReview) this.mcpReconnectionRead?.abort();
    if (!same) {
      this.clearedDisplay = undefined;
      this.fileRecoveryRead?.abort();
      this.port.drafts?.flush();
      for (const read of this.reads) read.abort();
      ++this.generation;
    }
    this.historyRead?.abort();
    const generation = this.generation;
    const historyGeneration = ++this.historyGeneration;
    this.publish({
      sessionId,
      snapshot: same ? this.value.snapshot : undefined,
      fullOutputs: same ? this.value.fullOutputs : new Map(),
      loadedOutputBodies: same ? this.value.loadedOutputBodies : new Map(),
      attachment: same ? this.value.attachment : undefined,
      context: same ? this.value.context : undefined,
      fileRecovery: same ? this.value.fileRecovery : undefined,
      models: same ? this.value.models : undefined,
      modelOutcome: same ? this.value.modelOutcome : undefined,
      mcp: same ? this.value.mcp : undefined,
      mcpTools: same ? this.value.mcpTools : undefined,
      mcpOutcome: same ? this.value.mcpOutcome : undefined,
      mcpConnection: same ? this.value.mcpConnection : undefined,
      mcpConnectionReading: false,
      mcpReconnectionOpen: same ? this.value.mcpReconnectionOpen : false,
      mcpReconnection: same ? this.value.mcpReconnection : undefined,
      // Same-scope event refresh must not withdraw a separate human confirmation.
      // Explicit selection and a changed Workspace still invalidate this observation.
      mcpReconnectionObservation: preserveReconnectionReview
        ? this.value.mcpReconnectionObservation
        : undefined,
      mcpReconnectionReading: preserveReconnectionReview
        ? this.value.mcpReconnectionReading
        : false,
      mcpReconnectionObserving: preserveReconnectionReview
        ? this.value.mcpReconnectionObserving
        : false,
      mcpMutationOpen: same ? this.value.mcpMutationOpen : false,
      mcpMutationFacts: same ? this.value.mcpMutationFacts : undefined,
      mcpMutationOutcome: same ? this.value.mcpMutationOutcome : undefined,
      mcpMutationFactsReading: same ? this.value.mcpMutationFactsReading : false,
      mcpMutationReading: same ? this.value.mcpMutationReading : false,
      mcpAuthOpen: same ? this.value.mcpAuthOpen : false,
      mcpAuthServerId: same ? this.value.mcpAuthServerId : undefined,
      mcpAuthStatus: same ? this.value.mcpAuthStatus : undefined,
      mcpAuthOutcome: same ? this.value.mcpAuthOutcome : undefined,
      mcpAuthReading: false,
      mcpAuthError: undefined,
      mcpSourceOpen: same ? this.value.mcpSourceOpen : false,
      mcpSource: same ? this.value.mcpSource : undefined,
      mcpSourceOutcome: same ? this.value.mcpSourceOutcome : undefined,
      mcpSourceReading: false,
      permissions: same ? this.value.permissions : undefined,
      status: same ? this.value.status : undefined,
      skills: same ? this.value.skills : undefined,
      panel: same ? this.value.panel : undefined,
      executionReading: same ? this.value.executionReading : undefined,
      planning: same ? this.value.planning : false,
      chooserRequested: false,
      notice: same ? this.value.notice : undefined,
      draft: this.drafts.get(sessionId) ?? '',
      loading: true,
      error: undefined,
    });
    const read = this.reading();
    this.historyRead = read;
    try {
      const snapshot = await this.port.readSession(sessionId, read.signal);
      if (
        read.signal.aborted ||
        generation !== this.generation ||
        historyGeneration !== this.historyGeneration
      )
        return;
      if (
        snapshot.storeId !== this.port.storeId ||
        snapshot.view.storeId !== this.port.storeId ||
        snapshot.view.session.id !== sessionId ||
        snapshot.messages.some((m) => m.sessionId !== sessionId) ||
        snapshot.interactions.some(
          (i) => i.originStoreId !== this.port.storeId || i.presentationSessionId !== sessionId,
        )
      )
        throw new Error('tui_identity_mismatch');
      if (
        same &&
        this.value.snapshot?.view.session.workspaceId !== snapshot.view.session.workspaceId
      ) {
        this.mcpToolsRead?.abort();
        this.mcpConnectionRead?.abort();
        this.mcpReconnectionRead?.abort();
        this.mcpMutationRead?.abort();
        this.mcpMutationFactsRead?.abort();
        this.mcpAuthRead?.abort();
        this.mcpSourceRead?.abort();
        this.mcpSourceLookupRead?.abort();
        this.publish({
          mcpReconnection: undefined,
          mcpReconnectionObservation: undefined,
          mcpReconnectionReading: false,
          mcpReconnectionObserving: false,
          mcpMutationOpen: false,
          mcpMutationFacts: undefined,
          mcpMutationOutcome: undefined,
          mcpMutationFactsReading: false,
          mcpMutationReading: false,
          mcpSource: undefined,
          mcpSourceOutcome: undefined,
          mcpSourceReading: false,
          mcpTools: undefined,
          mcpConnection: undefined,
          mcpConnectionReading: false,
        });
      }
      if (
        same &&
        this.value.snapshot?.view.session.contextSelectionId !==
          snapshot.view.session.contextSelectionId
      ) {
        this.fileRecoveryRead?.abort();
        if (!this.value.fileRecovery?.intent) this.publish({ fileRecovery: undefined });
      }
      let draft = this.drafts.get(sessionId) ?? '';
      if (this.port.drafts) {
        const scope = {
          storeId: this.port.storeId,
          workspaceId: snapshot.view.session.workspaceId,
          sessionId,
        };
        try {
          if (!this.drafts.has(sessionId)) draft = this.port.drafts.read(scope);
          else this.port.drafts.edit(scope, draft);
          this.drafts.set(sessionId, draft);
        } catch {
          this.draftUnavailable('tui_draft_storage_unavailable');
        }
      }
      const fullOutputs = new Map(
        [...this.value.fullOutputs].filter(([id]) => {
          const old = this.value.snapshot?.messages.find((m) => m.id === id);
          const next = snapshot.messages.find((m) => m.id === id);
          return old && next && JSON.stringify(old.outputBody) === JSON.stringify(next.outputBody);
        }),
      );
      this.publish({
        snapshot,
        planning:
          this.planningDrafts.get(
            this.planningKey({
              storeId: this.port.storeId,
              workspaceId: snapshot.view.session.workspaceId,
              sessionId,
            }),
          )?.enabled ?? false,
        attachments: new Map(
          [...this.value.attachments].filter(([key]) => {
            const [store, source, presentation, id, revision] = JSON.parse(key);
            const current = snapshot.interactions.find(
              (item) =>
                item.originStoreId === store &&
                item.sessionId === source &&
                item.presentationSessionId === presentation &&
                item.id === id,
            );
            if (!current) return presentation !== snapshot.view.session.id;
            if (current.revision !== revision || current.state !== 'pending') return false;
            try {
              return this.attachmentProofs.get(key) === interactionAttachment(current)?.key;
            } catch {
              return false;
            }
          }),
        ),
        draft,
        fullOutputs,
        loadedOutputBodies: new Map(
          [...this.value.loadedOutputBodies].filter(([id]) => fullOutputs.has(id)),
        ),
        loading: false,
        snapshotStale: false,
        context:
          this.value.context?.selection.id === snapshot.view.session.contextSelectionId
            ? this.value.context
            : undefined,
      });
    } catch (error) {
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        historyGeneration === this.historyGeneration
      ) {
        this.mcpReconnectionRead?.abort();
        this.publish({
          loading: false,
          snapshotStale: true,
          mcpReconnectionObservation: undefined,
          mcpReconnectionReading: false,
          mcpReconnectionObserving: false,
          error: error instanceof Error ? error.message : 'read_failed',
        });
      }
    } finally {
      this.reads.delete(read);
    }
  }
  private fileRecoveryRead?: AbortController;
  async openFileRecovery() {
    if (!this.port.fileRecovery || !this.value.sessionId) {
      this.publish({ error: 'file_recovery_unavailable' });
      return;
    }
    this.closePanel();
    const sessionId = this.value.sessionId,
      generation = this.generation,
      read = new AbortController();
    this.fileRecoveryRead = read;
    this.publish({ panel: 'rewind', fileRecovery: { phase: 'reading' }, error: undefined });
    try {
      const points = await this.port.fileRecovery.listPoints(sessionId, read.signal);
      const saved = (await this.port.fileRecovery.listSaved()).filter(
        (intent) => intent.sessionId === sessionId,
      );
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        sessionId === this.value.sessionId
      )
        this.publish({ fileRecovery: { points, saved, phase: 'ready' } });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({
          fileRecovery: { phase: 'failed' },
          error: error instanceof Error ? error.message : 'file_recovery_failed',
        });
    }
  }
  async readFileRecoveryPoint(pointId: string) {
    if (!this.port.fileRecovery || !this.value.sessionId) return;
    this.fileRecoveryRead?.abort();
    const sessionId = this.value.sessionId,
      generation = this.generation,
      read = new AbortController();
    this.fileRecoveryRead = read;
    const {
      scopeChoice: _scope,
      intent: _intent,
      detail: _detail,
      ...directory
    } = this.value.fileRecovery ?? { phase: 'reading' };
    this.publish({ fileRecovery: { ...directory, phase: 'reading' } });
    try {
      const detail = await this.port.fileRecovery.readPoint(sessionId, pointId, read.signal);
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        sessionId === this.value.sessionId
      )
        this.publish({ fileRecovery: { ...this.value.fileRecovery, detail, phase: 'ready' } });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({ error: error instanceof Error ? error.message : 'file_recovery_failed' });
    }
  }
  chooseFileRecoveryScope(
    scope: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent['scope'],
  ) {
    if (
      this.value.fileRecovery?.detail &&
      !this.value.fileRecovery.intent &&
      this.value.fileRecovery.phase === 'ready'
    )
      this.publish({ fileRecovery: { ...this.value.fileRecovery, scopeChoice: scope } });
  }
  selectSavedFileRecovery(index: number) {
    const intent = this.value.fileRecovery?.saved?.[index];
    if (intent)
      this.publish({ fileRecovery: { ...this.value.fileRecovery, intent, phase: 'ready' } });
  }
  async startFileRecovery(
    scope: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent['scope'],
  ) {
    const detail = this.value.fileRecovery?.detail,
      sessionId = this.value.sessionId;
    if (
      !this.port.fileRecovery ||
      !detail ||
      !sessionId ||
      detail.boundary.sessionId !== sessionId ||
      this.value.fileRecovery?.intent ||
      this.value.fileRecovery?.phase !== 'ready'
    )
      return;
    this.fileRecoveryRead?.abort();
    const read = new AbortController(),
      generation = this.generation;
    this.fileRecoveryRead = read;
    this.publish({ fileRecovery: { ...this.value.fileRecovery, phase: 'submitting' } });
    try {
      const intent = await this.port.fileRecovery.begin(
        sessionId,
        detail.boundary.checkpoint.id,
        scope,
        read.signal,
      );
      if (
        read.signal.aborted ||
        generation !== this.generation ||
        sessionId !== this.value.sessionId
      )
        return;
      this.publish({ fileRecovery: { ...this.value.fileRecovery, intent, phase: 'submitting' } });
      const result = await this.port.fileRecovery.continue(intent, read.signal);
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        sessionId === this.value.sessionId
      ) {
        this.publish({
          fileRecovery: { ...this.value.fileRecovery, intent: result, phase: 'ready' },
        });
        await this.applyFileRecoverySession(result);
      }
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({
          fileRecovery: { ...this.value.fileRecovery, phase: 'failed' },
          error: error instanceof Error ? error.message : 'file_recovery_failed',
        });
    }
  }
  private async applyFileRecoverySession(
    intent: import('@kite-ai/client/file-recovery-intent').FileRecoveryIntent,
  ) {
    if (intent.fork?.phase === 'succeeded' && this.value.sessionId === intent.sessionId) {
      await this.list();
      await this.select(intent.fork.request.newSessionId);
    }
  }
  async observeFileRecovery(continueLeg = false) {
    const intent = this.value.fileRecovery?.intent;
    if (!intent || !this.port.fileRecovery || this.value.fileRecovery?.phase === 'submitting')
      return;
    this.fileRecoveryRead?.abort();
    const read = new AbortController(),
      generation = this.generation;
    this.fileRecoveryRead = read;
    this.publish({ fileRecovery: { ...this.value.fileRecovery, phase: 'submitting' } });
    try {
      const result = await (continueLeg
        ? this.port.fileRecovery.continue(intent, read.signal)
        : this.port.fileRecovery.lookup(intent, read.signal));
      if (!read.signal.aborted && generation === this.generation) {
        this.publish({
          fileRecovery: { ...this.value.fileRecovery, intent: result, phase: 'ready' },
        });
        await this.applyFileRecoverySession(result);
      }
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({
          fileRecovery: { ...this.value.fileRecovery, phase: 'ready' },
          error: error instanceof Error ? error.message : 'file_recovery_failed',
        });
    }
  }
  closePanel() {
    this.fileRecoveryRead?.abort();
    this.executionRead?.abort();
    if (this.value.executionReading?.phase === 'reading')
      this.publish({ executionReading: { ...this.value.executionReading, phase: 'cancelled' } });
    this.recoveryRead?.abort();
    this.skillsRead?.abort();
    this.statusRead?.abort();
    this.modelRead?.abort();
    this.mcpRead?.abort();
    this.mcpToolsRead?.abort();
    this.mcpConnectionRead?.abort();
    this.mcpReconnectionRead?.abort();
    this.mcpAuthRead?.abort();
    this.mcpSourceRead?.abort();
    this.mcpSourceLookupRead?.abort();
    this.permissionRead?.abort();
    this.contextRead?.abort();
    this.publish({
      panel: undefined,
      chooserRequested: false,
      mcpReconnectionOpen: false,
      mcpReconnectionObservation: undefined,
      mcpReconnectionReading: false,
      mcpReconnectionObserving: false,
      mcpAuthOpen: false,
      mcpAuthReading: false,
      mcpSourceOpen: false,
      mcpSourceReading: false,
    });
  }
  async openSkills() {
    await this.readSkills(true);
  }
  private async readSkills(showPanel: boolean) {
    const port = this.port.skills,
      session = this.value.snapshot?.view.session;
    if (!port || !session || this.disposed) {
      this.publish({ error: 'skill_catalogue_unavailable' });
      return;
    }
    this.skillsRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.skillsRead = read;
    this.publish({
      ...(showPanel ? { panel: 'skills' as const } : {}),
      skills: { facts: this.value.skills?.facts, read: 'reading' },
      error: undefined,
    });
    try {
      const facts = await port.read(session.id, session.workspaceId, read.signal);
      if (
        read.signal.aborted ||
        generation !== this.generation ||
        (showPanel && this.value.panel !== 'skills')
      )
        return;
      if (
        facts.storeId !== this.port.storeId ||
        facts.workspaceId !== session.workspaceId ||
        !facts.complete ||
        facts.nextAfterId !== null
      )
        throw Error('skill_catalogue_scope_mismatch');
      if (facts.availability === 'unavailable') {
        this.publish({
          ...(!showPanel ? { error: facts.reason ?? 'skill_catalogue_unavailable' } : {}),
          skills: {
            facts: this.value.skills?.facts ?? freezeIntent(structuredClone(facts)),
            read: 'unknown',
            error: facts.reason ?? 'skill_catalogue_unavailable',
          },
        });
        return;
      }
      this.publish({ skills: { facts: freezeIntent(structuredClone(facts)), read: 'verified' } });
      return facts;
    } catch {
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        (!showPanel || this.value.panel === 'skills')
      )
        this.publish({
          ...(!showPanel ? { error: 'skill_catalogue_unavailable' } : {}),
          skills: {
            facts: this.value.skills?.facts,
            read: 'unknown',
            error: 'skill_catalogue_unavailable',
          },
        });
    } finally {
      this.reads.delete(read);
    }
    return undefined;
  }
  async restoreCallers() {
    if (!this.port.callers || this.callerRestoring || this.disposed) return;
    this.callerRestoring = true;
    try {
      const rows = await this.port.callers.list();
      if (rows.length > 128) throw Error('caller_intent_limit');
      const restored = new Map<string, TuiCallerOutcome>();
      for (const row of rows) {
        const key = callerKey(row.intent);
        if (restored.has(key)) throw Error('caller_restore_conflict');
        const known = this.value.callers.get(key);
        if (known && JSON.stringify(known.intent) !== JSON.stringify(row.intent))
          throw Error('caller_restore_conflict');
        restored.set(key, known ?? freezeIntent(structuredClone(row)));
      }
      if (!this.disposed) this.publish({ callers: restored, callerUnavailable: undefined });
    } catch (error) {
      if (!this.disposed)
        this.publish({
          callerUnavailable: error instanceof Error ? error.message : 'caller_journal_unavailable',
        });
    } finally {
      this.callerRestoring = false;
    }
  }
  private pendingCaller() {
    return [...this.value.callers.values()].find(
      (row) =>
        row.intent.scope.storeId === this.port.storeId &&
        row.intent.scope.sessionId === this.value.sessionId &&
        ['submitting', 'unknown'].includes(row.phase),
    );
  }
  private async submitCaller(scope: TuiDraftScope, request: TuiCallerRequest): Promise<Command> {
    const port = this.port.callers;
    if (!port) throw Error('caller_port_unavailable');
    let intent: TuiCallerIntent;
    try {
      intent = await port.prepare(scope, request);
      if (
        intent.scope.storeId !== scope.storeId ||
        intent.scope.sessionId !== scope.sessionId ||
        intent.scope.workspaceId !== scope.workspaceId ||
        JSON.stringify(intent.request) !== JSON.stringify(request)
      )
        throw Error('caller_prepare_identity_mismatch');
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : Error('caller_prepare_failed'), {
        notSubmitted: true,
      });
    }
    const key = callerKey(intent);
    this.publish({
      callers: new Map(this.value.callers).set(key, { intent, phase: 'submitting' }),
    });
    const result = await port.submit(intent);
    if (JSON.stringify(result.intent) !== JSON.stringify(intent))
      throw Error('caller_submit_identity_mismatch');
    this.publish({ callers: new Map(this.value.callers).set(key, result) });
    if (!result.command) throw Error('caller_outcome_unknown');
    return result.command;
  }
  async lookupCaller(key?: string): Promise<boolean> {
    const original = key ? this.value.callers.get(key) : this.pendingCaller();
    if (!original || !this.port.callers || this.disposed) return false;
    this.callerRead?.abort();
    const read = this.reading();
    this.callerRead = read;
    this.publish({ callerReading: callerKey(original.intent) });
    try {
      const result = await this.port.callers.lookup(original.intent, read.signal);
      if (read.signal.aborted || this.disposed) return true;
      if (JSON.stringify(result.intent) !== JSON.stringify(original.intent))
        throw Error('caller_lookup_identity_mismatch');
      this.publish({
        callers: new Map(this.value.callers).set(callerKey(original.intent), result),
      });
      const pending = this.unknownIntents.get(original.intent.request.commandId);
      if (pending && result.command && ['accepted', 'applied', 'rejected'].includes(result.phase)) {
        this.unknownIntents.delete(pending.commandId);
        this.publish({ intent: { ...pending, phase: result.phase } });
        this.settleDraft(pending.commandId);
      }
      if (original.intent.request.kind === 'execution.cancel') {
        const intent = this.value.jobStops.get(original.intent.request.commandId);
        if (intent)
          this.publish({
            jobStops: new Map(this.value.jobStops).set(original.intent.request.commandId, {
              ...intent,
              phase: result.phase === 'accepted' ? 'unknown' : result.phase,
            }),
          });
      }
    } catch {
    } finally {
      this.reads.delete(read);
      if (this.callerRead === read) this.publish({ callerReading: undefined });
    }
    return true;
  }
  cancelCallerRead() {
    this.callerRead?.abort();
    this.publish({ callerReading: undefined });
  }
  async clearCaller(key: string) {
    const original = this.value.callers.get(key);
    if (!original || !this.port.callers || !['applied', 'rejected'].includes(original.phase))
      return;
    try {
      await this.port.callers.clear(original.intent);
      const callers = new Map(this.value.callers);
      callers.delete(key);
      this.publish({ callers });
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : 'caller_clear_unavailable' });
    }
  }
  async openRecovery() {
    if ((!this.port.recovery && !this.port.callers) || !this.value.snapshot || this.disposed) {
      this.publish({ error: 'recovery_unavailable' });
      return;
    }
    await this.restoreCallers();
    this.recoveryRestoring = true;
    this.recoveryRestoreFailed = false;
    this.publish({ panel: 'recovery', error: undefined });
    try {
      const restored = ((await this.port.recovery?.restore?.()) ?? []).map((saved) => {
        if (saved.status !== 'outcome_unknown') throw Error('recovery_restore_invalid');
        return { intent: parseTuiRecoveryIntent(saved.intent), status: 'outcome_unknown' as const };
      });
      if (restored.length > 128) throw Error('recovery_intent_limit');
      if (
        new Set([
          ...this.recoveryIntents.keys(),
          ...restored.map((saved) => saved.intent.request.commandId),
        ]).size > 128
      )
        throw Error('recovery_intent_limit');
      for (const saved of restored) {
        if (saved.status !== 'outcome_unknown') throw Error('recovery_restore_invalid');
        const original = this.recoveryIntents.get(saved.intent.request.commandId);
        if (original && JSON.stringify(original.intent) !== JSON.stringify(saved.intent))
          throw Error('recovery_restore_conflict');
        if (!original)
          this.recoveryIntents.set(
            saved.intent.request.commandId,
            freezeIntent(structuredClone(saved)),
          );
      }
      const first = [...this.recoveryIntents.values()].find((entry) =>
        ['submitting', 'accepted', 'outcome_unknown'].includes(entry.status),
      );
      if (first) this.publish({ recovery: first });
    } catch (error) {
      this.recoveryRestoreFailed = true;
      this.publish({
        error: error instanceof Error ? error.message : 'recovery_journal_unavailable',
      });
    } finally {
      this.recoveryRestoring = false;
    }
  }
  async submitRecovery(kind: 'run' | 'report' | 'interrupt', targetId: string) {
    const port = this.port.recovery,
      snapshot = this.value.snapshot;
    if (
      !port ||
      !snapshot ||
      this.disposed ||
      this.recoveryRestoring ||
      this.recoveryRestoreFailed ||
      this.value.panel !== 'recovery' ||
      this.value.stale ||
      this.value.snapshotStale ||
      snapshot.view.session.rootSessionId !== snapshot.view.session.id ||
      snapshot.view.session.parentSessionId !== null ||
      (kind === 'interrupt' ? targetId !== 'confirm' : !/^[A-Za-z0-9_-]{1,128}$/.test(targetId))
    ) {
      this.publish({ error: 'recovery_scope_unavailable' });
      return;
    }
    if (this.recoveryRead && !this.recoveryRead.signal.aborted) return;
    if (
      [...this.recoveryIntents.values()].some(
        (entry) =>
          entry.intent.sessionId === snapshot.view.session.id &&
          ['submitting', 'accepted', 'outcome_unknown'].includes(entry.status),
      )
    ) {
      this.publish({ error: 'recovery_intent_pending' });
      return;
    }
    if (this.recoveryIntents.size >= 128) {
      this.publish({ error: 'recovery_intent_limit' });
      return;
    }
    const sessionId = snapshot.view.session.id,
      commandId = this.port.nextCommandId();
    const intent: TuiRecoveryIntent = freezeIntent(
      kind === 'interrupt'
        ? {
            kind,
            sessionId,
            request: {
              kind: 'session.recover',
              expectedStoreId: this.port.storeId,
              commandId,
              decision: 'interrupt',
            },
          }
        : kind === 'run'
          ? {
              kind,
              sessionId,
              request: {
                kind: 'run.resume',
                expectedStoreId: this.port.storeId,
                commandId,
                runId: targetId,
              },
            }
          : {
              kind,
              sessionId,
              reportCommandId: targetId,
              request: { expectedStoreId: this.port.storeId, commandId },
            },
    );
    const pending: TuiRecoveryOutcome = { intent, status: 'submitting' };
    this.recoveryIntents.set(commandId, pending);
    this.publish({ recovery: pending, error: undefined });
    const read = this.reading();
    this.recoveryRead = read;
    try {
      this.saveRecovery(intent, await port.submit(intent, read.signal));
    } catch {
      this.saveRecovery(intent, { intent, status: 'outcome_unknown' });
    } finally {
      this.reads.delete(read);
      if (this.recoveryRead === read) this.recoveryRead = undefined;
    }
  }
  private saveRecovery(intent: TuiRecoveryIntent, result: TuiRecoveryOutcome) {
    let safe: TuiRecoveryOutcome = { intent, status: 'outcome_unknown' };
    try {
      if (JSON.stringify(result.intent) !== JSON.stringify(intent))
        throw Error('recovery_scope_mismatch');
      if (result.status === 'failed' || result.status === 'outcome_unknown')
        safe = { ...result, intent };
      else {
        const command = result.command;
        if (
          !command ||
          command.id !== intent.request.commandId ||
          command.sessionId !== intent.sessionId ||
          command.originStoreId !== intent.request.expectedStoreId
        )
          throw Error('recovery_scope_mismatch');
        if (intent.kind === 'interrupt') {
          const checked = decodeSessionRecoveryCommand(command);
          if (
            result.status !== 'interrupted' ||
            checked.receipt.sessionId !== intent.sessionId ||
            checked.receipt.storeId !== intent.request.expectedStoreId
          )
            throw Error('recovery_scope_mismatch');
        } else if (intent.kind === 'run') {
          const checked = decodeRunResumeCommand(command);
          if (checked.status === 'accepted') {
            if (result.status !== 'accepted' || result.run) throw Error('recovery_scope_mismatch');
          } else if (
            result.status !== 'resumed' ||
            checked.receipt.runId !== intent.request.runId ||
            result.run?.id !== intent.request.runId ||
            result.run.originCommandId !== checked.receipt.originalCommandId
          )
            throw Error('recovery_scope_mismatch');
        } else {
          const checked = decodeJobReportResumeCommand(command);
          if (checked.receipt.reportCommandId !== intent.reportCommandId)
            throw Error('recovery_scope_mismatch');
          if (checked.receipt.outcome === 'report_suppressed') {
            if (result.status !== 'suppressed' || result.run)
              throw Error('recovery_scope_mismatch');
          } else if (
            result.status !== 'resumed' ||
            result.run?.id !== checked.receipt.runId ||
            result.run.originCommandId !== intent.reportCommandId
          )
            throw Error('recovery_scope_mismatch');
        }
        if (
          result.run &&
          (result.run.sessionId !== intent.sessionId ||
            result.run.originStoreId !== intent.request.expectedStoreId)
        )
          throw Error('recovery_scope_mismatch');
        safe = { ...result, intent };
      }
    } catch {
      /* Preserve the original identity and keep the unverified receipt unknown. */
    }
    this.recoveryIntents.set(intent.request.commandId, safe);
    this.publish({ recovery: safe });
  }
  async lookupRecovery() {
    const saved =
      [...this.recoveryIntents.values()].find((entry) =>
        ['submitting', 'accepted', 'outcome_unknown'].includes(entry.status),
      ) ?? this.value.recovery;
    if (!saved || !this.port.recovery || (this.recoveryRead && !this.recoveryRead.signal.aborted))
      return;
    const read = this.reading();
    this.recoveryRead = read;
    try {
      const result = await this.port.recovery.lookup(saved.intent, read.signal);
      if (!read.signal.aborted) this.saveRecovery(saved.intent, result);
    } catch {
      if (!read.signal.aborted)
        this.saveRecovery(saved.intent, { intent: saved.intent, status: 'outcome_unknown' });
    } finally {
      this.reads.delete(read);
      if (this.recoveryRead === read) this.recoveryRead = undefined;
    }
  }
  cancelRecoveryRead() {
    this.recoveryRead?.abort();
  }
  private pendingRecovery(anySession = false) {
    return [...this.recoveryIntents.values()].some(
      (entry) =>
        (anySession || entry.intent.sessionId === this.value.sessionId) &&
        ['submitting', 'accepted', 'outcome_unknown'].includes(entry.status),
    );
  }
  async openStatus() {
    const port = this.port.status,
      session = this.value.snapshot?.view.session;
    if (!port || !session || this.disposed) {
      this.publish({ error: 'host_status_unavailable' });
      return;
    }
    this.statusRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.statusRead = read;
    this.publish({
      panel: 'status',
      status: { facts: this.value.status?.facts, connection: 'checking' },
      error: undefined,
    });
    try {
      const facts = await port.read(session.id, session.workspaceId, read.signal);
      if (read.signal.aborted || generation !== this.generation || this.value.panel !== 'status')
        return;
      if (
        facts.identity.storeId !== this.port.storeId ||
        facts.scope.sessionId !== session.id ||
        facts.scope.workspaceId !== session.workspaceId
      )
        throw Error('host_status_scope_mismatch');
      this.publish({
        status: { facts: freezeIntent(structuredClone(facts)), connection: 'verified' },
      });
    } catch {
      if (!read.signal.aborted && generation === this.generation && this.value.panel === 'status')
        this.publish({
          status: {
            facts: this.value.status?.facts,
            connection: 'unknown',
            error: 'host_status_unavailable',
          },
        });
    } finally {
      this.reads.delete(read);
    }
  }
  async readContext(panel: 'context' | 'rewind' = 'context') {
    const snapshot = this.value.snapshot,
      port = this.port.management;
    if (!snapshot || !port || this.value.snapshotStale || this.disposed) {
      this.publish({ error: 'management_unavailable' });
      return;
    }
    this.contextRead?.abort();
    const generation = this.generation,
      read = this.reading(),
      session = snapshot.view.session;
    this.contextRead = read;
    this.publish({ panel, context: undefined, error: undefined });
    try {
      const page = await port.readContext(session.id, session.contextSelectionId, read.signal);
      if (read.signal.aborted || generation !== this.generation) return;
      if (
        page.selection.sessionId !== session.id ||
        page.selection.id !== session.contextSelectionId
      )
        throw new Error('context_identity_mismatch');
      this.publish({ context: page });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({ error: error instanceof Error ? error.message : 'context_read_failed' });
    } finally {
      this.reads.delete(read);
    }
  }
  async manage(intent: TuiManagementIntent) {
    if (this.disposed || !this.port.management) return;
    const saved = freezeIntent(structuredClone(intent)),
      prior = this.managementIntents.get(saved.request.commandId);
    if (prior) {
      if (JSON.stringify(prior.intent) !== JSON.stringify(saved)) {
        this.publish({ error: 'command_conflict' });
        return;
      }
      await this.lookupManagement(saved.request.commandId);
      return;
    }
    const snapshot = this.value.snapshot;
    if (
      !snapshot ||
      this.value.stale ||
      snapshot.view.session.id !== saved.sessionId ||
      saved.request.expectedStoreId !== this.port.storeId ||
      snapshot.view.session.parentSessionId !== null ||
      snapshot.view.session.rootSessionId !== saved.sessionId
    ) {
      this.publish({ error: 'management_scope_unavailable' });
      return;
    }
    const generation = this.generation;
    if (this.managementIntents.size >= 128) {
      this.publish({ error: 'management_intent_limit' });
      return;
    }
    const pending: TuiManagementOutcome = { intent: saved, status: 'outcome_unknown' };
    this.managementIntents.set(saved.request.commandId, pending);
    this.publish({ management: pending });
    let result: TuiManagementOutcome;
    try {
      result = await this.port.management.manage(saved);
    } catch {
      result = pending;
    }
    if (JSON.stringify(result.intent) !== JSON.stringify(saved)) result = pending;
    this.managementIntents.set(saved.request.commandId, result);
    this.publish({ management: result });
    if (
      !this.disposed &&
      generation === this.generation &&
      this.value.sessionId === saved.sessionId &&
      result.status === 'delete_requested' &&
      saved.kind === 'session.delete'
    ) {
      try {
        await this.port.management.newSession();
      } catch {
        this.publish({ error: 'session_creation_unknown' });
      }
    }
    if (!this.disposed && this.value.sessionId === saved.sessionId && result.status === 'applied') {
      if (saved.kind === 'session.fork') {
        await this.list();
        if (generation === this.generation && this.value.sessionId === saved.sessionId)
          await this.select(saved.request.newSessionId);
      } else await this.select(saved.sessionId);
    }
  }
  async lookupManagement(commandId?: string) {
    const saved = commandId ? this.managementIntents.get(commandId) : this.value.management;
    if (!saved || !this.port.management || this.disposed) return;
    let result: TuiManagementOutcome;
    try {
      result = await this.port.management.lookup(structuredClone(saved.intent));
    } catch {
      return;
    }
    if (JSON.stringify(result.intent) !== JSON.stringify(saved.intent)) return;
    this.managementIntents.set(saved.intent.request.commandId, result);
    this.publish({ management: result });
    if (this.value.sessionId === saved.intent.sessionId && result.status === 'applied')
      await this.select(saved.intent.sessionId);
  }
  async rewindBoundary(boundary: { messageId: string; seq: string } | null) {
    const snapshot = this.value.snapshot,
      context = this.value.context;
    if (
      !snapshot ||
      !context ||
      snapshot.view.runs.some((r) => r.isActive) ||
      context.selection.id !== snapshot.view.session.contextSelectionId
    ) {
      this.publish({ error: 'rewind_requires_idle_current_selection' });
      return;
    }
    if (
      boundary &&
      !context.messages.some((m) => m.id === boundary.messageId && m.seq === boundary.seq)
    ) {
      this.publish({ error: 'boundary_unavailable' });
      return;
    }
    await this.manage({
      kind: 'session.fork',
      sessionId: snapshot.view.session.id,
      request: {
        expectedStoreId: this.port.storeId,
        commandId: this.port.nextCommandId(),
        expectedContextSelectionId: context.selection.id,
        boundary,
        newSessionId: this.port.nextCommandId(),
        title: 'Restored conversation',
      },
    });
  }
  async includeExecution(executionId: string) {
    const snapshot = this.value.snapshot;
    if (!snapshot || this.value.stale) return;
    const execution = snapshot.view.executions.find((e) => e.id === executionId),
      run = snapshot.view.runs.find((r) => r.isActive);
    if (
      !execution ||
      execution.originStoreId !== this.port.storeId ||
      execution.sessionId !== snapshot.view.session.id ||
      !execution.resultRevision ||
      !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status) ||
      (run && !['running', 'waiting_execution', 'waiting_interaction'].includes(run.status))
    ) {
      this.publish({ error: 'result_identity_unavailable' });
      return;
    }
    await this.manage({
      kind: 'result.include',
      sessionId: snapshot.view.session.id,
      executionId,
      request: {
        expectedStoreId: this.port.storeId,
        commandId: this.port.nextCommandId(),
        expectedContextSelectionId: snapshot.view.session.contextSelectionId,
        resultRevision: execution.resultRevision,
        ...(run ? { targetRunId: run.id } : {}),
      },
    });
  }
  private async restoreMcp(): Promise<boolean> {
    if (!this.port.mcp?.list) return true;
    try {
      const rows = await this.port.mcp.list();
      if (rows.length > 128) throw Error('mcp_intent_limit');
      const restored = new Map<string, TuiMcpOutcome>();
      for (const row of rows) {
        const key = row.intent.request.commandId;
        if (restored.has(key)) throw Error('mcp_restore_conflict');
        const known = this.mcpIntents.get(key);
        if (known && JSON.stringify(known.intent) !== JSON.stringify(row.intent))
          throw Error('mcp_restore_conflict');
        restored.set(key, known ?? freezeIntent(structuredClone(row)));
      }
      if (this.disposed) return false;
      this.mcpIntents = restored;
      this.publish({ mcpSaved: [...restored.values()], mcpUnavailable: undefined });
      return true;
    } catch (error) {
      if (!this.disposed)
        this.publish({
          mcpUnavailable:
            error instanceof Error ? error.message : 'mcp_selection_journal_unavailable',
        });
      return false;
    }
  }
  selectMcpOriginal(commandId: string) {
    const outcome = this.mcpIntents.get(commandId);
    if (outcome && outcome.intent.sessionId === this.value.sessionId && this.value.panel === 'mcp')
      this.publish({ mcpOutcome: outcome });
  }
  private async readMcpTools(
    pending: TuiMcpToolsState,
    work: (signal: AbortSignal) => Promise<TuiMcpToolsState>,
  ) {
    const session = this.value.snapshot?.view.session;
    if (!session || this.value.panel !== 'mcp' || this.disposed) return;
    this.mcpToolsRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpToolsRead = read;
    const current = () =>
      !read.signal.aborted &&
      !this.disposed &&
      this.mcpToolsRead === read &&
      this.generation === generation &&
      this.value.panel === 'mcp' &&
      this.value.sessionId === session.id &&
      this.value.snapshot?.view.session.workspaceId === session.workspaceId;
    this.publish({ mcpTools: { ...pending, phase: 'reading', error: undefined } });
    try {
      const result = await work(read.signal);
      if (current()) this.publish({ mcpTools: freezeIntent(structuredClone(result)) });
    } catch (error) {
      if (current())
        this.publish({
          mcpTools: {
            ...pending,
            phase: 'failed',
            error: error instanceof Error ? error.message : 'mcp_tools_unavailable',
          },
        });
    } finally {
      this.reads.delete(read);
    }
  }
  private async restoreMcpConnections(): Promise<boolean> {
    const port = this.port.mcp?.connection;
    if (!port) return false;
    try {
      const rows = await port.list();
      if (rows.length > 128) throw Error('mcp_connection_intent_limit');
      const restored = new Map(this.mcpConnectionIntents);
      const seen = new Set<string>();
      for (const row of rows) {
        const id = row.intent.request.commandId;
        if (seen.has(id)) throw Error('mcp_connection_restore_conflict');
        seen.add(id);
        const known = restored.get(id);
        if (known && JSON.stringify(known.intent) !== JSON.stringify(row.intent))
          throw Error('mcp_connection_restore_conflict');
        restored.set(
          id,
          known ??
            freezeIntent(
              this.port.mcp?.reconnection
                ? { intent: structuredClone(row.intent), phase: 'outcome_unknown' as const }
                : structuredClone(row),
            ),
        );
      }
      if (restored.size > 128) throw Error('mcp_connection_intent_limit');
      if (this.disposed) return false;
      this.mcpConnectionIntents = restored;
      this.publish({ mcpConnections: [...restored.values()], mcpConnectionUnavailable: undefined });
      return true;
    } catch (error) {
      if (!this.disposed)
        this.publish({
          mcpConnectionUnavailable:
            error instanceof Error ? error.message : 'mcp_connection_journal_unavailable',
        });
      return false;
    }
  }
  selectMcpConnection(commandId: string) {
    const outcome = this.mcpConnectionIntents.get(commandId);
    if (
      outcome &&
      outcome.intent.sessionId === this.value.sessionId &&
      this.value.panel === 'mcp'
    ) {
      this.mcpConnectionRead?.abort();
      this.publish({ mcpConnection: outcome, mcpConnectionReading: false });
    }
  }
  async requestMcpConnection(serverId: string, observed = this.value.mcp?.facts) {
    const session = this.value.snapshot?.view.session,
      port = this.port.mcp?.connection;
    if (
      !session ||
      !port ||
      this.disposed ||
      this.mcpConnectionBusy ||
      this.mcpReconnectionBusy ||
      this.value.stale ||
      this.value.panel !== 'mcp' ||
      this.value.mcp?.read !== 'ready' ||
      !observed ||
      observed !== this.value.mcp.facts ||
      observed.storeId !== this.port.storeId ||
      observed.sessionId !== session.id ||
      observed.workspaceId !== session.workspaceId
    )
      return;
    if (
      !(await this.restoreMcpConnections()) ||
      (this.port.mcp?.reconnection && !(await this.restoreMcpReconnections())) ||
      this.disposed ||
      this.mcpConnectionBusy ||
      this.mcpReconnectionBusy ||
      this.value.snapshot?.view.session.id !== session.id ||
      this.value.snapshot?.view.session.workspaceId !== session.workspaceId ||
      this.value.panel !== 'mcp' ||
      observed !== this.value.mcp?.facts ||
      this.value.mcp.read !== 'ready'
    )
      return;
    const server = observed.items.find((row) => row.id === serverId);
    if (!server?.admitted || !server.selected || !server.available) {
      this.publish({ error: 'mcp_connection_unavailable' });
      return;
    }
    if (
      [...this.mcpConnectionIntents.values(), ...this.mcpReconnectionIntents.values()].some(
        (row) =>
          row.intent.request.expectedStoreId === this.port.storeId &&
          row.intent.sessionId === session.id &&
          row.intent.request.input.serverId === serverId &&
          ['pending', 'outcome_unknown'].includes(row.phase),
      )
    ) {
      this.publish({ error: 'mcp_original_connection_required' });
      return;
    }
    if (this.mcpConnectionIntents.size >= 128) {
      this.publish({ error: 'mcp_connection_intent_limit' });
      return;
    }
    const generation = this.generation;
    const intent: TuiMcpConnectionIntent = freezeIntent({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workspaceIdentity: observed.workspaceIdentity,
      request: {
        expectedStoreId: this.port.storeId,
        commandId: this.port.nextCommandId(),
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId: 'mcp.connect',
        definitionVersion: '1',
        input: { serverId, key: globalThis.crypto.randomUUID() },
      },
    });
    let outcome: TuiMcpConnectionOutcome = { intent, phase: 'outcome_unknown' };
    this.mcpConnectionBusy = true;
    this.mcpConnectionRead?.abort();
    this.mcpConnectionIntents.set(intent.request.commandId, outcome);
    this.publish({
      mcpConnection: outcome,
      mcpConnections: [...this.mcpConnectionIntents.values()],
      error: undefined,
    });
    try {
      const reply = await port.submit(intent, observed);
      if (JSON.stringify(reply.intent) === JSON.stringify(intent))
        outcome = freezeIntent(structuredClone(reply));
    } catch {
    } finally {
      this.mcpConnectionBusy = false;
    }
    this.mcpConnectionIntents.set(intent.request.commandId, outcome);
    this.publish({ mcpConnections: [...this.mcpConnectionIntents.values()] });
    if (
      this.disposed ||
      generation !== this.generation ||
      this.value.panel !== 'mcp' ||
      this.value.sessionId !== session.id ||
      this.value.snapshot?.view.session.workspaceId !== session.workspaceId ||
      this.value.mcpConnection?.intent.request.commandId !== intent.request.commandId
    )
      return;
    this.publish({
      mcpConnection: outcome,
      error: outcome.phase === 'failed' ? 'mcp_connection_failed' : undefined,
    });
  }
  async lookupMcpConnection() {
    const original = this.value.mcpConnection,
      port = this.port.mcp?.connection;
    if (
      !original ||
      !port ||
      this.disposed ||
      this.value.panel !== 'mcp' ||
      this.value.sessionId !== original.intent.sessionId
    )
      return;
    this.mcpConnectionRead?.abort();
    const read = this.reading(),
      generation = this.generation,
      workspaceId = this.value.snapshot?.view.session.workspaceId;
    this.mcpConnectionRead = read;
    this.publish({ mcpConnectionReading: true });
    let outcome: TuiMcpConnectionOutcome = {
      ...original,
      phase: 'outcome_unknown',
      fact: undefined,
    };
    try {
      const reply = await port.lookup(original.intent, read.signal);
      if (!read.signal.aborted && JSON.stringify(reply.intent) === JSON.stringify(original.intent))
        outcome = freezeIntent(structuredClone(reply));
    } catch {
    } finally {
      this.reads.delete(read);
    }
    if (read.signal.aborted) return;
    this.mcpConnectionIntents.set(original.intent.request.commandId, outcome);
    this.publish({ mcpConnections: [...this.mcpConnectionIntents.values()] });
    if (
      this.disposed ||
      this.mcpConnectionRead !== read ||
      generation !== this.generation ||
      this.value.panel !== 'mcp' ||
      this.value.sessionId !== original.intent.sessionId ||
      this.value.snapshot?.view.session.workspaceId !== workspaceId ||
      this.value.mcpConnection?.intent.request.commandId !== original.intent.request.commandId
    )
      return;
    this.publish({ mcpConnection: outcome, mcpConnectionReading: false });
  }
  private async restoreMcpReconnections(): Promise<boolean> {
    const port = this.port.mcp?.reconnection;
    if (!port) return false;
    try {
      const rows = await port.list();
      if (!Array.isArray(rows) || rows.length > 128) throw Error('mcp_reconnection_intent_limit');
      const restored = new Map(this.mcpReconnectionIntents),
        seen = new Set<string>();
      for (const row of rows) {
        if (
          !row ||
          typeof row !== 'object' ||
          Object.keys(row).some((k) => !['intent', 'phase', 'command', 'fact'].includes(k)) ||
          !['pending', 'ready', 'failed', 'cancelled', 'outcome_unknown'].includes(row.phase)
        )
          throw Error('mcp_reconnection_journal_invalid');
        const intent = freezeIntent(parseReconnectionIntent(row.intent)),
          id = intent.request.commandId;
        if (seen.has(id)) throw Error('mcp_reconnection_restore_conflict');
        seen.add(id);
        const known = restored.get(id);
        if (known && !sameReconnectionValue(known.intent, intent))
          throw Error('mcp_reconnection_restore_conflict');
        // Cold phases and cached facts never admit a new force operation before explicit Check.
        restored.set(id, known ?? freezeIntent({ intent, phase: 'outcome_unknown' as const }));
      }
      if (restored.size > 128) throw Error('mcp_reconnection_intent_limit');
      if (this.disposed) return false;
      this.mcpReconnectionIntents = restored;
      this.publish({
        mcpReconnections: [...restored.values()],
        mcpReconnectionUnavailable: undefined,
      });
      return true;
    } catch (error) {
      if (!this.disposed)
        this.publish({
          mcpReconnectionUnavailable:
            error instanceof Error ? error.message : 'mcp_reconnection_journal_unavailable',
        });
      return false;
    }
  }
  async openMcpReconnections() {
    if (!this.port.mcp?.reconnection || !this.value.snapshot?.view.session || this.disposed) return;
    this.closeMcpSources();
    this.mcpToolsRead?.abort();
    this.mcpReconnectionRead?.abort();
    this.publish({
      panel: 'mcp',
      mcpTools: undefined,
      mcpReconnectionOpen: true,
      mcpReconnectionObservation: undefined,
      mcpReconnectionReading: false,
      mcpReconnectionObserving: false,
    });
    await this.restoreMcpReconnections();
  }
  closeMcpReconnections() {
    this.mcpReconnectionRead?.abort();
    this.publish({
      mcpReconnectionOpen: false,
      mcpReconnectionObservation: undefined,
      mcpReconnectionReading: false,
      mcpReconnectionObserving: false,
    });
  }
  selectMcpReconnection(commandId: string) {
    const row = this.mcpReconnectionIntents.get(commandId);
    if (
      !row ||
      row.intent.workspaceId !== this.value.snapshot?.view.session.workspaceId ||
      this.value.panel !== 'mcp' ||
      !this.value.mcpReconnectionOpen
    )
      return;
    this.mcpReconnectionRead?.abort();
    this.publish({
      mcpReconnection: row,
      mcpReconnectionObservation: undefined,
      mcpReconnectionReading: false,
      mcpReconnectionObserving: false,
    });
  }
  canReviewMcpReconnection(kind: 'connection' | 'reconnection') {
    const session = this.value.snapshot?.view.session;
    return (
      !!session &&
      !!this.port.mcp?.reconnection &&
      !this.value.stale &&
      !this.value.snapshotStale &&
      !!reconnectionCarrier(
        kind === 'connection' ? this.value.mcpConnection : this.value.mcpReconnection,
        this.port.storeId,
        session.id,
        session.workspaceId,
      )
    );
  }
  async reviewMcpReconnection(kind: 'connection' | 'reconnection') {
    const port = this.port.mcp?.reconnection,
      session = this.value.snapshot?.view.session;
    if (
      !port ||
      !session ||
      this.disposed ||
      this.value.panel !== 'mcp' ||
      !this.canReviewMcpReconnection(kind)
    )
      return;
    const outcome = kind === 'connection' ? this.value.mcpConnection : this.value.mcpReconnection;
    const carrier = reconnectionCarrier(
      outcome,
      this.port.storeId,
      session.id,
      session.workspaceId,
    );
    if (!carrier || !outcome?.fact) return;
    const fact = outcome.fact;
    this.closeMcpSources();
    this.mcpToolsRead?.abort();
    this.mcpReconnectionRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpReconnectionRead = read;
    const current = () =>
      !this.disposed &&
      !read.signal.aborted &&
      this.mcpReconnectionRead === read &&
      generation === this.generation &&
      this.value.panel === 'mcp' &&
      this.value.mcpReconnectionOpen &&
      this.value.sessionId === session.id &&
      this.value.snapshot?.view.session.workspaceId === session.workspaceId;
    this.publish({
      mcpTools: undefined,
      mcpReconnectionOpen: true,
      mcpReconnectionObservation: undefined,
      mcpReconnectionObserving: true,
      error: undefined,
    });
    try {
      const observed = await port.observe(freezeIntent(carrier), read.signal);
      if (!current()) return;
      const ref = 'newOperationRef' in fact ? fact.newOperationRef : fact.operationRef;
      const connection = 'newConnection' in fact ? fact.newConnection : fact.connection;
      if (
        !sameReconnectionValue(observed.carrier, carrier) ||
        !ref ||
        !connection ||
        observed.target.carrierExecutionId !== fact.execution.id ||
        observed.target.carrierKey !== carrier.request.input.key ||
        !sameReconnectionValue(observed.target.operationRef, ref) ||
        observed.target.connectionExecutionId !== connection.id ||
        observed.target.configDigest !== fact.ready?.configDigest ||
        observed.target.currentGeneration !== fact.currentGeneration ||
        observed.management.storeId !== this.port.storeId ||
        observed.management.sessionId !== session.id ||
        observed.management.workspaceId !== session.workspaceId ||
        observed.management.workspaceIdentity !== carrier.workspaceIdentity
      )
        throw Error('mcp_reconnection_observation_mismatch');
      if (
        observed.replacement.kind === 'source' &&
        (!observed.source ||
          observed.source.storeId !== this.port.storeId ||
          observed.source.sessionId !== session.id ||
          observed.source.workspaceId !== session.workspaceId ||
          observed.source.workspaceIdentity !== carrier.workspaceIdentity ||
          !sameReconnectionValue(observed.replacement.expectedReadSet, observed.source.readSet))
      )
        throw Error('mcp_reconnection_source_mismatch');
      const validation = [
        'ui_review_validation_0',
        'ui_review_validation_1',
        'ui_review_validation_2',
        'ui_review_validation_3',
        'ui_review_validation_4',
      ].find(
        (value) =>
          value !== carrier.request.commandId &&
          value !== observed.target.operationRef.commandId &&
          value !== observed.target.carrierKey &&
          value !== observed.target.operationRef.key.split('/')[2],
      )!;
      // Validate both full requests before showing Confirm, without consuming a Command ID.
      parseReconnectionIntent({
        ...carrier,
        targetRequest: carrier.request,
        request: {
          expectedStoreId: this.port.storeId,
          commandId: validation,
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp',
          actionId: 'mcp.reconnect',
          definitionVersion: '1',
          input: {
            serverId: carrier.request.input.serverId,
            key: validation,
            target: observed.target,
            replacement: observed.replacement,
          },
        },
      });
      this.publish({
        mcpReconnectionObservation: freezeIntent(structuredClone(observed)),
        mcpReconnectionObserving: false,
      });
    } catch (error) {
      if (current())
        this.publish({
          mcpReconnectionObserving: false,
          error: error instanceof Error ? error.message : 'mcp_reconnection_observation_failed',
        });
    } finally {
      this.reads.delete(read);
    }
  }
  private currentReconnectionObservation(observed: TuiMcpReconnectionObservation) {
    const session = this.value.snapshot?.view.session;
    if (!session) return false;
    const carrier = reconnectionCarrier(
      observed.carrier.request.actionId === 'mcp.connect'
        ? this.value.mcpConnection
        : this.value.mcpReconnection,
      this.port.storeId,
      session.id,
      session.workspaceId,
    );
    return !!carrier && sameReconnectionValue(carrier, observed.carrier);
  }
  async confirmMcpReconnection(observed = this.value.mcpReconnectionObservation) {
    const port = this.port.mcp?.reconnection,
      session = this.value.snapshot?.view.session;
    if (
      !port ||
      !session ||
      !observed ||
      observed !== this.value.mcpReconnectionObservation ||
      !this.currentReconnectionObservation(observed) ||
      this.disposed ||
      this.value.stale ||
      this.value.snapshotStale ||
      this.mcpConnectionBusy ||
      this.mcpReconnectionBusy ||
      !this.value.mcpReconnectionOpen ||
      this.value.panel !== 'mcp'
    )
      return;
    if (
      !(await this.restoreMcpReconnections()) ||
      (this.port.mcp?.connection && !(await this.restoreMcpConnections())) ||
      observed !== this.value.mcpReconnectionObservation ||
      !this.currentReconnectionObservation(observed) ||
      this.disposed ||
      this.value.stale ||
      this.value.snapshotStale ||
      this.mcpReconnectionBusy ||
      this.mcpConnectionBusy ||
      this.value.sessionId !== session.id ||
      this.value.snapshot?.view.session.workspaceId !== session.workspaceId ||
      !this.value.mcpReconnectionOpen ||
      this.value.panel !== 'mcp'
    )
      return;
    if (
      [...this.mcpConnectionIntents.values(), ...this.mcpReconnectionIntents.values()].some(
        (row) =>
          row.intent.request.expectedStoreId === this.port.storeId &&
          row.intent.sessionId === session.id &&
          row.intent.request.input.serverId === observed.carrier.request.input.serverId &&
          ['pending', 'outcome_unknown'].includes(row.phase),
      )
    ) {
      this.publish({ error: 'mcp_original_connection_required' });
      return;
    }
    if (this.mcpReconnectionIntents.size >= 128) {
      this.publish({ error: 'mcp_reconnection_intent_limit' });
      return;
    }
    const intent = freezeIntent(
      parseReconnectionIntent({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workspaceIdentity: observed.carrier.workspaceIdentity,
        targetRequest: observed.carrier.request,
        request: {
          expectedStoreId: this.port.storeId,
          commandId: this.port.nextCommandId(),
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp',
          actionId: 'mcp.reconnect',
          definitionVersion: '1',
          input: {
            serverId: observed.carrier.request.input.serverId,
            key: globalThis.crypto.randomUUID(),
            target: observed.target,
            replacement: observed.replacement,
          },
        },
      }),
    );
    const generation = this.generation;
    let outcome: TuiMcpReconnectionOutcome = { intent, phase: 'outcome_unknown' };
    this.mcpReconnectionBusy = true;
    this.mcpReconnectionRead?.abort();
    this.mcpReconnectionIntents.set(intent.request.commandId, outcome);
    this.publish({
      mcpReconnection: outcome,
      mcpReconnections: [...this.mcpReconnectionIntents.values()],
      mcpReconnectionObservation: undefined,
      error: undefined,
    });
    try {
      const reply = await port.submit(intent, observed);
      if (
        sameReconnectionValue(reply.intent, intent) &&
        ['pending', 'ready', 'failed', 'cancelled', 'outcome_unknown'].includes(reply.phase)
      )
        outcome = freezeIntent(structuredClone(reply));
    } catch {
    } finally {
      this.mcpReconnectionBusy = false;
    }
    this.mcpReconnectionIntents.set(intent.request.commandId, outcome);
    this.publish({ mcpReconnections: [...this.mcpReconnectionIntents.values()] });
    if (
      !this.disposed &&
      generation === this.generation &&
      this.value.panel === 'mcp' &&
      this.value.mcpReconnectionOpen &&
      this.value.sessionId === session.id &&
      this.value.snapshot?.view.session.workspaceId === session.workspaceId &&
      this.value.mcpReconnection?.intent.request.commandId === intent.request.commandId
    )
      this.publish({ mcpReconnection: outcome });
  }
  async lookupMcpReconnection() {
    const original = this.value.mcpReconnection,
      port = this.port.mcp?.reconnection,
      session = this.value.snapshot?.view.session;
    if (
      !original ||
      !port ||
      !session ||
      this.disposed ||
      this.value.panel !== 'mcp' ||
      !this.value.mcpReconnectionOpen ||
      original.intent.request.expectedStoreId !== this.port.storeId ||
      original.intent.workspaceId !== session.workspaceId
    )
      return;
    this.mcpReconnectionRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpReconnectionRead = read;
    this.publish({ mcpReconnectionReading: true, mcpReconnectionObservation: undefined });
    let outcome: TuiMcpReconnectionOutcome = { intent: original.intent, phase: 'outcome_unknown' };
    try {
      const reply = await port.lookup(original.intent, read.signal);
      if (
        !read.signal.aborted &&
        sameReconnectionValue(reply.intent, original.intent) &&
        ['pending', 'ready', 'failed', 'cancelled', 'outcome_unknown'].includes(reply.phase)
      )
        outcome = freezeIntent(structuredClone(reply));
    } catch {
    } finally {
      this.reads.delete(read);
    }
    if (read.signal.aborted) return;
    this.mcpReconnectionIntents.set(original.intent.request.commandId, outcome);
    this.publish({ mcpReconnections: [...this.mcpReconnectionIntents.values()] });
    if (
      !this.disposed &&
      this.mcpReconnectionRead === read &&
      generation === this.generation &&
      this.value.panel === 'mcp' &&
      this.value.mcpReconnectionOpen &&
      this.value.sessionId === session.id &&
      this.value.snapshot?.view.session.workspaceId === session.workspaceId &&
      this.value.mcpReconnection?.intent.request.commandId === original.intent.request.commandId
    )
      this.publish({ mcpReconnection: outcome, mcpReconnectionReading: false });
  }
  async openMcpSourceMutations() {
    const port = this.port.mcp?.sourceMutation,
      sessionId = this.value.sessionId;
    if (!port || !sessionId || this.value.panel !== 'mcp') return;
    this.closeMcpSources();
    this.closeMcpReconnections();
    this.mcpMutationFactsRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpMutationFactsRead = read;
    this.publish({
      mcpMutationOpen: true,
      mcpMutationFacts: undefined,
      mcpMutationError: undefined,
      mcpMutationFactsReading: true,
    });
    try {
      const rows = await port.list();
      if (rows.length > 128) throw Error('mcp_source_mutation_intent_limit');
      const seen = new Set<string>();
      for (const row of rows) {
        const id = row.intent.request.commandId;
        if (seen.has(id)) throw Error('mcp_source_mutation_restore_conflict');
        seen.add(id);
        const prior = this.mcpMutationIntents.get(id);
        if (prior && JSON.stringify(prior.intent) !== JSON.stringify(row.intent))
          throw Error('mcp_source_mutation_restore_conflict');
        this.mcpMutationIntents.set(id, prior ?? freezeIntent(structuredClone(row)));
      }
      if (this.mcpMutationIntents.size > 128) throw Error('mcp_source_mutation_intent_limit');
      if (!read.signal.aborted && generation === this.generation && this.value.mcpMutationOpen)
        this.publish({ mcpMutationSaved: [...this.mcpMutationIntents.values()] });
      const facts = await port.read(sessionId, read.signal);
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        sessionId === this.value.sessionId &&
        this.value.mcpMutationOpen
      )
        this.publish({
          mcpMutationFacts: freezeIntent(structuredClone(facts)),
          mcpMutationFactsReading: false,
        });
    } catch {
      if (!read.signal.aborted && generation === this.generation && this.value.mcpMutationOpen)
        this.publish({
          mcpMutationError: 'Source directory unavailable',
          mcpMutationFactsReading: false,
        });
    } finally {
      this.reads.delete(read);
    }
  }
  closeMcpSourceMutations() {
    this.mcpMutationRead?.abort();
    this.mcpMutationFactsRead?.abort();
    this.publish({
      mcpMutationOpen: false,
      mcpMutationFactsReading: false,
      mcpMutationReading: false,
    });
  }
  selectMcpSourceMutation(id: string) {
    const row = this.mcpMutationIntents.get(id);
    if (row && this.value.panel === 'mcp' && this.value.mcpMutationOpen) {
      this.mcpMutationRead?.abort();
      this.publish({ mcpMutationOutcome: row, mcpMutationReading: false });
    }
  }
  async previewMcpSourceRemoval(
    serverId: string,
    scope: 'user' | 'workspace',
    observed: MutationSnapshot,
  ): Promise<TuiMcpSourceEntryPreview | undefined> {
    const port = this.port.mcp?.sourceMutation;
    if (
      !port ||
      !observed.readSet ||
      this.value.mcpMutationFacts !== observed ||
      !this.value.mcpMutationOpen
    )
      return;
    this.mcpMutationRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpMutationRead = read;
    try {
      const preview = await port.preview(
        observed.sessionId,
        { serverId, scope, expectedReadSet: observed.readSet },
        read.signal,
      );
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        this.value.mcpMutationOpen &&
        this.value.mcpMutationFacts === observed
      )
        return preview;
    } catch {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({ mcpMutationError: 'Source removal preview unavailable' });
    } finally {
      this.reads.delete(read);
    }
    return undefined;
  }
  async submitMcpSourceMutation(
    actionId: 'mcp.source.add' | 'mcp.source.remove',
    input: TuiMcpSourceMutationInput,
    observed: MutationSnapshot,
  ) {
    const port = this.port.mcp?.sourceMutation,
      session = this.value.snapshot?.view.session;
    if (
      !port ||
      !session ||
      this.disposed ||
      this.mcpMutationBusy ||
      this.value.stale ||
      this.value.snapshotStale ||
      !this.value.mcpMutationOpen ||
      this.value.panel !== 'mcp' ||
      this.value.mcpMutationFacts !== observed ||
      session.id !== observed.sessionId ||
      session.workspaceId !== observed.workspaceId ||
      observed.storeId !== this.port.storeId ||
      !observed.readSet
    )
      return;
    if (this.mcpMutationIntents.size >= 128) {
      this.publish({ mcpMutationError: 'Source mutation intent capacity reached' });
      return;
    }
    const intent: TuiMcpSourceMutationIntent = freezeIntent({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workspaceIdentity: observed.workspaceIdentity,
      request: {
        expectedStoreId: this.port.storeId,
        commandId: this.port.nextCommandId(),
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp.sources',
        actionId,
        definitionVersion: '1',
        input,
      },
    });
    this.mcpMutationBusy = true;
    const generation = this.generation;
    let outcome: TuiMcpSourceMutationOutcome = { intent, phase: 'outcome_unknown' };
    this.mcpMutationIntents.set(intent.request.commandId, outcome);
    this.publish({
      mcpMutationOutcome: outcome,
      mcpMutationSaved: [...this.mcpMutationIntents.values()],
      mcpMutationError: undefined,
    });
    try {
      const reply = await port.submit(intent, observed);
      if (JSON.stringify(reply.intent) !== JSON.stringify(intent))
        throw Error('mcp_source_mutation_reply_mismatch');
      outcome = freezeIntent(structuredClone(reply));
    } catch {
      if (generation === this.generation && this.value.mcpMutationOpen)
        this.publish({
          mcpMutationError: 'Source mutation unavailable; check original before retry',
        });
    } finally {
      this.mcpMutationBusy = false;
    }
    this.mcpMutationIntents.set(intent.request.commandId, outcome);
    if (!this.disposed) this.publish({ mcpMutationSaved: [...this.mcpMutationIntents.values()] });
    if (
      !this.disposed &&
      generation === this.generation &&
      this.value.mcpMutationOpen &&
      this.value.mcpMutationOutcome?.intent.request.commandId === intent.request.commandId
    )
      this.publish({ mcpMutationOutcome: outcome });
  }
  async lookupMcpSourceMutation() {
    const original = this.value.mcpMutationOutcome,
      port = this.port.mcp?.sourceMutation;
    if (
      !original ||
      !port ||
      this.disposed ||
      !this.value.mcpMutationOpen ||
      this.value.panel !== 'mcp'
    )
      return;
    this.mcpMutationRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpMutationRead = read;
    this.publish({ mcpMutationReading: true });
    try {
      const reply = await port.lookup(original.intent, read.signal);
      if (JSON.stringify(reply.intent) !== JSON.stringify(original.intent))
        throw Error('mcp_source_mutation_reply_mismatch');
      if (read.signal.aborted || this.disposed) return;
      const outcome = freezeIntent(structuredClone(reply));
      this.mcpMutationIntents.set(original.intent.request.commandId, outcome);
      this.publish({ mcpMutationSaved: [...this.mcpMutationIntents.values()] });
      if (
        generation === this.generation &&
        this.value.mcpMutationOpen &&
        this.value.mcpMutationOutcome?.intent.request.commandId ===
          original.intent.request.commandId
      )
        this.publish({ mcpMutationOutcome: outcome, mcpMutationReading: false });
    } catch {
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        this.value.mcpMutationOpen &&
        this.value.mcpMutationOutcome?.intent.request.commandId ===
          original.intent.request.commandId
      )
        this.publish({
          mcpMutationError: 'Original source mutation unavailable',
          mcpMutationReading: false,
        });
    } finally {
      this.reads.delete(read);
    }
  }
  private async restoreMcpSources() {
    const port = this.port.mcp?.source;
    if (!port) return false;
    try {
      const rows = await port.list();
      if (rows.length > 128) throw Error('mcp_source_intent_limit');
      const restored = new Map(this.mcpSourceIntents),
        seen = new Set<string>();
      for (const row of rows) {
        const id = row.intent.request.commandId;
        if (seen.has(id)) throw Error('mcp_source_restore_conflict');
        seen.add(id);
        const known = restored.get(id);
        if (known && JSON.stringify(known.intent) !== JSON.stringify(row.intent))
          throw Error('mcp_source_restore_conflict');
        restored.set(id, known ?? freezeIntent(structuredClone(row)));
      }
      if (restored.size > 128) throw Error('mcp_source_intent_limit');
      if (this.disposed) return false;
      this.mcpSourceIntents = restored;
      this.publish({ mcpSourceSaved: [...restored.values()], mcpSourceUnavailable: undefined });
      return true;
    } catch (error) {
      if (!this.disposed)
        this.publish({
          mcpSourceUnavailable:
            error instanceof Error ? error.message : 'mcp_source_journal_unavailable',
        });
      return false;
    }
  }
  async openMcpSources() {
    this.closeMcpReconnections();
    const session = this.value.snapshot?.view.session,
      port = this.port.mcp?.source;
    if (!session || !port || this.disposed) return;
    this.mcpAuthRead?.abort();
    this.mcpSourceRead?.abort();
    this.mcpSourceLookupRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpSourceRead = read;
    const current = () =>
      !this.disposed &&
      !read.signal.aborted &&
      this.mcpSourceRead === read &&
      generation === this.generation &&
      this.value.panel === 'mcp' &&
      this.value.mcpSourceOpen &&
      this.value.sessionId === session.id &&
      this.value.snapshot?.view.session.workspaceId === session.workspaceId;
    this.publish({
      panel: 'mcp',
      mcpSourceOpen: true,
      mcpSourceReading: false,
      mcpSource: { read: 'reading' },
      error: undefined,
    });
    try {
      await this.restoreMcpSources();
      if (!current()) return;
      this.publish({
        mcpSourceOutcome: [...this.mcpSourceIntents.values()].find(
          (row) =>
            row.intent.workspaceId === session.workspaceId &&
            row.intent.request.expectedStoreId === this.port.storeId &&
            ['pending', 'outcome_unknown'].includes(row.phase),
        ),
      });
      const facts = await port.read(session.id, read.signal);
      if (!current()) return;
      if (
        facts.storeId !== this.port.storeId ||
        facts.sessionId !== session.id ||
        facts.workspaceId !== session.workspaceId ||
        facts.items.length > 8192
      )
        throw Error('mcp_source_scope_mismatch');
      this.publish({ mcpSource: { facts: freezeIntent(structuredClone(facts)), read: 'ready' } });
    } catch (error) {
      if (current())
        this.publish({
          mcpSource: { read: 'failed' },
          error: error instanceof Error ? error.message : 'mcp_source_unavailable',
        });
    } finally {
      this.reads.delete(read);
    }
  }
  get hasMcpAuth() {
    return Boolean(this.port.mcpAuth && this.port.callers);
  }
  async openMcpAuth(serverId?: string) {
    const session = this.value.snapshot?.view.session,
      port = this.port.mcpAuth,
      observed = this.value.mcpSource?.facts;
    if (!session || !port || !this.value.mcpSourceOpen || this.disposed) return;
    if (
      serverId &&
      (!observed ||
        this.value.mcpSource?.read !== 'ready' ||
        !observed.items.some((x) => x.id === serverId && x.transport === 'http'))
    )
      return;
    this.mcpAuthView++;
    this.mcpAuthRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpAuthRead = read;
    this.publish({
      mcpAuthOpen: true,
      mcpAuthServerId: serverId,
      mcpAuthStatus: undefined,
      mcpAuthOutcome: undefined,
      mcpAuthReading: Boolean(serverId),
      mcpAuthError: undefined,
    });
    try {
      await this.restoreCallers();
      for (const key of this.mcpAuthOutcomes.keys())
        if (!this.value.callers.has(key)) this.mcpAuthOutcomes.delete(key);
      if (!serverId || !observed) return;
      const status = await port.read(observed, serverId, read.signal);
      if (
        this.disposed ||
        read.signal.aborted ||
        this.mcpAuthRead !== read ||
        generation !== this.generation ||
        !this.value.mcpAuthOpen ||
        this.value.sessionId !== session.id ||
        this.value.snapshot?.view.session.workspaceId !== session.workspaceId
      )
        return;
      if (
        status.serverId !== serverId ||
        status.workspaceId !== session.workspaceId ||
        !['oauth', 'auto'].includes(status.policy) ||
        !['available', 'locked', 'unavailable'].includes(status.status) ||
        typeof status.credentialPresent !== 'boolean' ||
        typeof status.loginAllowed !== 'boolean'
      )
        throw Error('mcp_auth_status_invalid');
      this.publish({ mcpAuthStatus: freezeIntent(structuredClone(status)), mcpAuthReading: false });
    } catch {
      if (!read.signal.aborted && this.mcpAuthRead === read && this.value.mcpAuthOpen)
        this.publish({ mcpAuthReading: false, mcpAuthError: 'mcp_auth_status_unavailable' });
    } finally {
      this.reads.delete(read);
    }
  }
  closeMcpAuth() {
    this.mcpAuthView++;
    this.mcpAuthRead?.abort();
    this.publish({ mcpAuthOpen: false, mcpAuthReading: false, mcpAuthError: undefined });
  }
  selectMcpAuthOriginal(key: string) {
    const row = this.value.callers.get(key);
    if (!row || !mcpAuthRequest(row.intent) || !this.value.mcpAuthOpen) return;
    this.mcpAuthRead?.abort();
    this.mcpAuthView++;
    this.publish({
      mcpAuthOutcome: this.mcpAuthOutcomes.get(key) ?? {
        intent: row.intent,
        phase: 'outcome_unknown',
      },
      mcpAuthReading: false,
      mcpAuthError: undefined,
    });
  }
  async requestMcpAuth(action: TuiMcpAuthAction, observed = this.value.mcpSource?.facts) {
    const session = this.value.snapshot?.view.session,
      status = this.value.mcpAuthStatus,
      port = this.port.mcpAuth;
    if (
      this.disposed ||
      this.mcpAuthBusy ||
      !session ||
      !port ||
      !this.port.callers ||
      !this.value.mcpAuthOpen ||
      !observed ||
      observed !== this.value.mcpSource?.facts ||
      observed.sessionId !== session.id ||
      observed.workspaceId !== session.workspaceId ||
      observed.storeId !== this.port.storeId ||
      !observed.readSet ||
      !status ||
      status.serverId !== this.value.mcpAuthServerId ||
      status.status !== 'available' ||
      (action === 'mcp.auth.login' && !status.loginAllowed) ||
      !['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.clear', 'mcp.auth.revoke'].includes(action)
    )
      return;
    this.mcpAuthBusy = true;
    const request: TuiCallerRequest = {
      expectedStoreId: this.port.storeId,
      commandId: this.port.nextCommandId(),
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp.sources',
      actionId: action,
      definitionVersion: '1',
      input: JSON.parse(
        JSON.stringify({ serverId: status.serverId, expectedReadSet: observed.readSet }),
      ),
    };
    const generation = this.generation,
      view = this.mcpAuthView;
    let intent: TuiCallerIntent | undefined;
    try {
      intent = freezeIntent(await port.prepare(request, observed));
      if (
        intent.scope.storeId !== observed.storeId ||
        intent.scope.sessionId !== observed.sessionId ||
        intent.scope.workspaceId !== observed.workspaceId ||
        JSON.stringify(intent.request) !== JSON.stringify(request)
      )
        throw Error('mcp_auth_intent_invalid');
      const key = callerKey(intent);
      this.publish({
        callers: new Map(this.value.callers).set(key, { intent, phase: 'submitting' }),
      });
      const result = await port.submit(intent);
      if (JSON.stringify(result.intent) !== JSON.stringify(intent))
        throw Error('mcp_auth_intent_invalid');
      const outcome: TuiMcpAuthOutcome = {
        intent,
        phase:
          result.phase === 'accepted' || result.phase === 'applied' ? 'pending' : 'outcome_unknown',
        caller: result,
      };
      this.mcpAuthOutcomes.set(key, outcome);
      if (this.disposed) return;
      this.publish({ callers: new Map(this.value.callers).set(key, result) });
      if (
        generation === this.generation &&
        view === this.mcpAuthView &&
        this.value.mcpAuthOpen &&
        this.value.sessionId === session.id &&
        this.value.snapshot?.view.session.workspaceId === session.workspaceId
      )
        this.publish({ mcpAuthOutcome: outcome, mcpAuthError: undefined });
    } catch {
      if (intent) {
        const key = callerKey(intent),
          outcome: TuiMcpAuthOutcome = { intent, phase: 'outcome_unknown' };
        this.mcpAuthOutcomes.set(key, outcome);
        if (!this.disposed)
          this.publish({
            callers: new Map(this.value.callers).set(key, { intent, phase: 'unknown' }),
          });
      }
      if (
        !this.disposed &&
        generation === this.generation &&
        view === this.mcpAuthView &&
        this.value.mcpAuthOpen
      )
        this.publish({ mcpAuthError: 'mcp_auth_request_unavailable' });
    } finally {
      this.mcpAuthBusy = false;
    }
  }
  async lookupMcpAuth() {
    const original = this.value.mcpAuthOutcome,
      port = this.port.mcpAuth;
    if (!original || !port || !this.value.mcpAuthOpen || this.disposed) return;
    this.mcpAuthRead?.abort();
    const read = this.reading(),
      generation = this.generation,
      key = callerKey(original.intent);
    this.mcpAuthRead = read;
    this.publish({ mcpAuthReading: true, mcpAuthError: undefined });
    try {
      const outcome = await port.lookup(original.intent, read.signal);
      if (JSON.stringify(outcome.intent) !== JSON.stringify(original.intent))
        throw Error('mcp_auth_intent_invalid');
      if (!read.signal.aborted)
        this.mcpAuthOutcomes.set(key, freezeIntent(structuredClone(outcome)));
      if (
        this.disposed ||
        read.signal.aborted ||
        generation !== this.generation ||
        this.mcpAuthRead !== read ||
        !this.value.mcpAuthOpen ||
        !this.value.mcpAuthOutcome ||
        callerKey(this.value.mcpAuthOutcome.intent) !== key
      )
        return;
      this.publish({
        mcpAuthOutcome: outcome,
        mcpAuthReading: false,
        ...(outcome.caller
          ? { callers: new Map(this.value.callers).set(key, outcome.caller) }
          : {}),
      });
    } catch {
      if (!read.signal.aborted && this.mcpAuthRead === read && this.value.mcpAuthOpen)
        this.publish({ mcpAuthReading: false, mcpAuthError: 'mcp_auth_original_unavailable' });
    } finally {
      this.reads.delete(read);
    }
  }
  async cancelMcpAuth() {
    const original = this.value.mcpAuthOutcome,
      e = original?.fact?.execution;
    if (
      !original ||
      !e ||
      original.phase !== 'pending' ||
      !['planned', 'dispatching', 'running'].includes(e.status) ||
      original.intent.scope.storeId !== this.port.storeId ||
      original.intent.scope.sessionId !== this.value.sessionId ||
      e.originStoreId !== original.intent.scope.storeId ||
      e.sessionId !== original.intent.scope.sessionId ||
      e.originCommandId !== original.intent.request.commandId ||
      original.fact?.phase !== 'pending' ||
      original.fact?.binding?.executionId !== e.id ||
      original.fact.binding.originalStoreId !== original.intent.scope.storeId ||
      original.fact.binding.sessionId !== original.intent.scope.sessionId ||
      original.fact.command?.subjectId !== original.intent.subjectId ||
      original.fact.command?.id !== original.intent.request.commandId ||
      original.fact.command.requestDigest !== original.intent.requestDigest ||
      !this.port.callers
    )
      return;
    try {
      await this.submitCaller(original.intent.scope, {
        expectedStoreId: this.port.storeId,
        commandId: this.port.nextCommandId(),
        kind: 'execution.cancel',
        executionId: e.id,
      });
    } catch {
      if (this.value.mcpAuthOpen) this.publish({ mcpAuthError: 'mcp_auth_cancel_unknown' });
    }
  }
  closeMcpSources() {
    this.closeMcpAuth();
    this.closeMcpSourceMutations();
    this.mcpAuthRead?.abort();
    this.mcpSourceRead?.abort();
    this.mcpSourceLookupRead?.abort();
    this.publish({ mcpSourceOpen: false, mcpSourceReading: false });
  }
  selectMcpSourceOriginal(commandId: string) {
    const outcome = this.mcpSourceIntents.get(commandId);
    if (
      !outcome ||
      outcome.intent.workspaceId !== this.value.snapshot?.view.session.workspaceId ||
      this.value.panel !== 'mcp' ||
      !this.value.mcpSourceOpen
    )
      return;
    this.mcpSourceLookupRead?.abort();
    this.publish({ mcpSourceOutcome: outcome, mcpSourceReading: false });
  }
  async requestMcpSourceApproval(serverId: string, observed = this.value.mcpSource?.facts) {
    const session = this.value.snapshot?.view.session,
      port = this.port.mcp?.source;
    const valid = () =>
      !this.disposed &&
      !this.mcpSourceBusy &&
      !this.value.stale &&
      !this.value.snapshotStale &&
      this.value.panel === 'mcp' &&
      this.value.mcpSourceOpen &&
      this.value.mcpSource?.read === 'ready' &&
      observed === this.value.mcpSource.facts &&
      this.value.snapshot?.view.session.id === session?.id &&
      this.value.snapshot?.view.session.workspaceId === session?.workspaceId;
    if (
      !session ||
      !port ||
      !observed ||
      !valid() ||
      observed.storeId !== this.port.storeId ||
      observed.sessionId !== session.id ||
      observed.workspaceId !== session.workspaceId
    )
      return;
    if (!(await this.restoreMcpSources()) || !valid()) return;
    if (
      !reviewableMcpSource(
        observed.items.find((row) => row.id === serverId),
        observed,
      ) ||
      !observed.readSet
    ) {
      this.publish({ error: 'mcp_source_approval_unavailable' });
      return;
    }
    if (
      [...this.mcpSourceIntents.values()].some(
        (row) =>
          row.intent.request.expectedStoreId === this.port.storeId &&
          row.intent.workspaceId === session.workspaceId &&
          row.intent.request.input.serverId === serverId &&
          ['pending', 'outcome_unknown'].includes(row.phase),
      )
    ) {
      this.publish({ error: 'mcp_original_source_required' });
      return;
    }
    if (this.mcpSourceIntents.size >= 128) {
      this.publish({ error: 'mcp_source_intent_limit' });
      return;
    }
    const generation = this.generation;
    const intent: TuiMcpSourceApprovalIntent = freezeIntent({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      workspaceIdentity: observed.workspaceIdentity,
      request: {
        expectedStoreId: this.port.storeId,
        commandId: this.port.nextCommandId(),
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp.sources',
        actionId: 'mcp.source.approve',
        definitionVersion: '1',
        input: { serverId, expectedReadSet: observed.readSet },
      },
    });
    let outcome: TuiMcpSourceApprovalOutcome = { intent, phase: 'outcome_unknown' };
    this.mcpSourceBusy = true;
    this.mcpSourceLookupRead?.abort();
    this.mcpSourceIntents.set(intent.request.commandId, outcome);
    this.publish({
      mcpSourceOutcome: outcome,
      mcpSourceSaved: [...this.mcpSourceIntents.values()],
      mcpSourceReading: false,
      error: undefined,
    });
    try {
      const reply = await port.submit(intent, observed);
      if (JSON.stringify(reply.intent) === JSON.stringify(intent))
        outcome = freezeIntent(structuredClone(reply));
    } catch {
    } finally {
      this.mcpSourceBusy = false;
    }
    this.mcpSourceIntents.set(intent.request.commandId, outcome);
    if (this.disposed) return;
    this.publish({ mcpSourceSaved: [...this.mcpSourceIntents.values()] });
    if (
      generation !== this.generation ||
      this.value.panel !== 'mcp' ||
      !this.value.mcpSourceOpen ||
      this.value.sessionId !== session.id ||
      this.value.snapshot?.view.session.workspaceId !== session.workspaceId ||
      this.value.mcpSourceOutcome?.intent.request.commandId !== intent.request.commandId
    )
      return;
    this.publish({ mcpSourceOutcome: outcome });
  }
  async lookupMcpSourceApproval() {
    const original = this.value.mcpSourceOutcome,
      port = this.port.mcp?.source;
    if (
      !original ||
      !port ||
      this.disposed ||
      this.value.panel !== 'mcp' ||
      !this.value.mcpSourceOpen ||
      original.intent.workspaceId !== this.value.snapshot?.view.session.workspaceId
    )
      return;
    this.mcpSourceLookupRead?.abort();
    const read = this.reading(),
      generation = this.generation,
      sessionId = this.value.sessionId,
      workspaceId = this.value.snapshot?.view.session.workspaceId;
    this.mcpSourceLookupRead = read;
    this.publish({ mcpSourceReading: true });
    let outcome: TuiMcpSourceApprovalOutcome = {
      ...original,
      phase: 'outcome_unknown',
      fact: undefined,
    };
    try {
      const reply = await port.lookup(original.intent, read.signal);
      if (!read.signal.aborted && JSON.stringify(reply.intent) === JSON.stringify(original.intent))
        outcome = freezeIntent(structuredClone(reply));
    } catch {
    } finally {
      this.reads.delete(read);
    }
    if (read.signal.aborted || this.disposed) return;
    this.mcpSourceIntents.set(original.intent.request.commandId, outcome);
    this.publish({ mcpSourceSaved: [...this.mcpSourceIntents.values()] });
    if (
      this.mcpSourceLookupRead !== read ||
      generation !== this.generation ||
      this.value.panel !== 'mcp' ||
      !this.value.mcpSourceOpen ||
      this.value.sessionId !== sessionId ||
      this.value.snapshot?.view.session.workspaceId !== workspaceId ||
      this.value.mcpSourceOutcome?.intent.request.commandId !== original.intent.request.commandId
    )
      return;
    this.publish({ mcpSourceOutcome: outcome, mcpSourceReading: false });
  }
  async openMcpTools(afterKey?: string) {
    this.closeMcpReconnections();
    const port = this.port.mcp,
      sessionId = this.value.sessionId;
    if (!sessionId || !port?.readToolsSnapshots) {
      this.publish({ error: 'mcp_tools_unavailable' });
      return;
    }
    await this.readMcpTools({ screen: 'snapshots', phase: 'reading' }, async (signal) => {
      const snapshots = await port.readToolsSnapshots!(sessionId, signal, { afterKey });
      if (snapshots.sessionId !== sessionId) throw Error('mcp_tools_scope_mismatch');
      if (
        afterKey &&
        ((snapshots.nextAfterKey !== null && snapshots.nextAfterKey <= afterKey) ||
          snapshots.items.some((row) => row.recordKey <= afterKey))
      )
        throw Error('mcp_tools_cursor_stale');
      return { screen: 'snapshots', phase: 'ready', snapshots };
    });
  }
  async selectMcpToolsSnapshot(recordKey: string, afterIndex = 0) {
    const current = this.value.mcpTools,
      port = this.port.mcp,
      sessionId = this.value.sessionId;
    const snapshot = current?.snapshots?.items.find((row) => row.recordKey === recordKey);
    if (!sessionId || !current || !snapshot || !port?.readToolsPage) return;
    const starts = afterIndex === 0 ? [0] : [...(current.pageStarts ?? [0]), afterIndex];
    await this.readMcpTools(
      {
        ...current,
        screen: 'tools',
        phase: 'reading',
        snapshot,
        page: undefined,
        entry: undefined,
        metadata: undefined,
        pageStarts: starts,
      },
      async (signal) => {
        const page = await port.readToolsPage!(sessionId, snapshot, signal, {
          afterIndex,
          ...(snapshot.index ? { indexDigest: snapshot.index.hash } : {}),
        });
        if (
          page.recordKey !== snapshot.recordKey ||
          !sameMcpToolsOrigin(snapshot, page) ||
          page.binding.indexDigest !== (snapshot.index?.hash ?? null) ||
          page.startIndex !== afterIndex ||
          page.toolCount !== snapshot.toolCount
        )
          throw Error('mcp_tools_binding_mismatch');
        return {
          ...current,
          screen: 'tools',
          phase: 'ready',
          snapshot,
          page,
          pageStarts: starts,
          entry: undefined,
          metadata: undefined,
        };
      },
    );
  }
  async previousMcpToolsPage() {
    const current = this.value.mcpTools,
      starts = current?.pageStarts ?? [];
    if (!current?.snapshot || starts.length < 2) return;
    this.publish({ mcpTools: { ...current, pageStarts: starts.slice(0, -2) } });
    await this.selectMcpToolsSnapshot(current.snapshot.recordKey, starts[starts.length - 2]);
  }
  async selectMcpTool(index: number) {
    const current = this.value.mcpTools,
      page = current?.page,
      port = this.port.mcp,
      sessionId = this.value.sessionId;
    const entry = page?.entries.find((row) => row.index === index);
    if (
      !current ||
      !page ||
      !entry ||
      !sessionId ||
      !port?.readToolDescriptor ||
      page.availability !== 'available'
    )
      return;
    await this.readMcpTools(
      { ...current, screen: 'descriptor', phase: 'reading', entry, metadata: undefined },
      async (signal) => ({
        ...current,
        screen: 'descriptor',
        phase: 'ready',
        entry,
        metadata: await port.readToolDescriptor!(sessionId, page.binding, entry, signal),
      }),
    );
  }
  backMcpTools() {
    const current = this.value.mcpTools;
    this.mcpToolsRead?.abort();
    this.mcpToolsRead = undefined;
    if (current?.screen === 'descriptor')
      this.publish({
        mcpTools: {
          ...current,
          screen: 'tools',
          phase: 'ready',
          entry: undefined,
          metadata: undefined,
          error: undefined,
        },
      });
    else if (current?.screen === 'tools')
      this.publish({
        mcpTools: { screen: 'snapshots', phase: 'ready', snapshots: current.snapshots },
      });
    else this.publish({ mcpTools: undefined });
  }
  async openMcp() {
    const session = this.value.snapshot?.view.session,
      port = this.port.mcp;
    if (!session || !port || this.disposed || this.value.snapshotStale) {
      this.publish({ error: 'mcp_directory_unavailable' });
      return;
    }
    this.mcpConnectionRead?.abort();
    this.closeMcpReconnections();
    this.closeMcpSources();
    this.mcpRead?.abort();
    this.mcpToolsRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.mcpRead = read;
    this.publish({
      panel: 'mcp',
      mcpTools: undefined,
      mcp: { facts: this.value.mcp?.facts, read: 'reading' },
      mcpOutcome: [...this.mcpIntents.values()].find(
        (outcome) =>
          outcome.intent.sessionId === session.id &&
          ['pending', 'outcome_unknown'].includes(outcome.phase),
      ),
      error: undefined,
    });
    try {
      if (port.reconnection) {
        await this.restoreMcpReconnections();
        if (
          read.signal.aborted ||
          generation !== this.generation ||
          this.value.panel !== 'mcp' ||
          this.value.sessionId !== session.id
        )
          return;
      }
      if (port.connection) {
        await this.restoreMcpConnections();
        if (
          read.signal.aborted ||
          generation !== this.generation ||
          this.value.panel !== 'mcp' ||
          this.value.sessionId !== session.id
        )
          return;
        this.publish({
          mcpConnection: [...this.mcpConnectionIntents.values()].find(
            (row) =>
              row.intent.sessionId === session.id &&
              ['pending', 'outcome_unknown'].includes(row.phase),
          ),
          mcpConnectionReading: false,
        });
      }
      if (port.list) {
        await this.restoreMcp();
        if (
          read.signal.aborted ||
          generation !== this.generation ||
          this.value.panel !== 'mcp' ||
          this.value.sessionId !== session.id
        )
          return;
        this.publish({
          mcpOutcome: [...this.mcpIntents.values()].find(
            (row) =>
              row.intent.sessionId === session.id &&
              ['pending', 'outcome_unknown'].includes(row.phase),
          ),
        });
      }
      const facts = await port.read(session.id, read.signal);
      if (
        read.signal.aborted ||
        generation !== this.generation ||
        this.value.panel !== 'mcp' ||
        this.value.sessionId !== session.id
      )
        return;
      if (
        facts.storeId !== this.port.storeId ||
        facts.sessionId !== session.id ||
        facts.workspaceId !== session.workspaceId
      )
        throw Error('mcp_directory_scope_mismatch');
      this.publish({ mcp: { facts: freezeIntent(structuredClone(facts)), read: 'ready' } });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation && this.value.panel === 'mcp')
        this.publish({
          mcp: { facts: this.value.mcp?.facts, read: 'failed' },
          error: error instanceof Error ? error.message : 'mcp_directory_unavailable',
        });
    } finally {
      this.reads.delete(read);
    }
  }
  async chooseMcp(
    serverId: string,
    enabled: boolean,
    scope: 'user' | 'workspace',
    observed = this.value.mcp?.facts,
  ) {
    const session = this.value.snapshot?.view.session,
      port = this.port.mcp;
    if (
      !session ||
      !port ||
      this.disposed ||
      this.mcpBusy ||
      this.value.stale ||
      this.value.panel !== 'mcp' ||
      this.value.mcp?.read !== 'ready' ||
      !observed ||
      observed !== this.value.mcp.facts ||
      observed.storeId !== this.port.storeId ||
      observed.sessionId !== session.id ||
      observed.workspaceId !== session.workspaceId
    )
      return;
    if (
      !(await this.restoreMcp()) ||
      this.disposed ||
      this.value.snapshot?.view.session.id !== session.id ||
      this.value.panel !== 'mcp' ||
      observed !== this.value.mcp?.facts
    )
      return;
    const server = observed.items.find((row) => row.id === serverId);
    if (!server?.admitted || (scope === 'workspace' && observed.readSet.workspaceEtag === null)) {
      this.publish({ error: 'mcp_selection_unavailable' });
      return;
    }
    if (
      [...this.mcpIntents.values()].some(
        (outcome) =>
          outcome.intent.request.expectedStoreId === this.port.storeId &&
          ['pending', 'outcome_unknown'].includes(outcome.phase) &&
          (scope === 'user' ||
            outcome.intent.request.input.scope === 'user' ||
            outcome.intent.workspaceId === session.workspaceId),
      )
    ) {
      this.publish({ error: 'mcp_original_outcome_required' });
      return;
    }
    if (this.mcpIntents.size >= 128) {
      this.publish({ error: 'mcp_intent_limit' });
      return;
    }
    const generation = this.generation,
      intent: TuiMcpIntent = freezeIntent({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workspaceIdentity: observed.workspaceIdentity,
        request: {
          expectedStoreId: this.port.storeId,
          commandId: this.port.nextCommandId(),
          kind: 'extension.invoke',
          extensionId: 'builtin.mcp.management',
          actionId: 'mcp.server.select',
          definitionVersion: '1',
          input: { serverId, enabled, scope, expectedReadSet: structuredClone(observed.readSet) },
        },
      });
    let outcome: TuiMcpOutcome = { intent, phase: 'outcome_unknown' };
    this.mcpBusy = true;
    this.mcpIntents.set(intent.request.commandId, outcome);
    this.publish({ mcpOutcome: outcome, error: undefined });
    try {
      const reply = await port.submit(intent);
      if (JSON.stringify(reply.intent) === JSON.stringify(intent)) outcome = reply;
    } catch {
    } finally {
      this.mcpBusy = false;
    }
    this.mcpIntents.set(intent.request.commandId, outcome);
    this.publish({ mcpSaved: [...this.mcpIntents.values()] });
    if (
      this.disposed ||
      generation !== this.generation ||
      this.value.sessionId !== session.id ||
      this.value.panel !== 'mcp'
    )
      return;
    this.publish({
      mcpOutcome: outcome,
      error: outcome.phase === 'failed' ? 'mcp_selection_failed' : undefined,
    });
    if (outcome.phase === 'applied') {
      await this.openMcp();
      if (generation === this.generation && this.value.panel === 'mcp')
        this.publish({ mcpOutcome: outcome });
    }
  }
  async lookupMcp() {
    const original = this.value.mcpOutcome,
      port = this.port.mcp,
      generation = this.generation;
    if (
      !original ||
      !port ||
      this.disposed ||
      this.mcpBusy ||
      this.value.panel !== 'mcp' ||
      this.value.sessionId !== original.intent.sessionId
    )
      return;
    this.mcpRead?.abort();
    const read = this.reading();
    this.mcpRead = read;
    let outcome: TuiMcpOutcome = { ...original, phase: 'outcome_unknown' };
    try {
      const reply = await port.lookup(original.intent, read.signal);
      if (!read.signal.aborted && JSON.stringify(reply.intent) === JSON.stringify(original.intent))
        outcome = reply;
    } catch {
    } finally {
      this.reads.delete(read);
    }
    if (read.signal.aborted) return;
    this.mcpIntents.set(original.intent.request.commandId, outcome);
    this.publish({ mcpSaved: [...this.mcpIntents.values()] });
    if (
      this.disposed ||
      generation !== this.generation ||
      this.value.sessionId !== original.intent.sessionId ||
      this.value.panel !== 'mcp'
    )
      return;
    this.publish({
      mcpOutcome: outcome,
      error: outcome.phase === 'failed' ? 'mcp_selection_failed' : undefined,
    });
    if (outcome.phase === 'applied') {
      await this.openMcp();
      if (generation === this.generation && this.value.panel === 'mcp')
        this.publish({ mcpOutcome: outcome });
    }
  }
  async openModels(panel: 'models' | 'effort' = 'models') {
    const session = this.value.snapshot?.view.session,
      port = this.port.models;
    if (!session || !port || this.disposed || this.value.snapshotStale) {
      this.publish({ error: 'model_settings_unavailable' });
      return;
    }
    const generation = this.generation;
    this.modelRead?.abort();
    const read = this.reading();
    this.modelRead = read;
    this.publish({
      panel,
      models: undefined,
      modelOutcome: [...this.modelIntents.values()].find(
        (o) =>
          o.intent.sessionId === session.id && ['pending', 'outcome_unknown'].includes(o.status),
      ),
      error: undefined,
    });
    try {
      const facts = await port.read(session.workspaceId, read.signal);
      if (
        read.signal.aborted ||
        generation !== this.generation ||
        this.value.sessionId !== session.id ||
        this.value.panel !== panel
      )
        return;
      if (
        facts.storeId !== this.port.storeId ||
        facts.scope !== 'workspace' ||
        facts.workspaceId !== session.workspaceId
      )
        throw Error('model_settings_scope_mismatch');
      this.publish({ models: freezeIntent(structuredClone(facts)) });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({
          error: error instanceof Error ? error.message : 'model_settings_unavailable',
        });
    } finally {
      this.reads.delete(read);
    }
  }
  async chooseModel(operation: ModelSettingsRequest['operation'], observed = this.value.models) {
    const session = this.value.snapshot?.view.session,
      port = this.port.models;
    if (
      !session ||
      !port ||
      !observed?.readSet ||
      observed !== this.value.models ||
      this.disposed ||
      this.value.stale ||
      !['models', 'effort'].includes(this.value.panel ?? '') ||
      observed.workspaceId !== session.workspaceId
    )
      return;
    if (
      [...this.modelIntents.values()].some(
        (o) =>
          o.intent.request.workspaceId === session.workspaceId &&
          ['pending', 'outcome_unknown'].includes(o.status),
      )
    ) {
      this.publish({ error: 'model_settings_original_outcome_required' });
      return;
    }
    const model = observed.models.find((m) => m.id === operation.modelId);
    if (
      !model ||
      (operation.kind === 'default' && (!model.enabled || !model.configured)) ||
      (operation.kind === 'enabled' &&
        !operation.enabled &&
        model.id === observed.defaultModelId) ||
      (operation.kind === 'effort' &&
        (model.reasoningEffortSupport !== 'compatible_wire' ||
          !!model.reasoningEffortReadonlyReason ||
          !model.configured ||
          (operation.reasoningEffort !== null &&
            !model.reasoningEffortChoices?.includes(operation.reasoningEffort))))
    ) {
      this.publish({ error: 'model_choice_unavailable' });
      return;
    }
    if (this.modelIntents.size >= 128) {
      this.publish({ error: 'model_settings_intent_limit' });
      return;
    }
    const generation = this.generation,
      saved: TuiModelIntent = freezeIntent({
        sessionId: session.id,
        scope: 'workspace',
        request: {
          expectedStoreId: this.port.storeId,
          commandId: this.port.nextCommandId(),
          workspaceId: session.workspaceId,
          expectedReadSet: structuredClone(observed.readSet),
          operation: structuredClone(operation),
        },
      });
    let result: TuiModelOutcome = { intent: saved, status: 'outcome_unknown' };
    this.modelIntents.set(saved.request.commandId, result);
    this.publish({ modelOutcome: result });
    try {
      const reply = await port.submit(saved);
      if (JSON.stringify(reply.intent) === JSON.stringify(saved)) result = reply;
    } catch {}
    this.modelIntents.set(saved.request.commandId, result);
    if (
      this.disposed ||
      generation !== this.generation ||
      this.value.sessionId !== session.id ||
      !['models', 'effort'].includes(this.value.panel ?? '')
    )
      return;
    this.publish({
      modelOutcome: result,
      error: result.status === 'failed' ? 'model_settings_save_failed' : undefined,
    });
    if (result.status === 'applied')
      await this.openModels(this.value.panel === 'effort' ? 'effort' : 'models');
  }
  async lookupModel() {
    const original = this.value.modelOutcome,
      port = this.port.models,
      generation = this.generation;
    if (!original || !port || this.disposed) return;
    let result = original;
    try {
      const reply = await port.lookup(original.intent);
      if (JSON.stringify(reply.intent) === JSON.stringify(original.intent)) result = reply;
    } catch {}
    this.modelIntents.set(original.intent.request.commandId, result);
    if (
      this.disposed ||
      generation !== this.generation ||
      this.value.sessionId !== original.intent.sessionId ||
      !['models', 'effort'].includes(this.value.panel ?? '')
    )
      return;
    this.publish({
      modelOutcome: result,
      error: result.status === 'failed' ? 'model_settings_save_failed' : undefined,
    });
    if (result.status === 'applied')
      await this.openModels(this.value.panel === 'effort' ? 'effort' : 'models');
  }
  async openPermissions() {
    const snapshot = this.value.snapshot,
      port = this.port.permissions;
    if (!snapshot || !port || this.disposed || this.value.snapshotStale) {
      this.publish({ error: 'permission_controls_unavailable' });
      return;
    }
    const session = snapshot.view.session,
      generation = this.generation;
    this.permissionRead?.abort();
    const read = this.reading();
    this.permissionRead = read;
    this.publish({ panel: 'permissions', permissions: undefined });
    try {
      const value = await port.read(session.id, session.workspaceId, read.signal);
      if (
        read.signal.aborted ||
        generation !== this.generation ||
        this.value.sessionId !== session.id ||
        this.value.panel !== 'permissions'
      )
        return;
      if (
        value.mode.storeId !== this.port.storeId ||
        value.mode.sessionId !== session.id ||
        value.trust.storeId !== this.port.storeId ||
        value.trust.workspaceId !== session.workspaceId ||
        value.grants.storeId !== this.port.storeId ||
        value.grants.sessionId !== session.id ||
        value.grants.nextAfterSeq !== null ||
        value.grants.items.some(
          (i) =>
            i.grant.sessionId !== session.id ||
            i.grant.originStoreId !== this.port.storeId ||
            i.grant.workspaceId !== session.workspaceId,
        )
      )
        throw new Error('permission_scope_mismatch');
      this.publish({ permissions: freezeIntent(structuredClone(value)), error: undefined });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({ error: error instanceof Error ? error.message : 'permission_read_failed' });
    } finally {
      this.reads.delete(read);
    }
  }
  async choosePermission(
    choice:
      | {
          kind: 'mode';
          mode: import('@kite-ai/client').PermissionModeState['mode'];
          makeDefault: boolean;
        }
      | { kind: 'trust'; trusted: boolean }
      | { kind: 'clear' },
    observation = this.value.permissions,
  ) {
    const current = observation,
      session = this.value.snapshot?.view.session;
    if (
      !current ||
      !session ||
      this.value.stale ||
      this.disposed ||
      !this.port.permissions ||
      current.mode.sessionId !== session.id ||
      (['pending', 'outcome_unknown'].includes(this.value.permissionOutcome?.status ?? '') &&
        (this.value.permissionOutcome?.intent.kind === 'workspace.trust'
          ? this.value.permissionOutcome.intent.workspaceId === session.workspaceId
          : this.value.permissionOutcome?.intent.sessionId === session.id))
    )
      return;
    if (choice.kind === 'mode' && current.mode.scopeSessionId !== session.id) {
      this.publish({ error: 'child_mode_inherited' });
      return;
    }
    const request = { expectedStoreId: this.port.storeId, commandId: this.port.nextCommandId() };
    const intent: TuiPermissionIntent =
      choice.kind === 'mode'
        ? {
            kind: 'permission.mode',
            sessionId: session.id,
            request: {
              ...request,
              mode: choice.mode,
              makeDefault: choice.makeDefault,
              ifRevision: current.mode.revision,
              ifDefaultRevision: current.mode.defaultRevision,
            },
          }
        : choice.kind === 'trust'
          ? {
              kind: 'workspace.trust',
              workspaceId: session.workspaceId,
              request: {
                ...request,
                trusted: choice.trusted,
                ifRevision: current.trust.revision,
                canonicalIdentity: current.trust.canonicalIdentity,
                externalReadScopeDigest: current.trust.externalReadScopeDigest,
              },
            }
          : {
              kind: 'permission.grants.clear',
              sessionId: session.id,
              request: { ...request, ifRevision: current.grants.revision },
            };
    if (this.permissionIntents.size >= 128) {
      this.publish({ error: 'permission_intent_limit' });
      return;
    }
    const saved = freezeIntent(structuredClone(intent)),
      pending: TuiPermissionOutcome = { intent: saved, status: 'outcome_unknown' };
    this.permissionIntents.set(request.commandId, pending);
    this.publish({ permissionOutcome: pending });
    let result = pending;
    try {
      result = await this.port.permissions.submit(saved);
    } catch {}
    if (JSON.stringify(result.intent) !== JSON.stringify(saved)) result = pending;
    this.permissionIntents.set(request.commandId, result);
    this.publish({ permissionOutcome: result });
    if (!this.disposed && this.value.sessionId === session.id && this.value.panel === 'permissions')
      await this.openPermissions();
  }
  async lookupPermission() {
    const original = this.value.permissionOutcome;
    if (!original || !this.port.permissions || this.disposed) return;
    let result = original;
    try {
      result = await this.port.permissions.lookup(original.intent);
    } catch {}
    if (JSON.stringify(result.intent) !== JSON.stringify(original.intent)) result = original;
    this.permissionIntents.set(original.intent.request.commandId, result);
    this.publish({ permissionOutcome: result });
    if (this.value.panel === 'permissions') await this.openPermissions();
  }
  async routeCommand(text: string) {
    const commandSession = this.value.sessionId;
    const commandDraftVersion = commandSession ? (this.draftVersions.get(commandSession) ?? 0) : 0;
    const commandScope = this.draftScope();
    let storedCommandVersion: number | undefined;
    try {
      if (commandScope) storedCommandVersion = this.port.drafts?.version(commandScope);
    } catch {
      this.draftUnavailable('tui_draft_storage_unavailable');
    }
    const consumeCommand = () => {
      if (
        !commandSession ||
        this.drafts.get(commandSession) !== text ||
        (this.draftVersions.get(commandSession) ?? 0) !== commandDraftVersion
      )
        return;
      if (this.port.drafts) {
        try {
          if (
            !commandScope ||
            storedCommandVersion === undefined ||
            !this.port.drafts.accepted(commandScope, storedCommandVersion)
          )
            return;
        } catch {
          this.draftUnavailable('tui_draft_storage_unavailable');
          return;
        }
      }
      this.drafts.set(commandSession, '');
      this.draftVersions.set(commandSession, commandDraftVersion + 1);
      if (this.value.sessionId === commandSession) this.publish({ draft: '' });
    };
    let command: ReturnType<typeof parseTuiCommand>;
    try {
      command = parseTuiCommand(text);
    } catch (error) {
      if (error instanceof Error && error.message === 'tui_command_unavailable') {
        await this.sendWorkflow(text);
      } else
        this.publish({ error: error instanceof Error ? error.message : 'invalid_tui_command' });
      return;
    }
    if (command.kind === 'plan') {
      if (command.task) await this.sendTask(command.task, true);
      else {
        this.togglePlanning();
        consumeCommand();
      }
      return;
    }
    if (command.kind === 'background') {
      consumeCommand();
      if (!this.port.executions) {
        this.publish({ error: 'tui_execution_reader_unavailable' });
        return;
      }
      this.publish({ panel: 'executions' });
      if (command.action === 'stop') await this.stopJob(command.id!);
      else if (command.action === 'output') await this.readExecution(command.id!, false);
      else if (command.action === 'child') await this.readExecution(command.id!, true);
      return;
    }
    if (command.kind === 'drafts' || command.kind === 'draft') {
      if (!this.port.drafts) {
        this.draftUnavailable('tui_draft_storage_unavailable');
        return;
      }
      try {
        const saved = this.port.drafts.flush();
        const fragments: { text: string; label?: boolean }[] = [];
        const label = (text: string) => fragments.push({ text, label: true });
        const raw = (text: string) => fragments.push({ text });
        if (!saved) {
          label('Local draft save failed; showing durable disk versions only');
          raw('\n');
        }
        if (command.kind === 'drafts') {
          const rows = this.port.drafts.list();
          if (!rows.length) label('No saved drafts');
          for (const [index, row] of rows.entries()) {
            if (index) raw('\n');
            raw(row.id);
            label(' · Store ');
            raw(row.storeId);
            label(' · Workspace ');
            raw(row.workspaceId);
            label(' · Session ');
            raw(row.sessionId);
            label(' · revision ');
            raw(String(row.revision));
          }
        } else {
          const row = await this.port.drafts.original(command.id);
          label('Original draft ');
          raw(row.id);
          label(' · association ');
          raw(row.association);
          raw('\n' + row.text);
        }
        this.publish({
          notice: fragments.map((part) => part.text).join(''),
          noticeFragments: fragments,
        });
      } catch {
        this.draftUnavailable('tui_draft_storage_unavailable');
      }
      return;
    }
    const snapshot = this.value.snapshot,
      management = this.port.management;
    if (command.kind === 'clear') {
      this.clearDisplay();
      consumeCommand();
      return;
    }
    if (command.kind === 'recovery') {
      await this.openRecovery();
      consumeCommand();
      return;
    }
    if (command.kind === 'theme' || command.kind === 'language') {
      this.openPreferences(command.kind);
      consumeCommand();
      return;
    }
    if (command.kind === 'permissions') {
      await this.openPermissions();
      consumeCommand();
      return;
    }
    if (command.kind === 'help') {
      this.publish({
        notice:
          '/plan [task] /background [stop|output|child <Job ID>] /theme /language /model /effort /new /resume /drafts /draft <id> /permissions /status /skills /mcp /clear /export /context /rewind /compact [focus] /compact reset /session rename <title> /session delete confirm /session fork <title> /exit',
      });
      consumeCommand();
      return;
    }
    if (command.kind === 'effort') {
      await this.openModels('effort');
      consumeCommand();
      return;
    }
    if (command.kind === 'model') {
      await this.openModels();
      consumeCommand();
      return;
    }
    if (command.kind === 'mcp') {
      await this.openMcp();
      consumeCommand();
      return;
    }
    if (command.kind === 'resume') {
      this.publish({ chooserRequested: true });
      consumeCommand();
      return;
    }
    if (command.kind === 'export') {
      await this.exportLoadedText();
      return;
    }
    if (command.kind === 'status') {
      await this.openStatus();
      consumeCommand();
      return;
    }
    if (command.kind === 'skills') {
      await this.openSkills();
      consumeCommand();
      return;
    }
    if (command.kind === 'exit' && management) {
      management.quit();
      return;
    }
    if (command.kind === 'rewind') {
      consumeCommand();
      await this.openFileRecovery();
      return;
    }
    if (
      !management ||
      !snapshot ||
      this.value.stale ||
      snapshot.view.session.parentSessionId !== null ||
      snapshot.view.session.rootSessionId !== snapshot.view.session.id
    ) {
      this.publish({ error: 'management_unavailable' });
      return;
    }
    if (command.kind === 'exit') {
      management.quit();
      return;
    }
    if (command.kind === 'new') {
      if (snapshot.messages.some((m) => m.role === 'user')) {
        try {
          const generation = this.generation;
          const id = await management.newSession();
          if (!this.disposed && generation === this.generation) await this.select(id);
        } catch {
          this.publish({ error: 'session_creation_unknown' });
        }
      }
      consumeCommand();
      return;
    }
    if (command.kind === 'context') {
      consumeCommand();
      await this.readContext('context');
      return;
    }
    const session = snapshot.view.session,
      base = { expectedStoreId: this.port.storeId, commandId: this.port.nextCommandId() };
    if (command.kind === 'rename')
      await this.manage({
        kind: 'session.rename',
        sessionId: session.id,
        request: { ...base, ifRevision: session.controlRevision, title: command.title },
      });
    if (command.kind === 'delete')
      await this.manage({
        kind: 'session.delete',
        sessionId: session.id,
        request: { ...base, ifRevision: session.controlRevision },
      });
    if (command.kind === 'fork')
      await this.manage({
        kind: 'session.fork',
        sessionId: session.id,
        request: {
          ...base,
          expectedContextSelectionId: session.contextSelectionId,
          newSessionId: this.port.nextCommandId(),
          title: command.title,
        },
      });
    if (command.kind === 'compact')
      await this.manage({
        kind: 'context.compress',
        sessionId: session.id,
        request: {
          ...base,
          expectedContextSelectionId: session.contextSelectionId,
          ...(command.focus ? { focus: command.focus } : {}),
        },
      });
    if (command.kind === 'compact_reset') {
      await this.readContext();
      if (
        this.value.sessionId !== session.id ||
        this.value.context?.selection.id !== session.contextSelectionId
      )
        return;
      await this.manage({
        kind: 'context.compression.reset',
        sessionId: session.id,
        request: {
          ...base,
          expectedContextSelectionId: session.contextSelectionId,
          expectedCompressionId: this.value.context.compression?.id ?? null,
        },
      });
    }
    if (
      this.value.management?.intent.request.commandId === base.commandId &&
      ['accepted', 'applied', 'delete_requested'].includes(this.value.management.status)
    )
      consumeCommand();
  }
  async loadOutput(message: Message) {
    const snapshot = this.value.snapshot,
      reader = this.port.readModelOutput;
    const original = snapshot?.messages.find((m) => m.id === message.id && m.seq === message.seq);
    if (original) message = original;
    else return;
    if (!snapshot || !reader || !message.outputBody || message.sessionId !== this.value.sessionId)
      return;
    if (
      message.outputBody.readAvailability === 'unsupported' ||
      message.contentFormat === 'unsupported'
    )
      return;
    const originalSession = message.originMessage?.sessionId ?? message.sessionId;
    const originalRun = message.originMessage ? message.originMessage.runId : message.runId;
    const originalStore = message.originMessage?.storeId ?? this.port.storeId;
    if (originalStore !== this.port.storeId) {
      this.publish({ error: 'tui_origin_store_unavailable' });
      return;
    }
    const generation = this.generation,
      read = this.reading();
    try {
      const output = await reader(originalSession, message.outputBody.executionId, read.signal);
      if (read.signal.aborted || generation !== this.generation) return;
      if (
        output.storeId !== originalStore ||
        output.sessionId !== originalSession ||
        output.executionId !== message.outputBody.executionId ||
        output.runId !== originalRun ||
        output.output.complete !== message.outputBody.complete
      )
        throw new Error('tui_output_identity_mismatch');
      this.publish({
        fullOutputs: new Map(this.value.fullOutputs).set(message.id, output.output.content),
        loadedOutputBodies: new Map(this.value.loadedOutputBodies).set(message.id, output.output),
      });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({ error: error instanceof Error ? error.message : 'output_failed' });
    } finally {
      this.reads.delete(read);
    }
  }
  async exportLoadedText() {
    const snapshot = this.value.snapshot,
      writer = this.port.exportLoadedText;
    if (!snapshot || !writer || this.disposed) {
      this.publish({ error: 'Export failed: loaded conversation unavailable' });
      return;
    }
    const generation = this.generation,
      sessionId = snapshot.view.session.id;
    const saved: TuiLoadedTextExport = freezeIntent({
      storeId: this.port.storeId,
      sessionId,
      generation,
      messages: snapshot.messages.flatMap((message) => {
        if (message.role !== 'user' && message.role !== 'assistant') return [];
        const loaded = this.value.loadedOutputBodies.get(message.id);
        return [
          {
            id: message.id,
            seq: message.seq,
            role: message.role,
            content: loaded?.content ?? message.content,
            ...(loaded?.reasoning ? { reasoning: loaded.reasoning } : {}),
            previewOnly: Boolean(message.outputBody && !loaded),
            complete: loaded?.complete ?? message.status === 'complete',
          },
        ];
      }),
    });
    const read = this.reading();
    this.publish({ notice: undefined, error: undefined });
    try {
      const result = await writer.write(saved, read.signal);
      if (
        read.signal.aborted ||
        generation !== this.generation ||
        this.value.sessionId !== sessionId
      )
        return;
      this.publish({ notice: `Exported loaded conversation: ${result.path}`, error: undefined });
      this.setDraft('');
    } catch {
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        this.value.sessionId === sessionId
      )
        this.publish({ error: 'Export failed' });
    } finally {
      this.reads.delete(read);
    }
  }
  async loadAttachment(card: Interaction) {
    const original = this.value.snapshot?.interactions.find(
      (i) => i.id === card.id && i.revision === card.revision,
    );
    if (!original) return;
    card = original;
    if (
      !this.port.readAttachment ||
      card.state !== 'pending' ||
      card.originStoreId !== this.port.storeId ||
      card.presentationSessionId !== this.value.sessionId
    )
      return;
    let proof: string | undefined;
    try {
      proof = interactionAttachment(card)?.key;
    } catch {
      return;
    }
    const generation = this.generation,
      read = this.reading();
    try {
      const content = await this.port.readAttachment(card, read.signal);
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        this.value.snapshot?.interactions.some(
          (item) => item.state === 'pending' && interactionKey(item) === interactionKey(card),
        )
      ) {
        const current = this.value.snapshot!.interactions.find(
          (item) => interactionKey(item) === interactionKey(card),
        )!;
        try {
          if (interactionAttachment(current)?.key !== proof) return;
        } catch {
          return;
        }
        const attachments = new Map(this.value.attachments);
        attachments.set(interactionKey(card), content);
        if (proof) this.attachmentProofs.set(interactionKey(card), proof);
        this.publish({
          attachments,
          attachment: { interactionId: card.id, revision: card.revision, content },
        });
      }
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({ error: error instanceof Error ? error.message : 'attachment_failed' });
    } finally {
      this.reads.delete(read);
    }
  }
  private async write(
    sessionId: string,
    commandId: string,
    kind: string,
    submit: () => Promise<Command>,
    concurrent = false,
  ) {
    if ((!concurrent && this.busy) || this.disposed) return;
    if (!concurrent) this.busy = true;
    this.publish({ intent: { sessionId, commandId, kind, phase: 'submitting' } });
    try {
      const command = await submit();
      if (
        command.id !== commandId ||
        command.originStoreId !== this.port.storeId ||
        command.sessionId !== sessionId ||
        ((this.port.callers ||
          this.submittedDrafts.get(commandId)?.request ||
          kind === 'interaction.answer') &&
          command.kind !== kind)
      )
        throw new Error('tui_receipt_identity_mismatch');
      const savedAnswer = this.answerIntent;
      if (kind === 'interaction.answer') {
        const result = record(command.receipt) ? command.receipt : {};
        if (
          !savedAnswer ||
          savedAnswer.request.commandId !== commandId ||
          (command.status !== 'rejected' &&
            (command.status !== 'applied' ||
              result.outcome !== 'answer_saved' ||
              result.interactionId !== savedAnswer.interactionId ||
              !/^(0|[1-9][0-9]*)$/.test(savedAnswer.request.expectedRevision) ||
              result.decisionRevision !==
                (BigInt(savedAnswer.request.expectedRevision) + 1n).toString()))
        )
          throw new Error('tui_answer_receipt_identity_mismatch');
        savedAnswer.phase = command.status === 'rejected' ? 'rejected' : 'applied';
        if (savedAnswer.phase === 'applied')
          this.answered.add(
            `${savedAnswer.sessionId}/${savedAnswer.interactionId}/${savedAnswer.request.expectedRevision}`,
          );
      }
      if (command.status === 'needs_review')
        this.unknownIntents.set(commandId, { sessionId, commandId, kind, phase: 'unknown' });
      else this.unknownIntents.delete(commandId);
      this.publish({
        intent: {
          sessionId,
          commandId,
          kind,
          phase:
            command.status === 'needs_review'
              ? 'unknown'
              : command.status === 'rejected'
                ? 'rejected'
                : command.status === 'applied'
                  ? 'applied'
                  : 'accepted',
        },
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'notSubmitted' in error &&
        error.notSubmitted === true
      ) {
        this.publish({
          intent: { sessionId, commandId, kind, phase: 'rejected' },
          error: error instanceof Error ? error.message : 'caller_prepare_failed',
        });
        return;
      }
      if (kind === 'interaction.answer' && this.answerIntent?.request.commandId === commandId)
        this.answerIntent.phase = 'unknown';
      this.unknownIntents.set(commandId, { sessionId, commandId, kind, phase: 'unknown' });
      this.publish({ intent: { sessionId, commandId, kind, phase: 'unknown' } });
    } finally {
      if (concurrent && this.answerIntent?.phase === 'unknown')
        this.publish({
          intent: {
            sessionId: this.answerIntent.sessionId,
            commandId: this.answerIntent.request.commandId,
            kind: 'interaction.answer',
            phase: 'unknown',
          },
        });
      if (!concurrent) this.busy = false;
    }
  }
  private workflowReading = false;
  private async sendWorkflow(text: string) {
    const token = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const snapshot = this.value.snapshot,
      sessionId = this.value.sessionId;
    if (!token || !this.port.skills?.workflowActivation) {
      this.publish({ error: 'tui_command_unavailable' });
      return;
    }
    if (
      !snapshot ||
      !sessionId ||
      this.busy ||
      this.workflowReading ||
      this.value.stale ||
      this.hasUnknownAnswer() ||
      this.pendingRecovery() ||
      this.value.intent?.phase === 'unknown'
    )
      return;
    const generation = this.generation,
      version = this.draftVersions.get(sessionId) ?? 0;
    this.workflowReading = true;
    try {
      const facts = await this.readSkills(false);
      if (
        !facts ||
        this.busy ||
        this.hasUnknownAnswer() ||
        this.state.intent?.phase === 'unknown' ||
        this.disposed ||
        generation !== this.generation ||
        this.value.sessionId !== sessionId ||
        (this.draftVersions.get(sessionId) ?? 0) !== version ||
        this.value.stale ||
        this.value.skills?.read !== 'verified'
      )
        return;
      const workflow = manualWorkflow(facts, token[1]!);
      if (!workflow) {
        const matches = facts.entries.filter((entry) => entry.workflow?.name === token[1]);
        const rejected = matches[0] ?? facts.entries.find((entry) => entry.name === token[1]);
        this.publish({
          error:
            matches.length > 1
              ? 'workflow_name_ambiguous'
              : (rejected?.workflow?.reason ?? rejected?.reason ?? 'tui_command_unavailable'),
        });
        return;
      }
      const current = this.value.snapshot!;
      if (
        current.view.session.workspaceId !== snapshot.view.session.workspaceId ||
        current.view.session.contextSelectionId !== snapshot.view.session.contextSelectionId ||
        current.view.runs.find((value) => value.isActive)?.id !==
          snapshot.view.runs.find((value) => value.isActive)?.id
      )
        return;
      const run = current.view.runs.find((value) => value.isActive);
      if (run && !['running', 'waiting_interaction', 'waiting_execution'].includes(run.status))
        return;
      const commandId = this.port.nextCommandId();
      const scope = {
        storeId: this.port.storeId,
        workspaceId: current.view.session.workspaceId,
        sessionId,
      };
      let storedRevision: number | undefined;
      try {
        storedRevision = this.port.drafts?.version(scope);
      } catch {
        this.draftUnavailable('tui_draft_storage_unavailable');
        return;
      }
      const extensionInputs = [
        {
          extensionId: workflow.extensionId,
          definitionVersion: workflow.definitionVersion,
          input: { activations: [{ key: commandId, skillId: workflow.skillId!, input: {} }] },
        },
      ];
      const common = {
        expectedStoreId: this.port.storeId,
        commandId,
        content: token[2]?.trim() || `Run the ${workflow.name} Skill Workflow.`,
        extensionInputs,
      };
      const intent: StartCommandRequest | FollowUpCommandRequest = freezeIntent(
        run
          ? {
              ...common,
              kind: 'input.follow_up',
              afterRunId: run.id,
              contextSelectionId: current.view.session.contextSelectionId,
            }
          : { ...common, kind: 'run.start' },
      );
      this.submittedDrafts.set(commandId, {
        scope,
        localRevision: version,
        storedRevision,
        request: intent,
      });
      await this.write(sessionId, commandId, intent.kind, () =>
        this.port.callers ? this.submitCaller(scope, intent) : this.port.submit(sessionId, intent),
      );
      this.settleDraft(commandId);
    } finally {
      this.workflowReading = false;
    }
  }

  async send() {
    if (this.value.draft.trim().startsWith('/')) {
      await this.routeCommand(this.value.draft);
      return;
    }
    await this.sendTask(this.value.draft, this.value.planning);
  }
  private async sendTask(draft: string, planning: boolean) {
    const snapshot = this.value.snapshot;
    if (
      !snapshot ||
      !draft.trim() ||
      this.callerRestoring ||
      this.value.callerUnavailable ||
      this.pendingCaller() ||
      this.value.stale ||
      this.hasUnknownAnswer() ||
      this.pendingRecovery() ||
      this.value.intent?.phase === 'unknown' ||
      this.busy
    )
      return;
    const run = snapshot.view.runs.find((r) => r.isActive);
    if (run && !['running', 'waiting_interaction', 'waiting_execution'].includes(run.status))
      return;
    const commandId = this.port.nextCommandId(),
      sessionId = snapshot.view.session.id;
    const observedDraftVersion = this.draftVersions.get(sessionId) ?? 0;
    const draftScope = {
      storeId: this.port.storeId,
      workspaceId: snapshot.view.session.workspaceId,
      sessionId,
    };
    let storedDraftVersion: number | undefined;
    try {
      storedDraftVersion = this.port.drafts?.version(draftScope);
    } catch {
      this.draftUnavailable('tui_draft_storage_unavailable');
    }
    const origin = snapshot.activeCommand;
    const maintenance =
      run && origin && ['context.compress', 'context.compression.reset'].includes(origin.kind);
    if (
      maintenance &&
      (origin.id !== run.originCommandId ||
        origin.sessionId !== sessionId ||
        origin.originStoreId !== this.port.storeId)
    ) {
      this.publish({ error: 'active_command_identity_unavailable' });
      return;
    }
    const planInputs = planning
      ? {
          extensionInputs: [
            { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
          ],
        }
      : {};
    const intent: StartCommandRequest | SteerCommandRequest | FollowUpCommandRequest = freezeIntent(
      maintenance || (planning && run)
        ? {
            kind: 'input.follow_up',
            expectedStoreId: this.port.storeId,
            commandId,
            afterRunId: run.id,
            contextSelectionId: snapshot.view.session.contextSelectionId,
            content: draft,
            ...planInputs,
          }
        : run
          ? {
              kind: 'input.steer',
              expectedStoreId: this.port.storeId,
              commandId,
              targetRunId: run.id,
              contextSelectionId: snapshot.view.session.contextSelectionId,
              content: draft,
            }
          : {
              kind: 'run.start',
              expectedStoreId: this.port.storeId,
              commandId,
              content: draft,
              ...planInputs,
            },
    );
    this.submittedDrafts.set(commandId, {
      scope: draftScope,
      localRevision: observedDraftVersion,
      storedRevision: storedDraftVersion,
      request: intent,
      ...(planning && intent.kind !== 'input.steer'
        ? {
            planningVersion: this.planningDrafts.get(this.planningKey(draftScope))?.version ?? 0,
          }
        : {}),
    });
    await this.write(sessionId, commandId, intent.kind, () =>
      this.port.callers
        ? this.submitCaller(draftScope, intent)
        : this.port.submit(sessionId, intent),
    );
    this.settleDraft(commandId);
  }

  async answer(card: Interaction, text: string) {
    const snapshot = this.value.snapshot;
    const original = snapshot?.interactions.find(
      (i) => i.id === card.id && i.revision === card.revision,
    );
    const answer = original && interactionAnswer(original, text);
    if (original) card = original;
    if (
      !snapshot ||
      this.busy ||
      this.hasUnknownAnswer() ||
      this.value.intent?.phase === 'unknown' ||
      !answer ||
      this.answered.has(`${card.presentationSessionId}/${card.id}/${card.revision}`) ||
      !snapshot.interactions.some((i) => i.id === card.id && i.revision === card.revision) ||
      card.originStoreId !== this.port.storeId ||
      card.presentationSessionId !== snapshot.view.session.id
    )
      return;
    if (requiresInteractionAttachment(card)) {
      try {
        const review = interactionAttachment(card);
        if (
          !review ||
          !this.value.attachments.has(interactionKey(card)) ||
          this.attachmentProofs.get(interactionKey(card)) !== review.key
        )
          return;
      } catch {
        return;
      }
    }
    const commandId = this.port.nextCommandId(),
      sessionId = card.presentationSessionId;
    const request = freezeIntent({
      expectedStoreId: this.port.storeId,
      commandId,
      expectedRevision: card.revision,
      answer: structuredClone(answer),
    });
    const interactionId = card.id;
    this.answerIntent = { sessionId, interactionId, request, phase: 'submitting' };
    await this.write(sessionId, commandId, 'interaction.answer', () =>
      this.port.answer(sessionId, interactionId, request),
    );
  }
  async cancel() {
    if (this.pendingRecovery(true) || this.value.panel === 'recovery') {
      this.cancelRecoveryRead();
      return;
    }
    if (this.workflowReading && this.value.skills?.read === 'reading') {
      this.skillsRead?.abort();
      return;
    }
    const snapshot = this.value.snapshot,
      run = snapshot?.view.runs.find((r) => r.isActive);
    const pending = this.value.intent;
    const originalCaller = [...this.value.callers.values()]
      .reverse()
      .find(
        (row) =>
          row.intent.scope.storeId === this.port.storeId &&
          (row.intent.scope.sessionId === snapshot?.view.session.id ||
            row.intent.request.commandId === pending?.commandId) &&
          ['run.start', 'input.steer', 'input.follow_up'].includes(row.intent.request.kind) &&
          ['submitting', 'unknown', 'accepted'].includes(row.phase),
      );
    const target =
      originalCaller?.intent.request.commandId ??
      run?.originCommandId ??
      (pending?.sessionId === snapshot?.view.session.id && pending?.kind === 'run.start'
        ? pending.commandId
        : undefined);
    if (!snapshot || !target || this.cancelled.has(target)) return;
    this.cancelled.add(target);
    const commandId = this.port.nextCommandId(),
      sessionId = originalCaller?.intent.scope.sessionId ?? snapshot.view.session.id;
    const cancelScope = originalCaller?.intent.scope ?? this.draftScope()!;
    await this.write(
      sessionId,
      commandId,
      'command.cancel',
      async () => {
        try {
          return this.port.callers
            ? await this.submitCaller(cancelScope, {
                kind: 'command.cancel',
                expectedStoreId: this.port.storeId,
                commandId,
                targetCommandId: target,
              })
            : this.port.cancel(sessionId, {
                kind: 'command.cancel',
                expectedStoreId: this.port.storeId,
                commandId,
                targetCommandId: target,
              });
        } catch (error) {
          if (error instanceof Error && 'notSubmitted' in error) this.cancelled.delete(target);
          throw error;
        }
      },
      true,
    );
  }
  async lookup() {
    if (!this.hasUnknownAnswer() && (await this.lookupCaller())) return;
    const answer = this.answerIntent;
    const intent =
      answer?.phase === 'unknown'
        ? {
            sessionId: answer.sessionId,
            commandId: answer.request.commandId,
            kind: 'interaction.answer',
            phase: 'unknown' as const,
          }
        : (this.unknownIntents.values().next().value ?? this.value.intent);
    if (intent?.phase !== 'unknown' || this.busy) {
      if (await this.lookupJobStop()) return;
      await this.lookupRecovery();
      return;
    }
    await this.write(intent.sessionId, intent.commandId, intent.kind, () =>
      this.port.getCommand(intent.commandId, intent.sessionId),
    );
    this.settleDraft(intent.commandId);
    const unresolved = this.unknownIntents.values().next().value;
    if (unresolved) this.publish({ intent: unresolved });
  }
  openExecutions() {
    if (!this.port.executions) {
      this.publish({ error: 'tui_execution_reader_unavailable' });
      return;
    }
    this.closePanel();
    this.publish({ panel: 'executions' });
  }
  private jobTarget(id: string): TuiJobTarget | undefined {
    const snapshot = this.value.snapshot;
    if (
      !snapshot ||
      snapshot.storeId !== this.port.storeId ||
      snapshot.view.session.id !== this.value.sessionId
    )
      return;
    const job = snapshot.view.executions.find(
      (execution) =>
        execution.id === id &&
        execution.kind === 'job' &&
        execution.sessionId === snapshot.view.session.id &&
        execution.originStoreId === this.port.storeId,
    );
    if (!job) return;
    return Object.freeze({
      storeId: this.port.storeId,
      sessionId: job.sessionId,
      executionId: job.id,
    });
  }
  async readExecution(id: string, child: boolean) {
    const target = this.jobTarget(id),
      port = this.port.executions,
      snapshot = this.value.snapshot;
    if (!target || !port || !snapshot) return;
    this.executionRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.executionRead = read;
    const old = this.value.executionReading;
    this.publish({
      panel: 'executions',
      executionReading: {
        target,
        phase: 'reading',
        ...(old && JSON.stringify(old.target) === JSON.stringify(target)
          ? { output: old.output, child: old.child }
          : {}),
      },
    });
    try {
      const result = child
        ? { child: await readChildLog(port, target, snapshot.view, read.signal) }
        : { output: await readJobOutput(port, target, read.signal) };
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        this.value.sessionId === target.sessionId &&
        this.value.panel === 'executions'
      )
        this.publish({ executionReading: { target, phase: 'ready', ...result } });
    } catch (error) {
      if (
        !read.signal.aborted &&
        generation === this.generation &&
        this.value.sessionId === target.sessionId
      )
        this.publish({
          executionReading: {
            ...this.value.executionReading!,
            target,
            phase: 'failed',
            error: error instanceof Error ? error.message : 'execution_read_failed',
          },
        });
    } finally {
      this.reads.delete(read);
    }
  }
  async stopJob(id: string) {
    const target = this.jobTarget(id),
      port = this.port.executions;
    if (
      !target ||
      !port ||
      this.disposed ||
      this.busy ||
      this.jobStopBusy ||
      this.callerRestoring ||
      this.value.callerUnavailable ||
      this.pendingCaller() ||
      this.value.stale ||
      this.hasUnknownAnswer() ||
      this.value.intent?.phase === 'unknown' ||
      [...this.value.jobStops.values()].some(
        (intent) => intent.phase === 'unknown' || intent.phase === 'submitting',
      )
    )
      return;
    this.jobStopBusy = true;
    this.executionRead?.abort();
    const read = this.reading(),
      generation = this.generation;
    this.executionRead = read;
    try {
      const job = originalJob(target, await port.getExecution(id, read.signal));
      read.signal.throwIfAborted();
      if (
        this.disposed ||
        generation !== this.generation ||
        this.value.sessionId !== target.sessionId ||
        this.value.stale ||
        !['planned', 'dispatching', 'running'].includes(job.status) ||
        job.cancelRequestedAt !== null
      )
        return;
      const request = Object.freeze({
        kind: 'execution.cancel' as const,
        expectedStoreId: target.storeId,
        commandId: this.port.nextCommandId(),
        executionId: target.executionId,
      });
      const intent: TuiJobStop = { target, request, phase: 'submitting' };
      this.publish({ jobStops: new Map(this.value.jobStops).set(request.commandId, intent) });
      let phase: TuiJobStop['phase'] = 'unknown';
      try {
        phase = jobStopReceipt(
          intent,
          await (this.port.callers
            ? this.submitCaller(
                {
                  storeId: target.storeId,
                  sessionId: target.sessionId,
                  workspaceId: this.value.snapshot!.view.session.workspaceId,
                },
                request,
              )
            : port.stop(target.sessionId, request)),
        );
      } catch (error) {
        if (error instanceof Error && 'notSubmitted' in error) {
          phase = 'rejected';
          this.publish({ error: error.message });
        }
        if (
          error instanceof ClientError &&
          error.code !== 'mutation_incomplete' &&
          error.status &&
          [400, 401, 403, 404, 409, 410, 413, 422, 429].includes(error.status)
        )
          phase = 'rejected';
      }
      this.publish({
        jobStops: new Map(this.value.jobStops).set(request.commandId, { ...intent, phase }),
      });
    } catch (error) {
      if (!read.signal.aborted && generation === this.generation)
        this.publish({ error: error instanceof Error ? error.message : 'job_stop_prepare_failed' });
    } finally {
      this.jobStopBusy = false;
      this.reads.delete(read);
    }
  }
  async lookupJobStop(): Promise<boolean> {
    const port = this.port.executions,
      intent = [...this.value.jobStops.values()].find((value) => value.phase === 'unknown');
    if (!port || !intent || this.jobStopBusy) return false;
    this.executionRead?.abort();
    const read = this.reading();
    this.executionRead = read;
    try {
      const command = await port.getCommand(intent.request.commandId, read.signal);
      read.signal.throwIfAborted();
      const phase = jobStopReceipt(intent, command);
      this.publish({
        jobStops: new Map(this.value.jobStops).set(intent.request.commandId, { ...intent, phase }),
      });
    } catch {
    } finally {
      this.reads.delete(read);
    }
    return true;
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
    for (const read of this.reads) read.abort();
    this.reads.clear();
    this.listeners.clear();
  }
}
