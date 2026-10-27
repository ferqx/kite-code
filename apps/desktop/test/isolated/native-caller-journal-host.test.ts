import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CallerCommandRequest } from '@kite-ai/client';
import { canonicalCallerCommandRequest } from '@kite-ai/client';
import { initializeDesktopBuildEnvironment } from '../../../../scripts/development/windows-desktop-environment';
import { callerDigest } from '../../electron/caller-journal';
import { buildWindowsAccess } from '../../scripts/build-windows-access';

async function windowsAccess(root: string) {
  if (process.platform !== 'win32') return '';
  initializeDesktopBuildEnvironment();
  const asset = await buildWindowsAccess(root);
  return JSON.stringify({ path: join(root, asset.relativePath), sha256: asset.sha256 });
}

for (const kind of ['run.start', 'input.steer', 'input.follow_up', 'command.cancel'] as const)
  test(`actual Node Native ${kind} durable POST loss and SIGKILL; cold physical first GET loss never repeats original request`, async () => {
    const module = await import(
      resolve(import.meta.dir, '../../../cli/test/fixtures/recovery-profile.ts')
    );
    const f = await module.recoveryProfile(
      kind === 'input.follow_up' ? { holdModelCommandId: 'native-original' } : {},
    );
    let warm: Awaited<ReturnType<typeof f.launch>> | undefined,
      child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const wire = `${f.root}-native-caller-${kind}.wire.jsonl`;
    try {
      const access = await windowsAccess(f.root);
      warm = await f.launch();
      if (kind === 'input.steer') {
        await warm.client.resumeRun('s', {
          kind: 'run.resume',
          expectedStoreId: f.storeId,
          commandId: 'resume-steer-target',
          runId: f.run.id,
        });
        await module.untilRecovery(async () => {
          const run = await warm!.client.getRun(f.run.id);
          return run.isActive && run.status === 'waiting_interaction';
        });
      }
      const view = await warm.client.getView('s'),
        common = { expectedStoreId: f.storeId, commandId: 'native-original' };
      const contextSelectionId = view.session.contextSelectionId;
      if (typeof contextSelectionId !== 'string') throw Error('fixture_context_unavailable');
      let input: CallerCommandRequest =
        kind === 'command.cancel'
          ? { ...common, kind, targetCommandId: 'work' }
          : kind === 'input.steer'
            ? {
                ...common,
                kind,
                content: '原🙂é\r\n全文',
                targetRunId: f.run.id,
                contextSelectionId: contextSelectionId,
              }
            : kind === 'input.follow_up'
              ? {
                  ...common,
                  kind,
                  content: '原🙂é\r\n全文',
                  afterRunId: f.run.id,
                  contextSelectionId: contextSelectionId,
                  extensionInputs: [
                    {
                      extensionId: 'builtin.planning',
                      definitionVersion: '1',
                      input: { mode: 'plan' },
                    },
                  ],
                }
              : {
                  ...common,
                  kind,
                  content: '原🙂é\r\n全文',
                  extensionInputs: [
                    {
                      extensionId: 'builtin.skill-workflow',
                      definitionVersion: '1',
                      input: {
                        activations: [
                          { skillId: 'skill:unconfigured', input: { full: '中文\r\n' } },
                        ],
                      },
                    },
                  ],
                };
      const attachmentBytes = Buffer.from('Native 冷恢复附件原件\r\nACK_LOST_ATTACHMENT');
      if (input.kind === 'run.start') {
        const file = await warm.client.uploadInputFile(
          's',
          {
            expectedStoreId: f.storeId,
            id: 'native-original-attachment',
            name: '原件.txt',
            mediaType: 'text/plain',
            size: String(attachmentBytes.length),
            hash: createHash('sha256').update(attachmentBytes).digest('hex'),
          },
          attachmentBytes,
        );
        input = { ...input, files: [file] };
      }
      const helper = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../electron/profile-access-helper.ts')],
        target: 'bun',
        format: 'esm',
        packages: 'bundle',
        outdir: f.root,
        naming: 'native-profile-access.js',
      });
      expect(helper.success).toBe(true);
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../native-caller-node.fixture.ts')],
        target: 'node',
        format: 'esm',
        packages: 'bundle',
        outdir: f.root,
        naming: 'native-caller-node.js',
      });
      expect(build.success).toBe(true);
      const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
      const launch = async (mode: string) => {
        const bootstrap = warm!.bootstrap;
        child = Bun.spawn(
          [
            realpathSync(Bun.which('node')!),
            join(f.root, 'native-caller-node.js'),
            mode,
            JSON.stringify({ dataRoot: f.profile.dataRoot, profile: 'owned' }),
            JSON.stringify({
              endpoint: bootstrap.endpoint,
              token: bootstrap.token,
              profile: bootstrap.profile,
            }),
            realpathSync(process.execPath),
            hash(process.execPath),
            join(f.root, 'native-profile-access.js'),
            hash(join(f.root, 'native-profile-access.js')),
            JSON.stringify(input),
            wire,
            's',
            access,
          ],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        );
        const out = new Response(child.stdout).text(),
          err = new Response(child.stderr).text(),
          timer = setTimeout(() => child?.kill('SIGKILL'), 15000);
        try {
          const code = await child.exited,
            error = await err;
          if (code !== 0) console.error('native node mode', mode, error);
          return { code, out: await out };
        } finally {
          clearTimeout(timer);
        }
      };
      if (input.kind === 'input.follow_up') {
        const originalInput = input;
        input = {
          ...input,
          commandId: 'native-stale-selection',
          afterRunId: null,
          contextSelectionId: 'not-current-selection',
        };
        expect((await launch('prepare')).code).not.toBe(0);
        expect(
          f.rows("SELECT count(*) AS n FROM command WHERE id='native-stale-selection'"),
        ).toEqual([{ n: 0 }]);
        expect(
          readFileSync(wire, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .filter((r) => r.method === 'POST'),
        ).toHaveLength(0);
        input = originalInput;
      }
      if (input.kind === 'run.start') {
        const originalInput = input;
        input = { ...input, commandId: 'native-prepared-only' };
        expect((await launch('prepared')).code).not.toBe(0);
        for (let lookup = 0; lookup < 2; lookup++) {
          const coldPrepared = await launch('normal');
          expect(coldPrepared.code).toBe(0);
          expect(JSON.parse(coldPrepared.out).phase).toBe('unknown');
        }
        expect(f.rows("SELECT count(*) AS n FROM command WHERE id='native-prepared-only'")).toEqual(
          [{ n: 0 }],
        );
        const requests = readFileSync(wire, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
        expect(requests.filter((r) => r.path === '/v1/commands/native-prepared-only')).toHaveLength(
          2,
        );
        for (const mode of ['capacity', 'bad-row']) {
          const refusal = await launch(mode);
          expect(refusal.code).toBe(0);
          const facts = JSON.parse(refusal.out);
          expect(facts.failure).toBe(
            mode === 'capacity' ? 'caller_capacity_exceeded' : 'draft_storage_unavailable',
          );
          expect(facts.refused).toBe(0);
          if (mode === 'bad-row') expect(facts.retained).toBe('{broken');
          expect(
            readFileSync(wire, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
              .filter((r) => r.method === 'POST'),
          ).toHaveLength(0);
        }
        input = { ...originalInput, commandId: 'native-hot-drift' };
        const drift = await launch('hot-drift');
        expect(drift.code).toBe(0);
        expect(JSON.parse(drift.out).lookupError).toBe('caller_intent_conflict');
        expect(f.rows("SELECT count(*) AS n FROM command WHERE id='native-hot-drift'")).toEqual([
          { n: 0 },
        ]);
        input = originalInput;
      }
      const original = await launch('post');
      expect(original.code).not.toBe(0);
      expect(f.rows("SELECT count(*) AS n FROM command WHERE id='native-original'")).toEqual([
        { n: 1 },
      ]);
      if (input.kind === 'run.start') {
        for (const mode of ['drift-body', 'drift-subject', 'drift-workspace']) {
          const drift = await launch(mode);
          expect(drift.code).toBe(0);
          expect(JSON.parse(drift.out).lookupError).toBeDefined();
          expect(JSON.parse(drift.out).phase).toBe('unknown');
        }
      }
      const lost = await launch('get');
      expect(lost.code).toBe(0);
      expect(JSON.parse(lost.out).phase).toBe('unknown');
      const recovered = await launch('normal');
      expect(recovered.code).toBe(0);
      const row = JSON.parse(recovered.out);
      expect(['applied', 'accepted', 'rejected']).toContain(row.phase);
      expect(row.scope).toEqual({ storeId: f.storeId, sessionId: 's', workspaceId: 'w' });
      expect(row.subjectId).toBe('local-user');
      expect(row.requestDigest).toBe(
        createHash('sha256').update(canonicalCallerCommandRequest(input)).digest('hex'),
      );
      const requests = readFileSync(wire, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'POST')[0].body).toEqual(input);
      expect(requests.filter((r) => r.mode !== 'post' && r.method === 'POST')).toHaveLength(0);
      expect(requests.filter((r) => r.path === '/v1/commands/native-original')).toHaveLength(
        kind === 'run.start' ? 5 : 2,
      );
      expect(f.rows("SELECT count(*) AS n FROM command WHERE id='native-original'")).toEqual([
        { n: 1 },
      ]);
      writeFileSync(
        `${wire}.facts.json`,
        JSON.stringify(
          f.rows(
            "SELECT id,kind,subject_id,request_digest,receipt_json,status FROM command WHERE id='native-original'",
          ),
        ),
      );
      if (input.kind === 'run.start') {
        const imported = await warm.client.getInputFileImport('s', 'native-original-attachment');
        expect(imported.state).toBe('bound');
        expect(imported.boundCommandId).toBe(input.commandId);
        expect(imported.reference).toEqual(input.files![0]!.reference!);
        const saved = await warm.client.readArtifact('s', {
          expectedStoreId: f.storeId,
          refId: imported.reference.id,
          scope: imported.reference.scope,
        });
        expect(Buffer.from(saved.content)).toEqual(attachmentBytes);
        expect(requests.filter((r) => r.path.includes('/input-files'))).toHaveLength(0);
      }
      console.log('native caller retained', wire);
    } finally {
      if (child?.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await warm?.close();
      f.close();
    }
  }, 30000);

