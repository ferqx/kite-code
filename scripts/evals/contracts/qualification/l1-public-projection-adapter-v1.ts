import { z } from 'zod';
import { projectCliRuntimeEventV1 } from '../../../../src/app/cli/runtime-event-projection';
import { createInitialState } from '../../../../src/app/tui/initialState';
import { handleRuntimeEventAction } from '../../../../src/app/tui/reducers/handleEvent';
import type { RuntimeEvent } from '../../../../src/core/runtime/events';
import {
  completedTerminalOutcomeV1,
  type RunTerminalOutcomeV1,
} from '../../../../src/core/runtime/terminal-outcome';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import type { QualificationSuiteV1 } from './feature-matrix';
import {
  evaluateL1PublicProjectionCorpusV1,
  type L1PublicProjectionCaseObservationV1,
  type L1PublicProjectionReportV1,
  l1PublicProjectionObservationForCaseV1,
} from './l1-public-projection-evaluator-v1';
import {
  bindL1PublicProjectionCatalogSuiteV1,
  buildL1PublicProjectionEvaluatorIdentityV1,
  buildL1PublicProjectionSourceOwnedBindingV1,
  L1_PUBLIC_PROJECTION_ADAPTERS_V1,
  L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
  L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
  L1_PUBLIC_PROJECTION_SUITE_ID_V1,
  type L1PublicProjectionAdapterIdV1,
  type L1PublicProjectionAdapterResultV1,
  type L1PublicProjectionEvaluatorIdentityV1,
  type L1PublicProjectionSourceOwnedBindingV1,
  l1PublicProjectionSourceOwnedBindingV1Schema,
} from './l1-public-projection-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const safeIdentifierSchema = z
  .string()
  .regex(SAFE_IDENTIFIER)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'L1 public-projection identifier must not contain an endpoint, absolute path, or unsafe metadata',
  });

export {
  L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
  L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
} from './l1-public-projection-schema-v1';

const completedOutcomeV1 = (): RunTerminalOutcomeV1 => completedTerminalOutcomeV1();

/**
 * Each adapter uses a new in-memory event and discards it immediately. The
 * only return value is an outcome token: no prompt, response, message, path,
 * endpoint, workspace value, provider, child process, or credential crosses
 * the adapter boundary.
 */
function cliTerminalProjectionObservedV1(turnId: string): boolean {
  const event: Extract<RuntimeEvent, { type: 'run.completed' }> = {
    type: 'run.completed',
    turnId,
    output: '',
    outcome: completedOutcomeV1(),
  };
  const projected = projectCliRuntimeEventV1(event);
  return (
    'terminalPresentation' in projected &&
    projected.terminalPresentation.complete === true &&
    projected.terminalPresentation.safeRetry === false &&
    projected.terminalPresentation.recoveryEntry === 'none'
  );
}

function tuiInvalidArgumentsProjectionObservedV1(): boolean {
  const toolCallId = 'qualification-invalid-arguments';
  const queued = handleRuntimeEventAction(createInitialState(), {
    type: 'tool.queued',
    toolCallId,
    name: 'read_file',
    args: {},
  });
  const projected = handleRuntimeEventAction(queued, {
    type: 'tool.failed',
    toolCallId,
    error: 'invalid arguments',
  });
  const terminalBlock = projected.turns.flatMap((turn) => turn.blocks).at(-1);
  return (
    projected.sessionError === false &&
    projected.pendingToolCalls[toolCallId] === undefined &&
    terminalBlock?.kind === 'tool_summary' &&
    terminalBlock.result === 'error' &&
    terminalBlock.tools.length === 1 &&
    terminalBlock.tools[0]?.status === 'error'
  );
}

function tuiToolApprovalProjectionObservedV1(): boolean {
  const projected = handleRuntimeEventAction(createInitialState(), {
    type: 'approval.requested',
    interactionId: 'qualification-tool-approval',
    toolCallId: 'qualification-tool-approval',
    approval: {
      scope: 'once',
      callId: 'qualification-tool-approval',
      cwd: 'fixture',
      threadId: 'qualification-projection',
      tool: 'fixture_tool',
      command: 'fixture',
      risk: 'read',
      approvalHash: 'fixture',
      summary: 'fixture',
      reason: 'fixture',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    },
  });
  return (
    projected.sessionError === false &&
    projected.interrupt?.kind === 'approval' &&
    projected.interrupt.interactionId === 'qualification-tool-approval' &&
    projected.interrupt.approval?.callId === 'qualification-tool-approval'
  );
}

/**
 * Provider recovery is a TUI interaction, not a terminal-success surrogate.
 * The sealed fixture exercises the real reducer with metadata-only IDs and
 * confirms that the user is asked to start the login action. It never carries
 * a provider endpoint, credential, authorization URL, or originating args.
 */
