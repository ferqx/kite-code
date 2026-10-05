export async function registeredEntrypoint(run: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await run();
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
        ? error.message
        : 'cli_registration_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
