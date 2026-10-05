import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient, type Interaction } from '@kite-ai/client';
import type { CLIServiceArtifact } from '../../host';
import { verifyTerminalBundle } from '../../host/terminal-artifact';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const detail = '  原文 café e\u0301 🧭\n第二行保持空格  ';
const custom = '  自定义 / @ 🚚 e\u0301  ';
async function until<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw Error(`owned_question_deadline:${label}`);
    await Bun.sleep(15);
  }
}
type Wire = { method: string; path: string; body?: Record<string, unknown> };

test('actual 80x24 TUI original schema wizard preserves labeled original IDs, edited Unicode text and Custom answer; only final Answer completes original Tool and Run', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-question-'));
  const evidence = `/private/tmp/kite-tui-question-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  const rows = (name: string): Record<string, unknown>[] =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const wire = () => rows('ui-http.jsonl') as Wire[];
  const answers = () =>
    wire().filter((row) => row.method === 'POST' && row.path.endsWith('/answer'));
  let python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let build: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let observer: ReturnType<typeof createClient> | undefined;
  let control: ReturnType<typeof Bun.serve> | undefined;
  const controlWork = new Set<Promise<Response>>();
  const facts: unknown[] = [];
  let original: Interaction | undefined,
    storeId = '',
    sessionId = '';
  let success = false,
    failure: unknown;
  const cleanupErrors: unknown[] = [];
  const observerReads: { method: string; path: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = args[0];
      observerReads.push({
        method: args[1]?.method ?? 'GET',
        path: new URL(request instanceof Request ? request.url : String(request)).pathname,
      });
      return originalFetch(...args);
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const sourceSha256 = Object.fromEntries(
      [
        'packages/agent/src/storage/sqlite/interaction-operations.ts',
        'packages/ui/src/tui/index.tsx',
        'packages/ui/src/tui/question.ts',
        'packages/ui/src/tui/question-panel.tsx',
        'packages/ui/src/tui/presentation.tsx',
        'apps/cli/test/isolated/tui-question-pty.test.ts',
        'apps/cli/test/fixtures/tui-question-pty.ts',
        'apps/cli/test/fixtures/tui-question-pty.py',
      ].map((path) => [path, sha(readFileSync(join(repo, path)))]),
    );
    build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [buildOut, buildErr, buildCode] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidence, 'build.log'), buildOut + buildErr, { mode: 0o600 });
    expect(buildCode).toBe(0);
    const candidate = verifyTerminalBundle(join(root, 'candidate'));
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const compiled = await Bun.build({
      entrypoints: [join(repo, 'apps/cli/test/fixtures/tui-question-pty.ts')],
      outdir: root,
      naming: 'host.js',
      target: 'bun',
      packages: 'external',
    });
    expect(compiled.success).toBe(true);
    const artifact: CLIServiceArtifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      entrypoint: join(root, 'host.js'),
      entrypointSha256: sha(readFileSync(join(root, 'host.js'))),
      buildId: 'owned-question-pty',
      apiMajor: 1,
    };
    facts.push({
      candidateDigest: candidate.digest,
      candidateId: candidate.candidateId,
      artifact,
      sourceSha256,
    });
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ root, workspace, dataRoot: profile.dataRoot, artifact }),
      { mode: 0o600 },
    );
    mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    async function connected() {
      if (observer) return observer;
      const privateObserver = await until('observer', async () =>
        existsSync(join(root, 'observer-private.json'))
          ? (JSON.parse(readFileSync(join(root, 'observer-private.json'), 'utf8')) as {
              endpoint: string;
              token: string;
            })
          : undefined,
      );
      observer = createClient({
        ...privateObserver,
        expected: {
          profile: {
            dataRoot: profile.dataRoot,
            name: profile.profile,
            accessKey: profile.profileAccessKey,
          },
          apiMajor: 1,
          requiredCapabilities: ['interactions', 'commands', 'history'],
        },
      });
      await observer.connect();
      storeId = observer.serverInfo!.storeId!;
      return observer;
    }
    async function pending() {
      const client = await connected();
      const post = await until('run-post', async () =>
        wire().find((row) => row.body?.kind === 'run.start'),
      );
      sessionId = decodeURIComponent(post.path.split('/')[3]!);
      return until('question', async () =>
        (await client.listInteractions(sessionId, { storeId, state: 'pending' })).interactions.find(
          (card) => card.kind === 'question',
        ),
      );
    }
    async function controlRequest(request: Request): Promise<Response> {
      try {
        const stage = new URL(request.url).pathname.slice(1);
        if (
          stage === 'initial' ||
          stage === 'blank' ||
          stage === 'route' ||
          stage === 'back' ||
          stage === 'text' ||
          stage === 'retained' ||
          stage === 'custom'
        ) {
          original ??= await pending();
          expect(answers()).toHaveLength(0);
          const actual = await (await connected()).getInteraction(sessionId, original.id, {
            storeId,
          });
          expect(actual.state).toBe('pending');
          expect(actual.revision).toBe(original.revision);
          expect(actual.executionId).toBe(original.executionId);
          expect(actual.runId).toBe(original.runId);
          expect(actual.definitionId).toBe('fixture.question');
          expect(actual.definitionVersion).toBe('1');
          expect(actual.originStoreId).toBe(storeId);
          expect((await (await connected()).getRun(original.runId!)).status).toBe(
            'waiting_interaction',
          );
          expect(rows('tool.jsonl')).toEqual([{ stage: 'entered' }]);
          facts.push({
            stage,
            interactionId: original.id,
            revision: original.revision,
            runId: original.runId,
            executionId: original.executionId,
            answerPosts: 0,
          });
          return Response.json({ checked: true });
        }
        if (stage === 'finish') {
          expect(original).toBeDefined();
          const run = await until('completed', async () => {
            const row = await (await connected()).getRun(original!.runId!);
            return row.status === 'completed' ? row : undefined;
          });
          expect(run.isActive).toBe(false);
          const answerPosts = answers();
          expect(answerPosts).toHaveLength(1);
          const post = answerPosts[0]!;
          expect(post.path).toBe(`/v1/sessions/${sessionId}/interactions/${original!.id}/answer`);
          expect(post.body!.expectedStoreId).toBe(storeId);
          expect(post.body!.expectedRevision).toBe(original!.revision);
          const expected = { q1: 'route-b', q2: detail, q3: custom };
          expect(post.body!.answer).toEqual({ kind: 'question', answers: expected });
          const saved = await (await connected()).getInteraction(sessionId, original!.id, {
            storeId,
          });
          expect(saved.state).toBe('answered');
          expect(saved.acceptedDecisionRevision).toBe(saved.revision);
          expect(Number(saved.acceptedDecisionRevision)).toBe(Number(original!.revision) + 1);
          expect(saved.runId).toBe(original!.runId);
          expect(saved.executionId).toBe(original!.executionId);
          expect(saved.request).toEqual(original!.request);
          expect(saved.sessionId).toBe(original!.sessionId);
          expect(saved.originStoreId).toBe(original!.originStoreId);
          expect(rows('tool.jsonl')).toEqual([
            { stage: 'entered' },
            { stage: 'answered', answer: expected },
          ]);
          expect(wire().filter((row) => row.body?.kind === 'run.start')).toHaveLength(1);
          expect(observerReads.every((row) => row.method === 'GET')).toBe(true);
          facts.push({ stage, original, saved, run, answerPost: post, tool: rows('tool.jsonl') });
          return Response.json({ checked: true });
        }
        throw Error('owned_question_unknown_control');
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : 'unknown' },
          { status: 500 },
        );
      }
    }
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const work = controlRequest(request);
        controlWork.add(work);
        void work.finally(() => controlWork.delete(work));
        return work;
      },
    });
    python = Bun.spawn(
      [
        'python3',
        join(repo, 'apps/cli/test/fixtures/tui-question-pty.py'),
        control.url.href,
        artifact.executable,
        artifact.entrypoint,
        root,
        evidence,
        detail,
        custom,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    writeFileSync(join(evidence, 'pty.log'), out + err, { mode: 0o600 });
    expect(code).toBe(0);
    const receipt = JSON.parse(readFileSync(join(evidence, 'pty-exit.json'), 'utf8'));
    expect(receipt).toMatchObject({ normalComplete: true, normalCtrlQ: true, exitCode: 0 });
    expect(rows('owned-service.jsonl')).toHaveLength(1);
    expect(rows('service-exit.jsonl')).toEqual([
      { pid: rows('owned-service.jsonl')[0]!.pid, exitCode: 0, returnedAfterCleanup: true },
    ]);
    expect(answers()).toHaveLength(1);
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    observer?.disposeNetwork();
    await control?.stop(true);
    await Promise.allSettled([...controlWork]);
    globalThis.fetch = originalFetch;
    if (python && python.exitCode === null)
      cleanupErrors.push(Error('owned_python_exit_unconfirmed'));
    if (build && build.exitCode === null) cleanupErrors.push(Error('owned_build_exit_unconfirmed'));
    if (controlWork.size) cleanupErrors.push(Error('owned_control_exit_unconfirmed'));
    const services = rows('owned-service.jsonl'),
      exits = rows('service-exit.jsonl');
    for (const service of services)
      if (
        exits.filter(
          (row) => row.pid === service.pid && row.exitCode === 0 && row.returnedAfterCleanup,
        ).length !== 1
      )
        cleanupErrors.push(Error('owned_service_exit_unconfirmed'));
    for (const name of [
      'ui-http.jsonl',
      'tool.jsonl',
      'permissions.jsonl',
      'owned-service.jsonl',
      'service-exit.jsonl',
    ]) {
      if (existsSync(join(root, name)))
        writeFileSync(join(evidence, name), readFileSync(join(root, name)), { mode: 0o600 });
    }
    if (success && !cleanupErrors.length) rmSync(root, { recursive: true, force: true });
    const packet = {
      success,
      cleanupConfirmed: success && !cleanupErrors.length && !existsSync(root),
      retainedRoot: existsSync(root) ? root : null,
      failure: failure instanceof Error ? failure.message : failure ? 'unknown' : null,
      cleanupErrors: cleanupErrors.map((error) =>
        error instanceof Error ? error.message : 'unknown',
      ),
      facts,
      observerReads,
      scope:
        'Explicit fixed-model harmless Tool requestInput with original oneOf labels, bounded string and anyOf Custom; source-free development candidate; actual macOS 80x24 keyboard; no default ask_user or installed/platform qualification',
    };
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(packet, null, 2), { mode: 0o600 });
    console.error(
      JSON.stringify({
        evidence,
        success,
        cleanupConfirmed: packet.cleanupConfirmed,
        retainedRoot: packet.retainedRoot,
      }),
    );
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'owned_question_cleanup_unconfirmed');
  if (failure) throw failure;
}, 180000);
