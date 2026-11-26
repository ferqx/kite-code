import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

for (const scenario of [
  {
    name: 'the sending message clears its draft on the first visible frame and preserves later edits',
    runner: 'prompt-send-browser-runner.fixture.ts',
    args: ['--sending-only'],
    env: {},
    completed: '"passed":4',
  },
  {
    name: 'tool icons and collapsed rows stay in place during paged receipt handoff',
    runner: 'native-live-tool-aggregation-browser-runner.fixture.ts',
    args: [],
    env: { KITE_AGGREGATION_SCENARIO: 'tool-motion', KITE_AGGREGATION_BASELINE: '' },
    completed: '"toolMotionCases":2',
  },
  {
    name: 'new Turns do not render saved messages, tools or attachment lists again',
    runner: 'prompt-send-browser-runner.fixture.ts',
    args: ['--history-isolation'],
    env: {},
    completed: '"historyIsolationCases":2',
  },
]) {
  test(scenario.name, async () => {
    const bundled = process.env.PLAYWRIGHT_BROWSERS_PATH || existsSync(chromium.executablePath());
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, '..', scenario.runner),
        ...scenario.args,
        ...(bundled ? ['--bundled-chromium'] : []),
      ],
      {
        cwd: resolve(import.meta.dir, '../../../..'),
        env: { ...process.env, ...scenario.env, NODE_ENV: 'production' },
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(150_000),
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain(scenario.completed);
  }, 160_000);
}
