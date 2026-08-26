import { realpathSync } from 'node:fs';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { createKiteMultiWorkspaceRuntimeServer } from '#kite-service/bootstrap';
import {
  createNodeRuntimeStdioOutput,
  createProcessRuntimeStdioSignals,
  createRuntimeStdioCarrier,
} from '#kite-service/carrier/runtime-server-stdio';
import { loadAgentConfig } from '#kite-service/config';
import { skillDirs } from '#kite-service/config/paths';

const args = process.argv.slice(2);
const value = (name: string): string => {
  const index = args.indexOf(name);
  const result = index < 0 ? undefined : args[index + 1];
  if (!result) throw new Error(`Service stdio fixture requires ${name}.`);
  return result;
};

const workspace = realpathSync.native(value('--workspace'));
const checkpointPath = value('--checkpoints');
const config = loadAgentConfig({ workspace });
const owner = createKiteMultiWorkspaceRuntimeServer({
  checkpointPath,
  workspaces: [
    {
      userId: 'runtime-transport-fixture',
      workspace,
      config,
      shellExecutor: async ({ command }) => ({
        ok: true as const,
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
      interactionMode: config.interactionMode ?? 'auto',
      sandboxBackend: 'none',
      skillOptions: skillDirs(workspace),
      initialSkillActivations: [],
    },
  ],
});
const admission: RuntimeServerAdmissionPort = Object.freeze({
  authorize: async () => ({ allowed: true as const, workspace }),
});
let settle!: () => void;
let reject!: (error: unknown) => void;
const shutdown = new Promise<void>((resolve, rejectPromise) => {
  settle = resolve;
  reject = rejectPromise;
});
let lifecycleLease: ReturnType<typeof setInterval> | undefined;

try {
  createRuntimeStdioCarrier({
    server: owner.server,
    admission,
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
  lifecycleLease = setInterval(() => undefined, 60_000);
  await shutdown;
} catch (error) {
  await owner[Symbol.asyncDispose]();
  throw error;
} finally {
  if (lifecycleLease !== undefined) clearInterval(lifecycleLease);
}
