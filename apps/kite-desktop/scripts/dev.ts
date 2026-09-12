import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';

const root = resolve(import.meta.dir, '..');
if (!existsSync(resolve(root, 'service/desktop.json'))) {
  throw new Error(
    '配套 Runtime Host 尚未准备。请先执行 bun run --cwd apps/kite-desktop prepare:service。',
  );
}
await import('./build-electron');
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
});
await server.listen();
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
  await server.close();
}
