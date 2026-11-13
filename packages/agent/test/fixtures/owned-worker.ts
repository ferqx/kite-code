import * as threads from 'node:worker_threads';
import { mock } from '#kite-test';

const original = { ...threads };
export const NativeWorker = original.Worker;
export type NativeWorker = InstanceType<typeof original.Worker>;
type WorkerArguments = ConstructorParameters<typeof NativeWorker>;

export function useFixtureWorker(Worker = NativeWorker): void {
  mock.module('node:worker_threads', () => ({ ...original, Worker }));
}

/** Replace only the business script. macOS still runs the real observer first. */
export function fixtureWorkerEntry(
  [entry, options]: WorkerArguments,
  fixture: URL,
): WorkerArguments {
  return options?.workerData
    ? [entry, { ...options, workerData: fixture.href }]
    : [fixture, options];
}
