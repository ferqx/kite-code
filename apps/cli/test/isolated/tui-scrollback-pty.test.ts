import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectProcess } from '@kite-ai/service/daemon';
import { Terminal } from '@xterm/headless';
import { ptyDeadline } from '../fixtures/tui-pty';

type Event =
  | { kind: 'data'; hex: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'mark'; name: string; ack: { storedMessages: number; mutationCalls: number } | null };
const repository = resolve(import.meta.dir, '../../../..');

test('80x24 current material versions preserve native history through status/input, active bodies and long pending questions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-tui-scrollback-'));
  const evidence = `${root}-evidence`;
  mkdirSync(evidence);
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 20000,
    allowProposedApi: true,
  });
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let driverExited = false;
  let fixtureIdentity: { pid: number; start: string } | undefined;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  let cleanupConfirmed = false;
  let success = false;
  const sourcePaths = [
    'packages/ui/src/tui/index.tsx',
    'packages/ui/src/tui/controller.ts',
    'packages/ui/src/tui/question-panel.tsx',
    'packages/ui/src/tui/composer.ts',
    'packages/ui/src/tui/presentation.tsx',
    'apps/cli/test/fixtures/tui-scrollback-pty.tsx',
    'apps/cli/test/fixtures/tui-scrollback-driver.ts',
    'apps/cli/test/fixtures/tui-pty.ts',
    'apps/cli/test/isolated/tui-scrollback-pty.test.ts',
  ];
  const sourceSha256 = Object.fromEntries(
    sourcePaths.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(repository, path)))
        .digest('hex'),
    ]),
  );
  const markers = Array.from({ length: 3 }, (_, round) =>
    Array.from(
      { length: 30 },
      (_, line) => `ROUND_${round + 1}_LINE_${String(line + 1).padStart(2, '0')}`,
    ),
  ).flat();
  const checkpoints: {
    name: string;
    position: { viewportY: number; baseY: number };
    counts: number[];
    bytes: number;
    clearsHistory: boolean;
    emitsHistory: boolean;
    footerPresent: boolean;
    changedCount: number;
    editingPresent: boolean;
    activeCounts: number[];
    questionCounts: number[];
    choiceCounts: number[];
    emitsMaterial: boolean;
    toolBeforeQuestion: boolean;
    lastAnswerLinePresent: boolean;
    collapsedPastePresent: boolean;
    jsonPastePresent: boolean;
    jsonTailPresent: boolean;
    cursorCells: { column: number; text: string }[];
  }[] = [];
  try {
    child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        join(repository, 'apps/cli/test/fixtures/tui-scrollback-driver.ts'),
        root,
        process.execPath,
        join(repository, 'apps/cli/test/fixtures/tui-scrollback-pty.tsx'),
        repository,
      ],
      {
        cwd: repository,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        ipc(message) {
          const value = message as { kind?: string; pid?: number; start?: string };
          if (
            value.kind === 'scrollback-fixture' &&
            Number.isSafeInteger(value.pid) &&
            value.pid! > 0 &&
            typeof value.start === 'string' &&
            value.start
          )
            fixtureIdentity = { pid: value.pid!, start: value.start };
        },
      },
    );
    void child.exited.then(() => {
      driverExited = true;
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    writeFileSync(join(evidence, 'driver.log'), stdout + stderr);
    for (const name of ['events.json', 'host-exit.json'])
      writeFileSync(join(evidence, name), readFileSync(join(root, name)));
    const driver = JSON.parse(readFileSync(join(root, 'events.json'), 'utf8')) as {
      pid: number;
      exitCode: number;
      normalComplete: boolean;
      failure: string | null;
      events: Event[];
    };
    const host = JSON.parse(readFileSync(join(root, 'host-exit.json'), 'utf8'));
    expect(exitCode).toBe(0);
    expect(driver.failure).toBeNull();
    expect(driver.normalComplete).toBe(true);
    expect(driver.exitCode).toBe(0);
    expect(host.pid).toBe(driver.pid);
    expect(host.normalComplete).toBe(true);
    expect(host.mutationCalls).toBe(0);
    let bytes = '';
    for (const event of driver.events) {
      if (event.kind === 'data') {
        const data = Buffer.from(event.hex, 'hex');
        bytes += data.toString('utf8');
        await new Promise<void>((resolve) => terminal.write(data, resolve));
      } else if (event.kind === 'resize') {
        terminal.resize(event.cols, event.rows);
      } else {
        if (['round3', 'active', 'pending', 'pending-choices', 'json'].includes(event.name)) {
          terminal.scrollToBottom();
          terminal.scrollLines(-100);
        }
        const buffer = terminal.buffer.active;
        const text = Array.from({ length: buffer.length }, (_, index) =>
          buffer.getLine(index)?.translateToString(true),
        ).join('\n');
        const cursorCells = Array.from({ length: 24 }, (_, row) => {
          const line = buffer.getLine(buffer.baseY + row);
          return Array.from({ length: 80 }, (_, column) => ({
            column,
            cell: line?.getCell(column),
          }))
            .filter(({ cell }) => cell?.isInverse())
            .map(({ column, cell }) => ({ column, text: cell!.getChars() }));
        }).flat();
        checkpoints.push({
          name: event.name,
          position: { viewportY: buffer.viewportY, baseY: buffer.baseY },
          counts: markers.map((marker) => text.split(marker).length - 1),
          bytes: Buffer.byteLength(bytes),
          clearsHistory: bytes.includes('\u001b[3J'),
          emitsHistory: bytes.includes('ROUND_'),
          footerPresent: text.includes('Session a'),
          changedCount: text.split('SEMANTIC_CHANGED_BODY').length - 1,
          editingPresent: text.includes('editing-safe'),
          activeCounts: Array.from(
            { length: 40 },
            (_, i) => text.split(`ACTIVE_LINE_${String(i + 1).padStart(2, '0')}`).length - 1,
          ),
          questionCounts: Array.from(
            { length: 35 },
            (_, i) => text.split(`QUESTION_LINE_${String(i + 1).padStart(2, '0')}`).length - 1,
          ),
          choiceCounts: Array.from({ length: 2 }, (_, choice) =>
            Array.from(
              { length: 30 },
              (_, line) =>
                text.split(`CHOICE_${choice + 1}_LINE_${String(line + 1).padStart(2, '0')}`)
                  .length - 1,
            ),
          ).flat(),
          emitsMaterial: /ROUND_|ACTIVE_LINE_|QUESTION_LINE_|CHOICE_\d_LINE_/.test(bytes),
          toolBeforeQuestion:
            text.indexOf('OWNED_LONG_QUESTION_TOOL') >= 0 &&
            text.indexOf('OWNED_LONG_QUESTION_TOOL') < text.indexOf('QUESTION_LINE_01'),
          lastAnswerLinePresent: text.includes('ANSWER_LINE_12'),
          collapsedPastePresent: text.includes('[Pasted 179 characters]'),
          jsonPastePresent: text.includes(
            `[Pasted ${
              Array.from(
                JSON.stringify(
                  Array.from(
                    { length: 30 },
                    (_, i) =>
                      `JSON_DRAFT_LINE_${String(i + 1).padStart(2, '0')} 原文 / @ café é 🧭`,
                  ),
                  null,
                  2,
                ),
              ).length
            } characters]`,
          ),
          jsonTailPresent: text.includes('JSON_TYPED_12 原文'),
          cursorCells,
        });
        if (event.ack) expect(event.ack.mutationCalls).toBe(0);
        if (['cleared', 'refreshed', 'changed'].includes(event.name))
          expect(event.ack?.storedMessages).toBe(3);
        bytes = '';
      }
    }
    writeFileSync(join(evidence, 'checkpoints.json'), JSON.stringify(checkpoints, null, 2));
    const at = (name: string) => checkpoints.find((entry) => entry.name === name)!;
    const allOnce = Array.from({ length: 90 }, () => 1);
    expect(at('round1').counts).toEqual(allOnce.map((_, index) => Number(index < 30)));
    expect(at('round2').counts).toEqual(allOnce.map((_, index) => Number(index < 60)));
    for (const name of [
      'round3',
      'status',
      'edited',
      'narrow',
      'restored',
      'body-replaced',
      'session-b',
      'session-a',
    ])
      expect(at(name).counts).toEqual(allOnce);
    expect(at('round3').position.viewportY).toBeLessThan(at('round3').position.baseY);
    for (const name of ['status', 'edited']) {
      expect(at(name).position.viewportY).toBe(at('round3').position.viewportY);
      expect(at(name).clearsHistory).toBe(false);
      expect(at(name).emitsHistory).toBe(false);
    }
    expect(at('edited').editingPresent).toBe(true);
    for (const name of ['cleared', 'refreshed']) {
      expect(at(name).counts).toEqual(allOnce.map(() => 0));
      expect(at(name).footerPresent).toBe(true);
    }
    expect(at('changed').counts).toEqual(allOnce.map((_, index) => Number(index >= 60)));
    expect(at('body-replaced').clearsHistory).toBe(true);
    expect(at('body-replaced').footerPresent).toBe(true);
    for (const name of ['body-replaced', 'changed', 'session-b', 'session-a'])
      expect(at(name).changedCount).toBe(1);
    for (const [baseline, updates] of [
      ['active', ['active-status', 'active-edited']],
      [
        'pending',
        [
          'pending-status',
          'pending-edited',
          'pending-pasted',
          'pending-long-input',
          'pending-visible-end',
          'pending-wrap-next',
        ],
      ],
      ['pending-choices', ['choices-status', 'choices-selected']],
      ['json', ['json-pasted', 'json-status', 'json-edited', 'json-long-input']],
    ] as const) {
      expect(at(baseline).position.viewportY).toBeLessThan(at(baseline).position.baseY);
      expect(at(baseline).position.viewportY).toBe(Math.max(0, at(baseline).position.baseY - 100));
      for (const name of [baseline, ...updates]) {
        expect(at(name).counts).toEqual(allOnce);
        if (baseline === 'active') expect(at(name).activeCounts).toEqual(Array(40).fill(1));
        else {
          expect(at(name).questionCounts).toEqual(Array(35).fill(1));
          expect(at(name).toolBeforeQuestion).toBe(true);
        }
      }
      for (const name of updates) {
        expect(at(name).position.viewportY).toBe(at(baseline).position.viewportY);
        expect(at(name).clearsHistory).toBe(false);
        expect(at(name).emitsMaterial).toBe(false);
      }
    }
    expect(at('active-edited').editingPresent).toBe(true);
    expect(at('pending-edited').editingPresent).toBe(true);
    expect(at('pending-long-input').lastAnswerLinePresent).toBe(true);
    expect(at('pending-pasted').collapsedPastePresent).toBe(true);
    expect(at('pending-visible-end').cursorCells).toEqual([{ column: 79, text: ' ' }]);
    expect(at('pending-wrap-next').cursorCells).toEqual([{ column: 9, text: 'a' }]);
    expect(at('json-pasted').jsonPastePresent).toBe(true);
    expect(at('json-long-input').jsonTailPresent).toBe(true);
    for (const name of ['pending-choices', 'choices-status', 'choices-selected'])
      expect(at(name).choiceCounts).toEqual(Array(60).fill(1));
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    if (child && !driverExited) {
      try {
        child.send('scrollback-driver-stop');
        await ptyDeadline(child.exited, 6000, 'scrollback_driver_cleanup_unknown');
      } catch (error) {
        cleanupErrors.push(error);
        try {
          child.kill('SIGKILL');
          await ptyDeadline(child.exited, 3000, 'scrollback_driver_force_exit_unknown');
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (fixtureIdentity) {
      try {
        const state = inspectProcess(fixtureIdentity.pid, fixtureIdentity.start);
        if (state === 'alive') {
          if (process.platform === 'win32') {
            const terminated = Bun.spawnSync(
              ['taskkill.exe', '/pid', String(fixtureIdentity.pid), '/f'],
              { stdout: 'pipe', stderr: 'pipe' },
            );
            if (terminated.exitCode !== 0)
              cleanupErrors.push(Error('scrollback_owned_fixture_kill_failed'));
          } else process.kill(fixtureIdentity.pid, 'SIGKILL');
          const end = Date.now() + 3000;
          while (inspectProcess(fixtureIdentity.pid, fixtureIdentity.start) !== 'dead') {
            if (Date.now() >= end) {
              cleanupErrors.push(Error('scrollback_owned_fixture_exit_unknown'));
              break;
            }
            await Bun.sleep(20);
          }
          cleanupErrors.push(Error('scrollback_fixture_required_parent_force_cleanup'));
        } else if (state !== 'dead')
          cleanupErrors.push(Error('scrollback_fixture_identity_uncertain'));
        cleanupConfirmed =
          driverExited && inspectProcess(fixtureIdentity.pid, fixtureIdentity.start) === 'dead';
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (child) {
      cleanupErrors.push(Error('scrollback_fixture_identity_missing'));
    }
    terminal.dispose();
    success = success && cleanupConfirmed && cleanupErrors.length === 0;
    if (success) rmSync(root, { recursive: true, force: true });
    writeFileSync(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          success,
          sourceSha256,
          cleanupConfirmed,
          fixtureIdentity,
          failure: failure ? String(failure) : null,
          cleanupErrors: cleanupErrors.map(String),
          retainedRoot: success ? null : root,
          scope: `public source TUI + finite UI port + actual ${process.platform === 'win32' ? 'Bun ConPTY' : 'Bun POSIX PTY'} 80x24 bytes + installed headless VT; no Service/Provider/installed artifact qualification`,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ evidence, success, cleanupConfirmed }));
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure, ...cleanupErrors] : cleanupErrors,
      'scrollback_cleanup_unknown',
    );
  if (failure) throw failure;
}, 20000);
