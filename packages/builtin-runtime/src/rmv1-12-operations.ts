import type {
  CapabilityEffectsV1,
  CapabilityExecutionContextV1,
  CapabilityExecutionMechanismV1,
  CapabilityExecutorV1,
  ExecutionReceiptV1,
  GitBrokerFailureCodeV1,
  GitBrokerResultV1,
  GitInspectRequestV1,
  RuntimeJsonValueV1,
  RuntimeModuleRegistryWriterV1,
  RuntimeModuleV1,
  WorkspaceFilesystemCommittedMutationV1,
  WorkspaceFilesystemMutationOperationV1,
  WorkspaceFilesystemObservationRecordV1,
  WorkspaceFilesystemObserveObservationV1,
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemPreimageObservationV1,
  WorkspaceFilesystemProviderFailureV1,
} from '@kite/runtime-spi';
import { defineRuntimeModuleV1 } from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import {
  builtinExecutionTraitsV1,
  defineBuiltinCapabilityContractV1,
  gitAvailabilityV1,
  parserForBuiltinOperationV1,
  staticEffectsClassifierV1,
} from './catalog-contract';
import {
  computeLineDiff,
  formatContentOutput,
  formatDiffOutput,
  formatMultiHunkDiff,
} from './filesystem/diff';
import {
  projectionDigest,
  truncateProjectedLines,
  truncateProjectedStreams,
} from './filesystem/projection';
import {
  createBuiltinPolicyCompilerV1,
  fileBuiltinPolicyRuleV1,
  readOnlyBuiltinPolicyRuleV1,
} from './policy-compiler';
import type { BuiltinOperationExecutionValueV1 } from './rmv1-11-operations';
import { builtinToolDescriptionV1 } from './tool-contracts';
import { BUILTIN_JSON_SCHEMAS_V1, BUILTIN_ZOD_SCHEMAS_V1 } from './tool-schemas';

export const RMV1_12_PROVIDER_ID_V1 = 'kite-builtin-runtime-rmv1-12' as const;

export const RMV1_12_OPERATION_IDS_V1 = Object.freeze([
  'builtin:read_file',
  'builtin:search_content',
  'builtin:search_files',
  'builtin:write_file',
  'builtin:edit_file',
  'builtin:git_inspect',
] as const);

export type Rmv112OperationIdV1 = (typeof RMV1_12_OPERATION_IDS_V1)[number];

export const READ_FILE_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:read_file'];
export const SEARCH_CONTENT_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:search_content'];
export const SEARCH_FILES_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:search_files'];
export const WRITE_FILE_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:write_file'];
export const EDIT_FILE_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:edit_file'];
export const GIT_INSPECT_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:git_inspect'];

const INPUT_SCHEMAS_V1: Readonly<
  Record<Rmv112OperationIdV1, Readonly<Record<string, RuntimeJsonValueV1>>>
> = Object.freeze({
  'builtin:read_file': READ_FILE_INPUT_SCHEMA_V1,
  'builtin:search_content': SEARCH_CONTENT_INPUT_SCHEMA_V1,
  'builtin:search_files': SEARCH_FILES_INPUT_SCHEMA_V1,
  'builtin:write_file': WRITE_FILE_INPUT_SCHEMA_V1,
  'builtin:edit_file': EDIT_FILE_INPUT_SCHEMA_V1,
  'builtin:git_inspect': GIT_INSPECT_INPUT_SCHEMA_V1,
});

const EFFECTS_V1 = Object.freeze({
  'builtin:read_file': Object.freeze({
    filesystem: 'read',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:search_content': Object.freeze({
    filesystem: 'read',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:search_files': Object.freeze({
    filesystem: 'read',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:write_file': Object.freeze({
    filesystem: 'write',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:edit_file': Object.freeze({
    filesystem: 'write',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:git_inspect': Object.freeze({
    filesystem: 'read',
    network: 'none',
    externalState: 'none',
  }),
});

const EXECUTION_MECHANISMS_V1: Readonly<
  Record<Rmv112OperationIdV1, CapabilityExecutionMechanismV1>
> = Object.freeze({
  'builtin:read_file': 'filesystem',
  'builtin:search_content': 'filesystem',
  'builtin:search_files': 'filesystem',
  'builtin:write_file': 'filesystem',
  'builtin:edit_file': 'filesystem',
  'builtin:git_inspect': 'git',
});

