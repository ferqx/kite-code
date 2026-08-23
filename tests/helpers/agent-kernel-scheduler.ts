import type { RuntimeState } from '@kite/runtime-host/kernel-adapter';
import { decideNextEffect as decideAgentKernelEffect } from '#agent-kernel';

/** Test-only State bridge while root fixtures still use the legacy RuntimeState type name. */
export function decideNextEffect(state: RuntimeState) {
  return decideAgentKernelEffect(state as unknown as Parameters<typeof decideAgentKernelEffect>[0]);
}
