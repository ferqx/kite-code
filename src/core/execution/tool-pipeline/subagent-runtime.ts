import type { GovernedSubagentCompositionV1 } from '@/core/subagent/composition';
import { createGovernedLocalSubagentCompositionV1 } from '@/core/subagent/composition';
import {
  executePipelineIssuedSubagentResumeV1,
  executePipelineIssuedSubagentStartV1,
  type SubagentInvocationRuntimeV1,
} from '@/core/subagent/task-tool';

/**
 * Sole production composition for acknowledged Subagent attempts. Grant
 * authority and concrete Provider selection remain inside the Tool Pipeline.
 */
export function createPipelineSubagentRuntimeV1(
  compositionFactory: () => GovernedSubagentCompositionV1 = createGovernedLocalSubagentCompositionV1,
): SubagentInvocationRuntimeV1 {
  const runtime: SubagentInvocationRuntimeV1 = {
    start: (deps, args) => executePipelineIssuedSubagentStartV1(compositionFactory(), deps, args),
    resume: (deps, continuation, toolResult) =>
      executePipelineIssuedSubagentResumeV1(compositionFactory(), deps, continuation, toolResult),
  };
  return Object.freeze(runtime);
}