function tuiProviderActionProjectionObservedV1(): boolean {
  const projected = handleRuntimeEventAction(createInitialState(), {
    type: 'provider.action_required',
    interactionId: 'qualification-provider-action',
    providerId: 'qualification-provider',
    action: 'login',
    originatingToolCallId: 'qualification-provider-tool',
  });
  const question = projected.turns
    .flatMap((turn) => turn.blocks)
    .find((block) => block.kind === 'question');
  return (
    projected.sessionError === false &&
    projected.interrupt?.kind === 'input' &&
    question?.kind === 'question' &&
    question.toolCallId === 'qualification-provider-tool'
  );
}

function adapterResult(
  adapterId: L1PublicProjectionAdapterIdV1,
  passed: boolean,
): L1PublicProjectionAdapterResultV1 {
  const pair = L1_PUBLIC_PROJECTION_ADAPTERS_V1.find((entry) => entry.adapterId === adapterId);
  if (!pair) throw new Error(`unregistered_l1_public_projection_adapter:${adapterId}`);
  return { ...pair, outcome: passed ? 'passed' : 'failed' };
}

/**
 * Call only the two real public projection functions with transient synthetic
 * objects. This code has no provider, filesystem, stdio, process-spawn, or
 * workspace interaction.
 */
export function runL1PublicProjectionAdaptersV1(): readonly L1PublicProjectionAdapterResultV1[] {
  return [
    adapterResult(
      'cli-invalid-arguments-projection-v1',
      cliTerminalProjectionObservedV1('qualification-cli-invalid-arguments'),
    ),
    adapterResult(
      'cli-tool-approval-projection-v1',
      cliTerminalProjectionObservedV1('qualification-cli-tool-approval'),
    ),
    adapterResult('tui-invalid-arguments-projection-v1', tuiInvalidArgumentsProjectionObservedV1()),
    adapterResult('tui-provider-action-projection-v1', tuiProviderActionProjectionObservedV1()),
    adapterResult('tui-tool-approval-projection-v1', tuiToolApprovalProjectionObservedV1()),
  ];
}

export function buildL1PublicProjectionEvaluatorV1(): L1PublicProjectionEvaluatorIdentityV1 {
  return buildL1PublicProjectionEvaluatorIdentityV1({
    oracle: { cli: 'terminal-presentation-v1', tui: 'runtime-event-rendering-v1' },
    verifier: { inventory: 'closed-case-inventory-v1', output: 'status-only-v1' },
    runner: {
      runner: L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
      fixtureId: L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
      invocation: 'direct-in-memory-v1',
    },
    scheduler: { mode: 'synchronous-projection-calls-v1' },
  });
}

/** Rebuild the whole closed projection corpus from fresh direct function calls. */
export function runL1PublicProjectionContractCorpusV1(
  input: { evaluator?: L1PublicProjectionEvaluatorIdentityV1 } = {},
): L1PublicProjectionReportV1 {
  const results = runL1PublicProjectionAdaptersV1();
  const passed = new Map(results.map((result) => [result.adapterId, result.outcome === 'passed']));
  const observations: L1PublicProjectionCaseObservationV1[] = [
    l1PublicProjectionObservationForCaseV1(
      'l1-cli-invalid-arguments-projection-v1',
      passed.get('cli-invalid-arguments-projection-v1') === true,
    ),
    l1PublicProjectionObservationForCaseV1(
      'l1-cli-tool-approval-projection-v1',
      passed.get('cli-tool-approval-projection-v1') === true,
    ),
    l1PublicProjectionObservationForCaseV1(
      'l1-tui-invalid-arguments-projection-v1',
      passed.get('tui-invalid-arguments-projection-v1') === true,
    ),
    l1PublicProjectionObservationForCaseV1(
      'l1-tui-provider-action-projection-v1',
      passed.get('tui-provider-action-projection-v1') === true,
    ),
    l1PublicProjectionObservationForCaseV1(
      'l1-tui-tool-approval-projection-v1',
      passed.get('tui-tool-approval-projection-v1') === true,
    ),
  ];
  return evaluateL1PublicProjectionCorpusV1({
    evaluator: input.evaluator ?? buildL1PublicProjectionEvaluatorV1(),
    observations,
  });
}

export type L1PublicProjectionReceiptOutcomeV1 = 'passed' | 'failed' | 'blocked';

