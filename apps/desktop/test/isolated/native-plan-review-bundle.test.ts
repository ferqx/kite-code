import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../scripts/build-native';

const require = createRequire(import.meta.url);
test.skipIf(process.platform !== 'darwin')(
  'relocated source-free Native Plan reviews preserve exact feedback, independent Ask approval, real Files progress and cold Store proofs',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-plan-review-bundle-'));
    const home = join(root, 'home'),
      moved = join(root, 'relocated');
    mkdirSync(home, { mode: 0o700 });
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    const bodies: {
      tools?: { function: { name: string } }[];
      messages: { role: string; content?: unknown }[];
    }[] = [];
    const questionsReady = new Map<number, () => void>();
    let provider: ReturnType<typeof Bun.serve> | undefined;
    let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    const fixtureLeases: ReturnType<typeof acquireArtifactAccess>[] = [];
    try {
      const releaseModule = resolve(
        import.meta.dir,
        '../../../../scripts/release/terminal-bundle.ts',
      );
      const { buildTerminalBundle } = await import(releaseModule);
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
      const electronDist = resolve(dirname(dirname(require('electron') as string)), '../..');
      const source = join(root, 'source-candidate');
      const built = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist,
        outdir: source,
      });
      renameSync(source, moved);
      rmSync(terminal.root, { recursive: true, force: true });
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
      // SQLite selection is process-wide: use the candidate's pinned engine before
      // the fixture's first database/Worker, and retain that original asset for cold reads.
      const original = verifyNativeRuntimeBundle(moved);
      fixtureLeases.push(acquireArtifactAccess({ root: moved, mode: 'shared' }));
      fixtureLeases.push(acquireArtifactAccess({ root: original.terminal.root, mode: 'shared' }));
      initializeSqliteEngine({
        root: join(original.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
        manifestSha256: original.terminal.manifest.sqlite.manifestSha256,
      });
      const seed = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      let storeId: string;
      try {
        storeId = (await seed.getMetadata()).storeId;
        await seed.createWorkspace({
          expectedStoreId: storeId,
          id: 'w',
          name: 'Plan review',
          rootUri: new URL(`file://${workspace}`).href,
        });
        for (const id of ['a', 'b', 'd', 'c'])
          await seed.createSession({
            expectedStoreId: storeId,
            subjectId: 'local-user',
            commandId: `create-${id}`,
            sessionId: id,
            workspaceId: 'w',
            title: `Plan ${id.toUpperCase()}`,
          });
      } finally {
        await seed.close();
      }
      const feedback = '  修改原计划 🪁\n保持组合字符 e\u0301 与空格  ';
      const bodyText =
        '# Original Unicode plan\n' + '完整正文 雪🙂 e\u0301\n'.repeat(3000) + '\n原完整正文尾部';
      const stages = new Map<string, number>();
      const pointers = new Map<string, { planId: string; version: number; digest: string }>();
      const callNames = new Map<string, string>();
      const observed: { sessionId: string; decision: string; feedback: string | undefined }[] = [];
      provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/count') return new Response(String(bodies.length));
          if (url.pathname === '/metadata') return Response.json({ feedback, bodyText });
          if (url.pathname === '/quit-facts') {
            const reader = await openSqliteStore({
              dataRoot: profile.dataRoot,
              profile: profile.profile,
              mode: 'readonly',
            });
            try {
              const sessions = [];
              for (const sessionId of ['a', 'b', 'd', 'c']) {
                const executions = await reader.listExecutions(sessionId);
                const runIds = [
                  ...new Set(
                    executions.flatMap((execution) => (execution.runId ? [execution.runId] : [])),
                  ),
                ];
                sessions.push({
                  sessionId,
                  runs: await Promise.all(
                    runIds.map(async (id) => {
                      const run = await reader.getRun(id);
                      return run
                        ? {
                            id: run.id,
                            status: run.status,
                            isActive: run.isActive,
                            originCommandId: run.originCommandId,
                          }
                        : null;
                    }),
                  ),
                  nonterminalExecutions: executions
                    .filter((execution) =>
                      ['planned', 'dispatching', 'running', 'outcome_unknown'].includes(
                        execution.status,
                      ),
                    )
                    .map((execution) => ({
                      id: execution.id,
                      runId: execution.runId,
                      definitionId: execution.definitionId,
                      kind: execution.kind,
                      status: execution.status,
                      originCommandId: execution.originCommandId,
                    })),
                });
              }
              return Response.json({ storeId: (await reader.getMetadata()).storeId, sessions });
            } finally {
              await reader.close();
            }
          }
          if (url.pathname === '/continue') {
            const release = questionsReady.get(Number(url.searchParams.get('request')));
            if (!release) return new Response('original request not held', { status: 409 });
            questionsReady.delete(Number(url.searchParams.get('request')));
            release();
            return new Response('released');
          }
          const body = (await request.json()) as (typeof bodies)[number];
          bodies.push(body);
          const serial = bodies.length;
          const frame = (delta: unknown, reason: string | null) =>
            `data: ${JSON.stringify({ id: `plan-${serial}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
          if (
            JSON.stringify(body.messages).includes('NATIVE_PARENT_B') &&
            !JSON.stringify(body.messages).includes('NATIVE_PLAN_B')
          ) {
            await new Promise<void>((release) => questionsReady.set(serial, release));
            return new Response(
              frame({ content: 'Original parent completed' }, null) +
                frame({}, 'stop') +
                'data: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          const serialized = JSON.stringify(body.messages);
          const sessionId = ['a', 'b', 'd', 'c'].find((id) =>
            serialized.includes(`NATIVE_PLAN_${id.toUpperCase()}`),
          )!;
          expect(sessionId).toBeDefined();
          const stage = stages.get(sessionId) ?? 0;
          stages.set(sessionId, stage + 1);
          if (stage === 0)
            await new Promise<void>((release) => questionsReady.set(serial, release));
          const toolMessage = [...body.messages]
            .reverse()
            .find((message) => message.role === 'tool') as
            | { content: string; tool_call_id?: string }
            | undefined;
          let value: any;
          if (toolMessage) {
            try {
              value = JSON.parse(toolMessage.content);
            } catch {}
          }
          const previous = toolMessage?.tool_call_id
            ? callNames.get(toolMessage.tool_call_id)
            : undefined;
          if (previous?.startsWith('planning.') && value === undefined) {
            // Preserve the actual semantic failure while letting Electron observe and report it.
            const failure = {
              sessionId,
              toolCallId: toolMessage?.tool_call_id,
              definitionId: previous,
              content: toolMessage?.content.slice(0, 3000),
            };
            console.error('provider_actual_tool_failure', JSON.stringify(failure));
            let diagnostic: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
            try {
              diagnostic = await openSqliteStore({
                dataRoot: profile.dataRoot,
                profile: profile.profile,
                mode: 'readonly',
              });
              const executions = (await diagnostic.listExecutions(sessionId)).filter(
                (execution) => execution.kind === 'tool',
              );
              const runIds = [
                ...new Set(
                  executions.flatMap((execution) => (execution.runId ? [execution.runId] : [])),
                ),
              ];
              console.error(
                'provider_actual_store_failure',
                JSON.stringify({
                  storeId: (await diagnostic.getMetadata()).storeId,
                  runs: await Promise.all(runIds.map((id) => diagnostic!.getRun(id))),
                  executions: executions.map((execution) => ({
                    id: execution.id,
                    runId: execution.runId,
                    definitionId: execution.definitionId,
                    definitionVersion: execution.definitionVersion,
                    status: execution.status,
                    result: execution.result,
                    ...(execution.definitionId === 'planning.review'
                      ? {
                          input: JSON.stringify(execution.input).slice(0, 3000),
                          inputKeys:
                            execution.input &&
                            typeof execution.input === 'object' &&
                            !Array.isArray(execution.input)
                              ? Object.keys(execution.input)
                              : null,
                        }
                      : {}),
                  })),
                  interactions: (
                    await diagnostic.listInteractions({ expectedStoreId: storeId, sessionId })
                  ).interactions.map((card) => ({
                    id: card.id,
                    runId: card.runId,
                    executionId: card.executionId,
                    kind: card.kind,
                    state: card.state,
                    revision: card.revision,
                    acceptedDecisionRevision: card.acceptedDecisionRevision,
                    request: card.request,
                    answer: card.answer,
                  })),
                }),
              );
            } catch (error) {
              console.error(
                'provider_actual_store_diagnostic_unavailable',
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              await diagnostic?.close();
            }
            return new Response(
              frame(
                {
                  content: `Controlled Provider stopped after actual ${previous} semantic failure`,
                },
                null,
              ) +
                frame({}, 'stop') +
                'data: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          if (previous === 'planning.write') {
            // Assert scalar values without applying asymmetric matchers to a reused request object.
            expect(value.planId).toBe(`p-${sessionId}`);
            expect(typeof value.digest).toBe('string');
            expect(/^[a-f0-9]{64}$/.test(value.digest)).toBe(true);
            expect(Number.isInteger(value.version) && value.version >= 1).toBe(true);
            expect(Object.keys(value).sort()).toEqual(['digest', 'planId', 'version']);
            pointers.set(sessionId, {
              planId: value.planId,
              version: value.version,
              digest: value.digest,
            });
            console.log(
              'provider_actual_planning_pointer',
              JSON.stringify({
                sessionId,
                toolCallId: toolMessage?.tool_call_id,
                content: toolMessage?.content.slice(0, 3000),
                parsed: JSON.stringify(value).slice(0, 3000),
              }),
            );
          }
          if (previous === 'planning.review') {
            expect(value.decision).toBe(
              sessionId === 'd'
                ? 'deny'
                : sessionId === 'a' && pointers.get(sessionId)!.version === 1
                  ? 'revise'
                  : 'approve',
            );
            if (value.decision === 'revise') expect(value.feedback).toBe(feedback);
            observed.push({ sessionId, decision: value.decision, feedback: value.feedback });
          }
          let name: string | undefined, input: unknown;
          const pointer = pointers.get(sessionId);
          const planWrite = (version: number | null, text: string) => ({
            planId: `p-${sessionId}`,
            expectedVersion: version,
            title: `Original ${sessionId} plan`,
            body: text,
            steps: [{ id: 'write', title: 'Write the approved file and verify its receipt' }],
          });
          if (stage === 0) {
            name = 'files.write';
            input = {
              path: `blocked-${sessionId}-0.txt`,
              base: null,
              content: 'must remain absent',
            };
          } else if (!pointer) {
            name = 'planning.write';
            input = planWrite(null, sessionId === 'a' ? bodyText : `Original ${sessionId} body`);
          } else if (previous === 'planning.write') {
            name = 'files.write';
            input = {
              path: `blocked-${sessionId}-${pointer!.version}.txt`,
              base: null,
              content: 'must remain absent',
            };
          } else if (
            previous === 'files.write' &&
            value?.baseline === undefined &&
            value?.content === undefined &&
            !value?.path
          ) {
            name = 'planning.review';
            input = pointer;
          } else if (previous === 'planning.review' && value.decision === 'revise') {
            // The exact accepted review result, rather than a request counter, drives v2.
            expect(value).toEqual({ status: 'not_approved', decision: 'revise', feedback });
            name = 'planning.write';
            input = planWrite(1, `# Revised original plan\n${value.feedback}\n新版正文尾部`);
          } else if (previous === 'planning.review' && value.decision === 'approve') {
            expect(value.mode).toBe(sessionId === 'a' ? 'auto' : 'accept_edits');
            name = 'files.write';
            input = {
              path: `effect-${sessionId}.txt`,
              base: null,
              content: `approved ${sessionId} exact effect\n雪🙂`,
            };
          } else if (previous === 'files.write' && value?.path) {
            const reader = await openSqliteStore({
              dataRoot: profile.dataRoot,
              profile: profile.profile,
              mode: 'readonly',
            });
            try {
              const execution = (await reader.listExecutions(sessionId)).find(
                (e) => e.definitionId === 'files.write' && e.status === 'succeeded',
              )!;
              expect(execution).toBeDefined();
              name = 'planning.update';
              input = {
                ...pointer,
                runId: execution.runId,
                expectedProgressRevision: null,
                stepId: 'write',
                status: 'completed',
                executionId: execution.id,
                completePlan: true,
              };
            } finally {
              await reader.close();
            }
          } else if (previous === 'planning.review' && value.decision === 'deny') {
            name = 'files.write';
            input = { path: 'denied-effect.txt', base: null, content: 'must remain absent' };
          }
          // Denial's refused effect must reach a real unsuccessful completion, not cancel.
          if (sessionId === 'd' && stage >= 5) name = undefined;
          const id = `native-plan-call-${serial}`;
          if (name) callNames.set(id, name);
          if (name === 'planning.review') {
            const argumentsJson = JSON.stringify(input) ?? 'undefined';
            const schema = (
              body.tools?.find((tool) => tool.function.name === 'planning.review')?.function as
                | { parameters?: unknown }
                | undefined
            )?.parameters;
            console.log(
              'provider_actual_review_emit',
              JSON.stringify({
                sessionId,
                toolCallId: id,
                arguments: argumentsJson.slice(0, 3000),
                argumentBytes: Buffer.byteLength(argumentsJson),
                keys: input && typeof input === 'object' ? Object.keys(input) : null,
                schema: JSON.stringify(schema)?.slice(0, 3000),
                pointer: JSON.stringify(pointer)?.slice(0, 3000),
              }),
            );
          }
          return new Response(
            frame(
              name
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id,
                        type: 'function',
                        function: { name, arguments: JSON.stringify(input) },
                      },
                    ],
                  }
                : { content: 'Exact original plan task finished' },
              null,
            ) +
              frame({}, name ? 'tool_calls' : 'stop') +
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
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
          tools: [{ id: 'files.write', definitionVersion: '2' }],
        }),
      );
      const fixture = join(root, 'driver.ts');
      writeFileSync(
        fixture,
        readFileSync(
          resolve(import.meta.dir, '../native-plan-review-electron.fixture.ts'),
          'utf8',
        ).replace(
          "import { _electron } from 'playwright';",
          `import {createRequire} from 'node:module';const {_electron}=createRequire(${JSON.stringify(resolve(import.meta.dir, '../../package.json'))})('playwright');`,
        ),
      );
      const result = await Bun.build({
        entrypoints: [fixture],
        target: 'node',
        format: 'esm',
        packages: 'external',
        outdir: root,
        naming: 'driver.js',
      });
      expect(result.success).toBe(true);
      driver = Bun.spawn(
        [
          realpathSync(Bun.which('node')!),
          join(root, 'driver.js'),
          moved,
          home,
          provider.url.href.replace(/\/$/, ''),
          storeId,
        ],
        {
          cwd: home,
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        },
      );
      const out = new Response(driver.stdout).text(),
        err = new Response(driver.stderr).text();
      const timer = setTimeout(() => driver!.kill('SIGKILL'), 65000);
      try {
        const code = await driver.exited,
          stdout = await out,
          stderr = await err;
        if (code)
          console.error({
            stdout,
            stderr,
            providerRequests: bodies.length,
            providerRoles: bodies.map((body) => body.messages.map((message) => message.role)),
          });
        else console.log(stdout);
        expect(code).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      expect(observed).toEqual([
        { sessionId: 'a', decision: 'revise', feedback },
        { sessionId: 'a', decision: 'approve', feedback: undefined },
        { sessionId: 'b', decision: 'approve', feedback: undefined },
        { sessionId: 'd', decision: 'deny', feedback: '原拒绝理由 雪🙂' },
      ]);
      const reviewRequests: {
        purpose: string;
        reviewer: { id: string; modelId: string };
        originCommandRequest: { content: string };
        rootWorkRequest: { content: string };
        target: {
          executionId: string;
          runId: string;
          sessionId: string;
          originStoreId: string;
          definitionId: string;
          definitionVersion: string;
          input: { path: string };
        };
      }[] = [];
      for (const body of bodies) {
        const reviews = body.messages.flatMap((message) => {
          if (message.role !== 'user' || typeof message.content !== 'string') return [];
          try {
            const payload = JSON.parse(message.content);
            return payload?.purpose === 'authorization_review' ? [payload] : [];
          } catch {
            return [];
          }
        });
        if (reviews.length) {
          // Auto's actual review child has one Model call and no Tool catalog.
          // Identify it by the expanded review purpose and original target, not by an empty list.
          expect(reviews).toHaveLength(1);
          expect(body.tools ?? []).toEqual([]);
          const review = reviews[0] as (typeof reviewRequests)[number];
          expect(review.reviewer.id).toBe('builtin.auto');
          expect(review.reviewer.modelId).toBe('fixed');
          expect(review.originCommandRequest.content).toBe('NATIVE_PLAN_A exact original task');
          expect(review.rootWorkRequest.content).toBe('NATIVE_PLAN_A exact original task');
          expect(review.target.originStoreId).toBe(storeId);
          expect(review.target.sessionId).toBe('a');
          expect(review.target.definitionId).toBe('files.write');
          expect(review.target.definitionVersion).toBe('2');
          expect(review.target.input.path).toBe('effect-a.txt');
          reviewRequests.push(review);
          console.log(
            'provider_actual_authorization_review',
            JSON.stringify({ purpose: review.purpose, target: review.target }),
          );
        } else if (
          !JSON.stringify(body.messages).includes('NATIVE_PARENT_B') ||
          JSON.stringify(body.messages).includes('NATIVE_PLAN_B')
        )
          expect(body.tools?.some((tool) => tool.function.name === 'planning.write')).toBe(true);
      }
      expect(reviewRequests).toHaveLength(1);
      const report = JSON.parse(readFileSync(join(home, 'plan-review-report.json'), 'utf8')) as {
        cards: {
          id: string;
          runId: string;
          executionId: string;
          commandId?: string;
          sessionId: string;
          decision?: string;
          mode?: string;
          version: string;
          request: any;
        }[];
        runs: {
          sessionId: string;
          id: string;
          status: 'completed' | 'failed' | 'cancelled';
          commandId: string;
        }[];
        management: {
          id: string;
          runId: string;
          sessionId: string;
          executionId: string;
          definitionId: string;
          request: any;
          completeHash?: string;
          commandId: string;
        }[];
        filesApprovals: {
          id: string;
          runId: string;
          sessionId: string;
          executionId: string;
          request: any;
          commandId: string;
        }[];
        expectedPosts: number;
        childPid: number;
        providerRequestsBeforeCancel: number;
        exitChoice: { calls: number; response: number; via: string; options: unknown };
      };
      expect(report.providerRequestsBeforeCancel).toBe(bodies.length);
      expect(report.exitChoice).toEqual({
        calls: 1,
        response: 1,
        via: 'one-shot-fixture-dialog-port',
        options: {
          type: 'warning',
          message: '仍有活动工作，或尚不能完整核实。退出会停止本应用拥有的服务。',
          buttons: ['保留服务', '退出'],
          defaultId: 0,
          cancelId: 0,
        },
      });
      expect(report.filesApprovals).toHaveLength(2);
      const reviewedFile = report.filesApprovals.find((approval) => approval.sessionId === 'a')!;
      expect(reviewRequests[0]!.target.executionId).toBe(reviewedFile.executionId);
      expect(reviewRequests[0]!.target.runId).toBe(reviewedFile.runId);
      expect(report.expectedPosts).toBe(
        report.management.length + 4 + report.filesApprovals.length,
      );
      expect(() => process.kill(report.childPid, 0)).toThrow();
      // Cold reads happen only after the actual owned Service child is dead.
      const verified = verifyNativeRuntimeBundle(moved);
      const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
      let cold: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
      try {
        leases.push(acquireArtifactAccess({ root: moved, mode: 'shared' }));
        leases.push(acquireArtifactAccess({ root: verified.terminal.root, mode: 'shared' }));
        const engine = initializeSqliteEngine({
          root: join(verified.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
          manifestSha256: verified.terminal.manifest.sqlite.manifestSha256,
        });
        expect(engine.version).toBe(verified.terminal.manifest.sqlite.version);
        expect(engine.sourceId).toBe(verified.terminal.manifest.sqlite.sourceId);
        cold = await openSqliteStore({
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          mode: 'readonly',
        });
        const cursor = (await cold.getMetadata()).lastChangeCursor;
        expect((await cold.getMetadata()).storeId).toBe(storeId);
        for (const original of report.management) {
          const card = (
            await cold.listInteractions({ expectedStoreId: storeId, sessionId: original.sessionId })
          ).interactions.find((card) => card.id === original.id)!;
          expect(card).toMatchObject({
            kind: 'approval',
            runId: original.runId,
            executionId: original.executionId,
            state: 'answered',
            acceptedDecisionRevision: '2',
            originStoreId: storeId,
            sessionId: original.sessionId,
            presentationSessionId: original.sessionId,
          });
          expect(card.request).toEqual(original.request);
          expect(card.answer).toEqual({
            kind: 'approval',
            decision: 'approve',
            grant: 'approve_once',
          });
          expect((await cold.getCommand(original.commandId))?.receipt).toMatchObject({
            outcome: 'answer_saved',
            interactionId: original.id,
            cancelled: false,
          });
          const execution = await cold.getExecution(original.executionId);
          expect(execution).toMatchObject({
            definitionId: original.definitionId,
            definitionVersion: '1',
            runId: original.runId,
            originStoreId: storeId,
            sessionId: original.sessionId,
            status:
              original.sessionId === 'c' && original.definitionId === 'planning.review'
                ? 'outcome_unknown'
                : 'succeeded',
          });
          if (original.completeHash) {
            expect(original.completeHash).toBe(original.request.approvalRequestDigest);
            expect(original.request.policy.review.reference.scope).toEqual({
              kind: 'execution',
              id: original.executionId,
            });
            expect(Number(original.request.policy.review.reference.size)).toBeGreaterThan(32768);
          }
        }
        for (const original of report.filesApprovals) {
          const card = (
            await cold.listInteractions({ expectedStoreId: storeId, sessionId: original.sessionId })
          ).interactions.find((card) => card.id === original.id)!;
          expect(card).toMatchObject({
            kind: 'approval',
            runId: original.runId,
            executionId: original.executionId,
            state: 'answered',
            acceptedDecisionRevision: '2',
            originStoreId: storeId,
            sessionId: original.sessionId,
            presentationSessionId: original.sessionId,
            definitionId: 'files.write',
            definitionVersion: '2',
          });
          expect(card.request).toEqual(original.request);
          expect(card.answer).toEqual({
            kind: 'approval',
            decision: 'approve',
            grant: 'approve_once',
          });
          expect((await cold.getCommand(original.commandId))?.receipt).toMatchObject({
            outcome: 'answer_saved',
            interactionId: original.id,
            cancelled: false,
          });
          expect((await cold.getExecution(original.executionId))?.status).toBe('succeeded');
        }
        for (const original of report.cards) {
          const card = (
            await cold.listInteractions({ expectedStoreId: storeId, sessionId: original.sessionId })
          ).interactions.find((card) => card.id === original.id)!;
          expect(card).toMatchObject({ runId: original.runId, executionId: original.executionId });
          expect(card.request).toEqual(original.request);
          if (original.decision === 'revise') expect(card.answer).toMatchObject({ feedback });
          const reviewExecution = await cold.getExecution(original.executionId);
          if (original.decision)
            expect(reviewExecution?.result).toMatchObject({
              outcome: 'succeeded',
              details: {
                decision: original.decision,
                ...(original.decision === 'revise' ? { feedback } : {}),
              },
            });
          else {
            expect(original.sessionId).toBe('c');
            expect(card.state).toBe('cancelled');
            expect(card.originStoreId).toBe(storeId);
            expect(card.sessionId).toBe('c');
            expect(card.answer).toBeNull();
            expect(card.acceptedDecisionRevision).toBeNull();
            expect(reviewExecution).toMatchObject({
              id: original.executionId,
              sessionId: original.sessionId,
              originStoreId: storeId,
              runId: original.runId,
              definitionId: 'planning.review',
              status: 'outcome_unknown',
              result: {
                outcome: 'outcome_unknown',
                details: { dispatchCommitted: true, adapterAttempted: true },
              },
            });
            expect((await cold.getRun(original.runId))?.status).toBe('cancelled');
          }
          if (original.decision) {
            expect(card.state).toBe('answered');
            expect(card.answer).toMatchObject({
              kind: 'plan_review',
              decision: original.decision,
              ...(original.mode ? { mode: original.mode } : {}),
            });
            expect((await cold.getCommand(original.commandId!))?.receipt).toMatchObject({
              outcome: 'answer_saved',
              interactionId: original.id,
              cancelled: false,
            });
          }
          const approval = await cold.getExtensionRecord({
            sessionId: original.sessionId,
            extensionId: 'builtin.planning',
            key: `run/${original.runId}/approval/p-${original.sessionId}/${original.version}`,
          });
          if (original.decision === 'approve')
            expect(approval?.value).toMatchObject({
              proof: { interactionId: original.id, answer: { mode: original.mode } },
            });
          else expect(approval).toBeNull();
          if (original.request.policy) {
            const metadata = original.request.policy.review;
            const seal = await cold.getExtensionRecord({
              sessionId: original.sessionId,
              extensionId: 'builtin.planning',
              key: `review.body/${original.executionId}`,
            });
            expect(seal?.value).toMatchObject({
              hash: metadata.hash,
              reference: metadata.reference,
              runId: original.runId,
              originStoreId: storeId,
              planRecordRevision: metadata.planRecordRevision,
            });
            const plan = (await cold.getExtensionRecord({
              sessionId: original.sessionId,
              extensionId: 'builtin.planning',
              key: 'plan/p-a/1',
            }))!.value as any;
            expect(plan.body).toBe(bodyText);
            const canonical = (v: any): string =>
              v === null || typeof v !== 'object'
                ? JSON.stringify(v)
                : Array.isArray(v)
                  ? `[${v.map(canonical).join(',')}]`
                  : `{${Object.keys(v)
                      .sort()
                      .map((key) => `${JSON.stringify(key)}:${canonical(v[key])}`)
                      .join(',')}}`;
            const bytes = Buffer.from(canonical(plan));
            expect(bytes.length).toBeGreaterThan(32768);
            expect(metadata.reference.size).toBe(String(bytes.length));
            expect(metadata.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
          }
        }
        for (const run of report.runs) {
          expect((await cold.getRun(run.id))?.status).toBe(run.status);
          const command = await cold.getCommand(run.commandId);
          expect(command?.request).toMatchObject({
            extensionInputs: [
              { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
            ],
          });
          const request = command!.request as { kind: string; afterRunId: string };
          expect(request.kind).toBe(run.sessionId === 'b' ? 'input.follow_up' : 'run.start');
          if (request.kind === 'input.follow_up') {
            expect(request.afterRunId).not.toBe(run.id);
            expect((await cold.getRun(request.afterRunId))?.status).toBe('completed');
          }
          const executions = (await cold.listExecutions(run.sessionId)).filter(
            (e) => e.runId === run.id,
          );
          const effects = executions.filter(
            (e) => e.definitionId === 'files.write' && e.status === 'succeeded',
          );
          if (['a', 'b'].includes(run.sessionId)) {
            expect(effects).toHaveLength(1);
            expect(readFileSync(join(workspace, `effect-${run.sessionId}.txt`), 'utf8')).toBe(
              `approved ${run.sessionId} exact effect\n雪🙂`,
            );
            const approvals = (
              await cold.listInteractions({ expectedStoreId: storeId, sessionId: run.sessionId })
            ).interactions.filter(
              (card) => card.kind === 'approval' && card.executionId === effects[0]!.id,
            );
            expect(approvals).toHaveLength(1);
            expect(approvals[0]!.answer).toMatchObject({
              decision: 'approve',
              grant: 'approve_once',
            });
            expect(
              (
                await cold.getExtensionRecord({
                  sessionId: run.sessionId,
                  extensionId: 'builtin.planning',
                  key: `progress/p-${run.sessionId}/${run.sessionId === 'a' ? 2 : 1}`,
                })
              )?.value,
            ).toMatchObject({
              completePlan: true,
              runId: run.id,
              steps: { write: { status: 'completed' } },
            });
          } else expect(effects).toHaveLength(0);
        }
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
      } finally {
        await cold?.close();
        for (const lease of leases.reverse()) lease.release();
      }
      expect(verifyNativeRuntimeBundle(moved).digest).toBe(built.digest);
    } finally {
      if (driver && driver.exitCode === null) {
        driver.kill('SIGKILL');
        await driver.exited;
      }
      for (const release of questionsReady.values()) release();
      provider?.stop(true);
      // Only actual command paths inside this exact disposable candidate are eligible.
      for (const line of String(execFileSync('/bin/ps', ['-axo', 'pid=,command=']))
        .trim()
        .split('\n')) {
        const row = line.trim().match(/^(\d+)\s+(.+)$/);
        if (row?.[2]?.includes(`${moved}/`))
          try {
            process.kill(Number(row[1]), 'SIGKILL');
          } catch {}
      }
      for (const lease of fixtureLeases.reverse()) lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
