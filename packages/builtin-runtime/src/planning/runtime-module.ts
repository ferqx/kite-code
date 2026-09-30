import type {
  CapabilityExecutionContext,
  CapabilityExecutor,
  ExecutionReceipt,
  RuntimeModule,
  RuntimeModuleRegistryWriter,
} from '@kite-ai/runtime-spi';
import { defineRuntimeModule } from '@kite-ai/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';
import {
  builtinExecutionTraits,
  defineBuiltinCapabilityContract,
  isReadOnlyShellCommand,
  parserForBuiltinOperation,
  shellEffectsClassifier,
  staticEffectsClassifier,
} from '../catalog-contract';
import { projectionDigest, truncateProjectedStreams } from '../filesystem/projection';
import type { BuiltinOperationExecutionValue } from '../model/runtime-module';
import {
  createBuiltinPolicyCompiler,
  readOnlyBuiltinPolicyRule,
  shellBuiltinPolicyRule,
  taskBuiltinPolicyRule,
} from '../policy-compiler';
import { SHELL_SEMANTICS_REVISION_ } from '../shell-semantics';
import { builtinToolDescription } from '../tool-contracts';
import { BUILTIN_JSON_SCHEMAS_, BUILTIN_ZOD_SCHEMAS_ } from '../tool-schemas';

export const PLANNING_PROVIDER_ID_ = 'kite-builtin-runtime-planning' as const;
export const PLANNING_OPERATION_ID_ = 'builtin:shell_execute' as const;
export const SHELL_READ_OPERATION_ID_ = 'builtin:shell_read' as const;
export const SHELL_STOP_OPERATION_ID_ = 'builtin:shell_stop' as const;
export const DEFAULT_SHELL_TIMEOUT_MS_ = 10 * 60 * 1_000;

export const SHELL_EXECUTE_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:shell_execute'];

const SHELL_EFFECTS_ = Object.freeze({
  filesystem: 'unknown',
  network: 'unknown',
  externalState: 'unknown',
});

export const PLANNING_CAPABILITY_REVISION_ = digestCapabilityBindingValue({
  schema: 'kite.planning-operation-capability.current',
  operationId: PLANNING_OPERATION_ID_,
  inputSchema: SHELL_EXECUTE_INPUT_SCHEMA_,
  effects: SHELL_EFFECTS_,
  shellSemanticsRevision: SHELL_SEMANTICS_REVISION_,
});

export const PLANNING_EXECUTOR_REVISION_ = digestCapabilityBindingValue({
  schema: 'kite.planning-operation-executor.current',
  operationId: PLANNING_OPERATION_ID_,
  capabilityRevision: PLANNING_CAPABILITY_REVISION_,
});

export type BuiltinShellIntent = 'inspect' | 'verify' | 'build' | 'test' | 'git' | 'other';

