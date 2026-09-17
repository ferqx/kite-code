import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeServiceStartupDiagnostic,
  encodeServiceStartupProgress,
  parseServiceStartupDiagnostic,
  SERVICE_STARTUP_DIAGNOSTIC_PREFIX,
} from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { RuntimeClient } from '@kite-ai/runtime-client';
import { RendererConnection } from '../electron/runtime/renderer-connection';
import { ServiceProcess, type ServiceProcessOptions } from '../electron/runtime/service-process';

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

test('store startup failure reaches initialize with only public code and schema', async () => {
  const diagnostic = `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify({
    code: 'store_incompatible',
    actualSchema: 11,
    expectedSchema: 10,
  })}`;
  await withFixture(
    `process.stderr.write(${JSON.stringify(diagnostic + '\n')});
process.stderr.write('secret epoch and path must stay private\\n');
process.exit(1);`,
    async (carrier) => {
      const connection = new RendererConnection(carrier, 'fixture');
      await connection.attach(1);
      await connection
        .send(
          1,
          JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'initialize',
            params: { protocolVersion: 2 },
          }),
        )
        .catch(() => undefined);
      const frame = JSON.parse(await withDeadline(connection.receive(1), 3_000));
      expect(frame.id).toBe(7);
      expect(frame.error.message).toContain('STORE_INCOMPATIBLE');
      expect(frame.error.message).toContain('11');
      expect(frame.error.message).toContain('10');
      expect(frame.error.message).not.toContain('epoch');
      expect(frame.error.message).not.toContain('path');
    },
  );
});

test('bounded progress stays separate from the terminal diagnostic and arbitrary stderr', async () => {
  const phases: string[] = [];
  const progress = encodeServiceStartupProgress('preparing');
  const diagnostic = `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify({
    code: 'store_insufficient_space',
    actualSchema: 9,
    expectedSchema: 10,
    stage: 'preparing',
  })}\n`;
  await withFixture(
    `for (let index = 0; index < 100; index++) process.stderr.write(${JSON.stringify(progress)});
process.stderr.write('private path /Users/example ' + 'x'.repeat(5000) + '\\n');
process.stderr.write(${JSON.stringify(diagnostic)});
process.exit(1);`,
    async (carrier) => {
      await expect(withDeadline(carrier.receive(), 3_000)).rejects.toThrow(
        'STORE_INSUFFICIENT_SPACE',
      );
      await expect(carrier.receive()).rejects.not.toThrow('/Users/example');
      expect(phases).toHaveLength(100);
      expect(phases.every((phase) => phase === 'preparing')).toBe(true);
    },
    { onStartupPhase: (phase) => phases.push(phase) },
  );
});

test('malformed startup stderr stays private and reports the exit code', async () => {
  await withFixture(
    `process.stderr.write('private storage path /Users/example\\n'); process.exit(7);`,
    async (carrier) => {
      await expect(withDeadline(carrier.receive(), 3_000)).rejects.toThrow('退出码 7');
      await expect(carrier.receive()).rejects.not.toThrow('/Users/example');
    },
  );
});

test('extra private diagnostic fields are not exposed to native save', async () => {
  const captured: unknown[] = [];
  await withFixture(
    `process.stderr.write(${JSON.stringify(
      `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}{"code":"store_busy","actualSchema":9,"expectedSchema":10,"path":"/private/secret"}\n`,
    )}); process.exit(1);`,
    async (carrier) => {
      await expect(withDeadline(carrier.receive(), 3_000)).rejects.toThrow('退出码 1');
      expect(captured).toHaveLength(0);
    },
    { onStartupDiagnostic: (diagnostic) => captured.push(diagnostic) },
  );
});

test('failed pre-initialize Service does not prevent Desktop shutdown', async () => {
  await withFixture(`process.exit(1);`, async (carrier) => {
    await expect(withDeadline(carrier.receive(), 3_000)).rejects.toThrow('退出码 1');
    await expect(carrier.close()).resolves.toBeUndefined();
  });
});

