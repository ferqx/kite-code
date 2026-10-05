import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';

async function until<T>(read: () => T | Promise<T | undefined> | undefined): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('cli_host_lifecycle_deadline');
    await Bun.sleep(10);
  }
}
async function lifecycle(interleaveCancellation = false, loseCancelResponse = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-lifecycle-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  symlinkSync(join(import.meta.dir, '../../../../node_modules'), join(root, 'node_modules'), 'dir');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const service = join(root, 'service.js');
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../fixtures/interaction-child.ts')],
    target: 'bun',
    packages: 'external',
    outdir: root,
    naming: 'service.js',
  });
  if (!built.success) throw new AggregateError(built.logs, 'fixture_build_failed');
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const artifact: CLIServiceArtifact = {
    entrypoint: service,
    entrypointSha256: hash(readFileSync(service)),
    executable: process.execPath,
    executableSha256: hash(readFileSync(process.execPath)),
    buildId: 'cli-lifecycle-fixture',
    apiMajor: 1,
  };
  const peer = await launchPairedService({
    profile,
    entrypoint: service,
    executable: process.execPath,
    instanceId: crypto.randomUUID(),
    buildId: artifact.buildId,
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'commands', 'interactions'],
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const storeId = peer.bootstrap.storeId!;
    await peer.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: new URL(`file://${workspace}`).href,
      name: 'actual workspace',
    });
    await peer.client.createSession({
      expectedStoreId: storeId,
      commandId: 'peer-create',
      sessionId: 'peer',
      workspaceId: 'workspace',
      title: 'peer work',
    });
    await peer.client.startRun('peer', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'peer-work',
      content: 'independent peer',
    });
    await until(
      async () =>
        (await peer.client.listInteractions('peer', { storeId, state: 'pending' })).interactions[0],
    );
    const driver = join(root, 'driver.ts');
    // The parent opens the window only after proving EOF preserved the original work.
    // The existing host hook then delivers SIGINT while a real interaction read is pending.
    const signalPath = join(root, 'cancel-window');
    writeFileSync(
      driver,
      interleaveCancellation
        ? `import { existsSync } from 'node:fs';
import { runSelectedCLI } from ${JSON.stringify(join(import.meta.dir, '../../host/index.ts'))};
import { parseCLIArguments } from ${JSON.stringify(join(import.meta.dir, '../../src/arguments.ts'))};
import { withCtrlC } from ${JSON.stringify(join(import.meta.dir, '../../src/index.ts'))};
try { process.exitCode=await withCtrlC(signal => runSelectedCLI({arguments:parseCLIArguments(process.argv.slice(2)),artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'new',cwd:${JSON.stringify(workspace)},stdin:process.stdin,signal,write:line=>process.stdout.write(line+'\\n'),prompt:line=>process.stderr.write(line),onLaunched({client}) {
const cancel=client.cancelCommand.bind(client);let cancels=0;client.cancelCommand=async(...args)=>{cancels++;process.stdout.write('cancel calls '+cancels+'\\n');const response=await cancel(...args);if(${JSON.stringify(loseCancelResponse)})throw Error('lost_cancel_response');return response;};
const original=client.listInteractions.bind(client);let interleaved=false;
client.listInteractions=async (...args)=>{const page=await original(...args);if(!interleaved && existsSync(${JSON.stringify(signalPath)})){interleaved=true;const interrupted=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));process.kill(process.pid,'SIGINT');await interrupted;process.stdout.write('cancel interleaved after pending read\\n');}return page;};
}})); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n');process.exitCode=1; }
`
        : `import { runCLIProcess } from ${JSON.stringify(join(import.meta.dir, '../../host/main.ts'))};
try { process.exitCode=await runCLIProcess({artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'new',cwd:${JSON.stringify(workspace)}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n');process.exitCode=1; }
`,
    );
    const running = Bun.spawn(
      [process.execPath, driver, 'run', '--thread', 'cli', '--task', 'question'],
      {
        cwd: root,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
      },
    );
    child = running;
    running.stdin.end();
    let output = '';
    const outputTask = (async () => {
      const reader = running.stdout.getReader(),
        decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        output += decoder.decode(next.value, { stream: true });
      }
      reader.releaseLock();
    })();
    const errorTask = new Response(running.stderr).text();
    await until(() => (output.includes('Paired host remains active') ? true : undefined));
    const intent = JSON.parse(
      output
        .split('\n')
        .find((line) => line.startsWith('work intent '))!
        .slice(12),
    ) as { commandId: string; storeId: string; sessionId: string };
    expect(intent).toMatchObject({ storeId, sessionId: 'cli' });
    await Bun.sleep(200);
    expect(child.exitCode).toBeNull();
    const original = await peer.client.getCommand(intent.commandId);
    expect(original.cancelRequestedAt).toBeNull();
    expect((await peer.client.getRun((original.receipt as { runId: string }).runId)).isActive).toBe(
      true,
    );
    const pending = (await peer.client.listInteractions('cli', { storeId, state: 'pending' }))
      .interactions;
    expect(pending.length).toBe(1);
    expect(pending[0]!.answer).toBeNull();
    expect(existsSync(join(profile.profilePath, 'effect'))).toBe(false);
    if (interleaveCancellation) writeFileSync(signalPath, 'cancel');
    else child.kill('SIGINT');
    if (interleaveCancellation) await until(() => (running.exitCode !== null ? true : undefined));
    expect(await child.exited).toBe(130);
    await outputTask;
    if (interleaveCancellation) expect(output).toContain('cancel interleaved after pending read');
    expect(output).toContain(`terminal ${intent.commandId} cancelled`);
    expect(output).toContain(
      "Paired host exit stops only this Service instance's remaining owned work",
    );
    const cancelled = await peer.client.getCommand(intent.commandId);
    expect(cancelled.cancelRequestedAt).not.toBeNull();
    expect((await peer.client.getRun((cancelled.receipt as { runId: string }).runId)).status).toBe(
      'cancelled',
    );
    const peerWork = await peer.client.getCommand('peer-work');
    expect(peerWork.cancelRequestedAt).toBeNull();
    expect((await peer.client.getRun((peerWork.receipt as { runId: string }).runId)).isActive).toBe(
      true,
    );
    expect(
      (await peer.client.listInteractions('peer', { storeId, state: 'pending' })).interactions
        .length,
    ).toBe(1);
    expect(existsSync(join(profile.profilePath, 'effect'))).toBe(false);
    expect(await errorTask).not.toContain('Bearer');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await peer.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  'actual CLI stdin EOF preserves its original pending work; Ctrl+C cancels it precisely and host exit leaves another Service work pending',
  () => lifecycle(),
  20000,
);
test(
  'Ctrl+C delivered inside a pending-interaction response still cancels the original CLI work and preserves peer work',
  () => lifecycle(true),
  20000,
);

test(
  'lost cancellation response is observed without repeating the saved cancellation intent',
  () => lifecycle(true, true),
  20000,
);
