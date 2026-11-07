import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processEventFailure, processStartFailure } from './errors';
import type { GitResult } from './git';
import {
  canonicalDirectory,
  identity,
  inspectPath,
  type PathIdentity,
  sameIdentity,
} from './paths';
import { limits } from './protocol';

/** Bun's Windows pipe creation fails under the host's write-restricted token.
 * Inherited ordinary file handles keep the original token and Job unchanged.
 */
export async function runWindowsGitProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    inputFd?: number;
    outputHash?: { algorithm: 'sha1' | 'sha256'; prefix: string; bytes: bigint };
    signal?: AbortSignal;
  },
): Promise<GitResult> {
  options.signal?.throwIfAborted();
  const root = mkdtempSync(join(canonicalDirectory(tmpdir()), 'kite-worktree-git-'));
  const rootIdentity = identity(root);
  const files: { path: string; identity: PathIdentity }[] = [];
  const descriptors: number[] = [];
  let result: GitResult | undefined;
  let failure: unknown;
  const create = (name: string, input?: string) => {
    const path = join(root, name);
    writeFileSync(path, input ?? '', { flag: 'wx', mode: 0o600 });
    const initial = identity(path);
    files.push({ path, identity: initial });
    inspectPath(path, false);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    descriptors.push(fd);
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev.toString() !== initial.dev ||
      opened.ino.toString() !== initial.ino ||
      opened.birthtimeNs.toString() !== initial.birthtimeNs
    )
      throw Error('worktree_output_scope_changed');
    return { path, fd, initial };
  };
  try {
    const input = options.inputFd ?? create('stdin', options.input).fd;
    const output = create('stdout');
    const error = create('stderr');
    const outputWriter = openSync(output.path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    descriptors.push(outputWriter);
    const errorWriter = openSync(error.path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    descriptors.push(errorWriter);
    for (const [writer, stream] of [
      [outputWriter, output],
      [errorWriter, error],
    ] as const) {
      const opened = fstatSync(writer, { bigint: true });
      if (
        !opened.isFile() ||
        opened.dev.toString() !== stream.initial.dev ||
        opened.ino.toString() !== stream.initial.ino ||
        opened.birthtimeNs.toString() !== stream.initial.birthtimeNs
      )
        throw Error('worktree_output_scope_changed');
    }
    const hash = options.outputHash
      ? createHash(options.outputHash.algorithm).update(options.outputHash.prefix)
      : undefined;
    const streams = [
      {
        ...output,
        bytes: 0n,
        chunks: [] as Buffer[],
        limit: options.outputHash?.bytes ?? BigInt(limits.gitStdoutBytes),
        hash,
      },
      {
        ...error,
        bytes: 0n,
        chunks: [] as Buffer[],
        limit: BigInt(limits.gitStderrBytes),
        hash: undefined,
      },
    ];
    const scratch = Buffer.allocUnsafe(64 * 1024);
    const drain = (final = false) => {
      for (const stream of streams) {
        const before = fstatSync(stream.fd, { bigint: true });
        if (!before.isFile() || before.size > stream.limit || before.size < stream.bytes)
          throw Error('inspection_limit');
        const upper = before.size;
        while (stream.bytes < upper) {
          const count = readSync(
            stream.fd,
            scratch,
            0,
            Number(
              upper - stream.bytes > BigInt(scratch.length)
                ? BigInt(scratch.length)
                : upper - stream.bytes,
            ),
            Number(stream.bytes),
          );
          if (!count) throw Error('worktree_output_incomplete');
          const bytes = scratch.subarray(0, count);
          if (stream.hash) stream.hash.update(bytes);
          else stream.chunks.push(Buffer.from(bytes));
          stream.bytes += BigInt(count);
        }
        if (final) {
          const eof = readSync(stream.fd, scratch, 0, 1, Number(stream.bytes));
          const after = fstatSync(stream.fd, { bigint: true });
          const current = lstatSync(stream.path, { bigint: true });
          if (
            eof ||
            !after.isFile() ||
            !current.isFile() ||
            (['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs'] as const).some(
              (field) => before[field] !== after[field] || before[field] !== current[field],
            )
          )
            throw Error('worktree_output_incomplete');
        }
      }
    };
    const exitCode = await new Promise<number>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, [...args], {
          cwd: options.cwd,
          env: options.env,
          detached: false,
          stdio: [input, outputWriter, errorWriter],
          windowsHide: true,
        });
      } catch (error) {
        reject(processStartFailure(error));
        return;
      }
      let failure: unknown;
      const abort = () => {
        failure ??= options.signal?.reason ?? new Error('worktree_inspection_cancelled');
        child.kill('SIGKILL');
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setInterval(() => {
        if (failure) return;
        try {
          drain();
        } catch (error) {
          failure = error;
          child.kill();
        }
      }, 5);
      child.on('error', (error) => {
        failure ??= processEventFailure(error, child.pid !== undefined);
      });
      child.on('close', (code) => {
        options.signal?.removeEventListener('abort', abort);
        clearInterval(timer);
        try {
          if (!failure) drain(true);
        } catch (error) {
          failure = error;
        }
        if (failure) reject(failure);
        else resolve(code ?? -1);
      });
    });
    result = {
      exitCode,
      stdout: Buffer.concat(streams[0]!.chunks),
      stderr: Buffer.concat(streams[1]!.chunks),
      ...(hash && options.outputHash && streams[0]!.bytes === options.outputHash.bytes
        ? { stdoutHash: hash.digest('hex') }
        : {}),
    };
  } catch (error) {
    failure = error;
  }
  const failures: unknown[] = [];
  for (const fd of descriptors.reverse())
    try {
      closeSync(fd);
    } catch (error) {
      failures.push(error);
    }
  try {
    inspectPath(root, true);
    if (!sameIdentity(rootIdentity, identity(root), false))
      failures.push(Error('worktree_output_scope_changed'));
  } catch (error) {
    failures.push(error);
  }
  if (!failures.length) {
    for (const file of files)
      try {
        inspectPath(file.path, false);
        if (!sameIdentity(file.identity, identity(file.path), false))
          throw Error('worktree_output_scope_changed');
        unlinkSync(file.path);
      } catch (error) {
        failures.push(error);
      }
    if (!failures.length)
      try {
        rmdirSync(root);
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...failures],
      'worktree_output_cleanup_unconfirmed',
    );
  if (failure) throw failure;
  return result!;
}
