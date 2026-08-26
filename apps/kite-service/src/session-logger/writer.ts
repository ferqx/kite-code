// apps/kite-service/src/session-logger/writer.ts
// 非阻塞 JSONL 写入器
//
// 设计借鉴 Pino/Winston 的 async flush 模式：
//   write() → push 到内存缓冲（纳秒级）→ queueMicrotask 触发异步写盘
//   finalize() → 先 await 所有 pending flush，再同步写盘，保证数据不丢且不交错
//
// 一条记录 ~300 bytes，50 条一 batch 约 15KB，异步 appendFile 一次写完，
// 主流程永不阻塞。

import { closeSync, existsSync, write } from 'node:fs';
import {
  assertSafeSessionLogSegment,
  assertSecureOpenFileIdentity,
  assertSecureSessionLogDirectoryChainIdentity,
  captureSecureSessionLogDirectoryChain,
  ensureSecureSessionLogDirectoryChain,
  openSecureAppendFile,
  type SecureSessionLogDirectoryBinding,
  type SecureSessionStorageOptions,
  unlinkSecureFileIfIdentity,
} from '@kite-ai/builtin-runtime/model';
import {
  sessionLogDir,
  sessionLogFrontendDir,
  sessionLogRoot,
  userKiteCodeDir,
} from '#kite-service/config/paths';
import type { SessionLoggingPolicy } from '#kite-service/config/session-logging-policy';
import { DEFAULT_SESSION_LOGGING_POLICY_ } from '#kite-service/config/session-logging-policy';
import {
  ActiveSessionLease,
  type ActiveSessionLeaseOptions,
  SESSION_LOG_LEASE_RESERVE_BYTES,
  SESSION_LOG_OPERATION_RESERVE_BYTES,
  tryAcquireSessionLogAdmission,
} from './active-session-lease';
import { runSessionLogMaintenance } from './retention';
import type { SessionLoggingDiagnostic } from './types';

// 每批次最多缓存的记录数
const BATCH_SIZE = 50;
const TERMINAL_RESERVE_BYTES = 256;
type AppendSessionLog = (fd: number, data: string, encoding: 'utf-8') => Promise<void>;

export interface SessionLogWriterOptions
  extends SecureSessionStorageOptions,
    Pick<
      ActiveSessionLeaseOptions,
      'now' | 'processIdentity' | 'heartbeatIntervalMs' | 'staleAfterMs'
    > {
  policy?: SessionLoggingPolicy;
  maintenanceMaxEntries?: number;
  maintenanceDeadlineMs?: number;
}

const appendToDescriptor: AppendSessionLog = (fd, data, encoding) =>
  new Promise((resolve, reject) => {
    const payload = Buffer.from(data, encoding);
    let offset = 0;
    const writeRemaining = () => {
      write(fd, payload, offset, payload.length - offset, null, (error, written) => {
        if (error) {
          reject(error);
          return;
        }
        if (written <= 0) {
          reject(new Error('Session-log append made no forward progress.'));
          return;
        }
        offset += written;
        if (offset < payload.length) writeRemaining();
        else resolve();
      });
    };
    writeRemaining();
  });

export class SessionLogWriter {
  private _filePath: string;
  private _buffer: string[] = [];
  private _scheduled = false;
  private _pendingFlush: Promise<void> | null = null;
  private _failed = false;
  private _failureReported = false;
  private _limitReached = false;
  private _finalized = false;
  private _fd: number | undefined;
  private _bytesWritten = 0;
  private _createdFile = false;
  private _fileIdentity?: { dev: number; ino: number };
  private readonly reportedDiagnostics = new Set<SessionLoggingDiagnostic['code']>();
  private readonly onDiagnostic?: (diagnostic: SessionLoggingDiagnostic) => void;
  private readonly append: AppendSessionLog;
  private readonly policy: SessionLoggingPolicy;
  private readonly options: SessionLogWriterOptions;
  private readonly lease: ActiveSessionLease;
  private readonly leaseBytes: number;
  private readonly directoryBindings: readonly SecureSessionLogDirectoryBinding[];

