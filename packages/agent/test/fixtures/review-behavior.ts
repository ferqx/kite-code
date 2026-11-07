import { createHash } from 'node:crypto';
import type { AuthorizationCheckAnswer } from '../../src/authorization-check-output';
import type { AuthorizationRequest, JobDefinition, ToolDefinition } from '../../src/extensions';
import { canonicalJson } from '../../src/json';
import {
  type ShellRiskPreparation,
  shellRiskAnswer,
  shellRiskDecision,
  shellRiskInstructions,
} from '../../src/shell-risk-review';
import type {
  EnsureAuthorizationCheckInput,
  ResolveAutoAuthorizationInput,
  Store,
} from '../../src/storage/port';
import type { Json } from '../../src/storage/types';
import type { ToolBehaviorBinding, TrustedToolBehavior } from '../../src/tool-behavior';

export function fixtureRiskBehavior(
  definition: ToolDefinition | JobDefinition,
  kind: 'tool' | 'job',
  prepare: (request: AuthorizationRequest) => Promise<ShellRiskPreparation | null>,
): TrustedToolBehavior {
  return {
    definition,
    capability: { kind, definitionId: definition.id, definitionVersion: definition.version },
    contractRef: 'fixture.shell-risk',
    configurationDigest: 'f'.repeat(64),
    autoReview: 'check',
    async prepareReview(request) {
      const prepared = await prepare(request);
      return prepared
        ? {
            ...prepared,
            instructions: shellRiskInstructions,
            material: {
              purpose: 'shell_risk',
              operation: {
                kind: request.kind,
                definitionId: request.definitionId,
                definitionVersion: request.definitionVersion,
                input: request.input,
              },
              material: prepared.material,
            },
          }
        : null;
    },
    interpretReview(content) {
      try {
        const risk = shellRiskAnswer(JSON.parse(content));
        return risk ? { answer: shellRiskDecision(risk), evidence: { risk: risk.risk } } : null;
      } catch {
        return null;
      }
    },
  };
}

export function fixtureCheckBinding(
  capability: ToolBehaviorBinding['capability'],
  checker: { id: string; version: string; modelId: string },
): ToolBehaviorBinding {
  return {
    capability,
    contractRef: 'kite.authorization-check',
    configurationDigest: createHash('sha256').update(canonicalJson(checker)).digest('hex'),
  };
}

export function fixtureReviewBinding(
  behaviors: readonly TrustedToolBehavior[],
  request: AuthorizationRequest,
): ToolBehaviorBinding | undefined {
  const selected = behaviors.find(
    ({ capability }) =>
      capability.kind === request.kind &&
      capability.definitionId === request.definitionId &&
      capability.definitionVersion === request.definitionVersion,
  );
  return selected
    ? {
        capability: selected.capability,
        contractRef: selected.contractRef,
        configurationDigest: selected.configurationDigest,
      }
    : undefined;
}

/** Generic-checker SQL fixtures explicitly seal the real target and checker binding. */
export async function ensureFixtureAuthorizationCheck(
  store: Store,
  input: Omit<EnsureAuthorizationCheckInput, 'behavior'> & { behavior?: ToolBehaviorBinding },
) {
  const target = await store.getExecution(input.targetExecutionId);
  if (!target) throw new Error('fixture_target_missing');
  return store.ensureAuthorizationCheck({
    ...input,
    behavior:
      input.behavior ??
      fixtureCheckBinding(
        {
          kind: target.kind,
          definitionId: target.definitionId,
          definitionVersion: target.definitionVersion,
        },
        input.checker,
      ),
  });
}

export async function resolveFixtureAutoAuthorization(
  store: Store,
  input: Omit<ResolveAutoAuthorizationInput, 'behavior'> & { behavior?: ToolBehaviorBinding },
) {
  const target = (await store.getExecution(input.targetExecutionId))!;
  const parent = target.parentExecutionId
    ? await store.getExecution(target.parentExecutionId)
    : null;
  const childInput = target.input as Record<string, Json>;
  const parentInput = parent?.input as Record<string, Json> | undefined;
  const parentProof = Object.hasOwn(input, 'parentProof')
    ? input.parentProof
    : parent?.kind === 'tool' &&
        target.kind === 'job' &&
        target.definitionId === 'shell.command' &&
        target.definitionVersion === '1' &&
        ['shell.execute', 'shell.launch'].includes(parent.definitionId) &&
        parent.definitionVersion === '1' &&
        childInput.command === parentInput?.command
      ? {
          parentExecutionId: parent.id,
          parentInputDigest: createHash('sha256').update(canonicalJson(parent.input)).digest('hex'),
          operationDigest: createHash('sha256')
            .update(canonicalJson({ command: childInput.command! }))
            .digest('hex'),
          parentBindings: [
            {
              kind: parent.kind,
              definitionId: parent.definitionId,
              definitionVersion: parent.definitionVersion,
            },
          ],
          cancelWithParent: target.cancelWithParent,
        }
      : undefined;
  return store.resolveAutoAuthorization({
    ...input,
    ...(parentProof === undefined ? {} : { parentProof }),
    behavior:
      input.behavior ??
      fixtureCheckBinding(
        {
          kind: target.kind,
          definitionId: target.definitionId,
          definitionVersion: target.definitionVersion,
        },
        input.checker,
      ),
  });
}

/** A controlled complete Model result on the same private owner path used by Runtime. */
export async function fixtureCheckResult(
  store: Store,
  executionId: string,
  result: Record<string, Json>,
  answer: AuthorizationCheckAnswer,
  evidence?: Json,
): Promise<Json> {
  const check = (await store.getExecution(executionId))!;
  const command = (await store.getCommand(check.originCommandId))!;
  const payload = (command.request as { input: Record<string, Json> }).input;
  const target = (await store.getExecution(
    (payload.target as { executionId: string }).executionId,
  ))!;
  const digest = (value: unknown) =>
    createHash('sha256')
      .update(canonicalJson(value as Json))
      .digest('hex');
  const { authorizationCheckBindingDigest: _binding, ...sealedInput } = check.input as Record<
    string,
    Json
  >;
  const output = {
    content: result.content!,
    reasoning: result.reasoning ?? '',
    ...(result.firstOutput ? { firstOutput: result.firstOutput } : {}),
    toolCalls: [],
    usage: result.usage ?? {},
    finishReason: 'stop',
  };
  return {
    ...result,
    authorizationCheckOutput: {
      kind: 'authorization_check_output',
      version: 1,
      modelExecutionId: executionId,
      behavior: payload.behavior!,
      target: {
        executionId: target.id,
        attempt: target.attempt,
        inputDigest: digest(target.input),
      },
      checkInputDigest: digest(payload),
      sealedInputHash: digest(sealedInput),
      modelOutputDigest: digest(output),
      contentHash: createHash('sha256').update(String(result.content)).digest('hex'),
      ...((payload.review as { fingerprint?: string } | undefined)?.fingerprint
        ? { materialFingerprint: (payload.review as { fingerprint: string }).fingerprint }
        : {}),
      answer,
      ...(evidence === undefined ? {} : { evidence }),
    },
  };
}