const l1PublicProjectionReceiptMaterialV1Schema = z
  .object({
    schema: z.literal('L1PublicProjectionReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: safeIdentifierSchema,
    sourceSurfaceId: safeIdentifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    adapterId: z.enum([
      'cli-invalid-arguments-projection-v1',
      'cli-tool-approval-projection-v1',
      'tui-invalid-arguments-projection-v1',
      'tui-provider-action-projection-v1',
      'tui-tool-approval-projection-v1',
    ]),
    assertionId: safeIdentifierSchema,
    sourceBindingDigest: digestSchema,
    matrixDigest: digestSchema,
    suiteId: safeIdentifierSchema,
    suiteDigest: digestSchema,
    evaluatorDigest: digestSchema,
    evaluatorReportDigest: digestSchema,
    outcome: z.enum(['passed', 'failed', 'blocked']),
    reasonCode: z.enum(['adapter_assertion_failed', 'evaluator_blocked', 'passed']),
  })
  .strict()
  .superRefine((value, context) => {
    const implementation = L1_PUBLIC_PROJECTION_ADAPTERS_V1.find(
      (entry) => entry.adapterId === value.adapterId,
    );
    if (!implementation || implementation.assertionId !== value.assertionId) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message: 'L1 public-projection receipt adapter/assertion pair must be registered',
      });
      return;
    }
    const expectedBindingDigest = buildL1PublicProjectionSourceOwnedBindingV1({
      sourceSurfaceId: value.sourceSurfaceId,
      declaration: implementation,
    }).bindingDigest;
    if (value.sourceBindingDigest !== expectedBindingDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBindingDigest'],
        message:
          'L1 public-projection receipt source binding digest must match its source and pair',
      });
    }
    const expectedReceiptId = `l1-projection-receipt:${value.sourceSurfaceId}:${value.assertionId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'L1 public-projection receipt ID must be derived from source and assertion',
      });
    }
    const expectedReason =
      value.outcome === 'passed'
        ? 'passed'
        : value.outcome === 'failed'
          ? 'adapter_assertion_failed'
          : 'evaluator_blocked';
    if (value.reasonCode !== expectedReason) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'L1 public-projection receipt reason must be derived from outcome',
      });
    }
  });
export type L1PublicProjectionReceiptMaterialV1 = z.infer<
  typeof l1PublicProjectionReceiptMaterialV1Schema
>;

export function computeL1PublicProjectionReceiptDigestV1(
  material: L1PublicProjectionReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l1.public-projection.receipt.v1',
    canonicalJsonBytes(l1PublicProjectionReceiptMaterialV1Schema.parse(material)),
  );
}

export const l1PublicProjectionReceiptV1Schema = l1PublicProjectionReceiptMaterialV1Schema
  .extend({ receiptDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { receiptDigest, ...material } = value;
    const parsed = l1PublicProjectionReceiptMaterialV1Schema.safeParse(material);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return;
    }
    const expected = computeL1PublicProjectionReceiptDigestV1(parsed.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: `L1 public-projection receipt digest mismatch: expected ${expected}`,
      });
    }
  });
export type L1PublicProjectionReceiptV1 = z.infer<typeof l1PublicProjectionReceiptV1Schema>;

/**
 * The caller must obtain `catalogSuite` from the source-owned Matrix. This
 * adapter only seals the exact local observation against that identity.
 */
export function buildL1PublicProjectionReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  binding: L1PublicProjectionSourceOwnedBindingV1;
  matrixDigest: string;
  matrixSuite: QualificationSuiteV1;
  evaluatorReport: L1PublicProjectionReportV1;
  adapterResult: L1PublicProjectionAdapterResultV1;
}): L1PublicProjectionReceiptV1 {
  const binding = l1PublicProjectionSourceOwnedBindingV1Schema.parse(input.binding);
  if (
    input.adapterResult.adapterId !== binding.adapterId ||
    input.adapterResult.assertionId !== binding.assertionId
  ) {
    throw new Error('l1_public_projection_receipt_adapter_binding_mismatch');
  }
  const catalogSuite = bindL1PublicProjectionCatalogSuiteV1(input.matrixSuite);
  if (catalogSuite.suiteId !== L1_PUBLIC_PROJECTION_SUITE_ID_V1) {
    throw new Error('l1_public_projection_receipt_catalog_suite_mismatch');
  }
  const outcome: L1PublicProjectionReceiptOutcomeV1 =
    input.evaluatorReport.status !== 'accepted'
      ? 'blocked'
      : input.adapterResult.outcome === 'passed'
        ? 'passed'
        : 'failed';
  const material = l1PublicProjectionReceiptMaterialV1Schema.parse({
    schema: 'L1PublicProjectionReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l1-projection-receipt:${input.sourceSurfaceId}:${binding.assertionId}`,
    sourceSurfaceId: input.sourceSurfaceId,
    featureId: input.featureId,
    adapterId: binding.adapterId,
    assertionId: binding.assertionId,
    sourceBindingDigest: binding.bindingDigest,
    matrixDigest: input.matrixDigest,
    suiteId: catalogSuite.suiteId,
    suiteDigest: catalogSuite.suiteDigest,
    evaluatorDigest: input.evaluatorReport.evaluator.evaluatorDigest,
    evaluatorReportDigest: input.evaluatorReport.reportDigest,
    outcome,
    reasonCode:
      outcome === 'passed'
        ? 'passed'
        : outcome === 'failed'
          ? 'adapter_assertion_failed'
          : 'evaluator_blocked',
  });
  return l1PublicProjectionReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL1PublicProjectionReceiptDigestV1(material),
  });
}