/** Audit metadata is derived from the canonical command shape, never model input. */
export function classifyBuiltinShellIntent(command: string): BuiltinShellIntent {
  const trimmed = command.trim();
  if (
    /(^|[;&|]\s*)(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|(^|[;&|]\s*)(pytest|cargo test|go test)\b/iu.test(
      trimmed,
    )
  ) {
    return 'test';
  }
  if (
    /(^|[;&|]\s*)(bun|npm|pnpm|yarn)\s+(run\s+)?(build|compile)\b|(^|[;&|]\s*)(cargo build|go build)\b/iu.test(
      trimmed,
    )
  ) {
    return 'build';
  }
  if (/(^|[;&|]\s*)git\b/iu.test(trimmed)) return 'git';
  if (isReadOnlyShellCommand(trimmed)) return 'inspect';
  if (/\b(typecheck|lint|check)\b/iu.test(trimmed)) return 'verify';
  return 'other';
}

const BUILTIN_SHELL_INTENT_VALUES_ = Object.freeze([
  'inspect',
  'verify',
  'build',
  'test',
  'git',
  'other',
] as const satisfies readonly BuiltinShellIntent[]);

export function projectBuiltinShellIntent(meta: { readonly intent?: string }): BuiltinShellIntent {
  return (BUILTIN_SHELL_INTENT_VALUES_ as readonly string[]).includes(meta.intent ?? '')
    ? (meta.intent as BuiltinShellIntent)
    : 'other';
}

export interface BuiltinShellTerminalExecutionResult {
  readonly status?: 'exited';
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly intent: BuiltinShellIntent;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
  /** Exact process phase retained so post-GO uncertainty cannot become a normal failure. */
  readonly executionPhase?:
    | 'not_started'
    | 'supervisor_started_before_go'
    | 'go_started'
    | 'unknown_after_go';
  readonly sandboxFailure?: Readonly<{
    readonly code: string;
    readonly stage: 'pre_dispatch' | 'post_dispatch';
    readonly cleanupConfirmed: boolean;
  }>;
  readonly processCleanup?: Readonly<{
    readonly confirmedExited: boolean;
    readonly gracefulRequested: boolean;
    readonly forced: boolean;
    readonly unconfirmedDescendantCount: number;
  }>;
  readonly shellId?: string;
  readonly cursor?: number;
}

export interface BuiltinShellRunningExecutionResult {
  readonly status: 'running';
  readonly shellId: string;
  readonly cursor: number;
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly intent: BuiltinShellIntent;
}

export type BuiltinShellExecutionResult =
  | BuiltinShellTerminalExecutionResult
  | BuiltinShellRunningExecutionResult;

/** Package-owned marker for an attempted Shell operation without a trustworthy terminal. */
export class BuiltinShellExecutionUnknownError extends Error {
  readonly code = 'BUILTIN_SHELL_EXECUTION_UNKNOWN' as const;

  constructor(message = 'Shell execution outcome is unknown after dispatch.') {
    super(message.slice(0, 512));
    this.name = 'BuiltinShellExecutionUnknownError';
  }
}

/** Invocation-scoped Host mechanism. Workspace, authority, signal and progress are closed over. */
export interface BuiltinShellExecutionMechanism {
  execute(
    input: Readonly<{
      command: string;
      timeoutMs?: number;
      yieldMs?: number;
      mode?: 'finite' | 'service';
    }>,
  ): Promise<BuiltinShellExecutionResult>;
  read?(
    input: Readonly<{
      shellId: string;
      cursor: number;
      waitMs?: number;
      waitUntil?: 'terminal';
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<Record<string, unknown>>>;
  stop?(input: Readonly<{ shellId: string }>): Promise<Readonly<Record<string, unknown>>>;
}

export interface PlanningExecutionMechanisms extends Readonly<Record<string, unknown>> {
  readonly shell?: BuiltinShellExecutionMechanism;
}

export function createPlanningRuntimeModule(): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-builtin-runtime-planning',
    providerId: PLANNING_PROVIDER_ID_,
    revision: 'planning-current',
    operationIds: Object.freeze([
      PLANNING_OPERATION_ID_,
      SHELL_READ_OPERATION_ID_,
      SHELL_STOP_OPERATION_ID_,
    ]),
    register: registerPlanningOperation,
  });
}

function registerPlanningOperation(registry: RuntimeModuleRegistryWriter): void {
  const parser = parserForBuiltinOperation(PLANNING_OPERATION_ID_, PLANNING_CAPABILITY_REVISION_);
  registry.registerCapability(
    defineBuiltinCapabilityContract(
      {
        capabilityId: PLANNING_OPERATION_ID_,
        revision: PLANNING_CAPABILITY_REVISION_,
        providerId: PLANNING_PROVIDER_ID_,
        title: 'Builtin Runtime operation builtin:shell_execute',
        executionMechanism: 'shell',
        toolName: 'shell_execute',
        description: builtinToolDescription('shell_execute'),
        visibility: 'model',
        effects: SHELL_EFFECTS_,
        inputSchema: SHELL_EXECUTE_INPUT_SCHEMA_,
        inputSchemaDigest: digestCapabilityBindingValue(SHELL_EXECUTE_INPUT_SCHEMA_),
      },
      {
        parser,
        kind: 'computer',
        minimumApproval: 'user',
        governanceRevision: 'shell-effects-v1',
        effectsClassifier: shellEffectsClassifier(SHELL_EFFECTS_),
        executionTraitsDeclaration: builtinExecutionTraits({
          resourceScopes: [
            { kind: 'process', key: 'shell' },
            { kind: 'workspace', key: 'workspace' },
          ],
          interactionBarrier: false,
          concurrencyGroup: 'parallel-read',
        }),
        execution: { retry: 'never' },
        policyCompiler: createBuiltinPolicyCompiler({
          operationId: PLANNING_OPERATION_ID_,
          capabilityRevision: PLANNING_CAPABILITY_REVISION_,
          parserRevision: parser.parserRevision,
          declaredEffects: SHELL_EFFECTS_,
          minimumApproval: 'user',
          rule: shellBuiltinPolicyRule,
        }),
      },
    ),
  );
  registry.registerExecutor({
    providerId: PLANNING_PROVIDER_ID_,
    capabilityId: PLANNING_OPERATION_ID_,
    capabilityRevision: PLANNING_CAPABILITY_REVISION_,
    executorRevision: PLANNING_EXECUTOR_REVISION_,
    execute: executeShellOperation,
  } satisfies CapabilityExecutor);
  registerManagedShellOperation(registry, SHELL_READ_OPERATION_ID_, true);
  registerManagedShellOperation(registry, SHELL_STOP_OPERATION_ID_, false);
}

