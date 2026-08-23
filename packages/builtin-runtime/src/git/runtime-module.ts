import type { WorkspaceFilesystemObservationRecord } from '@kite/runtime-contract';
import type {
  CapabilityEffects,
  CapabilityExecutionContext,
  CapabilityExecutionMechanism,
  CapabilityExecutor,
  ExecutionReceipt,
  GitBrokerFailureCode,
  GitBrokerResult,
  GitInspectRequest,
  RuntimeJsonValue,
  RuntimeModule,
  RuntimeModuleRegistryWriter,
  WorkspaceFilesystemCommittedMutation,
  WorkspaceFilesystemMutationOperation,
  WorkspaceFilesystemObserveObservation,
  WorkspaceFilesystemOperation,
  WorkspaceFilesystemPreimageObservation,
  WorkspaceFilesystemProviderFailure,
} from '@kite/runtime-spi';
import { defineRuntimeModule } from '@kite/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';
import {
  builtinExecutionTraits,
  defineBuiltinCapabilityContract,
  gitAvailability,
  parserForBuiltinOperation,
  staticEffectsClassifier,
} from '../catalog-contract';
import {
  computeLineDiff,
  formatContentOutput,
  formatDiffOutput,
  formatMultiHunkDiff,
} from '../filesystem/diff';
import {
  projectionDigest,
  truncateProjectedLines,
  truncateProjectedStreams,
} from '../filesystem/projection';
import type { BuiltinOperationExecutionValue } from '../model/runtime-module';
import {
  createBuiltinPolicyCompiler,
  fileBuiltinPolicyRule,
  readOnlyBuiltinPolicyRule,
} from '../policy-compiler';
import { builtinToolDescription } from '../tool-contracts';
import { BUILTIN_JSON_SCHEMAS_, BUILTIN_ZOD_SCHEMAS_ } from '../tool-schemas';

export const GIT_PROVIDER_ID_ = 'kite-builtin-runtime-git' as const;

export const GIT_OPERATION_IDS_ = Object.freeze([
  'builtin:read_file',
  'builtin:search_content',
  'builtin:search_files',
  'builtin:write_file',
  'builtin:edit_file',
  'builtin:git_inspect',
] as const);

export type GitOperationId = (typeof GIT_OPERATION_IDS_)[number];

export const READ_FILE_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:read_file'];
export const SEARCH_CONTENT_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:search_content'];
export const SEARCH_FILES_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:search_files'];
export const WRITE_FILE_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:write_file'];
export const EDIT_FILE_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:edit_file'];
export const GIT_INSPECT_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:git_inspect'];

const INPUT_SCHEMAS_: Readonly<Record<GitOperationId, Readonly<Record<string, RuntimeJsonValue>>>> =
  Object.freeze({
    'builtin:read_file': READ_FILE_INPUT_SCHEMA_,
    'builtin:search_content': SEARCH_CONTENT_INPUT_SCHEMA_,
    'builtin:search_files': SEARCH_FILES_INPUT_SCHEMA_,
    'builtin:write_file': WRITE_FILE_INPUT_SCHEMA_,
    'builtin:edit_file': EDIT_FILE_INPUT_SCHEMA_,
    'builtin:git_inspect': GIT_INSPECT_INPUT_SCHEMA_,
  });

