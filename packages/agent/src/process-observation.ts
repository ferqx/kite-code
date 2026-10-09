/** Trusted host observation only; no enumeration, signal, spawn, or ownership acquisition. */
export {
  isOwnedProcessIdentity,
  type OwnedProcessIdentity,
  type OwnedProcessRecord,
  observeOwnedProcessIdentity,
  ownedProcessKernelState,
} from './platform/process/owned-process-observation';