function registerManagedShellOperation(
  registry: RuntimeModuleRegistryWriter,
  operationId: typeof SHELL_READ_OPERATION_ID_ | typeof SHELL_STOP_OPERATION_ID_,
  readOnly: boolean,
): void {
  const inputSchema = BUILTIN_JSON_SCHEMAS_[operationId];
  const revision = digestCapabilityBindingValue({
    schema: 'kite.managed-shell-operation.current',
    operationId,
    inputSchema,
  });
  const executorRevision = digestCapabilityBindingValue({ operationId, revision });
  const parser = parserForBuiltinOperation(operationId, revision);
  const effects = Object.freeze({
    filesystem: 'none' as const,
    network: 'none' as const,
    externalState: readOnly ? ('none' as const) : ('write' as const),
  });
  registry.registerCapability(
    defineBuiltinCapabilityContract(
      {
        capabilityId: operationId,
        revision,
        providerId: PLANNING_PROVIDER_ID_,
        title: `Builtin Runtime operation ${operationId}`,
        executionMechanism: 'shell',
        toolName: operationId.slice('builtin:'.length),
        description: builtinToolDescription(
          operationId.slice('builtin:'.length) as 'shell_read' | 'shell_stop',
        ),
        visibility: 'model',
        effects,
        inputSchema,
        inputSchemaDigest: digestCapabilityBindingValue(inputSchema),
      },
      {
        parser,
        kind: 'computer',
        minimumApproval: 'none',
        governanceRevision: 'managed-shell-control-v1',
        effectsClassifier: staticEffectsClassifier(
          readOnly ? 'read_only' : 'external_side_effect',
          !readOnly,
          readOnly
            ? 'Reads one Runtime-owned Shell execution.'
            : 'Stops one Runtime-owned Shell execution.',
          effects,
        ),
        executionTraitsDeclaration: builtinExecutionTraits({
          resourceScopes: [{ kind: 'process', key: 'shell' }],
          interactionBarrier: false,
          concurrencyGroup: 'parallel-read',
        }),
        execution: { retry: readOnly ? 'safe_read' : 'never' },
        policyCompiler: createBuiltinPolicyCompiler({
          operationId,
          capabilityRevision: revision,
          parserRevision: parser.parserRevision,
          declaredEffects: effects,
          minimumApproval: 'none',
          rule: readOnly ? readOnlyBuiltinPolicyRule : taskBuiltinPolicyRule,
        }),
      },
    ),
  );
  registry.registerExecutor({
    providerId: PLANNING_PROVIDER_ID_,
    capabilityId: operationId,
    capabilityRevision: revision,
    executorRevision,
    execute: (request, context) =>
      executeManagedShellOperation(operationId, executorRevision, request, context),
  } satisfies CapabilityExecutor);
}

