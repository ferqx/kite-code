import type { SandboxCapabilityDescriptorV1 } from './execution-capability-surface';
import type { InProcessReadOnlyToolCatalogV1 } from './types';

/** Exact descriptor/effect binding required by a verified no-process fallback. */
export function isDescriptorAdmittedByInProcessReadOnlyCatalogV1(input: {
  catalog: InProcessReadOnlyToolCatalogV1;
  descriptor: SandboxCapabilityDescriptorV1;
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
