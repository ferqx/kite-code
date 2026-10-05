import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
/** Explicit finite configured policy, actual default factory and confined supervisor. */
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
      const body = (await req.json()) as { messages: { role: string }[] };
      const done = body.messages.at(-1)?.role === 'tool';
      const delta = done
        ? { content: 'NATIVE_PARENT_DONE_TWO_JOBS' }
        : {
            tool_calls: ['a', 'b'].map((key, index) => ({
              index,
              id: `native-launch-${key}`,
              type: 'function',
              function: {
                name: 'shell.launch',
                arguments: JSON.stringify({
                  key,
                  command: `printf 'NATIVE_JOB_${key}_中🙂\\n'; while :; do /bin/sleep 1; done`,
                  cancellation: 'detached',
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
      join(f.profile.profilePath, 'config.jsonc'),
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
        tools: [{ id: 'shell.launch', definitionVersion: '1' }],
      }),
      { mode: 0o600 },
    );
    const source = join(f.root, 'artifact', 'native-caller-jobs-service.ts');
    writeFileSync(
      source,
      `import{selectProfile}from'@kite-ai/agent/profile';import{createDefaultProcessConfiguration}from'@kite-ai/service/configuration';import{runServiceProcess}from'@kite-ai/service/main';await runServiceProcess({configure(startup){return createDefaultProcessConfiguration({profile:selectProfile(startup.profile),hostConfiguration:startup.hostConfiguration,shell:${JSON.stringify({ platform: 'darwin', configurationId: 'native-caller-confined-1', env: { PATH: '/usr/bin:/bin' }, supervisorPath: supervisor.outputs[0]!.path, bunExecutable: process.execPath, shellExecutable: '/bin/sh', graceMs: 20 })},permissionPolicy:{readPolicy(){return{mode:'full',workspaceTrust:true,revision:'explicit-native-caller-jobs-v1',allowed:[{kind:'model',definitionId:'fixed',definitionVersion:'1'},{kind:'tool',definitionId:'shell.launch',definitionVersion:'1'},{kind:'job',definitionId:'shell.command',definitionVersion:'1'}]};}}});}});`,
    );
    const compiled = await Bun.build({
      entrypoints: [source],
      target: 'bun',
      packages: 'external',
      outdir: join(f.root, 'artifact'),
    });
    if (!compiled.success) throw Error('native_job_service_build');
    const entrypoint = compiled.outputs[0]!.path;
    return {
      ...f,
      artifact: {
        ...f.artifact,
        entrypoint,
        entrypointSha256: createHash('sha256').update(readFileSync(entrypoint)).digest('hex'),
      },
      jobCalls: () => calls,
      close() {
        provider.stop(true);
        f.close();
      },
    };
  } catch (error) {
    provider.stop(true);
    f.close();
    throw error;
  }
}
