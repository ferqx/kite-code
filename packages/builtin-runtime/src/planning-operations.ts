import type {
  CapabilityExecutionContextV1,
  CapabilityExecutorV1,
  ExecutionReceiptV1,
  RuntimeModuleRegistryWriterV1,
  RuntimeModuleV1,
} from '@kite/runtime-spi';
import { defineRuntimeModuleV1 } from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import {
  builtinExecutionTraitsV1,
  defineBuiltinCapabilityContractV1,
  isReadOnlyShellCommandV1,
  parserForBuiltinOperationV1,
  shellEffectsClassifierV1,
} from './catalog-contract';
import { projectionDigest, truncateProjectedStreams } from './filesystem/projection';
import type { BuiltinOperationExecutionValueV1 } from './model-operations';
import { createBuiltinPolicyCompilerV1, shellBuiltinPolicyRuleV1 } from './policy-compiler';
import { builtinToolDescriptionV1 } from './tool-contracts';
import { BUILTIN_JSON_SCHEMAS_V1, BUILTIN_ZOD_SCHEMAS_V1 } from './tool-schemas';

export const RMV1_13_PROVIDER_ID_V1 = 'kite-builtin-runtime-rmv1-13' as const;
export const RMV1_13_OPERATION_ID_V1 = 'builtin:shell_execute' as const;
export const DEFAULT_SHELL_TIMEOUT_MS_V1 = 10 * 60 * 1_000;

export const SHELL_EXECUTE_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:shell_execute'];

const SHELL_EFFECTS_V1 = Object.freeze({
  filesystem: 'unknown',
  network: 'unknown',
  externalState: 'unknown',
});

export const RMV1_13_CAPABILITY_REVISION_V1 = digestCapabilityBindingValueV1({
  schema: 'kite.rmv1-13-operation-capability.v1',
  operationId: RMV1_13_OPERATION_ID_V1,
  inputSchema: SHELL_EXECUTE_INPUT_SCHEMA_V1,
  effects: SHELL_EFFECTS_V1,
});

export const RMV1_13_EXECUTOR_REVISION_V1 = digestCapabilityBindingValueV1({
  schema: 'kite.rmv1-13-operation-executor.v1',
  operationId: RMV1_13_OPERATION_ID_V1,
  capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
});

export type BuiltinShellIntentV1 = 'inspect' | 'verify' | 'build' | 'test' | 'git' | 'other';

/** Audit metadata is derived from the canonical command shape, never model input. */
export function classifyBuiltinShellIntentV1(command: string): BuiltinShellIntentV1 {
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
  if (isReadOnlyShellCommandV1(trimmed)) return 'inspect';
  if (/\b(typecheck|lint|check)\b/iu.test(trimmed)) return 'verify';
  return 'other';
}

const BUILTIN_SHELL_INTENT_VALUES_V1 = Object.freeze([
  'inspect',
  'verify',
  'build',
  'test',
  'git',
  'other',
] as const satisfies readonly BuiltinShellIntentV1[]);

export function projectBuiltinShellIntentV1(meta: {
  readonly intent?: string;
}): BuiltinShellIntentV1 {
  return (BUILTIN_SHELL_INTENT_VALUES_V1 as readonly string[]).includes(meta.intent ?? '')
    ? (meta.intent as BuiltinShellIntentV1)
    : 'other';
}

export interface BuiltinShellExecutionResultV1 {
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly intent: BuiltinShellIntentV1;
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
export class BuiltinShellExecutionUnknownErrorV1 extends Error {
  readonly code = 'BUILTIN_SHELL_EXECUTION_UNKNOWN' as const;