async function executeManagedShellOperation(
  operationId: typeof SHELL_READ_OPERATION_ID_ | typeof SHELL_STOP_OPERATION_ID_,
  executorRevision: string,
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: CapabilityExecutionContext,
): Promise<ExecutionReceipt> {
  const parsed = BUILTIN_ZOD_SCHEMAS_[operationId].safeParse(request.input);
  if (!parsed.success)
    return failedReceipt(request.invocationId, context, 'invalid_input', executorRevision);
  const input = parsed.data as {
    shell_id: string;
    cursor?: number;
    wait_ms?: number;
    wait_until?: 'terminal';
  };
  const mechanism = (context.environment.mechanisms as PlanningExecutionMechanisms | undefined)
    ?.shell;
  const snapshot =
    operationId === SHELL_STOP_OPERATION_ID_
      ? await mechanism?.stop?.({ shellId: input.shell_id })
      : await mechanism?.read?.({
          shellId: input.shell_id,
          cursor: input.cursor ?? 0,
          ...(input.wait_ms === undefined ? {} : { waitMs: input.wait_ms }),
          ...(input.wait_until === undefined ? {} : { waitUntil: input.wait_until }),
          signal: context.signal,
        });
  if (!snapshot)
    return failedReceipt(request.invocationId, context, 'mechanism_unavailable', executorRevision);
  // The live output page is already present on the snapshot. Repeating a
  // terminal preview inside result would bloat the Tool frame and can exceed
  // the protocol envelope before the caller can request the next cursor.
  const terminal = snapshot.result as BuiltinShellTerminalExecutionResult | undefined;
  const projectedSnapshot =
    terminal && typeof terminal === 'object' && !Array.isArray(terminal)
      ? {
          ...snapshot,
          result: {
            ...(terminal.status ? { status: terminal.status } : {}),
            ok: terminal.ok,
            exitCode: terminal.exitCode,
            intent: terminal.intent,
            ...(terminal.timedOut ? { timedOut: true } : {}),
            ...(terminal.aborted ? { aborted: true } : {}),
            ...(terminal.terminationReason
              ? { terminationReason: terminal.terminationReason }
              : {}),
            ...(terminal.executionPhase ? { executionPhase: terminal.executionPhase } : {}),
            ...(terminal.processCleanup ? { processCleanup: terminal.processCleanup } : {}),
          },
        }
      : snapshot;
  const text = JSON.stringify(projectedSnapshot);
  return succeededReceipt(
    request.invocationId,
    context,
    Object.freeze({
      schema: 'kite.builtin-operation-result.v1',
      ok: true,
      stdout: text,
      stderr: '',
      resultMeta: Object.freeze({
        operation: operationId,
        snapshot: projectedSnapshot as never,
        ...(typeof snapshot.shellId === 'string' ? { shellId: snapshot.shellId } : {}),
        ...(snapshot.status === 'running' || snapshot.status === 'exited'
          ? { shellStatus: snapshot.status }
          : {}),
      }),
    }) as BuiltinOperationExecutionValue,
    executorRevision,
  );
}

