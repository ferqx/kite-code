import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchPairedService } from '@kite-ai/service/paired';
import {
  parseShellModelFeedback,
  shellModelFeedbackMatchesResult,
} from '../../../tests/fixtures/unified-agent/shell-model-feedback';
/** Explicit Shell selection, actual default permission controls and confined supervisor. */
export async function nativeCallerJobsProfile() {
  const module = await import(
      resolve(import.meta.dir, '../../cli/test/fixtures/recovery-profile.ts')
    ),
    f = await module.recoveryProfile();
  let calls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      calls++;
      const body = (await req.json()) as {
        messages: {
          role: string;
          content?: string;
          tool_call_id?: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        }[];
      };
      let taskIndex = -1;
      for (let index = body.messages.length - 1; index >= 0; index--) {
        const message = body.messages[index]!;
        if (
          message.role === 'user' &&
          message.content === 'New task: two explicitly configured independent jobs'
        ) {
          taskIndex = index;
          break;
        }
      }
      if (taskIndex < 0) throw Error('native_jobs_original_task_unavailable');
      const history = body.messages.slice(taskIndex + 1);
      const launched = history.flatMap((message) =>
        message.role === 'assistant' ? (message.tool_calls ?? []) : [],
      );
      const results = history.filter((message) => message.role === 'tool');
      const done = launched.length === 2 && results.length === 2;
      if (launched.length || results.length) {
        if (
          !done ||
          !['a', 'b'].every((key) => {
            const id = `native-launch-${key}`;
            const call = launched.filter((candidate) => candidate.id === id);
            const result = results.filter((candidate) => candidate.tool_call_id === id);
            if (
              call.length !== 1 ||
              result.length !== 1 ||
              call[0]!.function.name !== 'shell_execute'
            )
              return false;
            const input = JSON.parse(call[0]!.function.arguments) as { background?: boolean };
            const output = parseShellModelFeedback(result[0]!.content!);
            const originals = f.rows(
              `SELECT result_json FROM execution WHERE session_id='s' AND kind='tool' AND adapter_id='shell.execute' AND call_id='${id}'`,
            ) as { result_json: string }[];
            return (
              input.background === true &&
              output.status === 'accepted' &&
              originals.length === 1 &&
              shellModelFeedbackMatchesResult(output, JSON.parse(originals[0]!.result_json))
            );
          })
        )
          throw Error('native_jobs_original_tool_results_unavailable');
      }
      const delta = done
        ? { content: 'NATIVE_PARENT_DONE_TWO_JOBS' }
        : {
            tool_calls: ['a', 'b'].map((key, index) => ({
              index,
              id: `native-launch-${key}`,
              type: 'function',
              function: {
                name: 'shell_execute',
                arguments: JSON.stringify({
                  command: `printf 'NATIVE_JOB_${key}_中🙂\\n'; while :; do /bin/sleep 1; done`,
                  background: true,
                }),
              },
            })),
          };
      const frame = (d: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${frame(delta, null)}${frame({}, done ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    const warm = await f.launch();
    try {
      await warm.client.recoverSession('s', {
        kind: 'session.recover',
        expectedStoreId: f.storeId,
        commandId: 'before-native-jobs',
        decision: 'interrupt',
      });
      const before = await warm.client.getPermissionMode('s', { storeId: f.storeId });
      const mutation = await warm.client.setPermissionMode('s', {
        expectedStoreId: f.storeId,
        commandId: 'native-jobs-current-full',
        mode: 'full',
        makeDefault: false,
        ifRevision: before.revision,
        ifDefaultRevision: before.defaultRevision,
      });
      const after = await warm.client.getPermissionMode('s', { storeId: f.storeId });
      const trust = await warm.client.getWorkspaceTrust('w', { storeId: f.storeId });
      if (
        mutation.state !== 'applied' ||
        after.mode !== 'full' ||
        after.scopeSessionId !== 's' ||
        after.revision !== mutation.receipt?.revision ||
        trust.storeId !== f.storeId ||
        !trust.trusted
      )
        throw Error('native_jobs_current_controls_unavailable');
      console.info(
        'native_jobs_current_controls',
        JSON.stringify({ before, mutation, after, trust }),
      );
    } finally {
      await warm.close();
    }
    const supervisor = await Bun.build({
      entrypoints: [
        resolve(
          import.meta.dir,
          '../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      target: 'bun',
      outdir: join(f.root, 'assets'),
      naming: 'shell-supervisor.js',
    });
    if (!supervisor.success) throw Error('native_job_supervisor_build');
    writeFileSync(
      f.userConfiguration.path,
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
        tools: [{ id: 'shell.execute', definitionVersion: '1' }],
      }),
      { mode: 0o600 },
    );
    const source = join(f.root, 'artifact', 'native-caller-jobs-service.ts');
    writeFileSync(
      source,
      `import{selectProfile}from'@kite-ai/agent/profile';import{createDefaultProcessConfiguration}from'@kite-ai/service/configuration';import{runServiceProcess}from'@kite-ai/service/main';await runServiceProcess({configure(startup,context){return createDefaultProcessConfiguration({userConfigurationPath:${JSON.stringify(f.userConfiguration.path)},observerSubjectId:context.subjectId,profile:selectProfile(startup.profile),hostConfiguration:startup.hostConfiguration,shell:${JSON.stringify({ platform: 'darwin', configurationId: 'native-caller-confined-1', env: { PATH: '/usr/bin:/bin' }, supervisorPath: supervisor.outputs[0]!.path, bunExecutable: process.execPath, shellExecutable: '/bin/sh', graceMs: 20 })}});}});`,
    );
    const compiled = await Bun.build({
      entrypoints: [source],
      target: 'bun',
      packages: 'external',
      outdir: join(f.root, 'artifact'),
    });
    if (!compiled.success) throw Error('native_job_service_build');
    const entrypoint = compiled.outputs[0]!.path;
    const artifact = {
      ...f.artifact,
      entrypoint,
      entrypointSha256: createHash('sha256').update(readFileSync(entrypoint)).digest('hex'),
    };
    const launch = () =>
      launchPairedService({
        profile: f.profile,
        ...artifact,
        spawnChild: f.userConfiguration.spawnChild,
        instanceId: crypto.randomUUID(),
        requiredCapabilities: [
          'sessions',
          'commands',
          'history',
          'events',
          'interactions',
          'run_resume',
          'session_recovery',
          'permission_controls',
        ],
      });
    // Native Shell adds its actual host read scope. Confirm that exact scope on
    // this Service; the earlier Files-only host cannot supply its trust receipt.
    const native = await launch();
    try {
      const trust = await native.client.getWorkspaceTrust('w', { storeId: f.storeId });
      if (
        trust.storeId !== f.storeId ||
        trust.workspaceId !== 'w' ||
        trust.status !== 'scope_changed' ||
        trust.trusted ||
        !trust.readScopes.some((scope) => scope.kind === 'native_shell_read')
      )
        throw Error('native_jobs_original_shell_trust_scope_unavailable');
      const mutation = await native.client.setWorkspaceTrust('w', {
        expectedStoreId: f.storeId,
        commandId: 'native-jobs-current-shell-trust',
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      });
      const accepted = await native.client.getWorkspaceTrust('w', { storeId: f.storeId });
      const mode = await native.client.getPermissionMode('s', { storeId: f.storeId });
      if (
        mutation.state !== 'applied' ||
        mutation.kind !== 'workspace.trust' ||
        mutation.receipt?.status !== 'applied' ||
        mutation.receipt.trusted !== true ||
        accepted.storeId !== f.storeId ||
        accepted.workspaceId !== 'w' ||
        accepted.revision !== mutation.receipt.revision ||
        !accepted.trusted ||
        accepted.canonicalIdentity !== trust.canonicalIdentity ||
        accepted.externalReadScopeDigest !== trust.externalReadScopeDigest ||
        accepted.canonicalIdentity !== mutation.receipt.canonicalIdentity ||
        accepted.externalReadScopeDigest !== mutation.receipt.externalReadScopeDigest ||
        mode.storeId !== f.storeId ||
        mode.sessionId !== 's' ||
        mode.scopeSessionId !== 's' ||
        mode.mode !== 'full'
      )
        throw Error('native_jobs_current_shell_controls_unavailable');
      console.info(
        'native_jobs_current_shell_controls',
        JSON.stringify({ trust, mutation, accepted, mode }),
      );
    } finally {
      await native.close();
    }
    return {
      ...f,
      artifact,
      launch,
      jobCalls: () => calls,
      close(options: { retainRoot?: boolean } = {}) {
        provider.stop(true);
        f.close(options);
      },
    };
  } catch (error) {
    provider.stop(true);
    f.close();
    throw error;
  }
}
