// src/core/session-logger/collector.ts
// SessionLogCollector — 伴随 runAgent() 生命周期，全量记录 + 聚合摘要
//
// Span 层级：
//   session.start (root)
//   ├── agent.turn [1]           ← nextTurn() 创建
//   │   ├── node.agent           ← step_begin 事件，parent = turn
//   │   │   ├── text             ← parent = node
//   │   │   ├── tool_call        ← parent = node
//   │   │   └── tool_done        ← parent = node
//   │   ├── node.tools
//   │   └── node.agent.end
//   ├── agent.turn [2]
//   │   └── ...
//   └── session.end (root)
//
// 子 Agent 事件通过 subagentEventSink → emitAndRecord() 写入，
// parentSpanId 使用当前活跃的 node span，归入主日志文件（子 agent 不创建独立日志）。

import { writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { sessionLogDir } from '@/core/config/paths';
import { genSpanId, genTraceId } from '@/core/id-utils';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { AgentEvent } from '@/protocol/events';
import { recordEvent, recordRuntimeEvent } from './recorder';
import type { RunSummary, TraceRecord } from './types';
import { SessionLogWriter } from './writer';

/** 是否为开发模式（非 NODE_ENV=production） */
const isDev = process.env.NODE_ENV !== 'production';

export class SessionLogCollector {
  private _writer: SessionLogWriter;
  /** 开发模式下单独记录异常（工具失败 / 子 agent 错误 / 模型重试） */
  private _errorWriter: SessionLogWriter | null = null;
  private _traceId: string;
  private _summary: RunSummary;
  private _turnIdx = 0;
  /** 当前 turn span ID，nextTurn() 时刷新 */
  private _currentTurnSpanId = '';
  /** 当前 node span ID，step_begin 时从 event.data.spanId 读取 */
  private _currentNodeSpanId = '';
  /** call_id / subagent_id+toolName → tool args，用于 error 事件附带入参 */
  private _pendingArgs = new Map<string, Record<string, unknown>>();

  constructor(
    threadId: string,
    workspace: string,
    frontend: string,
    model: { provider: string; name: string },
  ) {
    this._traceId = genTraceId();
    this._writer = new SessionLogWriter(frontend, threadId);
    if (isDev) {
      this._errorWriter = new SessionLogWriter(frontend, threadId, 'errors');
    }
    this._summary = {
      threadId,
      traceId: this._traceId,
      startedAt: new Date().toISOString(),
      status: 'completed',
      workspace,
      frontend,
      modelProvider: model.provider,
      modelName: model.name,
      device: {
        os: platform(),
        osVersion: release(),
        arch: arch(),
        bunVersion: Bun.version,
        terminal: process.env.TERM_PROGRAM,
      },
      stats: {
        turns: 0,
        toolCalls: { total: 0, ok: 0, failed: 0 },
        modelRetries: 0,
        subAgents: { total: 0, ok: 0, failed: 0, blocked: 0 },
        errors: 0,
      },
    };

    // 写入 session_start 记录
    this._recordRaw({
      traceId: this._traceId,
      spanId: genSpanId(),
      parentSpanId: '',
      name: 'session.start',
      kind: 1,
      timestamp: new Date().toISOString(),
      attributes: {
        'kite_code.thread_id': threadId,
        'kite_code.frontend': frontend,
        'kite_code.workspace': workspace,
        'gen_ai.system': model.provider,
        'gen_ai.request.model': model.name,
        'kite_code.os': platform(),
        'kite_code.os_version': release(),
        'kite_code.arch': arch(),
        'kite_code.bun_version': Bun.version,
        ...(process.env.TERM_PROGRAM ? { 'kite_code.terminal': process.env.TERM_PROGRAM } : {}),
      },
      status: { code: 'OK', message: '' },
    });
  }

  // ── 公开 API ──

  /** 处理一个 AgentEvent——全量记录 + 聚合统计。
   *  事件流应诚实完整，去重/过滤是消费者的职责。本层只做结构性过滤（internal 节点）。 */
  record(event: AgentEvent): void {
    try {
      // 跳过内部图节点（step_begin 携带 internal 标记）
      if (event.type === 'step_begin' && event.data.internal) {
        return;
      }

      // turn_begin：以 turnSpanId 作为记录 spanId（使记录本身成为 turn span）
      if (event.type === 'turn_begin') {
        const rec = recordEvent(event, this._traceId, '', event.data.spanId);
        this._recordRaw(rec);
        return;
      }

      // step_begin：以 chunkToEvents 预生成的 spanId 作为 node span
      if (event.type === 'step_begin') {
        this._currentNodeSpanId = event.data.spanId;
        // step_begin 的 parent 是 turn span，不是 node 自身
        const nodeSpanRec = recordEvent(event, this._traceId, this._currentTurnSpanId);
        this._recordRaw(nodeSpanRec);
        this._updateStats(event);
        return;
      }

      // step_end：parent 是 node span，但不使用 nodeSpanId 作为自身 spanId
      if (event.type === 'step_end') {
        if (this._currentNodeSpanId === '') return; // internal 节点的 step_end
        const rec = recordEvent(event, this._traceId, this._currentNodeSpanId);
        this._recordRaw(rec);
        this._currentNodeSpanId = '';
        this._updateStats(event);
        return;
      }

      // 其他事件：parent = 活跃 node span，fallback 到 turn span
      const parentId = this._currentNodeSpanId || this._currentTurnSpanId;
      const rec = recordEvent(event, this._traceId, parentId);
      this._recordRaw(rec);
      this._recordError(rec, event);

      // 缓存工具入参（供 error 事件附带入参）
      if (event.type === 'tool_call') {
        this._pendingArgs.set(event.data.call_id, event.data.args);
      } else if (event.type === 'subagent_step') {
        this._pendingArgs.set(`${event.data.id}:${event.data.toolName}`, event.data.toolArgs);
      }

      // 聚合统计
      this._updateStats(event);
    } catch {
      // 日志记录失败不影响 Agent
    }
  }

  /** Runtime-native log path; no AgentEvent projection is required. */
  recordRuntime(event: RuntimeEvent): void {
    try {
      const rec = recordRuntimeEvent(event, this._traceId, this._currentTurnSpanId);
      this._recordRaw(rec);
      if (event.type === 'tool.finished') {
        this._summary.stats.toolCalls.total++;
        if (event.result.ok) this._summary.stats.toolCalls.ok++;
        else this._summary.stats.toolCalls.failed++;
      } else if (event.type === 'tool.failed' || event.type === 'tool.rejected') {
        this._summary.stats.toolCalls.total++;
        this._summary.stats.toolCalls.failed++;
      } else if (event.type === 'subagent.started') {
        this._summary.stats.subAgents.total++;
      } else if (event.type === 'subagent.suspended') {
        this._summary.stats.subAgents.blocked++;
      } else if (event.type === 'subagent.completed') {
        this._summary.stats.subAgents.ok++;
      } else if (event.type === 'subagent.failed') {
        this._summary.stats.subAgents.failed++;
      }

      // 开发模式下，子 agent 失败和工具错误输出到独立错误日志
      // Dev mode: write sub-agent failures and tool errors to dedicated error log
      if (
        this._errorWriter &&
        (event.type === 'subagent.failed' ||
          event.type === 'subagent.tool_result' ||
          (event.type === 'tool.finished' && !event.result.ok) ||
          event.type === 'tool.failed')
      ) {
        this._errorWriter.write(rec);
      }
    } catch {
      // Logging cannot interrupt the runtime.
    }
  }

  /** 开始新 turn——turn 的实际日志记录由 turn_begin 事件产生 */
  nextTurn(turnSpanId: string): void {
    this._turnIdx++;
    this._summary.stats.turns = this._turnIdx;
    this._currentTurnSpanId = turnSpanId;
    this._currentNodeSpanId = '';
    this._pendingArgs.clear();
  }

  /** 会话结束。需要 await 以保证日志完全落盘 */
  async finalize(status: 'completed' | 'aborted' | 'fatal'): Promise<void> {
    this._summary.endedAt = new Date().toISOString();
    this._summary.status = status;

    // session.end 记录
    this._recordRaw({
      traceId: this._traceId,
      spanId: genSpanId(),
      parentSpanId: '',
      name: 'session.end',
      kind: 1,
      timestamp: new Date().toISOString(),
      attributes: { 'kite_code.session.status': status },
      status: { code: status === 'completed' ? 'OK' : 'ERROR', message: status },
    });

    // 写 summary + flush（先等 writer 异步写入完成）
    try {
      const dir = sessionLogDir(this._summary.frontend, this._summary.threadId);
      writeFileSync(`${dir}/summary.json`, JSON.stringify(this._summary, null, 2), 'utf-8');
    } catch {
      // ignore
    }
    await this._writer.finalize();
    if (this._errorWriter) await this._errorWriter.finalize();
  }

  // ── private ──

  private _recordRaw(rec: TraceRecord): void {
    this._writer.write(rec);
  }

  /** 错误事件同步写入 errors.jsonl（仅开发模式），附带入参 */
  private _recordError(rec: TraceRecord, event: AgentEvent): void {
    if (!this._errorWriter) return;
    const isError =
      (event.type === 'tool_done' && !event.data.ok) ||
      (event.type === 'subagent_tool_result' && !event.data.ok) ||
      event.type === 'error' ||
      event.type === 'subagent_error' ||
      event.type === 'model_retry';
    if (!isError) return;

    // 从缓存中查找对应的工具入参
    let argsKey: string | null = null;
    if (event.type === 'tool_done') {
      argsKey = event.data.call_id;
    } else if (event.type === 'subagent_tool_result') {
      argsKey = `${event.data.id}:${event.data.toolName}`;
    }
    if (argsKey) {
      const args = this._pendingArgs.get(argsKey);
      if (args) {
        rec.attributes['kite_code.tool.args'] = JSON.stringify(args).slice(0, 4096);
      }
    }

    this._errorWriter.write(rec);
  }

  private _updateStats(event: AgentEvent): void {
    switch (event.type) {
      case 'tool_done':
        this._summary.stats.toolCalls.total++;
        if (event.data.ok) this._summary.stats.toolCalls.ok++;
        else this._summary.stats.toolCalls.failed++;
        break;
      case 'model_retry':
        this._summary.stats.modelRetries++;
        break;
      case 'subagent_done':
        this._summary.stats.subAgents.total++;
        this._summary.stats.subAgents.ok++;
        break;
      case 'subagent_error':
        this._summary.stats.subAgents.total++;
        this._summary.stats.subAgents.failed++;
        break;
      case 'error':
        this._summary.stats.errors++;
        break;
      // turn 数由 nextTurn() 驱动（1 conversation turn 可含多轮 agent→tools 循环）
    }
  }
}
