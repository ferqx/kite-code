import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { expect, test } from '#kite-test';
import type { Subprocess as FixtureProcess } from '../../../../../scripts/tooling/process';

const { ptyDeadline, spawnTuiPTY } = (await import(
  join(import.meta.dirname, '../../../../../apps/cli/test/fixtures/tui-pty')
)) as {
  ptyDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T>;
  spawnTuiPTY(input: { cmd: string[]; cwd: string; env: NodeJS.ProcessEnv }): {
    readonly ended: boolean;
    host: Pick<FixtureProcess, 'kill' | 'exited'>;
    drain(): Promise<void>;
    viewport(): string;
    text(): string;
    key(value: string): Promise<void>;
    close(): void;
  };
};

test('actual 80x24 approval keeps options and private draft intact while paging the full scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-approval-presentation-'));
  const owned = spawnTuiPTY({
    cmd: [
      process.execPath,
      '--no-install',
      join(import.meta.dirname, 'approval-presentation.fixture.tsx'),
      root,
    ],
    cwd: root,
    env: { HOME: root, LANG: 'C.UTF-8' },
  });
  const frames: string[] = [];
  async function wait(text: string) {
    const end = Date.now() + 8000;
    for (;;) {
      await owned.drain();
      const frame = owned.viewport();
      if (frame.includes(text)) {
        frames.push(frame);
        return frame;
      }
      if (owned.ended || Date.now() > end)
        throw Error(`approval_frame_missing:${text}\n${frame}\n${owned.text().slice(-2000)}`);
      await fixtureDelay(30);
    }
  }
  async function key(value: string) {
    await owned.key(value);
    await fixtureDelay(80);
  }
  try {
    await wait('❯');
    await key('original');
    await key('\r');
    const once = await wait('❯ 仅此次');
    expect(once).toContain('本会话内相同命令');
    await key('private 草稿🙂');
    await wait('private 草稿🙂');
    await key('\x1b[B');
    const scope = await wait('❯ 本会话内相同命令');
    expect(scope).toContain('仅此次');
    expect(scope).toContain('完整范围第1行');
    expect(scope).toContain('private 草稿🙂');
    expect(scope).toContain('PgUp / PgDn');
    // The final detail must be reachable without changing or submitting the original choice.
    let last = scope;
    for (let n = 0; n < 5 && !last.includes('完整范围第35行'); n++) {
      await key('\x1b[6~');
      await owned.drain();
      last = owned.viewport();
      frames.push(last);
    }
    expect(last).toContain('完整范围第35行');
    expect(last).toContain('❯ 本会话内相同命令');
    expect(last).toContain('private 草稿🙂');
    await key('\x1b[A');
    const restored = await wait('❯ 仅此次');
    expect(restored).toContain('fixture.command');
    expect(restored).toContain('private 草稿🙂');
    expect(restored).not.toContain('完整范围第35行');
    expect(restored).not.toContain('observexecute');
    await key('\x03');
    const cancelled = await wait('Current task · Cancelled');
    expect(cancelled).not.toContain('(queued)');
    expect(cancelled).not.toContain('Ran:');
    owned.host.kill('SIGTERM');
    expect(await ptyDeadline(owned.host.exited, 5000, 'approval_fixture_exit')).toBe(0);
    const facts = JSON.parse(readFileSync(join(root, 'facts.json'), 'utf8'));
    expect(facts.effects).toBe(0);
    expect(facts.posts).toBe(0);
    expect(facts.interactions).toHaveLength(1);
    expect(facts.interactions[0]).toMatchObject({ state: 'cancelled', answer: null });
    expect(frames.every((frame) => frame.split('\n').length === 24)).toBe(true);
  } finally {
    if (!owned.ended) {
      owned.host.kill('SIGTERM');
      await ptyDeadline(owned.host.exited, 5000, 'approval_fixture_cleanup');
    }
    owned.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
