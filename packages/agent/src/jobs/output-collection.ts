import { type JobContext, JobStartError } from '../extensions';
import type { LaunchIdentity } from './launch-identity';

/** Host-only durable allocation. A resolved preparation transfers directory cleanup ownership. */
export interface ShellOutputCollection {
  prepare(
    context: JobContext,
    runtimeTemp: LaunchIdentity,
  ): Promise<{ env: Readonly<Record<string, string>>; cleanupTransferred: true }>;
}

export class ShellOutputPreparationCleanupError extends Error {
  readonly preparationError: unknown;
  readonly cleanupError: unknown;
  constructor(preparationError: unknown, cleanupError: unknown) {
    super('shell_output_preparation_cleanup_unknown', { cause: cleanupError });
    this.preparationError = preparationError;
    this.cleanupError = cleanupError;
  }
}

export async function prepareShellOutputCollection(
  collection: ShellOutputCollection,
  context: JobContext,
  launch: { runtimeTemp: LaunchIdentity; cleanup(): void | Promise<void> },
) {
  try {
    context.signal.throwIfAborted();
    // Do not check cancellation after this await: registration transfers cleanup
    // even if the producer is cancelled or cannot subsequently spawn.
    return await collection.prepare(context, launch.runtimeTemp);
  } catch (error) {
    try {
      await launch.cleanup();
    } catch (cleanupError) {
      throw new ShellOutputPreparationCleanupError(error, cleanupError);
    }
    throw new JobStartError(undefined, 'shell_output_preparation_failed');
  }
}