  constructor(
    frontend: string,
    threadId: string,
    basename = 'events',
    onDiagnostic?: (diagnostic: SessionLoggingDiagnostic) => void,
    append: AppendSessionLog = appendToDescriptor,
    options: SessionLogWriterOptions = {},
  ) {
    assertSafeSessionLogSegment(frontend, 'frontend');
    assertSafeSessionLogSegment(threadId, 'threadId');
    assertSafeSessionLogSegment(basename, 'basename');
    this.onDiagnostic = onDiagnostic;
    this.append = append;
    this.options = options;
    this.policy = options.policy ?? DEFAULT_SESSION_LOGGING_POLICY_;
    ensureSecureSessionLogDirectoryChain([userKiteCodeDir()], options);
    const root = sessionLogRoot();
    ensureSecureSessionLogDirectoryChain([root], options);
    const releaseAdmission = options.policy
      ? tryAcquireSessionLogAdmission(root, options)
      : undefined;
    if (options.policy && !releaseAdmission) {
      throw new Error('Session-log capacity admission is already in progress or unverifiable.');
    }
    try {
      if (options.policy) {
        const maintenance = runSessionLogMaintenance(this.policy, {
          ...options,
          root,
          maxEntries: options.maintenanceMaxEntries,
          deadlineMs: options.maintenanceDeadlineMs,
          reserveBytes: this.policy.maxSessionBytes,
        });
        if (maintenance.quarantinedSessions > 0) {
          this.reportDiagnostic({
            code: 'storage_quarantined',
            message: 'Unsafe session-log storage was quarantined; the Agent will continue.',
          });
        }
        if (!maintenance.capacitySatisfied) {
          throw new Error('Session-log total capacity could not be established safely.');
        }
      }
      const frontendDir = sessionLogFrontendDir(frontend);
      const dir = sessionLogDir(frontend, threadId);
      ensureSecureSessionLogDirectoryChain([frontendDir, dir], options);
      const directoryChain = [userKiteCodeDir(), root, frontendDir, dir];
      this.directoryBindings = captureSecureSessionLogDirectoryChain(directoryChain, options);
      this._filePath = `${dir}/${basename}.jsonl`;
      const acquiredLease = ActiveSessionLease.acquire(dir, {
        ...options,
        directoryChain,
        onFailure: () => this.reportFailure(),
      });
      try {
        const leaseBytes = acquiredLease.storageBytes();
        if (leaseBytes > SESSION_LOG_LEASE_RESERVE_BYTES) {
          throw new Error('Session-log lease metadata exceeded its bounded reserve.');
        }
        this.lease = acquiredLease;
        this.leaseBytes = leaseBytes;
        this._createdFile = !existsSync(this._filePath);
        const opened = openSecureAppendFile(this._filePath, this.options);
        this._fd = opened.fd;
        this._bytesWritten = opened.size;
        this._fileIdentity = opened.identity;
      } catch (error) {
        this.closeDescriptor();
        void acquiredLease.release('failed');
        throw error;
      }
    } finally {
      releaseAdmission?.();
    }
  }

  /** 追加一条记录。O(1) push 到内存缓冲，异步触发写盘，永不阻塞主流程 */
  write(record: unknown): void {
    if (this._failed || this._limitReached || this._finalized) return;
    try {
      this._buffer.push(JSON.stringify(record));
    } catch {
      this.reportFailure();
      return;
    }

    if (this._buffer.length >= BATCH_SIZE) {
      // 满了 → 立即异步写
      this._flushAsync();
    } else if (!this._scheduled) {
      // 没满 → 预约一次异步写（合并同一轮微任务内的多次 write）
      // 使用 queueMicrotask 而非 setImmediate，兼容 Bun / 浏览器 / Node.js
      this._scheduled = true;
      queueMicrotask(() => {
        if (!this._scheduled) return;
        this._scheduled = false;
        this._flushAsync();
      });
    }
  }

  /** 异步写盘——链式串行，保证写入顺序，跟踪末次 promise 供 finalize 等待 */
  private _flushAsync(): void {
    if (this._failed || this._limitReached || this._finalized) {
      this._buffer.length = 0;
      return;
    }
    const batch = this._buffer.splice(0);
    if (batch.length === 0) return;

    // 链到上一次 flush 之后执行，保证 JSONL 行顺序与 write() 调用顺序一致
    this._pendingFlush = (this._pendingFlush ?? Promise.resolve())
      .then(() => {
        if (this._failed || this._limitReached || this._finalized) return;
        return this.appendBatch(batch);
      })
      .catch(() => {
        this.reportFailure();
      });
  }

