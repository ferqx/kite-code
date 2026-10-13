/** Historical Desktop paths remain recognizable, but cannot build or launch the old writer. */
export function rejectRetiredDesktopEntry(): void {
  process.stderr.write(
    'legacy_desktop_entrypoint_retired\n' +
      '旧 Desktop 开发／构建入口已退役。请在仓库根使用当前 Native 入口：\n' +
      '  bun run release:build --product native\n' +
      '  bun run desktop\n' +
      '  bun run test:desktop:native\n' +
      '安装、归档和版本操作：bun run release:native --help\n',
  );
  process.exitCode = 2;
}

if (import.meta.main) rejectRetiredDesktopEntry();
