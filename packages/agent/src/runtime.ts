import { createHash } from 'node:crypto';
import type { ModelAdapter, ModelMessage, ModelRequest } from '@kite-ai/ai';
import type { ArtifactContentStore, ArtifactReadInput } from './artifact-port';
import {
  type AuthorizationReviewOutput,
  authorizationReviewAnswer,
  authorizationReviewOutputMediaType,
  authorizationReviewOutputRefId,
} from './authorization-review-output';
import {
  assertContextSource,
  type ContextCompressor,
  type ContextSource,
  type ContextSources,
  type SourceRequest,
  sealCompressor,
} from './context';
import {
  type ScopedBindings,
  type StandaloneScope,
  type ToolScope,
  UnifiedExecution,
} from './execution';
import { ChangeWaits } from './execution/change-waits';
import { ChildSlots } from './execution/child-slots';
import type { WorkspaceSerialLocks } from './execution/resource-port';
import { ExecutionResources } from './execution/resources';
import type {
  AuthorizationRequest,
  Extension,
  JobDefinition,
  JobEvent,
  JobHandle,
  NecessaryConditions,
  PermissionDecision,
  Permissions,
  RunInitializationContext,
  ToolDefinition,
} from './extensions';
import { sealForkRule } from './extensions/fork';
import { type PublicForkInput, prepareNamespaceFork } from './extensions/fork-preparation';
import { ExtensionHost } from './extensions/host';
import { canonicalJson, semanticDigest } from './json';

import { defaultLoop, type LoopContext } from './loop';
import { bodyReference, jsonBody, persistedModelRequest, utf8Body } from './model-body';
import { modelOutputReference, readModelOutput } from './model-output';
import { type ModelInputMetadata, modelInputMetadata } from './model-snapshot';
import type {
  AcceptCommandInput,
  AuthorizationReviewIdentity,
  CancelCommandInput,
  CancelWorkBase,
  CancelWorkInput,
  ReadAuthorizationReviewInput,
  Store,
} from './storage/port';
import {
  AgentError,
  type ChildConfiguration,
  type ChildRunActivation,
  type CommandRecord,
  type ExecutionRecord,
  type Json,
  type JsonSchema,
  type ModelInputIdentity,
  type ModelInputPage,
  type OwnerRef,
  type RequirementRef,
  type RunRecord,
  type SessionRecord,
  type WorkspaceRecord,
} from './storage/types';

export type { ModelInputPage } from './storage/types';
export interface ModelInputSnapshot extends Omit<ModelInputIdentity, 'modelId'> {
  storeId: string;
  bodyHash: string;
  bodyBytes: string;
  snapshotCursor: string;
  request: ModelRequest;
  metadata: ModelInputMetadata;
}
export interface ModelOutputSnapshot extends Omit<ModelInputIdentity, 'modelId' | 'confirmation'> {
  storeId: string;
  snapshotCursor: string;
  bodyHash: string;
  bodyBytes: string;
  contentBytes: string;
  reasoningBytes: string;
  output: {
    content: string;
    reasoning: string;
    toolCalls: import('./storage/types').ToolCall[];
    complete: boolean;
  };
}

