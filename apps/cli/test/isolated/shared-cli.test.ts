import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import {
  inspectProcess,
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '@kite-ai/service/daemon';
import {
  privateDirectory,
  temporarySocketDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { runSelectedCLI } from '../../host';
import { runSelectedDaemon } from '../../host/daemon';
import type { RunCLIArguments } from '../../src/arguments';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';

let root: string, entry: string, driver: string;
const supportsDaemonFixture = ['darwin', 'linux'].includes(process.platform);
const nativeTest = supportsDaemonFixture ? test : test.skip;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  if (!supportsDaemonFixture) return;
  // Keep UUID-scoped sockets inside macOS's original Unix address budget.
  root = temporarySocketDirectory('kite-shared-cli-');
  const old = await buildOwnedDaemon(join(root, 'artifact'));
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL('../fixtures/shared-cli-daemon-child.ts', import.meta.url)),
      fileURLToPath(new URL('../fixtures/shared-cli-driver.ts', import.meta.url)),
    ],
    target: 'bun',
    packages: 'external',
    outdir: dirname(old),
  });
  expect(result.success).toBe(true);
  entry = join(dirname(old), 'shared-cli-daemon-child.js');
  driver = join(dirname(old), 'shared-cli-driver.js');
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error('shared_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function limit<T>(value: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('shared_fixture_deadline')), 10000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function proveBusiness(
  client: ReturnType<typeof createClient>,
  databasePath: string,
  commandId: string,
  content: string,
  rootWorkCommandId = commandId,
) {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = (id: string) =>
      db
        .query(
          'SELECT id,kind,status,session_id,origin_store_id,subject_id,request_json,receipt_json FROM command WHERE id=?',
        )
        .get(id) as {
        id: string;
        kind: string;
        status: string;
        session_id: string;
        origin_store_id: string;
        subject_id: string;
        request_json: string;
        receipt_json: string;
      };
    const original = row(commandId);
    expect(original.status).toBe('applied');
    expect(JSON.parse(original.request_json)).toMatchObject({ content });
    const receipt = JSON.parse(original.receipt_json) as {
      runId: string;
      businessCommandId?: string;
      humanInputCommandId?: string;
      decisionCommandId?: string;
    };
    const businessId = receipt.businessCommandId ?? original.id;
    const publicCommand = await client.getCommand(commandId);
    expect(publicCommand.receipt).toMatchObject({ runId: receipt.runId });
    if (receipt.businessCommandId) {
      expect(businessId).not.toBe(original.id);
      const raw = row(receipt.humanInputCommandId!);
      expect(raw).toMatchObject({
        kind: 'human.input',
        status: 'applied',
        session_id: original.session_id,
        origin_store_id: original.origin_store_id,
        subject_id: original.subject_id,
      });
      expect(JSON.parse(raw.request_json)).toMatchObject({
        publicCommandId: original.id,
        content,
        originalRequest: JSON.parse(original.request_json),
      });
      expect(JSON.parse(raw.receipt_json)).toMatchObject({
        businessCommandId: businessId,
        decisionCommandId: receipt.decisionCommandId,
        state: 'decided',
      });
      const decision = row(receipt.decisionCommandId!);
      expect(decision).toMatchObject({
        kind: 'human.input.decision',
        status: 'applied',
        session_id: original.session_id,
        subject_id: original.subject_id,
      });
      expect(JSON.parse(decision.receipt_json)).toMatchObject({ businessCommandId: businessId });
      expect(row(businessId)).toMatchObject({ status: 'applied', session_id: original.session_id });
      expect(JSON.parse(row(businessId).receipt_json)).toMatchObject({ runId: receipt.runId });
    }
    const run = await client.getRun(receipt.runId);
    expect(run).toMatchObject({ originCommandId: businessId, rootWorkCommandId });
    const view = await client.getView(original.session_id);
    const model = view.executions.find(
      (execution) => execution.kind === 'model' && execution.runId === run.id,
    )!;
    expect(model).toMatchObject({
      status: 'succeeded',
      rootWorkCommandId,
    });
    expect(
      db
        .query(
          'SELECT origin_command_id,run_id,root_work_command_id,state FROM execution WHERE id=?',
        )
        .get(model.id),
    ).toEqual({
      origin_command_id: businessId,
      run_id: run.id,
      root_work_command_id: rootWorkCommandId,
      state: 'succeeded',
    });
    const snapshot = await client.getModelInput(original.session_id, model.id);
    expect(snapshot.confirmation).toBe('succeeded');
    expect(
      snapshot.request.messages.find((message) => message.sourceIds?.includes(businessId)),
    ).toMatchObject({ content, sourceIds: [businessId] });
    const tools = db
      .query(
        "SELECT id,adapter_id AS definitionId,run_id AS runId,origin_command_id AS originCommandId FROM execution WHERE kind='tool' AND run_id=?",
      )
      .all(run.id) as {
      id: string;
      definitionId: string;
      runId: string;
      originCommandId: string;
    }[];
    return {
      command: publicCommand,
      run,
      view,
      tools,
      decisionRequest: receipt.decisionCommandId
        ? JSON.parse(row(receipt.decisionCommandId).request_json)
        : undefined,
    };
  } finally {
    db.close();
  }
}

