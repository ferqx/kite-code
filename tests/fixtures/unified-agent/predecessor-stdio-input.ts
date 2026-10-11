/** Match only the committed CI stdio wiring change; never rewrite an old manifest. */
export function matchPredecessorStdioInput(
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
): 'identical' | 'runtime_stdio_validation_script_increment' | undefined {
  const original = Buffer.from(previous),
    actual = Buffer.from(current);
  if (original.equals(actual)) return 'identical';
  if (path !== 'package.json') return undefined;
  const oldCommand =
    'bun test --parallel=1 --max-concurrency=1 packages/agent/test/isolated/mcp/stdio-port.test.ts apps/service/test/isolated/paired.test.ts apps/service/test/isolated/startup-frame.test.ts apps/service/test/isolated/lifecycle.test.ts apps/cli/test/stdio-grants.test.ts apps/cli/test/stdio-interactions.test.ts';
  const addedCommand =
    ' packages/agent/test/isolated/mcp/linux-stdio-port.test.ts packages/agent/test/isolated/mcp/linux-owned-program.test.ts packages/agent/test/isolated/mcp/windows-stdio-port.test.ts && bun test --parallel=1 --max-concurrency=1 apps/service/test/isolated/mcp-source-packaged-default.test.ts';
  const anchor = `    "test:runtime:stdio": "${oldCommand}",\n`,
    text = original.toString('utf8');
  if (text.split(anchor).length !== 2) return undefined;
  // b16412a0 changed exactly this line. Every other byte, including other scripts,
  // dependency declarations, build inputs and metadata, must remain identical.
  const expected = text.replace(
    anchor,
    `    "test:runtime:stdio": "${oldCommand}${addedCommand}",\n`,
  );
  return Buffer.from(expected).equals(actual)
    ? 'runtime_stdio_validation_script_increment'
    : undefined;
}
