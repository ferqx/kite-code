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
} from '../catalog-contract';
import { projectionDigest, truncateProjectedStreams } from '../filesystem/projection';
import type { BuiltinOperationExecutionValue } from '../model/runtime-module';
import { createBuiltinPolicyCompiler, shellBuiltinPolicyRule } from '../policy-compiler';
import { SHELL_SEMANTICS_REVISION_ } from '../shell-semantics';
import { builtinToolDescription } from '../tool-contracts';
import { BUILTIN_JSON_SCHEMAS_, BUILTIN_ZOD_SCHEMAS_ } from '../tool-schemas';

export const PLANNING_PROVIDER_ID_ = 'kite-builtin-runtime-planning' as const;
export const PLANNING_OPERATION_ID_ = 'builtin:shell_execute' as const;
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

export interface BuiltinShellExecutionResult {
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
}

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
    input: Readonly<{ command: string; timeoutMs: number }>,
  ): Promise<BuiltinShellExecutionResult>;
}

export interface PlanningExecutionMechanisms extends Readonly<Record<string, unknown>> {
  readonly shell?: BuiltinShellExecutionMechanism;
}

export function createPlanningRuntimeModule(): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-builtin-runtime-planning',
    providerId: PLANNING_PROVIDER_ID_,
    revision: 'planning-current',
    operationIds: Object.freeze([PLANNING_OPERATION_ID_]),
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
}

async function executeShellOperation(
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: CapabilityExecutionContext,
): Promise<ExecutionReceipt> {
  const parsed = BUILTIN_ZOD_SCHEMAS_[PLANNING_OPERATION_ID_].safeParse(request.input);
  const input = parsed.success
    ? (parsed.data as { readonly command: string; readonly timeout_ms?: number })
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
        timeoutMs: optionalPositiveInteger(input.timeout_ms) ?? DEFAULT_SHELL_TIMEOUT_MS_,
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
  if (output.executionPhase === 'unknown_after_go') {
    throw new BuiltinShellExecutionUnknownError(output.stderr);
  }
  const streams = truncateProjectedStreams(output.stdout, output.stderr);
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok: output.ok,
    stdout: streams.stdout,
    stderr: streams.stderr,
    resultMeta: Object.freeze({
      command: output.command,
      intent: output.intent,
      truncated: streams.truncated,
      rawResultDigest: projectionDigest(output.stdout, output.stderr, output.exitCode),
      exitCode: output.exitCode,
      ...(output.timedOut ? { timedOut: true } : {}),
      ...(output.aborted ? { aborted: true } : {}),
      ...(output.executionPhase ? { executionPhase: output.executionPhase } : {}),
      ...(output.sandboxFailure ? { sandboxFailure: output.sandboxFailure } : {}),
      ...(output.processCleanup ? { processCleanup: output.processCleanup } : {}),
    }),
    ...(output.terminationReason ? { terminationReason: output.terminationReason } : {}),
  }) as BuiltinOperationExecutionValue;
}

function succeededReceipt(
  invocationId: string,
  context: CapabilityExecutionContext,
  value: BuiltinOperationExecutionValue,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: PLANNING_PROVIDER_ID_,
    executorRevision: PLANNING_EXECUTOR_REVISION_,
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
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: PLANNING_PROVIDER_ID_,
    executorRevision: PLANNING_EXECUTOR_REVISION_,
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