const EFFECTS_ = Object.freeze({
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

const EXECUTION_MECHANISMS_: Readonly<Record<GitOperationId, CapabilityExecutionMechanism>> =
  Object.freeze({
    'builtin:read_file': 'filesystem',
    'builtin:search_content': 'filesystem',
    'builtin:search_files': 'filesystem',
    'builtin:write_file': 'filesystem',
    'builtin:edit_file': 'filesystem',
    'builtin:git_inspect': 'git',
  });

export const GIT_CAPABILITY_REVISIONS_: Readonly<Record<GitOperationId, string>> = Object.freeze(
  Object.fromEntries(
    GIT_OPERATION_IDS_.map((operationId) => [
      operationId,
      digestCapabilityBindingValue({
        schema: 'kite.git-operation-capability.current',
        operationId,
        inputSchema: INPUT_SCHEMAS_[operationId],
        effects: EFFECTS_[operationId],
      }),
    ]),
  ) as Record<GitOperationId, string>,
);

export const GIT_EXECUTOR_REVISIONS_: Readonly<Record<GitOperationId, string>> = Object.freeze(
  Object.fromEntries(
    GIT_OPERATION_IDS_.map((operationId) => [
      operationId,
      digestCapabilityBindingValue({
        schema: 'kite.git-operation-executor.current',
        operationId,
        capabilityRevision: GIT_CAPABILITY_REVISIONS_[operationId],
      }),
    ]),
  ) as Record<GitOperationId, string>,
);

export interface BuiltinFilesystemPipelineResult {
  readonly ok: boolean;
  readonly observation?:
    | WorkspaceFilesystemObserveObservation
    | WorkspaceFilesystemCommittedMutation;
  readonly filesystemObservation?: WorkspaceFilesystemObservationRecord;
  readonly preimage?: WorkspaceFilesystemPreimageObservation;
  readonly failure?: WorkspaceFilesystemProviderFailure;
}

export interface BuiltinFilesystemExecutionMechanism {
  readonly allowExternalPaths: boolean;
  dispatch(operation: WorkspaceFilesystemOperation): Promise<BuiltinFilesystemPipelineResult>;
}

export interface BuiltinGitExecutionMechanism {
  inspect(request: GitInspectRequest, signal?: AbortSignal): Promise<GitBrokerResult>;
}

export interface GitExecutionMechanisms extends Readonly<Record<string, unknown>> {
  readonly filesystem?: BuiltinFilesystemExecutionMechanism;
  readonly git?: BuiltinGitExecutionMechanism;
}

export function createGitRuntimeModule(): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-builtin-runtime-git',
    providerId: GIT_PROVIDER_ID_,
    revision: 'git-current',
    operationIds: GIT_OPERATION_IDS_,
    register: (registry) => registerGitOperations(registry),
  });
}

function registerGitOperations(registry: RuntimeModuleRegistryWriter): void {
  for (const operationId of GIT_OPERATION_IDS_) {
    const capabilityRevision = GIT_CAPABILITY_REVISIONS_[operationId];
    const executorRevision = GIT_EXECUTOR_REVISIONS_[operationId];
    registry.registerCapability(
      defineBuiltinCapabilityContract(
        {
          capabilityId: operationId,
          revision: capabilityRevision,
          providerId: GIT_PROVIDER_ID_,
          title: `Builtin Runtime operation ${operationId}`,
          executionMechanism: EXECUTION_MECHANISMS_[operationId],
          ...(operationId.startsWith('builtin:')
            ? {
                toolName: operationId.slice('builtin:'.length),
                description: builtinToolDescription(operationId.slice('builtin:'.length)),
                visibility: 'model' as const,
              }
            : { visibility: 'internal' as const }),
          effects: EFFECTS_[operationId],
          inputSchema: INPUT_SCHEMAS_[operationId],
          inputSchemaDigest: digestCapabilityBindingValue(INPUT_SCHEMAS_[operationId]),
        },
        gitContractOptions(operationId, capabilityRevision, EFFECTS_[operationId]),
      ),
    );
    registry.registerExecutor({
      providerId: GIT_PROVIDER_ID_,
      capabilityId: operationId,
      capabilityRevision,
      executorRevision,
      execute: (request, context) => executeGitOperation(operationId, request, context),
    } satisfies CapabilityExecutor);
  }
}