export const RMV1_12_CAPABILITY_REVISIONS_V1: Readonly<Record<Rmv112OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_12_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-12-operation-capability.v1',
          operationId,
          inputSchema: INPUT_SCHEMAS_V1[operationId],
          effects: EFFECTS_V1[operationId],
        }),
      ]),
    ) as Record<Rmv112OperationIdV1, string>,
  );

export const RMV1_12_EXECUTOR_REVISIONS_V1: Readonly<Record<Rmv112OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_12_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-12-operation-executor.v1',
          operationId,
          capabilityRevision: RMV1_12_CAPABILITY_REVISIONS_V1[operationId],
        }),
      ]),
    ) as Record<Rmv112OperationIdV1, string>,
  );

export interface BuiltinFilesystemPipelineResultV1 {
  readonly ok: boolean;
  readonly observation?:
    | WorkspaceFilesystemObserveObservationV1
    | WorkspaceFilesystemCommittedMutationV1;
  readonly filesystemObservation?: WorkspaceFilesystemObservationRecordV1;
  readonly preimage?: WorkspaceFilesystemPreimageObservationV1;
  readonly failure?: WorkspaceFilesystemProviderFailureV1;
}

export interface BuiltinFilesystemExecutionMechanismV1 {
  readonly allowExternalPaths: boolean;
  dispatch(operation: WorkspaceFilesystemOperationV1): Promise<BuiltinFilesystemPipelineResultV1>;
}

export interface BuiltinGitExecutionMechanismV1 {
  inspect(request: GitInspectRequestV1, signal?: AbortSignal): Promise<GitBrokerResultV1>;
}

export interface Rmv112ExecutionMechanismsV1 extends Readonly<Record<string, unknown>> {
  readonly filesystem?: BuiltinFilesystemExecutionMechanismV1;
  readonly git?: BuiltinGitExecutionMechanismV1;
}

export function createRmv112RuntimeModuleV1(): RuntimeModuleV1 {
  return defineRuntimeModuleV1({
    moduleId: 'kite-builtin-runtime-rmv1-12',
    providerId: RMV1_12_PROVIDER_ID_V1,
    revision: 'rmv1-12',
    operationIds: RMV1_12_OPERATION_IDS_V1,
    register: (registry) => registerRmv112OperationsV1(registry),
  });
}

function registerRmv112OperationsV1(registry: RuntimeModuleRegistryWriterV1): void {
  for (const operationId of RMV1_12_OPERATION_IDS_V1) {
    const capabilityRevision = RMV1_12_CAPABILITY_REVISIONS_V1[operationId];
    const executorRevision = RMV1_12_EXECUTOR_REVISIONS_V1[operationId];
    registry.registerCapability(
      defineBuiltinCapabilityContractV1(
        {
          capabilityId: operationId,
          revision: capabilityRevision,
          providerId: RMV1_12_PROVIDER_ID_V1,
          title: `Builtin Runtime operation ${operationId}`,
          executionMechanism: EXECUTION_MECHANISMS_V1[operationId],
          ...(operationId.startsWith('builtin:')
            ? {
                toolName: operationId.slice('builtin:'.length),
                description: builtinToolDescriptionV1(operationId.slice('builtin:'.length)),
                visibility: 'model' as const,
              }
            : { visibility: 'internal' as const }),
          effects: EFFECTS_V1[operationId],
          inputSchema: INPUT_SCHEMAS_V1[operationId],
          inputSchemaDigest: digestCapabilityBindingValueV1(INPUT_SCHEMAS_V1[operationId]),
        },
        rmv112ContractOptionsV1(operationId, capabilityRevision, EFFECTS_V1[operationId]),
      ),
    );
    registry.registerExecutor({
      providerId: RMV1_12_PROVIDER_ID_V1,
      capabilityId: operationId,
      capabilityRevision,
      executorRevision,
      execute: (request, context) => executeRmv112OperationV1(operationId, request, context),
    } satisfies CapabilityExecutorV1);
  }
}