  constructor(message = 'Shell execution outcome is unknown after dispatch.') {
    super(message.slice(0, 512));
    this.name = 'BuiltinShellExecutionUnknownErrorV1';
  }
}

/** Invocation-scoped Host mechanism. Workspace, authority, signal and progress are closed over. */
export interface BuiltinShellExecutionMechanismV1 {
  execute(
    input: Readonly<{ command: string; timeoutMs: number }>,
  ): Promise<BuiltinShellExecutionResultV1>;
}

export interface Rmv113ExecutionMechanismsV1 extends Readonly<Record<string, unknown>> {
  readonly shell?: BuiltinShellExecutionMechanismV1;
}

export function createPlanningRuntimeModule(): RuntimeModuleV1 {
  return defineRuntimeModuleV1({
    moduleId: 'kite-builtin-runtime-rmv1-13',
    providerId: RMV1_13_PROVIDER_ID_V1,
    revision: 'rmv1-13',
    operationIds: Object.freeze([RMV1_13_OPERATION_ID_V1]),
    register: registerRmv113OperationV1,
  });
}

function registerRmv113OperationV1(registry: RuntimeModuleRegistryWriterV1): void {
  const parser = parserForBuiltinOperationV1(
    RMV1_13_OPERATION_ID_V1,
    RMV1_13_CAPABILITY_REVISION_V1,
  );
  registry.registerCapability(
    defineBuiltinCapabilityContractV1(
      {
        capabilityId: RMV1_13_OPERATION_ID_V1,
        revision: RMV1_13_CAPABILITY_REVISION_V1,
        providerId: RMV1_13_PROVIDER_ID_V1,
        title: 'Builtin Runtime operation builtin:shell_execute',
        executionMechanism: 'shell',
        toolName: 'shell_execute',
        description: builtinToolDescriptionV1('shell_execute'),
        visibility: 'model',
        effects: SHELL_EFFECTS_V1,
        inputSchema: SHELL_EXECUTE_INPUT_SCHEMA_V1,
        inputSchemaDigest: digestCapabilityBindingValueV1(SHELL_EXECUTE_INPUT_SCHEMA_V1),
      },
      {
        parser,
        kind: 'computer',
        minimumApproval: 'user',
        governanceRevision: 'shell-effects-v1',
        effectsClassifier: shellEffectsClassifierV1(SHELL_EFFECTS_V1),
        executionTraitsDeclaration: builtinExecutionTraitsV1({
          resourceScopes: [
            { kind: 'process', key: 'shell' },
            { kind: 'workspace', key: 'workspace' },
          ],
          interactionBarrier: false,
          concurrencyGroup: 'parallel-read',
        }),
        execution: { retry: 'never' },
        policyCompiler: createBuiltinPolicyCompilerV1({
          operationId: RMV1_13_OPERATION_ID_V1,
          capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
          parserRevision: parser.parserRevision,
          declaredEffects: SHELL_EFFECTS_V1,
          minimumApproval: 'user',
          rule: shellBuiltinPolicyRuleV1,
        }),
      },
    ),
  );
  registry.registerExecutor({
    providerId: RMV1_13_PROVIDER_ID_V1,
    capabilityId: RMV1_13_OPERATION_ID_V1,
    capabilityRevision: RMV1_13_CAPABILITY_REVISION_V1,
    executorRevision: RMV1_13_EXECUTOR_REVISION_V1,
    execute: executeShellOperationV1,
  } satisfies CapabilityExecutorV1);
}

async function executeShellOperationV1(
  request: Parameters<CapabilityExecutorV1['execute']>[0],
  context: CapabilityExecutionContextV1,
): Promise<ExecutionReceiptV1> {
  const parsed = BUILTIN_ZOD_SCHEMAS_V1[RMV1_13_OPERATION_ID_V1].safeParse(request.input);
  const input = parsed.success
    ? (parsed.data as { readonly command: string; readonly timeout_ms?: number })
    : undefined;
  if (!input) {
    return failedReceipt(request.invocationId, context, 'invalid_input');
  }
  const mechanisms = context.environment.mechanisms as Rmv113ExecutionMechanismsV1 | undefined;
  const mechanism = mechanisms?.shell;
  let result: BuiltinShellExecutionResultV1;
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
        timeoutMs: optionalPositiveInteger(input.timeout_ms) ?? DEFAULT_SHELL_TIMEOUT_MS_V1,
      });
    } catch (error) {
      if (error instanceof BuiltinShellExecutionUnknownErrorV1) throw error;
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
  return succeededReceipt(request.invocationId, context, projectShellResultV1(result));
}

function projectShellResultV1(
  output: BuiltinShellExecutionResultV1,
): BuiltinOperationExecutionValueV1 {
  if (output.executionPhase === 'unknown_after_go') {
    throw new BuiltinShellExecutionUnknownErrorV1(output.stderr);
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
  }) as BuiltinOperationExecutionValueV1;
}

function succeededReceipt(
  invocationId: string,
  context: CapabilityExecutionContextV1,
  value: BuiltinOperationExecutionValueV1,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_13_PROVIDER_ID_V1,
    executorRevision: RMV1_13_EXECUTOR_REVISION_V1,
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  invocationId: string,
  context: CapabilityExecutionContextV1,
  code: string,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_13_PROVIDER_ID_V1,
    executorRevision: RMV1_13_EXECUTOR_REVISION_V1,
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
