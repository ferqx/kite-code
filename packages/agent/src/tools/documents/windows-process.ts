import { spawn } from 'node:child_process';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWindowsPathSecurity } from '../../platform/windows-path-security';
import type { OfficeProcessResult } from './office-runtime';

const limit = 2 * 1024 * 1024;
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

/** Inherit ordinary files, not new Bun pipes, under the original Shell token and Job. */
export async function runWindowsOfficeProcess(
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
): Promise<OfficeProcessResult> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120000
  )
    throw Error('office_timeout_invalid');
  options.signal?.throwIfAborted();
  const security = defaultWindowsPathSecurity();
  const parent = tmpdir();
  security?.verifyPath(parent);
  security?.verifyScopeDirectory(parent);
  const parentIdentity = lstatSync(parent, { bigint: true });
  if (
    !parentIdentity.isDirectory() ||
    parentIdentity.isSymbolicLink() ||
    realpathSync(parent).toLowerCase() !== parent.toLowerCase()
  )
    throw Error('office_process_scope_changed');
  const root = mkdtempSync(join(parent, 'kite-office-process-'));
  const rootIdentity = lstatSync(root, { bigint: true });
  const descriptors: number[] = [];
  const files: { path: string; initial: BigIntStats }[] = [];
  let result: OfficeProcessResult | undefined;
  let failure: unknown;
  let exitUnknown = false;
  const verifyRoot = () => {
    security?.verifyPath(root);
    security?.verifyScopeDirectory(root);
    const current = lstatSync(root, { bigint: true });
    if (
      !current.isDirectory() ||
      !same(current, rootIdentity) ||
      !same(lstatSync(parent, { bigint: true }), parentIdentity)
    )
      throw Error('office_process_scope_changed');
  };
  const verifyFile = (file: { path: string; initial: BigIntStats }, fd?: number) => {
    verifyRoot();
    security?.verifyPath(file.path);
    const current = lstatSync(file.path, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      !same(current, file.initial)
    )
      throw Error('office_process_scope_changed');
    if (fd !== undefined) {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !same(opened, file.initial))
        throw Error('office_process_scope_changed');
    }
    return current;
  };
  const create = (name: string) => {
    verifyRoot();
    const path = join(root, name);
    const writer = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    descriptors.push(writer);
    const file = { path, initial: fstatSync(writer, { bigint: true }) };
    files.push(file);
    verifyFile(file, writer);
    const reader = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    descriptors.push(reader);
    verifyFile(file, reader);
    return { ...file, writer, reader, bytes: 0, chunks: [] as Buffer[] };
  };
  try {
    const input = create('stdin'),
      output = create('stdout'),
      error = create('stderr');
    const streams = [output, error];
    const scratch = Buffer.allocUnsafe(64 * 1024);
    const drain = (final = false) => {
      for (const stream of streams) {
        verifyFile(stream, stream.writer);
        verifyFile(stream, stream.reader);
        const before = fstatSync(stream.reader, { bigint: true });
        if (before.size > BigInt(limit)) throw Error('office_diagnostic_limit');
        if (before.size < BigInt(stream.bytes)) throw Error('office_process_output_incomplete');
        const upper = Number(before.size);
        while (stream.bytes < upper) {
          const count = readSync(
            stream.reader,
            scratch,
            0,
            Math.min(scratch.length, upper - stream.bytes),
            stream.bytes,
          );
          if (!count) throw Error('office_process_output_incomplete');
          stream.chunks.push(Buffer.from(scratch.subarray(0, count)));
          stream.bytes += count;
        }
        if (final) {
          const eof = readSync(stream.reader, scratch, 0, 1, stream.bytes);
          const after = fstatSync(stream.reader, { bigint: true });
          const current = verifyFile(stream, stream.reader);
          if (
            eof ||
            (['size', 'ctimeNs', 'mtimeNs'] as const).some(
              (key) => before[key] !== after[key] || before[key] !== current[key],
            )
          )
            throw Error('office_process_output_incomplete');
        }
      }
    };
    options.signal?.throwIfAborted();
    verifyFile(input, input.reader);
    const child = spawn(executable, [...args], {
      env: options.env,
      detached: false,
      stdio: [input.reader, output.writer, error.writer],
      windowsHide: true,
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      let closed = false;
      let reason: unknown;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: unknown) => {
        reason ??= error;
        if (closed || closeTimer) return;
        closeTimer = setTimeout(() => {
          exitUnknown = true;
          finish();
          reject(Error('office_process_exit_unconfirmed'));
        }, 5000);
        try {
          child.kill('SIGKILL');
        } catch {
          /* Only close proves termination. */
        }
      };
      const cancel = () => stop(options.signal?.reason ?? Error('office_cancelled'));
      const timer = setTimeout(() => stop(Error('office_timeout')), options.timeoutMs);
      const poll = setInterval(() => {
        if (!reason)
          try {
            drain();
          } catch (error) {
            stop(error);
          }
      }, 10);
      const finish = () => {
        clearTimeout(timer);
        clearInterval(poll);
        if (closeTimer) clearTimeout(closeTimer);
        options.signal?.removeEventListener('abort', cancel);
      };
      child.once('error', stop);
      child.once('close', (code) => {
        closed = true;
        finish();
        if (exitUnknown) return;
        if (reason) reject(reason);
        else resolve(code);
      });
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    options.signal?.throwIfAborted();
    if (code === null) throw Error('office_process_failed');
    drain(true);
    result = {
      code,
      stdout: Buffer.concat(output.chunks).toString('utf8'),
      stderr: Buffer.concat(error.chunks).toString('utf8'),
    };
  } catch (error) {
    failure = error;
  }
  const cleanupFailures: unknown[] = [];
  for (const fd of descriptors.reverse())
    try {
      closeSync(fd);
    } catch (error) {
      cleanupFailures.push(error);
    }
  // A child whose close is unknown may still own these files. Preserve them for the Job owner.
  if (!exitUnknown && !cleanupFailures.length) {
    try {
      verifyRoot();
      for (const file of files) {
        verifyFile(file);
        unlinkSync(file.path);
      }
      verifyRoot();
      rmdirSync(root);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (exitUnknown)
    throw new AggregateError([failure, ...cleanupFailures], 'office_process_exit_unconfirmed');
  if (cleanupFailures.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupFailures],
      'office_process_cleanup_unconfirmed',
    );
  if (failure) throw failure;
  return result!;
}
