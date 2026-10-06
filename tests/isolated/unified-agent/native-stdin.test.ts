import { expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { connectSharedService } from '../../../apps/cli/host/shared-service';
import { buildNativeCandidate } from '../../../apps/desktop/scripts/build-native';
import {
  installNativeBundle,
  uninstallNativeBundle,
} from '../../../scripts/release/native-install';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

test.skipIf(process.platform !== 'darwin')(
  'installed full Native stdin keeps EOF pending and a new CLI process answers exact work once with original IDs and complete semantic text',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-native-stdin-'));
    const diagnostic = `${root}.commands.jsonl`;
    writeFileSync(diagnostic, '', { mode: 0o600 });
    const home = join(root, 'home'),
      workspace = join(home, 'workspace'),
      prefix = join(root, 'installed'),
      socket = join(root, 'daemon.sock');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const profile = selectProfile({
      dataRoot: join(home, '.kite-code/unified-agent'),
      profile: 'default',
    });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const task = '完整 Native stdin 申请\r\n中🪁';
    const questions = {
      questions: [
        {
          question: 'First?',
          options: [
            { label: 'q1-o2', description: 'Exact label', recommended: true },
            { label: 'Second', description: 'Other' },
          ],
        },
        {
          question: 'Free?',
          options: [
            { label: 'One', description: 'One' },
            { label: 'Two', description: 'Two' },
          ],
        },
        {
          question: 'Unicode?',
          options: [
            { label: 'Yes', description: 'Y' },
            { label: 'No', description: 'N' },
          ],
        },
      ],
    };
    const answers = { q1: 'q1-o1', q2: { text: 'q2-o1' }, q3: { text: '  雪🪁\n第二行  ' } };
    const requests: {
      model: string;
      messages: { role: string; content: string }[];
      tools: { function: { name: string } }[];
    }[] = [];
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof requests)[number];
        requests.push(body);
        const asking = requests.length === 1;
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'native-stdin', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame(
            asking
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'original-questions',
                      type: 'function',
                      function: { name: 'ask_user', arguments: JSON.stringify(questions) },
                    },
                  ],
                }
              : { content: 'Finished' },
            null,
          ) +
            frame({}, asking ? 'tool_calls' : 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let installed = false;
    let connection: Awaited<ReturnType<typeof connectSharedService>> | undefined;
    const execute = async (argv: string[], input = '', expectedExit = 0) => {
      const child = Bun.spawn([join(prefix, 'bin/kite'), ...argv], {
        cwd: workspace,
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      try {
        child.stdin.write(input);
        child.stdin.end();
        const [code, stdout, stderr] = await output;
        appendFileSync(diagnostic, `${JSON.stringify({ argv, code, stdout, stderr })}\n`);
        if (code !== expectedExit)
          throw Error(
            `native_stdin_exit:${code}; expected:${expectedExit}; diagnostic:${diagnostic}\n${stdout}\n${stderr}`,
          );
        return { stdout, stderr };
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await output;
        }
      }
    };
    try {
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({
          modelId: 'fixed',
          tools: [],
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
        { mode: 0o600 },
      );
      const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-source') });
      const require = createRequire(resolve(import.meta.dir, '../../../apps/desktop/package.json'));
      const native = await buildNativeCandidate({
        terminalRoot: terminal.root,
        electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
        outdir: join(root, 'native-source'),
      });
      const selected = installNativeBundle({ bundleRoot: native.root, prefix });
      installed = true;
      expect(selected.candidateId).toBe(native.digest);
      rmSync(terminal.root, { recursive: true });
      rmSync(native.root, { recursive: true });
      expect(existsSync(terminal.root)).toBe(false);
      expect(existsSync(native.root)).toBe(false);
      await execute(['server', 'start', '--server', socket, '--workspace', workspace]);
      connection = await connectSharedService({
        profile,
        server: socket,
        workspace,
        requiredCapabilities: ['sessions', 'commands', 'history', 'interactions'],
      });
      expect(connection.bootstrap.buildId).toBe(`native-${native.digest}`);
      expect(connection.bootstrap.profile).toEqual({
        dataRoot: profile.dataRoot,
        name: 'default',
        accessKey: profile.profileAccessKey,
      });
      expect(connection.fixedWorkspace).toBe(workspace);
      expect(connection.bootstrap.dataAvailability).toBe('available');
      if (connection.bootstrap.dataAvailability !== 'available')
        throw Error('native_data_unavailable');
      const storeId = connection.bootstrap.storeId;
      const client = connection.client;
      expect(() => uninstallNativeBundle(prefix)).toThrow('Lock is busy');
      const invalid = `${JSON.stringify({ ...answers, q2: { text: ' \t\n ' } })}\n`;
      const first = await execute(
        [
          'run',
          '--task',
          task,
          '--workspace',
          workspace,
          '--trust-workspace',
          '--full',
          '--server',
          socket,
        ],
        invalid,
        3,
      );
      const original = JSON.parse(first.stdout.match(/^work intent (.+)$/m)![1]!) as {
        storeId: string;
        sessionId: string;
        commandId: string;
      };
      expect(original.storeId).toBe(storeId);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.tools.map((tool) => tool.function.name)).toEqual(['ask_user']);
      expect(
        requests[0]!.messages.filter((message) => message.role === 'user').at(-1)!.content,
      ).toBe(task);
      const request = {
        expectedStoreId: storeId,
        commandId: original.commandId,
        kind: 'run.start',
        content: task,
      };
      const command = await client.getCommand(original.commandId);
      expect(command).toMatchObject({
        id: original.commandId,
        originStoreId: storeId,
        sessionId: original.sessionId,
        kind: 'run.start',
        status: 'applied',
      });
      const receipt = command.receipt;
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        Array.isArray(receipt) ||
        typeof receipt.runId !== 'string'
      )
        throw Error('native_run_receipt_missing');
      const runId = receipt.runId;
      const run = await client.getRun(runId);
      expect(run).toMatchObject({
        originStoreId: storeId,
        sessionId: original.sessionId,
        originCommandId: original.commandId,
        status: 'waiting_interaction',
        isActive: true,
      });
      const cards = (await client.listInteractions(original.sessionId, { storeId, limit: 100 }))
        .interactions;
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card).toMatchObject({
        kind: 'question',
        definitionId: 'ask_user',
        originStoreId: storeId,
        sessionId: original.sessionId,
        presentationSessionId: original.sessionId,
        runId,
        state: 'pending',
        answer: null,
        acceptedDecisionRevision: null,
      });
      expect((card.request as { schema: { required: unknown } }).schema.required).toEqual([
        'q1',
        'q2',
        'q3',
      ]);
      const work = [
        'work',
        original.sessionId,
        '--input',
        JSON.stringify(request),
        '--server',
        socket,
      ];
      const empty = await execute(work, '', 3);
      const emptyOutcome = empty.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((row) => row.kind === 'work.outcome');
      expect(emptyOutcome).toMatchObject({
        commandId: original.commandId,
        sessionId: original.sessionId,
        storeId,
        status: 'waiting_interaction',
        exitCode: 3,
        run: { id: runId, status: 'waiting_interaction' },
      });
      expect(await client.getInteraction(original.sessionId, card.id, { storeId })).toEqual(card);
      expect(await client.getRun(runId)).toEqual(run);
      expect(requests).toHaveLength(1);
      const valid = `${JSON.stringify(answers)}\n`;
      const answered = await execute(work, valid + valid);
      const rows = answered.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(rows.find((row) => row.kind === 'work.outcome')).toMatchObject({
        commandId: original.commandId,
        sessionId: original.sessionId,
        storeId,
        status: 'succeeded',
        exitCode: 0,
        run: { id: runId, status: 'completed' },
      });
      const accepted = rows.filter(
        (row) => row.kind === 'work.event' && row.line.startsWith('answer accepted '),
      );
      expect(accepted).toHaveLength(1);
      const answerId = accepted[0].line.match(/^answer accepted ([^;]+);/)[1] as string;
      const decisionRevision = (BigInt(card.revision) + 1n).toString();
      expect(await client.getCommand(answerId)).toMatchObject({
        id: answerId,
        kind: 'interaction.answer',
        originStoreId: storeId,
        sessionId: original.sessionId,
        status: 'applied',
        receipt: { outcome: 'answer_saved', interactionId: card.id, decisionRevision },
      });
      const saved = await client.getInteraction(original.sessionId, card.id, { storeId });
      expect(saved).toMatchObject({
        id: card.id,
        executionId: card.executionId,
        attempt: card.attempt,
        runId,
        state: 'answered',
        revision: decisionRevision,
        acceptedDecisionRevision: decisionRevision,
        answer: { kind: 'question', answers },
      });
      expect((await client.getExecution(card.executionId)).status).toBe('succeeded');
      expect(requests).toHaveLength(2);
      const semantic = {
        answer: 'First?: q1-o2\nFree?: q2-o1\nUnicode?:   雪🪁\n第二行  ',
        answers: { q1: 'q1-o2', q2: 'q2-o1', q3: answers.q3.text },
      };
      expect(
        JSON.parse(requests[1]!.messages.find((message) => message.role === 'tool')!.content),
      ).toEqual(semantic);
      const view = await client.getView(original.sessionId);
      expect(view.runs).toHaveLength(1);
      const history = await client.listMessages(original.sessionId, {
        afterSeq: '0',
        upperSeq: view.session.nextSeq,
        limit: 200,
      });
      expect(history.length).toBeLessThan(200);
      expect(JSON.parse(history.find((message) => message.role === 'tool')!.content)).toEqual(
        semantic,
      );
      const repeated = await execute(work, valid);
      const repeatedRows = repeated.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(repeatedRows.find((row) => row.kind === 'work.outcome')).toMatchObject({
        commandId: original.commandId,
        status: 'succeeded',
        run: { id: runId, status: 'completed' },
      });
      expect(
        repeatedRows.filter(
          (row) => row.kind === 'work.event' && row.line.startsWith('answer accepted '),
        ),
      ).toHaveLength(0);
      expect(await client.getCommand(original.commandId)).toEqual(command);
      expect(await client.getInteraction(original.sessionId, card.id, { storeId })).toEqual(saved);
      expect((await client.getView(original.sessionId)).runs).toHaveLength(1);
      expect(requests).toHaveLength(2);
      expect(() => uninstallNativeBundle(prefix)).toThrow('Lock is busy');
    } catch (error) {
      console.error(`native_stdin_diagnostic:${diagnostic}`);
      throw error;
    } finally {
      try {
        await connection?.close();
        if (installed) {
          await execute(['server', 'stop', '--server', socket]);
          const status = await execute(['server', 'status', '--server', socket, '--json']);
          expect(JSON.parse(status.stdout).state).toBe('absent');
          uninstallNativeBundle(prefix);
        }
        rmSync(root, { recursive: true });
      } finally {
        provider.stop(true);
      }
    }
  },
  180000,
);
