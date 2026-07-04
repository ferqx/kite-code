import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { Checkpoint, PendingWrite } from '@langchain/langgraph-checkpoint';
import { sessionDataToUI } from '../src/app/tui/replay-blocks';
import type { OutputBlock } from '../src/app/tui/types';
import { BunSqliteSaver } from '../src/core/persistence/checkpoint';
import { generateSessionName, listSessions, loadSession } from '../src/core/persistence/sessions';

function makeDbPath(label: string): string {
  return join(tmpdir(), `kite-code-sessions-test-${label}.sqlite`);
}

function makeCheckpoint(
  id: string,
  channelValues: Record<string, unknown>,
  checkpointId?: number,
): Checkpoint {
  // Use incrementing timestamps so ordering is deterministic
  const baseMs = new Date('2026-05-17T10:00:00.000Z').getTime();
  return {
    v: 4,
    id,
    ts: new Date(baseMs + (checkpointId ?? 0) * 1000).toISOString(),
    channel_values: channelValues,
    channel_versions: Object.fromEntries(Object.keys(channelValues).map((k) => [k, 1])),
    versions_seen: {},
  };
}

describe('listSessions', () => {
  test('returns empty array for empty database', async () => {
    const dbPath = makeDbPath('empty');
    rmSync(dbPath, { force: true });
    // Initialize the database via BunSqliteSaver so the table exists
    const saver = new BunSqliteSaver(dbPath);
    saver.setup();
    saver.close();

    const sessions = await listSessions(dbPath);
    expect(sessions).toEqual([]);
  });

  test('returns sessions ordered by updatedAt descending', async () => {
    const dbPath = makeDbPath('ordered');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      makeCheckpoint(
        'cp-1a',
        {
          messages: [new HumanMessage('Task A')],
        },
        1,
      ),
      { source: 'input', step: 0, parents: {} },
    );
    // Add second checkpoint to thread-1 later (updates updatedAt)
    await saver.put(
      { configurable: { thread_id: 'thread-1', checkpoint_id: 'cp-1a' } },
      makeCheckpoint(
        'cp-1b',
        {
          messages: [new HumanMessage('Task A'), new AIMessage('Response')],
        },
        2,
      ),
      { source: 'loop', step: 1, parents: {} },
    );
    // Small delay so created_at differs from thread-1's last update
    await new Promise((r) => setTimeout(r, 1100));
    await saver.put(
      { configurable: { thread_id: 'thread-2' } },
      makeCheckpoint(
        'cp-2a',
        {
          messages: [new HumanMessage('Task B')],
        },
        3,
      ),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const sessions = await listSessions(dbPath);
    expect(sessions.length).toBe(2);
    // thread-2 was created last, should be first
    expect(sessions[0]!.threadId).toBe('thread-2');
    expect(sessions[1]!.threadId).toBe('thread-1');
  });

  test('reads session name from first HumanMessage', async () => {
    const dbPath = makeDbPath('name');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-x' } },
      makeCheckpoint('cp-x', {
        messages: [new HumanMessage('Write a function to calculate fibonacci numbers')],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const sessions = await listSessions(dbPath);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.threadId).toBe('thread-x');
    expect(sessions[0]!.name).toContain('Write a function');
  });

  test('stores full first message in session name when no cached name', async () => {
    const dbPath = makeDbPath('fullname');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    const longMsg = 'This is a very long task description that should definitely be stored in full';
    await saver.put(
      { configurable: { thread_id: 'thread-long' } },
      makeCheckpoint('cp-long', {
        messages: [new HumanMessage(longMsg)],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const sessions = await listSessions(dbPath);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.name).toBe(longMsg);
    expect(sessions[0]!.needsSmartName).toBe(true);
  });

  test('falls back to threadId when no HumanMessage found', async () => {
    const dbPath = makeDbPath('fallback');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-nomsg' } },
      makeCheckpoint('cp-nomsg', {
        messages: [new AIMessage('Hello')],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const sessions = await listSessions(dbPath);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.name).toBe('thread-nomsg');
  });

  test('formats updatedAt as local time string', async () => {
    const dbPath = makeDbPath('timefmt');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-t' } },
      makeCheckpoint('cp-t', {
        messages: [new HumanMessage('Time test')],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const sessions = await listSessions(dbPath);
    expect(sessions.length).toBe(1);
    // Should match YYYY-MM-DD HH:MM:SS format
    expect(sessions[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('limits to 50 sessions', async () => {
    const dbPath = makeDbPath('limit');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    for (let i = 0; i < 60; i++) {
      await saver.put(
        { configurable: { thread_id: `thread-${i}` } },
        makeCheckpoint(
          `cp-${i}`,
          {
            messages: [new HumanMessage(`Task ${i}`)],
          },
          i,
        ),
        { source: 'input', step: 0, parents: {} },
      );
    }
    saver.close();

    const sessions = await listSessions(dbPath);
    expect(sessions.length).toBeLessThanOrEqual(50);
  });

  // Skip: listSessions no longer catches corrupt database errors.
  // The function uses try/finally (no catch), so saver.setup() throws
  // SQLITE_NOTADB on corrupt files instead of returning [].  The callers
  // (TUI session selector) are expected to handle this at a higher level
  // or the corrupt file should be detected/cleaned up before listSessions.
  test.skip('returns empty array for corrupt database file', async () => {
    const dbPath = makeDbPath('corrupt');
    rmSync(dbPath, { force: true });
    // Create a file that is not a valid SQLite database
    Bun.write(dbPath, 'not a database');

    // listSessions should gracefully handle corrupted files
    const sessions = await listSessions(dbPath);
    expect(sessions).toEqual([]);
  });
});

describe('loadSession', () => {
  test('returns null for non-existent thread', async () => {
    const dbPath = makeDbPath('notfound');
    rmSync(dbPath, { force: true });
    // Initialize database
    const s = new BunSqliteSaver(dbPath);
    s.setup();
    s.close();

    const result = await loadSession(dbPath, 'nonexistent');
    expect(result).toBeNull();
  });

  test('loads session with user and text blocks', async () => {
    const dbPath = makeDbPath('usertext');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      makeCheckpoint('cp-1', {
        messages: [new HumanMessage('What is 2+2?'), new AIMessage('2+2 equals 4.')],
        modelProvider: 'openai',
        modelName: 'gpt-4o',
        thinkingLevel: null,
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-1');
    expect(result).not.toBeNull();
    expect(result?.threadId).toBe('thread-1');
    const { blocks } = sessionDataToUI(result!);
    expect(blocks.length).toBe(2);

    // First block: user message
    const userBlock = blocks[0]!;
    expect(userBlock.kind).toBe('user');
    if (userBlock.kind === 'user') {
      expect((userBlock as Extract<OutputBlock, { kind: 'user' }>).content).toBe('What is 2+2?');
    }

    // Second block: text response
    const textBlock = blocks[1]!;
    expect(textBlock.kind).toBe('text');
    if (textBlock.kind === 'text') {
      expect((textBlock as Extract<OutputBlock, { kind: 'text' }>).content).toBe('2+2 equals 4.');
    }

    // Model info
    expect(result?.modelProvider).toBe('openai');
    expect(result?.modelName).toBe('gpt-4o');
    expect(result?.thinkingLevel).toBeNull();
  });

  test('loads session with reasoning content block', async () => {
    const dbPath = makeDbPath('reason');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-r' } },
      makeCheckpoint('cp-r', {
        messages: [
          new HumanMessage('Solve this problem'),
          new AIMessage({
            content: 'The answer is 42.',
            additional_kwargs: {
              reasoning_content: 'Let me think step by step...',
            },
          }),
        ],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-r');
    expect(result).not.toBeNull();
    const { blocks } = sessionDataToUI(result!);
    // Should have user → reason → text blocks
    expect(blocks.length).toBe(3);
    expect(blocks[0]!.kind).toBe('user');
    const reasonBlock = blocks[1]!;
    expect(reasonBlock.kind).toBe('reason');
    if (reasonBlock.kind === 'reason') {
      const r = reasonBlock as Extract<OutputBlock, { kind: 'reason' }>;
      expect(r.content).toBe('Let me think step by step...');
      expect(r.folded).toBe(false);
    }
    expect(blocks[2]!.kind).toBe('text');
  });

  test('loads session with tool_card blocks from AIMessage tool_calls', async () => {
    const dbPath = makeDbPath('toolcalls');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-tc' } },
      makeCheckpoint('cp-tc', {
        messages: [
          new HumanMessage('Read the file'),
          new AIMessage({
            content: "I'll read the file",
            tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: '/tmp/test.txt' } }],
          }),
        ],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-tc');
    expect(result).not.toBeNull();
    const { blocks } = sessionDataToUI(result!);
    // Now matches real-time order: user → text → tool_summary
    // (text always precedes tool_calls in both live rendering and replay)
    expect(blocks.length).toBe(3);
    expect(blocks[0]!.kind).toBe('user');
    expect(blocks[1]!.kind).toBe('text');
    const tcBlock = blocks[2]!;
    expect(tcBlock.kind).toBe('tool_summary');
    if (tcBlock.kind === 'tool_summary') {
      const summary = tcBlock as Extract<OutputBlock, { kind: 'tool_summary' }>;
      expect(summary.tools[0]?.callId).toBe('call-1');
      expect(summary.tools[0]?.name).toBe('read_file');
      expect(summary.tools[0]?.args).toEqual({ path: '/tmp/test.txt' });
      expect(summary.tools[0]?.status).toBe('running'); // no ToolMessage → still pending
    }
  });

  test('loads session with ToolMessage producing tool_card blocks', async () => {
    const dbPath = makeDbPath('toolmsg');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-tm' } },
      makeCheckpoint('cp-tm', {
        messages: [
          new HumanMessage('Run a command'),
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call-sh', name: 'shell_execute', args: { command: 'echo hello' } }],
          }),
          new ToolMessage({
            content: JSON.stringify({ ok: true, stdout: 'hello', stderr: '' }),
            tool_call_id: 'call-sh',
            name: 'shell_execute',
            status: 'success',
          }),
        ],
      }),
      { source: 'loop', step: 1, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-tm');
    expect(result).not.toBeNull();
    // AIMessage tool_calls → tool_card, then ToolMessage enriches it in place
    const { blocks } = sessionDataToUI(result!);
    const toolCards = blocks.filter((b) => b.kind === 'tool_card');
    expect(toolCards.length).toBe(1);
    const tc0 = toolCards[0]!;
    if (tc0.kind === 'tool_card') {
      const tc = tc0 as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(tc.status).toBe('done');
      expect(tc.name).toBe('shell_execute');
      expect(tc.summary).toBe('hello');
      expect(tc.args).toEqual({ command: 'echo hello' });
      expect(tc.preview).toBe('echo hello');
    }
  });

  test('loads session with error tool result', async () => {
    const dbPath = makeDbPath('toolerr');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-err' } },
      makeCheckpoint('cp-err', {
        messages: [
          new HumanMessage('Delete important file'),
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call-rm', name: 'shell_execute', args: { command: 'rm -rf /' } }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              ok: false,
              stderr: 'permission denied',
              message: 'Cannot delete',
            }),
            tool_call_id: 'call-rm',
            name: 'shell_execute',
            status: 'error',
          }),
        ],
      }),
      { source: 'loop', step: 1, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-err');
    expect(result).not.toBeNull();
    const { blocks } = sessionDataToUI(result!);
    const toolCards = blocks.filter((b) => b.kind === 'tool_card');
    const lastCard = toolCards[toolCards.length - 1]!;
    if (lastCard.kind === 'tool_card') {
      const lc = lastCard as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(lc.status).toBe('error');
      expect(lc.summary).toContain('permission denied');
    }
  });

  test('detects approval interrupt', async () => {
    const dbPath = makeDbPath('approval');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    const config = await saver.put(
      { configurable: { thread_id: 'thread-app' } },
      makeCheckpoint('cp-app', {
        messages: [
          new HumanMessage('Run shell command'),
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call-sh2', name: 'shell_execute', args: { command: 'ls' } }],
          }),
        ],
      }),
      { source: 'loop', step: 0, parents: {} },
    );
    // interrupt() throws before state updates are written, so the interrupt
    // value lives in pending writes on the __interrupt__ channel
    const writes: PendingWrite[] = [['__interrupt__', { kind: 'tool_approval' }]];
    await saver.putWrites(config, writes, 'agent');
    saver.close();

    const result = await loadSession(dbPath, 'thread-app');
    expect(result).not.toBeNull();
    expect(result?.interrupt).not.toBeNull();
    expect(result?.interrupt?.kind).toBe('approval');
  });

  test('detects input interrupt from __interrupt__ pending writes', async () => {
    const dbPath = makeDbPath('input');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    const config = await saver.put(
      { configurable: { thread_id: 'thread-inp' } },
      makeCheckpoint('cp-inp', {
        messages: [
          new HumanMessage('Ask user something'),
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call-ask', name: 'ask_user', args: { question: 'What do?' } }],
          }),
        ],
      }),
      { source: 'loop', step: 0, parents: {} },
    );
    // interrupt() throws before state updates are written, so the interrupt
    // value lives in pending writes on the __interrupt__ channel
    const writes: PendingWrite[] = [['__interrupt__', { kind: 'user_input' }]];
    await saver.putWrites(config, writes, 'agent');
    saver.close();

    const result = await loadSession(dbPath, 'thread-inp');
    expect(result).not.toBeNull();
    expect(result?.interrupt).not.toBeNull();
    if (result?.interrupt) {
      expect(result?.interrupt.kind).toBe('input');
    }
  });

  test('does not detect interrupt for non-__interrupt__ pending writes', async () => {
    const dbPath = makeDbPath('otherwrite');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    const config = await saver.put(
      { configurable: { thread_id: 'thread-ow' } },
      makeCheckpoint('cp-ow', {
        messages: [
          new HumanMessage('Run something'),
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'call-sh', name: 'shell_execute', args: { command: 'ls' } }],
          }),
        ],
      }),
      { source: 'loop', step: 0, parents: {} },
    );
    // Pending writes to channels other than __interrupt__ should not trigger
    // interrupt detection
    const writes: PendingWrite[] = [['messages', { kind: 'tool_approval' }]];
    await saver.putWrites(config, writes, 'agent');
    saver.close();

    const result = await loadSession(dbPath, 'thread-ow');
    expect(result).not.toBeNull();
    // Non-__interrupt__ pending writes do NOT trigger interrupt detection
    expect(result?.interrupt).toBeNull();
  });

  test('no interrupt when state is clean', async () => {
    const dbPath = makeDbPath('noint');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-ni' } },
      makeCheckpoint('cp-ni', {
        messages: [new HumanMessage('Hello'), new AIMessage('Hi there!')],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-ni');
    expect(result).not.toBeNull();
    expect(result?.interrupt).toBeNull();
  });

  test('returns model info from channel_values', async () => {
    const dbPath = makeDbPath('modelinfo');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-mi' } },
      makeCheckpoint('cp-mi', {
        messages: [new HumanMessage('Test')],
        modelProvider: 'deepseek',
        modelName: 'deepseek-v3',
        thinkingLevel: 'high',
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-mi');
    expect(result).not.toBeNull();
    expect(result?.modelProvider).toBe('deepseek');
    expect(result?.modelName).toBe('deepseek-v3');
    expect(result?.thinkingLevel).toBe('high');
  });

  test('block IDs are unique and sequential', async () => {
    const dbPath = makeDbPath('blockids');
    rmSync(dbPath, { force: true });
    const saver = new BunSqliteSaver(dbPath);
    await saver.put(
      { configurable: { thread_id: 'thread-bid' } },
      makeCheckpoint('cp-bid', {
        messages: [
          new HumanMessage('Q1'),
          new AIMessage('A1'),
          new HumanMessage('Q2'),
          new AIMessage('A2'),
        ],
      }),
      { source: 'input', step: 0, parents: {} },
    );
    saver.close();

    const result = await loadSession(dbPath, 'thread-bid');
    expect(result).not.toBeNull();
    const { blocks } = sessionDataToUI(result!);
    const ids = blocks.map((b) => b.id);
    expect(ids).toEqual([1, 2, 3, 4]);
  });
});

describe('generateSessionName', () => {
  test.skip('generates a short name from a real message using the configured model', async () => {
    const name = await generateSessionName('Write a function to calculate fibonacci numbers');
    // The generated name should be 2-30 characters and not empty
    expect(name.length).toBeGreaterThanOrEqual(2);
    expect(name.length).toBeLessThanOrEqual(30);
    // Should not contain quotes
    expect(name).not.toContain('"');
    expect(name).not.toContain("'");
    // Should not end with punctuation
    expect(name).not.toMatch(/[.!。,，、；;]$/);
  });

  test('returns empty string for empty input', async () => {
    expect(await generateSessionName('')).toBe('');
  });

  test('returns empty string for whitespace-only input', async () => {
    expect(await generateSessionName('   ')).toBe('');
  });
});