async function fixture() {
  const base = join(root, randomUUID());
  privateDirectory(base);
  const dataRoot = join(base, 'data');
  const profile = selectProfile({ dataRoot, profile: 'owned' });
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: join(base, 's.sock'),
  });
  const web = join(base, 'web');
  mkdirSync(web);
  const manifest = [
    ['/index.html', 'text/html; charset=utf-8', '<title>Owned</title>'],
    ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
    ['/app.css', 'text/css; charset=utf-8', 'body{}'],
  ].map(([path, mediaType, content]) => {
    writeFileSync(join(web, path!.slice(1)), content!);
    return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
  });
  const raw = JSON.stringify(manifest);
  writeFileSync(join(web, 'manifest.json'), raw);
  const executable = realpathSync(process.execPath);
  const artifact = {
    entrypoint: entry,
    entrypointSha256: hash(readFileSync(entry)),
    executable,
    executableSha256: hash(readFileSync(executable)),
    apiMajor: 1 as const,
    buildId: 'running-older-build',
    daemon: {
      entrypoint: entry,
      entrypointSha256: hash(readFileSync(entry)),
      web: { directory: web, manifestSha256: hash(raw) },
    },
  };
  const daemon = (action: 'start' | 'stop') =>
    runSelectedDaemon({
      arguments: { kind: 'server', action, server: endpoint.socket, cancel: false, json: false },
      dataRoot,
      profile: 'owned',
      cwd: base,
      artifact,
      write() {},
    });
  await daemon('start');
  const bootstrap = await requestDaemonBootstrap(endpoint, {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  });
  const client = createClient({
    endpoint: bootstrap.httpEndpoint,
    token: bootstrap.token,
    expected: {
      profile: bootstrap.profile,
      instanceId: bootstrap.instanceId,
      apiMajor: 1,
      requiredCapabilities: [],
    },
  });
  const info = await client.connect();
  const storeId = info.storeId!;
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'workspace',
    rootUri: pathToFileURL(base).href,
    name: 'Owned',
  });
  const session = (id: string, workspaceId = 'workspace') =>
    client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId,
      title: id,
    });
  const args = (task: string, thread?: string): RunCLIArguments => ({
    kind: 'run',
    task,
    ...(thread ? { thread } : {}),
    server: endpoint.socket,
    trustWorkspace: false,
    skills: [],
  });
  const lines: string[] = [];
  let assetReads = 0;
  const run = (
    arguments_: RunCLIArguments,
    extra: Partial<Parameters<typeof runSelectedCLI>[0]> = {},
  ) =>
    runSelectedCLI({
      arguments: arguments_,
      dataRoot,
      profile: 'owned',
      cwd: '/missing-local-cwd',
      write: (line) => lines.push(line),
      prompt() {},
      resolveArtifact() {
        assetReads++;
        throw Error('paired_asset_must_not_resolve');
      },
      onLaunched() {
        throw Error('shared_must_not_launch');
      },
      ...extra,
    });
  const alive = async () => {
    expect(inspectProcess(bootstrap.pid, bootstrap.processStartIdentity)).toBe('alive');
    expect((await requestDaemonBootstrap(endpoint, bootstrap.profile)).instanceId).toBe(
      bootstrap.instanceId,
    );
  };
  return {
    base,
    dataRoot,
    profile,
    endpoint,
    bootstrap,
    client,
    storeId,
    session,
    args,
    lines,
    run,
    alive,
    async proof(sessionId: string, content: string, rootWorkCommandId?: string) {
      const db = new Database(profile.databasePath, { readonly: true });
      let commandId: string;
      try {
        const originals = db
          .query(
            "SELECT id FROM command WHERE session_id=? AND kind='run.start' AND root_work_command_id=id AND json_extract(request_json,'$.content')=?",
          )
          .all(sessionId, content) as { id: string }[];
        expect(originals).toHaveLength(1);
        commandId = originals[0]!.id;
      } finally {
        db.close();
      }
      return proveBusiness(client, profile.databasePath, commandId, content, rootWorkCommandId);
    },
    reads: () => assetReads,
    async close() {
      client.disposeNetwork();
      await daemon('stop');
      expect(readDaemonReservation(endpoint)).toBeUndefined();
    },
  };
}
nativeTest(
  'shared missing paired assets and differing target build run/resume full output while other client held work remains alive',
  async () => {
    const f = await fixture();
    try {
      await f.session('other');
      await f.client.startRun('other', {
        expectedStoreId: f.storeId,
        commandId: 'other-held',
        kind: 'run.start',
        content: 'New task: hold external',
      });
      await until(() => existsSync(join(f.base, 'entered-other')));
      const proof_other = await f.proof('other', 'New task: hold external');
      expect(proof_other.run.isActive).toBe(true);
      expect(
        proof_other.tools.find(
          (execution) => execution.id === readFileSync(join(f.base, 'entered-other'), 'utf8'),
        ),
      ).toMatchObject({
        definitionId: 'fixture.held',
        runId: proof_other.run.id,
        originCommandId: proof_other.run.originCommandId,
      });
      expect(await limit(f.run(f.args('ordinary complete answer', 'cli')))).toBe(0);
      const first = await f.proof('cli', 'ordinary complete answer');
      expect(first.run.status).toBe('completed');
      expect(
        f.lines.some((line) => line.includes('complete-owned-answer:') && line.includes(':TAIL')),
      ).toBe(true);
      expect(f.lines.join('\n').length).toBeGreaterThan(84 * 1024);
      expect(
        await limit(
          f.run(
            {
              ...f.args('Follow up: resume complete answer', 'cli'),
              kind: 'resume',
            } as RunCLIArguments,
            {
              artifact: {
                entrypoint: '/missing-installed/main.js',
                entrypointSha256: '0'.repeat(64),
                executable: '/missing-installed/bun',
                executableSha256: '0'.repeat(64),
                buildId: 'different-newer-installed-build',
                apiMajor: 1,
              },
            },
          ),
        ),
      ).toBe(0);
      const resumed = await f.proof('cli', 'Follow up: resume complete answer', first.command.id);
      expect(resumed.run.status).toBe('completed');
      const resumeApplication = resumed.command.receipt as {
        decisionCommandId: string;
        businessCommandId: string;
      };
      expect(await f.client.getCommand(resumeApplication.decisionCommandId)).toMatchObject({
        kind: 'human.input.decision',
        status: 'applied',
        originStoreId: f.storeId,
        sessionId: 'cli',
        receipt: { businessCommandId: resumeApplication.businessCommandId },
      });
      expect(resumed.decisionRequest).toMatchObject({
        proposal: {
          relation: 'same_work',
          purpose: 'work',
          targetRootWorkCommandId: first.command.id,
          selectionEffect: 'keep',
          basis: {
            kind: 'explicit_text',
            instruction: 'Follow up: resume complete answer',
          },
        },
      });

      await f.alive();
      expect((await f.client.getView('other')).runs.some((run) => run.isActive)).toBe(true);
      expect(existsSync(join(f.base, 'cancelled-other'))).toBe(false);
      expect(f.reads()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);
nativeTest(
  'shared explicit workspace, foreign thread and missing Skill capability reject before work without asset resolution',
  async () => {
    const f = await fixture();
    try {
      const elsewhere = join(f.base, 'elsewhere');
      mkdirSync(elsewhere);
      await f.client.createWorkspace({
        expectedStoreId: f.storeId,
        id: 'foreign-workspace',
        rootUri: pathToFileURL(elsewhere).href,
        name: 'Foreign',
      });
      await f.session('foreign', 'foreign-workspace');
      await expect(f.run({ ...f.args('x'), workspace: elsewhere })).rejects.toMatchObject({
        code: 'shared_workspace_mismatch',
      });
      await expect(f.run(f.args('x', 'foreign'))).rejects.toMatchObject({
        code: 'workspace_identity_mismatch',
      });
      await expect(
        f.run({ ...f.args('x'), skills: ['configured-guidance'] }),
      ).rejects.toMatchObject({
        code: 'shared_connection_failed',
      });
      expect(f.reads()).toBe(0);
      expect(existsSync(join(f.base, 'models'))).toBe(false);
      await f.alive();
    } finally {
      await f.close();
    }
  },
  30000,
);
nativeTest(
  'shared EOF preserves original waiting intent, actual stdin answer completes, explicit Ctrl+C only cancels original command',
  async () => {
    const f = await fixture();
    try {
      expect(
        await limit(f.run(f.args('question shared', 'unanswered'), { stdin: Readable.from([]) })),
      ).toBe(3);
      const intent = f.lines.find((line) => line.startsWith('work intent '))!;
      expect(intent).toContain('unanswered');
      const pending = await f.client.listInteractions('unanswered', {
        storeId: f.storeId,
        state: 'pending',
      });
      expect(pending.interactions).toHaveLength(1);
      expect(existsSync(join(f.base, 'answer-unanswered'))).toBe(false);
      await f.alive();
      expect(
        await limit(
          f.run(f.args('question shared', 'answered'), {
            stdin: Readable.from(['{"reply":"yes"}\n']),
          }),
        ),
      ).toBe(0);
      expect(readFileSync(join(f.base, 'answer-answered'), 'utf8')).toContain('yes');
      await f.session('other');
      await f.client.startRun('other', {
        expectedStoreId: f.storeId,
        commandId: 'other-held',
        kind: 'run.start',
        content: 'New task: hold external',
      });
      await until(() => existsSync(join(f.base, 'entered-other')));
      const proof_other = await f.proof('other', 'New task: hold external');
      expect(proof_other.run.isActive).toBe(true);
      expect(
        proof_other.tools.find(
          (execution) => execution.id === readFileSync(join(f.base, 'entered-other'), 'utf8'),
        ),
      ).toMatchObject({
        definitionId: 'fixture.held',
        runId: proof_other.run.id,
        originCommandId: proof_other.run.originCommandId,
      });
      const cancel = new AbortController();
      const running = f.run(f.args('New task: hold external', 'cancel-own'), {
        signal: cancel.signal,
      });
      await until(() => existsSync(join(f.base, 'entered-cancel-own')));
      const proof_cancel_own = await f.proof('cancel-own', 'New task: hold external');
      expect(proof_cancel_own.run.isActive).toBe(true);
      expect(
        proof_cancel_own.tools.find(
          (execution) => execution.id === readFileSync(join(f.base, 'entered-cancel-own'), 'utf8'),
        ),
      ).toMatchObject({
        definitionId: 'fixture.held',
        runId: proof_cancel_own.run.id,
        originCommandId: proof_cancel_own.run.originCommandId,
      });
      cancel.abort();
      expect(await limit(running)).toBe(130);
      expect(existsSync(join(f.base, 'cancelled-cancel-own'))).toBe(true);
      expect(await f.client.getRun(proof_cancel_own.run.id)).toMatchObject({
        status: 'cancelled',
        originCommandId: proof_cancel_own.run.originCommandId,
      });
      expect(readFileSync(join(f.base, 'cancelled-cancel-own'), 'utf8')).toBe(
        readFileSync(join(f.base, 'entered-cancel-own'), 'utf8'),
      );
      expect(existsSync(join(f.base, 'cancelled-other'))).toBe(false);
      expect((await f.client.getView('other')).runs.some((run) => run.isActive)).toBe(true);
      await f.alive();
    } finally {
      await f.close();
    }
  },
  30000,
);
function spawnDriver(
  dataRoot: string,
  socket: string,
  task = 'New task: hold external',
  thread = 'terminated',
) {
  return Bun.spawn(
    [process.execPath, driver, 'run', '--task', task, '--thread', thread, '--server', socket],
    {
      cwd: dirname(driver),
      env: { PATH: process.env.PATH ?? '', OWNED_DATA_ROOT: dataRoot },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
nativeTest(
  'compiled shared CLI SIGTERM detaches without cancelling daemon work; later daemon loss ends original observation without replay',
  async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawnDriver> | undefined;
    try {
      child = spawnDriver(f.dataRoot, f.endpoint.socket);
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      child.stdin.end();
      await until(() => existsSync(join(f.base, 'entered-terminated')));
      const proof_terminated = await f.proof('terminated', 'New task: hold external');
      expect(proof_terminated.run.isActive).toBe(true);
      expect(
        proof_terminated.tools.find(
          (execution) => execution.id === readFileSync(join(f.base, 'entered-terminated'), 'utf8'),
        ),
      ).toMatchObject({
        definitionId: 'fixture.held',
        runId: proof_terminated.run.id,
        originCommandId: proof_terminated.run.originCommandId,
      });
      child.kill('SIGTERM');
      expect(await limit(child.exited)).toBe(2);
      expect(await output).toContain('work intent');
      expect(await errors).not.toContain(f.bootstrap.token);
      expect(existsSync(join(f.base, 'cancelled-terminated'))).toBe(false);
      expect((await f.client.getView('terminated')).runs.some((run) => run.isActive)).toBe(true);
      await f.alive();
      const running = f.run(f.args('New task: hold external', 'network-lost'));
      await until(() => existsSync(join(f.base, 'entered-network-lost')));
      const proof_network_lost = await f.proof('network-lost', 'New task: hold external');
      expect(proof_network_lost.run.isActive).toBe(true);
      expect(
        proof_network_lost.tools.find(
          (execution) =>
            execution.id === readFileSync(join(f.base, 'entered-network-lost'), 'utf8'),
        ),
      ).toMatchObject({
        definitionId: 'fixture.held',
        runId: proof_network_lost.run.id,
        originCommandId: proof_network_lost.run.originCommandId,
      });
      const calls = readFileSync(join(f.base, 'models'), 'utf8');
      process.kill(f.bootstrap.pid, 'SIGKILL');
      expect(await limit(running)).toBe(2);
      expect(
        f.lines.some((line) => line.includes('network-lost') && line.startsWith('work intent ')),
      ).toBe(true);
      expect(readFileSync(join(f.base, 'models'), 'utf8')).toBe(calls);
      expect(f.reads()).toBe(0);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'compiled shared CLI SIGTERM while awaiting stdin question stops local reader without answering or cancelling original work',
  async () => {
    const f = await fixture();
    const child = spawnDriver(f.dataRoot, f.endpoint.socket, 'question shared', 'question-exit');
    let prompt = '';
    const errors = (async () => {
      const reader = child.stderr.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return prompt;
          prompt += new TextDecoder().decode(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    })();
    const output = new Response(child.stdout).text();
    try {
      // Keep stdin open and wait for the actual prompt; this is not an EOF fixture.
      await until(() => prompt.includes('Answer JSON matching the original schema'));
      child.kill('SIGTERM');
      expect(await limit(child.exited)).toBe(3);
      expect(await output).toContain('work intent');
      expect(await errors).not.toContain(f.bootstrap.token);
      const pending = await f.client.listInteractions('question-exit', {
        storeId: f.storeId,
        state: 'pending',
      });
      expect(pending.interactions).toHaveLength(1);
      expect(existsSync(join(f.base, 'answer-question-exit'))).toBe(false);
      expect((await f.client.getView('question-exit')).runs.some((run) => run.isActive)).toBe(true);
      await f.alive();
    } finally {
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await errors;
      await f.close();
    }
  },
  30000,
);
