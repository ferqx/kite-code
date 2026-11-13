import * as processes from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { expect, mock, test } from '#kite-test';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { imageInputBytes } from '../../../src/tools/images/format';

const actual = { ...processes };
let fault: 'start' | 'stdin' | 'unconfirmed' | undefined;
let starts = 0,
  kills = 0,
  closed = false;
mock.module('node:child_process', () => ({
  ...actual,
  spawn(...args: Parameters<typeof processes.spawn>) {
    starts++;
    const selected = fault;
    fault = undefined;
    if (!selected) return actual.spawn(...args);
    const child = new EventEmitter();
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    const stdin =
      selected === 'stdin'
        ? new Writable({
            write(_chunk, _encoding, callback) {
              callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
            },
          })
        : new PassThrough();
    Object.assign(child, {
      pid: selected === 'start' ? undefined : 12345,
      stdin,
      stdout,
      stderr,
      kill() {
        kills++;
        return true;
      },
    });
    queueMicrotask(() => {
      if (selected !== 'stdin')
        child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
      // The fixture owns no OS process. Delay its close proof independently of the operation error.
      setTimeout(() => {
        stdout.end();
        stderr.end();
        if (selected === 'unconfirmed') return;
        closed = true;
        child.emit('close', 1, null);
      }, 20);
    });
    return child as ReturnType<typeof processes.spawn>;
  },
}));
const { createImageProcessor } = await import('../../../src/tools/images/processor');
const posix = process.platform === 'win32' ? test.skip : test;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSOcAAAAASUVORK5CYII=',
  'base64',
);
function fixture() {
  const root = temporaryDirectory('kite-image-posix-'),
    child = join(root, 'child.js'),
    checksum = join(root, 'child.sha256');
  const assets = () => ({ child, checksum, dependencies: [] });
  function program(code: string) {
    writeFileSync(child, code);
    writeFileSync(checksum, createHash('sha256').update(code).digest('hex'));
  }
  function valid() {
    program(`
      for await (const chunk of process.stdin) {}
      const png = Buffer.from('${png.toString('base64')}', 'base64');
      const metadata = Buffer.from(JSON.stringify({mediaType:'image/png',size:png.length,width:1,height:1}));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(metadata.length);
      process.stdout.end(Buffer.concat([header,metadata,png]));
    `);
  }
  valid();
  return { root, program, valid, processImage: createImageProcessor({ assets }) };
}
const signal = () => new AbortController().signal;

posix(
  'failed POSIX spawn without a PID waits for close and releases queued and future reads',
  async () => {
    const setup = fixture();
    starts = 0;
    kills = 0;
    closed = false;
    fault = 'start';
    let reads = 0;
    try {
      const first = setup.processImage(async () => {
        reads++;
        return { bytes: png };
      }, signal());
      void first.catch(() => {});
      const queued = setup.processImage(async () => {
        expect(closed).toBe(true);
        reads++;
        return { bytes: png };
      }, signal());
      void queued.catch(() => {});
      await expect(first).rejects.toMatchObject({ code: 'EAGAIN' });
      expect((await queued).png).toEqual(png);
      expect(reads).toBe(2);
      expect(starts).toBe(2);
      expect(kills).toBe(0);
      expect((await setup.processImage(async () => ({ bytes: png }), signal())).png).toEqual(png);
    } finally {
      removeTemporaryDirectory(setup.root);
    }
  },
);

posix(
  'stdin end callback failure keeps an error handler until its deferred error and close',
  async () => {
    const setup = fixture();
    fault = 'stdin';
    try {
      await expect(
        setup.processImage(async () => ({ bytes: png }), signal()),
      ).rejects.toMatchObject({
        code: 'EPIPE',
      });
      expect((await setup.processImage(async () => ({ bytes: png }), signal())).png).toEqual(png);
    } finally {
      removeTemporaryDirectory(setup.root);
    }
  },
);

posix(
  'real early child exit while writing a full input does not crash or fence later processing',
  async () => {
    const setup = fixture();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        setup.program('process.exit(1);');
        let failure: unknown;
        try {
          await setup.processImage(
            async () => ({ bytes: new Uint8Array(imageInputBytes) }),
            signal(),
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toMatchObject({ code: 'image_process_exit_unconfirmed' });
        setup.valid();
        expect((await setup.processImage(async () => ({ bytes: png }), signal())).png).toEqual(png);
      }
    } finally {
      removeTemporaryDirectory(setup.root);
    }
  },
);

posix(
  'overflowing stdout or stderr closes the pipe before awaiting exit and permits recovery',
  async () => {
    const setup = fixture();
    try {
      for (const stream of ['stdout', 'stderr']) {
        setup.program(`
        for await (const chunk of process.stdin) {}
        process.${stream}.write(new Uint8Array(9 * 1024 * 1024));
      `);
        await expect(
          setup.processImage(async () => ({ bytes: png }), signal()),
        ).rejects.toMatchObject({
          code: 'image_process_output_invalid',
        });
        setup.valid();
        expect((await setup.processImage(async () => ({ bytes: png }), signal())).png).toEqual(png);
      }
    } finally {
      removeTemporaryDirectory(setup.root);
    }
  },
  7000,
);

posix(
  'missing POSIX close proof still fences queued and future reads',
  async () => {
    const setup = fixture();
    fault = 'unconfirmed';
    starts = 0;
    let reads = 0;
    const source = async () => {
      reads++;
      return { bytes: png };
    };
    try {
      const first = setup.processImage(source, signal());
      void first.catch(() => {});
      const queued = setup.processImage(source, signal());
      void queued.catch(() => {});
      await expect(first).rejects.toMatchObject({ code: 'image_process_exit_unconfirmed' });
      await expect(queued).rejects.toMatchObject({ code: 'image_process_exit_unconfirmed' });
      await expect(setup.processImage(source, signal())).rejects.toMatchObject({
        code: 'image_process_exit_unconfirmed',
      });
      expect(reads).toBe(1);
      expect(starts).toBe(1);
    } finally {
      removeTemporaryDirectory(setup.root);
    }
  },
  7000,
);
