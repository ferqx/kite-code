export async function registeredEntrypoint(run: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await run();
  } catch (error) {
    const value =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.message
          : '';
    const code = /^[a-z][a-z0-9_]{0,80}$/.test(value) ? value : 'cli_registration_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
