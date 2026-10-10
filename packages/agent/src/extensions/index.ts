import type { ContextSource, SourceRequest } from '../context';
import type { PermissionControlRead } from '../storage/port';
import type {
  ArtifactScope,
  ExecutionOutputPage,
  ExecutionStatus,
  ExtensionRecord,
  ExtensionRecordWrite,
  InteractionAnswer,
  InteractionKind,
  Json,
  JsonSchema,
  OperationRef,
  OperationRequest,
  RequirementEvaluation,
  RequirementRef,
  RunStatus,
} from '../storage/types';
import type { AgentOperationView } from './task/port';

export type { PermissionControlRead } from '../storage/port';

export type {
  ExecutionOutputPage,
  ExtensionRecord,
  ExtensionRecordWrite,
  Json,
  JsonSchema,
  OperationRef,
  OperationRequest,
} from '../storage/types';
export type { AgentOperationView } from './task/port';

export interface ArtifactRef {
  id: string;
  mediaType: string;
  size: string;
  scope?: ArtifactScope;
}
export interface ArtifactReader {
  read(ref: ArtifactRef): Promise<Uint8Array>;
}
export interface ArtifactWriter extends ArtifactReader {
  publish(input: { key: string; content: Uint8Array; mediaType: string }): Promise<ArtifactRef>;
}
export interface ToolResult {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  content: string;
  details?: Json;
  artifactRefs?: ArtifactRef[];
  /** Complete UTF-8 Model body; Core must verify original scope and read to successful EOF. */
  modelContent?: { kind: 'artifact'; reference: ArtifactRef; encoding: 'utf-8' };
}
export interface ToolContext extends ActionContext {
  readonly runId: string | null;
  reportProgress(update: Json): void;
  /** Persist a question for this exact live attempt and return its accepted information. */
  requestInput(request: Json): Promise<Json>;
  /** Information from the exact live attempt; plan review is not a Tool permission grant. */
  requestInteraction(input: { kind: 'question' | 'plan_review'; request: Json }): Promise<Json>;
}
export interface ResourceRequest {
  serial?: { scope: 'runtime' | 'workspace' | 'session'; key: string };
  slot?: 'model' | 'process';
}
export interface ToolDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly resources?: ResourceRequest;
  execute(input: Json, context: ToolContext): Promise<ToolResult>;
}
export interface JobHandle {
  readonly reference: Json;
}
export interface JobContext {
  readonly sessionId: string;
  readonly executionId: string;
  readonly signal: AbortSignal;
  /** Actual final dispatch metadata, after the owned Store transaction accepted it.
   * It explains the trusted host's decision; it never independently grants execution. */
  readonly dispatchAuthorization?: {
    readonly revision: string;
    readonly snapshot?: { namespace: string; version: string; data: Json };
  };
}
/** Cold verification has no execution, interaction, or operation-start capabilities. */
export interface JobReconcileContext {
  readonly sessionId: string;
  readonly executionId: string;
  readonly originalStoreId: string;
  readonly originalResultRevision: string;
  readonly originalInput: Json;
  readonly originalCommandId: string;
  readonly operationKey: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly signal: AbortSignal;
}
export type JobReconcileResult =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'observed';
      result: ToolResult | null;
      supervision: 'ended' | 'running' | 'unknown';
      evidence: Json;
    };
export interface StopConfirmation {
  status: 'stopped' | 'already_finished' | 'requested' | 'failed' | 'unknown';
  details?: Json;
}
export type JobEvent =
  | { type: 'output'; stream: 'stdout' | 'stderr'; content: string }
  | { type: 'output_dropped'; stream: 'stdout' | 'stderr'; bytes: string }
  | { type: 'progress'; value: Json }
  | { type: 'terminal'; result: ToolResult; supervision: 'ended' | 'unknown' };
