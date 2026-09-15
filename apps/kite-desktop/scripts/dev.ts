import { resolve } from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';

const root = resolve(import.meta.dir, '..');
try {
  await start();
} catch (error) {
  console.error(`桌面开发启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function start(): Promise<void> {
  const server = await createServer({
    root,
    server: { host: '127.0.0.1', port: 1420, strictPort: true },
  });
  try {
    // Reserve the actual listener before building; a probe would leave a race.
    try {
      await server.listen();
    } catch (error) {
      if (
        error instanceof Error &&
        (('code' in error && error.code === 'EADDRINUSE') ||
          error.message === 'Port 1420 is already in use')
      ) {
        throw new Error(
          '开发端口 1420 已被占用，尚未构建配套服务或启动新窗口。\n' +
            '可能已有 kite 开发实例运行，或其他程序正在使用该端口。\n' +
            '若是已有开发实例，请在原开发终端按 Ctrl+C 退出。查看占用者可运行：\n' +
            '  lsof -nP -iTCP:1420 -sTCP:LISTEN\n' +
            '确认并关闭对应程序后，再运行 bun run desktop。',
        );
      }
      throw error;
    }
    const servicePreparation = Bun.spawn(
      [process.execPath, 'run', resolve(root, '../../scripts/release/prepare-desktop-service.ts')],
      { cwd: resolve(root, '../..'), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
    );
    const servicePreparationExitCode = await servicePreparation.exited;
    if (servicePreparationExitCode !== 0)
      throw new Error(`配套 Runtime Host 准备失败（退出码 ${servicePreparationExitCode}）。`);
    await import('./build-electron');
    const child = Bun.spawn([String(electron), root], {
      cwd: root,
      env: { ...process.env, KITE_DESKTOP_RENDERER_URL: 'http://127.0.0.1:1420' },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      process.exitCode = await child.exited;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    await server.close();
  }
}