function rmv112ContractOptionsV1(
  operationId: Rmv112OperationIdV1,
  revision: string,
  effects: CapabilityEffectsV1,
) {
  const readOnly =
    operationId === 'builtin:read_file' ||
    operationId === 'builtin:search_content' ||
    operationId === 'builtin:search_files' ||
    operationId === 'builtin:git_inspect';
  const workspaceWrite =
    operationId === 'builtin:write_file' || operationId === 'builtin:edit_file';
  const workspaceRead =
    operationId === 'builtin:read_file' ||
    operationId === 'builtin:search_content' ||
    operationId === 'builtin:search_files';
  const policyRule =
    operationId === 'builtin:read_file' ||
    operationId === 'builtin:search_content' ||
    operationId === 'builtin:search_files' ||
    operationId === 'builtin:write_file' ||
    operationId === 'builtin:edit_file'
      ? fileBuiltinPolicyRuleV1
      : readOnlyBuiltinPolicyRuleV1;
  const parser = parserForBuiltinOperationV1(operationId, revision);
  return {
    parser,
    kind: 'computer' as const,
    minimumApproval: 'none' as const,
    ...(operationId === 'builtin:git_inspect' ? { availability: gitAvailabilityV1 } : {}),
    ...(operationId === 'builtin:git_inspect'
      ? { governanceRevision: 'git-inspect-v1' }
      : operationId === 'builtin:read_file' ||
          operationId === 'builtin:search_content' ||
          operationId === 'builtin:search_files' ||
          operationId === 'builtin:write_file' ||
          operationId === 'builtin:edit_file'
        ? { governanceRevision: 'trusted-workspace-file-access-v1' }
        : {}),
    effectsClassifier: staticEffectsClassifierV1(
      readOnly ? 'read_only' : workspaceWrite ? 'workspace_write' : 'unknown',
      workspaceWrite,
      operationId === 'builtin:read_file'
        ? 'read_file is a read-only capability.'
        : operationId === 'builtin:search_content'
          ? 'search_content is a read-only capability.'
          : operationId === 'builtin:search_files'
            ? 'search_files is a read-only capability.'
            : operationId === 'builtin:git_inspect'
              ? 'Typed Git inspect is read-only and broker-bound.'
              : operationId === 'builtin:write_file'
                ? 'write_file creates or overwrites workspace files.'
                : 'edit_file modifies workspace files.',
      effects,
    ),
    policyCompiler: createBuiltinPolicyCompilerV1({
      operationId,
      capabilityRevision: revision,
      parserRevision: parser.parserRevision,
      declaredEffects: effects,
      minimumApproval: 'none',
      rule: policyRule,
    }),
    ...(workspaceRead
      ? {
          executionTraitsDeclaration: builtinExecutionTraitsV1({
            resourceScopes: [{ kind: 'workspace', key: 'workspace' }],
            interactionBarrier: false,
            concurrencyGroup: 'parallel-read',
          }),
        }
      : {}),
    execution: readOnly ? { retry: 'safe_read' as const } : { retry: 'never' as const },
  };
}

async function executeRmv112OperationV1(
  operationId: Rmv112OperationIdV1,
  request: Parameters<CapabilityExecutorV1['execute']>[0],
  context: CapabilityExecutionContextV1,
): Promise<ExecutionReceiptV1> {
  const parsed = BUILTIN_ZOD_SCHEMAS_V1[operationId].safeParse(request.input);
  const input = parsed.success ? asRecord(parsed.data) : undefined;
  if (!input) {
    return failedReceipt(operationId, request.invocationId, context, 'invalid_input');
  }
  const mechanisms = context.environment.mechanisms as Rmv112ExecutionMechanismsV1 | undefined;
  let value: BuiltinOperationExecutionValueV1;
  if (operationId === 'builtin:git_inspect') {
    value = await executeGitInspectV1(input, context, mechanisms?.git);
  } else {
    value = await executeFilesystemOperationV1(operationId, input, mechanisms?.filesystem);
  }
  return succeededReceipt(operationId, request.invocationId, context, value);
}

