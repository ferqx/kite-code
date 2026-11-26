import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { directoryLink, privateDirectory } from '../../../../tests/fixtures/test-filesystem';
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
async function lifecycle(scenario: 'eof' | 'pending-read' | 'lost-response' | 'console') {
  const consoleInput = scenario === 'console';
  const interleaveCancellation = scenario === 'pending-read' || scenario === 'lost-response';
  const loseCancelResponse = scenario === 'lost-response';
  const pipeInterrupt = process.platform === 'win32' && scenario === 'eof';
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-lifecycle-')));
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  directoryLink(join(import.meta.dir, '../../../../node_modules'), join(root, 'node_modules'));
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
      rootUri: pathToFileURL(workspace).href,
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
    // The existing host hook interrupts over a real interaction response before it can be used.
    const signalPath = join(root, 'cancel-window');
    writeFileSync(
      driver,
      interleaveCancellation
        ? `import { existsSync } from 'node:fs';
import { runSelectedCLI } from ${JSON.stringify(join(import.meta.dir, '../../host/index.ts'))};
import { parseCLIArguments } from ${JSON.stringify(join(import.meta.dir, '../../src/arguments.ts'))};
import { withCtrlC } from ${JSON.stringify(join(import.meta.dir, '../../src/index.ts'))};
try {
  process.exitCode = await withCtrlC(signal => runSelectedCLI({
    arguments: parseCLIArguments(process.argv.slice(2)),
    artifact: ${JSON.stringify(artifact)},
    dataRoot: ${JSON.stringify(profile.dataRoot)},
    profile: 'new',
    cwd: ${JSON.stringify(workspace)},
    stdin: process.stdin,
    signal,
    write: line => process.stdout.write(line + '\\n'),
    prompt: line => process.stderr.write(line),
    onLaunched({client}) {
      const cancel = client.cancelCommand.bind(client);
      let cancels = 0;
      client.cancelCommand = async (...args) => {
        process.stdout.write('cancel calls ' + ++cancels + '\\n');
        const response = await cancel(...args);
        if (${loseCancelResponse}) {
          process.stdout.write('cancel response dropped after Service receipt\\n');
          throw Error('lost_cancel_response');
        }
        return response;
      };
      const original = client.listInteractions.bind(client);
      let interleaved = false;
      client.listInteractions = async (...args) => {
        const page = await original(...args);
        if (!interleaved && page.interactions.length && existsSync(${JSON.stringify(signalPath)})) {
          interleaved = true;
          process.emit('SIGINT');
          if (!signal.aborted) throw Error('driver_interrupt_not_delivered');
          process.stdout.write('cancel interleaved after pending read\\n');
        }
        return page;
      };
    },
  }));
} catch (error) {
  process.stderr.write(String(error?.code ?? 'driver_failed') + '\\n');
  process.exitCode = 1;
}
`
        : `import { runCLIProcess } from ${JSON.stringify(join(import.meta.dir, '../../host/main.ts'))};
${pipeInterrupt ? "process.once('message', message => { if (message === 'interrupt') process.emit('SIGINT'); });" : ''}
try { process.exitCode=await runCLIProcess({artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'new',cwd:${JSON.stringify(workspace)}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n');process.exitCode=1; } finally { if (process.connected) process.disconnect(); }
`,
    );
    let output = '';
    const decoder = new TextDecoder();
    const argv = [process.execPath, driver, 'run', '--thread', 'cli', '--task', 'question'];
    const processOptions = { cwd: root, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' } };
    const piped = consoleInput
      ? undefined
      : Bun.spawn(argv, {
          ...processOptions,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          ...(pipeInterrupt ? { ipc: () => {} } : {}),
        });
    const running =
      piped ??
      Bun.spawn(argv, {
        ...processOptions,
        terminal: {
          cols: 240,
          rows: 30,
          data(_terminal, bytes) {
            output += decoder.decode(bytes, { stream: true });
          },
        },
      });
    child = running;
    piped?.stdin.end();
    const outputTask = (async () => {
      if (!piped) return;
      for await (const bytes of piped.stdout) output += decoder.decode(bytes, { stream: true });
      output += decoder.decode();
    })();
    const errorTask = piped ? new Response(piped.stderr).text() : Promise.resolve('');
    const waitingText = consoleInput ? 'Approve harmless fixture' : 'Paired host remains active';
    await until(() => (output.includes(waitingText) ? true : undefined));
    const intent = JSON.parse(output.match(/work intent (\{[^\r\n]+\})/)![1]!) as {
      commandId: string;
      storeId: string;
      sessionId: string;
    };
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
    else if (consoleInput) running.terminal!.write('\x03');
    // A Windows pipe child has no console Ctrl+C to send. Bun's kill can terminate
    // it with 130 without entering the listener, so inject at the listener in that fixture.
    else if (pipeInterrupt) piped!.send('interrupt');
    else running.kill('SIGINT');
    await until(() => (running.exitCode !== null ? true : undefined));
    const exit = await running.exited;
    await outputTask;
    const stderr = await errorTask;
    expect(exit, `stdout:\n${output}\nstderr:\n${stderr}`).toBe(130);
    expect(running.signalCode).toBeNull();
    if (interleaveCancellation) {
      expect(output).toContain('cancel interleaved after pending read');
      expect(output.match(/^cancel calls \d+/gm)).toEqual(['cancel calls 1']);
    }
    const terminal = `terminal ${intent.commandId} cancelled`;
    const prior = loseCancelResponse
      ? `terminal ${intent.commandId} outcome_unknown`
      : `cancel accepted ${intent.commandId}`;
    if (loseCancelResponse) {
      expect(output).toContain('cancel response dropped after Service receipt');
      expect(output).not.toContain(`cancel accepted ${intent.commandId}`);
    }
    expect(output).toContain(prior);
    expect(output).toContain(terminal);
    expect(output.indexOf(terminal)).toBeGreaterThan(output.indexOf(prior));
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
    expect(stderr).not.toContain('Bearer');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    child?.terminal?.close();
    await peer.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  'actual CLI stdin EOF preserves its original pending work; Ctrl+C cancels it precisely and host exit leaves another Service work pending',
  () => lifecycle('eof'),
  20000,
);
test(
  'Ctrl+C delivered inside a pending-interaction response still cancels the original CLI work and preserves peer work',
  () => lifecycle('pending-read'),
  20000,
);

test(
  'lost cancellation response is observed without repeating the saved cancellation intent',
  () => lifecycle('lost-response'),
  20000,
);

test.skipIf(process.platform !== 'win32')(
  'Windows console Ctrl+C prints the exact cancellation terminal before exiting 130',
  () => lifecycle('console'),
  20000,
);