async function executeShellOperation(
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: CapabilityExecutionContext,
): Promise<ExecutionReceipt> {
  const parsed = BUILTIN_ZOD_SCHEMAS_[PLANNING_OPERATION_ID_].safeParse(request.input);
  const input = parsed.success
    ? (parsed.data as {
        readonly command: string;
        readonly timeout_ms?: number;
        readonly yield_ms?: number;
        readonly mode?: 'finite' | 'service';
      })
    : undefined;
  if (!input) {
    return failedReceipt(request.invocationId, context, 'invalid_input');
  }
  const mechanisms = context.environment.mechanisms as PlanningExecutionMechanisms | undefined;
  const mechanism = mechanisms?.shell;
  let result: BuiltinShellExecutionResult;
  if (!mechanism) {
    result = {
      ok: false,
      command: input.command,
      exitCode: -1,
      stdout: '',
      stderr: 'Sandbox execution Provider is unavailable.',
      intent: 'other',
      terminationReason: 'sandbox_denied',
    };
  } else {
    try {
      result = await mechanism.execute({
        command: input.command,
        ...(input.mode === 'service' && input.timeout_ms === undefined
          ? {}
          : { timeoutMs: optionalPositiveInteger(input.timeout_ms) ?? DEFAULT_SHELL_TIMEOUT_MS_ }),
        ...(input.mode === 'service'
          ? { yieldMs: input.yield_ms ?? 0 }
          : input.yield_ms === undefined
            ? {}
            : { yieldMs: input.yield_ms }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      });
    } catch (error) {
      if (error instanceof BuiltinShellExecutionUnknownError) throw error;
      const aborted = error instanceof Error && error.name === 'AbortError';
      result = {
        ok: false,
        command: input.command,
        exitCode: aborted ? 130 : -1,
        stdout: '',
        stderr: aborted ? 'Command cancelled by user.' : 'Shell execution adapter failed.',
        intent: 'other',
        ...(aborted ? { aborted: true, terminationReason: 'cancelled' as const } : {}),
      };
    }
  }
  return succeededReceipt(request.invocationId, context, projectShellResult(result));
}

function projectShellResult(output: BuiltinShellExecutionResult): BuiltinOperationExecutionValue {
  if (output.status === 'running') {
    const value = Object.freeze({
      shell_id: output.shellId,
      status: output.status,
      cursor: output.cursor,
      stdout: output.stdout,
      stderr: output.stderr,
    });
    return Object.freeze({
      schema: 'kite.builtin-operation-result.v1',
      // The start operation succeeded; this does not claim command completion.
      ok: true,
      stdout: JSON.stringify(value),
      stderr: '',
      resultMeta: Object.freeze({
        command: output.command,
        intent: output.intent,
        shell_id: output.shellId,
        shellId: output.shellId,
        status: output.status,
        shellStatus: output.status,
        cursor: output.cursor,
      }),
    }) as BuiltinOperationExecutionValue;
  }
  if (output.executionPhase === 'unknown_after_go') {
    throw new BuiltinShellExecutionUnknownError(output.stderr);
  }
  const streams = truncateProjectedStreams(output.stdout, output.stderr);
  const failureDetailCode =
    output.terminationReason === 'timed_out'
      ? 'timed_out'
      : output.terminationReason === 'cancelled'
        ? 'cancelled_by_user'
        : output.terminationReason === 'sandbox_denied'
          ? 'sandbox_denied'
          : 'tool_reported_failure';
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok: output.ok,
    stdout: streams.stdout,
    stderr: streams.stderr,
    resultMeta: Object.freeze({
      command: output.command,
      intent: output.intent,
      truncated: streams.truncated,
      ...(output.shellId ? { shell_id: output.shellId } : {}),
      ...(output.shellId ? { shellId: output.shellId, shellStatus: 'exited' as const } : {}),
      ...(output.status ? { status: output.status } : {}),
      ...(output.cursor !== undefined ? { cursor: output.cursor } : {}),
      rawResultDigest: projectionDigest(output.stdout, output.stderr, output.exitCode),
      exitCode: output.exitCode,
      ...(output.timedOut ? { timedOut: true } : {}),
      ...(output.aborted ? { aborted: true } : {}),
      ...(output.executionPhase ? { executionPhase: output.executionPhase } : {}),
      ...(output.sandboxFailure ? { sandboxFailure: output.sandboxFailure } : {}),
      ...(output.processCleanup ? { processCleanup: output.processCleanup } : {}),
    }),
    ...(!output.ok
      ? {
          classifierAdvice: Object.freeze({
            detailCode: failureDetailCode,
            disposition: 'never',
            maximumAdditionalCalls: 0,
            requiresNewModelResponse: false,
            safeAutomaticRetry: false,
          }),
        }
      : {}),
    ...(output.terminationReason ? { terminationReason: output.terminationReason } : {}),
  }) as BuiltinOperationExecutionValue;
}

function succeededReceipt(
  invocationId: string,
  context: CapabilityExecutionContext,
  value: BuiltinOperationExecutionValue,
  executorRevision = PLANNING_EXECUTOR_REVISION_,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: PLANNING_PROVIDER_ID_,
    executorRevision,
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  invocationId: string,
  context: CapabilityExecutionContext,
  code: string,
  executorRevision = PLANNING_EXECUTOR_REVISION_,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: PLANNING_PROVIDER_ID_,
    executorRevision,
    requestDigest: context.requestDigest,
    status: 'failed',
    dispatchCertainty: 'none',
    cleanupCertainty: 'not_required',
    failure: Object.freeze({
      code,
      message: 'Builtin Runtime shell operation is unavailable.',
      retryable: false,
    }),
  });
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
