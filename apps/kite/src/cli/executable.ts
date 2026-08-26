import packageJson from '../../package.json' with { type: 'json' };
import {
  createKiteCliRuntimeAccess,
  createKiteCliRuntimeServer,
  prepareKiteRuntimeSessionResume,
} from '../bootstrap';
import { runKiteInternalMcpStdioChild } from '../bootstrap/mcp-stdio-composition';
import {
  createNodeRuntimeStdioOutput,
  createProcessRuntimeStdioSignals,
  createRuntimeStdioCarrier,
} from '../carrier/runtime-server-stdio';
import { createRuntimeCommandIdAllocator } from '../runtime-client/command-id';
import { main } from './index';

export async function runCli(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`Kite Code ${packageJson.version}`);
    return;
  }
  await main({
    prepareRuntimeSessionResume: prepareKiteRuntimeSessionResume,
    createRuntimeAccess: createKiteCliRuntimeAccess,
    runRuntimeServerStdio: async (input) => {
      const owner = createKiteCliRuntimeServer(input);
      let settle!: () => void;
      let reject!: (error: unknown) => void;
      const ownerShutdown = new Promise<void>((resolve, rejectPromise) => {
        settle = resolve;
        reject = rejectPromise;
      });
      let ownerLifecycleLease: ReturnType<typeof setInterval> | undefined;
      try {
        createRuntimeStdioCarrier({
          server: owner.server,
          stdin: process.stdin,
          stdout: createNodeRuntimeStdioOutput(process.stdout),
          stderr: process.stderr,
          signals: createProcessRuntimeStdioSignals(process),
          shutdownComposition: async () => {
            try {
              await owner[Symbol.asyncDispose]();
              settle();
            } catch (error) {
              reject(error);
              throw error;
            }
          },
        });
        // Bun does not keep the process alive for an unresolved Promise or
        // signal listener. The parent-owned child therefore needs one App
        // lifecycle lease so stdin EOF remains connection-local; only an
        // owner signal can release the composition and this lease.
        ownerLifecycleLease = setInterval(() => undefined, 60_000);
        await ownerShutdown;
      } catch (error) {
        await owner[Symbol.asyncDispose]();
        throw error;
      } finally {
        if (ownerLifecycleLease !== undefined) clearInterval(ownerLifecycleLease);
      }
    },
    commandIds: createRuntimeCommandIdAllocator(),
  });
}

if (import.meta.main) {
  if (!runKiteInternalMcpStdioChild()) {
    runCli().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
