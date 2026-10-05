import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { launchPairedService } from '@kite-ai/service/paired';
import { createClient, type ExtensionCommandRequest, type ForkSessionRequest } from '../../src';
import {
  canonicalFileRecoveryIntent,
  type FileRecoveryIntent,
  lookupFileRecoveryLeg,
  parseFileRecoveryIntent,
  planFileRecoveryIntent,
  prepareFileRecoveryLeg,
  submitFileRecoveryLeg,
} from '../../src/file-recovery-intent';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const v = await read();
    if (match(v)) return v;
    if (Date.now() > deadline) throw Error('actual_file_recovery_deadline');
    await Bun.sleep(5);
  }
}

test('actual packaged default SDK three scopes seal durable raw digests, independent Ask and lost accepted replies with cold GET-only partial recovery', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-sdk-file-recovery-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const original = Buffer.from(`\uFEFF${'完整原文件 😀 é\r\n'.repeat(14000)}`),
    originalHash = hash(original);
  for (const s of ['session', 'code', 'both', 'drift']) {
    mkdirSync(join(workspace, s));
    writeFileSync(join(workspace, s, 'original.txt'), original);
  }
  const profile = selectProfile({ dataRoot: join(root, 'data-A'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const providerBodies: unknown[] = [],
    steps = new Map<string, number>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      providerBodies.push(body);
      const user = body.messages.filter((m) => m.role === 'user').at(-1)!.content,
        key = user.split(':')[0]!,
        step = steps.get(user) ?? 0;
      steps.set(user, step + 1);
      const session = key.split('_')[0]!,
        round = key.includes('SECOND') ? 'second' : 'first';
      let call: { name: string; input: unknown } | null = null;
      if (step === 0)
        call = { name: 'files.read', input: { path: `${session}/original.txt`, limit: 10000 } };
      if (step === 1) {
        const read = JSON.parse(body.messages.filter((m) => m.role === 'tool').at(-1)!.content) as {
          baseline: unknown;
        };
        call = {
          name: 'files.write',
          input: {
            path: `${session}/original.txt`,
            base: read.baseline,
            content: `${session} ${round} modified\r\n`,
          },
        };
      }
      if (step === 2)
        call = {
          name: 'files.write',
          input: { path: `${session}/${round}-created.txt`, base: null, content: 'new file\r\n' },
        };
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `fixed-${providerBodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${providerBodies.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'actual complete' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [
        { id: 'files.read', definitionVersion: '3' },
        { id: 'files.write', definitionVersion: '2' },
      ],
    }),
  );
  const { buildTerminalBundle } = (await import(
    pathToFileURL(join(import.meta.dir, '../../../../scripts/release/terminal-bundle.ts')).href
  )) as {
    buildTerminalBundle(input: {
      destination: string;
      repositoryRoot: string;
      bunExecutable: string;
    }): Promise<{
      buildId: string;
      artifact: {
        entrypoint: string;
        executable: string;
        runtimeProtection: Parameters<typeof launchPairedService>[0]['runtimeProtection'];
      };
    }>;
  };
  const built = await buildTerminalBundle({
    destination: join(root, 'candidate'),
    repositoryRoot: realpathSync(join(import.meta.dir, '../../../..')),
    bunExecutable: process.execPath,
  });
  const launch = (p: ReturnType<typeof selectProfile>, instanceId: string) =>
    launchPairedService({
      profile: p,
      instanceId,
      entrypoint: built.artifact.entrypoint,
      executable: built.artifact.executable,
      runtimeProtection: built.artifact.runtimeProtection,
      buildId: built.buildId,
      apiMajor: 1,
      requiredCapabilities: [
        'file_recovery',
        'commands',
        'sessions',
        'context',
        'interactions',
        'extensions_actions',
      ],
    });
  const child = await launch(profile, 'actual-A');
  let childB: Awaited<ReturnType<typeof launch>> | undefined;
  const client = child.client,
    storeId = child.bootstrap.storeId!;
  const journalPath = join(root, 'caller-journal.json'),
    journal = new Map<string, FileRecoveryIntent>(),
    journalWrites: {
      sha256: string;
      records: {
        sessionId: string;
        codeId: string | null;
        forkId: string | null;
        codePhase: string | null;
        forkPhase: string | null;
      }[];
    }[] = [],
    actualProofs: unknown[] = [];
  function journalKey(i: FileRecoveryIntent) {
    return i.code?.request.commandId ?? i.fork!.request.commandId;
  }
  async function persist(i: FileRecoveryIntent) {
    const parsed = await parseFileRecoveryIntent(i),
      prior = journal.get(journalKey(i));
    if (prior) expect(canonicalFileRecoveryIntent(parsed)).toBe(canonicalFileRecoveryIntent(prior));
    journal.set(journalKey(i), parsed);
    journalWrites.push({
      sha256: hash(JSON.stringify({ version: 1, records: [...journal.values()] })),
      records: [...journal.values()].map((v) => ({
        sessionId: v.sessionId,
        codeId: v.code?.request.commandId ?? null,
        forkId: v.fork?.request.commandId ?? null,
        codePhase: v.code?.phase ?? null,
        forkPhase: v.fork?.phase ?? null,
      })),
    });
    const pending = `${journalPath}.pending`,
      fd = openSync(pending, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, records: [...journal.values()] }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(pending, journalPath);
    const dir = openSync(root, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  const wire: {
    method: string;
    path: string;
    commandId?: string;
    bodyHash?: string;
    lost: boolean;
  }[] = [];
  let dropPost: string | undefined, dropGet: string | undefined;
  const proxy = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks),
        body = bytes.length ? (JSON.parse(bytes.toString('utf8')) as { commandId?: string }) : null;
      const event = {
        method: req.method!,
        path: req.url!,
        commandId: body?.commandId,
        bodyHash: bytes.length ? hash(bytes) : undefined,
        lost: false,
      };
      wire.push(event);
      if (body?.commandId) {
        const saved = JSON.parse(readFileSync(journalPath, 'utf8')) as {
          records: FileRecoveryIntent[];
        };
        const intent = saved.records.find(
          (i) =>
            i.code?.request.commandId === body.commandId ||
            i.fork?.request.commandId === body.commandId,
        )!;
        const leg = intent.code?.request.commandId === body.commandId ? intent.code : intent.fork;
        expect(leg!.phase).toBe('submitting');
        expect(body).toEqual(leg!.request);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value && key !== 'host')
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const actual = await fetch(`${child.bootstrap.endpoint}${req.url}`, {
          method: req.method,
          headers,
          ...(bytes.length ? { body: bytes } : {}),
        }),
        response = Buffer.from(await actual.arrayBuffer());
      if (
        (dropPost !== undefined && body?.commandId === dropPost) ||
        (dropGet !== undefined && req.method === 'GET' && req.url === dropGet)
      ) {
        dropPost = undefined;
        dropGet = undefined;
        event.lost = true;
        if (req.method === 'GET') {
          res.writeHead(actual.status, {
            'content-type': 'application/json',
            'content-length': response.length,
          });
          res.flushHeaders();
          res.write(response.subarray(0, Math.max(1, Math.floor(response.length / 2))), () =>
            req.socket.destroy(),
          );
        } else req.socket.destroy();
        return;
      }
      const responseHeaders = Object.fromEntries(
        [...actual.headers].filter(
          ([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key),
        ),
      );
      res.writeHead(actual.status, responseHeaders);
      res.end(response);
    } catch (error) {
      console.error('actual_file_recovery_proxy_failure', error);
      res.writeHead(500);
      res.end('owned_proxy_failure');
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw Error('owned_proxy_missing');
  const through = createClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    token: child.bootstrap.token,
    bootstrap: child.bootstrap,
    expected: {
      profile: child.bootstrap.profile,
      apiMajor: 1,
      instanceId: child.bootstrap.instanceId,
      buildId: built.buildId,
      requiredCapabilities: [
        'file_recovery',
        'commands',
        'sessions',
        'context',
        'interactions',
        'extensions_actions',
      ],
    },
  });
  const reader = await openSqliteStore({
    dataRoot: profile.dataRoot,
    profile: profile.profile,
    mode: 'readonly',
  });
  try {
    await through.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'Actual SDK Files',
    });
    const trust = await client.getWorkspaceTrust('w', { storeId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    const points = new Map<string, string>();
    for (const s of ['session', 'code', 'both', 'drift']) {
      await client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${s}`,
        sessionId: s,
        workspaceId: 'w',
        title: s,
      });
      const mode = await client.getPermissionMode(s, { storeId });
      await client.setPermissionMode(s, {
        expectedStoreId: storeId,
        commandId: `full-${s}`,
        mode: 'full',
        ifRevision: mode.revision,
        makeDefault: false,
        ifDefaultRevision: mode.defaultRevision,
      });
      for (const round of ['FIRST', 'SECOND']) {
        const id = `work-${s}-${round}`;
        await client.startRun(s, {
          expectedStoreId: storeId,
          commandId: id,
          kind: 'run.start',
          content: `${s}_${round}: actual read/write/create`,
        });
        const c = await until(
            () => client.getCommand(id),
            (c) => c.status === 'applied',
          ),
          run = await until(
            () => client.getRun((c.receipt as { runId: string }).runId),
            (r) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status),
          );
        expect(run.status).toBe('completed');
        if (round === 'FIRST') {
          const list = await client.listFileCheckpoints(s);
          expect(list.payload.items).toHaveLength(1);
          points.set(s, list.payload.items[0]!.checkpoint.id);
        }
      }
      expect((await client.listFileCheckpoints(s)).payload.items).toHaveLength(2);
    }
    expect(providerBodies).toHaveLength(32);
    const states: FileRecoveryIntent[] = [];
    for (const scope of ['session', 'code', 'both', 'drift'] as const) {
      const observation = await client.getFileCheckpointRecoveryBoundary(scope, points.get(scope)!);
      expect(observation.sessionId).toBe(scope);
      expect(observation.boundary).toBeNull();
      expect(observation.trigger.seq).toBe('3');
      expect(
        (await client.getFileCheckpoint(scope, points.get(scope)!)).payload.files.some(
          (f) => f.status === 'restore',
        ),
      ).toBe(true);
      const current = {
        storeId,
        sessionId: scope,
        workspaceId: 'w',
        subjectId: client.serverInfo!.subjectId!,
        contextSelectionId: observation.contextSelectionId,
      };
      let intent = await planFileRecoveryIntent({
        scope: scope === 'drift' ? 'both' : scope,
        observation,
        subjectId: current.subjectId,
        ...(scope !== 'session'
          ? { code: { commandId: `restore-${scope}`, restoreId: `original-${scope}` } }
          : {}),
        ...(scope !== 'code'
          ? {
              fork: {
                commandId: `fork-${scope}`,
                newSessionId: `branch-${scope}`,
                title: `完整 ${scope} 😀\r\n é`,
              },
            }
          : {}),
      });
      await persist(intent);
      const inodeBefore = statSync(join(workspace, scope, 'original.txt'), {
          bigint: true,
        }).ino.toString(),
        fileBefore = hash(readFileSync(join(workspace, scope, 'original.txt')));
      if (intent.code) {
        const hot = prepareFileRecoveryLeg(intent, 'code', current, { explicitContinue: true });
        await persist(hot.intent);
        if (scope === 'code') {
          const postCount = wire.filter((e) => e.method === 'POST').length;
          const coldPrepared = await parseFileRecoveryIntent(
            JSON.parse(readFileSync(journalPath, 'utf8')).records.find(
              (i: FileRecoveryIntent) => i.sessionId === scope,
            ),
          );
          expect(coldPrepared.code!.phase).toBe('prepared');
          expect(() =>
            prepareFileRecoveryLeg(coldPrepared, 'code', current, { explicitContinue: true }),
          ).toThrow('file_recovery_readonly');
          const queried = await lookupFileRecoveryLeg(coldPrepared, 'code', current, {
            getCommand: (id) => through.getCommand(id),
            getRestoreStatus: (s, p, r) => through.getFileRestoreStatus(s, p, r),
          });
          expect(queried.code!.phase).toBe('unknown');
          expect(await reader.getCommand(coldPrepared.code!.request.commandId)).toBeNull();
          expect(wire.filter((e) => e.method === 'POST')).toHaveLength(postCount);
        }
        dropPost = scope === 'both' ? intent.code!.request.commandId : undefined;
        const submitted = await submitFileRecoveryLeg(hot.intent, 'code', hot.permit, {
          currentScope: () => current,
          persist,
          post: (r) => through.invokeExtension(scope, r as ExtensionCommandRequest),
        });
        intent = submitted.intent;
        await persist(intent);
        if (scope === 'both') {
          expect(intent.code!.phase).toBe('unknown');
          expect(intent.fork!.phase).toBe('not_started');
          expect(await reader.getCommand(intent.fork!.request.commandId)).toBeNull();
        }
        const originalCmd = await client.getCommand(intent.code!.request.commandId);
        expect(originalCmd.requestDigest).toBe(intent.code!.requestDigest);
        expect(originalCmd.subjectId).toBe(current.subjectId);
        const cards = await until(
          () => client.listInteractions(scope, { storeId, state: 'pending', limit: 100 }),
          (p) =>
            p.interactions.some((c) => c.definitionId === 'builtin.files/files.checkpoint.restore'),
        );
        const card = cards.interactions.find(
          (c) => c.definitionId === 'builtin.files/files.checkpoint.restore',
        )!;
        expect(card.runId).toBeNull();
        expect(card.kind).toBe('approval');
        expect(hash(readFileSync(join(workspace, scope, 'original.txt')))).toBe(fileBefore);
        await client.answerInteraction(scope, card.id, {
          expectedStoreId: storeId,
          commandId: `answer-${scope}`,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
        });
        expect(
          (
            await until(
              () => client.getExecution(card.executionId!),
              (e) => ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(e.status),
            )
          ).status,
        ).toBe('succeeded');
        const ports = {
          getCommand: (id: string) => through.getCommand(id),
          getRestoreStatus: (s: string, p: string, r: string) =>
            through.getFileRestoreStatus(s, p, r),
        };
        if (scope === 'both') {
          dropGet = `/v1/commands/${intent.code!.request.commandId}`;
          intent = await lookupFileRecoveryLeg(
            await parseFileRecoveryIntent(
              JSON.parse(readFileSync(journalPath, 'utf8')).records.find(
                (i: FileRecoveryIntent) => i.sessionId === scope,
              ),
            ),
            'code',
            current,
            ports,
          );
          expect(intent.code!.phase).toBe('unknown');
        }
        intent = await lookupFileRecoveryLeg(
          await parseFileRecoveryIntent(intent),
          'code',
          current,
          ports,
        );
        expect(intent.code!.phase).toBe('succeeded');
        actualProofs.push({
          leg: 'code',
          command: await client.getCommand(intent.code!.request.commandId),
          status: await client.getFileRestoreStatus(
            scope,
            intent.checkpoint.id,
            (intent.code!.request.input as { restoreId: string }).restoreId,
          ),
        });
        await persist(intent);
        expect(readFileSync(join(workspace, scope, 'original.txt'))).toEqual(original);
        expect(
          statSync(join(workspace, scope, 'original.txt'), { bigint: true }).ino.toString(),
        ).not.toBe(inodeBefore);
        expect(existsSync(join(workspace, scope, 'first-created.txt'))).toBe(false);
        expect(existsSync(join(workspace, scope, 'second-created.txt'))).toBe(false);
      }
      if (intent.fork) {
        const codeProof = intent.code
          ? {
              command: await client.getCommand(intent.code!.request.commandId),
              restoreStatus: await client.getFileRestoreStatus(
                scope,
                intent.checkpoint.id,
                (intent.code.request.input as { restoreId: string }).restoreId,
              ),
            }
          : undefined;
        if (scope === 'both' || scope === 'drift') {
          const posts = wire.filter((e) => e.method === 'POST').length;
          const executions = (await client.getView(scope)).executions.map((e) => e.id).sort();
          if (scope === 'both')
            writeFileSync(join(workspace, scope, 'original.txt'), 'external edit\r\n');
          else {
            const c = await client.startRun(scope, {
              expectedStoreId: storeId,
              commandId: 'later-distinct-work',
              kind: 'run.start',
              content: 'drift_LATER: actual later write',
            });
            const applied = await until(
              () => client.getCommand(c.id),
              (v) => v.status === 'applied',
            );
            const run = await until(
              () => client.getRun((applied.receipt as { runId: string }).runId),
              (r) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status),
            );
            expect(run.status).toBe('completed');
            expect(run.id).not.toBe(intent.checkpoint.boundary.runId);
            expect((await client.getView(scope)).session.contextSelectionId).toBe(
              current.contextSelectionId,
            );
          }
          const changedDetail = await client.getFileCheckpoint(scope, intent.checkpoint.id);
          actualProofs.push({
            leg: scope === 'both' ? 'current_external_edit' : 'current_later_run',
            detail: changedDetail,
          });
          expect(changedDetail.payload.files.some((f) => f.status !== 'unchanged')).toBe(true);
          const beforeEffects = (await client.getView(scope)).executions.map((e) => e.id).sort();
          expect(() =>
            prepareFileRecoveryLeg(intent, 'fork', current, {
              explicitContinue: true,
              codeProof,
              currentDetail: changedDetail,
            }),
          ).toThrow('file_recovery_code_unconfirmed');
          expect(intent.code!.phase).toBe('succeeded');
          expect(intent.fork!.phase).toBe('not_started');
          expect(await reader.getCommand(intent.fork!.request.commandId)).toBeNull();
          expect(wire.filter((e) => e.method === 'POST')).toHaveLength(posts);
          expect((await client.getView(scope)).executions.map((e) => e.id).sort()).toEqual(
            beforeEffects,
          );
          if (scope === 'both') {
            expect(beforeEffects).toEqual(executions);
            writeFileSync(join(workspace, scope, 'original.txt'), original);
          } else {
            states.push(intent);
            continue;
          }
        }
        const hot = prepareFileRecoveryLeg(intent, 'fork', current, {
          explicitContinue: true,
          ...(codeProof
            ? {
                codeProof,
                currentDetail: await client.getFileCheckpoint(scope, intent.checkpoint.id),
              }
            : {}),
        });
        if (scope === 'both') dropPost = intent.fork!.request.commandId;
        const submitted = await submitFileRecoveryLeg(hot.intent, 'fork', hot.permit, {
          currentScope: () => current,
          persist,
          post: (r) => through.forkSession(scope, r as ForkSessionRequest),
        });
        intent = submitted.intent;
        await persist(intent);
        if (scope === 'both') {
          expect(intent.code!.phase).toBe('succeeded');
          expect(intent.fork!.phase).toBe('unknown');
        }
        intent = await lookupFileRecoveryLeg(
          await parseFileRecoveryIntent(intent),
          'fork',
          current,
          {
            getCommand: (id) => through.getCommand(id),
            getRestoreStatus: (s, p, r) => through.getFileRestoreStatus(s, p, r),
          },
        );
        expect(intent.fork!.phase).toBe('succeeded');
        await persist(intent);
        const c = await client.getCommand(intent.fork!.request.commandId);
        expect(c.requestDigest).toBe(intent.fork!.requestDigest);
        expect(c.sessionId).toBe(intent.fork!.request.newSessionId);
        actualProofs.push({ leg: 'fork', command: c });
        const branch = await client.getView(intent.fork!.request.newSessionId);
        expect(branch.session.rootSessionId).toBe(branch.session.id);
        expect(branch.session.title).toBe(intent.fork!.request.title);
        expect(branch.runs).toHaveLength(0);
        expect(branch.executions).toHaveLength(0);
        expect(branch.messages).toHaveLength(0);
      }
      if (scope === 'session') {
        expect(hash(readFileSync(join(workspace, scope, 'original.txt')))).toBe(fileBefore);
        expect(
          statSync(join(workspace, scope, 'original.txt'), { bigint: true }).ino.toString(),
        ).toBe(inodeBefore);
        expect(existsSync(join(workspace, scope, 'first-created.txt'))).toBe(true);
        expect(
          (await client.getView(scope)).executions.filter(
            (e) => e.definitionId === 'builtin.files/files.checkpoint.restore',
          ),
        ).toHaveLength(0);
      }
      states.push(intent);
    }
    expect(providerBodies).toHaveLength(36);
    const mutations = wire.filter((e) => e.method === 'POST');
    expect(mutations.map((m) => m.commandId).sort()).toEqual([
      'fork-both',
      'fork-session',
      'restore-both',
      'restore-code',
      'restore-drift',
    ]);
    expect(mutations.filter((m) => m.lost)).toHaveLength(2);
    expect(wire.filter((e) => e.method === 'GET' && e.lost)).toHaveLength(1);
    for (const i of states) {
      if (i.code)
        expect((await reader.getCommand(i.code.request.commandId))!.requestDigest).toBe(
          i.code.requestDigest,
        );
      if (i.fork && i.fork.phase !== 'not_started')
        expect((await reader.getCommand(i.fork.request.commandId))!.requestDigest).toBe(
          i.fork.requestDigest,
        );
    }
    const beforeCursor = (await reader.getMetadata()).lastChangeCursor;
    for (const i of states) {
      const current = {
        storeId: i.storeId,
        sessionId: i.sessionId,
        workspaceId: i.workspaceId,
        subjectId: i.subjectId,
      };
      for (const leg of ['code', 'fork'] as const)
        if (i[leg] && i[leg]!.phase !== 'not_started')
          expect(
            (
              await lookupFileRecoveryLeg(await parseFileRecoveryIntent(i), leg, current, {
                getCommand: (id) => through.getCommand(id),
                getRestoreStatus: (s, p, r) => through.getFileRestoreStatus(s, p, r),
              })
            )[leg]!.phase,
          ).toBe('succeeded');
    }
    expect((await reader.getMetadata()).lastChangeCursor).toBe(beforeCursor);
    expect(providerBodies).toHaveLength(36);
    expect(wire.filter((e) => e.method === 'POST')).toHaveLength(5);
    const profileB = selectProfile({ dataRoot: join(root, 'data-B'), profile: 'owned' });
    childB = await launch(profileB, 'actual-B');
    const actualB = {
      storeId: childB.bootstrap.storeId!,
      sessionId: 'both',
      workspaceId: 'w',
      subjectId: childB.client.serverInfo!.subjectId!,
      contextSelectionId: states[2]!.contextSelectionId,
    };
    expect(actualB.storeId).not.toBe(storeId);
    const old = await parseFileRecoveryIntent(states[2]);
    expect(() => prepareFileRecoveryLeg(old, 'fork', actualB, { explicitContinue: true })).toThrow(
      'file_recovery_readonly',
    );
    let foreignGets = 0;
    expect(
      await lookupFileRecoveryLeg(old, 'code', actualB, {
        async getCommand() {
          foreignGets++;
        },
        async getRestoreStatus() {
          foreignGets++;
        },
      }),
    ).toBe(old);
    expect(foreignGets).toBe(0);
    expect(old.storeId).toBe(storeId);
    writeFileSync(
      join(root, 'evidence.json'),
      JSON.stringify(
        {
          buildId: built.buildId,
          root,
          storeId,
          foreignStoreId: actualB.storeId,
          providerCalls: providerBodies.length,
          cursor: beforeCursor,
          originalBytes: original.length,
          originalHash,
          states,
          journalWrites,
          actualProofs,
          wire,
        },
        null,
        2,
      ),
    );
    console.log('actual_file_recovery_evidence', root, built.buildId);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await reader.close();
    await childB?.close();
    await child.close();
    provider.stop(true);
  }
}, 60000);
