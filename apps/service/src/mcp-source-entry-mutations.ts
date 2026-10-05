import { createHash } from 'node:crypto';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import {
  ConfigurationError,
  type McpSourceEntryMutation,
  type McpSourceEntryReceipt,
  type McpSourceIdentity,
  type McpSourceOptions,
  type McpSourceReadSet,
  mcpCanonical,
  readMcpSourceEntryPreview,
  readMcpSources,
  writeMcpSourceEntry,
} from '@kite-ai/agent/config';
import type {
  ActionContext,
  ActionDefinition,
  Json,
  QueryDefinition,
  ToolResult,
} from '@kite-ai/agent/extensions';
import type {
  CommandRecord,
  ExecutionRecord,
  HostMutationRecord,
  JsonSchema,
} from '@kite-ai/agent/storage';
import { validMcpSourceReadSet } from './mcp-source-result';

const extensionId = 'builtin.mcp.sources';
const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const object = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const closed = (value: Record<string, Json>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const equal = (a: unknown, b: unknown) => mcpCanonical(a) === mcpCanonical(b);
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const code = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value);
const actionId = (operation: 'add' | 'remove') => `mcp.source.${operation}`;
const bounded = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 8192 &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
type Host = Pick<
  AgentRuntime,
  | 'getMetadata'
  | 'getSession'
  | 'getCommand'
  | 'getExecution'
  | 'beginHostMutation'
  | 'finishHostMutation'
  | 'getHostMutation'
