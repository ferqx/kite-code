import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceProcess } from '../electron/runtime/service-process';

test('stdio carrier retains frame order and closes cleanly by EOF', async () => {
  await withFixture(
    `process.stdout.write('{"a":1}\\r\\n{"b":2}\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`,
    async (carrier) => {
      expect(await carrier.receive()).toBe('{"a":1}');
      expect(await carrier.receive()).toBe('{"b":2}');
      await carrier.close();
      expect(carrier.finished).toBe(true);
    },
  );
});

test('shutdown releases a full output queue and lets the Service finish its EOF cleanup', async () => {
  await withFixture(
    `let open = true;
const frame = '{"data":"pressure"}\\n';
function write() {
  while (open && process.stdout.write(frame)) {}
  if (open) process.stdout.once('drain', write);
}
process.stdin.resume();
process.stdin.on('end', () => { open = false; process.exit(0); });
write();`,
    async (carrier) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(withDeadline(carrier.close(), 3_000)).resolves.toBeUndefined();
      expect(carrier.finished).toBe(true);
    },
  );
});

test('invalid and oversized stdout close the owned Service instead of leaving it running', async () => {
  for (const source of [
    `process.stdout.write(Buffer.from([255, 10]));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`,
    `process.stdout.write('x'.repeat(1_048_580) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`,
  ]) {
    await withFixture(source, async (carrier) => {
      await expect(carrier.receive()).rejects.toThrow(/UTF-8|大小限制/u);
      await expect(withDeadline(carrier.close(), 3_000)).resolves.toBeUndefined();
      expect(carrier.finished).toBe(true);
    });
  }
});

test('start reports an unlaunchable paired executable before opening the renderer connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-electron-unlaunchable-'));
  try {
    const executable = join(root, 'fixture');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    await expect(
      ServiceProcess.start({
        executable,
        workspace: root,
        home: root,
        runtimeRoot: root,
        buildId: 'fixture',
        environmentKeys: [],
      }),
    ).rejects.toThrow('无法启动配套服务');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withFixture(
  source: string,
  operation: (carrier: ServiceProcess) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'kite-electron-service-'));
  const executable = join(root, 'fixture');
  const script = `#!/bin/sh\nexec ${shell(process.execPath)} -e ${shell(source)}\n`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o700);
  const carrier = await ServiceProcess.start({
    executable,
    workspace: root,
    home: root,
    runtimeRoot: root,
    buildId: 'fixture',
    environmentKeys: [],
  });
  try {
    await operation(carrier);
  } finally {
    await carrier.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function shell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('test deadline exceeded')), milliseconds),
    ),
  ]);
}
