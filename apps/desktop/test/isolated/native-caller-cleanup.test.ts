import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { expect, test } from '#kite-test';
import {
  which as findFixtureExecutable,
  type Subprocess,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { cleanupNativeCaller } from '../native-caller-cleanup.fixture';
import { openNativeShellObservation } from '../native-shell-observation.fixture';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'parent cleans the original Electron and Service after driver SIGKILL without signalling another instance or an unreadable identity',
  async () => {
    const root = realpathSync(temporaryDirectory('kite-native-caller-cleanup-'));
    const observation = openNativeShellObservation();
    const electronExecutable = require('electron') as string;
    const instances: {
      root: string;
      driver: Subprocess;
      pid?: number;
      servicePid?: number;
      serviceEntrypoint: string;
    }[] = [];
    const create = async (name: string) => {
      const owned = join(root, name),
        app = join(owned, 'native'),
        serviceEntrypoint = join(owned, 'service.js');
      mkdirSync(app, { recursive: true });
      writeFileSync(serviceEntrypoint, 'setInterval(() => {}, 1000);');
      writeFileSync(join(app, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
      writeFileSync(
        join(app, 'main.cjs'),
        `const {app,BrowserWindow}=require('electron'); const {spawn}=require('node:child_process'); const fs=require('node:fs'); app.whenReady().then(()=>{const window=new BrowserWindow({show:false}); window.loadURL('data:text/html,cleanup'); const service=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(serviceEntrypoint)}],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(join(owned, 'ready.json'))},JSON.stringify({pid:process.pid,servicePid:service.pid}));});`,
      );
      const script = join(owned, 'driver.cjs');
      writeFileSync(
        script,
        `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(${JSON.stringify(electronExecutable)},[${JSON.stringify(app)},${JSON.stringify(`--user-data-dir=${join(owned, 'caller-electron-data')}`)}],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(`${owned}-native-caller-window-fault.pid.json`)},JSON.stringify({pid:child.pid})); setInterval(()=>{},1000);`,
      );
      const driver = spawnFixtureProcess([realpathSync(findFixtureExecutable('node')!), script], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const instance = { root: owned, driver, serviceEntrypoint };
      instances.push(instance);
      const deadline = Date.now() + 10000;
      while (!existsSync(join(owned, 'ready.json'))) {
        if (Date.now() >= deadline) throw Error('cleanup_fault_window_not_ready');
        await fixtureDelay(20);
      }
      const ready = JSON.parse(readFileSync(join(owned, 'ready.json'), 'utf8')) as {
        pid: number;
        servicePid: number;
      };
      return Object.assign(instance, ready);
    };
    const input = (instance: (typeof instances)[number]) => ({
      root: instance.root,
      kind: 'fault',
      electronExecutable,
      serviceExecutable: process.execPath,
      serviceEntrypoint: instance.serviceEntrypoint,
      observation,
    });
    let completed = false;
    const failures: unknown[] = [];
    try {
      const original = await create('original'),
        other = await create('other');
      const main = observation.observe(original.pid)!,
        service = observation.observe(original.servicePid)!,
        foreign = observation.observe(other.pid)!,
        foreignService = observation.observe(other.servicePid)!;
      expect(main).toBeDefined();
      expect(service).toBeDefined();
      expect(foreign).toBeDefined();
      expect(foreignService).toBeDefined();
      original.driver.kill('SIGKILL');
      await original.driver.exited;
      expect(observation.present(main)).toBe(true);
      expect(observation.present(service)).toBe(true);
      await cleanupNativeCaller(input(original));
      expect(observation.present(main)).toBe(false);
      expect(observation.present(service)).toBe(false);
      expect(observation.present(foreign)).toBe(true);
      expect(observation.present(foreignService)).toBe(true);
      const actual = JSON.parse(
        readFileSync(`${original.root}-native-caller-window-fault.cleanup.json`, 'utf8'),
      );
      expect(actual.confirmed).toBe(true);
      expect(actual.observed.map((item: { pid: number }) => item.pid)).toContain(original.pid);
      expect(actual.observed.map((item: { pid: number }) => item.pid)).toContain(
        original.servicePid,
      );
      expect(
        actual.signals.every(
          (item: { pid: number }) => item.pid !== other.pid && item.pid !== other.servicePid,
        ),
      ).toBe(true);
      let signals = 0;
      await expect(
        cleanupNativeCaller({
          ...input(other),
          observation: {
            ...observation,
            observe: (pid) => (pid === other.pid ? undefined : observation.observe(pid)),
            signal() {
              signals++;
            },
          },
        }),
      ).rejects.toThrow('native_caller_cleanup_identity_unconfirmed');
      expect(signals).toBe(0);
      expect(observation.present(foreign)).toBe(true);
      expect(observation.present(foreignService)).toBe(true);
      const failure = JSON.parse(
        readFileSync(`${other.root}-native-caller-window-fault.cleanup.json`, 'utf8'),
      );
      expect(failure.confirmed).toBe(false);
      expect(failure.unconfirmed).toContain(other.pid);
      other.driver.kill('SIGKILL');
      await other.driver.exited;
      await cleanupNativeCaller(input(other));
      expect(observation.present(foreign)).toBe(false);
      expect(observation.present(foreignService)).toBe(false);
      completed = true;
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        for (const instance of instances) {
          try {
            if (instance.driver.exitCode === null) {
              instance.driver.kill('SIGKILL');
              await instance.driver.exited;
            }
          } catch (error) {
            failures.push(error);
          }
          try {
            await cleanupNativeCaller(input(instance));
          } catch (error) {
            failures.push(error);
          }
        }
      } finally {
        observation.close();
      }
      if (completed && !failures.length) rmSync(root, { recursive: true, force: true });
      else console.error('native_caller_cleanup_failure_retained', root);
    }
    if (failures.length) throw new AggregateError(failures, 'native_caller_fault_cleanup_failed');
  },
  30000,
);

for (const drift of ['arguments', 'parent'] as const)
  test.skipIf(process.platform !== 'darwin')(
    `parent cleanup refuses a changed ${drift} identity before any signal`,
    async () => {
      const root = realpathSync(temporaryDirectory('kite-native-caller-cleanup-drift-'));
      const electronExecutable = require('electron') as string;
      const main = {
        pid: 123456,
        parent: 1,
        command: `${electronExecutable} ${root}/native --user-data-dir=${root}/caller-electron-data`,
      };
      const child = { pid: 123457, parent: main.pid, command: '/bin/sleep 30' };
      const identity = {
        ...main,
        executable: realpathSync(electronExecutable),
        unique: 'new-incarnation',
        version: 4,
        coalition: 'owned',
        processGroup: main.pid,
      };
      let reads = 0,
        parentReads = 0,
        signals = 0;
      writeFileSync(
        `${root}-native-caller-window-fault.pid.json`,
        JSON.stringify({ pid: main.pid }),
      );
      const evidence = `${root}-native-caller-window-fault.cleanup.json`;
      try {
        await expect(
          cleanupNativeCaller(
            {
              root,
              kind: 'fault',
              electronExecutable,
              serviceExecutable: process.execPath,
              serviceEntrypoint: join(root, 'service.js'),
              observation: {
                observe: (pid) =>
                  pid === main.pid
                    ? identity
                    : { ...identity, pid: child.pid, parent: main.pid, executable: '/bin/sleep' },
                present: (value) =>
                  value.pid !== main.pid || drift === 'arguments' || ++parentReads === 1,
                signal() {
                  signals++;
                },
              },
            },
            () => {
              reads++;
              return drift === 'arguments' && reads > 1
                ? [
                    {
                      ...main,
                      command: `${electronExecutable} /another/native --user-data-dir=/another/caller-electron-data`,
                    },
                  ]
                : [main, child];
            },
          ),
        ).rejects.toThrow('native_caller_cleanup_identity_unconfirmed');
        expect(signals).toBe(0);
        const report = JSON.parse(readFileSync(evidence, 'utf8'));
        expect(report.confirmed).toBe(false);
        expect(report.unconfirmed).toContain(drift === 'arguments' ? main.pid : child.pid);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(`${root}-native-caller-window-fault.pid.json`, { force: true });
        rmSync(evidence, { force: true });
      }
    },
  );
