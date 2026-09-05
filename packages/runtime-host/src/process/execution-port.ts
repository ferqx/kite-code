import { fileURLToPath } from 'node:url';
import { readRuntimeHostProcessOutput } from './output';
import { guardProcessTree, processTreeSpawnOptions } from './process-tree';
import { spawnRuntimeHostProcess } from './spawn';

export interface RuntimeHostProcessTermination {
  readonly confirmedExited: boolean;
  readonly gracefulRequested: boolean;
  readonly forced: boolean;
  readonly unconfirmedProcessCount: number;
}

export interface RuntimeHostProcessTree {
  terminate(): Promise<RuntimeHostProcessTermination>;
  dispose(): void;
}

export interface RuntimeHostProcessHandle {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly processTree: RuntimeHostProcessTree;
}

/** Generic process mechanism for a domain package to compose. */
export interface RuntimeHostProcessExecutionPort {
  spawn(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
  }): RuntimeHostProcessHandle;
  readOutput(
    stream: ReadableStream<Uint8Array>,
    onLine?: (line: string) => void,
    stopSignal?: AbortSignal,
  ): Promise<string>;
}

/**
 * Compose generic spawn, bounded output, and process-tree cleanup. This port
 * has no Shell/command/policy knowledge; Builtin supplies those semantics.
 */
export function createRuntimeHostProcessExecutionPort(): RuntimeHostProcessExecutionPort {
  return {
    spawn(input) {
      const process =
        globalThis.process.platform === 'win32'
          ? spawnRuntimeHostProcess([...input.argv], {
              cwd: input.cwd,
              stdout: 'pipe',
              stderr: 'pipe',
              ...(input.env ? { env: { ...input.env } } : {}),
            })
          : spawnWatchedPosixProcess(input);
      const processTree = guardProcessTree(process);
      return {
        stdout: process.stdout as ReadableStream<Uint8Array>,
        stderr: process.stderr as ReadableStream<Uint8Array>,
        exited: process.exited,
        processTree: {
          async terminate() {
            const result = await processTree.terminate();
            return {
              confirmedExited: result.confirmedExited,
              gracefulRequested: result.gracefulRequested,
              forced: result.forced,
              unconfirmedProcessCount: result.unconfirmedPids.length,
            };
          },
          dispose() {
            processTree.dispose();
          },
        },
      };
    },
    readOutput: readRuntimeHostProcessOutput,
  };
}

function spawnWatchedPosixProcess(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}) {
  const childPath = fileURLToPath(new URL('./process-tree-child.ts', import.meta.url));
  const command =
    process.env.KITE_STANDALONE_EXECUTABLE === '1'
      ? [process.execPath, '--kite-internal-process-tree-v1']
      : [process.execPath, childPath];
  const watched = spawnRuntimeHostProcess(command, {
    cwd: input.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(process.env.KITE_STANDALONE_EXECUTABLE === '1'
        ? { KITE_STANDALONE_EXECUTABLE: '1' }
        : {}),
    },
    ...processTreeSpawnOptions(),
  });
  const request = Buffer.from(
    `${JSON.stringify({ argv: [...input.argv], cwd: input.cwd, env: input.env ?? null })}\n`,
  );
  watched.stdin.write(request);
  request.fill(0);
  void Promise.resolve(watched.stdin.flush()).catch(() => {
    try {
      watched.kill('SIGKILL');
    } catch {
      // The watchdog already failed closed.
    }
  });
  return watched;
}
