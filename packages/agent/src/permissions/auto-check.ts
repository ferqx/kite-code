import { createHash } from 'node:crypto';
import type { PermissionDecision } from '../extensions';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';

/** Continuing on timeout requires every challenged policy's agreement. */
export function autoCheckOptions(checks: readonly NonNullable<PermissionDecision['check']>[]) {
  const keys = checks.map((check) => check.operationKey);
  const scopes = checks.map((check) => check.timeoutScope);
  const scope = scopes[0];
  const behavior = checks[0]?.behavior;
  const stopOnTimeout = checks.some((check) => check.stopOnTimeout);
  return {
    ...(behavior &&
    checks.every(
      (check) =>
        check.behavior &&
        canonicalJson(check.behavior as unknown as Json) ===
          canonicalJson(behavior as unknown as Json),
    )
      ? { behavior }
      : {}),
    ...(keys.length && keys.every(Boolean)
      ? {
          operationKey:
            new Set(keys).size === 1
              ? keys[0]!
              : createHash('sha256').update(JSON.stringify(keys)).digest('hex'),
        }
      : {}),
    ...(stopOnTimeout ? { stopOnTimeout: true as const } : {}),
    ...(!stopOnTimeout &&
    scopes.length &&
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
