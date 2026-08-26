import { expect, test } from 'bun:test';
import { runCli as rootRunCli, runTui as rootRunTui } from '@kite-ai/kite-cli';
import { runCli } from '@kite-ai/kite-cli/cli';
import { runTui } from '@kite-ai/kite-cli/tui';

test('terminal package exposes only the closed CLI and TUI application entries', () => {
  expect(rootRunCli).toBe(runCli);
  expect(rootRunTui).toBe(runTui);
});