>;
export interface McpSourceEntryMutationScope {
  workspaceId: string;
  /** Re-supplies trusted finite variables at the final publication boundary. */
  sourceOptions(): McpSourceOptions;
  /** Synchronous original canonical Workspace root/device/inode and signal check. */
  validatePublication(): void;
  prepareRemoval?(
    serverId: string,
    readSet: McpSourceReadSet,
    signal: AbortSignal,
  ): Promise<{
    present(): Promise<boolean>;
    clear(receipt: McpSourceEntryReceipt): Promise<void>;
    release(): void;
  } | null>;
}
interface Binding {
  version: 1;
  executionId: string;
  originCommandId: string;
  originalStoreId: string;
  sessionId: string;
  workspaceId: string;
  actionId: string;
  inputDigest: string;
}
const binding = (
  execution: ExecutionRecord,
  workspaceId: string,
  operation: 'add' | 'remove',
): Binding => ({
  version: 1,
  executionId: execution.id,
  originCommandId: execution.originCommandId,
  originalStoreId: execution.originStoreId,
  sessionId: execution.sessionId,
  workspaceId,
  actionId: actionId(operation),
  inputDigest: hash(execution.input),
});
function mutationInput(operation: 'add' | 'remove', value: unknown): McpSourceEntryMutation | null {
  const input = object(value);
  if (
    !validMcpSourceReadSet(input.expectedReadSet) ||
    !['user', 'workspace'].includes(String(input.scope))
  )
    return null;
  const readSet = input.expectedReadSet as unknown as McpSourceReadSet;
  if (
    (input.scope === 'workspace' && !readSet.workspace) ||
    [readSet.user.error, readSet.workspace?.error].some(
      (error) => error !== undefined && error !== null && !code(error),
    )
  )
    return null;
  if (operation === 'remove') {
    if (
      !closed(input, ['scope', 'serverId', 'expectedRawEntryDigest', 'expectedReadSet']) ||
      typeof input.serverId !== 'string' ||
      !/^mcp-[a-f0-9]{64}$/.test(input.serverId) ||
      !hex(input.expectedRawEntryDigest)
    )
      return null;
    return {
      kind: operation,
      scope: input.scope as 'user' | 'workspace',
      serverId: input.serverId,
      expectedRawEntryDigest: input.expectedRawEntryDigest,
    };
  }
  const entry = object(input.entry);
  if (
    !closed(input, ['scope', 'name', 'entry', 'expectedReadSet']) ||
    typeof input.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.name) ||
    ['constructor', 'prototype'].includes(input.name)
  )
    return null;
  if (entry.type === 'http') {
    if (
      !closed(entry, ['type', 'url']) ||
      !bounded(entry.url) ||
      entry.url.includes('${') ||
      Array.from(entry.url).some((character) => character.charCodeAt(0) === 32)
    )
      return null;
    try {
      const url = new URL(entry.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        entry.url.includes('?') ||
        entry.url.includes('#')
      )
        return null;
    } catch {
      return null;
    }
  } else if (entry.type === 'stdio') {
    if (
      !closed(entry, ['type', 'command']) ||
      !bounded(entry.command) ||
      entry.command.length > 4096 ||
      !entry.command.startsWith('/') ||
      entry.command.includes('${')
    )
      return null;
  } else return null;
  return {
    kind: operation,
    scope: input.scope as 'user' | 'workspace',
    name: input.name,
    entry:
      entry.type === 'http'
        ? { type: 'http', url: String(entry.url) }
        : { type: 'stdio', command: String(entry.command) },
  };
}
function originalInput(command: CommandRecord): {
  operation: 'add' | 'remove';
  mutation: McpSourceEntryMutation;
  readSet: McpSourceReadSet;
} | null {
  const request = object(command.request);
  const operation =
    request.actionId === actionId('add')
      ? 'add'
      : request.actionId === actionId('remove')
        ? 'remove'
        : null;
  if (
    !operation ||
    command.kind !== 'extension.invoke' ||
    !closed(request, ['kind', 'extensionId', 'actionId', 'definitionVersion', 'input']) ||
    request.kind !== 'extension.invoke' ||
    request.extensionId !== extensionId ||
    request.definitionVersion !== '1' ||
    !hex(command.requestDigest) ||
    hash(command.request) !== command.requestDigest
  )
    return null;
  const mutation = mutationInput(operation, request.input);
  return mutation
    ? {
        operation,
        mutation,
        readSet: object(request.input).expectedReadSet as unknown as McpSourceReadSet,
      }
    : null;
}
function originalExecution(
  command: CommandRecord,
  execution: ExecutionRecord,
  operation: 'add' | 'remove',
) {
  return (
    id(execution.id) &&
    execution.originStoreId === command.originStoreId &&
    execution.sessionId === command.sessionId &&
    execution.originCommandId === command.id &&
    execution.kind === 'job' &&
    execution.definitionId === `${extensionId}/${actionId(operation)}` &&
    execution.definitionVersion === '1' &&
    execution.rootWorkCommandId === command.rootWorkCommandId &&
    execution.rootWorkSeq === command.rootWorkSeq &&
    equal(execution.input, object(command.request).input) &&
    // These are independent ordinary Actions, with no Run or detached Job producer.
    execution.parentExecutionId === null &&
    execution.runId === null
  );
}
function sourceRead(readSet: McpSourceReadSet, scope: 'user' | 'workspace') {
  return scope === 'user' ? readSet.user : readSet.workspace;
}
function safeRequest(
  mutation: McpSourceEntryMutation,
  readSet: McpSourceReadSet,
  workspaceId: string,
): Json {
  return {
    scope: mutation.scope,
    ...(mutation.scope === 'workspace' ? { workspaceId } : {}),
    ifMatch: sourceRead(readSet, mutation.scope)!.etag!,
    operationCount: 1,
  };
}
function matchesMutation(
  record: HostMutationRecord,
  identity: Binding,
  mutation: McpSourceEntryMutation,
  readSet: McpSourceReadSet,
  subjectId: string,
) {
  return (
    record.id === `mcp-entry-${identity.executionId}` &&
    record.originStoreId === identity.originalStoreId &&
    record.subjectId === subjectId &&
    record.requestDigest === hash(identity) &&
    record.kind === (mutation.scope === 'user' ? 'config.user.write' : 'config.workspace.write') &&
    record.scope === (mutation.scope === 'user' ? 'user' : identity.workspaceId) &&
    equal(record.safeRequest, safeRequest(mutation, readSet, identity.workspaceId))
  );
}
function declaration(value: unknown, source: McpSourceIdentity) {
  const v = object(value);
  return (
    closed(v, ['serverId', 'name', 'source', 'rawEntryDigest', 'transport', 'enabled', 'reason']) &&
    typeof v.serverId === 'string' &&
    /^mcp-[a-f0-9]{64}$/.test(v.serverId) &&
    typeof v.name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v.name) &&
    equal(v.source, source) &&
    hex(v.rawEntryDigest) &&
    [null, 'http', 'stdio'].includes(v.transport as string | null) &&
    typeof v.enabled === 'boolean' &&
    (v.reason === null || code(v.reason))
  );
}
function validReceipt(
  value: unknown,
  identity: Binding,
  mutation: McpSourceEntryMutation,
  readSet: McpSourceReadSet,
) {
  const receipt = object(value),
    target = object(receipt.target),
    selected = sourceRead(readSet, mutation.scope);
  if (
    !selected ||
    !closed(receipt, ['target', 'fallback', 'operationId', 'kind', 'oldEtag', 'newEtag']) ||
    receipt.operationId !== identity.executionId ||
    receipt.kind !== mutation.kind ||
    receipt.oldEtag !== selected.etag ||
    !hex(receipt.oldEtag) ||
    !hex(receipt.newEtag) ||
    receipt.newEtag === receipt.oldEtag ||
    !declaration(receipt.target, selected.identity)
  )
    return false;
  if (mutation.kind === 'add') {
    return (
      receipt.fallback === null &&
      target.name === mutation.name &&
      target.serverId === `mcp-${hash({ name: mutation.name })}` &&
      target.rawEntryDigest ===
        hash({
          version: 1,
          name: mutation.name,
          raw: {
            ...mutation.entry,
            _kiteSourceCreation: { version: 1, operationId: identity.executionId },
          },
        }) &&
      target.transport === mutation.entry.type &&
      target.enabled === true &&
      target.reason === null
    );
  }
  if (
    target.serverId !== mutation.serverId ||
    target.rawEntryDigest !== mutation.expectedRawEntryDigest
  )
    return false;
  return (
    receipt.fallback === null ||
    (mutation.scope === 'workspace' &&
      declaration(receipt.fallback, readSet.user.identity) &&
      object(receipt.fallback).serverId === target.serverId &&
      object(receipt.fallback).name === target.name)
  );
}
function display(contentType: string, summary: string, payload: Record<string, Json>) {
  const value = [
    {
      extensionId,
      contentType,
      contentVersion: 1,
      summary,
      payload,
      artifactRefs: [],
      actions: [],
    },
  ];
  if (Buffer.byteLength(JSON.stringify(value)) > 16384) throw new AgentError('source_result_limit');
  return value;
}

