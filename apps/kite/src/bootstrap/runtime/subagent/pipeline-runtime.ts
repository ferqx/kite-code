import type {
  BuiltinChildRuntimeDriverV1,
  GovernedSubagentCompositionV1 as BuiltinGovernedSubagentCompositionV1,
  SubagentLifecycleArtifactAccessV1,
  SubagentTaskArtifactAccessV1,
} from '@kite/builtin-runtime';
import {
  executePipelineIssuedSubagentResumeV1,
  executePipelineIssuedSubagentStartV1,
  type SubagentInvocationRuntimeV1,
} from './task-tool';

/** App factory consumed only after Host has acknowledged the outer attempt. */
export type AppSubagentRuntimeFactoryV1 = () => SubagentInvocationRuntimeV1;

type GovernedSubagentCompositionV1 = BuiltinGovernedSubagentCompositionV1<
  SubagentLifecycleArtifactAccessV1,
  BuiltinChildRuntimeDriverV1,
  SubagentTaskArtifactAccessV1
>;

/**
 * App composition for an acknowledged Subagent attempt. Builtin owns the
 * child lifecycle semantics; this adapter only binds the installed App
 * composition to the State 25 task-tool transport.
 */
export function createPipelineSubagentRuntimeV1(
  compositionFactory: () => GovernedSubagentCompositionV1,
): SubagentInvocationRuntimeV1 {
  const runtime: SubagentInvocationRuntimeV1 = {
    start: (deps, args) => executePipelineIssuedSubagentStartV1(compositionFactory(), deps, args),
    resume: (deps, continuation, toolResult) =>
      executePipelineIssuedSubagentResumeV1(compositionFactory(), deps, continuation, toolResult),
  };
  return Object.freeze(runtime);
}
