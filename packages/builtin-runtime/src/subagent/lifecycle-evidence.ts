import type {
  SubagentDelegationGrant,
  SubagentHandle,
  SubagentResumeGrant,
} from '@kite-ai/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';

/** One canonical identity shared by dispatch intent publication and restore verification. */
export function subagentDispatchIntentDigest(
  value: Readonly<SubagentDelegationGrant | SubagentResumeGrant | SubagentHandle>,
): string {
  return `sha256:${digestCapabilityBindingValue({
    schema: 'kite.subagent-dispatch-intent.v1',
    purpose: value.purpose,
    grantId: value.grantId,
    parentInvocationId: value.parentInvocationId,
    parentToolCallId: value.parentToolCallId,
    parentAttempt: value.parentAttempt,
    childInvocationId: value.childInvocationId,
    taskArtifact: value.taskArtifact,
    taskDigest: value.taskDigest,
    continuationId: value.purpose === 'resume' ? value.continuationId : null,
    continuationDigest: value.purpose === 'resume' ? value.continuationDigest : null,
    blockedToolCallId: value.purpose === 'resume' ? value.blockedToolCallId : null,
    blockedRuntimeToolCallId: value.purpose === 'resume' ? value.blockedRuntimeToolCallId : null,
    resumeAttempt: value.purpose === 'resume' ? value.resumeAttempt : null,
  })}`;
}