  /** 会话结束时写盘——先等待所有异步写入完成，再同步写剩余缓冲，避免数据交错 */
  async finalize(runOutcome: 'completed' | 'aborted' | 'fatal' = 'completed'): Promise<void> {
    if (this._finalized) return;
    // 抑制尚未执行的微任务，并将当前缓冲串到已有 flush 后。这样 finalize
    // 等待的是完整链，而不会在等待期间被微任务追加新的未等待写入。
    this._scheduled = false;
    if (!this._failed && !this._limitReached) this._flushAsync();

    if (this._pendingFlush) {
      await this._pendingFlush;
      this._pendingFlush = null;
    }
    this._finalized = true;
    this.closeDescriptor();
    await this.lease.release(
      this._failed ? 'failed' : this._limitReached ? 'limited' : 'closed',
      runOutcome,
    );
  }

  private async appendBatch(batch: readonly string[]): Promise<void> {
    const fd = this.ensureDescriptor();
    assertSecureSessionLogDirectoryChainIdentity(this.directoryBindings, this.options);
    assertSecureOpenFileIdentity(fd, this._filePath, this.options);
    const limitRecord = `${JSON.stringify({
      schemaVersion: 1,
      eventType: 'session.logging_limited',
      status: 'blocked',
      metadata: { reason: 'max_session_bytes' },
    })}\n`;
    const limitBytes = Buffer.byteLength(limitRecord);
    const normalLimit = Math.max(
      0,
      this.policy.maxSessionBytes -
        TERMINAL_RESERVE_BYTES -
        SESSION_LOG_OPERATION_RESERVE_BYTES -
        this.leaseBytes -
        limitBytes,
    );
    const admitted: string[] = [];
    let admittedBytes = 0;
    for (const line of batch) {
      const bytes = Buffer.byteLength(line) + 1;
      if (this._bytesWritten + admittedBytes + bytes > normalLimit) {
        if (admitted.length > 0) {
          const data = `${admitted.join('\n')}\n`;
          await this.append(fd, data, 'utf-8');
          this._bytesWritten += admittedBytes;
        }
        if (
          this._bytesWritten + limitBytes <=
          this.policy.maxSessionBytes - TERMINAL_RESERVE_BYTES
        ) {
          await this.append(fd, limitRecord, 'utf-8');
          this._bytesWritten += limitBytes;
        }
        this._limitReached = true;
        this._buffer.length = 0;
        this.reportDiagnostic({
          code: 'session_limit_reached',
          message:
            'The session log reached its configured size limit; further records were disabled.',
        });
        return;
      }
      admitted.push(line);
      admittedBytes += bytes;
    }
    if (admitted.length === 0) return;
    await this.append(fd, `${admitted.join('\n')}\n`, 'utf-8');
    this._bytesWritten += admittedBytes;
  }

  private ensureDescriptor(): number {
    if (this._fd != null) return this._fd;
    throw new Error('Session-log descriptor is unavailable after secure construction.');
  }

  private reportFailure(): void {
    this._failed = true;
    this._scheduled = false;
    this._buffer.length = 0;
    if (this._failureReported) return;
    this._failureReported = true;
    this.closeDescriptor();
    if (this._createdFile && this._bytesWritten === 0 && this._fileIdentity) {
      try {
        assertSecureSessionLogDirectoryChainIdentity(this.directoryBindings, this.options);
        unlinkSecureFileIfIdentity(this._filePath, this._fileIdentity);
      } catch {
        // Never follow a replaced ancestor merely to clean up an empty file.
      }
    }
    this.reportDiagnostic({
      code: 'writer_unavailable',
      message:
        'Session logging is unavailable; the Agent will continue without a logging fallback.',
    });
  }

  private reportDiagnostic(diagnostic: SessionLoggingDiagnostic): void {
    if (this.reportedDiagnostics.has(diagnostic.code)) return;
    this.reportedDiagnostics.add(diagnostic.code);
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Logging diagnostics are advisory and never escape into Runtime.
    }
  }

  private closeDescriptor(): void {
    if (this._fd == null) return;
    try {
      closeSync(this._fd);
    } catch {
      // The writer is already failed/closing and cannot affect Runtime.
    }
    this._fd = undefined;
  }
}
