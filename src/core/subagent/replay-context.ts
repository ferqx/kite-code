import { digestCapability } from '@/core/capabilities/catalog';
import type { ModelReplayInvocationBindingV1 } from '@/protocol/model-surface';

/** Digest the sealed replay authority, excluding only the advancing actor-local ordinal. */
export function subagentReplayContextDigestV1(
  mode: 'live' | 'record' | 'replay',
  binding?: ModelReplayInvocationBindingV1,
): string {
  if (mode === 'live') {
    return digestCapability({ schema: 'kite.subagent-replay-context.v1', mode });
  }
  if (!binding) throw new Error('Subagent record/replay authority binding is unavailable.');
  return digestCapability({
    schema: 'kite.subagent-replay-context.v1',
    mode,
    suiteId: binding.suiteId,
    suiteRevision: binding.suiteRevision,
    fixtureDigest: binding.fixtureDigest,
    replayDigest: binding.replayDigest,
    actor: binding.actor,
  });
}
