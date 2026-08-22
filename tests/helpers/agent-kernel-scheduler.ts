import type { RuntimeState } from '@kite/runtime-host';
import { decideNextEffect as decideAgentKernelEffect } from '#agent-kernel';

/** Test-only State25 bridge while root fixtures still use the legacy RuntimeState type name. */
export function decideNextEffect(state: RuntimeState) {
  return decideAgentKernelEffect(state as unknown as Parameters<typeof decideAgentKernelEffect>[0]);
}