/** A leaf adapter owns the external mechanism. The host is the only observer and fact writer. */
export interface JobDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly resources?: ResourceRequest;
  start(input: Json, context: JobContext): Promise<JobHandle>;
  observe(handle: JobHandle): AsyncIterable<JobEvent>;
  cancel(handle: JobHandle): Promise<StopConfirmation>;
  dispose(handle: JobHandle): Promise<void>;
  /** Explicit, non-secret identity of the implementation that can verify this operation. */
  readonly recovery?: { readonly version: string; readonly configuration: Json };
  reconcile?(reference: Json, context: JobReconcileContext): Promise<JobReconcileResult>;
}
export type { CompletionDirective, CompletionGovernance, MutationGovernance } from './governance';
export interface Extension {
  readonly compression?: import('../context').ContextCompressor;
  readonly mutationGovernance?: import('./governance').MutationGovernance;
  readonly completionGovernance?: import('./governance').CompletionGovernance;
  readonly id: string;
  readonly version: string;
  readonly apiMajor: 1;
  readonly tools?: readonly ToolDefinition[];
  readonly jobs?: readonly JobDefinition[];
  readonly actions?: readonly ActionDefinition[];
  readonly queries?: readonly QueryDefinition[];
  readonly records?: readonly RecordDefinition[];
  /** Pure scoped business contribution. Core inserts returned content as user data. */
  /** Pure evaluator confined to this selected extension namespace. */
  readonly conditions?: NecessaryConditions;
  readonly context?: {
    capture(request: Readonly<SourceRequest>, context: ReadContext): Promise<ContextSource[]>;
    /** Complete requests for one checkpoint and Session; never a cross-checkpoint cache. */
    captureBatch?(
      requests: readonly Readonly<SourceRequest>[],
      context: ReadContext,
    ): Promise<ContextSource[]>;
  };
}
export interface PublicRun {
  waitingForResults: string[];
  id: string;
  sessionId: string;
  status: RunStatus;
  isActive: boolean;
  createdAt: number;
  finishedAt: number | null;
}
export interface PublicExecution {
  resultAcceptance?: import('../storage/types').ExecutionRecord['resultAcceptance'];
  id: string;
  sessionId: string;
  runId: string | null;
  kind: 'model' | 'tool' | 'job';
  status: ExecutionStatus;
  result: Json;
  resultRevision: string;
  /** Core fills these identities from the stored execution, never from the caller's result. */
  originStoreId?: string;
  originCommandId?: string;
  rootWorkCommandId?: string;
  rootWorkSeq?: string;
  parentExecutionId?: string | null;
  definitionId?: string;
  definitionVersion?: string;
  attempt?: number;
  inputDigest?: string;
  /** Exact desensitized source identities captured for this execution's decision. */
  sources?: readonly { id: string; digest: string }[];
  delivery?: 'pending' | 'consumed' | 'suppressed' | null;
  deliveryReason?: string | null;
}
export interface PublicInteraction {
  id: string;
  originStoreId: string;
  sessionId: string;
  runId: string | null;
  executionId: string;
  attempt: number;
  kind: InteractionKind;
  definitionId: string;
  definitionVersion: string;
  inputDigest: string;
  request: Json;
  answer: InteractionAnswer | null;
  revision: string;
  acceptedDecisionRevision: string | null;
  state: 'pending' | 'answered' | 'cancelled';
}
export interface AcceptedInformation {
  interactionId: string;
  originStoreId: string;
  sessionId: string;
  runId: string | null;
  executionId: string;
  attempt: number;
  decisionRevision: string;
  request: Json;
  answer: Exclude<InteractionAnswer, { kind: 'approval' }>;
}
export interface ForkMessageAlias {
  readonly sessionId: string;
  readonly messageId: string;
  readonly seq: string;
}
export interface ForkSourceProjection {
  readonly storeId: string;
  readonly sessionId: string;
  readonly aliases: readonly {
    readonly current: ForkMessageAlias;
    readonly aliases: readonly ForkMessageAlias[];
  }[];
  getMessage(messageId: string): Promise<import('../storage/types').ForkSourceMessage>;
  readonly sources: readonly import('../storage/types').ForkReadonlySource[];
  getExecution(id: string): Promise<PublicExecution | null>;
  getRun(id: string): Promise<PublicRun | null>;
  readModelInput(id: string): Promise<import('../runtime').ModelInputSnapshot>;
  readModelOutput(id: string): Promise<import('../runtime').ModelOutputSnapshot>;
  readonly artifacts: ArtifactReader;
}
export interface ReadContext {
  readonly sessionId: string;
  openForkSourceProjection?(localKey: string): Promise<ForkSourceProjection>;
  readExecutionGroupSafety?(): Promise<import('../storage/types').ExecutionGroupSafety>;
  /** Registers a current dispatch predicate only in an actual Host preparation boundary. */
  requireExecutionGroupQuiescent?(): Promise<import('../storage/types').ExecutionGroupSafety>;
  readRunExecutionSafety?(runId: string): Promise<import('../storage/types').RunExecutionSafety>;
  /** Observes only original keys sealed into this current namespace record at Fork. */
  readForkRecordSources?(localKey: string): Promise<import('../storage/types').ForkRecordSources>;
  getRun(id: string): Promise<PublicRun | null>;
  getExecution(id: string): Promise<PublicExecution | null>;
  /** Pure actual same-Session fact projection; an unaccepted answer is not business approval. */
  getInteraction?(id: string): Promise<PublicInteraction | null>;
  readonly artifacts?: ArtifactReader;
  readonly records: {
    get(key: string): Promise<ExtensionRecord | null>;
    list(options?: {
      afterKey?: string;
      limit?: number;
      contentType?: string;
    }): Promise<ExtensionRecord[]>;
  };
}
export interface OperationOptions {
  /** Request only; the trusted Run policy must independently authorize this. */
  continuation?: { kind: 'after_turn' };
  resultRequirement?: import('../storage/types').ResultRequirementDeclaration;
  key: string;
  request: OperationRequest;
  planRecordKey?: string;
  cancellation?: 'attached' | 'detached';
  /** Ordinary Agent delegation may fail before any durable child identity is created. */
  admission?: 'fail_if_full';
}
export interface Operations {
  readAgentMessageTarget?(
    target: OperationRef | 'parent',
  ): Promise<{ sessionId: string; contextSelectionId: string; targetRunId: string | null }>;
  sendAgentMessage?(
    target: OperationRef | 'parent',
    input: {
      key: string;
      content: string;
      contextSelectionId: string;
      targetRunId?: string;
    },
  ): Promise<{ commandId: string; status: string; receipt: Json }>;
  listAgentMessages?(options?: { afterSeq?: string; upperSeq?: string; limit?: number }): Promise<{
    items: Omit<import('../storage/types').AgentMessage, 'body'>[];
    upperSeq: string;
    highWaterSeq: string;
    nextAfterSeq: string | null;
    snapshotCursor: string;
  }>;
  waitAgentMessages?(options?: {
    afterSeq?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    reason: 'mail' | 'input' | 'interaction' | 'timeout';
    messageIds: string[];
    highWaterSeq: string;
  }>;
  ensure(options: OperationOptions): Promise<OperationRef>;
  get(ref: OperationRef): Promise<PublicExecution | null>;
  readAgent(ref: OperationRef): Promise<AgentOperationView>;
  getAgentRef?(key: string): Promise<OperationRef | null>;
  listAgents?(options?: {
    afterSeq?: string;
    upperSeq?: string;
    limit?: number;
  }): Promise<import('../storage/types').AgentSummaryPage>;
  interruptAgent?(
    ref: OperationRef,
    input: { commandId: string; targetRunId: string },
  ): Promise<{ commandId: string; status: string; receipt: Json }>;
  sendAgentInput(
    ref: OperationRef,
    input: import('./task/port').AgentInput,
  ): Promise<{ commandId: string; status: string; receipt: Json }>;
  readOutput(
    ref: OperationRef,
    options?: {
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
    },
  ): Promise<ExecutionOutputPage>;
  waitAny(
    refs: readonly OperationRef[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{
    reason: 'terminal' | 'timeout' | 'input' | 'interaction';
    executions: PublicExecution[];
  }>;
  wait(
    ref: OperationRef,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<PublicExecution>;
  cancel?(ref: OperationRef, options?: { commandId?: string }): Promise<void>;
}
export interface ActionContext extends ReadContext {
  readonly executionId: string;
  readonly signal: AbortSignal;
  readonly artifacts?: ArtifactWriter;
  readonly records: ReadContext['records'] & {
    write(value: ExtensionRecordWrite): Promise<ExtensionRecord>;
  };
  readonly mutationFacts?: {
    list(
      requirementId: string,
      options?: { afterSeq?: string; limit?: number },
    ): Promise<import('../storage/types').MutationFactPage>;
    commit(input: {
      requirementId: string;
      mutationExecutionId: string;
      headRevision: string;
      outcome: 'passed' | 'failed' | 'inconclusive' | 'superseded';
      evidence: Json;
    }): Promise<void>;
  };
  readonly operations: Operations;
  readonly requestInput?: (request: Json) => Promise<Json>;
  readonly requestInteraction?: (input: {
    kind: 'question' | 'plan_review';
    request: Json;
  }) => Promise<Json>;
  /** Same informational request, with the original accepted fact identity for business evidence. */
  readonly requestInteractionWithReceipt?: (input: {
    kind: 'question' | 'plan_review';
    request: Json;
  }) => Promise<AcceptedInformation>;
  /** Append obligations in this extension's namespace to the actual Model Run. */
  readonly requirements?: {
    register(
      references: readonly Omit<
        RequirementRef,
        'extensionId' | 'sessionId' | 'runId' | 'originStoreId'
      >[],
    ): Promise<readonly RequirementRef[]>;
  };
}
export interface ActionDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly resources?: ResourceRequest;
  /** Preparation has only read projections. The prepared description is bound to this attempt. */
  prepare(input: Json, context: ReadContext): Promise<Json>;
  execute(prepared: Json, context: ActionContext): Promise<ToolResult>;
}
export interface PublicAction {
  actionId: string;
  definitionVersion: string;
  label: string;
  input: Json;
}
export interface PublicView {
  extensionId: string;
  contentType: string;
  contentVersion: number;
  summary: string;
  payload: Json;
  artifactRefs: ArtifactRef[];
  actions: PublicAction[];
}
export interface QueryDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  execute(input: Json, context: ReadContext): Promise<PublicView[]>;
}
export type { ForkRecordInput, ForkRecordOutput, RecordForkRule } from './fork';
export interface RecordDefinition {
  readonly fork?: import('./fork').RecordForkRule;
  contentType: string;
  contentVersion: number;
  schema: JsonSchema;
}
export function defineExtension<T extends Extension>(extension: T): T {
  return extension;
}
export interface AuthorizationRequest {
  kind: 'model' | 'tool' | 'job';
  sessionId: string;
  runId: string | null;
  executionId: string;
  definitionId: string;
  definitionVersion: string;
  input: Json;
  signal: AbortSignal;
}
export interface PermissionDecision {
  /** Optional trusted non-secret explanation. Not an authority or permission mode in Core. */
  snapshot?: { namespace: string; version: string; data: Json };
  /** Trusted host reads rechecked atomically against original dispatch scope. */
  controlReads?: readonly PermissionControlRead[];
  allowed: boolean;
  revision: string;
  reason?: string;
  /** The current host policy allows a human to decide this exact otherwise-unapproved call. */
  approval?: {
    request: Json;
    grants?: readonly ('approve_once' | 'same_command')[];
    commandDigest?: string;
  };
  /** Trusted host classification asks the finite durable reviewer; never itself grants execution. */
  review?: { request: Json; requireApproval?: boolean };
}
export interface Permissions {
  authorize(request: AuthorizationRequest): Promise<PermissionDecision>;
}
export interface NecessaryConditions {
  evaluate(
    requirements: readonly RequirementRef[],
    phase: 'dispatch' | 'completion',
    context?: NecessaryConditionContext,
  ): Promise<RequirementEvaluation[]>;
}
export interface NecessaryConditionContext {
  readonly boundary: {
    sessionId: string;
    runId: string | null;
    executionId: string | null;
    kind: 'model' | 'tool' | 'job' | null;
    definitionId: string | null;
    definitionVersion: string | null;
    attempt: number | null;
  };
  /** Only a ref in this evaluation's exact immutable collection can obtain a read scope. */
  forRequirement(reference: RequirementRef): Promise<ConditionReadContext>;
}
export type ConditionReadContext = Pick<
  ReadContext,
  'sessionId' | 'getRun' | 'getExecution' | 'getInteraction' | 'readRunExecutionSafety'
> & {
  readonly records: Pick<ReadContext['records'], 'get'>;
  readonly readMutationFacts?: (options?: {
    afterSeq?: string;
    limit?: number;
  }) => Promise<import('../storage/types').MutationFactPage>;
};
export type RunInitializationContext = Omit<ConditionReadContext, 'records'> & {
  readonly records: Pick<ReadContext['records'], 'get'> & {
    /** New immutable executable metadata in run/<actual Run ID>/; no Tool or external effect. */
    create(
      value: Omit<ExtensionRecordWrite, 'expectedRevision' | 'executable'>,
    ): Promise<ExtensionRecord>;
  };
};
