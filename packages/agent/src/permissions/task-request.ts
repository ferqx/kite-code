import { createHash } from 'node:crypto';
import type { AuthorizationRequest, Json } from '../extensions';
import { defaultTaskRoles, type TrustedTaskRole } from '../extensions/task/roles';
import { canonicalJson } from '../json';
import type { CapabilityDescription } from './index';

/** Only the unchanged finite builtin role declarations qualify; custom names/overrides do not. */
export function createDefaultTaskRequestClassifier(selectedRoles: readonly TrustedTaskRole[]) {
  const roles = structuredClone(selectedRoles).filter((selected) =>
    defaultTaskRoles.some(
      (trusted) =>
        canonicalJson(selected as unknown as Json) === canonicalJson(trusted as unknown as Json),
    ),
  );
  return (request: AuthorizationRequest): Partial<CapabilityDescription> | undefined => {
    const input = request.input;
    const role =
      request.kind === 'tool' &&
      ['task', 'task.execute', 'task.spawn'].includes(request.definitionId) &&
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      (typeof input.role === 'string' || request.definitionId === 'task.spawn')
        ? request.definitionId === 'task.spawn'
          ? typeof input.preset === 'string'
            ? input.preset
            : 'worker'
          : input.role
        : request.kind === 'job' && request.definitionId.startsWith('agent/')
          ? request.definitionId.slice('agent/'.length)
          : undefined;
    if (request.definitionVersion !== '1' || !roles.some((selected) => selected.id === role))
      return undefined;
    return {
      revision: `builtin.task.internal:${createHash('sha256')
        .update(
          canonicalJson({
            roles: roles as unknown as Json,
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
            input,
          }),
        )
        .digest('hex')}`,
      effects: ['record_write'],
      safeRead: false,
      internalRecordOnly: true,
    };
  };
}