async function executeFilesystemOperationV1(
  operationId: Exclude<Rmv112OperationIdV1, 'builtin:git_inspect'>,
  input: Readonly<Record<string, unknown>>,
  mechanism: BuiltinFilesystemExecutionMechanismV1 | undefined,
): Promise<BuiltinOperationExecutionValueV1> {
  if (!mechanism) return operationFailure('Workspace filesystem Provider is unavailable.');
  const pathScope = mechanism.allowExternalPaths
    ? operationId === 'builtin:write_file' || operationId === 'builtin:edit_file'
      ? 'approved_external'
      : 'external_read'
    : 'workspace_only';
  let operation: WorkspaceFilesystemOperationV1;
  switch (operationId) {
    case 'builtin:read_file':
      operation = {
        kind: 'read_file',
        path: stringValue(input.path),
        pathScope,
        ...(optionalIntegerValue(input.offset) === undefined
          ? {}
          : { offset: optionalIntegerValue(input.offset) }),
        ...(optionalIntegerValue(input.limit) === undefined
          ? {}
          : { limit: optionalIntegerValue(input.limit) }),
      };
      break;
    case 'builtin:search_content':
      operation = {
        kind: 'search_content',
        path: optionalStringValue(input.path) ?? '.',
        pathScope,
        pattern: stringValue(input.pattern),
        ...(optionalStringValue(input.glob) === undefined
          ? {}
          : { glob: optionalStringValue(input.glob) }),
      };
      break;
    case 'builtin:search_files':
      operation = {
        kind: 'search_files',
        path: optionalStringValue(input.path) ?? '.',
        pathScope,
        pattern: stringValue(input.pattern),
      };
      break;
    case 'builtin:write_file':
      operation = {
        kind: 'write_file',
        path: stringValue(input.path),
        pathScope,
        content: stringValue(input.content),
      };
      break;
    case 'builtin:edit_file':
      operation = {
        kind: 'edit_file',
        path: stringValue(input.path),
        pathScope,
        oldString: stringValue(input.old_string),
        newString: stringValue(input.new_string),
        ...(typeof input.replace_all === 'boolean' ? { replaceAll: input.replace_all } : {}),
      };
      break;
  }
  const result = await mechanism.dispatch(operation);
  switch (operation.kind) {
    case 'read_file':
      return projectReadFileV1(operation.path, result);
    case 'search_content':
      return projectSearchContentV1(operation.path, result);
    case 'search_files':
      return projectSearchFilesV1(operation.path, result);
    case 'write_file':
      return projectWriteFileV1(operation.path, operation.content, result);
    case 'edit_file':
      return projectEditFileV1(operation, result);
  }
}

export const MAX_MODEL_READ_FILE_CHARS_V1 = 64 * 1024;

function projectReadFileV1(
  path: string,
  result: BuiltinFilesystemPipelineResultV1,
): BuiltinOperationExecutionValueV1 {
  if (!result.ok || !result.observation) {
    const notFound = /(?:not found|no such file|enoent)/iu.test(result.failure?.message ?? '');
    return operationFailure(
      notFound ? 'File not found.' : 'File could not be read.',
      {
        path,
        totalLines: 0,
        truncated: false,
        rawResultDigest: projectionDigest('', '', -1),
      },
      notFound ? alternativeSearchAdvice() : userActionAdvice(),
    );
  }
  if (result.observation.kind !== 'read_file') {
    return operationFailure('File could not be read.', { path, totalLines: 0, truncated: false });
  }
  const observation = result.observation;
  const projected = projectReadContentV1(observation);
  return operationSuccess(
    projected.content,
    {
      path,
      totalLines: observation.totalLines,
      truncated: projected.truncated,
      rawResultDigest: projectionDigest(observation.content, '', 0),
    },
    {
      ...(result.filesystemObservation
        ? { filesystemObservation: result.filesystemObservation }
        : {}),
      path,
      totalLines: observation.totalLines,
    },
  );
}

function projectReadContentV1(
  output: Extract<WorkspaceFilesystemObserveObservationV1, { kind: 'read_file' }>,
): { content: string; truncated: boolean } {
  const fromLine = output.fromLine ?? 1;
  const toLine = output.toLine ?? fromLine;
  const sourceHasMore = toLine < output.totalLines;
  if (!sourceHasMore && output.content.length <= MAX_MODEL_READ_FILE_CHARS_V1) {
    return { content: output.content, truncated: false };
  }
  const lines = output.content.split('\n');
  const kept: string[] = [];
  let keptLength = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const sourceLine = fromLine + index;
    const hasMore = sourceLine < output.totalLines;
    const candidateLength = keptLength + (kept.length > 0 ? 1 : 0) + line.length;
    const marker = continuationMarker(output.totalLines, sourceLine + 1);
    if (
      (hasMore ? candidateLength + marker.length + 1 : candidateLength) >
      MAX_MODEL_READ_FILE_CHARS_V1
    ) {
      break;
    }
    kept.push(line);
    keptLength = candidateLength;
  }
  if (kept.length > 0) {
    return {
      content: `${kept.join('\n')}\n${continuationMarker(output.totalLines, fromLine + kept.length)}`,
      truncated: true,
    };
  }
  const marker = `... [read_file truncated; total_lines=${output.totalLines}; line ${fromLine} clipped; line offset cannot continue within this line]`;
  const available = Math.max(0, MAX_MODEL_READ_FILE_CHARS_V1 - marker.length - 1);
  const prefix = safePrefix(lines[0] ?? '', available);
  return { content: prefix ? `${prefix}\n${marker}` : marker, truncated: true };
}