function gitContractOptions(
  operationId: GitOperationId,
  revision: string,
  effects: CapabilityEffects,
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
      ? fileBuiltinPolicyRule
      : readOnlyBuiltinPolicyRule;
  const parser = parserForBuiltinOperation(operationId, revision);
  return {
    parser,
    kind: 'computer' as const,
    minimumApproval: 'none' as const,
    ...(operationId === 'builtin:git_inspect' ? { availability: gitAvailability } : {}),
    ...(operationId === 'builtin:git_inspect'
      ? { governanceRevision: 'git-inspect-v1' }
      : operationId === 'builtin:read_file' ||
          operationId === 'builtin:search_content' ||
          operationId === 'builtin:search_files' ||
          operationId === 'builtin:write_file' ||
          operationId === 'builtin:edit_file'
        ? { governanceRevision: 'trusted-workspace-file-access-v1' }
        : {}),
    effectsClassifier: staticEffectsClassifier(
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
    policyCompiler: createBuiltinPolicyCompiler({
      operationId,
      capabilityRevision: revision,
      parserRevision: parser.parserRevision,
      declaredEffects: effects,
      minimumApproval: 'none',
      rule: policyRule,
    }),
    ...(workspaceRead
      ? {
          executionTraitsDeclaration: builtinExecutionTraits({
            resourceScopes: [{ kind: 'workspace', key: 'workspace' }],
            interactionBarrier: false,
            concurrencyGroup: 'parallel-read',
          }),
        }
      : {}),
    execution: readOnly ? { retry: 'safe_read' as const } : { retry: 'never' as const },
  };
}

async function executeGitOperation(
  operationId: GitOperationId,
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: CapabilityExecutionContext,
): Promise<ExecutionReceipt> {
  const parsed = BUILTIN_ZOD_SCHEMAS_[operationId].safeParse(request.input);
  const input = parsed.success ? asRecord(parsed.data) : undefined;
  if (!input) {
    return failedReceipt(operationId, request.invocationId, context, 'invalid_input');
  }
  const mechanisms = context.environment.mechanisms as GitExecutionMechanisms | undefined;
  let value: BuiltinOperationExecutionValue;
  if (operationId === 'builtin:git_inspect') {
    value = await executeGitInspect(input, context, mechanisms?.git);
  } else {
    value = await executeFilesystemOperation(operationId, input, mechanisms?.filesystem);
  }
  return succeededReceipt(operationId, request.invocationId, context, value);
}

async function executeFilesystemOperation(
  operationId: Exclude<GitOperationId, 'builtin:git_inspect'>,
  input: Readonly<Record<string, unknown>>,
  mechanism: BuiltinFilesystemExecutionMechanism | undefined,
): Promise<BuiltinOperationExecutionValue> {
  if (!mechanism) return operationFailure('Workspace filesystem Provider is unavailable.');
  const pathScope = mechanism.allowExternalPaths
    ? operationId === 'builtin:write_file' || operationId === 'builtin:edit_file'
      ? 'approved_external'
      : 'external_read'
    : 'workspace_only';
  let operation: WorkspaceFilesystemOperation;
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
      return projectReadFile(operation.path, result);
    case 'search_content':
      return projectSearchContent(operation.path, result);
    case 'search_files':
      return projectSearchFiles(operation.path, result);
    case 'write_file':
      return projectWriteFile(operation.path, operation.content, result);
    case 'edit_file':
      return projectEditFile(operation, result);
  }
}

export const MAX_MODEL_READ_FILE_CHARS_ = 64 * 1024;

