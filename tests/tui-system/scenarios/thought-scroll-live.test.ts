import { expect, test } from 'bun:test';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitUserMessage } from '../harness/input-helpers';
import { spawnReadyTui } from '../harness/pty-process';
import { waitForOutputQuiescence, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

test('live two-turn delegation keeps Thinking after its prompt while scrolled', async () => {
  const server = createMockModelServer();
  const workspace = createTestWorkspace({
    configOverrides: {
      provider: {
        mock: {
          type: 'deepseek',
          apiKey: 'test-key',
          baseURL: server.baseURL,
          model: 'mock-model',
          models: [{ name: 'mock-model', default: true, streaming: true }],
        },
      },
      model: { default: { provider: 'mock', name: 'mock-model' } },
      sandbox: { enabled: false },
    },
  });
  server.setResponses([
    {
      message: {
        reasoning_chunks: ['Greeting'],
        content: Array.from({ length: 25 }, (_, i) => `GREETING_${i}`).join('\n\n'),
      },
      chunk_delay: 150,
    },
    {
      message: {
        reasoning_chunks: [
          Array.from(
            { length: 8 },
            (_, i) =>
              `Plan independent tasks. Step ${i}: inspect the repository and return a bounded summary without changing files.`,
          ).join('\n'),
          'Keep both tasks bounded.\n',
        ],
        content: 'DELEGATION_CAPTION',
        tool_calls: [
          {
            id: 'child-a',
            name: 'task',
            args: {
              name: 'Explore A',
              subagent_type: 'explore',
              task: 'Return a short summary of A.',
            },
          },
          {
            id: 'child-b',
            name: 'task',
            args: {
              name: 'Explore B',
              subagent_type: 'explore',
              task: 'Return a short summary of B.',
            },
          },
        ],
      },
      chunk_delay: 650,
    },
    {
      message: {
        reasoning_chunks: ['CHILD_A_REASONING\n', 'Checking its independent task.'],
        content: 'A complete.',
      },
      chunk_delay: 1200,
    },
    {
      message: {
        reasoning_chunks: ['CHILD_B_REASONING\n', 'Checking its independent task.'],
        content: 'B complete.',
      },
      chunk_delay: 1200,
    },
    {
      expectedRequest: {
        toolResults: [
          { toolCallId: 'child-a', contentIncludes: ['complete'] },
          { toolCallId: 'child-b', contentIncludes: ['complete'] },
        ],
      },
      message: { content: 'PARENT_COMPLETE' },
    },
  ]);
  const tui = await spawnReadyTui({ cols: 132, rows: 40, workspace, mockServer: server });
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    await submitUserMessage(tui, server, 'FIRST_PROMPT', { timeout: 15000 });
    await waitForText(() => tui.scrollback(), 'GREETING_24', 20000);
    await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 10000, 750);
    const liveFrames: string[] = [];
    sampler = setInterval(() => {
      liveFrames.push(tui.scrollback());
    }, 25);
    await submitUserMessage(tui, server, 'SECOND_PROMPT', { timeout: 15000 });
    await waitForText(() => tui.viewport(), 'Thinking', 10000);
    await tui.scrollViewport(-20);
    const position = tui.viewportPosition();
    const history = tui.viewport();
    expect(position.viewportY).toBeLessThan(position.baseY);
    await waitForText(() => tui.scrollback(), 'PARENT_COMPLETE', 30000);
    clearInterval(sampler);
    const activeFrames = liveFrames.filter(
      (frame) => frame.includes('SECOND_PROMPT') && !frame.includes('PARENT_COMPLETE'),
    );
    const misplaced = activeFrames.filter((frame) =>
      /Thinking/.test(
        frame.slice(
          frame.indexOf('GREETING_24') + 'GREETING_24'.length,
          frame.indexOf('SECOND_PROMPT'),
        ),
      ),
    );
    const duplicate = activeFrames.filter(
      (frame) =>
        (frame.slice(frame.indexOf('SECOND_PROMPT')).match(/Thinking \d+s/g) ?? []).length > 1,
    );
    console.log(
      JSON.stringify({
        activeFrames: activeFrames.length,
        misplaced: misplaced.length,
        duplicate: duplicate.length,
      }),
    );
    if (misplaced.length || duplicate.length)
      console.log(`BAD_LIVE_FRAME\n${misplaced[0] ?? duplicate[0]}`);
    expect(activeFrames.length).toBeGreaterThan(20);
    expect(activeFrames.some((frame) => frame.includes('Plan independent tasks.'))).toBe(true);
    expect(activeFrames.some((frame) => frame.includes('Delegating'))).toBe(true);
    expect(misplaced).toHaveLength(0);
    expect(duplicate).toHaveLength(0);
    await waitForOutputQuiescence(() => tui.outputSinceLastAction(), 10000, 750);
    expect(tui.viewportPosition().viewportY).toBe(position.viewportY);
    expect(tui.viewport()).toBe(history);
    await tui.scrollViewport(10000);
    const text = tui.scrollback();
    const second = text.slice(text.indexOf('SECOND_PROMPT'));
    expect(text.match(/Thinking \d+s/g)).toHaveLength(2);
    expect(second.match(/Thinking \d+s/g)).toHaveLength(1);
    expect(second.indexOf('Thinking')).toBeLessThan(second.indexOf('DELEGATION_CAPTION'));
    expect(text).not.toContain('Plan independent tasks.');
  } catch (error) {
    console.log(tui.scrollback());
    throw error;
  } finally {
    clearInterval(sampler);
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  }
}, 60000);