function continuationMarker(totalLines: number, nextOffset: number): string {
  return `... [read_file truncated; total_lines=${totalLines}; continue with offset=${nextOffset}]`;
}

function safePrefix(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const prefix = value.slice(0, maximum);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

function projectSearchFilesV1(
  path: string,
  result: BuiltinFilesystemPipelineResultV1,
): BuiltinOperationExecutionValueV1 {
  if (!result.ok || !result.observation) {
    return operationFailure(
      result.failure?.message ?? 'Workspace filesystem Provider failed.',
      {
        path,
        matchCount: 0,
        truncated: false,
        rawResultDigest: projectionDigest('', result.failure?.message ?? '', -1),
      },
      correctArgsAdvice(),
    );
  }
  if (result.observation.kind !== 'search_files') {
    return operationFailure('Workspace filesystem Provider returned the wrong observation.');
  }
  const raw =
    result.observation.matches.length > 0 ? `${result.observation.matches.join('\n')}\n` : '';
  const streams = truncateProjectedStreams(raw, '');
  return operationSuccess(streams.stdout, {
    path,
    matchCount: result.observation.matches.length,
    truncated: streams.truncated,
    rawResultDigest: projectionDigest(raw, '', 0),
  });
}

function projectSearchContentV1(
  path: string,
  result: BuiltinFilesystemPipelineResultV1,
): BuiltinOperationExecutionValueV1 {
  if (!result.ok || !result.observation) {
    return operationFailure(
      result.failure?.message ?? 'Workspace filesystem Provider failed.',
      {
        path,
        matchCount: 0,
        truncated: false,
        rawResultDigest: projectionDigest('', result.failure?.message ?? '', -1),
      },
      correctArgsAdvice(),
    );
  }
  if (result.observation.kind !== 'search_content') {
    return operationFailure('Workspace filesystem Provider returned the wrong observation.');
  }
  const lines = result.observation.matches.map(
    (match) => `${match.path}:${match.line}:${match.text}`,
  );
  const raw = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  const streams = truncateProjectedStreams(raw, '');
  return operationSuccess(streams.stdout, {
    path,
    matchCount: lines.length,
    truncated: streams.truncated,
    rawResultDigest: projectionDigest(raw, '', 0),
  });
}

function projectWriteFileV1(
  path: string,
  content: string,
  result: BuiltinFilesystemPipelineResultV1,
): BuiltinOperationExecutionValueV1 {
  if (!result.ok || !result.observation) {
    return operationFailure(result.failure?.message ?? 'Workspace filesystem Provider failed.', {
      path,
      truncated: false,
    });
  }
  if (result.observation.kind !== 'committed_mutation') {
    return operationFailure('Workspace filesystem Provider returned the wrong observation.');
  }
  let rawContent: string;
  if (result.preimage?.existed && result.preimage.content !== null) {
    const diff = computeLineDiff(result.preimage.content, content, 1);
    rawContent =
      diff.addedLines === 0 && diff.removedLines === 0
        ? formatContentOutput(
            content,
            `Wrote ${result.observation.lines} ${result.observation.lines === 1 ? 'line' : 'lines'} to ${path} (content unchanged)`,
          )
        : formatDiffOutput(diff);
  } else {
    rawContent = formatContentOutput(content, `Wrote ${result.observation.lines} lines to ${path}`);
  }
  const projected = truncateProjectedLines(rawContent);
  return operationSuccess(
    projected.content,
    {
      path,
      truncated: projected.truncated,
      workspaceMutationScope: [path],
      rawResultDigest: projectionDigest(rawContent, '', 0),
    },
    {
      ...(result.filesystemObservation
        ? { filesystemObservation: result.filesystemObservation }
        : {}),
      path,
    },
  );
}

function projectEditFileV1(
  operation: Extract<WorkspaceFilesystemMutationOperationV1, { kind: 'edit_file' }>,
  result: BuiltinFilesystemPipelineResultV1,
): BuiltinOperationExecutionValueV1 {
  if (!result.ok || !result.observation) {
    const message =
      result.failure?.code === 'read_required'
        ? `File has not been read yet: ${operation.path}. Read it with read_file first, then retry edit_file.`
        : result.failure?.code === 'stale_read'
          ? `File has been modified since you last read it: ${operation.path}. Re-read it with read_file, then retry with the exact current content.`
          : (result.failure?.message ?? 'Workspace filesystem Provider failed.');
    return operationFailure(message, { path: operation.path, truncated: false });
  }
  if (result.observation.kind !== 'committed_mutation') {
    return operationFailure('Workspace filesystem Provider returned the wrong observation.');
  }
  const parts: string[] = [];
  if (
    operation.replaceAll &&
    result.observation.matchLines &&
    result.observation.matchLines.length > 1
  ) {
    parts.push(
      formatMultiHunkDiff(
        operation.oldString,
        operation.newString,
        [...result.observation.matchLines],
        result.observation.replacements ?? 1,
      ),
    );
  } else {
    if (operation.replaceAll) {
      const count = result.observation.replacements ?? 1;
      parts.push(`(replaced ${count} time${count > 1 ? 's' : ''})`);
    }
    parts.push(
      formatDiffOutput(
        computeLineDiff(operation.oldString, operation.newString, result.observation.fromLine ?? 1),
      ),
    );
  }
  if (operation.oldString === operation.newString) parts.push('(no effective change)');
  const rawContent = parts.join('\n');
  const projected = truncateProjectedLines(rawContent);
  return operationSuccess(
    projected.content,
    {
      path: operation.path,
      truncated: projected.truncated,
      workspaceMutationScope: [operation.path],
      rawResultDigest: projectionDigest(rawContent, '', 0),
    },
    {
      ...(result.filesystemObservation
        ? { filesystemObservation: result.filesystemObservation }
        : {}),
      path: operation.path,
    },
  );
}

async function executeGitInspectV1(
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContextV1,
  mechanism: BuiltinGitExecutionMechanismV1 | undefined,
): Promise<BuiltinOperationExecutionValueV1> {
  if (!mechanism) {
    return projectGitResultV1({
      ok: false,
      output: 'Typed Git inspect broker is unavailable.',
      failureCode: 'sandbox_capability_missing',
    });
  }
  const request = gitRequestV1(input);
  if (!request) return operationFailure('Git inspect input is invalid.');
  return projectGitResultV1(await mechanism.inspect(request, context.signal));
}

function gitRequestV1(input: Readonly<Record<string, unknown>>): GitInspectRequestV1 | undefined {
  const operation = input.operation;
  if (
    operation !== 'status' &&
    operation !== 'diff' &&
    operation !== 'log' &&
    operation !== 'branch_list'
  ) {
    return undefined;
  }
  const paths = Array.isArray(input.paths) ? (input.paths as string[]) : undefined;
  return {
    operation,
    ...(paths ? { paths } : {}),
    ...(typeof input.revision === 'string' ? { revision: input.revision } : {}),
    ...(optionalIntegerValue(input.max_records) === undefined
      ? {}
      : { maxRecords: optionalIntegerValue(input.max_records) }),
    ...(optionalIntegerValue(input.max_output_bytes) === undefined
      ? {}
      : { maxOutputBytes: optionalIntegerValue(input.max_output_bytes) }),
    ...(optionalIntegerValue(input.timeout_ms) === undefined
      ? {}
      : { timeoutMs: optionalIntegerValue(input.timeout_ms) }),
  };
}

function projectGitResultV1(output: GitBrokerResultV1): BuiltinOperationExecutionValueV1 {
  const modelContent = JSON.stringify({
    ok: output.ok,
    output: output.output,
    ...(output.failureCode ? { failure_code: output.failureCode } : {}),
    ...(output.nextCapability ? { next_capability: output.nextCapability } : {}),
    ...(output.receipt ? { receipt: output.receipt } : {}),
  });
  const resultMeta: Record<string, RuntimeJsonValueV1> = {
    ...(output.failureCode ? { gitFailureCode: output.failureCode } : {}),
    ...(output.nextCapability ? { nextCapability: output.nextCapability } : {}),
    ...(output.receipt
      ? {
          invocationId: output.receipt.invocationId,
          capabilityRevision: output.receipt.featureRevision,
          gitReceipt: output.receipt as unknown as RuntimeJsonValueV1,
        }
      : {}),
  };
  return operationEnvelope(
    output.ok,
    output.ok ? modelContent : '',
    output.ok ? '' : modelContent,
    resultMeta,
    {
      ...(output.failureCode
        ? { classifierAdviceV1: gitClassifierAdviceV1(output.failureCode, output.nextCapability) }
        : {}),
      ...(output.failureCode === 'timed_out'
        ? { terminationReason: 'timed_out' }
        : output.failureCode === 'cancelled'
          ? { terminationReason: 'cancelled' }
          : {}),
    },
  );
}

function gitClassifierAdviceV1(
  failureCode: GitBrokerFailureCodeV1,
  nextCapability?: 'git_inspect',
): Readonly<Record<string, RuntimeJsonValueV1>> {
  const detailCode = {
    sandbox_capability_missing: 'sandbox_capability_missing',
    protected_path_denied: 'protected_path_denied',
    git_operation_unsupported: 'git_operation_unsupported',
    managed_network_setup_required: 'managed_network_setup_required',
    repository_invalid: 'repository_invalid',
    repository_hostile: 'repository_hostile',
    binary_untrusted: 'binary_untrusted',
    lock: 'repository_lock',
    cancelled: 'cancelled_by_user',
    timed_out: 'timed_out',
    process_failed: 'tool_reported_failure',
    receipt_invalid: 'receipt_invalid',
  }[failureCode];
  return Object.freeze({
    detailCode,
    disposition: 'never',
    maximumAdditionalCalls: 0,
    safeAutomaticRetry: false,
    ...(nextCapability ? { capabilityIntent: nextCapability } : {}),
  });
}

function succeededReceipt(
  operationId: Rmv112OperationIdV1,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  value: BuiltinOperationExecutionValueV1,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_12_PROVIDER_ID_V1,
    executorRevision: RMV1_12_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  operationId: Rmv112OperationIdV1,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  code: string,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_12_PROVIDER_ID_V1,
    executorRevision: RMV1_12_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'failed',
    dispatchCertainty: 'none',
    cleanupCertainty: 'not_required',
    failure: Object.freeze({
      code,
      message: `Builtin Runtime operation ${operationId} is unavailable.`,
      retryable: false,
    }),
  });
}