function projectReadFile(
  path: string,
  result: BuiltinFilesystemPipelineResult,
): BuiltinOperationExecutionValue {
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
  const projected = projectReadContent(observation);
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

function projectReadContent(
  output: Extract<WorkspaceFilesystemObserveObservation, { kind: 'read_file' }>,
): { content: string; truncated: boolean } {
  const fromLine = output.fromLine ?? 1;
  const toLine = output.toLine ?? fromLine;
  const sourceHasMore = toLine < output.totalLines;
  if (!sourceHasMore && output.content.length <= MAX_MODEL_READ_FILE_CHARS_) {
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
      (hasMore ? candidateLength + marker.length + 1 : candidateLength) > MAX_MODEL_READ_FILE_CHARS_
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
  const available = Math.max(0, MAX_MODEL_READ_FILE_CHARS_ - marker.length - 1);
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

function projectSearchFiles(
  path: string,
  result: BuiltinFilesystemPipelineResult,
): BuiltinOperationExecutionValue {
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

function projectSearchContent(
  path: string,
  result: BuiltinFilesystemPipelineResult,
): BuiltinOperationExecutionValue {
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

function projectWriteFile(
  path: string,
  content: string,
  result: BuiltinFilesystemPipelineResult,
): BuiltinOperationExecutionValue {
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

function projectEditFile(
  operation: Extract<WorkspaceFilesystemMutationOperation, { kind: 'edit_file' }>,
  result: BuiltinFilesystemPipelineResult,
): BuiltinOperationExecutionValue {
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

async function executeGitInspect(
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContext,
  mechanism: BuiltinGitExecutionMechanism | undefined,
): Promise<BuiltinOperationExecutionValue> {
  if (!mechanism) {
    return projectGitResult({
      ok: false,
      output: 'Typed Git inspect broker is unavailable.',
      failureCode: 'sandbox_capability_missing',
    });
  }
  const request = gitRequest(input);
  if (!request) return operationFailure('Git inspect input is invalid.');
  return projectGitResult(await mechanism.inspect(request, context.signal));
}

function gitRequest(input: Readonly<Record<string, unknown>>): GitInspectRequest | undefined {
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

function projectGitResult(output: GitBrokerResult): BuiltinOperationExecutionValue {
  const modelContent = JSON.stringify({
    ok: output.ok,
    output: output.output,
    ...(output.failureCode ? { failure_code: output.failureCode } : {}),
    ...(output.nextCapability ? { next_capability: output.nextCapability } : {}),
    ...(output.receipt ? { receipt: output.receipt } : {}),
  });
  const resultMeta: Record<string, RuntimeJsonValue> = {
    ...(output.failureCode ? { gitFailureCode: output.failureCode } : {}),
    ...(output.nextCapability ? { nextCapability: output.nextCapability } : {}),
    ...(output.receipt
      ? {
          invocationId: output.receipt.invocationId,
          capabilityRevision: output.receipt.featureRevision,
          gitReceipt: output.receipt as unknown as RuntimeJsonValue,
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
        ? { classifierAdvice: gitClassifierAdvice(output.failureCode, output.nextCapability) }
        : {}),
      ...(output.failureCode === 'timed_out'
        ? { terminationReason: 'timed_out' }
        : output.failureCode === 'cancelled'
          ? { terminationReason: 'cancelled' }
          : {}),
    },
  );
}

function gitClassifierAdvice(
  failureCode: GitBrokerFailureCode,
  nextCapability?: 'git_inspect',
): Readonly<Record<string, RuntimeJsonValue>> {
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
  operationId: GitOperationId,
  invocationId: string,
  context: CapabilityExecutionContext,
  value: BuiltinOperationExecutionValue,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: GIT_PROVIDER_ID_,
    executorRevision: GIT_EXECUTOR_REVISIONS_[operationId],
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  operationId: GitOperationId,
  invocationId: string,
  context: CapabilityExecutionContext,
  code: string,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: GIT_PROVIDER_ID_,
    executorRevision: GIT_EXECUTOR_REVISIONS_[operationId],
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
  resultMeta: Readonly<Record<string, RuntimeJsonValue>>,
  extra: Readonly<Record<string, unknown>> = {},
): BuiltinOperationExecutionValue {
  return operationEnvelope(true, stdout, '', resultMeta, extra);
}

function operationFailure(
  stderr: string,
  resultMeta: Readonly<Record<string, RuntimeJsonValue>> = {},
  classifierAdvice?: Readonly<Record<string, RuntimeJsonValue>>,
): BuiltinOperationExecutionValue {
  return operationEnvelope(false, '', stderr, resultMeta, {
    ...(classifierAdvice ? { classifierAdvice } : {}),
  });
}

function operationEnvelope(
  ok: boolean,
  stdout: string,
  stderr: string,
  resultMeta: Readonly<Record<string, RuntimeJsonValue>>,
  extra: Readonly<Record<string, unknown>>,
): BuiltinOperationExecutionValue {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok,
    stdout,
    stderr,
    resultMeta: Object.freeze(resultMeta),
    ...extra,
  }) as BuiltinOperationExecutionValue;
}

function correctArgsAdvice(): Readonly<Record<string, RuntimeJsonValue>> {
  return Object.freeze({
    detailCode: 'tool_reported_failure',
    disposition: 'correct_args',
    maximumAdditionalCalls: 1,
    requiresNewModelResponse: true,
    safeAutomaticRetry: false,
  });
}

function alternativeSearchAdvice(): Readonly<Record<string, RuntimeJsonValue>> {
  return Object.freeze({
    detailCode: 'tool_reported_failure',
    disposition: 'alternative',
    maximumAdditionalCalls: 1,
    requiresNewModelResponse: true,
    safeAutomaticRetry: false,
    capabilityIntent: 'workspace.search',
  });
}

function userActionAdvice(): Readonly<Record<string, RuntimeJsonValue>> {
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
