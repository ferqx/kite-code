import type { AuthorizationRequest, Extension, Json, ToolDefinition } from '../extensions';
import { type GrantCandidate, grantDigest, grantScopeDigest } from '../permission-grants';
import { parseShellCommandInput } from '../shell-input';
import {
  type ShellRiskPreparation,
  shellRiskAnswer,
  shellRiskDecision,
  shellRiskInstructions,
  shellRiskReviewContractDigest,
} from '../shell-risk-review';
import type { ToolBehaviorContext, TrustedToolBehavior } from '../tool-behavior';
import { createWorktreeToolBehavior } from './git-worktree/approval';
import type { GitWorktreeConfiguration } from './git-worktree/protocol';

/** Created alongside the actual Shell definitions, not selected from caller-controlled names. */
export function createShellToolBehaviors(options: {
  readonly extensions: readonly Extension[];
  readonly snapshot: unknown;
  readonly enableReview?: boolean;
  readonly commandDigest: (request: AuthorizationRequest) => string | undefined;
  readonly prepareRiskReview: (
    request: AuthorizationRequest,
  ) => Promise<ShellRiskPreparation | null>;
}): TrustedToolBehavior[] {
  const enableReview = options.enableReview !== false;
  const configurationDigest = grantDigest({
    snapshot: options.snapshot as Json,
    reviewContract: enableReview ? shellRiskReviewContractDigest : null,
  });
  const result: TrustedToolBehavior[] = [];
  const parentBindings = options.extensions.flatMap((extension) =>
    (extension.tools ?? [])
      .filter((tool) => tool.version === '1' && ['shell.execute', 'shell.launch'].includes(tool.id))
      .map((tool) => ({
        kind: 'tool' as const,
        definitionId: tool.id,
        definitionVersion: tool.version,
      })),
  );
  const scoped = !!(options.snapshot as { host?: unknown }).host;
  async function prepareParentProof(
    request: AuthorizationRequest,
    context?: ToolBehaviorContext,
  ): Promise<Json | null> {
    const parent = context?.parent;
    const parentBinding =
      parent &&
      parentBindings.find(
        (binding) =>
          binding.kind === parent.kind &&
          binding.definitionId === parent.definitionId &&
          binding.definitionVersion === parent.definitionVersion,
      );
    const parsed =
      request.kind === 'job' ? parseShellCommandInput(request.input, 'job', scoped) : undefined;
    const parentParsed =
      parentBinding &&
      parent &&
      parseShellCommandInput(
        parent.input,
        parent.definitionId === 'shell.launch' ? 'launch' : 'execute',
        scoped,
      );
    if (
      !parsed ||
      !parentParsed ||
      !parent ||
      parsed.command !== parentParsed.command ||
      parsed.workdir !== parentParsed.workdir ||
      parsed.executionScope.filesystem !== parentParsed.executionScope.filesystem ||
      parsed.executionScope.network !== parentParsed.executionScope.network
    )
      return null;
    return {
      operationDigest: grantDigest({
        configurationDigest,
        command: parsed.command,
        workdir: parsed.workdir ?? null,
        executionScope: scoped ? parsed.executionScope : null,
      }),
      parentBindings,
      parentExecutionId: parent.executionId,
      parentInputDigest: parent.inputDigest,
      cancelWithParent: parentParsed.cancellation !== 'detached',
    } as unknown as Json;
  }
  for (const extension of options.extensions) {
    for (const [kind, definitions] of [
      ['tool', extension.tools ?? []],
      ['job', extension.jobs ?? []],
    ] as const) {
      for (const definition of definitions) {
        const capability = {
          kind,
          definitionId: definition.id,
          definitionVersion: definition.version,
        };
        if (definition.version !== '1') continue;
        if (
          (kind === 'tool' && ['shell.execute', 'shell.launch'].includes(definition.id)) ||
          (kind === 'job' && definition.id === 'shell.command')
        ) {
          result.push({
            definition,
            capability,
            contractRef: 'builtin.shell.risk-and-command',
            configurationDigest,
            prepareParentProof,
            ...(enableReview
              ? {
                  autoReview: 'check' as const,
                  grantSatisfiesDefaultCheck: true as const,
                  async prepareReview(request) {
                    const prepared = await options.prepareRiskReview(request);
                    if (!prepared) return null;
                    const input =
                      request.input &&
                      typeof request.input === 'object' &&
                      !Array.isArray(request.input)
                        ? (Object.fromEntries(
                            Object.entries(request.input).filter(
                              ([name]) => name !== 'description',
                            ),
                          ) as Json)
                        : request.input;
                    return {
                      ...prepared,
                      material: {
                        purpose: 'shell_risk',
                        operation: {
                          kind: request.kind,
                          definitionId: request.definitionId,
                          definitionVersion: request.definitionVersion,
                          input,
                        },
                        material: prepared.material,
                      },
                      instructions: shellRiskInstructions,
                      evidence: prepared as unknown as Json,
                    };
                  },
                  interpretReview(content) {
                    try {
                      const risk = shellRiskAnswer(JSON.parse(content));
                      return risk
                        ? {
                            answer: shellRiskDecision(risk),
                            evidence: {
                              risk: risk.risk,
                              contractDigest: shellRiskReviewContractDigest,
                            },
                          }
                        : null;
                    } catch {
                      return null;
                    }
                  },
                }
              : {}),
            async grantOffers(request): Promise<GrantCandidate[]> {
              const commandDigest = options.commandDigest(request);
              if (!commandDigest) return [];
              const input =
                request.input && typeof request.input === 'object' && !Array.isArray(request.input)
                  ? request.input
                  : {};
              const candidate = {
                ruleId: 'builtin.shell.command',
                contractId: 'builtin.shell.exact-command',
                scope: { commandDigest },
                bindings: [capability],
                presentation: {
                  label: '本会话内相同命令',
                  details: [
                    `Session: ${request.sessionId}`,
                    `Command: ${typeof input.command === 'string' ? input.command : '(exact frozen invocation)'}`,
                    `Tool: ${definition.id}@${definition.version}`,
                    'Only the exact command, execution directory, environment, runner/assets, timeout and filesystem/network scope. Current hard limits remain.',
                  ],
                },
              };
              return [{ ...candidate, scopeDigest: grantScopeDigest(candidate) }];
            },
          });
        } else if (kind === 'tool' && definition.id === 'git.worktree') {
          const snapshot = options.snapshot as {
            assets?: { gitWorktree?: { configuration?: GitWorktreeConfiguration } };
          };
          const configuration = snapshot.assets?.gitWorktree?.configuration;
          if (configuration)
            result.push(
              createWorktreeToolBehavior({
                definition: definition as ToolDefinition,
                configuration,
                configurationDigest,
              }),
            );
        } else if (
          kind === 'tool' &&
          ['shell.read', 'shell.wait', 'shell.stop'].includes(definition.id)
        ) {
          result.push({
            definition,
            capability,
            contractRef: 'builtin.shell.observe',
            configurationDigest,
            autoReview: 'none',
          });
        }
      }
    }
  }
  return result;
}
