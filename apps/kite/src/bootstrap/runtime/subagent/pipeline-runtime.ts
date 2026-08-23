import type {
  BuiltinChildRuntimeDriver,
  GovernedSubagentComposition as BuiltinGovernedSubagentComposition,
  SubagentLifecycleArtifactAccess,
  SubagentTaskArtifactAccess,
} from '@kite/builtin-runtime/subagent';
import {
  executePipelineIssuedSubagentResume,
  executePipelineIssuedSubagentStart,
  type SubagentInvocationRuntime,
} from './task-tool';

/** App factory consumed only after Host has acknowledged the outer attempt. */
export type AppSubagentRuntimeFactory = () => SubagentInvocationRuntime;

type GovernedSubagentComposition = BuiltinGovernedSubagentComposition<
  SubagentLifecycleArtifactAccess,
  BuiltinChildRuntimeDriver,
  SubagentTaskArtifactAccess
>;

/**
 * App composition for an acknowledged Subagent attempt. Builtin owns the
 * child lifecycle semantics; this adapter only binds the installed App
 * composition to the State 25 task-tool transport.
 */
export function createPipelineSubagentRuntime(
  compositionFactory: () => GovernedSubagentComposition,
): SubagentInvocationRuntime {
  const runtime: SubagentInvocationRuntime = {
    start: (deps, args) => executePipelineIssuedSubagentStart(compositionFactory(), deps, args),
    resume: (deps, continuation, toolResult) =>
      executePipelineIssuedSubagentResume(compositionFactory(), deps, continuation, toolResult),
  };
  return Object.freeze(runtime);
}