const semanticDigestBytes = async (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sealExtension(extension: Extension): Extension {
  const recordKeys = new Map<string, boolean>();
  for (const definition of extension.records ?? []) {
    const key = `${definition.contentType}/${definition.contentVersion}`;
    if (recordKeys.has(key) && (definition.fork || recordKeys.get(key)))
      throw new AgentError('fork_rule_conflict');
    recordKeys.set(key, !!definition.fork);
  }
  const definitions = <T extends { inputSchema: JsonSchema; resources?: unknown }>(
    values: readonly T[] | undefined,
  ) =>
    values?.map(
      (definition) =>
        Object.freeze({
          ...definition,
          inputSchema: freeze(structuredClone(definition.inputSchema)),
          ...(definition.resources === undefined
            ? {}
            : { resources: freeze(structuredClone(definition.resources)) }),
          ...('recovery' in definition && definition.recovery !== undefined
            ? { recovery: freeze(structuredClone(definition.recovery)) }
            : {}),
        }) as T,
    );
  return Object.freeze({
    ...extension,
    ...(extension.compression ? { compression: sealCompressor(extension.compression) } : {}),
    ...(extension.mutationGovernance
      ? {
          mutationGovernance: Object.freeze({
            ...extension.mutationGovernance,
            definitions: freeze(structuredClone(extension.mutationGovernance.definitions)),
          }),
        }
      : {}),
    ...(extension.completionGovernance
      ? { completionGovernance: Object.freeze({ ...extension.completionGovernance }) }
      : {}),
    ...(extension.conditions ? { conditions: Object.freeze({ ...extension.conditions }) } : {}),
    ...(extension.context ? { context: Object.freeze({ ...extension.context }) } : {}),
    tools: Object.freeze(definitions(extension.tools) ?? []),
    jobs: Object.freeze(definitions(extension.jobs) ?? []),
    actions: Object.freeze(definitions(extension.actions) ?? []),
    queries: Object.freeze(
      (definitions(extension.queries) ?? []).map((query) =>
        Object.freeze({ ...query, outputSchema: freeze(structuredClone(query.outputSchema)) }),
      ),
    ),
    records: Object.freeze(
      (extension.records ?? []).map((record) =>
        Object.freeze({
          ...record,
          schema: freeze(structuredClone(record.schema)),
          fork: sealForkRule(record.fork),
        }),
      ),
    ),
  });
}

export type RunRequirementInitializer = (input: {
  readonly command: Readonly<CommandRecord>;
  readonly run: Readonly<RunRecord>;
  readonly session: Readonly<SessionRecord>;
  forExtension(extensionId: string): Promise<RunInitializationContext>;
}) => Promise<readonly RequirementRef[]>;

export interface StepCapabilities {
  /** Additional registrations, excluding the Runtime's global extensions. */
  readonly extensions?: readonly Extension[];
  readonly toolIds?: readonly string[];
  /** Bounded, non-secret facts about the cached catalogue that produced these definitions. */
  readonly snapshot: Json;
}

export type StepCapabilitiesReader = (input: {
  readonly command: Readonly<CommandRecord>;
  readonly run: Readonly<RunRecord>;
  readonly session: Readonly<SessionRecord>;
  readonly signal: AbortSignal;
}) => Promise<StepCapabilities>;

export interface AuthorizationReviewBinding extends AuthorizationReviewIdentity {
  readonly model: ModelAdapter;
}
function sealReview(
  binding: AuthorizationReviewBinding | undefined,
): AuthorizationReviewBinding | undefined {
  if (!binding) return undefined;
  if (
    !/^[A-Za-z0-9_.-]{1,64}$/.test(binding.id) ||
    !binding.version ||
    binding.version.length > 128 ||
    !binding.modelId ||
    binding.modelId.length > 256 ||
    !binding.model?.stream
  )
    throw new AgentError('authorization_review_binding_invalid');
  return Object.freeze({
    id: binding.id,
    version: binding.version,
    modelId: binding.modelId,
    model: binding.model,
  });
}
export interface AfterTurnPolicy {
  authorize(input: {
    readonly phase: 'request' | 'apply';
    readonly command: Readonly<CommandRecord>;
    readonly run: Readonly<RunRecord>;
    readonly session: Readonly<SessionRecord>;
    readonly execution: Readonly<ExecutionRecord>;
    readonly configuration: Readonly<ChildConfiguration>;
    readonly signal: AbortSignal;
  }): Promise<{
    allowed: boolean;
    revision: string;
    controlReads?: readonly import('./storage/port').PermissionControlRead[];
  }>;
}
export interface RunConfiguration {
  readonly compressor?: ContextCompressor;
  readonly afterTurn?: AfterTurnPolicy;
  readonly authorizationReview?: AuthorizationReviewBinding;
  readonly model?: ModelAdapter;
  readonly modelId: string;
  readonly toolIds?: readonly string[];
  readonly maxConcurrentSubagents?: number;
  /** Trusted host registrations selected for this Run; never accepted from a public command. */
  readonly extensions?: readonly Extension[];
  readonly sources?: ContextSources;
  readonly permissions?: Permissions;
  readonly conditions?: NecessaryConditions;
  readonly initializeRequirements?: RunRequirementInitializer;
  /** Pure cached selection at safe Steps and final freshness checks; never connects or executes. */
  readonly readStepCapabilities?: StepCapabilitiesReader;
  readonly dispose?: () => Promise<void>;
  /** The host supplies a desensitized immutable projection of the actual resolved configuration. */
  readonly snapshot: Json;
}

export interface ChildAgentConfiguration extends RunConfiguration {
  readonly id: string;
  readonly version: string;
  readonly model: ModelAdapter;
  readonly inputSchema?: JsonSchema;
}

function sealSources(sources: ContextSources | undefined): ContextSources | undefined {
  if (!sources) return undefined;
  const capture = sources.capture.bind(sources);
  return Object.freeze({ capture });
}

type RunBinding = {
  compressor?: ContextCompressor;
  afterTurn?: AfterTurnPolicy;
  authorizationReview?: AuthorizationReviewBinding;
  model: ModelAdapter;
  modelId: string;
  definitions: ReadonlyMap<string, ToolDefinition>;
  jobs?: ReadonlyMap<string, JobDefinition>;
  extensions?: readonly Extension[];
  sources?: ContextSources;
  permissions?: Permissions;
  conditions?: NecessaryConditions;
  initializeRequirements?: RunRequirementInitializer;
  readStepCapabilities?: StepCapabilitiesReader;
  dispose?: () => Promise<void>;
};
type RunExecutionCheckpoint = {
  loop?: LoopContext['checkpoint'];
  plannedModel?: ExecutionRecord;
  plannedTools: ReadonlyMap<string, ExecutionRecord>;
  modelRequest?: ModelRequest;
  modelSource?: Record<string, Json>;
  sourceRequests: readonly SourceRequest[];
  initializationState: 'unstarted' | 'completed';
};

export interface RuntimeOptions {
  compressor?: ContextCompressor;
  afterTurn?: AfterTurnPolicy;
  authorizationReview?: AuthorizationReviewBinding;
  store: Store;
  model?: ModelAdapter;
  modelId?: string;
  permissions: Permissions;
  conditions?: NecessaryConditions;
  initializeRunRequirements?: RunRequirementInitializer;
  extensions?: readonly Extension[];
  instanceId?: string;
  modelConcurrency?: number;
  processConcurrency?: number;
  workspaceSerialLocks?: WorkspaceSerialLocks;
  sources?: ContextSources;
  artifacts?: ArtifactContentStore;
  /** Only these host bindings may be named by an extension's kind:agent request. */
  childConfigurations?: readonly ChildAgentConfiguration[];
  maxConcurrentSubagents?: number;
  resolveChildRunConfiguration?: (input: {
    readonly configurationId: string;
    readonly parentExecution: Readonly<ExecutionRecord>;
    readonly parentRun: Readonly<RunRecord> | null;
    readonly parentSession: Readonly<SessionRecord>;
    readonly workspace: Readonly<WorkspaceRecord>;
    readonly command: CommandRecord;
    readonly signal: AbortSignal;
    readonly records: {
      forExtension(extensionId: string): {
        get(key: string): Promise<import('./storage/types').ExtensionRecord | null>;
      };
    };
  }) => Promise<RunConfiguration>;
  resolveRecoveryRunConfiguration?: (input: {
    readonly command: Readonly<CommandRecord>;
    readonly run: Readonly<RunRecord>;
    readonly session: Readonly<SessionRecord>;
    readonly workspace: Readonly<WorkspaceRecord>;
    readonly signal: AbortSignal;
  }) => Promise<RunConfiguration>;
  /** Restores only an explicitly registered Job query implementation, never a Model binding. */
  resolveRecoveryJobConfiguration?: (input: {
    readonly execution: Readonly<ExecutionRecord>;
    readonly session: Readonly<SessionRecord>;
    readonly workspace: Readonly<WorkspaceRecord>;
    readonly signal: AbortSignal;
  }) => Promise<{ extension: Extension; dispose?: () => Promise<void> }>;
  /** A distinct read authority; it cannot approve the original Job's dispatch. */
  authorizeJobReconcile?: (input: {
    readonly command: {
      expectedStoreId: string;
      commandId: string;
      subjectId: string;
      sessionId: string;
      executionId: string;
      expectedResultRevision: string;
    };
    readonly execution: Readonly<ExecutionRecord>;
    readonly manifest: Json;
    readonly signal: AbortSignal;
  }) => Promise<Pick<PermissionDecision, 'allowed' | 'revision' | 'controlReads'>>;
  supportsSelectedSkills?: boolean;
  /** Trusted host opt-in; its resolver validates every registered extension and version. */
  supportsExtensionInputs?: boolean;
  resolveRunConfiguration?: (input: {
    readonly command: CommandRecord;
    readonly session: SessionRecord;
    readonly workspace: WorkspaceRecord;
  }) => Promise<RunConfiguration>;
}

export type RuntimeBusyReason = 'admission' | 'dispatch' | 'execution' | 'background' | 'cleanup';
export interface RuntimeLifecycleState {
  readonly state: 'accepting' | 'draining' | 'closed' | 'drain_failed';
  readonly busy: boolean;
  readonly reasons: readonly RuntimeBusyReason[];
}
export interface RuntimeShutdownOptions {
  /** Trusted host seals its remaining read/control admission and drains resource users here. */
  readonly beforeResourceClose?: () => Promise<void>;
}
export type RuntimeShutdownResult =
  | { readonly accepted: false; readonly state: RuntimeLifecycleState }
  | {
      readonly accepted: true;
      readonly state: RuntimeLifecycleState;
      readonly completion: Promise<void>;
    };

export class AgentRuntime {
  readonly supportsSelectedSkills: boolean;
  readonly supportsExtensionInputs: boolean;
  private readonly instanceId: string;
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly extensions: readonly Extension[];
  private readonly toolExtensions = new Map<string, string>();
  private readonly childConfigurations = new Map<
    string,
    { binding: RunBinding; configuration: ChildConfiguration; inputSchema: JsonSchema }
  >();
  private readonly childBaseReleases: (() => Promise<void>)[] = [];
  private readonly childRetainers = new Map<string, () => () => Promise<void>>();
  private readonly authorizationReviewTasks = new Map<string, Promise<void>>();
  private readonly runBindingLeases = new Map<
    string,
    { binding: RunBinding; retain: () => () => Promise<void> }
  >();
  private readonly reportBindings = new Map<
    string,
    { binding: RunBinding; release: () => Promise<void> }
  >();
  private readonly defaultReviewer: AuthorizationReviewBinding | undefined;
  private readonly childSlots = new ChildSlots();
  private readonly childAdmissions = new WeakMap<
    JobDefinition,
    (scope: StandaloneScope) => Promise<() => void>
  >();
  private readonly execution: UnifiedExecution;
  private readonly extensionHost: ExtensionHost;
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly reportRecoveryPreparations = new Set<AbortController>();
  private reportRecoveryCleanupFailed = false;
  private readonly jobReconcileControllers = new Map<string, AbortController>();
  private jobReconcileCleanupFailed = false;
  private readonly runResumeControllers = new Map<string, AbortController>();
  private runResumeCleanupFailed = false;
  private readonly active = new Map<
    string,
    {
      sessionId: string;
      runId?: string;
      originStoreId: string;
      owner: OwnerRef;
      controller: AbortController;
      subjectId: string;
    }
  >();
  private readonly activeExecutions = new Map<
    string,
    {
      sessionId: string;
      originStoreId: string;
      owner: OwnerRef;
      controller: AbortController;
      subjectId: string;
    }
  >();
  private readonly wakeups = new Set<string>();
  private readonly pendingSessions = new Set<string>();
  private readonly dispatchFailures = new Map<string, { code: string; instanceId: string }>();
  private readonly nextDispatchPoll = new Map<string, number>();
  private readonly changeWaits: ChangeWaits;
  private controlTimer?: ReturnType<typeof setTimeout>;
  private controlTask?: Promise<void>;
  private closing = false;
  private lifecycleState: RuntimeLifecycleState['state'] = 'accepting';
  private admissions = 0;
  private resourceUsers = 0;
  private resourceAdmissionClosed = false;
  private readonly admissionWaiters = new Set<() => void>();
  private readonly resourceWaiters = new Set<() => void>();
  private closeTask?: Promise<void>;
  private readonly options: RuntimeOptions;
  constructor(options: RuntimeOptions) {
    this.options = { ...options };
    this.supportsSelectedSkills =
      options.supportsSelectedSkills === true && !!options.resolveRunConfiguration;
    this.supportsExtensionInputs =
      options.supportsExtensionInputs === true && !!options.resolveRunConfiguration;
    this.changeWaits = new ChangeWaits(options.store);
    this.defaultReviewer = sealReview(options.authorizationReview);
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.extensions = Object.freeze((options.extensions ?? []).map(sealExtension));
    const extensions = new Set<string>();
    for (const extension of this.extensions) {
      if (extension.apiMajor !== 1) throw new AgentError('extension_api_incompatible');
      if (extensions.has(extension.id)) throw new AgentError('extension_definition_conflict');
      extensions.add(extension.id);
      for (const tool of extension.tools ?? []) {
        if (this.tools.has(tool.id)) throw new AgentError('tool_definition_conflict');
        this.tools.set(tool.id, tool);
        this.toolExtensions.set(tool.id, extension.id);
      }
    }
    this.childLimit(options.maxConcurrentSubagents);
    if ((options.childConfigurations?.length ?? 0) > 128)
      throw new AgentError('invalid_child_configuration');
    for (const configuration of options.childConfigurations ?? []) {
      if (
        !/^[A-Za-z0-9_.-]{1,128}$/.test(configuration.id) ||
        !configuration.version ||
        this.childConfigurations.has(configuration.id)
      )
        throw new AgentError('invalid_child_configuration');
      const captured = this.runDefinitions(configuration.extensions, configuration.toolIds);
      const definitions = captured.definitions;
      let users = 1;
      let disposed = false;
      const release = async () => {
        if (--users === 0 && !disposed) {
          disposed = true;
          await configuration.dispose?.();
        }
      };
      this.childBaseReleases.push(release);
      this.childRetainers.set(configuration.id, () => {
        users++;
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await release();
        };
      });
      this.childConfigurations.set(configuration.id, {
        binding: {
          model: configuration.model,
          modelId: configuration.modelId,
          definitions,
          extensions: captured.extensions,
          jobs: captured.jobs,
          sources: sealSources(configuration.sources),
          compressor: sealCompressor(configuration.compressor ?? options.compressor),
          dispose: configuration.dispose,
          readStepCapabilities: configuration.readStepCapabilities,
          afterTurn: configuration.afterTurn ?? options.afterTurn,
          authorizationReview: sealReview(
            configuration.authorizationReview ?? this.defaultReviewer,
          ),
          permissions: configuration.permissions,
          conditions: configuration.conditions,
          initializeRequirements: configuration.initializeRequirements,
        },
        configuration: {
          id: configuration.id,
          version: configuration.version,
          snapshot: this.configurationSnapshot(
            configuration.modelId,
            configuration.snapshot,
            definitions,
            configuration.maxConcurrentSubagents,
            captured.extensionIds,
            captured.extensions,
          ),
        },
        inputSchema: structuredClone(
          configuration.inputSchema ?? {
            type: 'object',
            required: ['content'],
            additionalProperties: false,
            properties: { content: { type: 'string' } },
          },
        ),
      });
    }
    this.execution = new UnifiedExecution({
      store: options.store,
      sealModelInput: (scope, request) => this.sealModelInput(scope, request),
      sealModelMetadata: (scope, metadata) => this.sealModelMetadata(scope, metadata),
      publishModelOutput: options.artifacts
        ? (scope, executionId, value) => this.publishModelOutput(scope, executionId, value)
        : undefined,
      openModelInput: (scope, input) => this.openModelInput(scope, input),
      sealSource: (scope, source) => this.sealSource(scope, source),
      sealApprovalRequest: (scope, executionId, request) =>
        this.sealApprovalRequest(scope, executionId, request),
      verifyApprovalRequest: (scope, executionId, saved, actual) =>
        this.verifyApprovalRequest(scope, executionId, saved, actual),
      reviewAuthorization: (scope, request, source, decision) =>
        this.reviewAuthorization(scope, request, source, decision),
      permissions: options.permissions,
      conditions: options.conditions,
      conditionContext: (scope, reference, onRecord, boundaryExecutionId) =>
        this.extensionHost.conditionContext(scope, reference, onRecord, boundaryExecutionId),
      resources: new ExecutionResources(
        options.modelConcurrency,
        options.processConcurrency,
        options.workspaceSerialLocks,
      ),
      toolContext: (scope, definition, executionId, source) =>
        this.extensionHost.toolContext(scope, definition, executionId, source),
      onLiveExecution: (id, scope, controller) => this.trackExecution(id, scope, controller),
      admitJob: (definition, scope) =>
        this.childAdmissions.get(definition)?.(scope) ?? Promise.resolve(undefined),
      validateArtifacts: async (scope, references) => {
        const command =
          'run' in scope
            ? await options.store.getCommand(scope.run.originCommandId)
            : scope.command;
        if (!command) throw new AgentError('command_not_found');
        if (references.length > 64) throw new AgentError('artifact_references_too_large');
        for (const ref of references) {
          if (!ref.scope) throw new AgentError('artifact_scope_required');
          const original = await options.store.getArtifactReference({
            expectedStoreId: command.originStoreId,
            sessionId: command.sessionId,
            subjectId: command.subjectId,
            refId: ref.id,
            scope: ref.scope,
          });
          if (!original || original.mediaType !== ref.mediaType || original.size !== ref.size)
            throw new AgentError('artifact_reference_invalid');
        }
      },
    });
    const actionCatalogue = this.runDefinitions();
    const actionBindings: ScopedBindings = Object.freeze({
      extensions: actionCatalogue.extensions,
      tools: actionCatalogue.definitions,
      jobs: actionCatalogue.jobs,
      permissions: this.options.permissions,
      conditions: this.options.conditions,
      authorizationReview: this.defaultReviewer,
      // Global trusted definitions live until Runtime resource cleanup. Descendant
      // operations retain that same lifecycle; per-Run resolver assets are absent.
      retain: () => {
        if (this.resourceAdmissionClosed) throw new AgentError('runtime_draining');
        this.resourceUsers++;
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          if (--this.resourceUsers === 0) {
            for (const wake of this.resourceWaiters) wake();
            this.resourceWaiters.clear();
          }
        };
      },
    });
    this.extensionHost = new ExtensionHost({
      store: options.store,
      execution: this.execution,
      extensions: this.extensions,
      tools: this.tools,
      sources: sealSources(options.sources),
      artifacts: options.artifacts,
      forkSourceReaders: {
        readModelInput: (input) => this.readModelInput(input),
        readModelOutput: (input) => this.readModelOutput(input),
        readArtifact: (input) => this.readArtifact(input),
      },
      actionBindings,
      authorizeAfterTurn: (scope, id, configuration) =>
        this.authorizeAfterTurn(scope, id, configuration),
      onJobSettled: (scope, id) => this.onJobSettled(scope, id),
      resolveAgent: (configurationId, parent, executionId, source, continuation) =>
        this.resolveChildDefinition(configurationId, parent, executionId, source, continuation),
      live: (command, owner, controller) => this.trackLive(command, owner, controller),
      waitForChange: (cursor, signal, timeoutMs) => {
        this.watchControls();
        return this.changeWaits.wait(cursor, signal, timeoutMs);
      },
      onActivity: (sessionId) => this.schedule(sessionId),
      assertAcceptingWork: () => {
        if (this.closing) throw new AgentError('runtime_draining');
      },
    });
    // A closed, finite list of public entries accounts for their first async boundary.
    // Observations protect resource lifetime without making an otherwise idle Runtime busy.
    this.createWorkspace = this.accountEntry(this.createWorkspace, 'admission');
    this.createSession = this.accountEntry(this.createSession, 'admission');
    this.beginHostMutation = this.accountEntry(this.beginHostMutation, 'admission');
    this.clearPermissionGrants = this.accountEntry(this.clearPermissionGrants, 'admission');
    this.selectContext = this.accountEntry(this.selectContext, 'admission');
    this.compressContext = this.accountEntry(this.compressContext, 'admission');
    this.resetCompressionContext = this.accountEntry(this.resetCompressionContext, 'admission');
    this.renameSession = this.accountEntry(this.renameSession, 'admission');
    this.deleteSession = this.accountEntry(this.deleteSession, 'admission');
    this.forkSession = this.accountEntry(this.forkSession, 'admission');
    this.includeResult = this.accountEntry(this.includeResult, 'admission');
    this.answerInteraction = this.accountEntry(this.answerInteraction, 'admission');
    this.recoverSession = this.accountEntry(this.recoverSession, 'admission');
    this.resumeJobReport = this.accountEntry(this.resumeJobReport, 'admission');
    this.reconcileJob = this.accountEntry(this.reconcileJob, 'admission');
    this.resumeRun = this.accountEntry(this.resumeRun, 'admission');
    this.submitCommand = this.accountEntry(this.submitCommand, 'admission');
    this.getMetadata = this.accountEntry(this.getMetadata, 'observation');
    this.readRunExtensionRecord = this.accountEntry(this.readRunExtensionRecord, 'observation');
    this.readSessionExportText = this.accountEntry(this.readSessionExportText, 'observation');
    this.beginSessionExport = this.accountEntry(this.beginSessionExport, 'observation');
    this.readSessionExportPage = this.accountEntry(this.readSessionExportPage, 'observation');
    this.verifySessionExport = this.accountEntry(this.verifySessionExport, 'observation');
    this.listModelInputs = this.accountEntry(this.listModelInputs, 'observation');
    this.readModelInput = this.accountEntry(this.readModelInput, 'observation');
    this.readModelOutput = this.accountEntry(this.readModelOutput, 'observation');
    this.readArtifact = this.accountEntry(this.readArtifact, 'observation');
    this.readHostControl = this.accountEntry(this.readHostControl, 'observation');
    this.listPermissionGrants = this.accountEntry(this.listPermissionGrants, 'observation');
    this.getHostMutation = this.accountEntry(this.getHostMutation, 'observation');
    this.getInteraction = this.accountEntry(this.getInteraction, 'observation');
    this.listInteractions = this.accountEntry(this.listInteractions, 'observation');
    this.listPendingInputs = this.accountEntry(this.listPendingInputs, 'observation');
    this.readOriginalRunSelection = this.accountEntry(this.readOriginalRunSelection, 'observation');
    this.getSelectedContext = this.accountEntry(this.getSelectedContext, 'observation');
    this.getCompressionOrigin = this.accountEntry(this.getCompressionOrigin, 'observation');
    this.getMessageOrigin = this.accountEntry(this.getMessageOrigin, 'observation');
    this.getWorkspace = this.accountEntry(this.getWorkspace, 'observation');
    this.listWorkspaces = this.accountEntry(this.listWorkspaces, 'observation');
    this.listSessionDirectory = this.accountEntry(this.listSessionDirectory, 'observation');
    this.listWorkspaceDirectory = this.accountEntry(this.listWorkspaceDirectory, 'observation');
    this.listSessions = this.accountEntry(this.listSessions, 'observation');
    this.getCommand = this.accountEntry(this.getCommand, 'observation');
    this.getRun = this.accountEntry(this.getRun, 'observation');
    this.getExecution = this.accountEntry(this.getExecution, 'observation');
    this.listExecutionOutput = this.accountEntry(this.listExecutionOutput, 'observation');
    this.listMessages = this.accountEntry(this.listMessages, 'observation');
    this.getChanges = this.accountEntry(this.getChanges, 'observation');
    this.getView = this.accountEntry(this.getView, 'observation');
    this.getSession = this.accountEntry(this.getSession, 'observation');
    this.queryExtension = this.accountEntry(this.queryExtension, 'observation');
    this.waitForCommand = this.accountEntry(this.waitForCommand, 'observation');
    this.finishHostMutation = this.accountEntry(this.finishHostMutation, 'control');
    this.cancelCommand = this.accountEntry(this.cancelCommand, 'control');
    this.cancelRun = this.accountEntry(this.cancelRun, 'control');
    this.cancelExecution = this.accountEntry(this.cancelExecution, 'control');
    this.cancelSession = this.accountEntry(this.cancelSession, 'control');
  }
  private accountEntry<A extends unknown[], R>(
    operation: (...args: A) => Promise<R>,
    kind: 'admission' | 'observation' | 'control',
  ): (...args: A) => Promise<R> {
    return (...args) => {
      if (this.resourceAdmissionClosed || (kind === 'admission' && this.closing))
        return Promise.reject(new AgentError('runtime_draining'));
      this.resourceUsers++;
      if (kind !== 'observation') this.admissions++;
      const release = () => {
        if (kind !== 'observation' && --this.admissions === 0) {
          for (const wake of this.admissionWaiters) wake();
          this.admissionWaiters.clear();
        }
        if (--this.resourceUsers === 0) {
          for (const wake of this.resourceWaiters) wake();
          this.resourceWaiters.clear();
        }
      };
      try {
        return Promise.resolve(operation.apply(this, args)).finally(release);
      } catch (error) {
        release();
        return Promise.reject(error);
      }
    };
  }
  getLifecycleState(): RuntimeLifecycleState {
    const reasons: RuntimeBusyReason[] = [];
    if (this.admissions) reasons.push('admission');
    if (this.tasks.size || this.pendingSessions.size || this.wakeups.size) reasons.push('dispatch');
    if (this.active.size || this.activeExecutions.size || this.authorizationReviewTasks.size)
      reasons.push('execution');
    if (this.extensionHost.operationCount || this.execution.unconfirmedJobCount)
      reasons.push('background');
    if (
      this.runBindingLeases.size ||
      this.reportBindings.size ||
      this.reportRecoveryCleanupFailed ||
      this.jobReconcileCleanupFailed ||
      this.runResumeCleanupFailed ||
      (this.closing && this.lifecycleState !== 'closed')
    )
      reasons.push('cleanup');
    return { state: this.lifecycleState, busy: reasons.length !== 0, reasons };
  }
  tryBeginShutdown(
    mode: 'if_idle' | 'cancel',
    options: RuntimeShutdownOptions = {},
  ): RuntimeShutdownResult {
    if (mode !== 'if_idle' && mode !== 'cancel') throw new AgentError('invalid_shutdown_mode');
    if (this.closeTask)
      return { accepted: true, state: this.getLifecycleState(), completion: this.closeTask };
    const state = this.getLifecycleState();
    if (mode === 'if_idle' && state.busy) return { accepted: false, state };
    // No await between actual local owner facts and sealing all new work admission.
    this.closing = true;
    this.lifecycleState = 'draining';
    for (const preparation of this.reportRecoveryPreparations)
      preparation.abort(new AgentError('runtime_draining'));
    for (const controller of this.jobReconcileControllers.values())
      controller.abort(new AgentError('runtime_draining'));
    for (const controller of this.runResumeControllers.values())
      controller.abort(new AgentError('runtime_draining'));
    this.closeTask = this.drain({ beforeResourceClose: options.beforeResourceClose }).then(
      () => {
        this.lifecycleState = 'closed';
      },
      (error) => {
        this.lifecycleState = 'drain_failed';
        throw error;
      },
    );
    void this.closeTask.catch(() => {});
    return { accepted: true, state: this.getLifecycleState(), completion: this.closeTask };
  }
  private childLimit(value = this.options.maxConcurrentSubagents ?? 3) {
    if (!Number.isInteger(value) || value < 1 || value > 28)
      throw new AgentError('invalid_child_capacity');
    return value;
  }
  private selectedTools(
    ids?: readonly string[],
    registered: ReadonlyMap<string, ToolDefinition> = this.tools,
  ) {
    if (!ids) {
      if (registered.size > 512) throw new AgentError('invalid_tool_configuration');
      return new Map(registered);
    }
    if (ids.length > 512 || new Set(ids).size !== ids.length)
      throw new AgentError('invalid_tool_configuration');
    return new Map(
      ids.map((id) => {
        const definition = registered.get(id);
        if (!definition) throw new AgentError('tool_unavailable');
        return [id, definition] as const;
      }),
    );
  }
  private runDefinitions(additional: readonly Extension[] = [], ids?: readonly string[]) {
    if (additional.length > 64) throw new AgentError('invalid_extension_configuration');
    const extensions = Object.freeze([...this.extensions, ...additional.map(sealExtension)]);
    const names = new Set<string>();
    const tools = new Map<string, ToolDefinition>();
    const jobs = new Map<string, JobDefinition>();
    const extensionIds = new Map<string, string>();
    for (const extension of extensions) {
      if (extension.apiMajor !== 1 || names.has(extension.id))
        throw new AgentError('extension_definition_conflict');
      names.add(extension.id);
      for (const tool of extension.tools ?? []) {
        if (tools.has(tool.id)) throw new AgentError('tool_definition_conflict');
        tools.set(tool.id, tool);
        extensionIds.set(tool.id, extension.id);
      }
      for (const job of extension.jobs ?? []) {
        if (jobs.has(job.id)) throw new AgentError('job_definition_conflict');
        jobs.set(job.id, job);
      }
    }
    if (jobs.size > 256) throw new AgentError('invalid_job_configuration');
    return { extensions, definitions: this.selectedTools(ids, tools), jobs, extensionIds };
  }
  private configurationSnapshot(
    modelId: string,
    snapshot: Json,
    definitions: ReadonlyMap<string, ToolDefinition>,
    limit?: number,
    extensionIds = this.toolExtensions,
    registeredExtensions = this.extensions,
  ): Json {
    return {
      modelId,
      ...(snapshot === null ? {} : { snapshot: structuredClone(snapshot) }),
      maxConcurrentSubagents: this.childLimit(limit),
      extensions: registeredExtensions.map(({ id, version }) => ({ id, version })),
      tools: [...definitions.values()].map((tool) => ({
        id: tool.id,
        version: tool.version,
        extensionId: extensionIds.get(tool.id)!,
      })),
    };
  }
  private async reviewAuthorization(
    scope: ToolScope,
    request: AuthorizationRequest,
    source: Json,
    decision: PermissionDecision,
  ): Promise<ReadAuthorizationReviewInput | null> {
    const reviewer = scope.bindings?.authorizationReview ?? this.defaultReviewer;
    if (!reviewer || !decision.review) return null;
    const work = 'run' in scope ? scope.run : scope.command;
    const identity = { id: reviewer.id, version: reviewer.version, modelId: reviewer.modelId };
    const requestBody =
      Buffer.byteLength(canonicalJson(decision.review.request)) > 64 * 1024
        ? await this.publishBody(scope, decision.review.request)
        : undefined;
    const reviewRequest = requestBody ? null : decision.review.request;
    const origin =
      'run' in scope
        ? await this.options.store.getCommand(scope.run.originCommandId)
        : scope.command;
    const rootWork = origin ? await this.options.store.getCommand(origin.rootWorkCommandId) : null;
    if (!origin || !rootWork) throw new AgentError('command_not_found');
    const originCommandRequestBody =
      Buffer.byteLength(canonicalJson(origin.request)) > 64 * 1024
        ? await this.publishBody(scope, origin.request)
        : undefined;
    const rootWorkRequestBody =
      Buffer.byteLength(canonicalJson(rootWork.request)) > 64 * 1024
        ? await this.publishBody(scope, rootWork.request)
        : undefined;
    const targetInputBody =
      Buffer.byteLength(canonicalJson(request.input)) > 64 * 1024
        ? await this.publishBody(scope, request.input)
        : undefined;
    const targetSourceBody =
      Buffer.byteLength(canonicalJson(source)) > 64 * 1024
        ? await this.publishBody(scope, source)
        : undefined;
    const fact = await this.options.store.ensureAuthorizationReview({
      expectedStoreId: work.originStoreId,
      owner: scope.owner,
      targetExecutionId: request.executionId,
      ...(originCommandRequestBody ? { originCommandRequestBody } : {}),
      ...(rootWorkRequestBody ? { rootWorkRequestBody } : {}),
      ...(targetInputBody ? { targetInputBody } : {}),
      ...(targetSourceBody ? { targetSourceBody } : {}),
      policyRevision: decision.revision,
      request: reviewRequest,
      ...(requestBody ? { requestBody } : {}),
      requireApproval: decision.review.requireApproval === true,
      reviewer: identity,
    });
    if (canonicalJson(fact.source) !== canonicalJson(source))
      throw new AgentError('context_refresh_required');
    const reference: ReadAuthorizationReviewInput = {
      expectedStoreId: work.originStoreId,
      targetExecutionId: request.executionId,
      reviewExecutionId: fact.operation.executionId!,
      policyRevision: decision.revision,
      request: structuredClone(reviewRequest),
      ...(requestBody ? { requestBody } : {}),
      requireApproval: decision.review.requireApproval === true,
      reviewer: identity,
    };
    let task = this.authorizationReviewTasks.get(reference.reviewExecutionId);
    // An existing cold carrier is observation only. It never restarts a provider call.
    if (!task && fact.created) {
      const command = await this.options.store.getCommand(fact.operation.commandId);
      if (command?.kind !== 'authorization.review')
        throw new AgentError('authorization_review_unverifiable');
      const carrierId = `agent/${fact.configuration.id}`;
      const permissions: Permissions = {
        async authorize(candidate) {
          return {
            allowed:
              (candidate.kind === 'model' &&
                candidate.definitionId === identity.modelId &&
                candidate.definitionVersion === '1') ||
              (candidate.kind === 'job' &&
                candidate.definitionId === carrierId &&
                candidate.definitionVersion === identity.version),
            revision: 'authorization-review-purpose-1',
          };
        },
      };
      let calls = 0;
      const thisRuntime = this;
      const model: ModelAdapter = {
        async *stream(input, options) {
          if (calls++ || input.tools?.length)
            throw new AgentError('authorization_review_call_limit');
          const expanded = await thisRuntime.expandReviewRequest(input, scope);
          for await (const event of reviewer.model.stream(expanded, options)) {
            if (event.type === 'tool_call' || (event.type === 'finish' && event.reason !== 'stop'))
              throw new AgentError('authorization_review_output_invalid');
            yield event;
          }
        },
      };
      const configured = {
        configuration: fact.configuration,
        inputSchema: { type: 'object' } as JsonSchema,
        binding: {
          model,
          modelId: identity.modelId,
          definitions: new Map<string, ToolDefinition>(),
          jobs: new Map<string, JobDefinition>(),
          extensions: [],
          sources: {
            async capture() {
              return [];
            },
          },
          permissions,
        },
      };
      const parent: StandaloneScope = {
        command,
        owner: scope.owner,
        workspaceId: scope.workspaceId,
        signal: scope.signal,
        parentExecutionId: request.executionId,
        requirements: [],
        bindings: {
          extensions: [],
          tools: new Map(),
          jobs: new Map(),
          permissions,
          retain: () => async () => {},
        },
      };
      const child = this.childDefinition(
        fact.configuration.id,
        parent,
        request.executionId,
        fact.source,
        configured,
      );
      task = this.execution.job(parent, {
        executionId: reference.reviewExecutionId,
        definition: child.definition,
        request: fact.input,
        source: fact.source,
        cancelWithParent: true,
      });
      this.authorizationReviewTasks.set(reference.reviewExecutionId, task);
    }
    try {
      await task;
    } finally {
      if (task && this.authorizationReviewTasks.get(reference.reviewExecutionId) === task)
        this.authorizationReviewTasks.delete(reference.reviewExecutionId);
    }
    scope.signal.throwIfAborted();
    await scope.checkpoint?.();
    await scope.checkFreshness?.();
    return reference;
  }
  private childPermissions(parent: Permissions, child: Permissions | undefined): Permissions {
    const policies = child && child !== parent ? [parent, child] : [parent];
    return {
      async authorize(request) {
        const decisions: PermissionDecision[] = [];
        for (const policy of policies) {
          request.signal.throwIfAborted();
          decisions.push(
            freeze(
              structuredClone(
                await policy.authorize({
                  ...request,
                  input: freeze(structuredClone(request.input)),
                }),
              ),
            ),
          );
        }
        const controlReads: NonNullable<PermissionDecision['controlReads']>[number][] = [];
        let controlError: string | undefined;
        for (const decision of decisions) {
          const reads = decision.controlReads;
          if (reads === undefined) continue;
          if (!Array.isArray(reads) || reads.length > 3) {
            controlError = 'invalid_permission_control_reads';
            break;
          }
          for (const read of reads) {
            if (
              !read ||
              typeof read !== 'object' ||
              Array.isArray(read) ||
              Object.keys(read).some((key) => !['kind', 'scope', 'revision'].includes(key)) ||
              !['permission.mode', 'workspace.trust'].includes(read.kind) ||
              typeof read.scope !== 'string' ||
              !read.scope.length ||
              read.scope.length > 256 ||
              typeof read.revision !== 'string' ||
              !/^(0|[1-9][0-9]{0,18})$/.test(read.revision) ||
              BigInt(read.revision) > 9223372036854775807n
            ) {
              controlError = 'invalid_permission_control_reads';
              break;
            }
            const prior = controlReads.find(
              (item) => item.kind === read.kind && item.scope === read.scope,
            );
            if (prior && prior.revision !== read.revision) {
              controlError = 'permission_control_changed';
              break;
            }
            if (!prior) controlReads.push(read);
          }
          if (controlError) break;
        }
        if (controlReads.length > 3) controlError = 'invalid_permission_control_reads';
        const proof = {
          ...(decisions.some((decision) => decision.controlReads !== undefined)
            ? { controlReads }
            : {}),
          ...(decisions.some((decision) => decision.snapshot !== undefined)
            ? {
                snapshot: {
                  namespace: 'agent.permission-intersection',
                  version: '1',
                  data: {
                    policies: decisions.map((decision, index) => ({
                      scope: index === 0 ? 'parent' : 'child',
                      revision: decision.revision,
                      allowed: decision.allowed,
                      snapshot: decision.snapshot ?? null,
                    })),
                  } as Json,
                },
              }
            : {}),
        };
        const bindings: Json = decisions.map((decision) => ({
          controlReads:
            controlError || decision.controlReads === undefined
              ? null
              : decision.controlReads.map((read) => ({ ...read })),
          revision: decision.revision,
          allowed: decision.allowed,
          approval: decision.approval?.request ?? null,
          review: decision.review
            ? {
                request: decision.review.request,
                requireApproval: decision.review.requireApproval === true,
              }
            : null,
        }));
        const revision = `child-intersection/${await semanticDigest(bindings)}`;
        if (controlError) return { allowed: false, revision, reason: controlError };
        const denied = decisions.find(
          (decision) => !decision.allowed && !decision.approval && !decision.review,
        );
        if (denied)
          return {
            allowed: false,
            revision,
            reason: denied.reason ?? 'parent_child_permission_denied',
            ...proof,
          };
        const challenges = decisions.filter((decision) => !decision.allowed);
        if (!challenges.length) return { allowed: true, revision, ...proof };
        const approvals = challenges.filter((decision) => decision.approval);
        const reviews = challenges.filter((decision) => decision.review);
        const approval = approvals.length
          ? {
              request: {
                kind: 'parent_child_permission_intersection',
                policies: decisions.map((decision, index) => ({
                  scope: index === 0 ? 'parent' : 'child',
                  revision: decision.revision,
                  request: decision.approval?.request ?? null,
                })),
              } as Json,
            }
          : undefined;
        const review = reviews.length
          ? {
              request: {
                kind: 'parent_child_permission_intersection',
                policies: decisions.map((decision, index) => ({
                  scope: index === 0 ? 'parent' : 'child',
                  revision: decision.revision,
                  request: decision.review?.request ?? null,
                })),
              } as Json,
              requireApproval:
                approvals.length > 0 ||
                reviews.some((decision) => decision.review?.requireApproval),
            }
          : undefined;
        return {
          allowed: false,
          revision,
          ...proof,
          ...(approval ? { approval } : {}),
          ...(review ? { review } : {}),
        };
      },
    };
  }
  private async nearestParentRun(
    origin: ExecutionRecord,
  ): Promise<{ ancestor: ExecutionRecord; run: RunRecord | null }> {
    const visited = new Set<string>();
    let ancestor = origin;
    const originCommand = await this.options.store.getCommand(origin.originCommandId);
    for (let depth = 0; ; depth++) {
      if (visited.has(ancestor.id) || depth > 32) throw new AgentError('invalid_child_parent');
      visited.add(ancestor.id);
      const ancestorCommand = await this.options.store.getCommand(ancestor.originCommandId);
      if (
        !originCommand ||
        !ancestorCommand ||
        ancestorCommand.subjectId !== originCommand.subjectId ||
        ancestorCommand.sessionId !== origin.sessionId ||
        ancestorCommand.originStoreId !== origin.originStoreId ||
        ancestorCommand.rootWorkCommandId !== origin.rootWorkCommandId ||
        ancestorCommand.rootWorkSeq !== origin.rootWorkSeq
      )
        throw new AgentError('invalid_child_parent');
      if (ancestor.runId !== null) {
        const run = await this.options.store.getRun(ancestor.runId);
        if (
          !run ||
          run.sessionId !== origin.sessionId ||
          run.originStoreId !== origin.originStoreId ||
          run.rootWorkCommandId !== origin.rootWorkCommandId ||
          run.rootWorkSeq !== origin.rootWorkSeq ||
          run.originCommandId !== ancestor.originCommandId
        )
          throw new AgentError('invalid_child_parent');
        return { ancestor, run };
      }
      if (!ancestor.parentExecutionId) return { ancestor, run: null };
      const previous = await this.options.store.getExecution(ancestor.parentExecutionId);
      if (
        !previous ||
        previous.sessionId !== origin.sessionId ||
        previous.originStoreId !== origin.originStoreId ||
        previous.rootWorkCommandId !== origin.rootWorkCommandId ||
        previous.rootWorkSeq !== origin.rootWorkSeq
      )
        throw new AgentError('invalid_child_parent');
      ancestor = previous;
    }
  }
  private async resolveChildDefinition(
    configurationId: string,
    parent: StandaloneScope,
    parentExecutionId: string,
    source: Json,
    continuation?: { executionId: string; afterRunId: string },
  ) {
    const declared = this.childConfigurations.get(configurationId);
    if (!declared) throw new AgentError('child_configuration_unavailable');
    if (!this.options.resolveChildRunConfiguration)
      return this.childDefinition(
        configurationId,
        parent,
        parentExecutionId,
        source,
        undefined,
        undefined,
        continuation,
      );
    const execution = await this.options.store.getExecution(parentExecutionId);
    const session = await this.options.store.getSession(parent.command.sessionId);
    if (!execution || !session) throw new AgentError('child_parent_binding_unavailable');
    if (
      execution.sessionId !== parent.command.sessionId ||
      execution.originStoreId !== parent.command.originStoreId ||
      execution.rootWorkCommandId !== parent.command.rootWorkCommandId ||
      execution.rootWorkSeq !== parent.command.rootWorkSeq ||
      execution.originCommandId !== parent.command.id
    )
      throw new AgentError('child_parent_binding_unavailable');
    const workspace = await this.options.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new AgentError('workspace_not_found');
    const nearest = await this.nearestParentRun(execution);
    const allowedExtensions = new Set(
      nearest.run ? (parent.bindings?.extensions ?? []).map((item) => item.id) : [],
    );
    const reads = new Map<string, import('./storage/types').ChildConfigurationRecordRead>();
    let reading = true;
    const getRecord = async (extensionId: string, key: string) => {
      parent.signal.throwIfAborted();
      if (!reading || !allowedExtensions.has(extensionId) || !key || key.length > 256)
        throw new AgentError('child_configuration_read_scope_denied');
      const scopeKey = JSON.stringify([extensionId, key]);
      if (!reads.has(scopeKey) && reads.size >= 64)
        throw new AgentError('child_configuration_read_limit');
      const current = await this.options.store.getExtensionRecord({
        sessionId: execution.sessionId,
        extensionId,
        key,
      });
      parent.signal.throwIfAborted();
      if (current && (current.originStoreId !== execution.originStoreId || current.forkProvenance))
        throw new AgentError('child_configuration_read_scope_denied');
      const digest = await semanticDigest(current as unknown as Json);
      const prior = reads.get(scopeKey);
      if (prior && prior.digest !== digest) throw new AgentError('context_refresh_required');
      reads.set(scopeKey, {
        extensionId,
        key,
        digest,
        revision: current?.revision ?? null,
        originStoreId: current?.originStoreId ?? null,
      });
      return freeze(structuredClone(current));
    };
    let configuration: RunConfiguration;
    try {
      configuration = await this.options.resolveChildRunConfiguration({
        records: {
          forExtension: (extensionId) => {
            if (!reading || !allowedExtensions.has(extensionId))
              throw new AgentError('child_configuration_read_scope_denied');
            return { get: (key) => getRecord(extensionId, key) };
          },
        },
        configurationId,
        parentExecution: freeze(structuredClone(execution)),
        parentRun: freeze(structuredClone(nearest.run)),
        parentSession: freeze(structuredClone(session)),
        workspace: freeze(structuredClone(workspace)),
        command: freeze(structuredClone(parent.command)),
        signal: parent.signal,
      });
    } finally {
      reading = false;
    }
    const checkRecordFreshness = async () => {
      parent.signal.throwIfAborted();
      await parent.checkFreshness?.();
      for (const read of reads.values()) {
        const current = await this.options.store.getExtensionRecord({
          sessionId: execution.sessionId,
          extensionId: read.extensionId,
          key: read.key,
        });
        if ((await semanticDigest(current as unknown as Json)) !== read.digest)
          throw new AgentError('context_refresh_required');
      }
      parent.signal.throwIfAborted();
    };
    try {
      await checkRecordFreshness();
      const captured = this.runDefinitions(configuration.extensions, configuration.toolIds);
      return this.childDefinition(
        configurationId,
        { ...parent, checkFreshness: checkRecordFreshness },
        parentExecutionId,
        source,
        undefined,
        {
          inputSchema: declared.inputSchema,
          configuration: {
            ...declared.configuration,
            recordReads: structuredClone([...reads.values()]),
            snapshot: this.configurationSnapshot(
              configuration.modelId,
              configuration.snapshot,
              captured.definitions,
              configuration.maxConcurrentSubagents,
              captured.extensionIds,
              captured.extensions,
            ),
          },
          binding: {
            ...configuration,
            model: configuration.model ?? declared.binding.model,
            sources: sealSources(configuration.sources),
            compressor: sealCompressor(
              configuration.compressor ?? declared.binding.compressor ?? this.options.compressor,
            ),
            afterTurn:
              configuration.afterTurn ?? declared.binding.afterTurn ?? this.options.afterTurn,
            definitions: captured.definitions,
            jobs: captured.jobs,
            extensions: captured.extensions,
            authorizationReview: sealReview(
              configuration.authorizationReview ?? this.defaultReviewer,
            ),
          },
        },
        continuation,
      );
    } catch (error) {
      await configuration.dispose?.();
      throw error;
    }
  }
  private childDefinition(
    configurationId: string,
    parent: StandaloneScope,
    parentExecutionId: string,
    source: Json,
    reviewConfiguration?: {
      binding: RunBinding;
      configuration: ChildConfiguration;
      inputSchema: JsonSchema;
    },
    freshConfiguration?: {
      binding: RunBinding;
      configuration: ChildConfiguration;
      inputSchema: JsonSchema;
    },
    continuation?: { executionId: string; afterRunId: string },
  ): {
    configuration: ChildConfiguration;
    definition: JobDefinition;
    disposeUnused: () => Promise<void>;
    reserveForCreation?: () => Promise<void>;
  } {
    const template =
      reviewConfiguration ?? freshConfiguration ?? this.childConfigurations.get(configurationId);
    if (!template) throw new AgentError('child_configuration_unavailable');
    const capturedParent = parent.bindings;
    if (!reviewConfiguration && !capturedParent)
      throw new AgentError('child_parent_binding_unavailable');
    const toolIdentity = (tool: ToolDefinition, extensions: readonly Extension[]) => ({
      id: tool.id,
      version: tool.version,
      description: tool.description,
      inputSchema: tool.inputSchema,
      resources: (tool.resources ?? null) as Json,
      extensionId:
        extensions.find((extension) =>
          extension.tools?.some((candidate) => candidate.id === tool.id),
        )?.id ?? null,
    });
    const assertParentTools = (
      tools: ReadonlyMap<string, ToolDefinition>,
      extensions: readonly Extension[],
    ) => {
      if (reviewConfiguration) return;
      for (const tool of tools.values()) {
        const permitted = capturedParent!.tools.get(tool.id);
        if (
          !permitted ||
          canonicalJson(toolIdentity(tool, extensions)) !==
            canonicalJson(toolIdentity(permitted, capturedParent!.extensions))
        )
          throw new AgentError('child_tool_scope_exceeds_parent');
      }
    };
    const assertParentJobs = (
      jobs: ReadonlyMap<string, JobDefinition>,
      extensions: readonly Extension[],
    ) => {
      if (reviewConfiguration) return;
      const identity = (job: JobDefinition, modules: readonly Extension[]) => ({
        id: job.id,
        version: job.version,
        description: job.description,
        inputSchema: job.inputSchema,
        resources: (job.resources ?? null) as Json,
        extensionId:
          modules.find((extension) => extension.jobs?.some((candidate) => candidate.id === job.id))
            ?.id ?? null,
      });
      for (const job of jobs.values()) {
        const permitted = capturedParent!.jobs.get(job.id);
        if (
          !permitted ||
          canonicalJson(identity(job, extensions)) !==
            canonicalJson(identity(permitted, capturedParent!.extensions))
        )
          throw new AgentError('child_job_scope_exceeds_parent');
      }
    };
    assertParentTools(template.binding.definitions, template.binding.extensions ?? this.extensions);
    assertParentJobs(
      template.binding.jobs ?? new Map(),
      template.binding.extensions ?? this.extensions,
    );
    const configured = {
      ...template,
      binding: {
        ...template.binding,
        permissions: reviewConfiguration
          ? template.binding.permissions
          : this.childPermissions(
              capturedParent!.permissions ?? this.options.permissions,
              template.binding.permissions,
            ),
        definitions: new Map(template.binding.definitions),
        jobs: new Map(template.binding.jobs),
        extensions: template.binding.extensions ?? this.extensions,
      },
    };
    if (!reviewConfiguration && template.binding.readStepCapabilities) {
      const read = template.binding.readStepCapabilities;
      configured.binding.readStepCapabilities = async (input) => {
        const selected = await read(input);
        const bound = this.runDefinitions(selected.extensions, selected.toolIds);
        assertParentTools(bound.definitions, bound.extensions);
        assertParentJobs(bound.jobs, bound.extensions);
        return selected;
      };
    }
    let released = false;
    let reservedRelease: (() => void) | undefined;
    const staticRelease =
      !reviewConfiguration && !freshConfiguration
        ? this.childRetainers.get(configurationId)!()
        : undefined;
    const releaseConfigured = async () => {
      if (released) return;
      released = true;
      reservedRelease?.();
      reservedRelease = undefined;
      if (staticRelease) await staticRelease();
      else await template.binding.dispose?.();
    };
    configured.binding.dispose = releaseConfigured;
    const thisRuntime = this;
    let activation: ChildRunActivation | undefined;
    let handle: JobHandle | undefined;
    let controller: AbortController | undefined;
    let admitted = false;
    let task: Promise<void> | undefined;
    let jobSignal: AbortSignal | undefined;
    let carrierExecutionId: string | undefined;
    const abort = () =>
      controller?.abort(jobSignal?.reason ?? new AgentError('child_cancel_requested'));
    const checkHandle = (candidate: JobHandle) => {
      if (candidate !== handle || !activation || !controller)
        throw new AgentError('child_handle_unavailable');
    };
    const result = async (): Promise<import('./extensions').ToolResult> => {
      if (!activation) throw new AgentError('child_handle_unavailable');
      const current = await this.options.store.getRun(activation.run.id);
      const outcome =
        !current || current.isActive || current.status === 'interrupted'
          ? ('outcome_unknown' as const)
          : current.status === 'completed'
            ? ('succeeded' as const)
            : current.status === 'cancelled'
              ? ('cancelled' as const)
              : ('failed' as const);
      const messages =
        outcome === 'succeeded'
          ? await this.modelMessages(
              activation.session.id,
              parent.command.originStoreId,
              undefined,
              parent.command.subjectId,
            )
          : [];
      const assistant = messages
        .slice()
        .reverse()
        .find((message) => message.role === 'assistant');
      const content = assistant?.content ?? current?.reason ?? 'child_result_unavailable';
      let reviewOutput: AuthorizationReviewOutput | undefined;
      if (reviewConfiguration && outcome === 'succeeded') {
        const modelExecutionId = assistant?.sourceIds?.[0];
        if (!modelExecutionId || assistant.sourceIds?.length !== 1)
          throw new AgentError('authorization_review_unverifiable');
        const snapshot = await this.options.store.getModelOutputSnapshot({
          expectedStoreId: parent.command.originStoreId,
          sessionId: activation.session.id,
          subjectId: parent.command.subjectId,
          executionId: modelExecutionId,
        });
        if (snapshot.output) {
          if (!snapshot.complete || snapshot.identity.runId !== activation.run.id)
            throw new AgentError('authorization_review_unverifiable');
          const signal = jobSignal ?? parent.signal;
          const full = await readModelOutput(
            snapshot.output,
            {
              storeId: snapshot.originStoreId,
              sessionId: snapshot.identity.sessionId,
              subjectId: snapshot.subjectId,
              executionId: snapshot.identity.executionId,
            },
            (reference) => this.readBody(reference, signal, snapshot.storeId),
            signal,
          );
          if (!full.complete || full.toolCalls.length !== 0 || full.content !== content)
            throw new AgentError('authorization_review_unverifiable');
          let answer: ReturnType<typeof authorizationReviewAnswer> = null;
          try {
            answer = authorizationReviewAnswer(JSON.parse(full.content));
          } catch {
            // Invalid review output remains unavailable; it never authorizes the target.
          }
          if (answer) {
            reviewOutput = {
              kind: 'authorization_review_output',
              version: 1,
              modelExecutionId,
              modelOutputDigest: await semanticDigest(snapshot.output as unknown as Json),
              contentHash: await semanticDigestBytes(Buffer.from(full.content)),
              answer,
            };
            if (!this.options.artifacts) throw new AgentError('artifact_content_unavailable');
            await this.options.artifacts.publish({
              expectedStoreId: snapshot.storeId,
              sessionId: snapshot.identity.sessionId,
              subjectId: snapshot.subjectId,
              scope: { kind: 'execution', id: modelExecutionId },
              refId: authorizationReviewOutputRefId(reviewOutput.modelOutputDigest),
              mediaType: authorizationReviewOutputMediaType,
              content: Buffer.from(canonicalJson(reviewOutput)),
            });
          }
        }
      }
      let modelContent: import('./extensions').ToolResult['modelContent'];
      if (Buffer.byteLength(content) > 64 * 1024) {
        if (!this.options.artifacts || !carrierExecutionId)
          throw new AgentError('artifact_content_unavailable');
        const carrier = await this.options.store.getExecution(carrierExecutionId);
        const origin = carrier && (await this.options.store.getCommand(carrier.originCommandId));
        if (
          carrier?.kind !== 'job' ||
          carrier.childSessionId !== activation.session.id ||
          carrier.originStoreId !== parent.command.originStoreId ||
          carrier.sessionId !== parent.command.sessionId ||
          carrier.parentExecutionId !== parentExecutionId ||
          !origin ||
          origin.originStoreId !== carrier.originStoreId ||
          origin.sessionId !== carrier.sessionId ||
          origin.subjectId !== parent.command.subjectId ||
          origin.rootWorkCommandId !== carrier.rootWorkCommandId ||
          origin.rootWorkSeq !== carrier.rootWorkSeq ||
          carrier.rootWorkCommandId !== parent.command.rootWorkCommandId ||
          carrier.rootWorkSeq !== parent.command.rootWorkSeq
        )
          throw new AgentError('model_content_invalid');
        const bytes = Buffer.from(content);
        const hash = await semanticDigestBytes(bytes);
        const reference = await this.options.artifacts.publish({
          expectedStoreId: carrier.originStoreId,
          sessionId: carrier.sessionId,
          subjectId: origin.subjectId,
          scope: { kind: 'execution', id: carrierExecutionId },
          refId: `child-result-${carrierExecutionId}-${hash}`,
          mediaType: 'text/plain; charset=utf-8',
          content: bytes,
        });
        modelContent = {
          kind: 'artifact',
          encoding: 'utf-8',
          reference: {
            id: reference.id,
            size: reference.size,
            mediaType: reference.mediaType,
            scope: reference.scope,
          },
        };
      }
      return {
        outcome,
        content: modelContent
          ? `Child completed; complete output available (${modelContent.reference.size} bytes).`
          : content,
        ...(modelContent ? { modelContent } : {}),
        details: {
          childSessionId: activation.session.id,
          runId: activation.run.id,
          status: current?.status ?? 'unavailable',
          ...(reviewOutput ? { authorizationReviewOutput: reviewOutput } : {}),
        },
      };
    };
    const definition: JobDefinition = {
      id: `agent/${configurationId}`,
      version: configured.configuration.version,
      description: 'A permitted child Session using the same Agent Loop.',
      inputSchema: configured.inputSchema,
      start: async (_input, context) => {
        if (handle) throw new AgentError('child_already_started');
        if (!admitted) throw new AgentError('child_admission_required');
        await parent.checkFreshness?.();
        context.signal.throwIfAborted();
        const job = await this.options.store.getExecution(context.executionId);
        if (!job) throw new AgentError('execution_not_found');
        carrierExecutionId = job.id;
        const evaluations = await this.execution.requirements(
          { ...parent, requirements: job.requirements },
          'dispatch',
        );
        activation = await this.options.store.activateChildRun({
          expectedStoreId: parent.command.originStoreId,
          owner: parent.owner,
          executionId: context.executionId,
          configuration: configured.configuration.snapshot,
          requirementEvaluations: evaluations,
          freshness: { checked: true, source },
        });
        controller = new AbortController();
        jobSignal = context.signal;
        jobSignal.addEventListener('abort', abort, { once: true });
        if (jobSignal.aborted) abort();
        handle = {
          reference: {
            kind: 'child_session',
            childSessionId: activation.session.id,
            runId: activation.run.id,
            commandId: activation.command.id,
          },
        };
        return handle;
      },
      observe: async function* (candidate): AsyncIterable<JobEvent> {
        checkHandle(candidate);
        if (!task)
          task = thisRuntime.executeRun(
            activation!.command,
            parent.owner,
            activation!.run,
            configured.binding,
            controller!,
          );
        yield {
          type: 'progress',
          value: { childSessionId: activation!.session.id, runId: activation!.run.id },
        };
        await task.catch(() => {});
        yield { type: 'terminal', result: await result(), supervision: 'ended' };
      },
      cancel: async (candidate) => {
        checkHandle(candidate);
        controller!.abort(new AgentError('child_cancel_requested'));
        // No observer means no model call has begun. Settle the activated Run without starting it.
        if (!task)
          task = this.options.store
            .finishRun({
              expectedStoreId: parent.command.originStoreId,
              owner: parent.owner,
              runId: activation!.run.id,
              status: 'cancelled',
              reason: 'child_cancel_requested',
              requirements: [],
            })
            .then(() => releaseConfigured());
        const ended = await Promise.race([
          task.then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 5000);
            timeout.unref();
          }),
        ]);
        const run = await this.options.store.getRun(activation!.run.id).catch(() => null);
        return {
          status: ended && run && !run.isActive ? 'stopped' : 'unknown',
          details: { childSessionId: activation!.session.id, runId: activation!.run.id },
        };
      },
      dispose: async (candidate) => {
        checkHandle(candidate);
        jobSignal?.removeEventListener('abort', abort);
        if (!task) await releaseConfigured();
      },
    };
    const capacity = async () => {
      const origin = await this.options.store.getExecution(parentExecutionId);
      if (!origin) throw new AgentError('execution_not_found');
      const { ancestor, run: parentRun } = await this.nearestParentRun(origin);
      const configuration = parentRun?.configuration;
      assertParentTools(configured.binding.definitions, configured.binding.extensions);
      const limit =
        configuration && typeof configuration === 'object' && !Array.isArray(configuration)
          ? this.childLimit(
              Number(
                configuration.maxConcurrentSubagents ?? this.options.maxConcurrentSubagents ?? 3,
              ),
            )
          : this.childLimit();
      return { key: ancestor.runId ?? parent.command.id, limit };
    };
    this.childAdmissions.set(definition, async (scope) => {
      if (reviewConfiguration) {
        admitted = true;
        return () => {
          admitted = false;
        };
      }
      if (continuation) {
        for (;;) {
          scope.signal.throwIfAborted();
          const predecessor = await this.options.store.getExecution(continuation.executionId);
          const priorRun = await this.options.store.getRun(continuation.afterRunId);
          if (
            !predecessor ||
            !priorRun ||
            predecessor.originStoreId !== parent.command.originStoreId ||
            priorRun.originStoreId !== parent.command.originStoreId ||
            priorRun.sessionId !== predecessor.childSessionId ||
            priorRun.originCommandId !== `child-start-${predecessor.id}`
          )
            throw new AgentError('operation_unverifiable');
          if (predecessor.status === 'outcome_unknown' || priorRun.status === 'interrupted')
            throw new AgentError('operation_needs_review');
          if (
            ['succeeded', 'failed', 'cancelled'].includes(predecessor.status) &&
            !priorRun.isActive
          )
            break;
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(scope.signal.reason);
            };
            const timer = setTimeout(() => {
              scope.signal.removeEventListener('abort', abort);
              resolve();
            }, 20);
            scope.signal.addEventListener('abort', abort, { once: true });
          });
        }
      }
      const target = await capacity();
      const release =
        reservedRelease ?? (await this.childSlots.acquire(target.key, target.limit, scope.signal));
      reservedRelease = undefined;
      admitted = true;
      return () => {
        admitted = false;
        release();
      };
    });
    return {
      configuration: structuredClone(configured.configuration),
      definition,
      reserveForCreation: reviewConfiguration
        ? undefined
        : async () => {
            if (released) throw new AgentError('child_configuration_unavailable');
            if (reservedRelease) return;
            const target = await capacity();
            const release = this.childSlots.tryAcquire(target.key, target.limit, parent.signal);
            if (!release) throw new AgentError('child_capacity_full');
            reservedRelease = release;
          },
      disposeUnused: async () => {
        if (!task) await releaseConfigured();
      },
    };
  }
  private trackLive(
    command: CommandRecord,
    owner: OwnerRef,
    controller: AbortController,
    runId?: string,
  ) {
    this.active.set(command.id, {
      sessionId: command.sessionId,
      originStoreId: command.originStoreId,
      owner,
      controller,
      subjectId: command.subjectId,
      ...(runId ? { runId } : {}),
    });
    this.watchControls();
    return () => this.active.delete(command.id);
  }
  private trackExecution(id: string, scope: ToolScope, controller: AbortController) {
    const work =
      'run' in scope
        ? {
            sessionId: scope.run.sessionId,
            originStoreId: scope.run.originStoreId,
            subjectId: this.active.get(scope.run.originCommandId)?.subjectId,
          }
        : {
            sessionId: scope.command.sessionId,
            originStoreId: scope.command.originStoreId,
            subjectId: scope.command.subjectId,
          };
    if (!work.subjectId) throw new AgentError('execution_scope_unavailable');
    this.activeExecutions.set(id, {
      ...work,
      subjectId: work.subjectId,
      owner: scope.owner,
      controller,
    });
    this.watchControls();
    return () => this.activeExecutions.delete(id);
  }
  createWorkspace(input: Parameters<Store['createWorkspace']>[0]) {
    return this.options.store.createWorkspace(input);
  }
  getMetadata() {
    return this.options.store.getMetadata();
  }
  readSessionExportText(input: Parameters<Store['readSessionExportText']>[0]) {
    return this.options.store.readSessionExportText(input);
  }
  beginSessionExport(input: Parameters<Store['beginSessionExport']>[0]) {
    return this.options.store.beginSessionExport(input);
  }
  readSessionExportPage(input: Parameters<Store['readSessionExportPage']>[0]) {
    return this.options.store.readSessionExportPage(input);
  }
  verifySessionExport(input: Parameters<Store['verifySessionExport']>[0]) {
    return this.options.store.verifySessionExport(input);
  }
  listModelInputs(input: Parameters<Store['listModelInputs']>[0]): Promise<ModelInputPage> {
    return this.options.store.listModelInputs(input);
  }
  async readModelInput(
    input: Parameters<Store['getModelInputSnapshot']>[0] & { signal?: AbortSignal },
  ): Promise<ModelInputSnapshot> {
    const { signal, ...scope } = input;
    signal?.throwIfAborted();
    const snapshot = await this.options.store.getModelInputSnapshot(scope);
    signal?.throwIfAborted();
    const stored = snapshot.input;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored))
      throw new AgentError('model_input_unavailable');
    const body = bodyReference(stored.body);
    let request: ModelRequest;
    let hash: string;
    let size: string;
    if (body) {
      const ref = body.reference;
      if (
        ref.storeId !== snapshot.originStoreId ||
        ref.sessionId !== snapshot.identity.sessionId ||
        ref.subjectId !== snapshot.subjectId ||
        ref.scope.kind !== 'session' ||
        ref.scope.id !== snapshot.identity.sessionId ||
        ref.mediaType !== 'application/json'
      )
        throw new AgentError('model_body_invalid');
      request = persistedModelRequest(jsonBody(await this.readBody(ref, signal, snapshot.storeId)));
      if (
        request.modelId !== stored.modelId ||
        request.requestId !== stored.requestId ||
        canonicalJson(
          request.tools.map((tool) => ({ id: tool.id, definitionVersion: tool.definitionVersion })),
        ) !== canonicalJson(stored.tools!)
      )
        throw new AgentError('model_body_invalid');
      hash = ref.hash;
      size = ref.size;
      if (snapshot.identity.confirmation === 'succeeded' && snapshot.receiptInputHash !== hash)
        throw new AgentError('model_body_receipt_invalid');
    } else {
      request = persistedModelRequest(stored);
      const bytes = Buffer.from(canonicalJson(stored));
      hash = await semanticDigestBytes(bytes);
      size = String(bytes.byteLength);
    }
    if (
      request.requestId !== snapshot.identity.executionId ||
      request.modelId !== snapshot.identity.modelId
    )
      throw new AgentError('model_body_invalid');
    let metadata = snapshot.metadata;
    if (
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      metadata.version === 1 &&
      'body' in metadata
    ) {
      const sealed = bodyReference(metadata.body);
      if (
        Object.keys(metadata).some((key) => key !== 'version' && key !== 'body') ||
        !sealed ||
        sealed.reference.storeId !== snapshot.originStoreId ||
        sealed.reference.sessionId !== snapshot.identity.sessionId ||
        sealed.reference.subjectId !== snapshot.subjectId ||
        sealed.reference.scope.kind !== 'session' ||
        sealed.reference.scope.id !== snapshot.identity.sessionId ||
        sealed.reference.mediaType !== 'application/json'
      )
        throw new AgentError('model_snapshot_invalid');
      metadata = jsonBody(await this.readBody(sealed.reference, signal, snapshot.storeId));
    }
    signal?.throwIfAborted();
    const { modelId: _modelId, ...identity } = snapshot.identity;
    return {
      ...identity,
      storeId: snapshot.storeId,
      bodyHash: hash,
      bodyBytes: size,
      snapshotCursor: snapshot.snapshotCursor,
      request,
      metadata: modelInputMetadata(metadata, snapshot.dispatchAuthorization),
    };
  }
  async readModelOutput(
    input: Parameters<Store['getModelOutputSnapshot']>[0] & { signal?: AbortSignal },
  ): Promise<ModelOutputSnapshot> {
    const { signal, ...scope } = input;
    signal?.throwIfAborted();
    const snapshot = await this.options.store.getModelOutputSnapshot(scope);
    const output = snapshot.output
      ? await readModelOutput(
          snapshot.output,
          {
            storeId: snapshot.originStoreId,
            sessionId: snapshot.identity.sessionId,
            subjectId: snapshot.subjectId,
            executionId: snapshot.identity.executionId,
          },
          (reference) => this.readBody(reference, signal, snapshot.storeId),
          signal,
        )
      : {
          content: snapshot.content,
          reasoning: snapshot.reasoning,
          toolCalls: snapshot.toolCalls,
          complete: snapshot.complete,
        };
    signal?.throwIfAborted();
    const bytes = Buffer.from(canonicalJson(output as unknown as Json));
    const { modelId: _modelId, confirmation: _confirmation, ...identity } = snapshot.identity;
    return {
      ...identity,
      storeId: snapshot.storeId,
      snapshotCursor: snapshot.snapshotCursor,
      bodyHash: await semanticDigestBytes(bytes),
      bodyBytes: String(bytes.byteLength),
      contentBytes: String(Buffer.byteLength(output.content)),
      reasoningBytes: String(Buffer.byteLength(output.reasoning)),
      output,
    };
  }
  async readArtifact(input: ArtifactReadInput) {
    if (!this.options.artifacts) throw new AgentError('artifact_content_unavailable');
    const reference = await this.options.store.getArtifactReference(input);
    if (!reference) throw new AgentError('artifact_reference_not_found');
    return { reference, content: await this.options.artifacts.read(input) };
  }
  beginHostMutation(input: Parameters<Store['beginHostMutation']>[0]) {
    if (this.closing) throw new AgentError('runtime_draining');
    return this.options.store.beginHostMutation(input);
  }
  finishHostMutation(input: Parameters<Store['finishHostMutation']>[0]) {
    return this.options.store.finishHostMutation(input);
  }
  readHostControl(input: Parameters<Store['readHostControl']>[0]) {
    return this.options.store.readHostControl(input);
  }
  listPermissionGrants(input: Parameters<Store['listPermissionGrants']>[0]) {
    return this.options.store.listPermissionGrants(input);
  }
  clearPermissionGrants(input: Parameters<Store['clearPermissionGrants']>[0]) {
    if (this.closing) throw new AgentError('service_draining');
    return this.options.store.clearPermissionGrants(input);
  }
  getHostMutation(input: Parameters<Store['getHostMutation']>[0]) {
    return this.options.store.getHostMutation(input);
  }
  getInteraction(input: Parameters<Store['getInteraction']>[0]) {
    return this.options.store.getInteraction(input);
  }
  listInteractions(input: Parameters<Store['listInteractions']>[0]) {
    return this.options.store.listInteractions(input);
  }
  async listPendingInputs(input: Parameters<Store['listPendingInputs']>[0]) {
    if ((await this.options.store.getMetadata()).storeId !== input.expectedStoreId)
      throw new AgentError('store_identity_mismatch');
    const session = await this.options.store.getSession(input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    if (session.parentSessionId !== null) throw new AgentError('group_root_required');
    return this.options.store.listPendingInputs(input);
  }
  readOriginalRunSelection(input: Parameters<Store['readOriginalRunSelection']>[0]) {
    return this.options.store.readOriginalRunSelection(input);
  }
  getSelectedContext(input: Parameters<Store['getSelectedContext']>[0]) {
    return this.options.store.getSelectedContext(input);
  }
  /** Trusted complete original compression proof; no activation or Model work. */
  getCompressionOrigin(input: Parameters<Store['getCompressionOrigin']>[0]) {
    return this.options.store.getCompressionOrigin(input);
  }
  selectContext(input: Parameters<Store['selectContext']>[0]) {
    if (this.closing) throw new AgentError('runtime_draining');
    return this.options.store.selectContext(input);
  }
  compressContext(input: {
    expectedStoreId: string;
    sessionId: string;
    subjectId: string;
    commandId: string;
    expectedContextSelectionId: string;
    focus?: string;
  }): Promise<CommandRecord> {
    return this.submitCommand({
      expectedStoreId: input.expectedStoreId,
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      commandId: input.commandId,
      request: {
        kind: 'context.compress',
        expectedContextSelectionId: input.expectedContextSelectionId,
        ...(input.focus === undefined ? {} : { focus: input.focus }),
      },
    });
  }
  resetCompressionContext(input: {
    expectedStoreId: string;
    sessionId: string;
    subjectId: string;
    commandId: string;
    expectedContextSelectionId: string;
    expectedCompressionId: string | null;
  }): Promise<CommandRecord> {
    return this.submitCommand({
      expectedStoreId: input.expectedStoreId,
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      commandId: input.commandId,
      request: {
        kind: 'context.compression.reset',
        expectedContextSelectionId: input.expectedContextSelectionId,
        expectedCompressionId: input.expectedCompressionId,
      },
    });
  }
  renameSession(input: Parameters<Store['renameSession']>[0]) {
    if (this.closing) throw new AgentError('runtime_draining');
    return this.options.store.renameSession(input);
  }
  async deleteSession(input: Parameters<Store['deleteSession']>[0]) {
    if (this.closing) throw new AgentError('runtime_draining');
    const result = await this.options.store.deleteSession(input);
    await this.observeOwnedCancellation();
    return result;
  }
  getMessageOrigin(input: Parameters<Store['getMessageOrigin']>[0]) {
    return this.options.store.getMessageOrigin(input);
  }
  async forkSession(input: PublicForkInput) {
    if (this.closing) throw new AgentError('runtime_draining');
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'expectedStoreId',
            'commandId',
            'subjectId',
            'sourceSessionId',
            'expectedContextSelectionId',
            'boundary',
            'newSessionId',
            'title',
          ].includes(key),
      )
    )
      throw new AgentError('invalid_fork');
    if (await this.options.store.getCommand(input.commandId))
      return this.options.store.forkSession(input);
    const namespacePlan = await prepareNamespaceFork(this.options.store, this.extensions, input, {
      readModelInput: (scope) => this.readModelInput(scope),
      readModelOutput: (scope) => this.readModelOutput(scope),
      readArtifact: (scope) => this.readArtifact(scope),
    });
    return this.options.store.forkSession({
      ...input,
      ...(namespacePlan ? { namespacePlan } : {}),
    });
  }
  async includeResult(input: Parameters<Store['includeResult']>[0]) {
    if (this.closing) throw new AgentError('runtime_draining');
    const result = await this.options.store.includeResult(input);
    if (result.command.status === 'accepted') this.schedule(input.sessionId);
    return result;
  }
  answerInteraction(input: Parameters<Store['answerInteraction']>[0]) {
    if (this.closing) throw new AgentError('runtime_draining');
    return this.options.store.answerInteraction(input);
  }
  getWorkspace(id: string) {
    return this.options.store.getWorkspace(id);
  }
  listWorkspaces(options?: Parameters<Store['listWorkspaces']>[0]) {
    return this.options.store.listWorkspaces(options);
  }
  createSession(input: Parameters<Store['createSession']>[0]) {
    return this.options.store.createSession(input);
  }
  listSessionDirectory(input: Parameters<Store['listSessionDirectory']>[0]) {
    return this.options.store.listSessionDirectory(input);
  }
  listWorkspaceDirectory(input: Parameters<Store['listWorkspaceDirectory']>[0]) {
    return this.options.store.listWorkspaceDirectory(input);
  }
  listSessions(options?: Parameters<Store['listSessions']>[0]) {
    return this.options.store.listSessions(options);
  }
  async getCommand(id: string) {
    const command = await this.options.store.getCommand(id);
    const dispatchFailure =
      command?.status === 'accepted' ? this.dispatchFailures.get(command.sessionId) : undefined;
    return command && dispatchFailure ? { ...command, dispatchFailure } : command;
  }
  getRun(id: string) {
    return this.options.store.getRun(id);
  }
  /** Trusted host observation of one actual Run namespace; does not confer execution permission. */
  async readRunExtensionRecord(input: {
    sessionId: string;
    runId: string;
    extensionId: string;
    key: string;
  }): Promise<import('./storage/types').ExtensionRecord | null> {
    const run = await this.options.store.getRun(input.runId);
    const metadata = await this.options.store.getMetadata();
    const configuration = run?.configuration as { extensions?: { id: string }[] } | undefined;
    if (
      !run ||
      run.sessionId !== input.sessionId ||
      run.originStoreId !== metadata.storeId ||
      !configuration?.extensions?.some((extension) => extension.id === input.extensionId) ||
      !input.key ||
      input.key.length > 256
    )
      throw new AgentError('run_extension_read_scope_denied');
    const record = await this.options.store.getExtensionRecord(input);
    if (record && (record.originStoreId !== metadata.storeId || record.forkProvenance))
      throw new AgentError('run_extension_read_scope_denied');
    return freeze(structuredClone(record));
  }
  getExecution(id: string) {
    return this.options.store.getExecution(id);
  }
  listExecutionOutput(input: Parameters<Store['listExecutionOutput']>[0]) {
    return this.options.store.listExecutionOutput(input);
  }
  listMessages(id: string, options?: Parameters<Store['listMessages']>[1]) {
    return this.options.store.listMessages(id, options);
  }
  getChanges(input: Parameters<Store['getChanges']>[0]) {
    return this.options.store.getChanges(input);
  }
  getView(id: string) {
    return this.options.store.getView(id);
  }
  getSession(id: string) {
    return this.options.store.getSession(id);
  }
  getExtensionCatalogue() {
    return this.extensionHost.catalogue();
  }
  queryExtension(input: Parameters<ExtensionHost['query']>[0]) {
    return this.extensionHost.query(input);
  }
  async recoverSession(input: Parameters<Store['recoverSession']>[0]) {
    if (this.closing) throw new AgentError('runtime_draining');
    // The public caller cannot supply the private full-output observations.
    const original = {
      expectedStoreId: input.expectedStoreId,
      commandId: input.commandId,
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      expectedOwnerGeneration: input.expectedOwnerGeneration,
      decision: input.decision,
    };
    if (await this.options.store.getCommand(original.commandId))
      return this.options.store.recoverSession(original);
    const histories = await this.options.store.readRecoveryToolHistory(original);
    const outputs = new Map<string, ModelOutputSnapshot>();
    for (const history of histories) {
      let snapshot = outputs.get(history.modelExecutionId);
      if (!snapshot) {
        snapshot = await this.readModelOutput({
          expectedStoreId: original.expectedStoreId,
          sessionId: history.sessionId,
          subjectId: original.subjectId,
          executionId: history.modelExecutionId,
        });
        outputs.set(history.modelExecutionId, snapshot);
      }
      const calls = snapshot.output.toolCalls.filter((call) => call.id === history.callId);
      if (
        !snapshot.output.complete ||
        snapshot.runId !== history.runId ||
        calls.length !== 1 ||
        calls[0]!.name !== history.definitionId ||
        (await semanticDigest(JSON.parse(calls[0]!.arguments) as Json)) !== history.inputDigest
      )
        throw new AgentError('recovery_tool_history_unverifiable');
    }
    if (this.closing) throw new AgentError('runtime_draining');
    return this.options.store.recoverSession({
      ...original,
      toolHistoryProofs: histories.map(({ executionId, bindingDigest }) => ({
        executionId,
        bindingDigest,
      })),
    });
  }
  private async prepareRunCheckpoint(
    state: import('./storage/types').RunResumeState,
    subjectId: string,
    signal: AbortSignal,
  ): Promise<RunExecutionCheckpoint> {
    const checkpoint = state.checkpoint;
    if (!['run.start', 'input.follow_up'].includes(state.originalCommand.kind))
      throw new AgentError('resume_checkpoint_unavailable');
    if (!checkpoint || checkpoint.initializationState === 'started')
      throw new AgentError('run_initialization_incomplete');
    const models = state.executions.filter(
      (execution) => execution.kind === 'model' && execution.runId === state.run.id,
    );
    const last = models.at(-1);
    const result: RunExecutionCheckpoint = {
      plannedTools: new Map(),
      sourceRequests: [],
      initializationState: checkpoint.initializationState,
    };
    if (!last) return result;
    const scope = {
      expectedStoreId: state.run.originStoreId,
      sessionId: state.run.sessionId,
      subjectId,
    };
    const sourceBody = bodyReference((last.decisionSource as Record<string, Json>).sourceBody);
    if (
      sourceBody &&
      (sourceBody.reference.storeId !== state.run.originStoreId ||
        sourceBody.reference.sessionId !== state.run.sessionId ||
        sourceBody.reference.subjectId !== subjectId ||
        sourceBody.reference.scope.kind !== 'session' ||
        sourceBody.reference.scope.id !== state.run.sessionId)
    )
      throw new AgentError('model_source_invalid');
    const source = sourceBody
      ? jsonBody(await this.readBody(sourceBody.reference, signal, state.run.originStoreId))
      : structuredClone(last.decisionSource);
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      source.compressionId ||
      source.kind !== 'model_request' ||
      source.requestId !== last.id
    )
      throw new AgentError('resume_checkpoint_unavailable');
    result.modelSource = source;
    const request = (await this.readModelInput({ ...scope, executionId: last.id, signal })).request;
    result.modelRequest = request;
    if (last.status === 'planned') {
      result.plannedModel = last;
      result.loop = { kind: 'model', request, stepId: last.stepId };
      return result;
    }
    if (last.status !== 'succeeded') throw new AgentError('resume_checkpoint_unavailable');
    const output = (await this.readModelOutput({ ...scope, executionId: last.id, signal })).output;
    if (!output.complete) throw new AgentError('resume_checkpoint_unavailable');
    const tools = new Map<string, ExecutionRecord>();
    const settled: { callId: string; result: import('./extensions').ToolResult }[] = [];
    let incomplete = false;
    const callIds = new Set<string>();
    for (const call of output.toolCalls) {
      if (callIds.has(call.id)) throw new AgentError('resume_checkpoint_unavailable');
      callIds.add(call.id);
      const candidates = state.executions.filter(
        (execution) =>
          execution.kind === 'tool' &&
          execution.runId === state.run.id &&
          execution.stepId === last.stepId &&
          execution.callId === call.id,
      );
      if (candidates.length > 1) throw new AgentError('resume_checkpoint_unavailable');
      const existing = candidates[0];
      if (!existing) {
        incomplete = true;
        continue;
      }
      const decision = existing.decisionSource as Record<string, Json>;
      let originalInput: Json = null;
      try {
        originalInput = JSON.parse(call.arguments) as Json;
      } catch {
        /* Invalid original calls record null input. */
      }
      if (existing.definitionId !== call.name || decision.modelExecutionId !== last.id)
        throw new AgentError('resume_checkpoint_unavailable');
      if (canonicalJson(originalInput) !== canonicalJson(existing.input))
        throw new AgentError('resume_checkpoint_unavailable');
      if (existing.status === 'planned') {
        incomplete = true;
        tools.set(call.id, existing);
      } else if (['succeeded', 'failed', 'cancelled'].includes(existing.status) && !incomplete)
        settled.push({
          callId: call.id,
          result: existing.result as unknown as import('./extensions').ToolResult,
        });
      else throw new AgentError('resume_checkpoint_unavailable');
    }
    const requests: SourceRequest[] = [];
    for (const model of models.slice(0, -1)) {
      if (model.status !== 'succeeded') throw new AgentError('resume_checkpoint_unavailable');
      const prior = (await this.readModelOutput({ ...scope, executionId: model.id, signal }))
        .output;
      if (!prior.complete) throw new AgentError('resume_checkpoint_unavailable');
      for (const call of prior.toolCalls) {
        let input: Json = null;
        try {
          input = JSON.parse(call.arguments) as Json;
        } catch {
          /* Original invalid call remains a known result. */
        }
        requests.push({
          sessionId: state.run.sessionId,
          workspaceId: state.session.workspaceId,
          definitionId: call.name,
          input,
        });
      }
    }
    result.sourceRequests = requests;
    result.plannedTools = tools;
    result.loop = {
      kind: 'response',
      stepId: last.stepId,
      response: {
        content: output.content,
        reasoning: output.reasoning,
        toolCalls: output.toolCalls,
        usage: {},
        executionId: last.id,
      },
      settledCalls: settled,
    };
    return result;
  }
  async resumeRun(input: import('./storage/types').RunResumeInput): Promise<CommandRecord> {
    input = freeze(structuredClone(input));
    if (this.closing) throw new AgentError('runtime_draining');
    const state = await this.options.store.verifyRunResume(input);
    if (state.command) return state.command;
    if (this.closing) throw new AgentError('runtime_draining');
    if (this.tasks.has(input.sessionId)) throw new AgentError('run_resume_busy');
    const controller = new AbortController();
    this.runResumeControllers.set(input.commandId, controller);
    this.watchControls();
    let complete!: (command: CommandRecord) => void, fail!: (error: unknown) => void;
    const ready = new Promise<CommandRecord>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const task = (async () => {
      let lease: import('./storage/types').RunResumeLease | null = null;
      let owner: OwnerRef | undefined;
      let dispose: (() => Promise<void>) | undefined;
      let transferred = false;
      let cleanupFailed = false;
      try {
        const prepared = await this.prepareRunCheckpoint(state, input.subjectId, controller.signal);
        const checkpoint = {
          ...state.checkpoint!,
          boundary:
            prepared.loop?.kind === 'response'
              ? prepared.loop.response.toolCalls.length
                ? ('tool_calls' as const)
                : ('completion' as const)
              : ('before_model_dispatch' as const),
        };
        controller.signal.throwIfAborted();
        const begun = await this.options.store.beginRunResume({
          ...input,
          instanceId: this.instanceId,
          checkpoint,
        });
        if (!begun.lease) {
          complete(begun.command);
          return;
        }
        lease = begun.lease;
        const workspace = await this.options.store.getWorkspace(state.session.workspaceId);
        if (!workspace) throw new AgentError('workspace_not_found');
        let resolved: RunConfiguration | undefined;
        if (this.options.resolveRecoveryRunConfiguration) {
          resolved = await this.options.resolveRecoveryRunConfiguration({
            command: freeze(structuredClone(state.originalCommand)),
            run: freeze(structuredClone(state.run)),
            session: freeze(structuredClone(state.session)),
            workspace: freeze(structuredClone(workspace)),
            signal: controller.signal,
          });
          let attempted = false;
          dispose = async () => {
            if (!attempted) {
              attempted = true;
              await resolved!.dispose?.();
            }
          };
        } else if (this.options.resolveRunConfiguration)
          throw new AgentError('run_recovery_binding_unavailable');
        controller.signal.throwIfAborted();
        const model = resolved?.model ?? this.options.model;
        if (!model) throw new AgentError('run_recovery_binding_unavailable');
        const modelId =
          resolved?.modelId ??
          (state.originalCommand.request as { modelId?: string }).modelId ??
          this.options.modelId ??
          'fixed';
        const catalogue = this.runDefinitions(resolved?.extensions, resolved?.toolIds);
        const reviewer = sealReview(resolved?.authorizationReview ?? this.defaultReviewer);
        const snapshot = resolved?.snapshot ?? null;
        const configuration = this.configurationSnapshot(
          modelId,
          {
            ...(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
              ? snapshot
              : { value: snapshot }),
            authorizationReview: reviewer
              ? { id: reviewer.id, version: reviewer.version, modelId: reviewer.modelId }
              : null,
          },
          catalogue.definitions,
          resolved?.maxConcurrentSubagents,
          catalogue.extensionIds,
          catalogue.extensions,
        );
        if (canonicalJson(configuration) !== canonicalJson(state.run.configuration))
          throw new AgentError('run_configuration_mismatch');
        const committed = await this.options.store.commitRunResume({
          expectedStoreId: input.expectedStoreId,
          lease,
          expectedConfiguration: configuration,
          checkpoint,
        });
        owner = committed.owner;
        lease = null;
        complete(committed.command);
        transferred = true;
        await this.executeRun(
          committed.originalCommand,
          owner,
          committed.run,
          {
            model,
            modelId,
            definitions: catalogue.definitions,
            jobs: catalogue.jobs,
            extensions: catalogue.extensions,
            sources: sealSources(resolved?.sources),
            permissions: resolved?.permissions,
            conditions: resolved?.conditions,
            initializeRequirements:
              resolved?.initializeRequirements ?? this.options.initializeRunRequirements,
            authorizationReview: reviewer,
            readStepCapabilities: resolved?.readStepCapabilities,
            afterTurn: resolved?.afterTurn ?? this.options.afterTurn,
            compressor: sealCompressor(resolved?.compressor ?? this.options.compressor),
            dispose,
          },
          controller,
          prepared,
        );
      } catch (error) {
        fail(error);
        if (transferred) this.stopDispatchPolling(input.sessionId, error);
      } finally {
        try {
          if (!transferred) await dispose?.();
        } catch (error) {
          cleanupFailed = true;
          this.runResumeCleanupFailed = true;
          this.stopDispatchPolling(input.sessionId, error);
        }
        this.runResumeControllers.delete(input.commandId);
        if (lease && !cleanupFailed) {
          try {
            await this.options.store.releaseRunResumeLease(lease);
          } catch (error) {
            this.runResumeCleanupFailed = true;
            this.stopDispatchPolling(input.sessionId, error);
          }
        }
        if (owner && !this.runResumeCleanupFailed)
          await this.options.store.releaseSessionOwner(owner).catch((error) => {
            this.runResumeCleanupFailed = true;
            this.stopDispatchPolling(input.sessionId, error);
          });
      }
    })().finally(() => {
      this.tasks.delete(input.sessionId);
      if (!this.runResumeCleanupFailed && this.wakeups.delete(input.sessionId))
        this.schedule(input.sessionId);
    });
    this.tasks.set(input.sessionId, task);
    void task.catch((error) => this.stopDispatchPolling(input.sessionId, error));
    return ready;
  }
  async reconcileJob(input: {
    expectedStoreId: string;
    commandId: string;
    subjectId: string;
    sessionId: string;
    executionId: string;
    expectedResultRevision: string;
  }): Promise<CommandRecord> {
    input = freeze(structuredClone(input));
    if (this.closing) throw new AgentError('runtime_draining');
    const prior = await this.options.store.getJobReconciliationReceipt(input);
    if (prior) return prior;
    if (this.closing) throw new AgentError('runtime_draining');
    if (this.tasks.has(input.sessionId)) throw new AgentError('job_reconciliation_busy');
    const controller = new AbortController();
    this.jobReconcileControllers.set(input.commandId, controller);
    this.watchControls();
    const task = (async () => {
      let lease: import('./storage/types').JobRecoveryLease | null = null;
      let dispose: (() => Promise<void>) | undefined;
      let cleanupFailed = false;
      try {
        const execution = await this.options.store.getExecution(input.executionId);
        const session = execution && (await this.options.store.getSession(execution.sessionId));
        const workspace = session && (await this.options.store.getWorkspace(session.workspaceId));
        if (!execution || !session || !workspace || !execution.recoveryManifest)
          throw new AgentError('job_reconciliation_unavailable');
        const manifest = freeze(structuredClone(execution.recoveryManifest));
        const origin = await this.options.store.getCommand(execution.originCommandId);
        const originalRequest = origin?.request as Record<string, Json> | undefined;
        if (
          origin?.kind !== 'operation.job' ||
          origin.sessionId !== execution.sessionId ||
          origin.originStoreId !== input.expectedStoreId ||
          originalRequest?.kind !== 'operation.job' ||
          originalRequest.definitionId !== execution.definitionId ||
          originalRequest.definitionVersion !== execution.definitionVersion ||
          originalRequest.extensionId !== (manifest as { extensionId?: string }).extensionId ||
          typeof originalRequest.operationKey !== 'string' ||
          !originalRequest.operationKey ||
          originalRequest.operationKey.length > 256 ||
          originalRequest.input === undefined ||
          canonicalJson(originalRequest.input) !== canonicalJson(execution.input)
        )
          throw new AgentError('operation_unverifiable');
        const authorize = async () => {
          controller.signal.throwIfAborted();
          const decision = await this.options.authorizeJobReconcile?.({
            command: input,
            execution: freeze(structuredClone(execution)),
            manifest,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (!decision?.allowed || !decision.revision) throw new AgentError('permission_denied');
          return freeze({
            revision: decision.revision,
            ...(decision.controlReads
              ? { controlReads: structuredClone(decision.controlReads) }
              : {}),
          });
        };
        await authorize();
        const begun = await this.options.store.beginJobReconciliation({
          ...input,
          instanceId: this.instanceId,
        });
        if (!begun.lease) return begun.command;
        lease = begun.lease;
        let extension: Extension | undefined;
        if (this.options.resolveRecoveryJobConfiguration) {
          const restored = await this.options.resolveRecoveryJobConfiguration({
            execution: freeze(structuredClone(begun.execution)),
            session: freeze(structuredClone(session)),
            workspace: freeze(structuredClone(workspace)),
            signal: controller.signal,
          });
          let attempted = false;
          dispose = async () => {
            if (attempted) return;
            attempted = true;
            await restored.dispose?.();
          };
          extension = sealExtension(restored.extension);
        } else {
          extension = this.extensions.find(
            (candidate) => candidate.id === (manifest as { extensionId?: string }).extensionId,
          );
        }
        controller.signal.throwIfAborted();
        const definition = extension?.jobs?.find(
          (candidate) => candidate.id === begun.execution.definitionId,
        );
        const rebuilt =
          extension && definition?.recovery && definition.reconcile
            ? {
                extensionId: extension.id,
                extensionVersion: extension.version,
                adapterId: definition.id,
                adapterVersion: definition.version,
                inputSchema: definition.inputSchema,
                resources: (definition.resources ?? null) as Json,
                recovery: definition.recovery,
              }
            : null;
        const authorization = await authorize();
        await this.options.store.markJobReconciliationDispatch({
          expectedStoreId: input.expectedStoreId,
          lease,
          authorization,
          expectedRecoveryManifest: manifest,
        });
        let receipt: import('./storage/types').JobReconciliationReceipt = {
          executionId: execution.id,
          resultRevision: execution.resultRevision,
          outcome: 'unresolved',
          supervision: 'unknown',
          result: null,
          evidence: null,
          reason: 'job_recovery_definition_unavailable',
          evidenceSource: 'adapter_reconcile',
        };
        if (rebuilt && canonicalJson(rebuilt) === canonicalJson(manifest)) {
          try {
            controller.signal.throwIfAborted();
            const observed = await definition!.reconcile!(
              freeze(structuredClone(begun.execution.reference)),
              Object.freeze({
                sessionId: begun.execution.sessionId,
                executionId: begun.execution.id,
                originalStoreId: begun.execution.originStoreId,
                originalResultRevision: begun.execution.resultRevision,
                originalInput: freeze(structuredClone(begun.execution.input)),
                originalCommandId: origin.id,
                operationKey: originalRequest.operationKey,
                definitionId: begun.execution.definitionId,
                definitionVersion: begun.execution.definitionVersion,
                signal: controller.signal,
              }),
            );
            controller.signal.throwIfAborted();
            const value = freeze(structuredClone(observed));
            if (
              !value ||
              typeof value !== 'object' ||
              Buffer.byteLength(canonicalJson(value as Json)) > 1048576
            )
              throw new AgentError('job_reconciliation_result_invalid');
            if (value.status === 'unavailable') {
              if (
                Object.keys(value).some((key) => !['status', 'reason'].includes(key)) ||
                typeof value.reason !== 'string' ||
                !value.reason ||
                value.reason.length > 4096
              )
                throw new AgentError('job_reconciliation_result_invalid');
              receipt.reason = value.reason;
            } else if (value.status === 'observed') {
              if (
                Object.keys(value).some(
                  (key) => !['status', 'result', 'supervision', 'evidence'].includes(key),
                ) ||
                !['ended', 'running', 'unknown'].includes(value.supervision) ||
                value.evidence === undefined
              )
                throw new AgentError('job_reconciliation_result_invalid');
              const result = value.result;
              if (
                result !== null &&
                (!result ||
                  typeof result !== 'object' ||
                  Array.isArray(result) ||
                  !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
                    result.outcome,
                  ) ||
                  typeof result.content !== 'string' ||
                  (result.artifactRefs !== undefined && !Array.isArray(result.artifactRefs)) ||
                  (result.modelContent !== undefined &&
                    (result.modelContent?.kind !== 'artifact' ||
                      result.modelContent.encoding !== 'utf-8' ||
                      !result.modelContent.reference ||
                      Object.keys(result.modelContent).some(
                        (key) => !['kind', 'reference', 'encoding'].includes(key),
                      ))) ||
                  Object.keys(result).some(
                    (key) =>
                      !['outcome', 'content', 'details', 'artifactRefs', 'modelContent'].includes(
                        key,
                      ),
                  ))
              )
                throw new AgentError('job_reconciliation_result_invalid');
              if (result?.modelContent || result?.artifactRefs?.length) {
                const references = [
                  ...(result.artifactRefs ?? []),
                  ...(result.modelContent ? [result.modelContent.reference] : []),
                ];
                if (references.length > 64) throw new AgentError('artifact_references_too_large');
                for (const ref of references) {
                  if (!ref.scope) throw new AgentError('artifact_scope_required');
                  const original = await this.options.store.getArtifactReference({
                    expectedStoreId: input.expectedStoreId,
                    sessionId: execution.sessionId,
                    subjectId: input.subjectId,
                    refId: ref.id,
                    scope: ref.scope,
                  });
                  if (
                    !original ||
                    original.mediaType !== ref.mediaType ||
                    original.size !== ref.size
                  )
                    throw new AgentError('artifact_reference_invalid');
                  if (ref === result.modelContent?.reference) {
                    if (
                      result.modelContent.kind !== 'artifact' ||
                      result.modelContent.encoding !== 'utf-8'
                    )
                      throw new AgentError('model_content_invalid');
                    await this.readBody(original, controller.signal, input.expectedStoreId);
                  }
                }
              }
              receipt = {
                ...receipt,
                supervision: value.supervision,
                result: result as Json,
                evidence: value.evidence,
                outcome:
                  value.supervision === 'ended' && result && result.outcome !== 'outcome_unknown'
                    ? 'verified'
                    : 'unresolved',
                reason:
                  value.supervision === 'ended' && result && result.outcome !== 'outcome_unknown'
                    ? null
                    : 'job_reconciliation_unconfirmed',
              };
            } else throw new AgentError('job_reconciliation_result_invalid');
          } catch (error) {
            receipt.reason = error instanceof AgentError ? error.code : 'job_reconciliation_failed';
          }
        }
        controller.signal.throwIfAborted();
        return await this.options.store.finishJobReconciliation({
          expectedStoreId: input.expectedStoreId,
          lease,
          authorization,
          receipt,
        });
      } finally {
        try {
          await dispose?.();
        } catch (error) {
          cleanupFailed = true;
          this.jobReconcileCleanupFailed = true;
          this.stopDispatchPolling(input.sessionId, error);
        } finally {
          this.jobReconcileControllers.delete(input.commandId);
          if (lease && !cleanupFailed) {
            try {
              await this.options.store.releaseJobRecoveryLease(lease);
            } catch (error) {
              this.jobReconcileCleanupFailed = true;
              this.stopDispatchPolling(input.sessionId, error);
            }
          }
        }
      }
    })().finally(() => this.tasks.delete(input.sessionId));
    const owned = task.then(
      () => {},
      () => {},
    );
    this.tasks.set(input.sessionId, owned);
    return task;
  }
  async resumeJobReport(input: {
    expectedStoreId: string;
    commandId: string;
    subjectId: string;
    sessionId: string;
    reportCommandId: string;
  }): Promise<CommandRecord> {
    input = freeze(structuredClone(input));
    if (this.closing) throw new AgentError('runtime_draining');
    if ((await this.options.store.getMetadata()).storeId !== input.expectedStoreId)
      throw new AgentError('store_identity_mismatch');
    const report = await this.options.store.getCommand(input.reportCommandId);
    if (
      report?.kind !== 'job.report' ||
      report.sessionId !== input.sessionId ||
      report.subjectId !== input.subjectId ||
      report.originStoreId !== input.expectedStoreId
    )
      throw new AgentError('report_recovery_unavailable');
    const parent = await this.options.store.getRun(
      (report.request as { parentRunId: string }).parentRunId,
    );
    if (
      !parent ||
      parent.sessionId !== input.sessionId ||
      parent.originStoreId !== input.expectedStoreId
    )
      throw new AgentError('report_recovery_unavailable');
    await this.options.store.verifyJobReportRecovery({
      expectedStoreId: input.expectedStoreId,
      sessionId: input.sessionId,
      reportCommandId: report.id,
      recovery: {
        commandId: input.commandId,
        subjectId: input.subjectId,
        expectedConfiguration: parent.configuration,
      },
    });
    const previous = await this.options.store.getCommand(input.commandId);
    if (previous) {
      if (
        previous.kind !== 'job.report.resume' ||
        previous.sessionId !== input.sessionId ||
        previous.subjectId !== input.subjectId ||
        previous.originStoreId !== input.expectedStoreId ||
        canonicalJson(previous.request) !==
          canonicalJson({
            kind: 'job.report.resume',
            originalReportCommandId: report.id,
            expectedConfiguration: parent.configuration,
          })
      )
        throw new AgentError('command_conflict');
      return previous;
    }
    if (this.tasks.has(input.sessionId)) throw new AgentError('report_recovery_busy');
    const controller = new AbortController();
    this.reportRecoveryPreparations.add(controller);
    let complete!: (value: CommandRecord) => void;
    let fail!: (error: unknown) => void;
    const ready = new Promise<CommandRecord>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const task = (async () => {
      let owner: OwnerRef | null = null;
      let bindingTransferred = false;
      let dispose: (() => Promise<void>) | undefined;
      try {
        const session = await this.options.store.getSession(input.sessionId);
        if (session && (session.parentSessionId !== null || session.rootSessionId !== session.id))
          throw new AgentError('group_root_required');
        if (
          !session ||
          [...this.active.values()].some(
            (work) => work.owner.sessionId === session.rootSessionId,
          ) ||
          (session.rootSessionId !== session.id && this.tasks.has(session.rootSessionId))
        )
          throw new AgentError('report_recovery_busy');
        owner = await this.options.store.acquireSessionOwner(
          session.rootSessionId,
          this.instanceId,
        );
        if (!owner) throw new AgentError('owner_busy');
        const workspace = await this.options.store.getWorkspace(session.workspaceId);
        const origin = await this.options.store.getCommand(parent.originCommandId);
        if (!workspace || !origin) throw new AgentError('report_recovery_unavailable');
        controller.signal.throwIfAborted();
        let model = this.options.model,
          modelId =
            (origin.request as { modelId?: string }).modelId ?? this.options.modelId ?? 'fixed';
        let catalogue = this.runDefinitions();
        let snapshot: Json = null;
        let limit: number | undefined;
        let binding: Partial<RunBinding> = {
          afterTurn: this.options.afterTurn,
          compressor: sealCompressor(this.options.compressor),
          authorizationReview: this.defaultReviewer,
          initializeRequirements: this.options.initializeRunRequirements,
        };
        if (this.options.resolveRecoveryRunConfiguration) {
          const resolved = await this.options.resolveRecoveryRunConfiguration({
            command: freeze(structuredClone(origin)),
            run: freeze(structuredClone(parent)),
            session: freeze(structuredClone(session)),
            workspace: freeze(structuredClone(workspace)),
            signal: controller.signal,
          });
          let disposalAttempted = false;
          dispose = async () => {
            if (!disposalAttempted) {
              disposalAttempted = true;
              await resolved.dispose?.();
            }
          };
          controller.signal.throwIfAborted();
          model = resolved.model;
          modelId = resolved.modelId;
          limit = resolved.maxConcurrentSubagents;
          catalogue = this.runDefinitions(resolved.extensions, resolved.toolIds);
          snapshot = structuredClone(resolved.snapshot);
          binding = {
            ...binding,
            sources: sealSources(resolved.sources),
            permissions: resolved.permissions,
            conditions: resolved.conditions,
            initializeRequirements:
              resolved.initializeRequirements ?? binding.initializeRequirements,
            readStepCapabilities: resolved.readStepCapabilities,
            afterTurn: resolved.afterTurn ?? binding.afterTurn,
            compressor: sealCompressor(resolved.compressor ?? binding.compressor),
            authorizationReview: sealReview(resolved.authorizationReview ?? this.defaultReviewer),
          };
        } else if (this.options.resolveRunConfiguration) {
          throw new AgentError('report_recovery_binding_unavailable');
        }
        if (!model) throw new AgentError('report_recovery_binding_unavailable');
        const reviewer = binding.authorizationReview;
        const configuration = this.configurationSnapshot(
          modelId,
          {
            ...(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
              ? snapshot
              : { value: snapshot }),
            authorizationReview: reviewer
              ? { id: reviewer.id, version: reviewer.version, modelId: reviewer.modelId }
              : null,
          },
          catalogue.definitions,
          limit,
          catalogue.extensionIds,
          catalogue.extensions,
        );
        if (canonicalJson(configuration) !== canonicalJson(parent.configuration))
          throw new AgentError('report_configuration_mismatch');
        const carrier = await this.options.store.getExecution(
          (report.request as { executionId: string }).executionId,
        );
        const fact = carrier?.afterTurn as {
          sourceExecutionId: string;
          configuration: ChildConfiguration;
        } | null;
        const source = fact && (await this.options.store.getExecution(fact.sourceExecutionId));
        let authorization: import('./storage/types').AfterTurnAuthorization | null = null;
        if (fact && source && binding.afterTurn) {
          const decision = await binding.afterTurn.authorize({
            phase: 'apply',
            command: freeze(structuredClone(origin)),
            run: freeze(structuredClone(parent)),
            session: freeze(structuredClone(session)),
            execution: freeze(structuredClone(source)),
            configuration: freeze(structuredClone(fact.configuration)),
            signal: controller.signal,
          });
          if (decision.allowed)
            authorization = {
              revision: decision.revision,
              ...(decision.controlReads ? { controlReads: decision.controlReads } : {}),
            };
        }
        controller.signal.throwIfAborted();
        const applied = await this.options.store.applyJobReport({
          expectedStoreId: input.expectedStoreId,
          owner,
          commandId: report.id,
          authorization,
          recovery: {
            commandId: input.commandId,
            subjectId: input.subjectId,
            expectedConfiguration: configuration,
          },
        });
        const receipt = await this.options.store.getCommand(input.commandId);
        if (!receipt) throw new AgentError('report_recovery_receipt_missing');
        this.reportRecoveryPreparations.delete(controller);
        complete(receipt);
        if (applied.run && applied.started) {
          bindingTransferred = true;
          await this.executeRun(
            applied.command,
            owner,
            applied.run,
            {
              ...binding,
              model,
              modelId,
              definitions: catalogue.definitions,
              jobs: catalogue.jobs,
              extensions: catalogue.extensions,
              dispose,
            },
            controller,
          );
        }
      } catch (error) {
        fail(error);
      } finally {
        this.reportRecoveryPreparations.delete(controller);
        try {
          if (!bindingTransferred) await dispose?.();
        } catch (error) {
          // A failed release remains a local cleanup fact, never successful disposal.
          // Do not replay an arbitrary host disposer during shutdown.
          this.reportRecoveryCleanupFailed = true;
          this.stopDispatchPolling(input.sessionId, error);
        } finally {
          if (owner) await this.options.store.releaseSessionOwner(owner).catch(() => false);
        }
      }
    })().finally(() => {
      this.tasks.delete(input.sessionId);
      if (this.wakeups.delete(input.sessionId)) this.schedule(input.sessionId);
    });
    this.tasks.set(input.sessionId, task);
    // The original caller waits only for preparation and the atomic recovery receipt.
    // The owned task remains live through Model execution and binding disposal.
    void task.catch((error) => this.stopDispatchPolling(input.sessionId, error));
    return ready;
  }
  async submitCommand(input: AcceptCommandInput): Promise<CommandRecord> {
    if (this.closing) throw new AgentError('runtime_draining');
    if (
      ![
        'run.start',
        'extension.invoke',
        'input.steer',
        'input.follow_up',
        'context.compress',
        'context.compression.reset',
      ].includes(input.request.kind)
    )
      throw new AgentError('command_not_supported');
    if ((await this.options.store.getMetadata()).storeId !== input.expectedStoreId)
      throw new AgentError('store_identity_mismatch');
    const existing = await this.options.store.getCommand(input.commandId);
    if (!existing && !this.pendingSessions.has(input.sessionId) && this.pendingSessions.size >= 256)
      throw new AgentError('runtime_queue_full', 'runtime_queue_full', true);
    if (input.request.kind === 'extension.invoke' && !existing)
      this.extensionHost.validateAction(input.request);
    if (this.closing) throw new AgentError('runtime_draining');
    const command = await this.options.store.acceptCommand(input);
    // Acceptance may already be durable when sealing happens. It grants no local
    // execution ownership: a surviving legitimate owner may still advance it.
    if (this.closing) return command;
    if (command.status === 'accepted') {
      this.dispatchFailures.delete(command.sessionId);
      this.pendingSessions.add(command.sessionId);
      this.schedule(command.sessionId);
      this.watchControls();
    }
    return command;
  }
  private watchControls() {
    if (
      this.closing ||
      this.controlTimer ||
      this.controlTask ||
      (!this.active.size &&
        !this.jobReconcileControllers.size &&
        !this.runResumeControllers.size &&
        !this.pendingSessions.size &&
        !this.changeWaits.size)
    )
      return;
    this.controlTimer = setTimeout(() => {
      this.controlTimer = undefined;
      this.controlTask = this.pollControls().finally(() => {
        this.controlTask = undefined;
        this.watchControls();
      });
      void this.controlTask.catch(() => {});
    }, 25);
    this.controlTimer.unref();
  }
  private async pollControls() {
    await this.changeWaits.poll();
    await Promise.allSettled(
      [...this.active].map(async ([id, live]) => {
        const command = await this.options.store.getCommand(id);
        if (command?.cancelRequestedAt !== null && command?.cancelRequestedAt !== undefined)
          live.controller.abort(new AgentError('cancel_requested'));
      }),
    );
    await Promise.allSettled(
      [...this.activeExecutions].map(async ([id, live]) => {
        const execution = await this.options.store.getExecution(id);
        if (execution?.cancelRequestedAt !== null && execution?.cancelRequestedAt !== undefined)
          live.controller.abort(new AgentError('execution_cancel_requested'));
      }),
    );
    await Promise.allSettled(
      [...this.jobReconcileControllers, ...this.runResumeControllers].map(
        async ([id, controller]) => {
          const command = await this.options.store.getCommand(id);
          if (command?.cancelRequestedAt !== null && command?.cancelRequestedAt !== undefined)
            controller.abort(new AgentError('cancel_requested'));
        },
      ),
    );
    for (const sessionId of this.pendingSessions) {
      if (this.closing) return;
      if (this.tasks.has(sessionId) || (this.nextDispatchPoll.get(sessionId) ?? 0) > Date.now())
        continue;
      this.nextDispatchPoll.set(sessionId, Date.now() + 250);
      try {
        const pending = await this.options.store.listAcceptedCommands(sessionId, 1);
        if (pending.length) this.schedule(sessionId);
        else {
          this.pendingSessions.delete(sessionId);
          this.nextDispatchPoll.delete(sessionId);
        }
      } catch (error) {
        this.stopDispatchPolling(sessionId, error);
      }
    }
  }
  private schedule(sessionId: string) {
    if (this.closing) return;
    if (this.tasks.has(sessionId)) {
      this.wakeups.add(sessionId);
      return;
    }
    this.wakeups.delete(sessionId);
    this.nextDispatchPoll.set(sessionId, Date.now() + 250);
    const task = this.pump(sessionId)
      .catch((error) => {
        this.stopDispatchPolling(sessionId, error);
        this.wakeups.delete(sessionId);
      })
      .finally(() => {
        this.tasks.delete(sessionId);
        if (this.wakeups.delete(sessionId)) this.schedule(sessionId);
      });
    this.tasks.set(sessionId, task);
    // Local diagnostics explain an accepted command that cannot acquire a safe dispatch boundary.
    // They never change durable completion facts or automatically perform recovery.
  }
  private stopDispatchPolling(sessionId: string, error: unknown) {
    this.pendingSessions.delete(sessionId);
    this.nextDispatchPoll.delete(sessionId);
    if (!this.dispatchFailures.has(sessionId) && this.dispatchFailures.size >= 256)
      this.dispatchFailures.delete(this.dispatchFailures.keys().next().value!);
    const code =
      error instanceof AgentError && /^[a-zA-Z0-9_]+$/.test(error.code)
        ? error.code
        : 'dispatch_failed';
    this.dispatchFailures.set(sessionId, { code, instanceId: this.instanceId });
  }
  private async pump(sessionId: string): Promise<void> {
    const session = await this.options.store.getSession(sessionId);
    if (!session) throw new AgentError('session_not_found');
    const owner = await this.options.store.acquireSessionOwner(
      session.rootSessionId,
      this.instanceId,
    );
    if (!owner) return;
    try {
      while (!this.closing) {
        // Recovery query receipts never become ordinary model work, including accepted unknowns.
        const commands = (await this.options.store.listAcceptedCommands(sessionId, 32)).filter(
          (command) => command.kind !== 'job.reconcile',
        );
        for (const command of commands) {
          if (this.closing) break;
          if ((await this.options.store.getCommand(command.id))?.status !== 'accepted') continue;
          const dispatch = await this.options.store.inspectOwnerDispatch({
            expectedStoreId: command.originStoreId,
            owner,
            sessionId,
          });
          if (dispatch.hasUncommittedAction) throw new AgentError('session_recovery_required');
          if (command.kind === 'input.steer' || command.kind === 'result.include') {
            await this.options.store.rejectCommand({
              expectedStoreId: command.originStoreId,
              owner,
              commandId: command.id,
              reason: 'input_target_stopped',
            });
            continue;
          }
          if (command.kind === 'operation.tool') {
            await this.options.store.rejectCommand({
              expectedStoreId: command.originStoreId,
              owner,
              commandId: command.id,
              reason: 'operation_recovery_required',
              needsReview: true,
            });
            continue;
          }
          if (command.kind === 'job.report') {
            const parentRun = await this.options.store.getRun(
              (command.request as { parentRunId: string }).parentRunId,
            );
            if (parentRun?.isActive) {
              this.pendingSessions.add(sessionId);
              return;
            }
            await this.runJobReport(command, owner);
            continue;
          }
          if (command.kind === 'extension.invoke') {
            const controller = new AbortController();
            const release = this.trackLive(command, owner, controller);
            try {
              await this.extensionHost.run(command, owner, controller);
            } catch (error) {
              const current = await this.options.store.getCommand(command.id);
              if (current?.status === 'accepted' && current.cancelRequestedAt === null)
                await this.options.store.rejectCommand({
                  expectedStoreId: command.originStoreId,
                  owner,
                  commandId: command.id,
                  reason: error instanceof AgentError ? error.code : 'action_preparation_failed',
                });
            } finally {
              release();
            }
            continue;
          }
          if (
            !this.options.model &&
            !this.options.resolveRunConfiguration &&
            !Object.hasOwn(command.request as object, 'selectedSkills') &&
            !Object.hasOwn(command.request as object, 'extensionInputs')
          ) {
            await this.options.store.rejectCommand({
              expectedStoreId: command.originStoreId,
              owner,
              commandId: command.id,
              reason: 'model_unavailable',
            });
            continue;
          }
          await this.run(command, owner);
        }
        if (await this.options.store.releaseSessionOwner(owner)) return;
        if (!commands.length) {
          if (this.extensionHost.hasActiveOperations(owner.sessionId)) return;
          if (
            [...this.active.values()].some(
              (work) =>
                work.owner.sessionId === owner.sessionId &&
                work.owner.generation === owner.generation,
            )
          )
            return;
          // A new exact Session command may have been accepted after the empty list read,
          // causing the atomic release to retain this same owner. Do not classify that
          // normal intake window as recovery; persistent live/unknown work still fails closed.
          const dispatch = await this.options.store.inspectOwnerDispatch({
            expectedStoreId: (await this.options.store.getMetadata()).storeId,
            owner,
            sessionId,
          });
          if (!dispatch.hasUnsettledWork) {
            if (dispatch.hasPendingCommands) continue;
            // The newly accepted command may already have been precisely cancelled.
            // A different Session's accepted work keeps its own scheduling/authority.
            await this.options.store.releaseSessionOwner(owner);
            return;
          }
          throw new AgentError('session_recovery_required');
        }
      }
    } finally {
      await this.options.store.releaseSessionOwner(owner).catch(() => false);
    }
  }
  private async authorizeAfterTurn(
    scope: StandaloneScope,
    id: string,
    configuration: ChildConfiguration,
  ) {
    const execution = await this.options.store.getExecution(id);
    const run = execution?.runId ? await this.options.store.getRun(execution.runId) : null;
    const session = await this.options.store.getSession(scope.command.sessionId);
    const retained = run && this.runBindingLeases.get(run.id);
    const policy = retained?.binding.afterTurn;
    if (
      !execution ||
      !run ||
      !session ||
      !['run.start', 'input.follow_up', 'child.start'].includes(scope.command.kind) ||
      !policy ||
      execution.kind !== 'tool' ||
      execution.originCommandId !== scope.command.id ||
      execution.originStoreId !== scope.command.originStoreId
    )
      throw new AgentError('after_turn_not_authorized');
    const decision = await policy.authorize({
      phase: 'request',
      command: freeze(structuredClone(scope.command)),
      run: freeze(structuredClone(run)),
      session: freeze(structuredClone(session)),
      execution: freeze(structuredClone(execution)),
      configuration: freeze(structuredClone(configuration)),
      signal: scope.signal,
    });
    if (!decision.allowed) throw new AgentError('after_turn_not_authorized');
    return {
      revision: decision.revision,
      ...(decision.controlReads ? { controlReads: decision.controlReads } : {}),
    };
  }
  private async onJobSettled(scope: StandaloneScope, id: string) {
    const execution = await this.options.store.getExecution(id);
    const fact = execution?.afterTurn as { parentRunId?: string } | null;
    if (!execution || !fact?.parentRunId) return;
    const commandId = `report-${await semanticDigest([execution.originStoreId, id, execution.resultRevision])}`;
    const command = await this.options.store.getCommand(commandId);
    if (command?.status !== 'accepted' || this.closing) return;
    const retained = this.runBindingLeases.get(fact.parentRunId);
    if (!retained || this.reportBindings.has(commandId)) return;
    this.reportBindings.set(commandId, { binding: retained.binding, release: retained.retain() });
    this.schedule(scope.command.sessionId);
  }
  private async runJobReport(command: CommandRecord, owner: OwnerRef) {
    let retained = this.reportBindings.get(command.id);
    if (!retained) {
      // Terminal SQL can be visible before its observer transfers the exact parent lease.
      const parentRunId = (command.request as { parentRunId?: string }).parentRunId;
      const parent = parentRunId && this.runBindingLeases.get(parentRunId);
      if (parent) {
        retained = { binding: parent.binding, release: parent.retain() };
        this.reportBindings.set(command.id, retained);
      }
    }
    if (!retained) {
      await this.options.store.rejectCommand({
        expectedStoreId: command.originStoreId,
        owner,
        commandId: command.id,
        reason: 'report_recovery_required',
        needsReview: true,
      });
      return;
    }
    const controller = new AbortController();
    const release = this.trackLive(command, owner, controller);
    let deferred = false;
    try {
      const request = command.request as { executionId: string; parentRunId: string };
      const carrier = await this.options.store.getExecution(request.executionId);
      const fact = carrier?.afterTurn as {
        sourceExecutionId: string;
        configuration: ChildConfiguration;
      } | null;
      const execution = fact && (await this.options.store.getExecution(fact.sourceExecutionId));
      const run = await this.options.store.getRun(request.parentRunId);
      const session = await this.options.store.getSession(command.sessionId);
      const origin = execution && (await this.options.store.getCommand(execution.originCommandId));
      let authorization: import('./storage/types').AfterTurnAuthorization | null = null;
      if (
        fact &&
        execution &&
        run &&
        session &&
        origin &&
        retained.binding.afterTurn &&
        !this.closing
      ) {
        const decision = await retained.binding.afterTurn.authorize({
          phase: 'apply',
          command: freeze(structuredClone(origin)),
          run: freeze(structuredClone(run)),
          session: freeze(structuredClone(session)),
          execution: freeze(structuredClone(execution)),
          configuration: freeze(structuredClone(fact.configuration)),
          signal: controller.signal,
        });
        if (decision.allowed)
          authorization = {
            revision: decision.revision,
            ...(decision.controlReads ? { controlReads: decision.controlReads } : {}),
          };
      }
      const applied = await this.options.store.applyJobReport({
        expectedStoreId: command.originStoreId,
        owner,
        commandId: command.id,
        authorization,
      });
      if (applied.started && applied.run) {
        this.reportBindings.delete(command.id);
        await this.executeRun(
          applied.command,
          owner,
          applied.run,
          { ...retained.binding, dispose: retained.release },
          controller,
        );
        return;
      }
    } catch (error) {
      if (
        error instanceof AgentError &&
        ['report_parent_active', 'session_busy', 'execution_group_fenced'].includes(error.code)
      ) {
        deferred = true;
        this.pendingSessions.add(command.sessionId);
        return;
      }
      await this.options.store.rejectCommand({
        expectedStoreId: command.originStoreId,
        owner,
        commandId: command.id,
        reason: error instanceof AgentError ? error.code : 'report_preparation_failed',
        needsReview: true,
      });
    } finally {
      release();
      if (!deferred && this.reportBindings.delete(command.id)) await retained.release();
    }
  }
  private async run(command: CommandRecord, owner: OwnerRef): Promise<void> {
    let modelId =
      (command.request as { modelId?: string }).modelId ?? this.options.modelId ?? 'fixed';
    let model = this.options.model;
    let definitions = new Map(this.tools);
    let maxConcurrentSubagents: number | undefined;
    let bindings = this.runDefinitions();
    let sources: ContextSources | undefined;
    let authorizationReview = this.defaultReviewer;
    let permissions: Permissions | undefined;
    let conditions: NecessaryConditions | undefined;
    let initializeRequirements = this.options.initializeRunRequirements;
    let afterTurn = this.options.afterTurn;
    let compressor = sealCompressor(this.options.compressor);
    let readStepCapabilities: StepCapabilitiesReader | undefined;
    let dispose: (() => Promise<void>) | undefined;
    let run: RunRecord;
    try {
      let snapshot: Json = null;
      if (
        (command.kind === 'run.start' || command.kind === 'input.follow_up') &&
        Object.hasOwn(command.request as object, 'selectedSkills') &&
        !this.supportsSelectedSkills
      )
        throw new AgentError('selected_skills_unavailable');
      if (
        (command.kind === 'run.start' || command.kind === 'input.follow_up') &&
        Object.hasOwn(command.request as object, 'extensionInputs') &&
        !this.supportsExtensionInputs
      )
        throw new AgentError('extension_inputs_unavailable');
      if (this.options.resolveRunConfiguration) {
        const session = await this.options.store.getSession(command.sessionId);
        if (!session) throw new AgentError('session_not_found');
        const workspace = await this.options.store.getWorkspace(session.workspaceId);
        if (!workspace) throw new AgentError('workspace_not_found');
        const resolved = await this.options.resolveRunConfiguration({
          command: structuredClone(command),
          session,
          workspace,
        });
        model = resolved.model;
        modelId = resolved.modelId;
        maxConcurrentSubagents = resolved.maxConcurrentSubagents;
        dispose = resolved.dispose;
        sources = resolved.sources;
        permissions = resolved.permissions;
        authorizationReview = sealReview(resolved.authorizationReview ?? this.defaultReviewer);
        conditions = resolved.conditions;
        initializeRequirements = resolved.initializeRequirements ?? initializeRequirements;
        readStepCapabilities = resolved.readStepCapabilities;
        afterTurn = resolved.afterTurn ?? afterTurn;
        compressor = sealCompressor(resolved.compressor ?? compressor);
        snapshot = structuredClone(resolved.snapshot);
        bindings = this.runDefinitions(resolved.extensions, resolved.toolIds);
        definitions = bindings.definitions;
      }
      if (!model) throw new AgentError('model_unavailable');
      const configuration = this.configurationSnapshot(
        modelId,
        {
          ...(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
            ? snapshot
            : { value: snapshot }),
          authorizationReview: authorizationReview
            ? {
                id: authorizationReview.id,
                version: authorizationReview.version,
                modelId: authorizationReview.modelId,
              }
            : null,
        },
        definitions,
        maxConcurrentSubagents,
        bindings.extensionIds,
        bindings.extensions,
      );
      const write = {
        expectedStoreId: command.originStoreId,
        owner,
        commandId: command.id,
        configuration,
      };
      run =
        command.kind === 'input.follow_up'
          ? (await this.options.store.applyInput({ ...write, kind: 'follow_up' })).run
          : await this.options.store.startRun(write);
    } catch (error) {
      await dispose?.();
      if (error instanceof AgentError && error.code === 'command_cancelled') return;
      await this.options.store.rejectCommand({
        expectedStoreId: command.originStoreId,
        owner,
        commandId: command.id,
        reason: error instanceof AgentError ? error.code : 'run_start_failed',
      });
      return;
    }
    await this.executeRun(command, owner, run, {
      model,
      modelId,
      definitions,
      jobs: bindings.jobs,
      extensions: bindings.extensions,
      sources,
      permissions,
      conditions,
      initializeRequirements,
      authorizationReview,
      readStepCapabilities,
      afterTurn,
      compressor,
      dispose,
    });
  }
  private async executeRun(
    command: CommandRecord,
    owner: OwnerRef,
    run: RunRecord,
    binding: RunBinding,
    controller = new AbortController(),
    resumed?: RunExecutionCheckpoint,
  ): Promise<void> {
    const { model, modelId, definitions } = binding;
    let users = 1;
    let disposed = false;
    const releaseBinding = async () => {
      if (--users === 0) {
        disposed = true;
        await binding.dispose?.();
        this.runBindingLeases.delete(run.id);
      }
    };
    const retain = () => {
      if (disposed) throw new AgentError('run_configuration_disposed');
      users++;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await releaseBinding();
      };
    };
    this.runBindingLeases.set(run.id, { binding, retain });
    const release = this.trackLive(command, owner, controller, run.id);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let expiry: Promise<void> | undefined;
    const expire = () =>
      (expiry ??= (async () => {
        const root = await this.options.store.getSession(owner.sessionId);
        if (
          root?.ownerInstanceId === owner.instanceId &&
          root.ownerGeneration === owner.generation
        ) {
          await this.options.store.cancelWork({
            expectedStoreId: run.originStoreId,
            commandId: `deadline-${run.id}`,
            sessionId: run.sessionId,
            subjectId: command.subjectId,
            kind: 'run.cancel',
            runId: run.id,
          });
        }
        controller.abort(new AgentError('child_deadline_exceeded'));
      })());
    const armDeadline = () => {
      if (run.deadlineAt === null) return;
      deadlineTimer = setTimeout(
        () => {
          if (Date.now() < run.deadlineAt!) {
            armDeadline();
            return;
          }
          void expire().catch(() => controller.abort(new AgentError('child_deadline_exceeded')));
        },
        Math.max(0, run.deadlineAt - Date.now()),
      );
      deadlineTimer.unref();
    };
    armDeadline();
    try {
      const session = await this.options.store.getSession(run.sessionId);
      if (!session) throw new AgentError('session_not_found');
      const compressors = [
        binding.compressor,
        ...(binding.extensions ?? this.extensions).map((extension) => extension.compression),
      ].filter((value): value is ContextCompressor => Boolean(value));
      if (compressors.length > 1) throw new AgentError('compression_slot_conflict');
      const selectedCompressor = compressors[0];
      if (command.kind === 'context.compress' && !selectedCompressor)
        throw new AgentError('compression_unavailable');
      if (resumed?.initializationState !== 'completed') {
        await this.options.store.beginRunRequirementsInitialization({
          expectedStoreId: run.originStoreId,
          owner,
          runId: run.id,
        });
        controller.signal.throwIfAborted();
        const references =
          (await binding.initializeRequirements?.({
            command: freeze(structuredClone(command)),
            run: freeze(structuredClone(run)),
            session: freeze(structuredClone(session)),
            forExtension: async (extensionId) => {
              controller.signal.throwIfAborted();
              const extension = (binding.extensions ?? this.extensions).find(
                (candidate) => candidate.id === extensionId,
              );
              if (!extension) throw new AgentError('extension_not_available');
              return this.extensionHost.initializationContext({
                command,
                runId: run.id,
                owner,
                extension,
                signal: controller.signal,
              });
            },
          })) ?? [];
        controller.signal.throwIfAborted();
        run = await this.options.store.registerRunRequirements({
          expectedStoreId: run.originStoreId,
          owner,
          runId: run.id,
          requirements: [...references],
          initialize: true,
        });
      }
      let inputVersion = 0;
      let capturedInputVersion = 0;
      let inputTask: Promise<number> | undefined;
      const applySteer = () => {
        if (inputTask) return inputTask;
        inputTask = (async () => {
          let applied = 0;
          // One owner serializes safe checkpoints; the final dispatch/finish transaction closes races.
          for (let batch = 0; batch < 4; batch++) {
            const page = await this.options.store.listPendingInputs({
              expectedStoreId: run.originStoreId,
              sessionId: run.sessionId,
              kind: 'input.steer',
              targetRunId: run.id,
              limit: 50,
            });
            for (const input of page.commands) {
              try {
                await this.options.store.applyInput({
                  expectedStoreId: run.originStoreId,
                  owner,
                  commandId: input.id,
                  kind: input.kind === 'result.include' ? 'result_include' : 'steer',
                  runId: run.id,
                });
                inputVersion++;
                applied++;
              } catch (error) {
                if (
                  !(error instanceof AgentError) ||
                  ![
                    'input_cancelled',
                    'input_target_stopped',
                    'context_selection_changed',
                  ].includes(error.code)
                )
                  throw error;
                if ((await this.options.store.getCommand(input.id))?.status === 'accepted')
                  await this.options.store.rejectCommand({
                    expectedStoreId: run.originStoreId,
                    owner,
                    commandId: input.id,
                    reason: error.code,
                  });
              }
            }
            if (!page.nextAfterSeq) break;
          }
          return applied + (await applyMail());
        })().finally(() => {
          inputTask = undefined;
        });
        return inputTask;
      };
      let observedMailSeq = '0';
      const applyMail = async () => {
        let receivedAny = false;
        let receivedSeq = '0';
        let afterSeq = '0';
        let upperSeq: string | undefined;
        for (let batch = 0; batch < 4; batch++) {
          const page = await this.options.store.listAgentMessages({
            expectedStoreId: run.originStoreId,
            sessionId: run.sessionId,
            subjectId: command.subjectId,
            runId: run.id,
            pendingOnly: true,
            afterSeq,
            ...(upperSeq === undefined ? {} : { upperSeq }),
            limit: 50,
          });
          upperSeq ??= page.upperSeq;
          receivedSeq = page.receivedSeq;
          const pending = page.items.filter((mail) => mail.state === 'accepted');
          if (pending.length) {
            receivedAny = true;
            const received = await this.options.store.receiveAgentMessages({
              expectedStoreId: run.originStoreId,
              owner,
              runId: run.id,
              messageIds: pending.map((mail) => mail.id),
            });
            void received;
          }
          if (!page.nextAfterSeq) break;
          afterSeq = page.nextAfterSeq;
        }
        const observed = receivedAny
          ? await this.options.store.listAgentMessages({
              expectedStoreId: run.originStoreId,
              sessionId: run.sessionId,
              subjectId: command.subjectId,
              runId: run.id,
              limit: 1,
            })
          : { receivedSeq };
        if (observed.receivedSeq !== observedMailSeq) {
          observedMailSeq = observed.receivedSeq;
          inputVersion++;
          return 1;
        }
        return 0;
      };
      const checkpoint = async () => {
        await applySteer();
      };
      const scope = {
        run,
        owner,
        workspaceId: session.workspaceId,
        signal: controller.signal,
        checkpoint,
        bindings: {
          extensions: binding.extensions ?? this.extensions,
          tools: definitions,
          jobs: binding.jobs ?? this.runDefinitions().jobs,
          permissions: binding.permissions,
          authorizationReview: binding.authorizationReview,
          conditions: binding.conditions,
          retain,
        } as ScopedBindings,
      };
      let capabilityFingerprint: string | undefined;
      const readCapabilities = async () => {
        if (!binding.readStepCapabilities) return null;
        controller.signal.throwIfAborted();
        const value = await binding.readStepCapabilities({
          command: freeze(structuredClone(command)),
          run: freeze(structuredClone(run)),
          session: freeze(structuredClone(session)),
          signal: controller.signal,
        });
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some((key) => !['extensions', 'toolIds', 'snapshot'].includes(key)) ||
          value.snapshot === undefined
        )
          throw new AgentError('invalid_step_capabilities');
        const snapshot = freeze(structuredClone(value.snapshot));
        if (new TextEncoder().encode(canonicalJson(snapshot)).byteLength > 64 * 1024)
          throw new AgentError('step_capability_snapshot_too_large');
        const selected = this.runDefinitions(value.extensions, value.toolIds);
        const facts: Json = {
          snapshot,
          extensions: selected.extensions.map(({ id, version }) => ({ id, version })),
          tools: [...selected.definitions.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((tool) => ({
              id: tool.id,
              version: tool.version,
              extensionId: selected.extensionIds.get(tool.id)!,
              description: tool.description,
              inputSchema: tool.inputSchema,
              resources: (tool.resources ?? null) as Json,
            })),
          jobs: [...selected.jobs.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((job) => ({
              id: job.id,
              version: job.version,
              description: job.description,
              inputSchema: job.inputSchema,
              resources: (job.resources ?? null) as Json,
            })),
        };
        return { selected, snapshot, fingerprint: await semanticDigest(facts) };
      };
      const selectCapabilities = async () => {
        const current = await readCapabilities();
        if (!current) return;
        capabilityFingerprint = current.fingerprint;
        scope.bindings = {
          extensions: current.selected.extensions,
          tools: current.selected.definitions,
          jobs: current.selected.jobs,
          permissions: binding.permissions,
          authorizationReview: binding.authorizationReview,
          conditions: binding.conditions,
          capabilitySnapshot: current.snapshot,
          retain,
        };
      };
      const checkCapabilities = async (fingerprint: string | undefined) => {
        const current = await readCapabilities();
        if (current && current.fingerprint !== fingerprint)
          throw new AgentError('capability_refresh_required');
      };
      const configuredSources = binding.sources ?? this.options.sources;
      const sourceRequests = new Map<string, SourceRequest>();
      sourceRequests.set('model', {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        definitionId: modelId,
        input: { kind: 'model_request' },
      });
      let captured: ContextSource[] = [];
      let continuationSource: ContextSource | null = null;
      const capture = async (
        requests: Iterable<SourceRequest> = sourceRequests.values(),
        bindings = scope.bindings,
      ) => {
        const sources = new Map<string, ContextSource>();
        for (const request of requests) {
          const contributed = await this.extensionHost.contextSources({
            command,
            extensions: bindings.extensions,
            request,
          });
          const hostSources = (await configuredSources?.capture(request)) ?? [];
          if (!Array.isArray(hostSources) || hostSources.length > 256)
            throw new AgentError('context_source_budget_exceeded');
          for (const source of [...hostSources, ...contributed]) {
            assertContextSource(source);
            const previous = sources.get(source.id);
            if (previous && previous.digest !== source.digest)
              throw new AgentError('context_refresh_required');
            sources.set(source.id, source);
            if (sources.size > 256) throw new AgentError('context_source_budget_exceeded');
          }
        }
        if (continuationSource) {
          if (sources.has(continuationSource.id))
            throw new AgentError('context_source_namespace_collision');
          sources.set(continuationSource.id, continuationSource);
          if (sources.size > 256) throw new AgentError('context_source_budget_exceeded');
        }
        const result = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
        return result;
      };
      let lastAutomaticFailure: string | undefined;
      const compress = async (
        originalMessages: ModelMessage[],
        trigger: 'manual' | 'automatic',
      ) => {
        if (!selectedCompressor) return false;
        const focus =
          command.kind === 'context.compress'
            ? ((command.request as { focus?: string }).focus ?? null)
            : null;
        const input = {
          command: freeze(structuredClone(command)),
          run: freeze(structuredClone(run)),
          session: freeze(structuredClone(session)),
          messages: freeze(structuredClone(originalMessages)),
          sources: freeze(structuredClone(captured)),
          trigger,
          focus,
          signal: controller.signal,
        };
        const fingerprint =
          trigger === 'automatic'
            ? await semanticDigest({
                selection: session.contextSelectionId,
                compressor: { id: selectedCompressor.id, version: selectedCompressor.version },
                messages: originalMessages as unknown as Json,
              })
            : undefined;
        if (fingerprint && fingerprint === lastAutomaticFailure) return false;
        let stage: 'pure' | 'model' | 'store' = 'pure';
        let attemptedExecutionId: string | undefined;
        let providerFailure: unknown;
        try {
          if (
            trigger === 'automatic' &&
            (await selectedCompressor.shouldCompress?.(input)) !== true
          )
            return false;
          const prepared = await selectedCompressor.prepare(input);
          if (!prepared) {
            if (trigger === 'manual') throw new AgentError('compression_not_reducible');
            lastAutomaticFailure = fingerprint;
            return false;
          }
          if (
            typeof prepared.instructions !== 'string' ||
            !prepared.instructions.trim() ||
            Buffer.byteLength(canonicalJson(prepared.snapshot)) > 32768
          )
            throw new AgentError('compression_configuration_invalid');
          const requestId = crypto.randomUUID();
          stage = 'store';
          const pending = await this.options.store.beginCompression({
            expectedStoreId: run.originStoreId,
            owner,
            runId: run.id,
            executionId: requestId,
            expectedContextSelectionId: session.contextSelectionId,
            compressor: {
              id: selectedCompressor.id,
              version: selectedCompressor.version,
              snapshot: prepared.snapshot,
            },
            trigger,
          });
          attemptedExecutionId = requestId;
          stage = 'model';
          const originalModel = model!;
          const compressionModel: ModelAdapter = {
            ...(originalModel.describeRequest
              ? { describeRequest: originalModel.describeRequest.bind(originalModel) }
              : {}),
            async *stream(request, options) {
              try {
                yield* originalModel.stream(request, options);
              } catch (error) {
                providerFailure = error;
                throw error;
              }
            },
          };
          await defaultLoop({
            modelId,
            signal: controller.signal,
            getTools: () => [],
            getMessages: async () => [
              ...originalMessages,
              {
                role: 'user',
                content: prepared.instructions + (focus ? `\nFocus (user data): ${focus}` : ''),
                sourceIds: [pending.id],
              },
            ],
            executeTool: async () => {
              throw new AgentError('compression_summary_invalid');
            },
            executeModel: async (request, stepId) => {
              const response = await this.execution.model(
                { ...scope, compressionId: pending.id, decisionSources: captured, checkFreshness },
                compressionModel,
                { ...request, requestId },
                stepId,
              );
              if (!response.content.trim() && !response.toolCalls.length)
                throw new AgentError('compression_summary_invalid');
              stage = 'pure';
              if (
                !response.toolCalls.length &&
                selectedCompressor.validateSummary &&
                (await selectedCompressor.validateSummary({
                  ...input,
                  summary: response.content,
                })) !== true
              )
                throw new AgentError('compression_not_reducible');
              return response;
            },
          });
          stage = 'store';
          await checkFreshness();
          await this.options.store.commitCompression({
            expectedStoreId: run.originStoreId,
            owner,
            runId: run.id,
            compressionId: pending.id,
            ...(trigger === 'manual'
              ? { requirements: await this.execution.requirements(scope, 'completion') }
              : {}),
          });
          lastAutomaticFailure = undefined;
          return true;
        } catch (error) {
          if (trigger === 'manual') throw error;
          controller.signal.throwIfAborted();
          const safeCode =
            error instanceof AgentError &&
            [
              'compression_not_reducible',
              'compression_summary_invalid',
              'compression_configuration_invalid',
              'compression_no_new_messages',
              'context_refresh_required',
              'capability_refresh_required',
              'input_pending',
              'superseded_by_user_input',
              'permission_denied',
              'model_response_incomplete',
              'model_event_after_finish',
              'duplicate_tool_call_id',
            ].includes(error.code);
          if (
            (error instanceof AgentError && !safeCode) ||
            (stage !== 'pure' && providerFailure !== error && !safeCode)
          )
            throw error;
          if (attemptedExecutionId) {
            const actual = await this.options.store.getExecution(attemptedExecutionId);
            if (
              !actual ||
              actual.originStoreId !== run.originStoreId ||
              actual.sessionId !== run.sessionId ||
              actual.runId !== run.id ||
              actual.kind !== 'model' ||
              actual.ownerGeneration !== owner.generation ||
              !['succeeded', 'failed'].includes(actual.status) ||
              actual.cancelRequestedAt !== null ||
              (actual.decisionSource as { compressionId?: string }).compressionId !==
                `compression-${attemptedExecutionId}`
            )
              throw error;
          }
          lastAutomaticFailure = fingerprint;
          return false;
        }
      };
      const messages = async () => {
        await applySteer();
        await this.consumeJobResults(run, owner, controller.signal);
        await selectCapabilities();
        capturedInputVersion = inputVersion;
        captured = await capture();
        const assembled: ModelMessage[] = [
          ...captured.map((source) => ({
            role: source.role ?? ('system' as const),
            content: source.content,
            sourceIds: [source.id],
          })),
          ...(await this.modelMessages(
            run.sessionId,
            run.originStoreId,
            controller.signal,
            command.subjectId,
          )),
        ];
        if (
          !['context.compress', 'context.compression.reset'].includes(command.kind) &&
          (await compress(assembled, 'automatic'))
        )
          return [
            ...captured.map((source) => ({
              role: source.role ?? ('system' as const),
              content: source.content,
              sourceIds: [source.id],
            })),
            ...(await this.modelMessages(
              run.sessionId,
              run.originStoreId,
              controller.signal,
              command.subjectId,
            )),
          ];
        return assembled;
      };
      const checkFreshness = async () => {
        if (inputVersion !== capturedInputVersion) throw new AgentError('superseded_by_user_input');
        await checkCapabilities(capabilityFingerprint);
        if (
          (await semanticDigest(JSON.parse(JSON.stringify(await capture())) as Json)) !==
          (await semanticDigest(JSON.parse(JSON.stringify(captured)) as Json))
        )
          throw new AgentError('context_refresh_required');
      };
      const modelTools = () =>
        [...scope.bindings.tools.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((tool) => ({
            id: tool.id,
            definitionVersion: tool.version,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }));
      const loopContext: LoopContext = {
        checkpoint: resumed?.loop,
        modelId,
        signal: controller.signal,
        getMessages: messages,
        getTools: modelTools,
        restoreToolCall: async (call) => {
          if (
            !configuredSources &&
            !scope.bindings.extensions.some((extension) => extension.context)
          )
            return;
          let input: Json = null;
          try {
            input = JSON.parse(call.arguments) as Json;
          } catch {
            /* Known invalid original input. */
          }
          sourceRequests.set(`${call.name}:${await semanticDigest(input)}`, {
            sessionId: session.id,
            workspaceId: session.workspaceId,
            definitionId: call.name,
            input,
          });
        },
        executeModel: async (request, stepId) => {
          if (resumed?.plannedModel?.id === request.requestId)
            return this.execution.model(
              { ...scope, decisionSources: captured, checkFreshness },
              model!,
              request,
              stepId,
              resumed.plannedModel,
            );
          let current = request;
          let attempt = 0;
          while (true) {
            try {
              return await this.execution.model(
                { ...scope, decisionSources: captured, checkFreshness },
                model!,
                current,
                attempt === 0 ? stepId : `${stepId}:refresh:${attempt}`,
              );
            } catch (error) {
              if (
                !(error instanceof AgentError) ||
                ![
                  'context_refresh_required',
                  'capability_refresh_required',
                  'input_pending',
                  'superseded_by_user_input',
                ].includes(error.code)
              )
                throw error;
              if (
                ['context_refresh_required', 'capability_refresh_required'].includes(error.code) &&
                attempt > 0
              )
                throw error;
              controller.signal.throwIfAborted();
              current = {
                ...request,
                requestId: crypto.randomUUID(),
                messages: await messages(),
                tools: modelTools(),
              };
              attempt++;
            }
          }
        },
        executeTool: async (call, stepId, source) => {
          let input: Json = null;
          try {
            input = JSON.parse(call.arguments) as Json;
          } catch {
            /* UnifiedExecution records invalid parameters. */
          }
          if (
            configuredSources ||
            scope.bindings.extensions.some((extension) => extension.context)
          ) {
            const key = `${call.name}:${await semanticDigest(input)}`;
            if (!sourceRequests.has(key) && sourceRequests.size >= 256)
              throw new AgentError('context_source_budget_exceeded');
            sourceRequests.set(key, {
              sessionId: session.id,
              workspaceId: session.workspaceId,
              definitionId: call.name,
              input,
            });
          }
          const decisionSources = structuredClone(captured);
          const decisionRequests = structuredClone([...sourceRequests.values()]);
          const decisionInputVersion = capturedInputVersion;
          const decisionCapabilities = capabilityFingerprint;
          const decisionBindings = scope.bindings;
          const checkToolDecision = async () => {
            if (inputVersion !== decisionInputVersion)
              throw new AgentError('superseded_by_user_input');
            await checkCapabilities(decisionCapabilities);
            if (
              (await semanticDigest(
                JSON.parse(
                  JSON.stringify(await capture(decisionRequests, decisionBindings)),
                ) as Json,
              )) !== (await semanticDigest(JSON.parse(JSON.stringify(decisionSources)) as Json))
            )
              throw new AgentError('context_refresh_required');
          };
          return this.execution.tool(
            {
              ...scope,
              bindings: decisionBindings,
              decisionSources,
              checkFreshness: checkToolDecision,
            },
            decisionBindings.tools.get(call.name),
            call,
            stepId,
            source,
            undefined,
            (() => {
              const planned = resumed?.plannedTools.get(call.id);
              return planned?.stepId === stepId &&
                (planned.decisionSource as Record<string, Json>).modelExecutionId === source
                ? planned
                : undefined;
            })(),
          );
        },
      };
      if (resumed?.modelRequest && resumed.modelSource) {
        for (const request of resumed.sourceRequests)
          sourceRequests.set(
            `${request.definitionId}:${await semanticDigest(request.input)}`,
            request,
          );
        await selectCapabilities();
        if (
          canonicalJson(modelTools() as unknown as Json) !==
            canonicalJson(resumed.modelRequest.tools as unknown as Json) ||
          canonicalJson((scope.bindings.capabilitySnapshot ?? null) as Json) !==
            canonicalJson(resumed.modelSource.capabilitySnapshot ?? null)
        )
          throw new AgentError('capability_refresh_required');
        captured = await capture();
        if (
          canonicalJson(captured as unknown as Json) !==
          canonicalJson(resumed.modelSource.sources ?? [])
        )
          throw new AgentError('context_refresh_required');
        capturedInputVersion = inputVersion;
      }
      const requiredResults = async () => {
        const current = await this.options.store.getRun(run.id);
        let added = 0;
        for (const ref of current?.requirements ?? []) {
          if (
            ref.runId !== run.id ||
            ref.phase === 'dispatch' ||
            ref.evaluationProvider !== 'extension'
          )
            continue;
          const record = await this.options.store.getExtensionRecord({
            extensionId: ref.extensionId,
            sessionId: ref.sessionId,
            key: ref.recordKey,
          });
          const value = record?.value;
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            value.kind !== 'operation_result' ||
            typeof value.executionId !== 'string'
          )
            continue;
          const execution = await this.options.store.getExecution(value.executionId);
          if (
            !execution ||
            !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
          )
            continue;
          if (
            execution.resultAcceptance?.runId === run.id &&
            execution.resultAcceptance.selectionId === value.contextSelectionId &&
            execution.resultAcceptance.resultRevision === execution.resultRevision
          )
            continue;
          const commandId = `required-${createHash('sha256')
            .update(
              canonicalJson([
                run.originStoreId,
                run.id,
                value.executionId,
                execution.resultRevision,
              ]),
            )
            .digest('hex')}`;
          const before = await this.options.store.getCommand(commandId);
          await this.options.store.consumeJobResult({
            expectedStoreId: run.originStoreId,
            owner,
            commandId,
            sessionId: run.sessionId,
            executionId: execution.id,
            resultRevision: execution.resultRevision,
            contextSelectionId: String(value.contextSelectionId),
            targetRunId: run.id,
            requiredRef: ref,
            ...(execution.status === 'outcome_unknown' ? { requiredDiagnostic: true } : {}),
          });
          if (!before) added++;
        }
        return added;
      };
      if (command.kind === 'context.compression.reset') {
        const request = command.request as {
          expectedContextSelectionId: string;
          expectedCompressionId: string | null;
        };
        let expectedHighWaterSeq: string | undefined;
        if (request.expectedCompressionId !== null) {
          await selectCapabilities();
          capturedInputVersion = inputVersion;
          captured = await capture();
          expectedHighWaterSeq = (
            await this.options.store.getExpandedContext({
              expectedStoreId: run.originStoreId,
              sessionId: run.sessionId,
              contextSelectionId: request.expectedContextSelectionId,
              messageLimit: 1,
              sourceLimit: 1,
              byteLimit: 8 * 1024 * 1024,
            })
          ).highWaterSeq;
          const expanded = await this.modelMessages(
            run.sessionId,
            run.originStoreId,
            controller.signal,
            command.subjectId,
            true,
            expectedHighWaterSeq,
          );
          if (
            !selectedCompressor?.validateExpanded ||
            (await selectedCompressor.validateExpanded({
              command: freeze(structuredClone(command)),
              run: freeze(structuredClone(run)),
              session: freeze(structuredClone(session)),
              messages: freeze(
                structuredClone([
                  ...captured.map((source) => ({
                    role: source.role ?? ('system' as const),
                    content: source.content,
                    sourceIds: [source.id],
                  })),
                  ...expanded,
                ]),
              ),
              sources: freeze(structuredClone(captured)),
              trigger: 'manual',
              focus: null,
              signal: controller.signal,
            })) !== true
          )
            throw new AgentError('compression_reset_unsafe');
          await checkFreshness();
        }
        await this.options.store.resetCompression({
          expectedStoreId: run.originStoreId,
          owner,
          runId: run.id,
          ...request,
          expectedHighWaterSeq,
          requirements: await this.execution.requirements(scope, 'completion'),
        });
        return;
      }
      if (command.kind === 'context.compress') {
        await compress(await messages(), 'manual');
        return;
      }
      const completionKeys = new Map<string, string>();
      complete: while (true) {
        await this.options.store.setRunResultWait({
          expectedStoreId: run.originStoreId,
          owner,
          runId: run.id,
          executionIds: [],
        });
        await defaultLoop(loopContext);
        if ((await applySteer()) > 0 || inputVersion !== capturedInputVersion) continue;
        let resultChanged = false;
        const seenInteractions = new Set<string>();
        settle: for (;;) {
          controller.signal.throwIfAborted();
          const cursor = (await this.options.store.getMetadata()).lastChangeCursor;
          resultChanged = (await requiredResults()) > 0 || resultChanged;
          const evaluations = await this.execution.requirements(
            scope,
            'completion',
            undefined,
            true,
          );
          // A child can settle after the initial read but before evaluation finishes.
          // Admit its exact result before treating that fresh terminal state as a failure.
          if ((await requiredResults()) > 0) {
            resultChanged = true;
            continue;
          }
          const blocked = evaluations.filter((evaluation) => evaluation.outcome === 'unsatisfied');
          if (!blocked.length) {
            if (resultChanged) continue complete;
            try {
              await this.options.store.finishRun({
                expectedStoreId: command.originStoreId,
                owner,
                runId: run.id,
                status: 'completed',
                requirements: evaluations,
              });
              break complete;
            } catch (error) {
              if (!(error instanceof AgentError) || error.code !== 'input_pending') throw error;
              if ((await applySteer()) > 0) continue complete;
              continue;
            }
          }
          let directiveApplied = false;
          let continueModel = false;
          const latest = await this.options.store.getRun(run.id);
          for (const extension of scope.bindings.extensions) {
            if (!extension.completionGovernance) continue;
            const references = latest?.requirements ?? [];
            const directive = await extension.completionGovernance.prepare({
              runId: run.id,
              requirements: references,
              evaluations,
              context: {
                boundary: {
                  sessionId: run.sessionId,
                  runId: run.id,
                  executionId: null,
                  kind: null,
                  definitionId: null,
                  definitionVersion: null,
                  attempt: null,
                },
                forRequirement: async (reference) => {
                  if (
                    reference.extensionId !== extension.id ||
                    !references.some(
                      (ref) =>
                        canonicalJson(ref as unknown as Json) ===
                        canonicalJson(reference as unknown as Json),
                    )
                  )
                    throw new AgentError('requirement_scope_mismatch');
                  return this.extensionHost.conditionContext(scope, reference, () => {});
                },
              },
            });
            if (!directive) continue;
            if (typeof directive.key !== 'string' || !directive.key || directive.key.length > 512)
              throw new AgentError('completion_directive_invalid');
            const key = `${extension.id}:${directive.key}`;
            if (completionKeys.get(extension.id) === key)
              throw new AgentError('necessary_condition_unsatisfied');
            completionKeys.set(extension.id, key);
            if (directive.kind === 'continue') {
              if (
                typeof directive.content !== 'string' ||
                Buffer.byteLength(directive.content) > 32 * 1024
              )
                throw new AgentError('completion_directive_invalid');
              const content = canonicalJson({
                kind: 'completion_diagnostic',
                key: directive.key,
                content: directive.content,
              });
              continuationSource = {
                id: `${extension.id}:completion:${run.id}`,
                kind: 'completion',
                role: 'user',
                scope: session.id,
                digest: await semanticDigest(content),
                content,
              };
              continueModel = true;
              directiveApplied = true;
              break;
            }
            if (directive.kind !== 'tool') throw new AgentError('completion_directive_invalid');
            const definition = scope.bindings.tools.get(directive.definitionId);
            if (
              !definition ||
              definition.version !== directive.definitionVersion ||
              !(extension.tools ?? []).some(
                (tool) => tool.id === definition.id && tool.version === definition.version,
              )
            )
              throw new AgentError('completion_tool_unavailable');
            await applySteer();
            await selectCapabilities();
            const requests: SourceRequest[] = [
              {
                sessionId: session.id,
                workspaceId: session.workspaceId,
                definitionId: modelId,
                input: { kind: 'model_request' },
              },
              {
                sessionId: session.id,
                workspaceId: session.workspaceId,
                definitionId: definition.id,
                input: directive.input,
              },
            ];
            const decisionBindings = scope.bindings;
            const decisionInputVersion = inputVersion;
            const decisionCapabilities = capabilityFingerprint;
            const checkSources = await capture(requests, decisionBindings);
            const checkCompletionFreshness = async () => {
              if (inputVersion !== decisionInputVersion)
                throw new AgentError('superseded_by_user_input');
              await checkCapabilities(decisionCapabilities);
              if (
                (await semanticDigest(checkSources as unknown as Json)) !==
                (await semanticDigest(
                  (await capture(requests, decisionBindings)) as unknown as Json,
                ))
              )
                throw new AgentError('context_refresh_required');
            };
            const reference = references.find(
              (ref) =>
                ref.extensionId === extension.id &&
                ref.requirementId === extension.mutationGovernance?.requirementId,
            );
            if (!reference) throw new AgentError('mutation_policy_missing');
            const result = await this.execution.tool(
              {
                ...scope,
                bindings: decisionBindings,
                decisionSources: checkSources,
                checkFreshness: checkCompletionFreshness,
              },
              definition,
              {
                id: crypto.randomUUID(),
                name: definition.id,
                arguments: canonicalJson(directive.input),
              },
              crypto.randomUUID(),
              '',
              {
                kind: 'completion_decision',
                requirement: reference as unknown as Json,
                key: directive.key,
                sources: checkSources as unknown as Json,
              },
            );
            if (result.outcome === 'outcome_unknown')
              throw new AgentError('operation_unverifiable');
            directiveApplied = true;
            if (result.outcome !== 'succeeded') throw new AgentError(result.content);
            break;
          }
          if (directiveApplied) {
            if (continueModel) continue complete;
            continue;
          }
          const ids = [
            ...new Set(blocked.flatMap((evaluation) => evaluation.wait?.executionIds ?? [])),
          ];
          if (
            blocked.some((evaluation) => !evaluation.wait?.executionIds.length) ||
            !ids.length ||
            ids.length > 64
          ) {
            if (resultChanged) continue complete;
            throw new AgentError('necessary_condition_unsatisfied');
          }
          for (const id of ids) {
            const execution = await this.options.store.getExecution(id);
            const parent = execution?.parentExecutionId
              ? await this.options.store.getExecution(execution.parentExecutionId)
              : null;
            if (
              execution?.kind !== 'job' ||
              execution.originStoreId !== run.originStoreId ||
              execution.sessionId !== run.sessionId ||
              parent?.runId !== run.id ||
              execution.rootWorkCommandId !== run.rootWorkCommandId ||
              execution.rootWorkSeq !== run.rootWorkSeq
            )
              throw new AgentError('required_result_unverifiable');
            if (!['planned', 'dispatching', 'running'].includes(execution.status)) continue settle;
          }
          try {
            await this.options.store.setRunResultWait({
              expectedStoreId: run.originStoreId,
              owner,
              runId: run.id,
              executionIds: ids,
            });
          } catch (error) {
            if (error instanceof AgentError && error.code === 'result_wait_changed') continue;
            throw error;
          }
          const events = await this.changeWaits.wait(
            cursor,
            controller.signal,
            Math.max(0, Math.min(30000, (run.deadlineAt ?? Number.MAX_SAFE_INTEGER) - Date.now())),
          );
          if ((await applySteer()) > 0) continue complete;
          for (const event of events) {
            if (
              seenInteractions.has(event.objectId) ||
              !['interaction.requested', 'interaction.projected'].includes(event.type)
            )
              continue;
            const interaction = await this.options.store.getInteraction({
              expectedStoreId: run.originStoreId,
              sessionId: run.sessionId,
              interactionId: event.objectId,
            });
            if (!interaction) continue;
            const children = await Promise.all(
              ids.map((id) => this.options.store.getExecution(id)),
            );
            if (children.some((execution) => execution?.childSessionId === interaction.sessionId)) {
              seenInteractions.add(event.objectId);
              continue complete;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof AgentError && error.code === 'child_deadline_exceeded') await expire();
      await this.options.store.finishRun({
        expectedStoreId: command.originStoreId,
        owner,
        runId: run.id,
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        reason:
          controller.signal.reason instanceof AgentError &&
          controller.signal.reason.code === 'child_deadline_exceeded'
            ? 'child_deadline_exceeded'
            : error instanceof AgentError
              ? error.code
              : 'execution_failed',
        requirements: [],
      });
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      await expiry?.catch(() => {});
      release();
      await releaseBinding().catch((error) => {
        if (resumed) this.runResumeCleanupFailed = true;
        return Promise.reject(error);
      });
    }
  }
  async cancelCommand(input: CancelCommandInput): Promise<CommandRecord> {
    let receipt: CommandRecord;
    try {
      receipt = await this.options.store.cancelCommand(input);
    } catch (error) {
      // Shrinking safety action only for this Runtime's verified live handle.
      const active = this.active.get(input.targetCommandId);
      const code = error instanceof AgentError ? error.code : '';
      if (
        active &&
        active.sessionId === input.sessionId &&
        active.originStoreId === input.expectedStoreId &&
        active.subjectId === input.subjectId &&
        [
          'storage_error',
          'worker_unavailable',
          'store_closed',
          'SQLITE_FULL',
          'SQLITE_READONLY',
          'SQLITE_IOERR',
          'storage_queue_full',
        ].includes(code)
      ) {
        active.controller.abort(new AgentError('cancel_requested_not_durable'));
        throw new AgentError('cancel_requested_not_durable');
      }
      throw error;
    }
    const targetCommandId = (receipt.receipt as { targetCommandId?: string } | null)
      ?.targetCommandId;
    if (targetCommandId) {
      this.active.get(targetCommandId)?.controller.abort(new AgentError('cancel_requested'));
      this.jobReconcileControllers.get(targetCommandId)?.abort(new AgentError('cancel_requested'));
      this.runResumeControllers.get(targetCommandId)?.abort(new AgentError('cancel_requested'));
    }
    return receipt;
  }
  cancelRun(input: CancelWorkBase & { runId: string }) {
    return this.cancelWork({ ...input, kind: 'run.cancel' });
  }
  cancelExecution(input: CancelWorkBase & { executionId: string }) {
    return this.cancelWork({ ...input, kind: 'execution.cancel' });
  }
  cancelSession(input: CancelWorkBase & { includeBackground: boolean }) {
    return this.cancelWork({ ...input, kind: 'session.cancel' });
  }
  private async cancelWork(input: CancelWorkInput): Promise<CommandRecord> {
    let receipt: CommandRecord;
    try {
      receipt = await this.options.store.cancelWork(input);
    } catch (error) {
      const code = error instanceof AgentError ? error.code : '';
      if (
        ![
          'storage_error',
          'worker_unavailable',
          'store_closed',
          'SQLITE_FULL',
          'SQLITE_READONLY',
          'SQLITE_IOERR',
          'storage_queue_full',
        ].includes(code)
      )
        throw error;
      const targets =
        input.kind === 'execution.cancel'
          ? [this.activeExecutions.get(input.executionId)]
          : input.kind === 'run.cancel'
            ? [...this.active.values()].filter((live) => live.runId === input.runId)
            : [...this.active.values()].filter(
                (live) => input.includeBackground || live.runId !== undefined,
              );
      const owned = targets.filter(
        (live) =>
          live?.sessionId === input.sessionId &&
          live.originStoreId === input.expectedStoreId &&
          live.subjectId === input.subjectId,
      );
      if (!owned.length) throw error;
      for (const live of owned)
        live!.controller.abort(new AgentError('cancel_requested_not_durable'));
      throw new AgentError('cancel_requested_not_durable');
    }
    await this.observeOwnedCancellation();
    return receipt;
  }
  private async observeOwnedCancellation(): Promise<void> {
    // Observe only already owned handles. Durable flags choose attached descendants precisely.
    await Promise.allSettled(
      [...this.active].map(async ([id, live]) => {
        const command = await this.options.store.getCommand(id);
        if (command?.cancelRequestedAt !== null && command?.cancelRequestedAt !== undefined)
          live.controller.abort(new AgentError('cancel_requested'));
      }),
    );
    await Promise.allSettled(
      [...this.activeExecutions].map(async ([id, live]) => {
        const execution = await this.options.store.getExecution(id);
        if (execution?.cancelRequestedAt !== null && execution?.cancelRequestedAt !== undefined)
          live.controller.abort(new AgentError('execution_cancel_requested'));
      }),
    );
  }
  async waitForCommand(
    commandId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CommandRecord> {
    const deadline = Date.now() + (options.timeoutMs ?? 10000);
    while (true) {
      options.signal?.throwIfAborted();
      if (this.closing) throw new AgentError('runtime_draining');
      const command = await this.getCommand(commandId);
      if (!command) throw new AgentError('command_not_found');
      if ('dispatchFailure' in command) throw new AgentError(command.dispatchFailure.code);
      if (command.status === 'rejected' || command.status === 'needs_review') return command;
      if (
        (command.kind === 'input.steer' || command.kind === 'result.include') &&
        command.status === 'applied'
      )
        return command;
      const runId = (command.receipt as { runId?: string } | null)?.runId;
      if (runId) {
        const run = await this.options.store.getRun(runId);
        if (run && !run.isActive) return command;
      }
      const executionId = (command.receipt as { executionId?: string } | null)?.executionId;
      if (executionId && command.kind !== 'job.report') {
        const execution = await this.options.store.getExecution(executionId);
        const pendingAttempt = (command.receipt as { preparingNextAttempt?: boolean } | null)
          ?.preparingNextAttempt;
        if (
          execution &&
          ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status) &&
          (!pendingAttempt || command.cancelRequestedAt !== null)
        )
          return command;
      }
      if (Date.now() >= deadline) throw new AgentError('wait_timeout');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  close(): Promise<void> {
    const result = this.tryBeginShutdown('cancel');
    if (!result.accepted) throw new AgentError('shutdown_not_accepted');
    return result.completion;
  }
  private async drain(options: RuntimeShutdownOptions): Promise<void> {
    this.changeWaits.close();
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.controlTimer = undefined;
    this.pendingSessions.clear();
    this.nextDispatchPoll.clear();
    this.dispatchFailures.clear();
    await this.controlTask?.catch(() => {});
    if (this.admissions) await new Promise<void>((resolve) => this.admissionWaiters.add(resolve));
    for (const [commandId, active] of this.active) {
      await this.options.store
        .cancelCommand({
          expectedStoreId: active.originStoreId,
          sessionId: active.sessionId,
          commandId: crypto.randomUUID(),
          targetCommandId: commandId,
          subjectId: active.subjectId,
        })
        .catch(() => {});
      active.controller.abort(new AgentError('service_shutdown'));
    }
    await Promise.allSettled(this.tasks.values());
    this.wakeups.clear();
    await this.extensionHost.drain();
    for (const retained of this.reportBindings.values()) await retained.release();
    this.reportBindings.clear();
    await this.execution.stopUnconfirmedJobs();
    if (
      this.runBindingLeases.size ||
      this.reportRecoveryCleanupFailed ||
      this.jobReconcileCleanupFailed ||
      this.runResumeCleanupFailed
    )
      throw new AgentError('shutdown_cleanup_unconfirmed');
    await Promise.all(this.childBaseReleases.map((release) => release()));
    await options.beforeResourceClose?.();
    this.resourceAdmissionClosed = true;
    if (this.resourceUsers) await new Promise<void>((resolve) => this.resourceWaiters.add(resolve));
    await this.options.artifacts?.close();
    await this.options.store.close();
  }
  private async consumeJobResults(
    run: RunRecord,
    owner: OwnerRef,
    signal: AbortSignal,
  ): Promise<void> {
    const session = await this.options.store.getSession(run.sessionId);
    if (!session) throw new AgentError('session_not_found');
    let afterCursor = '0';
    let upperCursor: string | undefined;
    while (true) {
      signal.throwIfAborted();
      const page = await this.options.store.listPendingJobResults({
        expectedStoreId: run.originStoreId,
        sessionId: run.sessionId,
        afterCursor,
        ...(upperCursor === undefined ? {} : { upperCursor }),
        limit: 100,
      });
      upperCursor ??= page.highWaterCursor;
      for (const result of page.jobs) {
        signal.throwIfAborted();
        const currentRun = await this.options.store.getRun(run.id);
        let required = false;
        for (const ref of currentRun?.requirements ?? []) {
          if (ref.runId !== run.id || ref.evaluationProvider !== 'extension') continue;
          const record = await this.options.store.getExtensionRecord({
            extensionId: ref.extensionId,
            sessionId: ref.sessionId,
            key: ref.recordKey,
          });
          const value = record?.value;
          if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            value.kind === 'operation_result' &&
            value.executionId === result.executionId
          ) {
            required = true;
            break;
          }
        }
        if (required) continue;
        // Imported or rewound facts remain historical; observation cannot grant a new delivery.
        if (
          result.originStoreId !== run.originStoreId ||
          result.contextSelectionId !== session.contextSelectionId
        )
          continue;
        try {
          await this.options.store.consumeJobResult({
            expectedStoreId: run.originStoreId,
            owner,
            sessionId: run.sessionId,
            targetRunId: run.id,
            contextSelectionId: result.contextSelectionId,
            executionId: result.executionId,
            resultRevision: result.resultRevision,
            commandId: `consume-${await semanticDigest([
              run.sessionId,
              run.id,
              result.contextSelectionId,
              result.executionId,
              result.resultRevision,
            ])}`,
          });
        } catch (error) {
          if (
            !(error instanceof AgentError) ||
            ![
              'context_rewound',
              'result_not_pending',
              'result_delivery_cancelled',
              'operation_unverifiable',
            ].includes(error.code)
          )
            throw error;
        }
      }
      if (page.nextAfterCursor === null) return;
      if (BigInt(page.nextAfterCursor) <= BigInt(afterCursor))
        throw new AgentError('invalid_context_cursor');
      afterCursor = page.nextAfterCursor;
    }
  }
  private async readBody(
    reference: import('./storage/types').ArtifactReference,
    signal?: AbortSignal,
    expectedStoreId?: string,
  ): Promise<Uint8Array> {
    if (!this.options.artifacts) throw new AgentError('artifact_content_unavailable');
    signal?.throwIfAborted();
    const storeId = expectedStoreId ?? (await this.options.store.getMetadata()).storeId;
    const original = await this.options.store.getArtifactReference({
      expectedStoreId: storeId,
      sessionId: reference.sessionId,
      subjectId: reference.subjectId,
      refId: reference.id,
      scope: reference.scope,
    });
    if (
      !original ||
      canonicalJson(original as unknown as Json) !== canonicalJson(reference as unknown as Json)
    )
      throw new AgentError('model_body_invalid');
    const content = await this.options.artifacts.read({
      expectedStoreId: storeId,
      sessionId: reference.sessionId,
      subjectId: reference.subjectId,
      refId: reference.id,
      scope: reference.scope,
    });
    signal?.throwIfAborted();
    if (
      String(content.byteLength) !== reference.size ||
      (await semanticDigestBytes(content)) !== reference.hash
    )
      throw new AgentError('model_body_invalid');
    return content;
  }
  private async sealApprovalRequest(
    scope: ToolScope,
    executionId: string,
    request: Json,
  ): Promise<Json> {
    let nodes = 0,
      complex = false;
    const visit = (value: Json, depth: number) => {
      if (++nodes > 2048 || depth > 16) {
        complex = true;
        return;
      }
      if (value && typeof value === 'object')
        for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(request, 0);
    const content = Buffer.from(canonicalJson(request));
    if (content.byteLength <= 32768 && !complex) return request;
    if (!this.options.artifacts) throw new AgentError('artifact_content_unavailable');
    const execution = await this.options.store.getExecution(executionId);
    const command = execution && (await this.options.store.getCommand(execution.originCommandId));
    if (
      !execution ||
      !command ||
      execution.sessionId !== command.sessionId ||
      execution.originStoreId !== command.originStoreId
    )
      throw new AgentError('interaction_binding_changed');
    scope.signal.throwIfAborted();
    const hash = await semanticDigestBytes(content);
    const reference = await this.options.artifacts.publish({
      expectedStoreId: command.originStoreId,
      sessionId: command.sessionId,
      subjectId: command.subjectId,
      scope: { kind: 'execution', id: executionId },
      refId: `approval-body-${(await semanticDigest(executionId)).slice(0, 32)}-${hash}`,
      mediaType: 'application/json',
      content,
    });
    scope.signal.throwIfAborted();
    const original = request as { [key: string]: Json };
    return {
      policy: {
        reason: 'complete_approval_request',
        review: {
          kind: 'artifact',
          complete: true,
          reference: {
            id: reference.id,
            mediaType: reference.mediaType,
            size: reference.size,
            scope: reference.scope as unknown as Json,
          },
        },
      },
      grants: original.grants!,
      ...(original.commandDigest === undefined ? {} : { commandDigest: original.commandDigest }),
      definitionId: original.definitionId!,
      definitionVersion: original.definitionVersion!,
      input: {
        kind: 'complete_approval_request',
        inputDigest: await semanticDigest(original.input!),
      },
      approvalRequestDigest: hash,
    };
  }
  private async verifyApprovalRequest(
    scope: ToolScope,
    executionId: string,
    saved: Json,
    actual: Json,
  ): Promise<void> {
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      !('approvalRequestDigest' in saved)
    )
      return;
    const envelope = saved as {
      approvalRequestDigest: string;
      policy: {
        review: {
          reference: {
            id: string;
            mediaType: string;
            size: string;
            scope: { kind: 'execution'; id: string };
          };
        };
      };
    };
    const ref = envelope.policy?.review?.reference;
    if (
      ref?.scope?.kind !== 'execution' ||
      ref.scope.id !== executionId ||
      !/^[a-f0-9]{64}$/.test(envelope.approvalRequestDigest)
    )
      throw new AgentError('interaction_binding_changed');
    const execution = await this.options.store.getExecution(executionId);
    const command = execution && (await this.options.store.getCommand(execution.originCommandId));
    if (!execution || !command) throw new AgentError('interaction_binding_changed');
    const reference = await this.options.store.getArtifactReference({
      expectedStoreId: command.originStoreId,
      sessionId: command.sessionId,
      subjectId: command.subjectId,
      refId: ref.id,
      scope: ref.scope,
    });
    if (
      !reference ||
      reference.hash !== envelope.approvalRequestDigest ||
      reference.mediaType !== ref.mediaType ||
      reference.size !== ref.size
    )
      throw new AgentError('interaction_binding_changed');
    const content = await this.readBody(reference, scope.signal, command.originStoreId);
    let complete: Json;
    try {
      complete = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as Json;
    } catch {
      throw new AgentError('interaction_binding_changed');
    }
    if (!complete || typeof complete !== 'object' || Array.isArray(complete))
      throw new AgentError('interaction_binding_changed');
    for (const [key, value] of Object.entries(actual as { [key: string]: Json }))
      if (canonicalJson(complete[key]!) !== canonicalJson(value))
        throw new AgentError('interaction_binding_changed');
    scope.signal.throwIfAborted();
  }
  private async publishBody(
    scope: ToolScope,
    value: Json,
  ): Promise<import('./model-body').ModelBodyReference> {
    if (!this.options.artifacts) throw new AgentError('artifact_content_unavailable');
    const command =
      'run' in scope
        ? await this.options.store.getCommand(scope.run.originCommandId)
        : scope.command;
    if (!command) throw new AgentError('command_not_found');
    scope.signal.throwIfAborted();
    const content = Buffer.from(canonicalJson(value));
    const hash = await semanticDigestBytes(content);
    const reference = await this.options.artifacts.publish({
      expectedStoreId: command.originStoreId,
      sessionId: command.sessionId,
      subjectId: command.subjectId,
      scope: { kind: 'session', id: command.sessionId },
      refId: `model-body-${hash}`,
      mediaType: 'application/json',
      content,
    });
    scope.signal.throwIfAborted();
    return { kind: 'model_body', version: 1, reference };
  }
  private async publishModelOutput(
    scope: import('./execution').ExecutionScope,
    executionId: string,
    value: Json,
  ): Promise<import('./storage/types').ArtifactReference> {
    if (!this.options.artifacts) throw new AgentError('artifact_content_unavailable');
    const command = await this.options.store.getCommand(scope.run.originCommandId);
    const execution = await this.options.store.getExecution(executionId);
    if (
      !command ||
      !execution ||
      execution.kind !== 'model' ||
      execution.originStoreId !== scope.run.originStoreId ||
      command.originStoreId !== scope.run.originStoreId ||
      execution.sessionId !== scope.run.sessionId ||
      command.sessionId !== scope.run.sessionId ||
      execution.runId !== scope.run.id ||
      execution.originCommandId !== command.id ||
      execution.ownerGeneration !== scope.owner.generation
    )
      throw new AgentError('model_output_scope_denied');
    const content = Buffer.from(canonicalJson(value));
    const hash = await semanticDigestBytes(content);
    return this.options.artifacts.publish({
      expectedStoreId: command.originStoreId,
      sessionId: command.sessionId,
      subjectId: command.subjectId,
      scope: { kind: 'execution', id: executionId },
      refId: `model-output-${executionId}-${hash}`,
      mediaType: 'application/vnd.kite.model-output+json',
      content,
    });
  }
  private async sealModelMetadata(
    scope: import('./execution').ExecutionScope,
    metadata: Json,
  ): Promise<Json> {
    if (Buffer.byteLength(canonicalJson(metadata)) <= 64 * 1024) return metadata;
    return { version: 1, body: (await this.publishBody(scope, metadata)) as unknown as Json };
  }
  private async sealModelInput(
    scope: import('./execution').ExecutionScope,
    request: ModelRequest,
  ): Promise<Json> {
    const command = await this.options.store.getCommand(scope.run.originCommandId);
    let authorizationReviewBindingDigest: string | undefined;
    if (command?.kind === 'child.start') {
      const carrier = await this.options.store.getExecution(
        String((command.request as Record<string, Json>).parentExecutionId),
      );
      const parent = carrier ? await this.options.store.getCommand(carrier.originCommandId) : null;
      if (parent?.kind === 'authorization.review') {
        authorizationReviewBindingDigest = await semanticDigest(carrier!.input);
        request = await this.expandReviewRequest(request, scope);
      }
    }
    const input = JSON.parse(JSON.stringify(request)) as Json;
    if (Buffer.byteLength(canonicalJson(input)) <= 64 * 1024) return input;
    const body = await this.publishBody(scope, input);
    // Identity and actual tool manifest remain visible to durable authorization; body is immutable.
    return {
      modelId: request.modelId,
      requestId: request.requestId,
      tools: request.tools.map((tool) => ({
        id: tool.id,
        definitionVersion: tool.definitionVersion,
      })),
      body: body as unknown as Json,
      ...(authorizationReviewBindingDigest ? { authorizationReviewBindingDigest } : {}),
    };
  }
  private async openModelInput(
    scope: import('./execution').ExecutionScope,
    input: Json,
  ): Promise<ModelRequest> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new AgentError('model_body_invalid');
    const body = bodyReference(input.body);
    if (!body) return input as unknown as ModelRequest;
    const command = await this.options.store.getCommand(scope.run.originCommandId);
    if (
      !command ||
      body.reference.storeId !== command.originStoreId ||
      body.reference.sessionId !== command.sessionId ||
      body.reference.subjectId !== command.subjectId ||
      body.reference.scope.kind !== 'session' ||
      body.reference.scope.id !== command.sessionId
    )
      throw new AgentError('model_body_invalid');
    const actual = jsonBody(await this.readBody(body.reference, scope.signal)) as Record<
      string,
      Json
    >;
    if (
      actual.modelId !== input.modelId ||
      actual.requestId !== input.requestId ||
      !Array.isArray(actual.messages) ||
      !Array.isArray(actual.tools) ||
      canonicalJson(
        actual.tools.map((tool) => {
          const value = tool as Record<string, Json>;
          return { id: value.id!, definitionVersion: value.definitionVersion! };
        }),
      ) !== canonicalJson(input.tools!)
    )
      throw new AgentError('model_body_invalid');
    return actual as unknown as ModelRequest;
  }
  private async sealSource(scope: ToolScope, source: Json): Promise<Json> {
    if (Buffer.byteLength(canonicalJson(source)) <= 64 * 1024) return source;
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw new AgentError('model_source_invalid');
    const body = await this.publishBody(scope, source);
    const sources = Array.isArray(source.sources)
      ? source.sources.map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new AgentError('model_source_invalid');
          return { id: value.id!, digest: value.digest! };
        })
      : [];
    return {
      ...source,
      ...(Array.isArray(source.sourceIds) ? { sourceIds: [] } : {}),
      sources,
      sourceBody: body as unknown as Json,
    };
  }
  private async expandReviewRequest(
    request: ModelRequest,
    scope: ToolScope,
  ): Promise<ModelRequest> {
    const messages = [];
    for (const message of request.messages) {
      if (message.role !== 'user') {
        messages.push(message);
        continue;
      }
      let payload: Record<string, Json>;
      try {
        payload = JSON.parse(message.content);
      } catch {
        messages.push(message);
        continue;
      }
      if (payload.purpose !== 'authorization_review') {
        messages.push(message);
        continue;
      }
      for (const field of ['originCommandRequest', 'rootWorkRequest']) {
        const body = bodyReference(payload[field]);
        if (body) payload[field] = jsonBody(await this.readBody(body.reference, scope.signal));
      }
      const context = payload.decisionContext as Record<string, Json> | null;
      if (context?.modelInput) {
        const input = context.modelInput as Record<string, Json>;
        const body = bodyReference(input.body);
        const actual = body
          ? (jsonBody(await this.readBody(body.reference, scope.signal)) as Record<string, Json>)
          : input;
        payload.decisionContext = {
          modelExecutionId: context.modelExecutionId!,
          messages: actual.messages!,
        };
      }
      const requestBody = bodyReference(payload.requestBody);
      if (requestBody) {
        payload.request = jsonBody(await this.readBody(requestBody.reference, scope.signal));
        delete payload.requestBody;
      }
      const target = payload.target as Record<string, Json>;
      const inputBody = bodyReference(target.input);
      if (inputBody)
        target.input = jsonBody(await this.readBody(inputBody.reference, scope.signal));
      const targetBody = bodyReference(target.source);
      if (targetBody)
        target.source = jsonBody(await this.readBody(targetBody.reference, scope.signal));
      const source = target.source as Record<string, Json>;
      const sourceBody = bodyReference(source?.sourceBody);
      if (sourceBody)
        target.source = jsonBody(await this.readBody(sourceBody.reference, scope.signal));
      messages.push({ ...message, content: canonicalJson(payload) });
    }
    return { ...request, messages };
  }
  private async resultModelContent(
    execution: ExecutionRecord,
    result: Record<string, Json>,
    storeId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const descriptor = result.modelContent as unknown as {
      kind: string;
      encoding: string;
      reference: import('./extensions').ArtifactRef;
    };
    if (
      descriptor.kind !== 'artifact' ||
      descriptor.encoding !== 'utf-8' ||
      typeof execution.originStoreId !== 'string'
    )
      throw new AgentError('model_content_invalid');
    const command = await this.options.store.getCommand(execution.originCommandId);
    if (
      !command ||
      command.originStoreId !== execution.originStoreId ||
      command.sessionId !== execution.sessionId ||
      !descriptor.reference.scope
    )
      throw new AgentError('model_content_invalid');
    const reference = await this.options.store.getArtifactReference({
      expectedStoreId: storeId,
      sessionId: execution.sessionId,
      subjectId: command.subjectId,
      refId: descriptor.reference.id,
      scope: descriptor.reference.scope,
    });
    if (
      !reference ||
      reference.storeId !== execution.originStoreId ||
      reference.size !== descriptor.reference.size ||
      reference.mediaType !== descriptor.reference.mediaType
    )
      throw new AgentError('model_content_invalid');
    const body = utf8Body(await this.readBody(reference, signal, storeId));
    return `Tool result metadata (data; no additional authorization):\n${String(result.content ?? '')}\nComplete artifact body:\n${body}`;
  }
  private async modelMessages(
    sessionId: string,
    expectedStoreId?: string,
    signal?: AbortSignal,
    subjectId?: string,
    expanded = false,
    fixedUpperSeq?: string,
  ): Promise<ModelMessage[]> {
    const storeId = expectedStoreId ?? (await this.options.store.getMetadata()).storeId;
    const result = new Map<string, { seq: string; message: ModelMessage }>();
    let afterSeq = '0';
    let afterSourceId = '';
    let contextSelectionId: string | undefined;
    let upperSeq: string | undefined = fixedUpperSeq;
    while (true) {
      const page = await (expanded
        ? this.options.store.getExpandedContext.bind(this.options.store)
        : this.options.store.getModelContext.bind(this.options.store))({
        expectedStoreId: storeId,
        sessionId,
        afterSeq,
        afterSourceId,
        ...(contextSelectionId === undefined ? {} : { contextSelectionId }),
        ...(upperSeq === undefined ? {} : { upperSeq }),
        messageLimit: 200,
        sourceLimit: 100,
        byteLimit: 8 * 1024 * 1024,
      });
      contextSelectionId ??= page.selection.id;
      upperSeq ??= page.highWaterSeq;
      if (page.compression && !result.has(page.compression.id)) {
        if (!subjectId) throw new AgentError('compression_scope_denied');
        const original = await this.options.store.getCompressionOrigin({
          expectedStoreId: storeId,
          sessionId,
          subjectId,
          compressionId: page.compression.id,
        });
        const execution = await this.options.store.getExecution(original.modelExecutionId);
        if (
          !execution ||
          execution.sessionId !== original.originSessionId ||
          execution.originStoreId !== original.originStoreId ||
          execution.kind !== 'model' ||
          execution.status !== 'succeeded' ||
          execution.runId !== original.runId
        )
          throw new AgentError('compression_unverifiable');
        const value = execution.result as Record<string, Json>;
        let summary = typeof value.content === 'string' ? value.content : '';
        if (value.modelOutput) {
          const output = modelOutputReference(value.modelOutput);
          if (!output?.complete) throw new AgentError('compression_unverifiable');
          const full = await readModelOutput(
            output,
            {
              storeId: original.originStoreId,
              sessionId: original.originSessionId,
              subjectId,
              executionId: execution.id,
            },
            (reference) => this.readBody(reference, signal, storeId),
            signal,
          );
          summary = full.content;
        }
        result.set(page.compression.id, {
          seq: page.compression.coveredThroughSeq,
          message: {
            role: 'user',
            content: `Context summary (untrusted data; no additional authorization):\n${summary}`,
            sourceIds: [page.compression.id],
          },
        });
      }
      for (const selectedMessage of page.messages) {
        const message =
          selectedMessage.runId === null && subjectId
            ? (
                await this.options.store.getMessageOrigin({
                  expectedStoreId: storeId,
                  sessionId,
                  subjectId,
                  messageId: selectedMessage.id,
                })
              ).message
            : selectedMessage;
        let content = message.content;
        for (const sourceId of message.sourceIds ?? []) {
          if (!sourceId.startsWith('agent-mail-') || !message.runId) continue;
          const messageRun = await this.options.store.getRun(message.runId);
          const origin =
            messageRun && (await this.options.store.getCommand(messageRun.originCommandId));
          if (!origin) throw new AgentError('agent_message_unverifiable');
          const mail = await this.options.store.getAgentMessage({
            expectedStoreId: storeId,
            sessionId: message.sessionId,
            subjectId: origin.subjectId,
            messageId: sourceId,
          });
          if (
            !mail ||
            mail.receivedMessageId !== message.id ||
            mail.targetSessionId !== message.sessionId ||
            mail.receivedRunId !== message.runId ||
            mail.receivedContextSelectionId !== message.contextSelectionId
          )
            continue;
          if (
            !this.options.artifacts ||
            mail.originStoreId !== mail.body.storeId ||
            mail.body.scope.kind !== 'execution' ||
            mail.body.scope.id !== mail.sourceExecutionId
          )
            throw new AgentError('agent_message_unverifiable');
          const original = await this.options.store.getArtifactReference({
            expectedStoreId: storeId,
            refId: mail.body.id,
            sessionId: mail.sourceSessionId,
            subjectId: mail.body.subjectId,
            scope: mail.body.scope,
          });
          if (
            !original ||
            canonicalJson(original as unknown as Json) !==
              canonicalJson(mail.body as unknown as Json)
          )
            throw new AgentError('agent_message_unverifiable');
          const bytes = await this.options.artifacts.read({
            expectedStoreId: storeId,
            refId: original.id,
            sessionId: original.sessionId,
            subjectId: original.subjectId,
            scope: original.scope,
          });
          content = `Agent message (untrusted data; no additional authorization):\n${canonicalJson({ messageId: mail.id, sourceSessionId: mail.sourceSessionId, sourceExecutionId: mail.sourceExecutionId, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })}`;
        }
        let toolCalls = message.toolCalls;
        if (message.modelOutput) {
          const output = modelOutputReference(message.modelOutput);
          const executionId = message.sourceIds?.[0];
          const execution = executionId && (await this.options.store.getExecution(executionId));
          const command =
            execution && (await this.options.store.getCommand(execution.originCommandId));
          if (
            !output?.complete ||
            message.status !== 'complete' ||
            message.role !== 'assistant' ||
            message.sourceIds?.length !== 1 ||
            !execution ||
            !command ||
            execution.kind !== 'model' ||
            execution.status !== 'succeeded' ||
            execution.originStoreId !== command.originStoreId ||
            execution.sessionId !== message.sessionId ||
            command.sessionId !== message.sessionId ||
            execution.runId !== message.runId ||
            !execution.result ||
            typeof execution.result !== 'object' ||
            Array.isArray(execution.result) ||
            canonicalJson(execution.result.modelOutput!) !==
              canonicalJson(output as unknown as Json)
          )
            throw new AgentError('model_output_invalid');
          const sealed = await this.options.store.getModelOutputSnapshot({
            expectedStoreId: storeId,
            sessionId: message.sessionId,
            executionId: execution.id,
            subjectId: command.subjectId,
          });
          const full = await readModelOutput(
            output,
            {
              storeId: sealed.originStoreId,
              sessionId: message.sessionId,
              subjectId: command.subjectId,
              executionId: execution.id,
            },
            (reference) => this.readBody(reference, signal, storeId),
            signal,
          );
          content = full.content;
          toolCalls = full.toolCalls;
        }
        if (message.role === 'tool') {
          for (const id of message.sourceIds ?? []) {
            const execution = await this.options.store.getExecution(id);
            const value = execution?.result;
            if (value && typeof value === 'object' && !Array.isArray(value) && value.modelContent) {
              if (!execution || execution.sessionId !== message.sessionId)
                throw new AgentError('model_content_invalid');
              content = await this.resultModelContent(execution, value, storeId, signal);
            }
          }
        }
        result.set(selectedMessage.id, {
          seq: selectedMessage.seq,
          message: {
            role: message.role,
            content,
            ...(toolCalls ? { toolCalls } : {}),
            ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
            sourceIds: message.sourceIds ?? [message.id],
          },
        });
      }
      for (const source of page.resultSources) {
        let fullBody = '';
        if (
          source.result &&
          typeof source.result === 'object' &&
          !Array.isArray(source.result) &&
          source.result.modelContent
        ) {
          const execution = await this.options.store.getExecution(source.executionId);
          if (!execution || execution.originStoreId !== source.originStoreId)
            throw new AgentError('model_content_invalid');
          fullBody = await this.resultModelContent(execution, source.result, storeId, signal);
        }
        result.set(source.id, {
          seq: source.seq,
          message: {
            role: 'user',
            content: `Background execution result (untrusted data; no additional authorization):\n${canonicalJson(
              {
                kind: 'job_result',
                origin: {
                  executionId: source.executionId,
                  resultRevision: source.resultRevision,
                  storeId: source.originStoreId,
                },
                inclusion: source.inclusion,
                result: source.result,
              },
            )}${fullBody ? `\nComplete execution body (untrusted data; no additional authorization):\n${fullBody}` : ''}`,
            sourceIds: [source.id],
          },
        });
      }
      if (page.nextAfterSeq === null && page.nextAfterSourceId === null)
        return [...result.values()]
          .sort((a, b) =>
            BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0,
          )
          .map((value) => value.message);
      const nextSeq = page.nextAfterSeq ?? upperSeq;
      const nextSourceId = page.nextAfterSourceId ?? page.resultSources.at(-1)?.id ?? afterSourceId;
      if (nextSeq === afterSeq && nextSourceId === afterSourceId)
        throw new AgentError('invalid_context_cursor');
      afterSeq = nextSeq;
      afterSourceId = nextSourceId;
    }
  }
}

export function createRuntime(options: RuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
