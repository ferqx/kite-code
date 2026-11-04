import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import * as owned from '../../../src/platform/process/windows-owned-child';

const actual = { ...owned };
let starts = 0;
mock.module('../../../src/platform/process/windows-owned-child', () => ({
  ...actual,
  startWindowsOwnedChild(...args: Parameters<typeof owned.startWindowsOwnedChild>) {
    starts++;
    const child = actual.startWindowsOwnedChild(...args);
    return {
      ...child,
      exited: new Promise<number>(() => {}),
      async stop(input: Parameters<typeof child.stop>[0]) {
        const fact = await child.stop(input);
        // Physically stop/close our real synthetic child first; only its adapter proof is withheld.
        await child.close();
        return {
          ...fact,
          root: { ...fact.root, waitConfirmed: false },
          job: { ...fact.job, treeStopped: false },
        };
      },
    };
  },
}));
const { createImageProcessor } = await import('../../../src/tools/images/processor');

(process.platform === 'win32' ? test : test.skip)(
  'unconfirmed original exit settles unknown, wakes queued calls and fences further reads',
  async () => {
    const root = temporaryDirectory('kite-image-exit-proof-'),
      child = join(root, 'child.js'),
      checksum = join(root, 'child.sha256');
    const code = 'for await(const chunk of process.stdin) {} setInterval(()=>{},1000);';
    writeFileSync(child, code);
    writeFileSync(checksum, createHash('sha256').update(code).digest('hex'));
    const processImage = createImageProcessor({
      assets: () => ({ child, checksum, dependencies: [] }),
      timeoutMs: 250,
    });
    let entered!: () => void,
      reads = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const source = async () => {
      reads++;
      entered();
      return { bytes: new Uint8Array([1]) };
    };
    const signal = new AbortController().signal;
    try {
      const first = processImage(source, signal);
      void first.catch(() => {});
      await started;
      const queued = processImage(source, signal);
      void queued.catch(() => {});
      const results = await Promise.allSettled([first, queued]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected')
          expect(result.reason.code).toBe('image_process_exit_unconfirmed');
      }
      let failure: unknown;
      try {
        await processImage(source, signal);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'image_process_exit_unconfirmed' });
      expect(starts).toBe(1);
      expect(reads).toBe(1);
    } finally {
      removeTemporaryDirectory(root);
    }
  },
  6000,
);
