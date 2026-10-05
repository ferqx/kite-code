import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Terminal } from '@xterm/headless';

type Event =
  | { kind: 'data'; hex: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'mark'; name: string; ack: { storedMessages: number; mutationCalls: number } | null };
const repository = resolve(import.meta.dir, '../../../..');
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;

nativeTest(
  '80x24 completed native history preserves an up-scrolled reader across status/edit and survives semantic reflows once',
  async () => {
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
    let success = false;
    const sourcePaths = [
      'packages/ui/src/tui/index.tsx',
      'packages/ui/src/tui/controller.ts',
      'apps/cli/test/fixtures/tui-scrollback-pty.tsx',
      'apps/cli/test/fixtures/tui-scrollback-pty.py',
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
    }[] = [];
    try {
      child = Bun.spawn(
        [
          'python3',
          join(repository, 'apps/cli/test/fixtures/tui-scrollback-pty.py'),
          root,
          process.execPath,
          join(repository, 'apps/cli/test/fixtures/tui-scrollback-pty.tsx'),
          repository,
        ],
        { cwd: repository, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
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
          if (event.name === 'round3') terminal.scrollLines(-100);
          const buffer = terminal.buffer.active;
          const text = Array.from({ length: buffer.length }, (_, index) =>
            buffer.getLine(index)?.translateToString(true),
          ).join('\n');
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
      success = true;
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      terminal.dispose();
      if (success) rmSync(root, { recursive: true, force: true });
      writeFileSync(
        join(evidence, 'result.json'),
        JSON.stringify(
          {
            success,
            sourceSha256,
            cleanupConfirmed: success,
            retainedRoot: success ? null : root,
            scope:
              'public source TUI + finite UI port + actual macOS/POSIX 80x24 PTY + installed headless VT; no Service/Provider/installed artifact qualification',
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ evidence, success, cleanupConfirmed: success }));
    }
  },
  20000,
);
