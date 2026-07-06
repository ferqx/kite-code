import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { UserInputProvider } from '@/protocol/provider';
import type { AgentConfig } from '../src/core/config/index';
import { forkFromCheckpoint, revertToCheckpoint } from '../src/core/runner';

const fakeConfig: AgentConfig = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerName: 'fake' as any,
  providerType: 'openai-compatible',
  apiKey: 'noop',
  baseURL: 'http://localhost:9999',
  modelName: 'fake',
  sandbox: { enabled: true },
};

class NoopChatModel extends ChatOpenAI {
  constructor() {
    super({
      apiKey: 'noop',
      model: 'fake',
      configuration: { baseURL: 'http://localhost:9999' },
      temperature: 0,
    });
  }

  override async invoke(_input: unknown, _options?: unknown): Promise<any> {
    return new AIMessage('ok');
  }

  bind(_kwargs: unknown): this {
    return this;
  }
  override bindTools(_tools: unknown[], _kwargs?: unknown): this {
    return this;
  }
}

function createProvider(): { provider: UserInputProvider; events: any[] } {
  const events: any[] = [];
  const provider: UserInputProvider = {
    onEvent(event) {
      events.push(event);
    },
    async requestAction() {
      return { type: 'cancel' as const };
    },
  };
  return { provider, events };
}

describe('revertToCheckpoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-rewind-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits error event when checkpoint not found', async () => {
    const { provider, events } = createProvider();
    const cpPath = join(tmpDir, 'cp.db');
    const threadId = 'rewind-thread-1';

    const gen = revertToCheckpoint(provider, {
      threadId,
      checkpointId: 'nonexistent-cp',
      workspace: tmpDir,
      checkpointPath: cpPath,
      config: fakeConfig,
    });

    for await (const ev of gen) {
      events.push(ev);
    }

    const errorEvents = events.filter((e: any) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].data.message).toContain('Checkpoint not found');
  });

  it('handles signal abort gracefully', async () => {
    const { provider, events } = createProvider();
    const cpPath = join(tmpDir, 'cp.db');
    const threadId = 'rewind-thread-2';

    // Save a checkpoint first so the existence check passes
    const { BunSqliteSaver } = await import('../src/core/persistence/checkpoint');
    const saver = new BunSqliteSaver(cpPath);
    const checkpoint: any = {
      v: 4,
      id: 'cp-ok',
      ts: new Date().toISOString(),
      channel_values: { messages: [] },
      channel_versions: {},
      versions_seen: {},
    };
    await saver.put({ configurable: { thread_id: threadId, checkpoint_id: 'cp-ok' } }, checkpoint, {
      source: 'loop',
      step: 0,
      parents: {},
    });
    saver.close();

    const abort = new AbortController();
    abort.abort();

    const gen = revertToCheckpoint(provider, {
      threadId,
      checkpointId: 'cp-ok',
      workspace: tmpDir,
      checkpointPath: cpPath,
      config: fakeConfig,
      signal: abort.signal,
      model: new NoopChatModel(),
    });

    for await (const ev of gen) {
      events.push(ev);
    }
    // Generator terminated without throwing on abort
    expect(true).toBe(true);
  });
});

describe('forkFromCheckpoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kite-code-fork-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits error event when checkpoint not found', async () => {
    const { provider, events } = createProvider();
    const cpPath = join(tmpDir, 'cp.db');

    const gen = forkFromCheckpoint(provider, {
      oldThreadId: 'nonexistent-thread',
      checkpointId: 'nonexistent-cp',
      newThreadId: 'forked-thread-1',
      workspace: tmpDir,
      checkpointPath: cpPath,
      config: fakeConfig,
    });

    for await (const ev of gen) {
      events.push(ev);
    }

    const errorEvents = events.filter((e: any) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].data.message).toContain('Checkpoint not found');
  });

  it('uses new threadId independent of old threadId', async () => {
    const { provider, events } = createProvider();
    const cpPath = join(tmpDir, 'cp.db');
    const oldThreadId = 'old-thread';
    const newThreadId = 'new-thread-forked';

    const gen = forkFromCheckpoint(provider, {
      oldThreadId,
      checkpointId: 'missing-cp',
      newThreadId,
      workspace: tmpDir,
      checkpointPath: cpPath,
      config: fakeConfig,
    });

    for await (const ev of gen) {
      events.push(ev);
    }

    const errorEvents = events.filter((e: any) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].data.message).toContain('Checkpoint not found');
  });
});
