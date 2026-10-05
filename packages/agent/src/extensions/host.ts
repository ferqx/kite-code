import { createHash } from 'node:crypto';
import Ajv from 'ajv';

import type { ArtifactContentStore } from '../artifact-port';
import {
  assertContextSource,
  type ContextSource,
  type ContextSources,
  type SourceRequest,
} from '../context';
import type { StandaloneScope, ToolScope, UnifiedExecution } from '../execution';
import { canonicalJson, semanticDigest } from '../json';
import type { Store } from '../storage/port';
import {
  AgentError,
  type ChildConfiguration,
  type CommandRecord,
  type DispatchRecordListRead,
  type DispatchRecordRead,
  type ExecutionGroupGuard,
  type ExtensionRecordWrite,
  type ForkRecordSourceBinding,
  type Json,
  type OperationRef,
  type OwnerRef,
  type RequirementRef,
} from '../storage/types';
import type { TrustedForkSourceReaders } from './fork-source-readers';
import type {
  ActionContext,
  ActionDefinition,
  ArtifactRef,
  ConditionReadContext,
  Extension,
  JobDefinition,
  PublicExecution,
  PublicRun,
  PublicView,
  ReadContext,
  RunInitializationContext,
  ToolDefinition,
} from './index';
import type { OutputOperations } from './output';

