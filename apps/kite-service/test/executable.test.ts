import { describe, expect, test } from 'bun:test';
import { runKiteServiceMain } from '@kite-ai/kite-service';
import { isKiteServiceMcpStdioInvocation } from '../src/executable';

describe('Kite App Server internal executable router', () => {
  test('recognizes the final private MCP marker in source and Windows standalone argv layouts', () => {
    const marker = '--kite-internal-mcp-stdio-v1';
    expect(isKiteServiceMcpStdioInvocation([marker], ['bun', 'service.ts', marker])).toBe(true);
    expect(isKiteServiceMcpStdioInvocation([], ['C:\\install\\kite-service.exe', marker])).toBe(
      true,
    );
    expect(
      isKiteServiceMcpStdioInvocation(
        [],
        ['C:\\install\\kite-service.exe', '--kite-internal-posix-supervisor-v1', marker],
      ),
    ).toBe(false);
  });

  test('rejects every retired Service lifecycle entrypoint', async () => {
    await expect(runKiteServiceMain(['service', 'run'])).rejects.toThrow(
      'Unsupported Kite Service internal entrypoint',
    );
    await expect(runKiteServiceMain(['service', 'run-single'])).rejects.toThrow(
      'Unsupported Kite Service internal entrypoint',
    );
  });
});