test('actual Node Native execution.cancel preserves original independent Job through POST loss and cold first GET loss', async () => {
  const module = await import(
      resolve(import.meta.dir, '../../../cli/test/fixtures/caller-job-profile.ts')
    ),
    f = await module.callerJobProfile();
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const wire = `${f.root}-native-execution-cancel.wire.jsonl`;
  try {
    const access = await windowsAccess(f.root);
    const helper = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../electron/profile-access-helper.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
      outdir: f.root,
      naming: 'native-profile-access.js',
    });
    expect(helper.success).toBe(true);
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../native-caller-node.fixture.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: f.root,
      naming: 'native-caller-node.js',
    });
    expect(build.success).toBe(true);
    const input: CallerCommandRequest = {
        kind: 'execution.cancel',
        expectedStoreId: f.storeId,
        commandId: 'native-job-stop',
        executionId: f.jobs[0].id,
      },
      hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const launch = async (mode: string) => {
      child = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(f.root, 'native-caller-node.js'),
          mode,
          JSON.stringify({ dataRoot: f.profile.dataRoot, profile: 'owned' }),
          JSON.stringify({ endpoint: f.endpoint, token: f.token, profile: f.serviceProfile }),
          realpathSync(process.execPath),
          hash(process.execPath),
          join(f.root, 'native-profile-access.js'),
          hash(join(f.root, 'native-profile-access.js')),
          JSON.stringify(input),
          wire,
          's',
          access,
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      const out = new Response(child.stdout).text(),
        err = new Response(child.stderr).text(),
        timer = setTimeout(() => child?.kill('SIGKILL'), 15000);
      try {
        const code = await child.exited,
          error = await err;
        if (code !== 0 && mode !== 'post') console.error(error);
        return { code, out: await out };
      } finally {
        clearTimeout(timer);
      }
    };
    expect((await launch('post')).code).not.toBe(0);
    expect(JSON.parse((await launch('get')).out).phase).toBe('unknown');
    const recovered = JSON.parse((await launch('normal')).out);
    expect(recovered.phase).toBe('applied');
    expect(recovered.target).toEqual({ kind: 'execution', id: f.jobs[0].id });
    const command = await f.client.getCommand(input.commandId);
    expect(command.receipt).toEqual({
      kind: 'execution.cancel',
      executionId: f.jobs[0].id,
      outcome: 'cancel_requested',
      affectedCount: 2,
    });
    const a = await f.client.getExecution(f.jobs[0].id),
      b = await f.client.getExecution(f.jobs[1].id);
    expect(a.cancelRequestedAt).not.toBeNull();
    expect(b.cancelRequestedAt).toBeNull();
    expect(b.status).toBe('running');
    expect(f.calls()).toBe(2);
    expect(
      (await f.client.getView('s')).runs.filter(
        (r: { status: string }) => r.status === 'completed',
      ),
    ).toHaveLength(1);
    const requests = readFileSync(wire, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(requests.filter((r) => r.mode !== 'post' && r.method === 'POST')).toHaveLength(0);
    expect(requests.filter((r) => r.path === '/v1/commands/native-job-stop')).toHaveLength(2);
    writeFileSync(`${wire}.facts.json`, JSON.stringify({ command, a, b, calls: f.calls() }));
    console.log('native job retained', wire);
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await f.close();
  }
}, 30000);