const semanticDigestBytes = async (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

type ReadStamp = { read: () => Promise<unknown>; digest: string };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);
function publicRun(run: Awaited<ReturnType<Store['getRun']>>): PublicRun | null {
  if (!run) return null;
  return {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    isActive: run.isActive,
    createdAt: run.createdAt,
    waitingForResults: run.waitingForResults,
    finishedAt: run.finishedAt,
  };
}
async function publicExecution(
  execution: Awaited<ReturnType<Store['getExecution']>>,
): Promise<PublicExecution | null> {
  if (!execution) return null;
  const decision = execution.decisionSource;
  const sources =
    decision && typeof decision === 'object' && !Array.isArray(decision)
      ? decision.sources
      : undefined;
  return {
    id: execution.id,
    sessionId: execution.sessionId,
    runId: execution.runId,
    kind: execution.kind,
    status: execution.status,
    result: execution.result,
    resultRevision: execution.resultRevision,
    originStoreId: execution.originStoreId,
    originCommandId: execution.originCommandId,
    rootWorkCommandId: execution.rootWorkCommandId,
    rootWorkSeq: execution.rootWorkSeq,
    parentExecutionId: execution.parentExecutionId,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    attempt: execution.attempt,
    inputDigest: await semanticDigest(execution.input),
    sources: Array.isArray(sources)
      ? sources.flatMap((source) =>
          source &&
          typeof source === 'object' &&
          !Array.isArray(source) &&
          typeof source.id === 'string' &&
          typeof source.digest === 'string'
            ? [{ id: source.id, digest: source.digest }]
            : [],
        )
      : [],
    delivery: execution.delivery,
    resultAcceptance: execution.resultAcceptance,
    deliveryReason: execution.deliveryReason,
  };
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;
interface DispatchCapture {
  open: boolean;
  commandId: string;
  records: Map<string, DispatchRecordRead>;
  lists: Map<string, DispatchRecordListRead>;
  forks: Map<string, ForkRecordSourceBinding>;
  sourceForks: Map<string, ForkRecordSourceBinding>;
  guard?: ExecutionGroupGuard;
  contextRevision?: string;
}

export interface ExtensionHostOptions {
  store: Store;
  execution: UnifiedExecution;
  extensions: readonly Extension[];
  tools: ReadonlyMap<string, ToolDefinition>;
  sources?: ContextSources;
  artifacts?: ArtifactContentStore;
  forkSourceReaders?: TrustedForkSourceReaders;
  actionBindings?: StandaloneScope['bindings'];
  resolveAgent?(
    configurationId: string,
    scope: StandaloneScope,
    parentExecutionId: string,
    source: Json,
    continuation?: { executionId: string; afterRunId: string },
  ): Promise<{
    configuration: ChildConfiguration;
    definition: JobDefinition;
    disposeUnused: () => Promise<void>;
    /** Reserve the original Runtime ChildSlots before durable creation; disposeUnused releases failures. */
    reserveForCreation?: () => Promise<void>;
  }>;
  authorizeAfterTurn?(
    scope: StandaloneScope,
    sourceExecutionId: string,
    configuration: ChildConfiguration,
  ): Promise<import('../storage/types').AfterTurnAuthorization>;
  onJobSettled?(scope: StandaloneScope, executionId: string): Promise<void>;
  waitForChange?(
    cursor: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<import('../storage/types').ChangeEvent[]>;
  live(command: CommandRecord, owner: OwnerRef, controller: AbortController): () => void;
  onActivity?(sessionId: string): void;
  assertAcceptingWork?(): void;
}
/** Trusted host facade: extension handlers receive only scoped data and finite operations. */
export class ExtensionHost {
  private readonly validator = new Ajv({ allErrors: true, strict: false });
  private readonly extensions = new Map<string, Extension>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly operationSessions = new Map<string, string>();
  private cleanupFailed = false;
  private readonly forkReaderClosers = new WeakMap<ReadContext, () => void>();
  private readonly forkViewRefs = new WeakMap<ReadContext, Map<string, () => Promise<void>>>();
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly options: ExtensionHostOptions;
  constructor(options: ExtensionHostOptions) {
    this.options = options;
    for (const extension of options.extensions) {
      for (const job of extension.jobs ?? []) {
        if (this.jobs.has(job.id)) throw new AgentError('job_definition_conflict');
        this.validator.compile(job.inputSchema);
        this.jobs.set(job.id, Object.freeze({ ...job }));
      }
      for (const definitions of [extension.actions ?? [], extension.queries ?? []]) {
        const names = new Set<string>();
        for (const definition of definitions) {
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(definition.id) || names.has(definition.id))
            throw new AgentError('extension_definition_conflict');
          names.add(definition.id);
          this.validator.compile(definition.inputSchema);
        }
      }
      for (const query of extension.queries ?? []) this.validator.compile(query.outputSchema);
      for (const definition of extension.records ?? []) this.validator.compile(definition.schema);
      this.extensions.set(extension.id, extension);
    }
  }
  catalogue() {
    return [...this.extensions.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((extension) => ({
        extensionId: extension.id,
        version: extension.version,
        actions: (extension.actions ?? []).map(({ id, version, description, inputSchema }) => ({
          id,
          version,
          description,
          inputSchema,
        })),
        queries: (extension.queries ?? []).map(({ id, version, description, inputSchema }) => ({
          id,
          version,
          description,
          inputSchema,
        })),
      }));
  }
  validateAction(request: {
    extensionId: string;
    actionId: string;
    definitionVersion: string;
    input: Json;
  }) {
    const definition = this.extensions
      .get(request.extensionId)
      ?.actions?.find(
        (action) => action.id === request.actionId && action.version === request.definitionVersion,
      );
    if (!definition) throw new AgentError('action_not_found');
    if (!this.validator.compile(definition.inputSchema)(request.input))
      throw new AgentError('invalid_action_arguments');
  }
  private async readContext(
    sessionId: string,
    extensionId: string,
    stamps?: ReadStamp[],
    subjectId?: string,
    expectedStoreId?: string,
    dispatch?: DispatchCapture,
  ): Promise<ReadContext> {
    const session = await this.options.store.getSession(sessionId);
    if (!session || session.deletedAt !== null) throw new AgentError('session_not_found');
    const read = async <T>(load: () => Promise<T>): Promise<T> => {
      const value = await load();
      if (stamps) stamps.push({ read: load, digest: await semanticDigest(json(value)) });
      return value;
    };
    let forkReaderOpen = true;
    const viewRefs = new Map<string, () => Promise<void>>();
    const checkOpen = () => {
      if (!forkReaderOpen || (dispatch && !dispatch.open))
        throw new AgentError('dispatch_read_context_closed');
    };
    const context: ReadContext = {
      sessionId,
      readExecutionGroupSafety: async () => {
        if (!subjectId || !expectedStoreId) throw new AgentError('execution_group_scope_denied');
        return this.options.store.readExecutionGroupSafety({
          expectedStoreId,
          subjectId,
          sessionId,
          ...(dispatch ? { boundaryCommandId: dispatch.commandId } : {}),
        });
      },
      requireExecutionGroupQuiescent: async () => {
        if (!dispatch?.open || !subjectId || !expectedStoreId)
          throw new AgentError('execution_group_guard_boundary_invalid');
        const fact = await this.options.store.readExecutionGroupSafety({
          expectedStoreId,
          subjectId,
          sessionId,
          boundaryCommandId: dispatch.commandId,
        });
        if (!fact.quiescent) throw new AgentError('execution_group_not_quiescent');
        if (
          dispatch.contextRevision !== undefined &&
          dispatch.contextRevision !== fact.contextRevision
        )
          throw new AgentError('context_refresh_required');
        dispatch.contextRevision = fact.contextRevision;
        dispatch.guard = {
          kind: 'execution_group_quiescence',
          version: 1,
          rootSessionId: fact.rootSessionId,
          originCommandId: dispatch.commandId,
        };
        return fact;
      },
      readRunExecutionSafety: (runId) =>
        read(async () => {
          if (!subjectId || !expectedStoreId) throw new AgentError('execution_safety_scope_denied');
          return this.options.store.readRunExecutionSafety({
            expectedStoreId,
            subjectId,
            sessionId,
            runId,
          });
        }),
      openForkSourceProjection: async (localKey) => {
        checkOpen();
        if (!subjectId || !expectedStoreId) throw new AgentError('fork_source_unverifiable');
        const input = { expectedStoreId, subjectId, sessionId, extensionId, localKey };
        const observed = await read(() => this.options.store.readForkSourceProjection(input));
        checkOpen();
        const recheck = async () => {
          checkOpen();
          const current = await this.options.store.readForkSourceProjection(input);
          checkOpen();
          if (canonicalJson(json(current.binding)) !== canonicalJson(json(observed.binding)))
            throw new AgentError('dispatch_read_set_changed');
          return current;
        };
        if (dispatch) {
          const prior = dispatch.sourceForks.get(localKey);
          if (prior && canonicalJson(json(prior)) !== canonicalJson(json(observed.binding)))
            throw new AgentError('dispatch_read_set_invalid');
          dispatch.sourceForks.set(localKey, observed.binding);
          if (
            dispatch.sourceForks.size + dispatch.forks.size > 64 ||
            Buffer.byteLength(
              canonicalJson(
                json([
                  ...dispatch.records.values(),
                  ...dispatch.forks.values(),
                  ...dispatch.sourceForks.values(),
                ]),
              ),
            ) >
              32 * 1024
          )
            throw new AgentError('dispatch_read_set_invalid');
        }
        const source = (id: string) => {
          checkOpen();
          const result = observed.proof.sources.find((s) => s.executionId === id);
          if (!result) throw new AgentError('fork_source_scope_denied');
          return result;
        };
        const model = (id: string) => {
          const s = source(id);
          if (s.kind !== 'model') throw new AgentError('fork_source_scope_denied');
          return s;
        };
        for (const ref of observed.proof.sources.flatMap((s) => s.artifactRefs))
          viewRefs.set(
            canonicalJson(
              json({ id: ref.id, mediaType: ref.mediaType, size: ref.size, scope: ref.scope }),
            ),
            async () => {
              const fresh = await this.options.store.readForkSourceProjection(input);
              if (canonicalJson(json(fresh.binding)) !== canonicalJson(json(observed.binding)))
                throw new AgentError('artifact_reference_invalid');
            },
          );
        return {
          storeId: expectedStoreId,
          sessionId,
          aliases: structuredClone(observed.aliases),
          sources: structuredClone(observed.proof.sources),
          getMessage: async (messageId) => {
            await recheck();
            const message = await this.options.store.readForkSourceMessage({ ...input, messageId });
            await recheck();
            return message;
          },
          getExecution: async (id) => {
            source(id);
            await recheck();
            const value = publicExecution(await this.options.store.getExecution(id));
            await recheck();
            return value;
          },
          getRun: async (id) => {
            checkOpen();
            if (!observed.proof.sources.some((s) => s.runId === id))
              throw new AgentError('fork_source_scope_denied');
            await recheck();
            const value = publicRun(await this.options.store.getRun(id));
            await recheck();
            return value;
          },
          readModelInput: async (id) => {
            const s = model(id);
            await recheck();
            if (!this.options.forkSourceReaders)
              throw new AgentError('fork_source_reader_unavailable');
            const value = await this.options.forkSourceReaders.readModelInput({
              expectedStoreId,
              subjectId,
              sessionId: s.sessionId,
              executionId: id,
            });
            await recheck();
            if (
              value.bodyHash !== observed.proof.models.find((m) => m.executionId === id)?.inputHash
            )
              throw new AgentError('fork_source_body_changed');
            return value;
          },
          readModelOutput: async (id) => {
            const s = model(id);
            await recheck();
            if (!this.options.forkSourceReaders)
              throw new AgentError('fork_source_reader_unavailable');
            const value = await this.options.forkSourceReaders.readModelOutput({
              expectedStoreId,
              subjectId,
              sessionId: s.sessionId,
              executionId: id,
            });
            await recheck();
            if (
              !value.output.complete ||
              value.bodyHash !== observed.proof.models.find((m) => m.executionId === id)?.outputHash
            )
              throw new AgentError('fork_source_body_changed');
            return value;
          },
          artifacts: {
            read: async (ref) => {
              checkOpen();
              const original = observed.proof.sources
                .flatMap((s) => s.artifactRefs)
                .find((r) => r.id === ref.id);
              if (
                !original ||
                original.mediaType !== ref.mediaType ||
                original.size !== ref.size ||
                canonicalJson(json(original.scope)) !== canonicalJson(json(ref.scope))
              )
                throw new AgentError('fork_source_scope_denied');
              await recheck();
              if (!this.options.forkSourceReaders)
                throw new AgentError('fork_source_reader_unavailable');
              const value = await this.options.forkSourceReaders.readArtifact({
                expectedStoreId,
                subjectId,
                sessionId: original.sessionId,
                refId: original.id,
                scope: original.scope,
              });
              await recheck();
              if (
                String(value.content.byteLength) !== original.size ||
                (await semanticDigestBytes(value.content)) !== original.hash
              )
                throw new AgentError('fork_source_media_invalid');
              return value.content;
            },
          },
        };
      },
      readForkRecordSources: async (localKey) => {
        if (!forkReaderOpen || (dispatch && !dispatch.open))
          throw new AgentError('dispatch_read_context_closed');
        if (!subjectId || !expectedStoreId) throw new AgentError('fork_record_source_unverifiable');
        const result = await read(() =>
          this.options.store.readForkRecordSources({
            expectedStoreId,
            subjectId,
            sessionId,
            extensionId,
            localKey,
          }),
        );
        if (!forkReaderOpen) throw new AgentError('dispatch_read_context_closed');
        if (dispatch) {
          if (!dispatch.open) throw new AgentError('dispatch_read_context_closed');
          const prior = dispatch.forks.get(localKey);
          if (prior && canonicalJson(json(prior)) !== canonicalJson(json(result.binding)))
            throw new AgentError('dispatch_read_set_invalid');
          for (const record of result.records) {
            const observed = {
              extensionId: record.extensionId,
              sessionId: record.sessionId,
              key: record.key,
              revision: record.revision,
              originStoreId: record.originStoreId,
              digest: await semanticDigest(json(record)),
            };
            const identity = canonicalJson([record.extensionId, record.sessionId, record.key]);
            const before = dispatch.records.get(identity);
            if (
              (before && canonicalJson(json(before)) !== canonicalJson(json(observed))) ||
              (!before && dispatch.records.size >= 64)
            )
              throw new AgentError('dispatch_read_set_invalid');
            dispatch.records.set(identity, observed);
          }
          dispatch.forks.set(localKey, result.binding);
          if (
            Buffer.byteLength(canonicalJson(json([...dispatch.records.values()]))) +
              Buffer.byteLength(canonicalJson(json([...dispatch.forks.values()]))) >
            32 * 1024
          )
            throw new AgentError('dispatch_read_set_invalid');
        }
        return result;
      },
      getRun: (id) =>
        read(async () => {
          const run = await this.options.store.getRun(id);
          if (run && run.sessionId !== sessionId) throw new AgentError('permission_denied');
          return publicRun(run);
        }),
      getExecution: (id) =>
        read(async () => {
          const execution = await this.options.store.getExecution(id);
          if (execution && execution.sessionId !== sessionId)
            throw new AgentError('permission_denied');
          return publicExecution(execution);
        }),
      getInteraction: (id) =>
        read(async () => {
          const interaction = await this.options.store.getInteraction({
            expectedStoreId: expectedStoreId ?? (await this.options.store.getMetadata()).storeId,
            sessionId,
            interactionId: id,
          });
          if (!interaction) return null;
          if (interaction.sessionId !== sessionId) throw new AgentError('permission_denied');
          return {
            id: interaction.id,
            originStoreId: interaction.originStoreId,
            sessionId: interaction.sessionId,
            runId: interaction.runId,
            executionId: interaction.executionId,
            attempt: interaction.attempt,
            kind: interaction.kind,
            definitionId: interaction.definitionId,
            definitionVersion: interaction.definitionVersion,
            inputDigest: interaction.inputDigest,
            request: structuredClone(interaction.request),
            answer: structuredClone(interaction.answer),
            revision: interaction.revision,
            acceptedDecisionRevision: interaction.acceptedDecisionRevision,
            state: interaction.state,
          };
        }),
      ...(this.options.artifacts && subjectId
        ? {
            artifacts: {
              read: async (ref: ArtifactRef) => {
                if (!ref.scope) throw new AgentError('artifact_scope_required');
                const input = {
                  expectedStoreId:
                    expectedStoreId ?? (await this.options.store.getMetadata()).storeId,
                  sessionId,
                  subjectId,
                  refId: ref.id,
                  scope: ref.scope,
                };
                const original = await read(() => this.options.store.getArtifactReference(input));
                if (!original || original.mediaType !== ref.mediaType || original.size !== ref.size)
                  throw new AgentError('artifact_reference_invalid');
                return this.options.artifacts!.read(input);
              },
            },
          }
        : {}),
      records: {
        get: async (key) => {
          if (dispatch && !dispatch.open) throw new AgentError('dispatch_read_context_closed');
          const record = await read(() =>
            this.options.store.getExtensionRecord({ sessionId, extensionId, key }),
          );
          if (dispatch) {
            if (!dispatch.open) throw new AgentError('dispatch_read_context_closed');
            const observed = {
              extensionId,
              sessionId,
              key,
              revision: record?.revision ?? null,
              originStoreId: record?.originStoreId ?? null,
              digest: await semanticDigest(json(record)),
            };
            const identity = canonicalJson([extensionId, sessionId, key]);
            const prior = dispatch.records.get(identity);
            if (
              (prior &&
                canonicalJson(prior as unknown as Json) !==
                  canonicalJson(observed as unknown as Json)) ||
              (!prior && dispatch.records.size >= 64)
            )
              throw new AgentError('dispatch_read_set_invalid');
            dispatch.records.set(identity, observed);
          }
          return record;
        },
        list: async (options) => {
          if (dispatch && !dispatch.open) throw new AgentError('dispatch_read_context_closed');
          const records = await read(() =>
            this.options.store.listExtensionRecords({ sessionId, extensionId, ...options }),
          );
          if (dispatch) {
            if (!dispatch.open) throw new AgentError('dispatch_read_context_closed');
            const query = {
              extensionId,
              sessionId,
              afterKey: options?.afterKey ?? '',
              limit: Math.max(1, Math.min(200, options?.limit ?? 100)),
              contentType: options?.contentType || null,
            };
            const key = canonicalJson(query);
            const observed = { ...query, digest: await semanticDigest(json(records)) };
            const prior = dispatch.lists.get(key);
            if (
              (prior && prior.digest !== observed.digest) ||
              (!prior && dispatch.lists.size >= 64)
            )
              throw new AgentError('dispatch_read_set_invalid');
            dispatch.lists.set(key, observed);
          }
          return records;
        },
      },
    };
    this.forkViewRefs.set(context, viewRefs);
    this.forkReaderClosers.set(context, () => {
      forkReaderOpen = false;
    });
    return context;
  }
  async conditionContext(
    scope: ToolScope,
    reference: RequirementRef,
    onRecord: (record: Awaited<ReturnType<ReadContext['records']['get']>>, key: string) => void,
    boundaryExecutionId?: string,
  ): Promise<ConditionReadContext> {
    const command =
      'run' in scope
        ? await this.options.store.getCommand(scope.run.originCommandId)
        : scope.command;
    if (!command) throw new AgentError('command_not_found');
    const context = await this.readContext(
      reference.sessionId,
      reference.extensionId,
      undefined,
      command.subjectId,
      command.originStoreId,
    );
    return {
      sessionId: context.sessionId,
      readRunExecutionSafety: async (runId) => {
        if (runId !== reference.runId) throw new AgentError('execution_safety_scope_denied');
        const boundary = boundaryExecutionId
          ? await this.options.store.getExecution(boundaryExecutionId)
          : null;
        return this.options.store.readRunExecutionSafety({
          expectedStoreId: command.originStoreId,
          subjectId: command.subjectId,
          sessionId: reference.sessionId,
          runId,
          ...(boundary?.kind === 'tool' && boundary.runId === runId
            ? { excludeExecutionId: boundary.id }
            : {}),
        });
      },
      getRun: context.getRun,
      getExecution: context.getExecution,
      getInteraction: context.getInteraction,
      readMutationFacts: (options) =>
        this.options.store.listMutationFacts({
          expectedStoreId: command.originStoreId,
          requirement: reference,
          ...options,
        }),
      records: {
        get: async (key) => {
          const record = await context.records.get(key);
          onRecord(record, key);
          return record;
        },
      },
    };
  }
  async contextSources(input: {
    command: CommandRecord;
    extensions: readonly Extension[];
    request: SourceRequest;
  }): Promise<ContextSource[]> {
    if (input.request.sessionId !== input.command.sessionId)
      throw new AgentError('invalid_extension_scope');
    const result: ContextSource[] = [];
    for (const extension of input.extensions) {
      if (!extension.context) continue;
      const context = await this.readContext(
        input.command.sessionId,
        extension.id,
        undefined,
        input.command.subjectId,
        input.command.originStoreId,
      );
      let sources: ContextSource[];
      try {
        sources = await extension.context.capture(structuredClone(input.request), context);
      } finally {
        this.forkReaderClosers.get(context)?.();
      }
      if (!Array.isArray(sources) || sources.length > 128)
        throw new AgentError('context_source_budget_exceeded');
      for (const source of sources) {
        assertContextSource(source);
        if (!source.id.startsWith(`${extension.id}:`))
          throw new AgentError('extension_source_namespace_mismatch');
        result.push({ ...structuredClone(source), role: 'user' });
      }
    }
    return result;
  }
  async initializationContext(input: {
    command: CommandRecord;
    runId: string;
    owner: OwnerRef;
    extension: Extension;
    signal: AbortSignal;
  }): Promise<RunInitializationContext> {
    const read = await this.readContext(
      input.command.sessionId,
      input.extension.id,
      undefined,
      input.command.subjectId,
      input.command.originStoreId,
    );
    return {
      sessionId: read.sessionId,
      getRun: read.getRun,
      getExecution: read.getExecution,
      getInteraction: read.getInteraction,
      records: {
        get: read.records.get,
        create: async (value) => {
          input.signal.throwIfAborted();
          const schema = input.extension.records?.find(
            (record) =>
              record.contentType === value.contentType &&
              record.contentVersion === value.contentVersion,
          );
          if (!schema || !this.validator.compile(schema.schema)(value.value))
            throw new AgentError('extension_record_format_unavailable');
          return this.options.store.initializeRunRecord({
            expectedStoreId: input.command.originStoreId,
            owner: input.owner,
            runId: input.runId,
            extensionId: input.extension.id,
            write: value,
          });
        },
      },
    };
  }
  async query(input: {
    sessionId: string;
    extensionId: string;
    queryId: string;
    input: Json;
    subjectId?: string;
    expectedStoreId?: string;
  }): Promise<PublicView[]> {
    const extension = this.extensions.get(input.extensionId);
    const definition = extension?.queries?.find((query) => query.id === input.queryId);
    if (!definition) throw new AgentError('query_not_found');
    if (!this.validator.compile(definition.inputSchema)(input.input))
      throw new AgentError('invalid_query_arguments');
    const expectedStoreId =
      input.expectedStoreId ?? (await this.options.store.getMetadata()).storeId;
    const context = await this.readContext(
      input.sessionId,
      input.extensionId,
      undefined,
      input.subjectId,
      expectedStoreId,
    );
    let views: PublicView[];
    try {
      views = await definition.execute(input.input, context);
    } finally {
      this.forkReaderClosers.get(context)?.();
    }
    if (
      !this.validator.compile(definition.outputSchema)(views) ||
      views.length > 200 ||
      JSON.stringify(views).length > 1024 * 1024 ||
      views.some((view) => view.extensionId !== input.extensionId)
    )
      throw new AgentError('invalid_public_view');
    for (const view of views)
      for (const ref of view.artifactRefs) {
        if (!input.subjectId || !ref.scope) throw new AgentError('artifact_scope_required');
        const delegated = this.forkViewRefs.get(context)?.get(canonicalJson(json(ref)));
        if (delegated) {
          await delegated();
          continue;
        }
        const original = await this.options.store.getArtifactReference({
          expectedStoreId,
          sessionId: input.sessionId,
          subjectId: input.subjectId,
          refId: ref.id,
          scope: ref.scope,
        });
        if (!original || original.mediaType !== ref.mediaType || original.size !== ref.size)
          throw new AgentError('artifact_reference_invalid');
      }
    return views;
  }
  private async checkFreshness(
    stamps: ReadStamp[],
    sourceRequest: SourceRequest,
    captured: ContextSource[],
  ) {
    for (const stamp of stamps)
      if ((await semanticDigest(json(await stamp.read()))) !== stamp.digest)
        throw new AgentError('context_refresh_required');
    const current = (await this.options.sources?.capture(sourceRequest)) ?? [];
    if ((await semanticDigest(json(current))) !== (await semanticDigest(json(captured))))
      throw new AgentError('context_refresh_required');
  }
  async run(command: CommandRecord, owner: OwnerRef, controller: AbortController): Promise<void> {
    const request = command.request as {
      extensionId: string;
      actionId: string;
      definitionVersion: string;
      input: Json;
    };
    const extension = this.extensions.get(request.extensionId);
    const definition = extension?.actions?.find(
      (action) => action.id === request.actionId && action.version === request.definitionVersion,
    );
    if (!extension || !definition) throw new AgentError('action_not_found');
    if (!this.validator.compile(definition.inputSchema)(request.input))
      throw new AgentError('invalid_action_arguments');
    const session = await this.options.store.getSession(command.sessionId);
    if (!session) throw new AgentError('session_not_found');
    const sourceRequest: SourceRequest = {
      sessionId: command.sessionId,
      workspaceId: session.workspaceId,
      definitionId: `${extension.id}/${definition.id}`,
      input: request.input,
    };
    let predecessorExecutionId: string | undefined;
    let attempt = 1;
    try {
      for (let preparation = 0; preparation < 2; preparation++) {
        controller.signal.throwIfAborted();
        const stamps: ReadStamp[] = [];
        const dispatch: DispatchCapture = {
          open: true,
          commandId: command.id,
          records: new Map(),
          lists: new Map(),
          forks: new Map(),
          sourceForks: new Map(),
        };
        const context = await this.readContext(
          command.sessionId,
          request.extensionId,
          stamps,
          command.subjectId,
          command.originStoreId,
          dispatch,
        );
        const captured = (await this.options.sources?.capture(sourceRequest)) ?? [];
        let prepared: Json;
        try {
          prepared = await definition.prepare(request.input, context);
        } finally {
          dispatch.open = false;
          this.forkReaderClosers.get(context)?.();
        }
        try {
          await this.checkFreshness(stamps, sourceRequest, captured);
        } catch (error) {
          if (
            error instanceof AgentError &&
            error.code === 'context_refresh_required' &&
            preparation === 0
          )
            continue;
          throw error;
        }
        const executionId = crypto.randomUUID();
        const recordReads = structuredClone([...dispatch.records.values()]);
        const recordListReads = structuredClone([...dispatch.lists.values()]);
        const forkSourceBindings = structuredClone([...dispatch.sourceForks.values()]);
        const forkBindings = structuredClone([...dispatch.forks.values()]);
        const guard = dispatch.guard === undefined ? undefined : structuredClone(dispatch.guard);
        const contextRevision = dispatch.contextRevision;
        const source: Json = {
          kind: 'action_decision',
          commandId: command.id,
          extensionId: extension.id,
          actionId: definition.id,
          definitionVersion: definition.version,
          preparedDigest: await semanticDigest(prepared),
          sources: json(captured),
          reads: stamps.map((stamp) => stamp.digest),
          recordReads: recordReads as unknown as Json,
          recordListReads: recordListReads as unknown as Json,
          ...(forkSourceBindings.length
            ? { forkSourceBindings: forkSourceBindings as unknown as Json }
            : {}),
          ...(forkBindings.length ? { forkBindings: forkBindings as unknown as Json } : {}),
          ...(guard === undefined ? {} : { guard: guard as unknown as Json }),
          ...(contextRevision === undefined ? {} : { contextRevision }),
        };
        const scope: StandaloneScope = {
          command,
          owner,
          workspaceId: session.workspaceId,
          signal: controller.signal,
          checkFreshness: () => this.checkFreshness(stamps, sourceRequest, captured),
          bindings: this.options.actionBindings,
          captureDispatchReadSet: async (actualExecutionId) => {
            if (actualExecutionId !== executionId)
              throw new AgentError('dispatch_read_set_invalid');
            const records = structuredClone(recordReads);
            const recordLists = structuredClone(recordListReads);
            if (!guard)
              return {
                records,
                recordLists,
                ...(forkBindings.length ? { forkBindings } : {}),
                ...(forkSourceBindings.length ? { forkSourceBindings } : {}),
              };
            const actual = await this.options.store.readExecutionGroupSafety({
              expectedStoreId: command.originStoreId,
              sessionId: command.sessionId,
              subjectId: command.subjectId,
              boundaryCommandId: command.id,
              excludeExecutionId: actualExecutionId,
            });
            if (actual.rootSessionId !== guard.rootSessionId || !actual.quiescent)
              throw new AgentError('execution_group_not_quiescent');
            return {
              records,
              recordLists,
              ...(forkBindings.length ? { forkBindings } : {}),
              ...(forkSourceBindings.length ? { forkSourceBindings } : {}),
              executionGroup: {
                rootSessionId: actual.rootSessionId,
                executionId: actualExecutionId,
                revision: actual.revision,
                ...(contextRevision === undefined ? {} : { contextRevision }),
                quiescent: true,
              },
            };
          },
        };
        const result = await this.options.execution.action(scope, {
          executionId,
          extensionId: extension.id,
          definition,
          prepared,
          decisionSource: source,
          reprepareOnFreshness: preparation === 0,
          ...(predecessorExecutionId ? { predecessorExecutionId, attempt } : {}),
          execute: async (signal) => {
            const read = await this.readContext(
              command.sessionId,
              request.extensionId,
              undefined,
              command.subjectId,
              command.originStoreId,
            );
            try {
              return await definition.execute(
                prepared,
                this.actionContext(
                  read,
                  {
                    ...scope,
                    signal,
                    // Dispatch consumed preparation record preconditions; child effects still authorize independently.
                    checkFreshness: () => this.checkFreshness([], sourceRequest, captured),
                  },
                  extension,
                  definition,
                  executionId,
                  source,
                ),
              );
            } finally {
              this.forkReaderClosers.get(read)?.();
            }
          },
        });
        const details = result.details;
        if (
          preparation === 0 &&
          details &&
          typeof details === 'object' &&
          !Array.isArray(details) &&
          details.code === 'context_refresh_required' &&
          details.adapterAttempted === false
        ) {
          predecessorExecutionId = executionId;
          attempt++;
          continue;
        }
        return;
      }
    } catch (error) {
      if (predecessorExecutionId) {
        const current = await this.options.store.getCommand(command.id);
        const receipt = current?.receipt as {
          executionId?: string;
          preparingNextAttempt?: boolean;
        } | null;
        if (receipt?.executionId === predecessorExecutionId && receipt.preparingNextAttempt)
          await this.options.store.stopActionPreparation({
            expectedStoreId: command.originStoreId,
            owner,
            commandId: command.id,
            predecessorExecutionId,
            reason: error instanceof AgentError ? error.code : 'action_preparation_failed',
            cancelled: controller.signal.aborted,
          });
      }
      throw error;
    }
  }
  async toolContext(
    scope: ToolScope,
    definition: ToolDefinition,
    executionId: string,
    source: Json,
  ): Promise<ActionContext> {
    const extension = [...(scope.bindings?.extensions ?? this.extensions.values())].find(
      (candidate) =>
        candidate.tools?.some(
          (tool) => tool.id === definition.id && tool.version === definition.version,
        ),
    );
    if (!extension) throw new AgentError('tool_not_available');
    const command =
      'run' in scope
        ? await this.options.store.getCommand(scope.run.originCommandId)
        : scope.command;
    if (!command) throw new AgentError('command_not_found');
    const standalone: StandaloneScope = {
      command,
      owner: scope.owner,
      workspaceId: scope.workspaceId,
      signal: scope.signal,
      checkFreshness: scope.checkFreshness,
      checkpoint: scope.checkpoint,
      requirements: 'run' in scope ? scope.run.requirements : scope.requirements,
      bindings: scope.bindings,
    };
    return this.actionContext(
      await this.readContext(
        command.sessionId,
        extension.id,
        undefined,
        command.subjectId,
        command.originStoreId,
      ),
      standalone,
      extension,
      definition,
      executionId,
      source,
    );
  }
  hasActiveOperations(sessionId: string): boolean {
    return [...this.operationSessions.values()].includes(sessionId);
  }
  private actionContext(
    read: ReadContext,
    scope: StandaloneScope,
    extension: Extension,
    definition: ActionDefinition | ToolDefinition,
    executionId: string,
    source: Json,
  ): ActionContext {
    const { artifacts: artifactReader, ...projection } = read;
    // Tool callback lifetimes are owned by UnifiedExecution; this observer is only exposed
    // through Host-owned prepare/execute/query callbacks with an explicit close boundary.
    if (!('prepare' in definition)) {
      delete projection.readForkRecordSources;
      delete projection.openForkSourceProjection;
    }
    projection.readExecutionGroupSafety = () =>
      this.options.store.readExecutionGroupSafety({
        expectedStoreId: scope.command.originStoreId,
        subjectId: scope.command.subjectId,
        sessionId: scope.command.sessionId,
        boundaryCommandId: scope.command.id,
        ...((source as { guard?: Json }).guard ? { excludeExecutionId: executionId } : {}),
      });
    projection.requireExecutionGroupQuiescent = async () => {
      if (!(source as { guard?: Json }).guard)
        throw new AgentError('execution_group_guard_boundary_invalid');
      const fact = await projection.readExecutionGroupSafety!();
      if (!fact.quiescent) throw new AgentError('execution_group_not_quiescent');
      return fact;
    };
    projection.readRunExecutionSafety = (runId) =>
      this.options.store.readRunExecutionSafety({
        expectedStoreId: scope.command.originStoreId,
        subjectId: scope.command.subjectId,
        sessionId: scope.command.sessionId,
        runId,
        excludeExecutionId: executionId,
      });
    const write = async (value: ExtensionRecordWrite) => {
      scope.signal.throwIfAborted();
      const schema = extension.records?.find(
        (record) =>
          record.contentType === value.contentType &&
          record.contentVersion === value.contentVersion,
      );
      if (!schema || !this.validator.compile(schema.schema)(value.value))
        throw new AgentError('extension_record_format_unavailable');
      const prior = await read.records.get(value.key);
      if (
        prior &&
        (prior.contentType !== value.contentType || prior.contentVersion !== value.contentVersion)
      )
        throw new AgentError('extension_record_format_unavailable');
      return this.options.store.writeExtensionRecord({
        expectedStoreId: scope.command.originStoreId,
        owner: scope.owner,
        extensionId: extension.id,
        sessionId: scope.command.sessionId,
        originCommandId: scope.command.id,
        originExecutionId: executionId,
        write: value,
      });
    };
    const get = async (ref: OperationRef) => {
      if (ref.extensionId !== extension.id || ref.sessionId !== scope.command.sessionId)
        throw new AgentError('permission_denied');
      const original = await this.options.store.getOperation({
        extensionId: extension.id,
        sessionId: scope.command.sessionId,
        key: ref.key,
        originStoreId: ref.originStoreId,
        subjectId: scope.command.subjectId,
      });
      if (!original || original.commandId !== ref.commandId)
        throw new AgentError('operation_not_found');
      return original.executionId
        ? publicExecution(await this.options.store.getExecution(original.executionId))
        : null;
    };
    const readAgent = async (ref: OperationRef) => {
      if (
        ref.originStoreId !== scope.command.originStoreId ||
        (await this.options.store.getMetadata()).storeId !== scope.command.originStoreId
      )
        throw new AgentError('store_identity_mismatch');
      const projection = await get(ref);
      if (!projection || projection.id !== ref.executionId)
        throw new AgentError('operation_not_found');
      const carrier = await this.options.store.getExecution(projection.id);
      if (
        !carrier?.childSessionId ||
        carrier.kind !== 'job' ||
        (ref.childSessionId !== undefined && ref.childSessionId !== carrier.childSessionId)
      )
        throw new AgentError('invalid_child_execution');
      const session = await this.options.store.getSession(carrier.childSessionId);
      if (!session || session.parentSessionId !== scope.command.sessionId)
        throw new AgentError('invalid_child_execution');
      const handle = carrier.reference;
      const runId =
        handle &&
        typeof handle === 'object' &&
        !Array.isArray(handle) &&
        typeof handle.runId === 'string'
          ? handle.runId
          : null;
      const run = runId ? await this.options.store.getRun(runId) : null;
      if (run) {
        const command = await this.options.store.getCommand(run.originCommandId);
        const request = command?.request;
        if (
          run.sessionId !== carrier.childSessionId ||
          run.originStoreId !== carrier.originStoreId ||
          run.rootWorkCommandId !== carrier.rootWorkCommandId ||
          run.rootWorkSeq !== carrier.rootWorkSeq ||
          !request ||
          typeof request !== 'object' ||
          Array.isArray(request) ||
          run.originCommandId !== `child-start-${carrier.id}` ||
          !['child.start', 'input.follow_up'].includes(String(request.kind)) ||
          (request.kind === 'child.start' && request.parentExecutionId !== carrier.id)
        )
          throw new AgentError('operation_unverifiable');
      }
      return {
        execution: projection,
        childSessionId: session.id,
        contextSelectionId: session.contextSelectionId,
        run: run ? { ...publicRun(run)!, deadlineAt: run.deadlineAt } : null,
      };
    };
    const waitAny = async (
      refs: readonly OperationRef[],
      options: { signal?: AbortSignal; timeoutMs?: number } = {},
      observeUpdates = true,
    ) => {
      if (
        !Array.isArray(refs) ||
        !refs.length ||
        refs.length > 64 ||
        new Set(refs.map((ref) => ref.commandId)).size !== refs.length
      )
        throw new AgentError('invalid_wait_targets');
      const timeout = options.timeoutMs ?? 30000;
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 30000)
        throw new AgentError('invalid_wait_timeout');
      const originExecution = await this.options.store.getExecution(executionId);
      const run = originExecution?.runId
        ? await this.options.store.getRun(originExecution.runId)
        : null;
      const current = run;
      const deadline = Math.min(
        Date.now() + timeout,
        current?.deadlineAt ?? Number.MAX_SAFE_INTEGER,
      );
      const signal = options.signal
        ? AbortSignal.any([scope.signal, options.signal])
        : scope.signal;
      let cursor = (await this.options.store.getMetadata()).lastChangeCursor;
      for (;;) {
        signal.throwIfAborted();
        const executions = await Promise.all(
          refs.map(async (ref) => {
            if (ref.originStoreId !== scope.command.originStoreId)
              throw new AgentError('store_identity_mismatch');
            const actual = await get(ref);
            if (!actual || (ref.executionId !== null && actual.id !== ref.executionId))
              throw new AgentError('operation_unverifiable');
            return actual;
          }),
        );
        if (executions.some((item) => terminal.has(item.status)))
          return { reason: 'terminal' as const, executions };
        for (const ref of observeUpdates ? refs : []) {
          if (ref.childSessionId) {
            const summary = await this.options.store.getAgentSummary({
              expectedStoreId: scope.command.originStoreId,
              ref,
              subjectId: scope.command.subjectId,
            });
            if (summary.waitingInteractionId) return { reason: 'interaction' as const, executions };
          }
        }
        if (Date.now() >= deadline) return { reason: 'timeout' as const, executions };
        if (!this.options.waitForChange) throw new AgentError('wait_unavailable');
        const events = await this.options.waitForChange(cursor, signal, deadline - Date.now());
        if (events.length) cursor = events.at(-1)!.cursor;
        else cursor = (await this.options.store.getMetadata()).lastChangeCursor;
        for (const event of observeUpdates ? events : []) {
          if (
            event.type === 'command.accepted' &&
            event.sessionId === scope.command.sessionId &&
            run
          ) {
            const input = await this.options.store.getCommand(event.objectId);
            const body = input?.request;
            if (
              body &&
              typeof body === 'object' &&
              !Array.isArray(body) &&
              (body.kind === 'input.steer' || body.kind === 'result.include') &&
              body.targetRunId === run.id
            )
              return { reason: 'input' as const, executions };
          }
          if (event.type === 'interaction.created' || event.type === 'interaction.requested') {
            const interaction = await this.options.store.getInteraction({
              expectedStoreId: scope.command.originStoreId,
              sessionId: scope.command.sessionId,
              interactionId: event.objectId,
            });
            if (
              interaction &&
              refs.some(
                (ref) =>
                  ref.executionId === interaction.executionId ||
                  (ref.childSessionId !== undefined &&
                    interaction.ancestry.includes(ref.childSessionId)),
              )
            )
              return { reason: 'interaction' as const, executions };
          }
        }
      }
    };
    const requestInteractionWithReceipt = this.options.execution.interactionRequesterWithReceipt(
      scope,
      executionId,
    );
    const requestInteraction = async (input: {
      kind: 'question' | 'plan_review';
      request: Json;
    }) => {
      const { answer } = await requestInteractionWithReceipt(input);
      return answer.kind === 'question' ? answer.answers : (answer as unknown as Json);
    };
    return {
      ...projection,
      executionId,
      signal: scope.signal,
      requestInput: (request) => requestInteraction({ kind: 'question', request }),
      requestInteraction,
      requestInteractionWithReceipt,
      requirements: {
        register: async (references) => {
          scope.signal.throwIfAborted();
          const current = await this.options.store.getExecution(executionId);
          if (!current?.runId) throw new AgentError('requirement_run_required');
          if (!Array.isArray(references) || references.length > 64)
            throw new AgentError('requirement_limit');
          const run = await this.options.store.registerRunRequirements({
            expectedStoreId: scope.command.originStoreId,
            owner: scope.owner,
            runId: current.runId,
            requirements: references.map((reference) => {
              if (
                Object.keys(reference).some(
                  (key) =>
                    ![
                      'definitionVersion',
                      'requirementId',
                      'revision',
                      'phase',
                      'executionId',
                      'attempt',
                      'recordKey',
                    ].includes(key),
                )
              )
                throw new AgentError('invalid_requirement');
              return {
                ...reference,
                ...(extension.conditions ? { evaluationProvider: 'extension' as const } : {}),
                extensionId: extension.id,
                sessionId: scope.command.sessionId,
                runId: current.runId!,
              };
            }),
          });
          return run.requirements.filter((reference) => reference.extensionId === extension.id);
        },
      },
      ...(this.options.artifacts
        ? {
            artifacts: {
              read:
                artifactReader?.read ??
                (async () => {
                  throw new AgentError('artifact_content_unavailable');
                }),
              publish: async (input: { key: string; content: Uint8Array; mediaType: string }) => {
                scope.signal.throwIfAborted();
                if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.key))
                  throw new AgentError('artifact_key_invalid');
                const ref = await this.options.artifacts!.publish({
                  expectedStoreId: scope.command.originStoreId,
                  sessionId: scope.command.sessionId,
                  subjectId: scope.command.subjectId,
                  refId: `artifact-${await semanticDigest({ storeId: scope.command.originStoreId, sessionId: scope.command.sessionId, executionId, extensionId: extension.id, key: input.key })}`,
                  scope: { kind: 'execution', id: executionId },
                  content: input.content,
                  mediaType: input.mediaType,
                });
                return { id: ref.id, mediaType: ref.mediaType, size: ref.size, scope: ref.scope };
              },
            },
          }
        : {}),
      mutationFacts: {
        list: async (requirementId, options) => {
          const execution = await this.options.store.getExecution(executionId);
          const run = execution?.runId ? await this.options.store.getRun(execution.runId) : null;
          const reference = run?.requirements.find(
            (ref) =>
              ref.extensionId === extension.id &&
              ref.requirementId === requirementId &&
              ref.runId === run.id,
          );
          if (!reference) throw new AgentError('requirement_scope_mismatch');
          return this.options.store.listMutationFacts({
            expectedStoreId: scope.command.originStoreId,
            requirement: reference,
            ...options,
          });
        },
        commit: async (input) => {
          const execution = await this.options.store.getExecution(executionId);
          const run = execution?.runId ? await this.options.store.getRun(execution.runId) : null;
          const reference = run?.requirements.find(
            (ref) =>
              ref.extensionId === extension.id &&
              ref.requirementId === input.requirementId &&
              ref.runId === run.id,
          );
          if (!reference) throw new AgentError('requirement_scope_mismatch');
          await this.options.store.commitMutationCheck({
            expectedStoreId: scope.command.originStoreId,
            owner: scope.owner,
            requirement: reference,
            executionId,
            mutationExecutionId: input.mutationExecutionId,
            headRevision: input.headRevision,
            outcome: input.outcome,
            evidence: input.evidence,
          });
        },
      },
      records: { ...read.records, write },
      operations: {
        ensure: async (options) => {
          this.options.assertAcceptingWork?.();
          scope.signal.throwIfAborted();
          const admission = (options as { admission?: unknown }).admission;
          if (
            admission !== undefined &&
            (admission !== 'fail_if_full' || options.request.kind !== 'agent')
          )
            throw new AgentError('invalid_operation_admission');
          if (definition.resources?.serial || definition.resources?.slot)
            throw new AgentError('nested_resource_unsupported');
          if (options.request.kind === 'agent') {
            const prior = await this.options.store.getOperation({
              extensionId: extension.id,
              sessionId: scope.command.sessionId,
              key: options.key,
              subjectId: scope.command.subjectId,
              originStoreId: scope.command.originStoreId,
            });
            if (prior) {
              const command = await this.options.store.getCommand(prior.commandId);
              const request = command?.request;
              if (
                !request ||
                typeof request !== 'object' ||
                Array.isArray(request) ||
                request.kind !== 'operation.agent' ||
                request.parentExecutionId !== executionId ||
                request.configurationId !== options.request.configurationId ||
                canonicalJson(request.input as Json) !== canonicalJson(options.request.input) ||
                request.cancellation !== (options.cancellation ?? 'attached') ||
                canonicalJson((request.resultRequirement ?? null) as Json) !==
                  canonicalJson((options.resultRequirement ?? null) as unknown as Json)
              )
                throw new AgentError('operation_conflict');
              return prior;
            }
          }
          if (options.resultRequirement) {
            const requested = options.resultRequirement;
            if (
              !extension.conditions ||
              !extension.records?.some(
                (record) =>
                  record.contentType === requested.contentType &&
                  record.contentVersion === requested.contentVersion,
              )
            )
              throw new AgentError('result_requirement_definition_unavailable');
            if (options.request.kind !== 'agent')
              throw new AgentError('result_requirement_unsupported');
          }
          const agent =
            options.request.kind === 'agent'
              ? await this.options.resolveAgent?.(
                  options.request.configurationId,
                  scope,
                  executionId,
                  source,
                )
              : undefined;
          try {
            if (admission === 'fail_if_full') {
              if (!agent?.reserveForCreation) throw new AgentError('agent_admission_unavailable');
              await agent.reserveForCreation();
            }
            const kind = options.request.kind === 'agent' ? 'job' : options.request.kind;
            const child =
              agent?.definition ??
              (options.request.kind === 'job'
                ? (scope.bindings?.jobs ?? this.jobs).get(options.request.definitionId)
                : options.request.kind === 'tool'
                  ? (scope.bindings?.tools ?? this.options.tools).get(options.request.definitionId)
                  : undefined);
            if (
              !child ||
              (options.request.kind !== 'agent' &&
                child.version !== options.request.definitionVersion) ||
              !this.validator.compile(child.inputSchema)(options.request.input)
            )
              throw new AgentError('operation_definition_unavailable');
            const afterTurnAuthorization = options.continuation
              ? await (async () => {
                  if (
                    options.continuation?.kind !== 'after_turn' ||
                    options.request.kind !== 'agent' ||
                    !agent ||
                    !this.options.authorizeAfterTurn
                  )
                    throw new AgentError('after_turn_not_authorized');
                  return this.options.authorizeAfterTurn(scope, executionId, agent.configuration);
                })()
              : undefined;
            const ref = await this.options.store.ensureOperation({
              expectedStoreId: scope.command.originStoreId,
              owner: scope.owner,
              sessionId: scope.command.sessionId,
              extensionId: extension.id,
              originCommandId: scope.command.id,
              parentExecutionId: executionId,
              operationKey: options.key,
              request: options.request,
              ...(afterTurnAuthorization ? { afterTurnAuthorization } : {}),
              ...(options.resultRequirement
                ? {
                    resultRequirement: options.resultRequirement,
                    resultRequirementSchema: extension.records!.find(
                      (record) =>
                        record.contentType === options.resultRequirement!.contentType &&
                        record.contentVersion === options.resultRequirement!.contentVersion,
                    )!.schema,
                  }
                : {}),
              cancellation: options.cancellation ?? 'attached',
              ...(agent ? { childConfiguration: agent.configuration } : {}),
              ...(options.planRecordKey ? { planRecordKey: options.planRecordKey } : {}),
            });
            const plannedJob =
              ref.executionId &&
              kind === 'job' &&
              (await this.options.store.getExecution(ref.executionId))?.status === 'planned';
            if ((!ref.executionId || plannedJob) && !this.operations.has(ref.commandId)) {
              const releaseBinding = scope.bindings?.retain();
              const task = this.performOperation(
                ref,
                scope,
                executionId,
                source,
                child,
                kind,
              ).finally(async () => {
                try {
                  await releaseBinding?.();
                  await agent?.disposeUnused();
                } catch (error) {
                  this.cleanupFailed = true;
                  throw error;
                }
              });
              this.operations.set(ref.commandId, task);
              this.operationSessions.set(ref.commandId, scope.owner.sessionId);
              void task
                .finally(() => {
                  this.operations.delete(ref.commandId);
                  this.operationSessions.delete(ref.commandId);
                  this.options.onActivity?.(scope.owner.sessionId);
                })
                .catch(() => {});
            } else await agent?.disposeUnused();
            return ref;
          } catch (error) {
            await agent?.disposeUnused();
            throw error;
          }
        },
        get,
        sendAgentInput: async (ref, input) => {
          this.options.assertAcceptingWork?.();
          scope.signal.throwIfAborted();
          if (input.mode === 'follow_up') {
            if (
              Object.keys(input).some(
                (key) =>
                  ![
                    'mode',
                    'key',
                    'afterRunId',
                    'contextSelectionId',
                    'content',
                    'resultRequirement',
                    'continuation',
                  ].includes(key),
              ) ||
              !/^[A-Za-z0-9_.-]{1,128}$/.test(input.key) ||
              !input.content ||
              new TextEncoder().encode(input.content).length > 1024 * 1024
            )
              throw new AgentError('invalid_agent_input');
            const view = await readAgent(ref);
            if (
              !view.run ||
              view.run.id !== input.afterRunId ||
              view.contextSelectionId !== input.contextSelectionId
            )
              throw new AgentError('input_target_changed');
            const previous = await this.options.store.getExecution(view.execution.id);
            const configurationId = previous?.childConfiguration?.id;
            if (!configurationId) throw new AgentError('operation_unverifiable');
            const prepared: Json = {
              content: canonicalJson({
                kind: 'agent_message',
                sourceSessionId: scope.command.sessionId,
                sourceExecutionId: executionId,
                carrierExecutionId: view.execution.id,
                content: input.content,
              }),
            };
            const prior = await this.options.store.getOperation({
              extensionId: extension.id,
              sessionId: scope.command.sessionId,
              key: input.key,
              subjectId: scope.command.subjectId,
              originStoreId: scope.command.originStoreId,
            });
            if (prior) {
              const command = await this.options.store.getCommand(prior.commandId);
              const request = command?.request;
              if (
                !request ||
                typeof request !== 'object' ||
                Array.isArray(request) ||
                request.kind !== 'operation.agent' ||
                request.parentExecutionId !== executionId ||
                request.configurationId !== configurationId ||
                canonicalJson(request.input as Json) !== canonicalJson(prepared) ||
                canonicalJson((request.resultRequirement ?? null) as Json) !==
                  canonicalJson((input.resultRequirement ?? null) as unknown as Json) ||
                Boolean(request.afterTurn) !== Boolean(input.continuation) ||
                canonicalJson(request.followUp as Json) !==
                  canonicalJson({
                    previousCommandId: ref.commandId,
                    previousExecutionId: view.execution.id,
                    childSessionId: view.childSessionId,
                    afterRunId: input.afterRunId,
                    contextSelectionId: input.contextSelectionId,
                  })
              )
                throw new AgentError('operation_conflict');
              return {
                commandId: prior.commandId,
                status: command!.status,
                receipt: { ref: prior } as unknown as Json,
              };
            }
            if (
              input.resultRequirement &&
              (!extension.conditions ||
                !extension.records?.some(
                  (record) =>
                    record.contentType === input.resultRequirement!.contentType &&
                    record.contentVersion === input.resultRequirement!.contentVersion,
                ))
            )
              throw new AgentError('result_requirement_definition_unavailable');
            const agent = await this.options.resolveAgent?.(
              configurationId,
              scope,
              executionId,
              source,
              { executionId: view.execution.id, afterRunId: input.afterRunId },
            );
            if (!agent) throw new AgentError('child_configuration_unavailable');
            try {
              if (!this.validator.compile(agent.definition.inputSchema)(prepared))
                throw new AgentError('operation_definition_unavailable');
              const afterTurnAuthorization = input.continuation
                ? await (async () => {
                    if (
                      input.continuation?.kind !== 'after_turn' ||
                      !this.options.authorizeAfterTurn
                    )
                      throw new AgentError('after_turn_not_authorized');
                    return this.options.authorizeAfterTurn(scope, executionId, agent.configuration);
                  })()
                : undefined;
              const next = await this.options.store.ensureAgentFollowUp({
                expectedStoreId: scope.command.originStoreId,
                owner: scope.owner,
                sessionId: scope.command.sessionId,
                extensionId: extension.id,
                originCommandId: scope.command.id,
                parentExecutionId: executionId,
                operationKey: input.key,
                request: { kind: 'agent', configurationId, input: prepared },
                cancellation: 'detached',
                childConfiguration: agent.configuration,
                ...(afterTurnAuthorization ? { afterTurnAuthorization } : {}),
                ...(input.resultRequirement
                  ? {
                      resultRequirement: input.resultRequirement,
                      resultRequirementSchema: extension.records!.find(
                        (record) =>
                          record.contentType === input.resultRequirement!.contentType &&
                          record.contentVersion === input.resultRequirement!.contentVersion,
                      )!.schema,
                    }
                  : {}),
                previous: ref,
                afterRunId: input.afterRunId,
                contextSelectionId: input.contextSelectionId,
              });
              const planned =
                next.executionId &&
                (await this.options.store.getExecution(next.executionId))?.status === 'planned';
              if (planned && !this.operations.has(next.commandId)) {
                const release = scope.bindings?.retain();
                const task = this.performOperation(
                  next,
                  scope,
                  executionId,
                  source,
                  agent.definition,
                  'job',
                ).finally(async () => {
                  try {
                    await release?.();
                    await agent.disposeUnused();
                  } catch (error) {
                    this.cleanupFailed = true;
                    throw error;
                  }
                });
                this.operations.set(next.commandId, task);
                this.operationSessions.set(next.commandId, scope.owner.sessionId);
                void task
                  .finally(() => {
                    this.operations.delete(next.commandId);
                    this.operationSessions.delete(next.commandId);
                    this.options.onActivity?.(scope.owner.sessionId);
                  })
                  .catch(() => {});
              } else await agent.disposeUnused();
              return {
                commandId: next.commandId,
                status: 'applied',
                receipt: { ref: next } as unknown as Json,
              };
            } catch (error) {
              await agent.disposeUnused();
              throw error;
            }
          }
          if (
            input.mode !== 'steer' ||
            Object.keys(input).some(
              (key) =>
                !['mode', 'key', 'targetRunId', 'contextSelectionId', 'content'].includes(key),
            )
          )
            throw new AgentError('invalid_agent_input');
          await get(ref);
          const commandId = `agent-input-${await semanticDigest({ storeId: scope.command.originStoreId, sessionId: scope.command.sessionId, extensionId: extension.id, key: input.key })}`;
          const command = await this.options.store.acceptAgentInput({
            expectedStoreId: scope.command.originStoreId,
            owner: scope.owner,
            sessionId: scope.command.sessionId,
            extensionId: extension.id,
            originCommandId: scope.command.id,
            parentExecutionId: executionId,
            commandId,
            ref,
            key: input.key,
            targetRunId: input.targetRunId,
            contextSelectionId: input.contextSelectionId,
            content: input.content,
          });
          return { commandId: command.id, status: command.status, receipt: command.receipt };
        },
        readAgent,
        readAgentMessageTarget: (target) =>
          this.options.store.readAgentMessageTarget({
            expectedStoreId: scope.command.originStoreId,
            sourceExecutionId: executionId,
            extensionId: extension.id,
            subjectId: scope.command.subjectId,
            target,
          }),
        sendAgentMessage: async (target, input) => {
          this.options.assertAcceptingWork?.();
          scope.signal.throwIfAborted();
          if (!this.options.artifacts) throw new AgentError('artifact_content_unavailable');
          if (
            !input ||
            Object.keys(input).some(
              (key) => !['key', 'content', 'contextSelectionId', 'targetRunId'].includes(key),
            ) ||
            !/^[A-Za-z0-9_.-]{1,128}$/.test(input.key) ||
            typeof input.content !== 'string' ||
            !input.content.trim() ||
            Buffer.byteLength(input.content) > 1048576
          )
            throw new AgentError('invalid_agent_message');
          let targetSessionId: string;
          let targetCarrierExecutionId: string | undefined;
          if (target === 'parent') {
            const current = await this.options.store.getSession(scope.command.sessionId);
            if (!current?.parentSessionId) throw new AgentError('agent_message_relation_invalid');
            targetSessionId = current.parentSessionId;
          } else {
            if (target.extensionId !== extension.id || target.sessionId !== scope.command.sessionId)
              throw new AgentError('permission_denied');
            const actual = await this.options.store.getAgentSummary({
              expectedStoreId: scope.command.originStoreId,
              subjectId: scope.command.subjectId,
              ref: target,
            });
            targetSessionId = actual.childSessionId;
            targetCarrierExecutionId = actual.executionId;
          }
          const commandId = `agent-mail-${await semanticDigest({ storeId: scope.command.originStoreId, sessionId: scope.command.sessionId, extensionId: extension.id, key: input.key })}`;
          const body = await this.options.artifacts.publish({
            expectedStoreId: scope.command.originStoreId,
            sessionId: scope.command.sessionId,
            subjectId: scope.command.subjectId,
            refId: commandId,
            scope: { kind: 'execution', id: executionId },
            mediaType: 'text/plain; charset=utf-8',
            content: new TextEncoder().encode(input.content),
          });
          const command = await this.options.store.queueAgentMessage({
            expectedStoreId: scope.command.originStoreId,
            owner: scope.owner,
            commandId,
            originCommandId: scope.command.id,
            sourceExecutionId: executionId,
            extensionId: extension.id,
            key: input.key,
            targetSessionId,
            ...(targetCarrierExecutionId === undefined ? {} : { targetCarrierExecutionId }),
            contextSelectionId: input.contextSelectionId,
            ...(input.targetRunId === undefined ? {} : { targetRunId: input.targetRunId }),
            body,
          });
          return { commandId: command.id, status: command.status, receipt: command.receipt };
        },
        listAgentMessages: async (options = {}) => {
          if (Object.keys(options).some((key) => !['afterSeq', 'upperSeq', 'limit'].includes(key)))
            throw new AgentError('invalid_mail_cursor');
          const page = await this.options.store.listAgentMessages({
            expectedStoreId: scope.command.originStoreId,
            sessionId: scope.command.sessionId,
            subjectId: scope.command.subjectId,
            ...options,
          });
          return { ...page, items: page.items.map(({ body: _body, ...item }) => item) };
        },
        waitAgentMessages: async (options = {}) => {
          if (!this.options.waitForChange) throw new AgentError('wait_unavailable');
          const timeout = options.timeoutMs ?? 30000;
          if (
            !Number.isInteger(timeout) ||
            timeout < 0 ||
            timeout > 30000 ||
            Object.keys(options).some((key) => !['afterSeq', 'timeoutMs', 'signal'].includes(key))
          )
            throw new AgentError('invalid_wait_timeout');
          const current = await this.options.store.getExecution(executionId);
          const run = current?.runId ? await this.options.store.getRun(current.runId) : null;
          const signal = options.signal
            ? AbortSignal.any([scope.signal, options.signal])
            : scope.signal;
          const deadline = Math.min(
            Date.now() + timeout,
            run?.deadlineAt ?? Number.MAX_SAFE_INTEGER,
          );
          let cursor = (await this.options.store.getMetadata()).lastChangeCursor;
          for (;;) {
            signal.throwIfAborted();
            const page = await this.options.store.listAgentMessages({
              expectedStoreId: scope.command.originStoreId,
              sessionId: scope.command.sessionId,
              subjectId: scope.command.subjectId,
              afterSeq: options.afterSeq ?? '0',
              confirmedOnly: true,
              limit: 100,
            });
            const ready = page.items.filter((mail) =>
              ['accepted', 'received'].includes(mail.state),
            );
            if (ready.length)
              return {
                reason: 'mail' as const,
                messageIds: ready.map((mail) => mail.id),
                highWaterSeq: page.highWaterSeq,
              };
            if (Date.now() >= deadline)
              return {
                reason: 'timeout' as const,
                messageIds: [],
                highWaterSeq: page.highWaterSeq,
              };
            const events = await this.options.waitForChange(cursor, signal, deadline - Date.now());
            if (events.length) cursor = events.at(-1)!.cursor;
            for (const event of events) {
              if (event.sessionId !== scope.command.sessionId) continue;
              if (event.type === 'agent.message_ready') {
                const mail = await this.options.store.getAgentMessage({
                  expectedStoreId: scope.command.originStoreId,
                  sessionId: scope.command.sessionId,
                  subjectId: scope.command.subjectId,
                  messageId: event.objectId,
                });
                if (
                  mail?.targetSessionId === scope.command.sessionId &&
                  ['accepted', 'received'].includes(mail.state)
                )
                  return {
                    reason: 'mail' as const,
                    messageIds: [mail.id],
                    highWaterSeq:
                      BigInt(mail.seq) > BigInt(page.highWaterSeq) ? mail.seq : page.highWaterSeq,
                  };
              }
              if (event.type === 'command.accepted' && run) {
                const input = await this.options.store.getCommand(event.objectId);
                const request = input?.request;
                if (
                  request &&
                  typeof request === 'object' &&
                  !Array.isArray(request) &&
                  (request.kind === 'input.steer' || request.kind === 'result.include') &&
                  request.targetRunId === run.id
                )
                  return {
                    reason: 'input' as const,
                    messageIds: [],
                    highWaterSeq: page.highWaterSeq,
                  };
              }
              if (event.type === 'interaction.requested' || event.type === 'interaction.created')
                return {
                  reason: 'interaction' as const,
                  messageIds: [],
                  highWaterSeq: page.highWaterSeq,
                };
            }
          }
        },
        getAgentRef: async (key) => {
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new AgentError('invalid_operation_key');
          const actual = await this.options.store.getOperation({
            extensionId: extension.id,
            sessionId: scope.command.sessionId,
            key,
            originStoreId: scope.command.originStoreId,
            subjectId: scope.command.subjectId,
          });
          if (actual)
            await this.options.store.getAgentSummary({
              expectedStoreId: scope.command.originStoreId,
              ref: actual,
              subjectId: scope.command.subjectId,
            });
          return actual;
        },
        listAgents: async (options = {}) => {
          if (Object.keys(options).some((key) => !['afterSeq', 'upperSeq', 'limit'].includes(key)))
            throw new AgentError('invalid_agent_page');
          return this.options.store.listAgentSummaries({
            expectedStoreId: scope.command.originStoreId,
            sessionId: scope.command.sessionId,
            extensionId: extension.id,
            subjectId: scope.command.subjectId,
            ...options,
          });
        },
        interruptAgent: async (ref, input) => {
          scope.signal.throwIfAborted();
          if (
            Object.keys(input).some((key) => !['commandId', 'targetRunId'].includes(key)) ||
            !/^[A-Za-z0-9_.-]{1,128}$/.test(input.commandId) ||
            !input.targetRunId
          )
            throw new AgentError('invalid_agent_interrupt');
          if (ref.extensionId !== extension.id || ref.sessionId !== scope.command.sessionId)
            throw new AgentError('permission_denied');
          const view = await this.options.store.getAgentSummary({
            expectedStoreId: scope.command.originStoreId,
            ref,
            subjectId: scope.command.subjectId,
          });
          if (!view.run || view.run.id !== input.targetRunId)
            throw new AgentError('input_target_changed');
          const command = await this.options.store.interruptAgent({
            expectedStoreId: scope.command.originStoreId,
            owner: scope.owner,
            sessionId: scope.command.sessionId,
            extensionId: extension.id,
            originCommandId: scope.command.id,
            parentExecutionId: executionId,
            ref,
            commandId: input.commandId,
            targetRunId: input.targetRunId,
          });
          return { commandId: command.id, status: command.status, receipt: command.receipt };
        },
        readOutput: async (ref, options = {}) => {
          if (
            ref.originStoreId !== scope.command.originStoreId ||
            (await this.options.store.getMetadata()).storeId !== scope.command.originStoreId
          )
            throw new AgentError('store_identity_mismatch');
          const original = await get(ref);
          if (
            !original ||
            original.id !== ref.executionId ||
            original.sessionId !== scope.command.sessionId
          )
            throw new AgentError('operation_not_found');
          if (
            Object.keys(options).some((key) => !['afterSeq', 'upperSeq', 'limit'].includes(key)) ||
            (options.limit !== undefined &&
              (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200))
          )
            throw new AgentError('invalid_output_page');
          return this.options.store.listExecutionOutput({ executionId: original.id, ...options });
        },
        cancel: async (ref, options = {}) => {
          await get(ref);
          await this.options.store.cancelCommand({
            expectedStoreId: scope.command.originStoreId,
            sessionId: scope.command.sessionId,
            commandId: options.commandId ?? crypto.randomUUID(),
            targetCommandId: ref.commandId,
            subjectId: scope.command.subjectId,
          });
        },
        waitAny,
        wait: async (ref, options = {}) => {
          const timeout = options.timeoutMs ?? 10000;
          if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 30000)
            throw new AgentError('invalid_wait_timeout');
          const deadline = Date.now() + timeout;
          for (;;) {
            const result = await waitAny(
              [ref],
              {
                ...options,
                timeoutMs: Math.max(0, Math.min(30000, deadline - Date.now())),
              },
              false,
            );
            if (result.reason === 'terminal') return result.executions[0]!;
            if (result.reason === 'timeout' || Date.now() >= deadline)
              throw new AgentError('wait_timeout');
            // Single-target wait keeps its terminal contract. Accepted input stays in the
            // ledger for the calling Tool's next safe boundary; it does not imply that
            // this already-dispatched Tool or its child has stopped. The absolute
            // deadline is retained across input and human-interaction wake-ups.
          }
        },
      } as OutputOperations,
    };
  }
  private async performOperation(
    ref: OperationRef,
    parent: StandaloneScope,
    parentExecutionId: string,
    source: Json,
    definition: ToolDefinition | JobDefinition,
    kind: 'tool' | 'job',
  ) {
    const command = await this.options.store.getCommand(ref.commandId);
    if (!command) throw new AgentError('command_not_found');
    if (kind === 'tool' && command.status !== 'accepted') return;
    const request = command.request as { input: Json; cancellation?: string };
    const input = request.input;
    const controller = new AbortController();
    const abort = () => controller.abort(parent.signal.reason);
    const attached = request.cancellation !== 'detached';
    if (attached) parent.signal.addEventListener('abort', abort, { once: true });
    if (attached && parent.signal.aborted) abort();
    const release = this.options.live(command, parent.owner, controller);
    try {
      const scope = {
        ...parent,
        // A child operation does not inherit the original Action's prepare collector.
        captureDispatchReadSet: undefined,
        command,
        parentExecutionId,
        cancelWithParent: attached,
        signal: controller.signal,
      };
      if (kind === 'job') {
        if (!ref.executionId) throw new AgentError('execution_not_found');
        await this.options.execution.job(scope, {
          executionId: ref.executionId,
          definition: definition as JobDefinition,
          request: input,
          source,
          cancelWithParent: attached,
        });
        await this.options.onJobSettled?.(scope, ref.executionId);
      } else
        await this.options.execution.tool(
          scope,
          definition as ToolDefinition,
          { id: ref.commandId, name: definition.id, arguments: JSON.stringify(input) },
          `action:${parentExecutionId}`,
          parentExecutionId,
          source,
        );
    } catch (error) {
      const current = await this.options.store.getCommand(command.id);
      if (current?.status === 'accepted')
        await this.options.store.rejectCommand({
          expectedStoreId: command.originStoreId,
          owner: parent.owner,
          commandId: command.id,
          reason: error instanceof AgentError ? error.code : 'operation_preparation_failed',
          needsReview: true,
        });
      throw error;
    } finally {
      release();
      parent.signal.removeEventListener('abort', abort);
    }
  }
  get operationCount(): number {
    return this.operations.size + Number(this.cleanupFailed);
  }
  async drain() {
    await Promise.allSettled(this.operations.values());
    if (this.cleanupFailed) throw new AgentError('shutdown_cleanup_unconfirmed');
  }
}
