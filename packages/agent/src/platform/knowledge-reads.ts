import { closeSync, openSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { AgentError } from '../storage/types';

/** Trusted knowledge I/O failed to close its original acquired resource. Never a local DTO. */
export class KnowledgeReadCleanupError extends AgentError {
  declare readonly cause: {
    readonly originalError: unknown;
    readonly cleanupError: unknown;
    readonly resources: object;
  };
  constructor(input: { originalError: unknown; cleanupError: unknown; resources: object }) {
    super('knowledge_cleanup_unconfirmed');
    this.name = 'KnowledgeReadCleanupError';
    Object.defineProperty(this, 'cause', { value: Object.freeze({ ...input }), enumerable: false });
  }
}
export interface KnowledgeFileAccess {
  read<T>(
    path: string,
    flags: number,
    operation: (handle: FileHandle) => Promise<T> | T,
  ): Promise<T>;
  readSync<T>(path: string, flags: number, operation: (descriptor: number) => T): T;
}
export interface KnowledgeReadScope {
  run<T>(operation: (files: KnowledgeFileAccess) => Promise<T> | T): Promise<T>;
  runSync<T>(operation: (files: KnowledgeFileAccess) => T): T;
  dispose(): Promise<void>;
}

/** No I/O at construction. Only original admitted reads can acquire file authority. */
export function createKnowledgeReadScope(): KnowledgeReadScope {
  const retained = new Set<{
    resource: FileHandle | number;
    failure?: KnowledgeReadCleanupError;
  }>();
  let users = 0;
  let sealed = false;
  let firstFailure: KnowledgeReadCleanupError | undefined;
  let disposal: Promise<void> | undefined;
  let idle: (() => void) | undefined;
  const admit = () => {
    if (firstFailure) throw firstFailure;
    if (sealed) throw new AgentError('knowledge_scope_closed');
    users++;
  };
  const release = () => {
    if (--users === 0) idle?.();
  };
  const failure = (
    entry: { resource: FileHandle | number; failure?: KnowledgeReadCleanupError },
    originalError: unknown,
    cleanupError: unknown,
  ) => {
    const error = new KnowledgeReadCleanupError({
      originalError,
      cleanupError,
      resources: Object.freeze({ scope, resource: entry.resource }),
    });
    entry.failure = error;
    firstFailure ??= error;
    return error;
  };
  const files: KnowledgeFileAccess = {
    async read(path, flags, operation) {
      users++;
      try {
        const handle = await open(path, flags);
        const entry = { resource: handle };
        retained.add(entry);
        let result: Awaited<ReturnType<typeof operation>> | undefined;
        let failed = false;
        let originalError: unknown;
        try {
          result = await operation(handle);
        } catch (error) {
          failed = true;
          originalError = error;
        }
        try {
          await handle.close();
          retained.delete(entry);
        } catch (cleanupError) {
          throw failure(entry, originalError, cleanupError);
        }
        if (failed) throw originalError;
        return result!;
      } finally {
        release();
      }
    },
    readSync(path, flags, operation) {
      const descriptor = openSync(path, flags);
      const entry = { resource: descriptor };
      retained.add(entry);
      let result: ReturnType<typeof operation> | undefined;
      let failed = false;
      let originalError: unknown;
      try {
        result = operation(descriptor);
      } catch (error) {
        failed = true;
        originalError = error;
      }
      try {
        closeSync(descriptor);
        retained.delete(entry);
      } catch (cleanupError) {
        throw failure(entry, originalError, cleanupError);
      }
      if (failed) throw originalError;
      return result!;
    },
  };
  const admittedFiles = () => {
    let active = true;
    const check = () => {
      if (!active) throw new AgentError('knowledge_scope_closed');
    };
    const access: KnowledgeFileAccess = {
      read(path, flags, operation) {
        check();
        return files.read(path, flags, operation);
      },
      readSync(path, flags, operation) {
        check();
        return files.readSync(path, flags, operation);
      },
    };
    return {
      access,
      retire: () => {
        active = false;
      },
    };
  };
  const scope: KnowledgeReadScope = {
    async run(operation) {
      admit();
      const admitted = admittedFiles();
      try {
        return await operation(admitted.access);
      } finally {
        admitted.retire();
        release();
      }
    },
    runSync(operation) {
      admit();
      const admitted = admittedFiles();
      try {
        return operation(admitted.access);
      } finally {
        admitted.retire();
        release();
      }
    },
    dispose() {
      if (disposal) return disposal;
      sealed = true;
      disposal = Promise.resolve().then(async () => {
        if (users)
          await new Promise<void>((resolve) => {
            idle = resolve;
          });
        if (firstFailure) throw firstFailure;
      });
      return disposal;
    },
  };
  return scope;
}
