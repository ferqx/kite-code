import type { SandboxCapabilityDescriptor } from './execution-capability-surface';
import type { InProcessReadOnlyToolCatalog } from './types';

/** Exact descriptor/effect binding required by a verified no-process fallback. */
export function isDescriptorAdmittedByInProcessReadOnlyCatalog(input: {
  catalog: InProcessReadOnlyToolCatalog;
  descriptor: SandboxCapabilityDescriptor;
}): boolean {
  const { catalog, descriptor } = input;
  const contract = catalog.tools.find((tool) => tool.toolId === descriptor.capabilityId);
  if (!contract || contract.descriptorRevision !== descriptor.revision) return false;
  return (
    descriptor.kind === 'builtin_tool' &&
    descriptor.provider.type === 'builtin' &&
    descriptor.availability === 'available' &&
    descriptor.declaredEffects.filesystem === 'read' &&
    descriptor.declaredEffects.network === 'none' &&
    descriptor.declaredEffects.externalState === 'none' &&
    descriptor.effectiveEffects.filesystem === 'read' &&
    descriptor.effectiveEffects.network === 'none' &&
    descriptor.effectiveEffects.externalState === 'none'
  );
}
