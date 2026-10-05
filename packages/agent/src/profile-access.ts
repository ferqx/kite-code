/** Explicit host profile-use authority. Import does not open files or acquire locks. */
import {
  acquireProfileAccess as acquire,
  type ProfileAccess,
  type ProfileOptions,
} from './platform/profile';

export type { FileLock, WindowsPathSecurity } from './platform/locks';
export type { ProfileAccess, ProfileOptions } from './platform/profile';
export {
  acquireInheritedProfileAccess,
  acquireProfileDataLock,
  assertProfileAccess,
} from './platform/profile';
/** Normal host admission; maintenance-exclusive authority is not exposed by this leaf. */
export function acquireProfileAccess(options: ProfileOptions): ProfileAccess {
  return acquire(options);
}
