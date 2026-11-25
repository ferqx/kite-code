/** Only bounded machine codes cross from Bun into the Windows dialogs. */
function failureCode(error: unknown): string {
  const code = error instanceof Error ? ('code' in error ? error.code : error.message) : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/u.test(code)
    ? code
    : 'operation_failed';
}

export function reportSetupFailure(error: unknown): void {
  const code = failureCode(error);
  const original =
    code === 'native_archive_rolled_back' && error instanceof Error
      ? error.cause
      : (code === 'native_archive_close_unknown' ||
            (code === 'native_windows_close_unknown' &&
              error instanceof AggregateError &&
              error.errors.length > 1)) &&
          error instanceof AggregateError
        ? error.errors[0]
        : undefined;
  const root = original ?? error;
  const detail = root instanceof Error ? failureCode(root.cause) : 'operation_failed';
  if (detail !== 'operation_failed') console.error(`KITE_SETUP_DIAGNOSTIC ${detail}`);
  console.error(`KITE_SETUP_FAILURE ${code}${original ? ` ${failureCode(original)}` : ''}`);
}
