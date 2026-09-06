import { isIdentifier, isRecord } from './validation';

/**
 * In-process-only context attached to one admitted Runtime command. It is
 * intentionally absent from the Runtime Protocol schemas and mappers.
 */
export const RUNTIME_COMMAND_CONTEXT_SCHEMA_ = 'kite.runtime-command-context.v1' as const;

export interface RuntimeCommandContext {
  readonly schema: typeof RUNTIME_COMMAND_CONTEXT_SCHEMA_;
  /** RuntimeServer logical connection identity; never a transport credential. */
  readonly connectionId: string;
  /** Protocol request identity that was admitted for this command. */
  readonly requestId: string;
  /** App-owned opaque reference to the authenticated Worker connection binding. */
  readonly bindingReference: string | null;
  readonly clientInfo?: Readonly<{
    readonly name: string;
    readonly version: string;
    readonly instanceId: string;
  }>;
}

export function isRuntimeCommandContext(value: unknown): value is RuntimeCommandContext {
  if (!isRecord(value)) return false;
  if (
    value.schema !== RUNTIME_COMMAND_CONTEXT_SCHEMA_ ||
    !isIdentifier(value.connectionId) ||
    !isIdentifier(value.requestId) ||
    (value.bindingReference !== null && !isIdentifier(value.bindingReference))
  ) {
    return false;
  }
  if (value.clientInfo === undefined) return true;
  if (!isRecord(value.clientInfo)) return false;
  return (
    isIdentifier(value.clientInfo.name) &&
    isIdentifier(value.clientInfo.version) &&
    isIdentifier(value.clientInfo.instanceId)
  );
}

export function assertRuntimeCommandContext(
  value: unknown,
): asserts value is RuntimeCommandContext {
  if (!isRuntimeCommandContext(value)) throw new TypeError('Invalid RuntimeCommandContext.');
}

/** Validate and freeze the context before crossing an asynchronous boundary. */
export function freezeRuntimeCommandContext(value: RuntimeCommandContext): RuntimeCommandContext {
  assertRuntimeCommandContext(value);
  return Object.freeze({
    ...value,
    ...(value.clientInfo === undefined
      ? {}
      : { clientInfo: Object.freeze({ ...value.clientInfo }) }),
  });
}
