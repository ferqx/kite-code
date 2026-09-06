import type { Database } from 'bun:sqlite';
import { assertKiteSessionStoreSchema } from './kite-home-store';
import { KiteHomeWriteError, type KiteHomeWriteTransactionPort } from './kite-home-write';
import type {
  KiteSessionExecutionAuthority,
  KiteSessionExecutionBinding,
} from './kite-session-execution-authority';
import { KiteSessionExecutionAuthorityError } from './kite-session-execution-authority';

export type KiteSessionMutationErrorCode = 'invalid_input' | 'revision_conflict' | 'deleted';

export class KiteSessionMutationError extends Error {
  readonly code: KiteSessionMutationErrorCode;

  constructor(code: KiteSessionMutationErrorCode, message: string) {
    super(message);
    this.name = 'KiteSessionMutationError';
    this.code = code;
  }
}

export interface KiteSessionMutationInput extends KiteSessionExecutionBinding {
  readonly expectedSessionRevision: number;
}

export interface KiteSessionMutationPort {
  run<Result>(input: KiteSessionMutationInput, mutation: () => Result): Result;
  assertDispatchable(binding: KiteSessionExecutionBinding): void;
}

/**
 * The target Store's sole Session-scoped write boundary. The generation and Session revision are
 * re-read after BEGIN IMMEDIATE, so a successful check cannot race another SQLite writer commit.
 */
export function createKiteSessionMutationPort(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly authority: KiteSessionExecutionAuthority;
}): KiteSessionMutationPort {
  assertKiteSessionStoreSchema(input.database);
  const selectRevision = input.database.query<{ revision: number }, [string]>(
    'SELECT revision FROM runtime_sessions WHERE session_id = ? LIMIT 1',
  );

  const run = <Result>(request: KiteSessionMutationInput, mutation: () => Result): Result => {
    assertRevision(request.expectedSessionRevision);
    try {
      return input.writer.run(() => {
        input.authority.assertActive(request);
        const session = selectRevision.get(request.sessionId);
        if (!session) {
          throw new KiteSessionMutationError('deleted', 'Session was deleted before mutation.');
        }
        if (session.revision !== request.expectedSessionRevision) {
          throw new KiteSessionMutationError(
            'revision_conflict',
            'Session revision changed before mutation.',
          );
        }
        return mutation();
      });
    } catch (error) {
      if (
        error instanceof KiteHomeWriteError &&
        error.code === 'write_failed' &&
        (error.cause instanceof KiteSessionMutationError ||
          error.cause instanceof KiteSessionExecutionAuthorityError)
      ) {
        throw error.cause;
      }
      throw error;
    }
  };

  const assertDispatchable = (binding: KiteSessionExecutionBinding): void => {
    input.authority.assertActive(binding);
  };

  return Object.freeze({ run, assertDispatchable });
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KiteSessionMutationError('invalid_input', 'Expected Session revision is invalid.');
  }
}
