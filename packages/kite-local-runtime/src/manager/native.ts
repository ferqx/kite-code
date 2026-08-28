import type { KiteHomeIdentity } from '../service';
import { createKiteServiceManagerNativeLifecycleLockPort } from './native-lock';
import type { KiteServiceManagerNativeStatePort } from './native-state';
import { createKiteServiceManagerNativeStatePort } from './native-state';
import type { KiteServiceManagerLifecycleLockPort, KiteServiceManagerProcessPort } from './ports';

export interface KiteServiceManagerNativePorts {
  readonly state: KiteServiceManagerNativeStatePort;
  readonly lifecycleLock: KiteServiceManagerLifecycleLockPort;
}

/**
 * Compose the manager's Native state and lifecycle-lock ports from one explicit, already
 * validated home identity. The process probe remains injected to keep PID identity decisions
 * platform-specific and testable.
 */
export function createKiteServiceManagerNativePorts(input: {
  readonly identity: KiteHomeIdentity;
  readonly process: KiteServiceManagerProcessPort;
}): KiteServiceManagerNativePorts {
  return Object.freeze({
    state: createKiteServiceManagerNativeStatePort(input.identity),
    lifecycleLock: createKiteServiceManagerNativeLifecycleLockPort(input),
  });
}
