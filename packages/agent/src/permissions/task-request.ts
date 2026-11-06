import { createHash } from 'node:crypto';
import type { AuthorizationRequest, Json } from '../extensions';
import {
  defaultTaskRoleId,
  defaultTaskRoles,
  type TrustedTaskRole,
} from '../extensions/task/roles';
import { canonicalJson } from '../json';
import type { CapabilityDescription } from './index';

/** Exact finite trusted builtins only; prior catalogues must be verified by the calling host. */
export function createDefaultTaskRequestClassifier(
  selectedRoles: readonly TrustedTaskRole[],
  options: {
    readonly trustedRoles?: readonly TrustedTaskRole[];
    readonly defaultRole?: string;
  } = {},
) {
  const trustedRoles = options.trustedRoles ?? defaultTaskRoles;
  const defaultRole = options.defaultRole ?? defaultTaskRoleId;
  const roles = structuredClone(selectedRoles).filter((selected) =>
    trustedRoles.some(
      (trusted) =>
        canonicalJson(selected as unknown as Json) === canonicalJson(trusted as unknown as Json),
    ),
  );
  return (request: AuthorizationRequest): Partial<CapabilityDescription> | undefined => {
    const input = request.input;
    const role =
      request.kind === 'tool' &&
      request.definitionId === 'task.spawn' &&
      input &&
      typeof input === 'object' &&
      !Array.isArray(input)
        ? typeof input.preset === 'string'
          ? input.preset
          : defaultRole
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
