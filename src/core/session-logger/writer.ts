// src/core/session-logger/writer.ts
// 非阻塞 JSONL 写入器
//
// 设计借鉴 Pino/Winston 的 async flush 模式：
//   write() → push 到内存缓冲（纳秒级）→ queueMicrotask 触发异步写盘
//   finalize() → 先 await 所有 pending flush，再同步写盘，保证数据不丢且不交错
//
// 一条记录 ~300 bytes，50 条一 batch 约 15KB，异步 appendFile 一次写完，
// 主流程永不阻塞。

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { sessionLogDir } from '@/core/config/paths';

// 每批次最多缓存的记录数
const BATCH_SIZE = 50;

export class SessionLogWriter {
  private _filePath: string;
  private _buffer: string[] = [];
  private _scheduled = false;
  private _pendingFlush: Promise<void> | null = null;

  constructor(frontend: string, threadId: string, basename = 'events') {
    const dir = sessionLogDir(frontend, threadId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this._filePath = `${dir}/${basename}.jsonl`;
  }

  /** 追加一条记录。O(1) push 到内存缓冲，异步触发写盘，永不阻塞主流程 */
  write(record: unknown): void {
    this._buffer.push(JSON.stringify(record));

    if (this._buffer.length >= BATCH_SIZE) {
      // 满了 → 立即异步写
      this._flushAsync();
    } else if (!this._scheduled) {
      // 没满 → 预约一次异步写（合并同一轮微任务内的多次 write）
      // 使用 queueMicrotask 而非 setImmediate，兼容 Bun / 浏览器 / Node.js
      this._scheduled = true;
      queueMicrotask(() => {
        this._scheduled = false;
        this._flushAsync();
      });
    }
  }

  /** 异步写盘——链式串行，保证写入顺序，跟踪末次 promise 供 finalize 等待 */
  private _flushAsync(): void {
    const batch = this._buffer.splice(0);
    if (batch.length === 0) return;

    const lines = `${batch.join('\n')}\n`;
    // 链到上一次 flush 之后执行，保证 JSONL 行顺序与 write() 调用顺序一致
    this._pendingFlush = (this._pendingFlush ?? Promise.resolve())
      .then(() => appendFile(this._filePath, lines, 'utf-8'))
      .catch(() => {
        // 磁盘 I/O 失败静默——日志是辅助功能，不能拖垮 Agent
      });
  }

  /** 会话结束时写盘——先等待所有异步写入完成，再同步写剩余缓冲，避免数据交错 */
  async finalize(): Promise<void> {
    // 等待所有 pending 异步写入完成
    if (this._pendingFlush) {
      await this._pendingFlush;
      this._pendingFlush = null;
    }

    if (this._buffer.length === 0) return;
    try {
      appendFileSync(this._filePath, `${this._buffer.join('\n')}\n`, 'utf-8');
      this._buffer = [];
    } catch {
      // 静默
    }
  }
}
