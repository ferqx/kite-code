import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { selectProfile } from '@kite-ai/agent/profile';
import { expect, test } from '#kite-test';
import { buildDevelopmentService } from '../../../../scripts/development/desktop-reload';
import { launchPairedService, type ServiceStartupTiming } from '../../src/paired';
import { ownedUserConfiguration } from '../fixtures/user-configuration-fixture';

test('real Service startup reports ordered stages without exposing private configuration; observer failure does not affect admission', async () => {
  const repository = realpathSync(join(import.meta.dirname, '../../../..'));
  const cache = join(repository, '.cache');
  mkdirSync(cache, { recursive: true });
  const root = realpathSync(mkdtempSync(join(cache, 'kite-startup-timing-')));
  const timings: ServiceStartupTiming[] = [];
  try {
    const user = ownedUserConfiguration(join(root, 'home'));
    const application = join(root, 'application');
    const built = await buildDevelopmentService(repository, application);
    const service = await launchPairedService({
      entrypoint: join(application, 'services', built.id, 'main.js'),
      profile: selectProfile({ dataRoot: join(root, 'data'), profile: 'development' }),
      instanceId: 'timing',
      buildId: 'timing',
      apiMajor: 1,
      requiredCapabilities: ['file_recovery'],
      spawnChild: user.spawnChild,
      onStartupTiming(timing) {
        timings.push(timing);
        throw Error('observer_failure');
      },
    });
    try {
      expect(service.bootstrap.dataAvailability).toBe('available');
      // stderr and stdout are independent pipes; wait for the final stage observation.
      const deadline = Date.now() + 1000;
      while (timings.at(-1)?.stage !== 'http' || timings.at(-1)?.status !== 'completed') {
        if (Date.now() > deadline) throw Error('timing_observation_timeout');
        await sleepTimer(5);
      }
      expect(timings.map(({ stage, status }) => `${stage}:${status}`)).toEqual(
        ['shell_runtime', 'configuration', 'store', 'runtime', 'http'].flatMap((stage) => [
          `${stage}:started`,
          `${stage}:completed`,
        ]),
      );
      expect(timings.every((timing) => Number.isSafeInteger(timing.durationMs))).toBe(true);
      expect(JSON.stringify(timings)).not.toContain(root);
      expect(JSON.stringify(timings)).not.toContain(service.bootstrap.token);
    } finally {
      await service.close();
    }
    expect(await service.exited).toBe(0);
    const quietTimings: ServiceStartupTiming[] = [];
    const ordinary = await launchPairedService({
      entrypoint: join(repository, 'apps/service/src/main.ts'),
      profile: selectProfile({ dataRoot: join(root, 'data'), profile: 'development' }),
      instanceId: 'ordinary',
      buildId: 'ordinary',
      apiMajor: 1,
      requiredCapabilities: ['file_recovery'],
      spawnChild: user.spawnChild,
      onStartupTiming: (timing) => quietTimings.push(timing),
    });
    await ordinary.close();
    expect(await ordinary.exited).toBe(0);
    expect(ordinary.diagnostics).toEqual([]);
    expect(quietTimings).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('fragmented timing lines survive noisy private stderr; timeout still closes the original owned child', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-startup-fragments-')));
  const timings: ServiceStartupTiming[] = [];
  const encoder = new TextEncoder();
  const valid = JSON.stringify({
    code: 'service_startup_timing',
    stage: 'shell_runtime',
    status: 'started',
    durationMs: 0,
  });
  let ended = false;
  let killed = false;
  let finish!: (code: number) => void;
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  try {
    await expect(
      launchPairedService({
        entrypoint: join(root, 'unused.js'),
        profile: selectProfile({ dataRoot: join(root, 'data'), profile: 'development' }),
        instanceId: 'timing',
        buildId: 'timing',
        apiMajor: 1,
        requiredCapabilities: [],
        startupTimeoutMs: 20,
        onStartupTiming(timing) {
          timings.push(timing);
        },
        spawnChild() {
          return {
            pid: 1,
            stdout: new ReadableStream({
              start: (controller) => {
                stdout = controller;
              },
            }),
            stderr: new ReadableStream({
              start(controller) {
                stderr = controller;
                for (const text of [
                  'private-token-and-path\n',
                  valid.slice(0, 13),
                  `${valid.slice(13)}\n`,
                  `${'x'.repeat(20000)}\n`,
                  `${valid.slice(0, -1)},"token":"private-token"}\n`,
                  `${valid.replace('shell_runtime', 'private_stage')}\n`,
                  `${valid.replace(':0', ':-1')}\n`,
                  valid.replace('started', 'completed').slice(0, 23),
                  `${valid.replace('started', 'completed').slice(23)}\n`,
                ])
                  controller.enqueue(encoder.encode(text));
              },
            }),
            exited: new Promise<number>((resolve) => {
              finish = resolve;
            }),
            stdin: {
              write() {},
              flush() {},
              end() {
                ended = true;
                stdout.close();
                stderr.close();
                finish(0);
              },
            },
            kill() {
              killed = true;
            },
          };
        },
      }),
    ).rejects.toMatchObject({ code: 'startup_timeout' });
    expect(timings.map(({ status }) => status)).toEqual(['started', 'completed']);
    expect(JSON.stringify(timings)).not.toContain('private');
    expect(ended).toBe(true);
    expect(killed).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