test('actual Node Native cold lookup confirms the completed original public Run without replay', async () => {
  const sessionId = 'native-derived',
    module = await import('../../../cli/test/fixtures/recovery-profile'),
    f = await module.recoveryProfile({ completeModelSessionId: sessionId });
  let warm: Awaited<ReturnType<typeof f.launch>> | undefined,
    child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const wire = `${f.root}-native-derived.wire.jsonl`;
  try {
    const access = await windowsAccess(f.root);
    warm = await f.launch();
    await warm.client.createSession({
      expectedStoreId: f.storeId,
      commandId: 'native-derived-create',
      sessionId,
      workspaceId: 'w',
      title: 'Native derived business',
    });
    const input: CallerCommandRequest = {
      kind: 'run.start',
      expectedStoreId: f.storeId,
      commandId: 'native-derived-original',
      content: 'New task: complete the original Native business\n完整原文🙂é\r\nEXACT TAIL',
    };
    for (const [entrypoint, target, naming] of [
      ['../../electron/profile-access-helper.ts', 'bun', 'native-profile-access.js'],
      ['../native-caller-node.fixture.ts', 'node', 'native-caller-node.js'],
    ] as const) {
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, entrypoint)],
        target,
        format: 'esm',
        packages: 'bundle',
        outdir: f.root,
        naming,
      });
      expect(build.success).toBe(true);
    }
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const launch = async (mode: string) => {
      child = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(f.root, 'native-caller-node.js'),
          mode,
          JSON.stringify({ dataRoot: f.profile.dataRoot, profile: 'owned' }),
          JSON.stringify({
            endpoint: warm!.bootstrap.endpoint,
            token: warm!.bootstrap.token,
            profile: warm!.bootstrap.profile,
          }),
          realpathSync(process.execPath),
          hash(process.execPath),
          join(f.root, 'native-profile-access.js'),
          hash(join(f.root, 'native-profile-access.js')),
          JSON.stringify(input),
          wire,
          sessionId,
          access,
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      const out = new Response(child.stdout).text(),
        err = new Response(child.stderr).text(),
        timer = setTimeout(() => child?.kill('SIGKILL'), 15000);
      try {
        const code = await child.exited,
          error = await err;
        if (code !== 0 && mode !== 'post') console.error(error);
        return { code, out: await out };
      } finally {
        clearTimeout(timer);
      }
    };
    const seed = await warm.client.startRun(sessionId, {
      kind: 'run.start',
      expectedStoreId: f.storeId,
      commandId: 'native-derived-seed',
      content: 'New task: establish the original completed Native work',
    });
    await module.untilRecovery(async () => {
      const command = await warm!.client.getCommand(seed.id);
      const receipt = command.receipt as { runId?: string } | null;
      return (
        command.status === 'applied' &&
        typeof receipt?.runId === 'string' &&
        (await warm!.client.getRun(receipt.runId)).status === 'completed'
      );
    });
    const seedRun = (await warm.client.getView(sessionId)).runs.find(
      (run) => run.originCommandId === seed.id,
    )!;
    expect(seedRun.status).toBe('completed');
    expect(
      f.rows(`SELECT kind,state,origin_command_id FROM execution WHERE run_id='${seedRun.id}'`),
    ).toEqual([{ kind: 'model', state: 'succeeded', origin_command_id: seed.id }]);
    const callsBefore = f.calls();
    expect((await launch('post')).code).not.toBe(0);
    await module.untilRecovery(async () => {
      const command = await warm!.client.getCommand(input.commandId);
      const receipt = command.receipt as { runId?: string } | null;
      return (
        command.status === 'applied' &&
        typeof receipt?.runId === 'string' &&
        (await warm!.client.getRun(receipt.runId)).status === 'completed'
      );
    });
    const original = await warm.client.getCommand(input.commandId),
      receipt = original.receipt as { runId: string },
      run = await warm.client.getRun(receipt.runId);
    expect(original).toMatchObject({ status: 'applied', sessionId, originStoreId: f.storeId });
    const publicRow = f.rows(
      "SELECT request_json,request_digest FROM command WHERE id='native-derived-original'",
    )[0] as { request_json: string; request_digest: string };
    expect(JSON.parse(publicRow.request_json)).toEqual({
      kind: input.kind,
      content: input.content,
    });
    expect(original.requestDigest).toBe(publicRow.request_digest);
    expect(publicRow.request_digest).toBe(
      createHash('sha256').update(canonicalCallerCommandRequest(input)).digest('hex'),
    );
    expect(run).toMatchObject({
      status: 'completed',
      originCommandId: original.id,
      rootWorkCommandId: original.id,
    });
    expect(run.id).not.toBe(seedRun.id);
    expect(
      f.rows(
        `SELECT kind,state,origin_command_id,root_work_command_id FROM execution WHERE run_id='${run.id}'`,
      ),
    ).toEqual([
      {
        kind: 'model',
        state: 'succeeded',
        origin_command_id: original.id,
        root_work_command_id: original.id,
      },
    ]);
    const model = (await warm.client.getView(sessionId)).executions.find(
      (execution) => execution.kind === 'model' && execution.runId === run.id,
    )!;
    const modelInput = await warm.client.getModelInput(sessionId, model.id);
    expect(modelInput.confirmation).toBe('succeeded');
    expect(
      modelInput.request.messages.find((message) => message.sourceIds?.includes(original.id)),
    ).toMatchObject({ content: input.content, sourceIds: [original.id] });
    expect(f.calls()).toBe(callsBefore + 1);
    const snapshot = () => ({
      cursor: f.rows('SELECT last_change_cursor FROM storage_meta'),
      commands: f.rows('SELECT * FROM command ORDER BY id'),
      runs: f.rows('SELECT * FROM run ORDER BY id'),
      executions: f.rows('SELECT * FROM execution ORDER BY id'),
      ledger: readFileSync(f.ledger, 'utf8'),
      calls: f.calls(),
    });
    const before = snapshot();
    expect(JSON.parse((await launch('get')).out).phase).toBe('unknown');
    for (let index = 0; index < 2; index++) {
      const recovered = await launch('normal');
      expect(recovered.code).toBe(0);
      const row = JSON.parse(recovered.out);
      expect(row.phase).toBe('applied');
      expect(row.scope).toEqual({ storeId: f.storeId, workspaceId: 'w', sessionId });
      expect(row.subjectId).toBe(original.subjectId);
      expect(row.bodyDigest).toBe(callerDigest(input));
      expect(row.lookupError).toBeUndefined();
      expect(row.requestDigest).toBe(
        createHash('sha256').update(canonicalCallerCommandRequest(input)).digest('hex'),
      );
    }
    expect(snapshot()).toEqual(before);
    expect(await warm.client.getCommand(input.commandId)).toEqual(original);
    const requests = readFileSync(wire, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(requests.find((request) => request.method === 'POST').body).toEqual(input);
    expect(
      requests
        .filter((request) => request.mode !== 'post')
        .every((request) => request.method === 'GET'),
    ).toBe(true);
    expect(
      requests.filter((request) => request.path === `/v1/commands/${input.commandId}`),
    ).toHaveLength(3);
    writeFileSync(`${wire}.facts.json`, JSON.stringify({ original, run, modelInput, before }));
    console.log('native derived caller retained', wire);
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await warm?.close();
    f.close();
  }
}, 30000);
