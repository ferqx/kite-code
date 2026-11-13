/** Only bounded machine codes cross from the runtime into the Windows dialogs. */
export function reportSetupFailure(error: unknown): void {
  const code = error instanceof Error ? ('code' in error ? error.code : error.message) : undefined;
  console.error(
    `KITE_SETUP_FAILURE ${typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/u.test(code) ? code : 'operation_failed'}`,
  );
}
