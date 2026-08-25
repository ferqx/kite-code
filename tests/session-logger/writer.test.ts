// tests/session-logger/writer.test.ts
// 验证 SessionLogWriter 写入 → finalize → 文件内容完整性

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionLogDir } from '#app/config/paths';

const TEST_FRONTEND = 'test';
const TEST_THREAD = 'test-session-logger-writer';
const originalHome = process.env.KITE_CODE_HOME;
let isolatedHome = '';

function testDir(): string {
  return sessionLogDir(TEST_FRONTEND, TEST_THREAD);
}

function cleanup() {
  const dir = testDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SessionLogWriter', () => {
  beforeAll(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), 'kite-code-writer-test-'));
    process.env.KITE_CODE_HOME = isolatedHome;
  });

  afterEach(cleanup);

  afterAll(() => {
    if (originalHome == null) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = originalHome;
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
  });

  test('单条写入 + finalize 后文件内容正确', async () => {
    // 动态导入以隔离模块状态
    const { SessionLogWriter } = await import('#app/session-logger/writer');
    cleanup();

    const writer = new SessionLogWriter(TEST_FRONTEND, TEST_THREAD);
    writer.write({
      name: 'test',
      attributes: { key: 'value' },
      status: { code: 'OK', message: '' },
    });
    await writer.finalize();

    const content = readFileSync(join(testDir(), 'events.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.name).toBe('test');
    expect(parsed.attributes.key).toBe('value');
  });

  test('多条写入在同一文件中，顺序正确', async () => {
    const { SessionLogWriter } = await import('#app/session-logger/writer');
    cleanup();

    const writer = new SessionLogWriter(TEST_FRONTEND, TEST_THREAD);
    for (let i = 0; i < 10; i++) {
      writer.write({ index: i, name: `event-${i}` });
    }
    await writer.finalize();

    const content = readFileSync(join(testDir(), 'events.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(JSON.parse(lines[i]!).index).toBe(i);
    }
  });

  test('finalize 时缓冲为空不会产生空行', async () => {
    const { SessionLogWriter } = await import('#app/session-logger/writer');
    cleanup();

    const writer = new SessionLogWriter(TEST_FRONTEND, TEST_THREAD);
    writer.write({ empty: false });
    await writer.finalize();
    // 二次 finalize 不应产生额外内容
    await writer.finalize();

    const content = readFileSync(join(testDir(), 'events.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1); // 仍然只有 1 行
  });

  test('write 超 BATCH_SIZE 触发异步写盘，finalize 后数据完整', async () => {
    const { SessionLogWriter } = await import('#app/session-logger/writer');
    cleanup();

    const writer = new SessionLogWriter(TEST_FRONTEND, TEST_THREAD);
    // 写入 120 条，超过 BATCH_SIZE=50，触发两次异步写盘
    for (let i = 0; i < 120; i++) {
      writer.write({ index: i });
    }
    await writer.finalize();

    const content = readFileSync(join(testDir(), 'events.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(120);
    for (let i = 0; i < 120; i++) {
      expect(JSON.parse(lines[i]!).index).toBe(i);
    }
  });

  test('异步写盘 + finalize 不产生数据交错', async () => {
    const { SessionLogWriter } = await import('#app/session-logger/writer');
    cleanup();

    const writer = new SessionLogWriter(TEST_FRONTEND, TEST_THREAD);

    // 先写 50 条触发异步 flush
    for (let i = 0; i < 50; i++) {
      writer.write({ batch: 1, index: i });
    }
    // 异步 flush 已触发（batch 满 50），但可能尚未完成

    // 再写 20 条（留在缓冲中）
    for (let i = 0; i < 20; i++) {
      writer.write({ batch: 2, index: i });
    }

    // finalize 应该先等异步 flush 完成，再写剩余缓冲
    await writer.finalize();

    const content = readFileSync(join(testDir(), 'events.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(70); // 50 + 20 = 70

    // 验证所有行都是有效 JSON
    for (const line of lines) {
      expect(() => JSON.parse(line!)).not.toThrow();
    }
  });

  test('序列化失败后立即熔断且诊断回调异常不会传播', async () => {
    const { SessionLogWriter } = await import('#app/session-logger/writer');
    cleanup();
    let diagnostics = 0;
    const writer = new SessionLogWriter(TEST_FRONTEND, TEST_THREAD, 'events', () => {
      diagnostics++;
      throw new Error('diagnostic callback failed');
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => writer.write(circular)).not.toThrow();
    expect(() => writer.write({ ignored: true })).not.toThrow();
    await expect(writer.finalize()).resolves.toBeUndefined();

    expect(diagnostics).toBe(1);
    expect(existsSync(join(testDir(), 'events.jsonl'))).toBe(false);
  });

  test('首批异步写失败后不执行已排队的后续批次', async () => {
    const { SessionLogWriter } = await import('#app/session-logger/writer');
    cleanup();
    let appendCalls = 0;
    let diagnostics = 0;
    const writer = new SessionLogWriter(
      TEST_FRONTEND,
      TEST_THREAD,
      'events',
      () => {
        diagnostics++;
      },
      async () => {
        appendCalls++;
        if (appendCalls === 1) throw new Error('first append failed');
      },
    );

    for (let index = 0; index < 100; index++) writer.write({ index });
    await writer.finalize();

    expect(appendCalls).toBe(1);
    expect(diagnostics).toBe(1);
    expect(existsSync(join(testDir(), 'events.jsonl'))).toBe(false);
    expect(JSON.parse(readFileSync(join(testDir(), 'terminal.json'), 'utf8')).outcome).toBe(
      'failed',
    );
  });
});