function operationSuccess(
  stdout: string,
  resultMeta: Readonly<Record<string, RuntimeJsonValueV1>>,
  extra: Readonly<Record<string, unknown>> = {},
): BuiltinOperationExecutionValueV1 {
  return operationEnvelope(true, stdout, '', resultMeta, extra);
}

function operationFailure(
  stderr: string,
  resultMeta: Readonly<Record<string, RuntimeJsonValueV1>> = {},
  classifierAdviceV1?: Readonly<Record<string, RuntimeJsonValueV1>>,
): BuiltinOperationExecutionValueV1 {
  return operationEnvelope(false, '', stderr, resultMeta, {
    ...(classifierAdviceV1 ? { classifierAdviceV1 } : {}),
  });
}

function operationEnvelope(
  ok: boolean,
  stdout: string,
  stderr: string,
  resultMeta: Readonly<Record<string, RuntimeJsonValueV1>>,
  extra: Readonly<Record<string, unknown>>,
): BuiltinOperationExecutionValueV1 {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok,
    stdout,
    stderr,
    resultMeta: Object.freeze(resultMeta),
    ...extra,
  }) as BuiltinOperationExecutionValueV1;
}

function correctArgsAdvice(): Readonly<Record<string, RuntimeJsonValueV1>> {
  return Object.freeze({
    detailCode: 'tool_reported_failure',
    disposition: 'correct_args',
    maximumAdditionalCalls: 1,
    requiresNewModelResponse: true,
    safeAutomaticRetry: false,
  });
}

function alternativeSearchAdvice(): Readonly<Record<string, RuntimeJsonValueV1>> {
  return Object.freeze({
    detailCode: 'tool_reported_failure',
    disposition: 'alternative',
    maximumAdditionalCalls: 1,
    requiresNewModelResponse: true,
    safeAutomaticRetry: false,
    capabilityIntent: 'workspace.search',
  });
}

function userActionAdvice(): Readonly<Record<string, RuntimeJsonValueV1>> {
  return Object.freeze({
    detailCode: 'tool_reported_failure',
    disposition: 'user_action',
    maximumAdditionalCalls: 0,
    requiresNewModelResponse: true,
    safeAutomaticRetry: false,
  });
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalIntegerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
