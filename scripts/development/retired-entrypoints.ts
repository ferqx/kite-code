type RetiredApplication = 'terminal';

const currentCommands: Record<RetiredApplication, readonly string[]> = {
  terminal: [
    'bun run release:build',
    'bun run agent --help',
    'bun run tui',
    'bun run cli:dev --help',
    'bun run tui:dev',
  ],
};

/** Ordinary retired paths reject before loading their historical implementations. */
export function rejectRetiredEntrypoint(application: RetiredApplication): void {
  process.stderr.write(
    `legacy_${application}_entrypoint_retired\n` +
      '旧普通入口已退役。请在仓库根使用当前入口：\n' +
      currentCommands[application].map((command) => `  ${command}\n`).join(''),
  );
  process.exitCode = 2;
}

if (import.meta.main) {
  const application = process.argv[2];
  if (application === 'terminal') rejectRetiredEntrypoint(application);
  else {
    process.stderr.write('legacy_entrypoint_arguments_invalid\n');
    process.exitCode = 2;
  }
}
