import type { RequirementEvaluation, RequirementRef } from '../storage/types';
import type { ConditionReadContext, Json, NecessaryConditionContext } from './index';

/** Trusted Run policy; public Tool arguments cannot install this boundary. */
export interface MutationGovernance {
  readonly requirementId: string;
  readonly definitions: readonly { id: string; version: string; effects: readonly string[] }[];
  describe(input: { definitionId: string; definitionVersion: string; input: Json }): Promise<Json>;
}
export type CompletionDirective =
  | { kind: 'tool'; key: string; definitionId: string; definitionVersion: string; input: Json }
  | { kind: 'continue'; key: string; content: string };
export interface CompletionGovernance {
  prepare(input: {
    runId: string;
    requirements: readonly RequirementRef[];
    evaluations: readonly RequirementEvaluation[];
    context: NecessaryConditionContext;
  }): Promise<CompletionDirective | null>;
}
export type GovernanceReadContext = ConditionReadContext;
