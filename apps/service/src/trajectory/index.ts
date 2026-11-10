import type { Store } from '@kite-ai/agent/storage';
import { TrajectoryEvidenceReads, type TrajectoryMaterialReader } from './evidence';

/** Trusted first-party source. Subject identity is injected by Service, never by the request. */
export interface TrajectorySource {
  evidence?: TrajectoryEvidenceReads;
  open(
    input: Parameters<Store['openTrajectory']>[0],
    options: { signal?: AbortSignal },
  ): ReturnType<Store['openTrajectory']>;
  readEvents(
    input: Parameters<Store['readTrajectoryEvents']>[0],
    options: { signal?: AbortSignal },
  ): ReturnType<Store['readTrajectoryEvents']>;
}
export function createTrajectorySource(
  store: Pick<Store, 'openTrajectory' | 'readTrajectoryEvents' | 'readTrajectoryBinding'>,
  material?: TrajectoryMaterialReader,
): TrajectorySource {
  return {
    ...(material ? { evidence: new TrajectoryEvidenceReads(store, material) } : {}),
    async open(input, { signal }) {
      signal?.throwIfAborted();
      const value = await store.openTrajectory(input);
      signal?.throwIfAborted();
      return value;
    },
    async readEvents(input, { signal }) {
      signal?.throwIfAborted();
      const value = await store.readTrajectoryEvents(input);
      signal?.throwIfAborted();
      return value;
    },
  };
}
