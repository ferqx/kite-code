import { createHash } from 'node:crypto';
import type { PermissionDecision } from '../extensions';

/** Intersections preserve only the Auto options supported by every challenged policy. */
export function autoCheckOptions(checks: readonly NonNullable<PermissionDecision['check']>[]) {
  const keys = checks.map((check) => check.operationKey);
  const scopes = checks.map((check) => check.timeoutScope);
  const scope = scopes[0];
  return {
    ...(keys.length && keys.every(Boolean)
      ? {
          operationKey:
            new Set(keys).size === 1
              ? keys[0]!
              : createHash('sha256').update(JSON.stringify(keys)).digest('hex'),
        }
      : {}),
    ...(scopes.length &&
    scopes.every(
      (candidate) =>
        candidate &&
        (candidate === scope ||
          (typeof candidate === 'object' &&
            typeof scope === 'object' &&
            candidate.filesystem === scope.filesystem &&
            candidate.network === scope.network)),
    )
      ? { timeoutScope: scope! }
      : {}),
  };
}
