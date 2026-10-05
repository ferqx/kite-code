import type {
  CompletionGovernance,
  Json,
  MutationGovernance,
  NecessaryConditionContext,
  ToolDefinition,
} from '../../extensions';
import { AgentError, type RequirementEvaluation, type RequirementRef } from '../../storage/types';
import type { PlanningInitialization } from './index';

export interface AutomaticValidationOptions {
  /** Host-qualified complete-baseline mutations, not model-selected effects or validators. */
  mutations: readonly {
    definitionId: string;
    definitionVersion: string;
    effects: readonly ('workspace_write' | 'destructive' | 'unknown')[];
  }[];
  fileHashChecker: { definitionId: string; definitionVersion: string };
}
const requirementId = 'mutation.required',
  checkId = 'validation.auto_check';
function object(value: unknown): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('automatic_validation_invalid');
  return value as Record<string, Json>;
}
export function createAutomaticValidation(extensionId: string, input: AutomaticValidationOptions) {
  const options = structuredClone(input);
  if (
    !options.mutations.length ||
    options.mutations.length > 64 ||
    !options.fileHashChecker.definitionId ||
    !options.fileHashChecker.definitionVersion ||
    new Set(options.mutations.map((value) => value.definitionId)).size !==
      options.mutations.length ||
    options.mutations.some(
      (value) =>
        !value.definitionId ||
        !value.definitionVersion ||
        !value.effects.length ||
        value.effects.some(
          (effect) => !['workspace_write', 'destructive', 'unknown'].includes(effect),
        ),
    )
  )
    throw new Error('automatic_validation_policy_invalid');
  const governance: MutationGovernance = {
    requirementId,
    definitions: options.mutations.map((value) => ({
      id: value.definitionId,
      version: value.definitionVersion,
      effects: value.effects,
    })),
    async describe({ input }) {
      const value = object(input);
      if (typeof value.path !== 'string' || !value.path || value.path.length > 4096)
        throw new Error('automatic_validation_descriptor_invalid');
      return { kind: 'file_hash', path: value.path };
    },
  };
  async function initialize(input: PlanningInitialization): Promise<RequirementRef> {
    const context = await input.forExtension(extensionId),
      key = `run/${input.run.id}/${requirementId}`;
    const record = await context.records.create({
      key,
      contentType: 'agent.mutation-policy',
      contentVersion: 1,
      value: {
        kind: 'mutation_policy',
        runId: input.run.id,
        requirementId,
        definitions: governance.definitions as unknown as Json,
        checkDefinitionId: checkId,
        checkDefinitionVersion: '1',
        checkTools: [
          {
            id: options.fileHashChecker.definitionId,
            version: options.fileHashChecker.definitionVersion,
          },
        ],
        fileHashChecker: options.fileHashChecker as unknown as Json,
      },
    });
    return {
      extensionId,
      definitionVersion: '1',
      requirementId,
      recordKey: key,
      revision: record.revision,
      sessionId: input.run.sessionId,
      runId: input.run.id,
      phase: 'completion',
      evaluationProvider: 'extension',
    };
  }
  async function evaluate(
    ref: RequirementRef,
    phase: 'dispatch' | 'completion',
    context?: NecessaryConditionContext,
  ): Promise<RequirementEvaluation> {
    if (context && (context.boundary.runId !== ref.runId || context.boundary.executionId !== null))
      return {
        requirement: ref,
        recordRevision: ref.revision,
        outcome: 'satisfied',
        evidence: { reason: 'nonapplicable_run_boundary' },
      };
    if (phase === 'dispatch')
      return {
        requirement: ref,
        recordRevision: ref.revision,
        outcome: 'satisfied',
        evidence: { reason: 'completion_only' },
      };
    if (!context)
      return {
        requirement: ref,
        recordRevision: ref.revision,
        outcome: 'unsatisfied',
        evidence: { reason: 'condition_context_unavailable' },
      };
    const read = await context.forRequirement(ref),
      policy = await read.records.get(ref.recordKey),
      head = await read.records.get(`run/${ref.runId}/mutation.current`);
    let satisfied = false;
    if (
      policy &&
      policy.originStoreId === ref.originStoreId &&
      policy.revision === ref.revision &&
      policy.contentType === 'agent.mutation-policy' &&
      policy.contentVersion === 1
    ) {
      if (!head) satisfied = true;
      else if (
        head.originStoreId === ref.originStoreId &&
        head.contentType === 'agent.mutation-policy' &&
        head.contentVersion === 1
      ) {
        const value = object(head.value);
        const checker =
          typeof value.lastCheckerExecutionId === 'string'
            ? await read.getExecution(value.lastCheckerExecutionId)
            : null;
        satisfied =
          value.checkedThrough === value.lastSeq &&
          value.lastOutcome === 'passed' &&
          checker?.status === 'succeeded' &&
          checker.runId === ref.runId &&
          checker.originStoreId === ref.originStoreId &&
          checker.definitionId === checkId &&
          checker.definitionVersion === '1';
      }
    }
    return {
      requirement: ref,
      recordRevision: policy?.revision ?? ref.revision,
      outcome: satisfied ? 'satisfied' : 'unsatisfied',
      evidence: {
        reason: satisfied ? 'mutation_verified' : 'mutation_verification_required',
        headRevision: head?.revision ?? null,
      },
    };
  }
  const completion: CompletionGovernance = {
    async prepare({ runId, requirements, evaluations, context }) {
      const ref = requirements.find(
        (value) =>
          value.extensionId === extensionId &&
          value.requirementId === requirementId &&
          value.runId === runId,
      );
      if (
        !ref ||
        !evaluations.some(
          (value) =>
            value.requirement.requirementId === requirementId &&
            value.requirement.extensionId === extensionId &&
            value.outcome === 'unsatisfied',
        )
      )
        return null;
      const read = await context.forRequirement(ref),
        head = await read.records.get(`run/${runId}/mutation.current`);
      if (!head || !read.readMutationFacts) return null;
      const value = object(head.value);
      if (value.lastOutcome === 'failed' || value.lastOutcome === 'inconclusive')
        return {
          kind: 'continue',
          key: `repair:${head.revision}`,
          content:
            'An exact automatic check did not pass. Repair through normal tools without changing the original expectation, then reverify; missing or unknown effects cannot be declared successful.',
        };
      const page = await read.readMutationFacts({
          afterSeq: String(value.checkedThrough),
          limit: 1,
        }),
        fact = page.facts[0];
      if (
        !fact ||
        !['succeeded', 'failed', 'cancelled'].includes(fact.status) ||
        page.headRevision !== head.revision
      )
        return null;
      return {
        kind: 'tool',
        key: `check:${head.revision}:${fact.seq}`,
        definitionId: checkId,
        definitionVersion: '1',
        input: {
          runId,
          mutationExecutionId: fact.executionId,
          headRevision: head.revision,
          seq: fact.seq,
        },
      };
    },
  };
  const tool: ToolDefinition = {
    id: checkId,
    version: '1',
    description:
      'Verify an exact registered mutation using the host-sealed complete-baseline checker. No mutation permission or waiver is granted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'mutationExecutionId', 'headRevision', 'seq'],
      properties: Object.fromEntries(
        ['runId', 'mutationExecutionId', 'headRevision', 'seq'].map((key) => [
          key,
          { type: 'string', minLength: 1 },
        ]),
      ),
    },
    async execute(input, context) {
      const value = object(input);
      if (
        value.runId !== context.runId ||
        !context.mutationFacts ||
        typeof value.seq !== 'string' ||
        !/^[1-9][0-9]*$/.test(value.seq)
      )
        return { outcome: 'failed', content: 'automatic_validation_scope_mismatch' };
      const page = await context.mutationFacts.list(requirementId, {
          afterSeq: String(BigInt(value.seq) - 1n),
          limit: 1,
        }),
        fact = page.facts[0];
      if (
        !fact ||
        fact.executionId !== value.mutationExecutionId ||
        page.headRevision !== value.headRevision
      )
        return { outcome: 'failed', content: 'mutation_head_changed' };
      let outcome: 'passed' | 'failed' | 'inconclusive' | 'superseded' = 'inconclusive';
      let evidence: Json = { mutationExecutionId: fact.executionId, status: fact.status };
      if (fact.status === 'succeeded' && fact.supersededBy) {
        outcome = 'superseded';
        evidence = {
          mutationExecutionId: fact.executionId,
          reason: 'superseded_by_known_mutation',
          supersededBy: fact.supersededBy,
        };
      } else if (fact.status === 'failed' || fact.status === 'cancelled') {
        const result = object(fact.result);
        // These host-qualified atomic file adapters report publish ambiguity as outcome_unknown.
        if (result.outcome === fact.status) outcome = 'passed';
        evidence = { ...object(evidence), reason: 'known_atomic_mutation_not_succeeded' };
      } else if (fact.status === 'succeeded') {
        let expected: string | undefined;
        try {
          const result = object(fact.result),
            body = object(JSON.parse(String(result.content)));
          expected = String(object(body.baseline).hash);
          if (!/^[a-f0-9]{64}$/.test(expected)) expected = undefined;
        } catch {
          /* Missing complete baseline cannot pass. */
        }
        if (expected) {
          const descriptor = object(fact.descriptor);
          let ref: Awaited<ReturnType<typeof context.operations.ensure>> | undefined;
          try {
            ref = await context.operations.ensure({
              key: `auto-check/${context.executionId}`,
              request: {
                kind: 'tool',
                definitionId: options.fileHashChecker.definitionId,
                definitionVersion: options.fileHashChecker.definitionVersion,
                input: { path: descriptor.path!, offset: 1, limit: 1 },
              },
            });
          } catch (error) {
            if (
              !(error instanceof AgentError) ||
              ![
                'definition_unavailable',
                'operation_definition_unavailable',
                'permission_denied',
              ].includes(error.code)
            )
              throw error;
            evidence = {
              mutationExecutionId: fact.executionId,
              reason: 'checker_preflight_unavailable',
              code: error.code,
            };
          }
          const checked = ref
            ? await context.operations.wait(ref, { signal: context.signal })
            : undefined;
          if (checked?.status === 'outcome_unknown')
            return { outcome: 'outcome_unknown', content: 'automatic_checker_outcome_unknown' };
          if (checked?.status === 'succeeded') {
            try {
              const body = object(JSON.parse(String(object(checked.result).content))),
                hash = String(object(body.baseline).hash);
              if (/^[a-f0-9]{64}$/.test(hash)) {
                outcome = hash === expected ? 'passed' : 'failed';
                evidence = {
                  mutationExecutionId: fact.executionId,
                  checkerExecutionId: checked.id,
                  expectedHash: expected,
                  observedHash: hash,
                };
              }
            } catch {
              /* Malformed baseline is inconclusive. */
            }
          }
        }
      }
      try {
        await context.mutationFacts.commit({
          requirementId,
          mutationExecutionId: fact.executionId,
          headRevision: String(value.headRevision),
          outcome,
          evidence,
        });
      } catch (error) {
        return {
          outcome: 'failed',
          content: error instanceof Error ? error.message : 'mutation_head_changed',
        };
      }
      return {
        outcome: 'succeeded',
        content: JSON.stringify({
          kind: 'automatic_verification',
          outcome,
          evidence,
          repair: ['passed', 'superseded'].includes(outcome)
            ? null
            : 'Repair through normally authorized tools; the original expected baseline is unchanged.',
        }),
        details: { outcome, evidence },
      };
    },
  };
  return { governance, completion, tool, initialize, evaluate };
}