test('pre-initialize close waits beyond the old deadline without killing publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-electron-safe-close-'));
  const marker = join(root, 'settled');
  const ready = join(root, 'ready');
  try {
    await withFixture(
      `process.on('SIGTERM', () => {
  setTimeout(() => {
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'settled');
    process.exit(0);
  }, 16_000);
});
process.stdin.resume();
require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
setInterval(() => {}, 1_000);`,
      async (carrier) => {
        await withDeadline(
          (async () => {
            while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10));
          })(),
          3_000,
        );
        await withDeadline(carrier.close(), 20_000);
        expect(carrier.finished).toBe(true);
        expect(readFileSync(marker, 'utf8')).toBe('settled');
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

test('nonzero exit after initialize still requires task-result inspection', async () => {
  await withFixture(
    `process.stdin.resume(); process.stdin.on('end', () => process.exit(1));`,
    async (carrier) => {
      carrier.markInitialized();
      await expect(carrier.close()).rejects.toThrow('请检查任务结果');
    },
  );
});

test('startup EOF from a still-live Service fails promptly and cleans up the owned process', async () => {
  await withFixture(
    `require('node:fs').closeSync(1);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);`,
    async (carrier) => {
      await expect(withDeadline(carrier.receive(), 3_000)).rejects.toThrow('退出码 未知');
      await withDeadline(
        (async () => {
          while (!carrier.finished) await new Promise((resolve) => setTimeout(resolve, 1));
        })(),
        3_000,
      );
      expect(carrier.finished).toBe(true);
    },
  );
});

test('failed startup EOF waits for owned Service settlement beyond the old cleanup deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-electron-failed-startup-settle-'));
  const marker = join(root, 'settled');
  try {
    await withFixture(
      `process.on('SIGTERM', () => {
  setTimeout(() => {
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'settled');
    process.exit(0);
  }, 3_000);
});
require('node:fs').closeSync(1);
process.stdin.resume();
setInterval(() => {}, 1_000);`,
      async (carrier) => {
        await expect(withDeadline(carrier.receive(), 3_000)).rejects.toThrow('退出码 未知');
        await withDeadline(
          (async () => {
            while (!carrier.finished) await new Promise((resolve) => setTimeout(resolve, 10));
          })(),
          6_000,
        );
        expect(readFileSync(marker, 'utf8')).toBe('settled');
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('startup diagnostic codec excludes paths and epochs and rejects added fields', () => {
  const line = encodeServiceStartupDiagnostic({
    name: 'KiteSessionStoreOpenError',
    code: 'store_incompatible',
    message: '/private/path',
    compatibility: {
      actualSchema: 11,
      expectedSchema: 10,
      actualEpoch: 'private-epoch',
      expectedEpoch: 'expected-epoch',
    },
  });
  expect(line).toBeDefined();
  expect(line).not.toContain('/private/path');
  expect(line).not.toContain('epoch');
  expect(parseServiceStartupDiagnostic(line!)).toEqual({
    code: 'store_incompatible',
    actualSchema: 11,
    expectedSchema: 10,
  });
  expect(
    parseServiceStartupDiagnostic(line!.trimEnd().replace('}', ',"path":"secret"}')),
  ).toBeUndefined();
});

test('a Service that exits before initialize still reports its store error through RuntimeClient', async () => {
  const diagnostic = `${SERVICE_STARTUP_DIAGNOSTIC_PREFIX}${JSON.stringify({
    code: 'store_migration_required',
    actualSchema: 9,
    expectedSchema: 10,
  })}`;
  await withFixture(
    `process.stderr.write(${JSON.stringify(diagnostic + '\n')}); process.exit(1);`,
    async (carrier) => {
      await withDeadline(
        (async () => {
          while (!carrier.finished) await new Promise((resolve) => setTimeout(resolve, 1));
        })(),
        3_000,
      );
      const connection = new RendererConnection(carrier, 'fixture');
      await connection.attach(1);
      const runtime = new RuntimeClient({
        clientInfo: { name: 'test', version: '1', instanceId: 'test' },
        transport: {
          async connect() {
            return {
              send: (message) => connection.send(1, JSON.stringify(message)),
              async *messages() {
                for (;;) yield JSON.parse(await connection.receive(1));
              },
              close: async () => undefined,
            };
          },
        },
      });
      await expect(withDeadline(runtime.connect(), 3_000)).rejects.toThrow(
        'STORE_MIGRATION_REQUIRED',
      );
      await runtime.close();
    },
  );
});

async function withFixture(
  source: string,
  operation: (carrier: ServiceProcess) => Promise<void>,
  options: Pick<ServiceProcessOptions, 'onStartupPhase' | 'onStartupDiagnostic'> = {},
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
    ...options,
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
