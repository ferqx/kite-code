type RetiredApplication = 'desktop' | 'terminal' | 'service' | 'release';

const currentCommands: Record<RetiredApplication, readonly string[]> = {
  desktop: [
    'bun run release:build --product native',
    'bun run desktop',
    'bun run test:desktop:native',
    'bun run release:native --help',
  ],
  terminal: [
    'bun run release:build',
    'bun run agent --help',
    'bun run tui',
    'bun run cli:dev --help',
    'bun run tui:dev',
  ],
  service: ['bun run build', 'bun run release:build', 'bun run server'],
  release: [
    'bun run release:build',
    'bun run release:verify',
    'bun run release:smoke',
    'bun run release:install --help',
    'bun run release:terminal --help',
    'bun run release:native --help',
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
  if (
    application === 'desktop' ||
    application === 'terminal' ||
    application === 'service' ||
    application === 'release'
  )
    rejectRetiredEntrypoint(application);
  else {
    process.stderr.write('legacy_entrypoint_arguments_invalid\n');
    process.exitCode = 2;
  }
}
