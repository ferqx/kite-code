import type { CapabilityDescriptor, EffectProfile } from '@/protocol/capabilities';
import { isDescriptorAdmittedByInProcessReadOnlyCatalogV1 } from './in-process-read-only';
import type { ExecutionCapabilitySurfaceV1 } from './types';

const DENIED_EFFECT_LEVELS = new Set(['write', 'destructive', 'unknown']);

function profileFitsSurface(
  profile: EffectProfile,
  surface: ExecutionCapabilitySurfaceV1,
): boolean {
  if (!surface.write) {
    if (DENIED_EFFECT_LEVELS.has(profile.filesystem)) return false;
    if (DENIED_EFFECT_LEVELS.has(profile.externalState)) return false;
  }
  if (!surface.network && profile.network !== 'none') return false;
  return true;
}

/**
 * Fail-closed model/execution admission for one capability descriptor.
 *
 * The no-process fallback is bound to its sealed descriptor catalog. Native
 * process-backed shell execution is instead governed by the explicit shell
 * surface: its descriptor is intentionally conservative (`unknown`) because
 * the native sandbox, not the in-process tool, enforces filesystem/network
 * restrictions. Every other capability must fit both declared and effective
 * effects independently of whether process execution remains available.
 */
export function isDescriptorAdmittedByExecutionCapabilitySurfaceV1(input: {
  surface: ExecutionCapabilitySurfaceV1;
  descriptor: CapabilityDescriptor;
}): boolean {
  const { surface, descriptor } = input;

  if (!surface.process && !surface.write) {
    return Boolean(
      surface.inProcessReadOnlyTools &&
        isDescriptorAdmittedByInProcessReadOnlyCatalogV1({
          catalog: surface.inProcessReadOnlyTools,
          descriptor,
        }),
    );
  }

  if (descriptor.kind === 'builtin_tool' && descriptor.capabilityId === 'builtin:shell_execute') {
    return surface.process && surface.shell;
  }

  if (descriptor.kind === 'builtin_tool' && descriptor.capabilityId === 'builtin:activate_skill') {
    if (!surface.process || !surface.skillChild) return false;
  }

  if (descriptor.kind === 'mcp_tool' && !surface.network && !surface.localStdioMcp) return false;

  return (
    profileFitsSurface(descriptor.declaredEffects, surface) &&
    profileFitsSurface(descriptor.effectiveEffects, surface)
  );
}
