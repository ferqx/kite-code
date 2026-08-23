import { readRuntimeHostProcessOutput } from './process-output';
import { spawnRuntimeHostProcess } from './process-spawn';
import { guardProcessTree, processTreeSpawnOptions } from './process-tree';

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
      const process = spawnRuntimeHostProcess([...input.argv], {
        cwd: input.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        ...(input.env ? { env: { ...input.env } } : {}),
        ...processTreeSpawnOptions(),
      });
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
