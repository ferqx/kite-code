import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JobContext, JobStartError } from '../../../src/extensions';
import { launchIdentity, removeRuntimeTemp } from '../../../src/jobs/launch-identity';
import {
  prepareShellOutputCollection,
  ShellOutputPreparationCleanupError,
} from '../../../src/jobs/output-collection';

test('durable registration is awaited and transfers cleanup despite cancellation', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kite-output-preparation-'));
  const controller = new AbortController();
  const context = { signal: controller.signal, executionId: 'producer' } as JobContext;
  const runtimeTemp = launchIdentity(temp);
  let cleaned = false;
  try {
    const result = await prepareShellOutputCollection(
      {
        async prepare(received, identity) {
          expect(received).toBe(context);
          expect(identity).toBe(runtimeTemp);
          await Promise.resolve();
          mkdirSync(join(temp, 'out'));
          writeFileSync(join(temp, 'out', 'report.pdf'), 'file');
          controller.abort();
          return { env: { KITE_OUTPUT_DIR: join(temp, 'out') }, cleanupTransferred: true };
        },
      },
      context,
      {
        runtimeTemp,
        cleanup() {
          cleaned = true;
          removeRuntimeTemp(runtimeTemp);
        },
      },
    );
    expect(result.cleanupTransferred).toBe(true);
    expect(result.env.KITE_OUTPUT_DIR).toBe(join(temp, 'out'));
    expect(cleaned).toBe(false);
    expect(existsSync(join(temp, 'out', 'report.pdf'))).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('failed allocation cleans the original directory before a known unstarted failure', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kite-output-preparation-'));
  const runtimeTemp = launchIdentity(temp);
  try {
    await expect(
      prepareShellOutputCollection(
        {
          async prepare() {
            throw Error('registration');
          },
        },
        { signal: new AbortController().signal } as JobContext,
        {
          runtimeTemp,
          cleanup() {
            removeRuntimeTemp(runtimeTemp);
          },
        },
      ),
    ).rejects.toBeInstanceOf(JobStartError);
    expect(existsSync(temp)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('cleanup uncertainty is not reported as a known unstarted failure', async () => {
  await expect(
    prepareShellOutputCollection(
      {
        async prepare() {
          throw Error('registration');
        },
      },
      { signal: new AbortController().signal } as JobContext,
      {
        runtimeTemp: {} as ReturnType<typeof launchIdentity>,
        cleanup() {
          throw Error('cleanup');
        },
      },
    ),
  ).rejects.toBeInstanceOf(ShellOutputPreparationCleanupError);
});
