import { join } from 'node:path';
import { classifyBuiltinShellIntent } from '@kite-ai/builtin-runtime';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import { createKiteCliRuntimeAccess } from '../../src/bootstrap';
import { APP_PREPARED_SHELL_EXECUTION_ } from '../../src/sandbox/prepared-tool-pipeline';

const workspace = required('KITE_RESTART_TEST_WORKSPACE');
const checkpointPath = required('KITE_RESTART_TEST_CHECKPOINT');
const sessionId = required('KITE_RESTART_TEST_SESSION');
const baseURL = required('KITE_RESTART_TEST_MODEL_URL');
const shellExecutor = async ({ command }: { readonly command: string }) => ({
  ok: true,
  command,
  exitCode: 0,
  stdout: 'child shell completed',
  stderr: '',
});
Object.defineProperty(shellExecutor, APP_PREPARED_SHELL_EXECUTION_, {
  enumerable: false,
  value: Object.freeze({
    execute: async (prepared: { readonly command: string }) =>
      Object.freeze({
        ok: true,
        command: prepared.command,
        exitCode: 0,
        stdout: 'child shell completed',
        stderr: '',
        intent: classifyBuiltinShellIntent(prepared.command),
        executionPhase: 'go_started' as const,
      }),
  }),
});

const access = createKiteCliRuntimeAccess({
  sessionId,
  userId: 'restart-approval-user',
  workspace,
  checkpointPath,
  config: {
    providerName: 'restart-approval-model',
    providerType: 'openai-compatible',
    apiKey: 'restart-approval-key',
    baseURL,
    modelName: 'mock-model',
    sandbox: { enabled: false },
  },
  shellExecutor,
  interactionMode: 'accept_edits',
  sandboxBackend: 'seatbelt',
  skillOptions: {
    userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
    userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
  },
  initialSkillActivations: [],
});

await access.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  commandId: 'restart-approval-create',
  type: 'create_session',
  workspace,
  bootstrapSessionId: sessionId,
});
await access.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  commandId: 'restart-approval-start',
  type: 'start_turn',
  sessionId,
  expectedRevision: 0,
  input: 'Run the approval-gated command once.',
});

for (let attempt = 0; attempt < 500; attempt += 1) {
  const result = await access.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'get_session_projection',
    sessionId,
  });
  const interaction =
    result.status === 'ok'
      ? result.session?.interactionQueue.interactions.find(
          (candidate) => candidate.kind === 'approval',
        )
      : undefined;
  if (interaction?.kind === 'approval') {
    process.stdout.write(`${JSON.stringify(interaction)}\n`);
    await new Promise<never>(() => setInterval(() => undefined, 60_000));
  }
  await Bun.sleep(10);
}

throw new Error('Pending approval was not persisted before the child deadline.');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
