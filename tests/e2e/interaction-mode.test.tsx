/**
 * TUI E2E — Interaction Mode (审核模式) Slash Command
 *
 * Tests for /mode slash command display in StatsLine.
 * Multi-step cycling and tool-approval behavior are tested via
 * integration tests (interaction-mode.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTui, type TuiHarness } from './render-tui';
import { ResponsePlan, text } from './response-plan';

const TIMEOUT = 60000;

const plan = new ResponsePlan([{ group: 'idle', responses: [text('OK', 10)] }]);

function clearInputBuffer(tui: TuiHarness) {
  for (let i = 0; i < 30; i++) tui.stdin.write('\x7f');
}

async function runSlashCommand(tui: TuiHarness, cmd: string, delay = 800) {
  clearInputBuffer(tui);
  await new Promise((r) => setTimeout(r, 100));
  for (const ch of cmd) {
    tui.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 100));
  tui.stdin.write('\r');
  await new Promise((r) => setTimeout(r, delay));
}

function getModeLabel(output: string): string | null {
  if (output.includes('[自动审批]')) return 'auto';
  if (output.includes('[完全权限]')) return 'full';
  return null; // ask mode has no label
}

let tui: TuiHarness;

describe('TUI E2E — Interaction Mode Slash Commands', () => {
  beforeAll(async () => {
    tui = await createTui({
      modelResponses: plan.flatten(),
      terminalWidth: 120,
      stepTimeout: TIMEOUT,
    });
  });

  afterAll(() => {
    tui.unmount();
  });

  test('/mode auto shows [自动审批] in StatsLine', async () => {
    await runSlashCommand(tui, '/mode auto');
    expect(getModeLabel(tui.getOutput())).toBe('auto');
  });

  test('/mode full shows [完全权限] in StatsLine', async () => {
    await runSlashCommand(tui, '/mode full');
    expect(getModeLabel(tui.getOutput())).toBe('full');
  });

  test('/mode ask shows no label (default mode)', async () => {
    // First set auto so we can verify the switch back
    await runSlashCommand(tui, '/mode auto');
    await runSlashCommand(tui, '/mode ask');
    expect(getModeLabel(tui.getOutput())).toBeNull();
  });

  test('mode label persists across render cycles', async () => {
    await runSlashCommand(tui, '/mode auto');
    // Wait an extra cycle to ensure label is stable
    await new Promise((r) => setTimeout(r, 500));
    expect(getModeLabel(tui.getOutput())).toBe('auto');
  });
});
