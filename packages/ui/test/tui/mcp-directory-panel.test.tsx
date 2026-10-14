import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { TuiController } from '../../src/tui/controller';
import { TuiMcpDirectoryPanel } from '../../src/tui/mcp-directory-panel';
import { TuiPresentationProvider } from '../../src/tui/presentation';

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
test('saved MCP prompt directory reads original details without invocation and aborts on close', async () => {
  let reads = 0,
    closed = 0;
  let signal: AbortSignal | undefined;
  const controller = {
    state: { sessionId: 's' },
    port: {
      mcp: {
        async readDirectory(_session: string, _family: string, abort: AbortSignal) {
          reads++;
          signal = abort;
          return {
            family: 'prompts',
            sessionId: 's',
            workspaceId: 'w',
            nextAfterKey: null,
            items: [
              {
                key: 'prompts/exec',
                serverId: 'server',
                configDigest: 'a'.repeat(64),
                generation: 1,
                live: false,
                descriptorDigests: ['b'.repeat(64)],
                descriptors: [
                  {
                    name: 'Original prompt',
                    description: 'Original full description',
                    arguments: [{ name: 'topic', required: true }],
                  },
                ],
              },
            ],
          };
        },
      },
    },
  } as unknown as TuiController;
  const ui = render(
    <TuiPresentationProvider
      value={{
        preferences: {
          revision: 'a'.repeat(64),
          language: 'en-US',
          resolvedLanguage: 'en-US',
          colorPreset: 'teal',
          theme: 'dark',
        },
        testDiagnostics: false,
      }}
    >
      <TuiMcpDirectoryPanel controller={controller} family="prompts" onBack={() => closed++} />
    </TuiPresentationProvider>,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Original prompt');
    expect(ui.lastFrame()).toContain('Historical binding');
    expect(ui.lastFrame()).toContain('does not connect or execute');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('"required": true');
    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).toContain('Original full description');
    ui.stdin.write('\u001b');
    await tick();
    expect(closed).toBe(1);
    expect(reads).toBe(1);
  } finally {
    ui.unmount();
  }
  expect(signal?.aborted).toBe(true);
});