/** Ordinary Actions publish one declaration. Historical queries read original SQL facts only. */
export function createMcpSourceEntryMutations(options: {
  runtime(): Host;
  profileAccessKey: string;
  observerSubjectId?: string;
  readSetSchema: JsonSchema;
  scope(sessionId: string): Promise<McpSourceEntryMutationScope>;
}): { actions: ActionDefinition[]; queries: QueryDefinition[] } {
  const subjectId = options.observerSubjectId;
  async function execute(
    operation: 'add' | 'remove',
    input: Json,
    context: ActionContext,
  ): Promise<ToolResult> {
    let identity: Binding | null = null,
      mutationIdentity: {
        commandId: string;
        expectedStoreId: string;
        subjectId: string;
        requestDigest: string;
      } | null = null;
    let receipt: McpSourceEntryReceipt | null = null,
      record: HostMutationRecord | null = null;
    let created = false,
      published = false;
    let removal: Awaited<ReturnType<NonNullable<McpSourceEntryMutationScope['prepareRemoval']>>> =
      null;
    const releaseRemoval = () => removal?.release();
    let credentialCleanup:
      | {
          status: 'not_attempted' | 'not_needed' | 'completed' | 'failed' | 'outcome_unknown';
          attempted: boolean;
        }
      | undefined;
    const result = (outcome: ToolResult['outcome'], reason: string): ToolResult => ({
      outcome,
      content: reason,
      details: {
        binding: identity as unknown as Json,
        receipt: receipt as unknown as Json,
        mutation: record as unknown as Json,
        code: reason,
        effectAttempted: published,
        connectionAttempted: false,
        credentialLookupAttempted: credentialCleanup !== undefined,
        credentialRevocationAttempted: credentialCleanup?.attempted ?? false,
        ...(credentialCleanup ? { credentialCleanup } : {}),
        modelAttempted: false,
      },
    });
    const perform = async () => {
      try {
        const host = options.runtime(),
          metadata = await host.getMetadata();
        const own = await host.getExecution(context.executionId);
        const command = own ? await host.getCommand(own.originCommandId) : null;
        const original = command && originalInput(command);
        const current = await host.getSession(context.sessionId);
        if (
          !subjectId ||
          !current ||
          current.deletedAt !== null ||
          !own ||
          !command ||
          !original ||
          original.operation !== operation ||
          command.originStoreId !== metadata.storeId ||
          command.subjectId !== subjectId ||
          command.sessionId !== context.sessionId ||
          object(command.receipt).executionId !== own.id ||
          !originalExecution(command, own, operation) ||
          !['dispatching', 'running'].includes(own.status) ||
          !equal(input, own.input)
        )
          return result('failed', 'operation_unverifiable');
        identity = binding(own, current.workspaceId, operation);
        context.signal.throwIfAborted();
        const source = await options.scope(context.sessionId),
          sourceOptions = source.sourceOptions();
        if (
          source.workspaceId !== current.workspaceId ||
          sourceOptions.scope.storeId !== metadata.storeId ||
          sourceOptions.scope.sessionId !== context.sessionId ||
          sourceOptions.scope.workspaceId !== current.workspaceId
        )
          throw new AgentError('mcp_source_scope_invalid');
        source.validatePublication();
        const observed = readMcpSources(sourceOptions);
        if (!equal(observed.readSet, original.readSet)) throw new AgentError('mcp_source_conflict');
        if (
          Object.values(observed.registry.errors).some((error) => error !== null) ||
          !hex(sourceRead(original.readSet, original.mutation.scope)?.etag)
        )
          throw new AgentError('mcp_source_unavailable');
        if (operation === 'remove' && source.prepareRemoval) {
          removal = await source.prepareRemoval(
            String(object(input).serverId),
            original.readSet,
            context.signal,
          );
          if (removal) {
            credentialCleanup = { status: 'not_attempted', attempted: false };
            if (!(await removal.present())) credentialCleanup.status = 'not_needed';
          }
        }
        mutationIdentity = {
          commandId: `mcp-entry-${own.id}`,
          expectedStoreId: metadata.storeId,
          subjectId,
          requestDigest: hash(identity),
        };
        const begun = await host.beginHostMutation({
          ...mutationIdentity,
          kind: original.mutation.scope === 'user' ? 'config.user.write' : 'config.workspace.write',
          scope: original.mutation.scope === 'user' ? 'user' : current.workspaceId,
          safeRequest: safeRequest(original.mutation, original.readSet, current.workspaceId),
        });
        record = begun.record;
        if (
          !begun.created ||
          !matchesMutation(record, identity, original.mutation, original.readSet, subjectId)
        )
          return result('outcome_unknown', 'mcp_source_mutation_unverifiable');
        created = true;
        context.signal.throwIfAborted();
        const fresh = await host.getSession(context.sessionId);
        if (!fresh || fresh.deletedAt !== null || fresh.workspaceId !== current.workspaceId)
          throw new AgentError('mcp_source_scope_invalid');
        const actual = await host.getExecution(own.id),
          actualCommand = await host.getCommand(command.id);
        if (
          !actual ||
          !actualCommand ||
          !originalExecution(actualCommand, actual, operation) ||
          !equal(actualCommand.request, command.request) ||
          actualCommand.requestDigest !== command.requestDigest ||
          actualCommand.subjectId !== subjectId ||
          object(actualCommand.receipt).executionId !== own.id ||
          !['dispatching', 'running'].includes(actual.status) ||
          actual.cancelRequestedAt !== null ||
          actualCommand.cancelRequestedAt !== null
        )
          throw new AgentError('operation_unverifiable');
        receipt = writeMcpSourceEntry({
          ...source.sourceOptions(),
          expectedReadSet: original.readSet,
          mutation: original.mutation,
          operationId: own.id,
          validatePublication() {
            context.signal.throwIfAborted();
            source.validatePublication();
            if (!equal(readMcpSources(source.sourceOptions()).readSet, original.readSet))
              throw new AgentError('mcp_source_conflict');
          },
          afterPublication() {
            published = true;
          },
        });
        if (!validReceipt(receipt, identity, original.mutation, original.readSet))
          throw new AgentError('mcp_source_publication_unknown');
        record = await host.finishHostMutation({
          ...mutationIdentity,
          state: 'applied',
          receipt: { status: 'applied', etag: receipt.newEtag },
        });
        if (
          !matchesMutation(record, identity, original.mutation, original.readSet, subjectId) ||
          record.state !== 'applied' ||
          !equal(record.receipt, { status: 'applied', etag: receipt.newEtag })
        )
          return result('outcome_unknown', 'mcp_source_mutation_unverifiable');
        if (removal && credentialCleanup?.status === 'not_attempted') {
          credentialCleanup.attempted = true;
          try {
            await removal.clear(receipt);
            credentialCleanup.status = 'completed';
          } catch (error) {
            const uncertain =
              error instanceof Error && 'code' in error && String(error.code).endsWith('_unknown');
            credentialCleanup.status = uncertain ? 'outcome_unknown' : 'failed';
            return result(
              'outcome_unknown',
              uncertain
                ? 'mcp_source_removed_credential_cleanup_unknown'
                : 'mcp_source_removed_credential_cleanup_failed',
            );
          }
        }
        return result('succeeded', 'mcp_source_entry_saved');
      } catch (error) {
        const reason =
          error instanceof AgentError || error instanceof ConfigurationError
            ? code(error.code)
              ? error.code
              : 'mcp_source_unavailable'
            : 'mcp_source_unavailable';
        // The leaf emits this code only after rename, including failure before its callback.
        if (reason === 'mcp_source_publication_unknown') published = true;
        const uncertain = published;
        if (mutationIdentity && !created)
          return result('outcome_unknown', 'mcp_source_mutation_unverifiable');
        if (mutationIdentity && created) {
          try {
            record = await options.runtime().finishHostMutation({
              ...mutationIdentity,
              state: uncertain ? 'outcome_unknown' : 'failed',
              receipt: { status: uncertain ? 'outcome_unknown' : 'failed', code: reason },
            });
          } catch {
            return result('outcome_unknown', 'mcp_source_mutation_unverifiable');
          }
        }
        return result(
          uncertain ? 'outcome_unknown' : context.signal.aborted ? 'cancelled' : 'failed',
          reason,
        );
      }
    };
    let response: ToolResult;
    let cleanupFailed = false;
    try {
      response = await perform();
    } finally {
      try {
        releaseRemoval();
      } catch {
        if (credentialCleanup) credentialCleanup.status = 'outcome_unknown';
        cleanupFailed = true;
      }
    }
    return cleanupFailed
      ? result('outcome_unknown', 'mcp_source_removed_credential_cleanup_unknown')
      : response;
  }
  const schemaBase = {
    scope: { type: 'string', enum: ['user', 'workspace'] },
    expectedReadSet: options.readSetSchema,
  };
  const actions = ['add', 'remove'].map((kind): ActionDefinition => {
    const operation = kind as 'add' | 'remove';
    return {
      id: actionId(operation),
      version: '1',
      description:
        operation === 'add'
          ? 'Add one basic MCP source declaration; no approval, connection or credential grant'
          : 'Remove one exact MCP source declaration; shared credential references are retained',
      inputSchema:
        operation === 'add'
          ? {
              type: 'object',
              additionalProperties: false,
              required: ['scope', 'name', 'entry', 'expectedReadSet'],
              properties: {
                ...schemaBase,
                name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
                entry: {
                  oneOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['type', 'url'],
                      properties: {
                        type: { const: 'http' },
                        url: { type: 'string', minLength: 1, maxLength: 8192 },
                      },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['type', 'command'],
                      properties: {
                        type: { const: 'stdio' },
                        command: { type: 'string', minLength: 1, maxLength: 4096 },
                      },
                    },
                  ],
                },
              },
            }
          : {
              type: 'object',
              additionalProperties: false,
              required: ['scope', 'serverId', 'expectedRawEntryDigest', 'expectedReadSet'],
              properties: {
                ...schemaBase,
                serverId: { type: 'string', pattern: '^mcp-[a-f0-9]{64}$' },
                expectedRawEntryDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              },
            },
      async prepare(input) {
        if (!mutationInput(operation, input)) throw new AgentError('invalid_action_arguments');
        return structuredClone(input);
      },
      execute: (input, context) => execute(operation, input, context),
    };
  });
  const preview: QueryDefinition = {
    id: 'mcp.source.entry.preview',
    version: '1',
    description: 'Read an exact source entry and the user declaration a removal would reveal',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'serverId', 'expectedReadSet'],
      properties: { ...schemaBase, serverId: { type: 'string', pattern: '^mcp-[a-f0-9]{64}$' } },
    },
    outputSchema: { type: 'array' },
    async execute(input, context) {
      if (!context.readExecutionGroupSafety || !subjectId)
        throw new AgentError('source_observer_unavailable');
      const admission = await context.readExecutionGroupSafety(),
        host = options.runtime(),
        metadata = await host.getMetadata();
      if (admission.originStoreId !== metadata.storeId)
        throw new AgentError('operation_unverifiable');
      const source = await options.scope(context.sessionId),
        request = object(input);
      if (!validMcpSourceReadSet(request.expectedReadSet))
        throw new AgentError('invalid_query_arguments');
      source.validatePublication();
      const readSet = request.expectedReadSet as unknown as McpSourceReadSet;
      const impact = readMcpSourceEntryPreview(source.sourceOptions(), {
        scope: request.scope as 'user' | 'workspace',
        serverId: String(request.serverId),
        expectedReadSet: readSet,
      });
      return display(
        'builtin.mcp.source.entry.preview',
        'Source entry removal impact; no connection or credential authority',
        {
          storeId: metadata.storeId,
          sessionId: context.sessionId,
          workspaceId: source.workspaceId,
          readSet: readSet as unknown as Json,
          preview: impact as unknown as Json,
        },
      );
    },
  };
  const history: QueryDefinition = {
    id: 'mcp.source.mutation.result',
    version: '1',
    description:
      'Read one original source entry mutation without reading current files or replaying a write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['commandId'],
      properties: { commandId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
    },
    outputSchema: { type: 'array' },
    async execute(input, context) {
      if (!context.readExecutionGroupSafety) throw new AgentError('source_observer_unavailable');
      const admission = await context.readExecutionGroupSafety(),
        host = options.runtime(),
        metadata = await host.getMetadata();
      if (admission.originStoreId !== metadata.storeId)
        throw new AgentError('operation_unverifiable');
      const payload: Record<string, Json> = {
        storeId: metadata.storeId,
        sessionId: context.sessionId,
        workspaceId: null,
        operation: null,
        command: null,
        execution: null,
        phase: 'outcome_unknown',
        mutation: null,
        receipt: null,
        reason: 'original_proof_unavailable',
      };
      const output = () =>
        display(
          'builtin.mcp.source.mutation.result',
          'Original source entry mutation; shared credentials and transport authority are separate',
          payload,
        );
      if (!subjectId || subjectId.length > 256) {
        payload.reason = 'source_observer_unavailable';
        return output();
      }
      const commandId = object(input).commandId;
      if (!id(commandId)) throw new AgentError('invalid_query_arguments');
      const command = await host.getCommand(commandId);
      if (!command) return output();
      if (
        command.originStoreId !== metadata.storeId ||
        command.sessionId !== context.sessionId ||
        command.subjectId !== subjectId
      ) {
        payload.reason = 'source_observer_denied';
        return output();
      }
      const original = originalInput(command);
      if (command.id !== commandId || !original) {
        payload.reason = 'operation_unverifiable';
        return output();
      }
      payload.operation = original.operation;
      const session = await host.getSession(context.sessionId);
      payload.workspaceId = session?.workspaceId ?? null;
      if (
        session &&
        original.readSet.scopeDigest !==
          hash({
            persistentScopeDigest: hash({
              profileId: options.profileAccessKey,
              storeId: command.originStoreId,
              workspaceId: session.workspaceId,
              profile: original.readSet.user.identity.rootIdentity,
              workspace: original.readSet.workspace?.identity.rootIdentity ?? null,
            }),
            sessionId: context.sessionId,
          })
      ) {
        payload.reason = 'mcp_source_scope_invalid';
        return output();
      }
      const commandReceipt = object(command.receipt),
        executionId = commandReceipt.executionId;
      payload.command = {
        id: command.id,
        originStoreId: command.originStoreId,
        sessionId: command.sessionId,
        subjectId,
        kind: 'extension.invoke',
        requestDigest: command.requestDigest,
        status: command.status,
        executionId: id(executionId) ? executionId : null,
      };
      if (!id(executionId)) {
        if (command.status === 'accepted' && executionId === undefined) {
          payload.phase = 'pending';
          payload.reason = null;
        }
        return output();
      }
      const execution = await host.getExecution(executionId);
      payload.reason = 'execution_scope_unavailable';
      if (
        !session ||
        !execution ||
        execution.id !== executionId ||
        !originalExecution(command, execution, original.operation)
      )
        return output();
      payload.execution = {
        id: execution.id,
        originStoreId: execution.originStoreId,
        sessionId: execution.sessionId,
        originCommandId: execution.originCommandId,
        parentExecutionId: execution.parentExecutionId,
        runId: execution.runId,
        kind: 'job',
        definitionId: execution.definitionId,
        definitionVersion: execution.definitionVersion,
        inputDigest: hash(execution.input),
        status: execution.status,
      };
      const identity = binding(execution, session.workspaceId, original.operation);
      let mutation: HostMutationRecord | null;
      try {
        mutation = await host.getHostMutation({
          expectedStoreId: metadata.storeId,
          subjectId,
          commandId: `mcp-entry-${execution.id}`,
        });
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'host_mutation_scope_denied')
          throw error;
        payload.reason = 'host_mutation_unverifiable';
        return output();
      }
      if (mutation) {
        payload.reason = 'host_mutation_unverifiable';
        if (!matchesMutation(mutation, identity, original.mutation, original.readSet, subjectId))
          return output();
        payload.mutation = {
          id: mutation.id,
          originStoreId: mutation.originStoreId,
          subjectId,
          kind: mutation.kind,
          scope: mutation.scope,
          requestDigest: mutation.requestDigest,
          state: mutation.state,
          etag: hex(object(mutation.receipt).etag) ? object(mutation.receipt).etag! : null,
        };
      }
      if (['planned', 'dispatching', 'running'].includes(execution.status)) {
        if (!mutation) {
          payload.phase = 'pending';
          payload.reason = null;
        } else payload.reason = 'partial_mutation_unverifiable';
        return output();
      }
      payload.reason = 'action_receipt_unverifiable';
      if (
        command.status !== 'applied' ||
        commandReceipt.status !== execution.status ||
        commandReceipt.preparingNextAttempt === true ||
        commandReceipt.finalizationDigest !==
          hash({
            status: execution.status,
            preparingNextAttempt: false,
            result: execution.result,
            writes: [],
            message: null,
          })
      )
        return output();
      const result = object(execution.result),
        details = object(result.details);
      const deniedCodes = [
        'approval_denied',
        'permission_denied',
        'cancelled_before_dispatch',
        'cancel_requested',
        'execution_cancel_requested',
      ];
      if (
        !mutation &&
        ['failed', 'cancelled'].includes(execution.status) &&
        result.outcome === execution.status &&
        closed(result, ['outcome', 'content', 'details']) &&
        closed(details, ['code', 'adapterAttempted']) &&
        details.adapterAttempted === false &&
        result.content === details.code &&
        deniedCodes.includes(String(details.code)) &&
        (execution.status !== 'cancelled' ||
          command.cancelRequestedAt !== null ||
          execution.cancelRequestedAt !== null)
      ) {
        payload.phase = execution.status;
        payload.reason = details.code!;
        return output();
      }
      payload.reason = 'mutation_result_unverifiable';
      const cleanup = object(details.credentialCleanup),
        hasCleanup = Object.hasOwn(details, 'credentialCleanup');
      if (
        hasCleanup &&
        (!closed(cleanup, ['status', 'attempted']) ||
          original.operation !== 'remove' ||
          !['not_attempted', 'not_needed', 'completed', 'failed', 'outcome_unknown'].includes(
            String(cleanup.status),
          ) ||
          typeof cleanup.attempted !== 'boolean' ||
          details.credentialLookupAttempted !== true ||
          details.credentialRevocationAttempted !== cleanup.attempted ||
          (['completed', 'failed'].includes(String(cleanup.status)) && cleanup.attempted !== true))
      )
        return output();
      if (
        !closed(result, ['outcome', 'content', 'details']) ||
        !closed(details, [
          'binding',
          'receipt',
          'mutation',
          'code',
          'effectAttempted',
          'connectionAttempted',
          'credentialLookupAttempted',
          'credentialRevocationAttempted',
          'modelAttempted',
          ...(hasCleanup ? ['credentialCleanup'] : []),
        ]) ||
        result.outcome !== execution.status ||
        result.content !== details.code ||
        !code(details.code) ||
        ![
          'connectionAttempted',
          ...(!hasCleanup ? ['credentialLookupAttempted', 'credentialRevocationAttempted'] : []),
          'modelAttempted',
        ].every((key) => details[key] === false) ||
        ![false, true].includes(details.effectAttempted as boolean) ||
        (details.binding !== null && !equal(details.binding, identity))
      )
        return output();
      if (hasCleanup) payload.credentialCleanup = cleanup;
      if (
        ['failed', 'cancelled'].includes(execution.status) &&
        details.effectAttempted === false &&
        details.receipt === null &&
        (details.binding === null || equal(details.binding, identity)) &&
        (!mutation
          ? details.mutation === null
          : mutation.state === 'failed' &&
            equal(details.mutation, mutation) &&
            equal(mutation.receipt, { status: 'failed', code: details.code }))
      ) {
        payload.phase = execution.status;
        payload.reason = details.code!;
        return output();
      }
      if (
        !(
          (execution.status === 'succeeded' &&
            details.code === 'mcp_source_entry_saved' &&
            (!hasCleanup || ['not_needed', 'completed'].includes(String(cleanup.status)))) ||
          (original.operation === 'remove' &&
            execution.status === 'outcome_unknown' &&
            hasCleanup &&
            ((cleanup.status === 'failed' &&
              details.code === 'mcp_source_removed_credential_cleanup_failed') ||
              (cleanup.status === 'outcome_unknown' &&
                details.code === 'mcp_source_removed_credential_cleanup_unknown')))
        ) ||
        details.effectAttempted !== true ||
        !equal(details.binding, identity) ||
        !mutation ||
        mutation.state !== 'applied' ||
        !equal(details.mutation, mutation) ||
        !validReceipt(details.receipt, identity, original.mutation, original.readSet) ||
        !equal(mutation.receipt, { status: 'applied', etag: object(details.receipt).newEtag })
      )
        return output();
      payload.phase = 'saved';
      payload.receipt = details.receipt!;
      payload.reason = execution.status === 'succeeded' ? null : details.code!;
      return output();
    },
  };
  return { actions, queries: [preview, history] };
}
